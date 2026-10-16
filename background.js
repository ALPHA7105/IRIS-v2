
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  });
});

// A finding can ask the side panel to open a specific conversation.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "openIrisChat") return;

  (async () => {
    try {
      if (sender.tab?.id) {
        await chrome.storage.session.set({
          iris_pending_chat: {
            mode: request.mode === "finding" ? "finding" : "page",
            selectedFinding: request.selectedFinding || null,
            tabId: sender.tab.id,
            requestedAt: Date.now()
          }
        });

        await chrome.sidePanel.open({
          tabId: sender.tab.id
        });
      }

      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message || "Could not open IRIS."
      });
    }
  })();

  return true;
});
