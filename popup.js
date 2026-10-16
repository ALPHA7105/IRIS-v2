
const API_URL =
  "https://irisextension.vercel.app/api/scan";

const auditBtn = document.getElementById("auditBtn");
const restoreBtn = document.getElementById("restoreBtn");
const clearBtn = document.getElementById("clearBtn");
const resultsDiv = document.getElementById("results");
const statusMessage = document.getElementById("statusMessage");

let currentTabId = null;
let currentUrl = null;
let currentCacheKey = null;
let currentArticleText = "";
let currentResults = [];

function cacheKeyFor(url) {
  return "iris_scan:" + url;
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function setBusy(busy) {
  auditBtn.disabled = busy;
  auditBtn.textContent = busy
    ? "Analyzing..."
    : "Run AI Scanner";
}

async function getActivePage() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (
    !tab ||
    !tab.id ||
    !tab.url ||
    !/^https?:\/\//i.test(tab.url)
  ) {
    throw new Error("Open a normal webpage before using IRIS.");
  }

  currentTabId = tab.id;
  currentUrl = tab.url;
  currentCacheKey = cacheKeyFor(currentUrl);

  return tab;
}

async function getPageText() {
  const response = await chrome.tabs.sendMessage(
    currentTabId,
    { action: "getText" }
  );

  if (!response || typeof response.text !== "string") {
    throw new Error("Could not read this page. Refresh it and try again.");
  }

  return response.text.substring(0, 8000);
}

async function loadSavedAnalysis() {
  const data = await chrome.storage.local.get(currentCacheKey);
  return data[currentCacheKey] || null;
}

async function initialise() {
  try {
    await getActivePage();

    const saved = await loadSavedAnalysis();

    if (saved) {
      currentResults = saved.results || [];
      currentArticleText = saved.articleText || "";

      displayResults(currentResults);

      setStatus(
        "Saved analysis loaded. Scanned " +
        new Date(saved.scannedAt).toLocaleString()
      );
    } else {
      resultsDiv.replaceChildren();
      setStatus("Ready to scan this page.");
    }
  } catch (error) {
    setStatus(error.message);
    auditBtn.disabled = true;
  }
}

function addText(parent, tag, value, styles = {}) {
  const element = document.createElement(tag);
  element.textContent = value || "";

  for (const [property, value] of Object.entries(styles)) {
    element.style[property] = value;
  }

  parent.appendChild(element);
  return element;
}

function displayResults(results) {
  resultsDiv.replaceChildren();

  if (!Array.isArray(results) || results.length === 0) {
    addText(
      resultsDiv,
      "p",
      "No findings were returned. This does not prove that the article is accurate.",
      { padding: "12px", fontSize: "12px" }
    );
    return;
  }

  const summary = document.createElement("div");
  summary.style.cssText =
    "padding:12px;background:#fff;border-radius:8px;" +
    "margin-bottom:12px;font-size:12px;" +
    "border:1px solid #dadce0;";

  addText(
    summary,
    "strong",
    `${results.length} finding(s)`,
    { color: "#1a73e8" }
  );

  resultsDiv.appendChild(summary);

  for (const item of results) {
    const report = document.createElement("div");
    report.className = "report-item";

    const heading = addText(
      report,
      "div",
      item.tactic || "Finding",
      {
        fontWeight: "bold",
        fontSize: "13px",
        color: item.integrity_flag ? "#d93025" : "#1a73e8"
      }
    );

    heading.title = "Click to locate this passage in the article.";

    addText(report, "p", item.explanation, {
      fontSize: "12px",
      lineHeight: "1.5",
      color: "#333",
      margin: "8px 0"
    });

    if (item.sentence) {
      addText(report, "p", `“${item.sentence}”`, {
        fontSize: "11px",
        color: "#5f6368",
        fontStyle: "italic",
        margin: "6px 0"
      });
    }

    if (item.fact_check) {
      addText(report, "div", item.fact_check, {
        fontSize: "11px",
        lineHeight: "1.5",
        padding: "8px",
        background: "#f8f9fa",
        borderLeft: "3px solid #1a73e8",
        marginTop: "8px"
      });
    }

    if (Array.isArray(item.sources) && item.sources.length) {
      const sourceBox = document.createElement("div");
      sourceBox.style.cssText =
        "font-size:11px;margin-top:8px;";

      addText(sourceBox, "strong", "Sources");

      for (const source of item.sources) {
        try {
          const url = new URL(source.url);

          if (!["https:", "http:"].includes(url.protocol)) {
            continue;
          }

          const link = document.createElement("a");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = source.title || url.hostname;
          link.style.cssText =
            "display:block;margin-top:5px;color:#1a73e8;";

          sourceBox.appendChild(link);
        } catch {
          // Ignore invalid source URLs.
        }
      }

      report.appendChild(sourceBox);
    }

    report.addEventListener("click", async event => {
      if (event.target.closest("a")) return;

      if (currentTabId && item.sentence) {
        try {
          await chrome.tabs.sendMessage(currentTabId, {
            action: "scrollTo",
            sentence: item.sentence
          });
        } catch {
          setStatus("Refresh the webpage to enable passage navigation.");
        }
      }
    });

    report.style.cursor = "pointer";
    resultsDiv.appendChild(report);
  }
}

auditBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Reading the article...");

  try {
    await getActivePage();
    const text = await getPageText();

    if (!text.trim()) {
      throw new Error("No readable text was found on this page.");
    }

    const saved = await loadSavedAnalysis();

    // Reuse a saved result when the page text is unchanged.
    if (saved && saved.articleText === text) {
      currentResults = saved.results || [];
      currentArticleText = text;
      displayResults(currentResults);
      setStatus("Loaded saved analysis. No API request was needed.");
      return;
    }

    setStatus("Analyzing article and searching for evidence...");

    
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Server returned non-JSON data (HTTP ${response.status}): ` +
        responseText.substring(0, 250)
      );
    }


    if (!response.ok) {
      throw new Error(data.error || `Server error (${response.status}).`);
    }

    if (!Array.isArray(data.results)) {
      throw new Error("The server returned an invalid report.");
    }

    currentResults = data.results;
    currentArticleText = text;

    const record = {
      url: currentUrl,
      scannedAt: Date.now(),
      articleText: text,
      results: currentResults,
      searched: data.searched === true
    };

    // Save before displaying, so the report survives popup closure.
    await chrome.storage.local.set({
      [currentCacheKey]: record
    });

    displayResults(currentResults);

    // Highlight the passages found by IRIS.
    for (const item of currentResults) {
      if (!item.sentence) continue;

      try {
        await chrome.tabs.sendMessage(currentTabId, {
          action: "highlight",
          sentence: item.sentence
        });
      } catch {
        // The report remains available if highlighting fails.
      }
    }

    setStatus(
      data.searched
        ? "Analysis saved. Search evidence was retrieved."
        : "Analysis saved. Live search evidence was unavailable."
    );
  } catch (error) {
    setStatus(error.message || "The scan failed. Please try again.");
  } finally {
    setBusy(false);
  }
});

restoreBtn.addEventListener("click", async () => {
  try {
    await getActivePage();
    const saved = await loadSavedAnalysis();

    if (!saved) {
      setStatus("No saved analysis exists for this page.");
      return;
    }

    currentResults = saved.results || [];
    currentArticleText = saved.articleText || "";

    displayResults(currentResults);

    setStatus(
      "Restored saved analysis from " +
      new Date(saved.scannedAt).toLocaleString()
    );
  } catch (error) {
    setStatus(error.message);
  }
});

clearBtn.addEventListener("click", async () => {
  resultsDiv.replaceChildren();

  try {
    if (currentTabId) {
      await chrome.tabs.sendMessage(currentTabId, {
        action: "clearHighlights"
      });
    }
  } catch {
    // Clearing the popup still works if the page cannot be reached.
  }

  // IMPORTANT: Do not delete the saved analysis here.
  setStatus("Analysis hidden. Use Restore Saved Analysis to bring it back.");
});

document.addEventListener("DOMContentLoaded", initialise);
