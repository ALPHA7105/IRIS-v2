
const OLLAMA_API = "https://ollama.com/api";
const MODEL = "gpt-oss:120b";

// Operational safeguards, not limits on the number of findings.
const MAX_ARTICLE_LENGTH = 40000;
const CHUNK_SIZE = 5000;
const CHUNK_OVERLAP = 600;
const SEARCH_RESULTS_PER_QUERY = 5;

// These can be adjusted through Vercel environment variables.
// Searches scale with the article rather than always stopping at 3.
const MAX_TOTAL_SEARCHES = Math.max(
  1,
  Number.parseInt(process.env.IRIS_MAX_SEARCHES || "40", 10) || 40
);

const SEARCH_CONCURRENCY = 4;
const ANALYSIS_CONCURRENCY = 2;

const VALID_CATEGORIES = new Set([
  "fact_check",
  "reasoning",
  "framing"
]);

const VALID_VERDICTS = new Set([
  "Supported",
  "Contradicted",
  "Insufficient evidence",
  "Potential reasoning issue"
]);

// --------------------------------------------------
// General helpers
// --------------------------------------------------

function uniqueBy(items, keyFunction) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = keyFunction(item);

    if (seen.has(key)) continue;

    seen.add(key);
    output.push(item);
  }

  return output;
}

function parseJsonResponse(value) {
  if (value && typeof value === "object") {
    return value;
  }

  if (typeof value !== "string") {
    throw new Error("Model returned an invalid response.");
  }

  // Normally Ollama's JSON format produces valid JSON directly.
  // This fallback handles a response wrapped in a code fence.
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(cleaned);
}

function normaliseUrl(value) {
  if (typeof value !== "string") return "";

  try {
    const parsed = new URL(value);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.href;
  } catch {
    return "";
  }
}

function normaliseDate(item) {
  const value =
    item.published_at ??
    item.publishedAt ??
    item.published_date ??
    item.publishedDate ??
    item.updated_at ??
    item.updatedAt ??
    item.date ??
    "";

  return typeof value === "string" ||
    typeof value === "number"
    ? String(value).substring(0, 100)
    : "";
}

function normaliseSearchResult(item) {
  return {
    title:
      typeof item.title === "string"
        ? item.title.substring(0, 300)
        : "",
    url: normaliseUrl(item.url),
    content:
      typeof item.content === "string"
        ? item.content.substring(0, 2500)
        : "",
    published_at: normaliseDate(item)
  };
}

function cleanText(value, maxLength = 2000) {
  return typeof value === "string"
    ? value.trim().substring(0, maxLength)
    : "";
}

// --------------------------------------------------
// Chunking
// --------------------------------------------------

function splitIntoChunks(text) {
  if (text.length <= CHUNK_SIZE) {
    return [{ index: 0, text }];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    // Prefer ending at a paragraph or sentence boundary.
    if (end < text.length) {
      const minimumEnd = start + Math.floor(CHUNK_SIZE * 0.7);
      const window = text.substring(minimumEnd, end);

      const paragraphBreak = window.lastIndexOf("\n\n");
      const sentenceBreak = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! ")
      );

      if (paragraphBreak >= 0) {
        end = minimumEnd + paragraphBreak + 2;
      } else if (sentenceBreak >= 0) {
        end = minimumEnd + sentenceBreak + 2;
      }
    }

    chunks.push({
      index: chunks.length,
      text: text.substring(start, end)
    });

    if (end >= text.length) break;

    // Overlap helps preserve context across chunk boundaries.
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
}

// --------------------------------------------------
// Concurrency helper
// --------------------------------------------------

async function mapWithConcurrency(items, concurrency, callback) {
  const output = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      output[index] = await callback(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return output;
}

// --------------------------------------------------
// Ollama API
// --------------------------------------------------

async function ollamaChat(key, messages) {
  const response = await fetch(`${OLLAMA_API}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      format: "json"
    })
  });

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `Ollama chat failed (${response.status}): ${error.substring(0, 500)}`
    );
  }

  const data = await response.json();
  const content = data.message?.content;

  if (!content) {
    throw new Error("Ollama returned an empty response.");
  }

  return parseJsonResponse(content);
}

async function searchWeb(key, query) {
  const response = await fetch(`${OLLAMA_API}/web_search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      max_results: SEARCH_RESULTS_PER_QUERY
    })
  });

  if (!response.ok) {
    throw new Error(`Web search failed (${response.status}).`);
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return uniqueBy(
    results
      .map(normaliseSearchResult)
      .filter(item => item.url && (item.title || item.content)),
    item => item.url
  );
}

// --------------------------------------------------
// Stage 1: Find claims that genuinely need searching
// --------------------------------------------------

async function extractClaims(key, chunk) {
  const response = await ollamaChat(key, [
    {
      role: "system",
      content: `
You are the research-planning component of IRIS, the Information &
Reasoning Inconsistency Scanner.

Examine the supplied article excerpt carefully.

Identify the distinct, meaningful factual claims that would benefit from
checking against external evidence. Include claims about dates, statistics,
scientific findings, events, quotations, public statements, and claims
about what a person or organisation did.

Do not create searches for ordinary opinions, purely hypothetical
statements, or rhetorical questions unless they contain a checkable claim.

Do not invent claims. Each claim must be an exact quotation copied from
the supplied text.

Create a specific, useful web search query for each claim that needs
external verification. Prefer queries that could find primary sources
or reputable reporting.

Do not merge separate factual claims merely because they concern the
same topic. Do not impose an arbitrary quota on the claims you identify.

Return JSON only, in this structure:
{
  "claims": [
    {
      "claim": "Exact quotation from the article",
      "query": "A specific search query"
    }
  ]
}

If no claims need searching, return {"claims": []}.
`
    },
    {
      role: "user",
      content: chunk.text
    }
  ]);

  const claims = Array.isArray(response.claims)
    ? response.claims
    : [];

  return uniqueBy(
    claims
      .filter(item =>
        item &&
        typeof item.claim === "string" &&
        typeof item.query === "string"
      )
      .map(item => ({
        claim: item.claim.trim(),
        query: item.query.trim().substring(0, 500)
      }))
      .filter(item =>
        item.claim &&
        item.query &&
        chunk.text.includes(item.claim)
      ),
    item => `${item.claim}\n${item.query}`
  );
}

// --------------------------------------------------
// Stage 2: Analyse one chunk using its evidence
// --------------------------------------------------

async function analyseChunk(key, chunk, claims, evidence) {
  const response = await ollamaChat(key, [
    {
      role: "system",
      content: `
You are IRIS, the Information & Reasoning Inconsistency Scanner.

Analyse the article excerpt for meaningful issues in three independent
categories:

1. fact_check
   Checkable factual claims that can be assessed against external evidence.

2. reasoning
   Logical errors, unsupported conclusions, contradictions, faulty
   generalisations, false dilemmas, causal errors, and other reasoning
   weaknesses. Explain the specific reasoning problem, not merely that
   you disagree with the conclusion.

3. framing
   Materially misleading framing, emotionally manipulative language,
   loaded wording, fear appeals, or rhetoric that distorts how evidence
   should be interpreted. Ordinary persuasive writing is not automatically
   manipulative.

Be thorough. Report every distinct, meaningful issue you can justify.
There is no fixed quota on findings. Do not invent issues to make the
report longer.

IMPORTANT RULES:

- The "sentence" field must be an exact quotation from the supplied
  article excerpt. Do not paraphrase it.
- Analyse the quoted sentence in context. Do not label a statement a
  fallacy merely because it is forceful, emotional, controversial, or
  factually incorrect.
- A factual claim and a reasoning flaw may be separate findings when
  they represent genuinely different problems. Avoid duplicate findings
  that merely restate the same issue.
- A claim being absent from search results does NOT mean it is false.
- A lack of sufficient evidence must result in "Insufficient evidence",
  not "Contradicted".
- "Contradicted" requires supplied evidence that directly conflicts with
  the claim. Explain the conflict specifically.
- "Supported" means the supplied evidence meaningfully supports the claim.
  It does not mean the claim is proven beyond all doubt.
- "Potential reasoning issue" is for a plausible logical weakness that
  depends on interpretation or context. Explain what additional context
  could change the assessment.
- For reasoning and framing findings, use "Potential reasoning issue"
  unless the finding is a factual assessment with an evidence-based verdict.
- Do not use a reasoning flaw as proof that a factual claim is false.
- Do not treat a source as relevant simply because it mentions the same
  subject. Explain how it relates to the exact claim.
- Prefer primary sources and credible, independent sources where available.
- Use only sources present in the supplied search evidence. Never invent
  titles, URLs, dates, quotations, or source contents.
- If a factual claim has no relevant supplied evidence, use
  "Insufficient evidence" and leave sources empty.
- If a sentence has no meaningful issue, do not include it.
- Avoid repeating findings already captured by another quotation.

Return valid JSON only:
{
  "results": [
    {
      "sentence": "Exact quotation from the article",
      "category": "fact_check",
      "tactic": "Short issue label",
      "explanation": "A specific explanation of the issue",
      "verdict": "Insufficient evidence",
      "integrity_flag": false,
      "fact_check": "Evidence-based assessment, or an explanation of uncertainty",
      "sources": [
        {
          "title": "Exact source title",
          "url": "Exact source URL",
          "published_at": "Date only if supplied",
          "relevance": "How this source bears on the exact claim"
        }
      ]
    }
  ]
}

Allowed categories: fact_check, reasoning, framing.

Allowed verdicts: Supported, Contradicted, Insufficient evidence,
Potential reasoning issue.

Set integrity_flag to true ONLY when supplied evidence establishes a
specific factual contradiction or materially misleading factual claim.
Do not set it to true for ordinary uncertainty, an unsupported claim,
or a possible logical weakness.
`
    },
    {
      role: "user",
      content: JSON.stringify({
        articleExcerpt: chunk.text,
        claimsSelectedForResearch: claims,
        searchEvidence: evidence
      })
    }
  ]);

  return Array.isArray(response.results) ? response.results : [];
}

// --------------------------------------------------
// Stage 3: Validate model output against the article
// and actual search results
// --------------------------------------------------

function validateFindings(findings, article, evidence) {
  const allowedSources = new Map();

  for (const group of evidence) {
    for (const source of group.results || []) {
      if (source.url) {
        allowedSources.set(source.url, source);
      }
    }
  }

  const validated = [];

  for (const item of findings) {
    if (!item || typeof item !== "object") continue;

    const sentence = cleanText(item.sentence, 3000);
    const category = VALID_CATEGORIES.has(item.category)
      ? item.category
      : "";

    // Only allow exact quotations that really occur in the article.
    if (!sentence || !article.includes(sentence) || !category) {
      continue;
    }

    const sources = uniqueBy(
      (Array.isArray(item.sources) ? item.sources : [])
        .filter(source =>
          source &&
          typeof source.url === "string" &&
          allowedSources.has(source.url)
        )
        .map(source => {
          const realSource = allowedSources.get(source.url);

          return {
            title: realSource.title || cleanText(source.title, 300),
            url: realSource.url,
            published_at: realSource.published_at || "",
            relevance: cleanText(source.relevance, 1000)
          };
        }),
      source => source.url
    );

    let verdict = VALID_VERDICTS.has(item.verdict)
      ? item.verdict
      : "Insufficient evidence";

    // Never allow a factual verdict of Supported or Contradicted
    // without a source actually retrieved by this scan.
    if (
      category === "fact_check" &&
      sources.length === 0
    ) {
      verdict = "Insufficient evidence";
    }

    // Reasoning and framing are interpretive assessments, not
    // factual verdicts that can be proved by a web search alone.
    if (
      category !== "fact_check" &&
      verdict !== "Potential reasoning issue"
    ) {
      verdict = "Potential reasoning issue";
    }

    const integrityFlag =
      category === "fact_check" &&
      item.integrity_flag === true &&
      verdict === "Contradicted" &&
      sources.length > 0;

    validated.push({
      sentence,
      category,
      tactic: cleanText(item.tactic, 160) || category,
      explanation: cleanText(item.explanation, 2000),
      verdict,
      integrity_flag: integrityFlag,
      fact_check: cleanText(item.fact_check, 2000),
      sources
    });
  }

  return validated;
}

// --------------------------------------------------
// Stage 4: Merge repeated findings and source lists
// --------------------------------------------------

function mergeFindings(findings) {
  const merged = new Map();

  for (const finding of findings) {
    // The same quote can have distinct issues, so include category
    // and issue label in the key rather than deduplicating by quote alone.
    const key = [
      finding.sentence.trim().toLowerCase(),
      finding.category,
      finding.tactic.trim().toLowerCase()
    ].join("::");

    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        ...finding,
        sources: [...finding.sources]
      });
      continue;
    }

    existing.sources = uniqueBy(
      [...existing.sources, ...finding.sources],
      source => source.url
    );

    // Prefer a supported assessment over uncertainty, but only when
    // the assessment is grounded in actual evidence.
    const priority = {
      "Contradicted": 4,
      "Supported": 3,
      "Potential reasoning issue": 2,
      "Insufficient evidence": 1
    };

    if (priority[finding.verdict] > priority[existing.verdict]) {
      existing.verdict = finding.verdict;
      existing.fact_check = finding.fact_check || existing.fact_check;
      existing.explanation =
        finding.explanation || existing.explanation;
    } else if (
      !existing.explanation &&
      finding.explanation
    ) {
      existing.explanation = finding.explanation;
    }

    existing.integrity_flag =
      existing.integrity_flag || finding.integrity_flag;

    if (!existing.fact_check && finding.fact_check) {
      existing.fact_check = finding.fact_check;
    }
  }

  return Array.from(merged.values());
}

// --------------------------------------------------
// API handler
// --------------------------------------------------

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Use POST for this endpoint."
    });
  }

  const key = process.env.OLLAMA_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "Server is missing its Ollama API credential."
    });
  }

  const article = req.body?.text;

  if (typeof article !== "string" || !article.trim()) {
    return res.status(400).json({
      error: "Article text is missing."
    });
  }

  if (article.length > MAX_ARTICLE_LENGTH) {
    return res.status(413).json({
      error: `Article is too long. Maximum: ${MAX_ARTICLE_LENGTH} characters.`
    });
  }

  const cleanArticle = article.trim();

  try {
    const chunks = splitIntoChunks(cleanArticle);

    // 1. Extract factual claims from every chunk.
    const chunkClaims = await mapWithConcurrency(
      chunks,
      ANALYSIS_CONCURRENCY,
      async chunk => ({
        chunk,
        claims: await extractClaims(key, chunk)
      })
    );

    // 2. Build a shared list of distinct search queries.
    // The budget is configurable and is not a findings quota.
    const queryToClaims = new Map();

    for (const entry of chunkClaims) {
      for (const claim of entry.claims) {
        const keyQuery = claim.query.trim().toLowerCase();

        if (!queryToClaims.has(keyQuery)) {
          queryToClaims.set(keyQuery, {
            query: claim.query,
            claims: []
          });
        }

        queryToClaims.get(keyQuery).claims.push(claim.claim);
      }
    }

    const allQueries = Array.from(queryToClaims.values());

    const selectedQueries = allQueries.slice(
      0,
      MAX_TOTAL_SEARCHES
    );

    const skippedSearches = Math.max(
      0,
      allQueries.length - selectedQueries.length
    );

    // 3. Search the web concurrently, without exceeding the
    // configured request budget.
    const searchOutcomes = await mapWithConcurrency(
      selectedQueries,
      SEARCH_CONCURRENCY,
      async item => {
        try {
          const results = await searchWeb(key, item.query);

          return {
            query: item.query,
            claims: item.claims,
            results
          };
        } catch (error) {
          console.error(
            "IRIS search error:",
            error.message
          );

          return {
            query: item.query,
            claims: item.claims,
            results: [],
            error: "Search unavailable for this query."
          };
        }
      }
    );

    // 4. Analyse each chunk using the evidence relevant to its claims.
    const chunkFindings = await mapWithConcurrency(
      chunkClaims,
      ANALYSIS_CONCURRENCY,
      async entry => {
        const chunkText = entry.chunk.text;

        const relevantGroups = searchOutcomes.filter(group =>
          group.claims.some(claim =>
            chunkText.includes(claim)
          )
        );

        const evidence = relevantGroups.map(group => ({
          query: group.query,
          results: group.results,
          ...(group.error ? { error: group.error } : {})
        }));

        const rawFindings = await analyseChunk(
          key,
          entry.chunk,
          entry.claims,
          evidence
        );

        return validateFindings(
          rawFindings,
          cleanArticle,
          evidence
        );
      }
    );

    // 5. Merge overlap duplicates and return every distinct
    // validated finding. There is intentionally no findings slice.
    const results = mergeFindings(chunkFindings.flat());

    const evidenceFound = searchOutcomes.some(
      group => group.results.length > 0
    );

    return res.status(200).json({
      results,
      searched: evidenceFound,
      search_status: {
        attempted: selectedQueries.length,
        evidence_found: evidenceFound,
        queries: searchOutcomes.map(group => ({
          query: group.query,
          results_found: group.results.length,
          ...(group.error ? { error: group.error } : {})
        })),
        skipped_due_to_budget: skippedSearches
      },
      analysis_status: {
        chunks_analysed: chunks.length,
        findings_returned: results.length,
        complete: skippedSearches === 0
      }
    });
  } catch (error) {
    console.error("IRIS scan error:", error.message);

    return res.status(502).json({
      error: "IRIS could not complete the scan. Please try again."
    });
  }
};
