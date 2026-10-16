
const OLLAMA_API = "https://ollama.com/api";
const MODEL = "gpt-oss:120b";

const MAX_TEXT_LENGTH = 8000;
const MAX_SEARCHES = 3;

async function ollamaChat(key, messages) {
  const response = await fetch(`${OLLAMA_API}/chat`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
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
    throw new Error(`Ollama chat failed (${response.status}): ${error}`);
  }

  const data = await response.json();
  const content = data.message?.content;

  if (!content) {
    throw new Error("Ollama returned an empty response.");
  }

  return JSON.parse(content);
}

async function searchWeb(key, query) {
  const response = await fetch(`${OLLAMA_API}/web_search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      max_results: 4
    })
  });

  if (!response.ok) {
    throw new Error(`Web search failed (${response.status}).`);
  }

  const data = await response.json();
  return data.results || [];
}

function extractJson(text) {
  // The model is asked for JSON, but validate the structure anyway.
  if (Array.isArray(text)) return text;
  if (text && Array.isArray(text.results)) return text.results;
  return [];
}

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

  if (article.length > MAX_TEXT_LENGTH) {
    return res.status(413).json({
      error: `Article is too long. Maximum: ${MAX_TEXT_LENGTH} characters.`
    });
  }

  try {
    // Stage 1: Ask the model for focused factual search queries.
    const queryResponse = await ollamaChat(key, [
      {
        role: "system",
        content:
          "You are a research assistant. Identify up to 3 specific, " +
          "important factual claims in an article that would benefit " +
          "from checking against current external evidence. Do not " +
          "search for opinions or ordinary rhetorical statements. " +
          'Return JSON only: {"queries":["query 1","query 2"]}. ' +
          "If nothing needs checking, return an empty queries array."
      },
      {
        role: "user",
        content: article.substring(0, MAX_TEXT_LENGTH)
      }
    ]);

    const queries = Array.isArray(queryResponse.queries)
      ? queryResponse.queries
          .filter(q => typeof q === "string" && q.trim())
          .slice(0, MAX_SEARCHES)
      : [];

    // Stage 2: Search for evidence.
    const evidence = [];

    for (const query of queries) {
      try {
        const results = await searchWeb(key, query);

        evidence.push({
          query,
          results: results.slice(0, 4).map(item => ({
            title: item.title || "",
            url: item.url || "",
            content: (item.content || "").substring(0, 1800)
          }))
        });
      } catch (error) {
        // Preserve the analysis even if one search fails.
        evidence.push({
          query,
          error: "Search unavailable for this query.",
          results: []
        });
      }
    }

    // Stage 3: Analyse rhetoric and assess claims against the evidence.
    const finalResponse = await ollamaChat(key, [
      {
        role: "system",
        content: `
You are IRIS, the Information & Reasoning Inconsistency Scanner.

Analyse the supplied article for:
- Logical fallacies and weaknesses in reasoning.
- Potential emotional manipulation or misleading framing.
- Important factual claims that the supplied search evidence can assess.

Be selective. Return up to 8 useful findings, not a forced quota.
Do not invent fallacies just to fill the report.

Every "sentence" must be an exact quotation from the article.
If a finding cannot be tied to an exact passage, omit it.

Only set integrity_flag to true when the supplied evidence supports
a specific factual contradiction or materially misleading claim.
Do not treat missing evidence as proof of falsity.
If evidence is insufficient, set integrity_flag to false and
explain that the claim remains unverified.
Do not claim that you performed a search unless search evidence
was supplied below.

Return valid JSON in this format:
{
  "results": [
    {
      "sentence": "Exact text from article",
      "tactic": "Name of fallacy or finding",
      "explanation": "Concise explanation for a student",
      "integrity_flag": false,
      "fact_check": "",
      "sources": [
        {"title": "Source title", "url": "https://example.com"}
      ]
    }
  ]
}

Use an empty sources array if no source supports the finding.
Only include sources from the supplied search results.
Keep the explanation clear and avoid overstating certainty.
`
      },
      {
        role: "user",
        content: JSON.stringify({
          article: article.substring(0, MAX_TEXT_LENGTH),
          searchEvidence: evidence
        })
      }
    ]);

    const results = extractJson(finalResponse);

    // Validate returned findings before sending them to the extension.
    const safeResults = results
      .filter(item =>
        item &&
        typeof item.sentence === "string" &&
        typeof item.tactic === "string" &&
        typeof item.explanation === "string" &&
        article.includes(item.sentence)
      )
      .map(item => ({
        sentence: item.sentence,
        tactic: item.tactic.substring(0, 120),
        explanation: item.explanation.substring(0, 1500),
        integrity_flag: item.integrity_flag === true,
        fact_check:
          typeof item.fact_check === "string"
            ? item.fact_check.substring(0, 1500)
            : "",
        sources: Array.isArray(item.sources)
          ? item.sources
              .filter(s =>
                s &&
                typeof s.title === "string" &&
                typeof s.url === "string" &&
                evidence.some(group =>
                  group.results.some(r => r.url === s.url)
                )
              )
              .slice(0, 4)
              .map(s => ({
                title: s.title.substring(0, 200),
                url: s.url
              }))
          : []
      }));

    return res.status(200).json({
      results: safeResults,
      searched: evidence.some(group => group.results.length > 0)
    });
  } catch (error) {
    console.error("IRIS scan error:", error.message);

    return res.status(502).json({
      error: "IRIS could not complete the scan. Please try again."
    });
  }
};
