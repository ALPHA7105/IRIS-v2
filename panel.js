
const SCAN_API = "https://irisextension.vercel.app/api/scan";
const CHAT_API = "https://irisextension.vercel.app/api/chat";

const $ = id => document.getElementById(id);

const reportView = $("reportView");
const chatView = $("chatView");
const backBtn = $("backBtn");
const scanBtn = $("scanBtn");
const talkPageBtn = $("talkPageBtn");
const restoreBtn = $("restoreBtn");
const clearBtn = $("clearBtn");
const statusBox = $("status");
const resultsBox = $("results");
const chatTitle = $("chatTitle");
const chatSubtitle = $("chatSubtitle");
const chatContext = $("chatContext");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const sendBtn = $("sendBtn");
const newChatBtn = $("newChatBtn");

let tabId = null;
let pageUrl = "";
let cacheKey = "";
let articleText = "";
let findings = [];
let chatMode = "page";
let selectedFinding = null;
let conversation = [];
let sending = false;

function setStatus(message) {
  statusBox.textContent = message;
}

function makeCacheKey(url) {
  return "iris_scan:" + url;
}

function addText(parent, tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text || "";
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  console.log("IRIS: Tabs returned:", tabs);

  const tab = tabs[0];

  console.log("IRIS: Selected tab:", tab);
  console.log("IRIS: URL:", tab?.url);
  console.log("IRIS: Tab ID:", tab?.id);

  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(
      "Open a normal webpage before using IRIS. URL: " +
      (tab?.url || "unavailable")
    );
  }

  tabId = tab.id;
  pageUrl = tab.url;
  cacheKey = makeCacheKey(pageUrl);

  return tab;
}

async function getPageText() {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getText"
    });

    if (typeof response?.text === "string") {
      return response.text.substring(0, 30000);
    }
  } catch {
    // Try injecting the content script if it is not available.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getText"
    });

    if (typeof response?.text === "string") {
      return response.text.substring(0, 30000);
    }
  } catch {
    // Restricted browser pages cannot be read by extensions.
  }

  throw new Error(
    "IRIS couldn't read this page. Refresh it and try again. Some browser pages cannot be scanned."
  );
}

async function loadSavedAnalysis() {
  const saved = await chrome.storage.local.get(cacheKey);
  return saved[cacheKey] || null;
}

async function saveAnalysis(searched = false) {
  await chrome.storage.local.set({
    [cacheKey]: {
      url: pageUrl,
      scannedAt: Date.now(),
      articleText,
      results: findings,
      searched
    }
  });
}

function renderResults(items) {
  resultsBox.replaceChildren();

  if (!Array.isArray(items) || items.length === 0) {
    addText(
      resultsBox,
      "p",
      "No findings were returned. That does not prove the article is accurate.",
      "muted"
    );
    return;
  }

  addText(
    resultsBox,
    "p",
    `${items.length} finding(s) returned`,
    "muted"
  );

  items.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "finding";

    const header = document.createElement("div");
    header.className = "finding-head";

    const title = addText(
      header,
      "div",
      item.tactic || item.category || "Finding",
      "finding-title"
    );

    title.style.color = item.integrity_flag ? "var(--red)" : "var(--blue)";

    const askButton = document.createElement("button");
    askButton.type = "button";
    askButton.className = "chat-icon";
    askButton.title = "Discuss this specific finding with IRIS";
    askButton.setAttribute("aria-label", "Ask IRIS about this finding");
    askButton.textContent = "↩ Chat";

    askButton.addEventListener("click", () => {
      openChat("finding", item);
    });

    header.appendChild(askButton);
    card.appendChild(header);

    if (item.sentence) {
      const quote = addText(card, "blockquote", `“${item.sentence}”`, "quote");
      quote.title = "Click the quote to locate it on the webpage.";

      quote.addEventListener("click", () => {
        locateSentence(item.sentence);
      });

      quote.style.cursor = "pointer";
    }

    addText(
      card,
      "p",
      item.explanation || "No explanation was supplied.",
      "explanation"
    );

    if (item.verdict) {
      addText(card, "p", `Assessment: ${item.verdict}`, "muted");
    }

    if (item.fact_check) {
      addText(card, "div", item.fact_check, "fact-check");
    }

    if (Array.isArray(item.sources) && item.sources.length) {
      const sourceArea = document.createElement("div");
      sourceArea.className = "source-list";
      addText(sourceArea, "strong", "Sources");

      item.sources.forEach(source => {
        const url = safeLink(source.url);
        if (!url) return;

        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.title || url;
        sourceArea.appendChild(link);
      });

      card.appendChild(sourceArea);
    }

    resultsBox.appendChild(card);
  });
}

async function locateSentence(sentence) {
  if (!tabId || !sentence) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: "scrollTo",
      sentence
    });
  } catch {
    setStatus("Refresh the webpage to enable passage navigation.");
  }
}

async function highlightFindings() {
  for (const item of findings) {
    if (!item.sentence) continue;

    try {
      await chrome.tabs.sendMessage(tabId, {
        action: "highlight",
        sentence: item.sentence
      });
    } catch {
      // The report can still be used without webpage highlights.
    }
  }
}

async function initialise() {
  try {
    await getActiveTab();

    const saved = await loadSavedAnalysis();

    if (saved) {
      articleText = saved.articleText || "";
      findings = saved.results || [];
      renderResults(findings);

      setStatus(
        "Saved analysis loaded from " +
        new Date(saved.scannedAt).toLocaleString()
      );
    } else {
      setStatus("Ready to scan this page.");
    }

    const pendingData = await chrome.storage.session.get("iris_pending_chat");
    const pending = pendingData.iris_pending_chat;

    if (pending && pending.tabId === tabId) {
      await chrome.storage.session.remove("iris_pending_chat");
      openChat(pending.mode, pending.selectedFinding);
    }
  } catch (error) {
    setStatus(error.message || "Could not initialise IRIS.");
    scanBtn.disabled = true;
    talkPageBtn.disabled = true;
  }
}

async function runScan() {
  scanBtn.disabled = true;
  scanBtn.textContent = "Analyzing...";
  setStatus("Reading the webpage...");

  try {
    await getActiveTab();
    const text = await getPageText();

    if (!text.trim()) {
      throw new Error("No readable text was found on this page.");
    }

    const saved = await loadSavedAnalysis();

    if (saved && saved.articleText === text) {
      articleText = text;
      findings = saved.results || [];
      renderResults(findings);
      setStatus("Loaded the saved analysis for this unchanged page.");
      return;
    }

    setStatus("Analyzing claims and searching for evidence...");

    const response = await fetch(SCAN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Scan failed (${response.status}).`);
    }

    if (!Array.isArray(data.results)) {
      throw new Error("The scan server returned an invalid report.");
    }

    articleText = text;
    findings = data.results;

    await saveAnalysis(data.searched === true);
    renderResults(findings);
    await highlightFindings();

    setStatus(
      data.searched
        ? "Analysis saved. Search evidence was retrieved."
        : "Analysis saved. Search evidence was unavailable."
    );
  } catch (error) {
    setStatus(error.message || "The scan failed. Please try again.");
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Run AI Scanner";
  }
}

function showReport() {
  chatView.classList.add("hidden");
  reportView.classList.remove("hidden");
  backBtn.style.display = "none";
}

function openChat(mode, finding = null) {
  chatMode = mode === "finding" ? "finding" : "page";
  selectedFinding = chatMode === "finding" ? finding : null;
  conversation = [];

  reportView.classList.add("hidden");
  chatView.classList.remove("hidden");
  backBtn.style.display = "inline-block";

  chatTitle.textContent = chatMode === "finding"
    ? "Discuss this finding"
    : "Talk with IRIS";

  chatSubtitle.textContent = chatMode === "finding"
    ? "Question the reasoning, challenge the assessment, or request a fresh check."
    : "Explore the article, question its claims, and investigate its arguments.";

  chatContext.textContent = chatMode === "finding"
    ? `Selected passage: “${selectedFinding?.sentence || ""}”`
    : `Current page: ${pageUrl}`;

  chatMessages.replaceChildren();

  if (chatMode === "finding" && selectedFinding) {
    addBubble(
      "assistant",
      `Let's examine this finding together.\n\nIRIS originally identified: ${selectedFinding.tactic || selectedFinding.category || "Potential issue"}.\n\n${selectedFinding.explanation || ""}\n\nWhat would you like to question or verify?`
    );
  } else {
    addBubble(
      "assistant",
      "I'm ready to discuss this page. Ask me about its claims, reasoning, assumptions, or framing. If you want a factual claim checked, ask and I'll look for fresh evidence."
    );
  }

  chatInput.value = "";
  chatInput.focus();
}

function addBubble(role, text, sources = [], changed = false, updated = "") {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;

  addText(
    bubble,
    "div",
    role === "user" ? "You" : "IRIS",
    "bubble-label"
  );

  addText(bubble, "div", text);

  if (changed && updated) {
    addText(
      bubble,
      "div",
      `Assessment revised: ${updated}`,
      "change-note"
    );
  }

  if (Array.isArray(sources) && sources.length) {
    const sourceList = document.createElement("div");
    sourceList.className = "source-list";
    addText(sourceList, "strong", "Evidence used");

    sources.forEach(source => {
      const url = safeLink(source.url);
      if (!url) return;

      const entry = document.createElement("div");
      entry.className = "source";

      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title || url;
      entry.appendChild(link);

      if (source.published_at) {
        addText(entry, "p", `Date: ${source.published_at}`);
      }

      if (source.relevance) {
        addText(entry, "p", source.relevance);
      }

      sourceList.appendChild(entry);
    });

    bubble.appendChild(sourceList);
  }

  chatMessages.appendChild(bubble);
  bubble.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return bubble;
}

async function sendMessage(event) {
  event.preventDefault();

  if (sending) return;

  const message = chatInput.value.trim();
  if (!message) return;

  try {
    if (!articleText) {
      await getActiveTab();

      const saved = await loadSavedAnalysis();

      if (saved?.articleText) {
        articleText = saved.articleText;
        findings = saved.results || [];
      } else {
        articleText = await getPageText();
      }
    }
  } catch (error) {
    addBubble("assistant", error.message || "I couldn't read the page.");
    return;
  }

  sending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "Checking...";
  chatInput.disabled = true;

  addBubble("user", message);
  chatInput.value = "";

  const pending = addBubble("assistant", "Considering your question and checking relevant evidence...");

  try {
    const payload = {
      mode: chatMode,
      article: articleText,
      selectedFinding: selectedFinding
        ? {
            sentence: selectedFinding.sentence,
            category: selectedFinding.category || "",
            tactic: selectedFinding.tactic || "",
            explanation: selectedFinding.explanation || "",
            verdict: selectedFinding.verdict || "",
            fact_check: selectedFinding.fact_check || "",
            sources: selectedFinding.sources || []
          }
        : null,
      history: conversation,
      message
    };

    const response = await fetch(CHAT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Chat failed (${response.status}).`);
    }

    if (pending && pending.isConnected) {
      pending.remove();
    }

    const answer = data.answer || "I couldn't generate an answer.";
    addBubble(
      "assistant",
      answer,
      data.sources || [],
      data.assessment_changed === true,
      data.updated_assessment || ""
    );

    conversation.push(
      { role: "user", content: message },
      { role: "assistant", content: answer }
    );

    // Keep the in-memory conversation manageable.
    conversation = conversation.slice(-12);

    if (data.research?.queries_attempted > 0) {
      const note = data.research.evidence_found
        ? "Fresh search results were retrieved for this response."
        : "Search was attempted, but no usable results were retrieved.";

      addText(chatMessages, "p", note, "small");
    }
  } catch (error) {
    if (pending && pending.isConnected) {
      pending.remove();
    }

    console.error("IRIS chat request failed:", error);

    addBubble(
        "assistant",
        `${error.message || "The request failed."}\n\nYour message was not added to the conversation history. You can try sending it again.`
    );

    chatInput.value = message;

  } finally {
    sending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send message";
    chatInput.disabled = false;
    chatInput.focus();
  }
}

scanBtn.addEventListener("click", runScan);

talkPageBtn.addEventListener("click", async () => {
  try {
    await getActiveTab();

    if (!articleText) {
      const saved = await loadSavedAnalysis();
      articleText = saved?.articleText || await getPageText();

      if (saved) findings = saved.results || [];
    }

    openChat("page");
  } catch (error) {
    setStatus(error.message || "Couldn't open the conversation.");
  }
});

backBtn.addEventListener("click", showReport);

restoreBtn.addEventListener("click", async () => {
  try {
    await getActiveTab();
    const saved = await loadSavedAnalysis();

    if (!saved) {
      setStatus("No saved analysis exists for this page.");
      return;
    }

    articleText = saved.articleText || "";
    findings = saved.results || [];
    renderResults(findings);

    setStatus(
      "Restored analysis from " +
      new Date(saved.scannedAt).toLocaleString()
    );
  } catch (error) {
    setStatus(error.message || "Could not restore the analysis.");
  }
});

clearBtn.addEventListener("click", async () => {
  try {
    await getActiveTab();
    await chrome.tabs.sendMessage(tabId, {
      action: "clearHighlights"
    });
    setStatus("Highlights hidden. Your saved analysis is still available.");
  } catch {
    setStatus("Highlights could not be cleared on this page.");
  }
});

const clearFindingsBtn = document.getElementById("clearFindingsBtn");

// Remove highlights from the webpage without deleting the saved analysis.
async function hidePageHighlights() {
  if (!tabId) return;

  await chrome.tabs.sendMessage(tabId, {
    action: "clearHighlights"
  });

  setStatus("Highlights hidden. Your analysis is still saved.");
}

// Restore highlights from the cached analysis without scanning again.
async function restorePageHighlights() {
  if (!tabId || !cacheKey) return;

  const saved = await chrome.storage.local.get(cacheKey);
  const cached = saved[cacheKey];

  if (!cached || !Array.isArray(cached.results)) {
    setStatus("No saved analysis for this page. Analyse it first.");
    return;
  }

  results = cached.results;

  await chrome.tabs.sendMessage(tabId, {
    action: "highlight",
    results
  });

  renderResults(results);
  setStatus("Saved highlights restored.");
}

// Clear the current report and its highlights.
// This does not delete analyses belonging to other pages.
async function clearCurrentFindings() {
  if (!tabId) return;

  await chrome.tabs.sendMessage(tabId, {
    action: "clearHighlights"
  });

  results = [];
  document.getElementById("results").replaceChildren();

  if (cacheKey) {
    await chrome.storage.local.remove(cacheKey);
  }

  setStatus("Findings cleared. You can analyse this page again.");
}

document.getElementById("clearBtn").addEventListener("click", async () => {
  try {
    await hidePageHighlights();
  } catch (error) {
    setStatus("Could not hide highlights. Reload the webpage and try again.");
    console.error(error);
  }
});

document.getElementById("restoreBtn").addEventListener("click", async () => {
  try {
    await restorePageHighlights();
  } catch (error) {
    setStatus("Could not restore highlights. Reload the webpage and try again.");
    console.error(error);
  }
});

clearFindingsBtn.addEventListener("click", async () => {
  try {
    await clearCurrentFindings();
  } catch (error) {
    setStatus("Could not clear findings. Please try again.");
    console.error(error);
  }
});

newChatBtn.addEventListener("click", () => {
  openChat(chatMode, selectedFinding);
});

chatForm.addEventListener("submit", sendMessage);

initialise();
