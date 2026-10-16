
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getText") {
    sendResponse({
      text: document.body?.innerText || ""
    });
    return;
  }

  if (request.action === "clearHighlights") {
    document.querySelectorAll("mark[data-iris-highlight]")
      .forEach(mark => {
        mark.replaceWith(
          document.createTextNode(mark.textContent || "")
        );
      });

    return;
  }

  if (
    request.action !== "highlight" &&
    request.action !== "scrollTo"
  ) {
    return;
  }

  const quote = String(request.sentence || "").trim();

  if (quote.length < 5) return;

  // Find the quoted sentence in a text node.
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );

  let node;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;

    if (!parent) continue;

    if (
      parent.closest(
        "script, style, noscript, textarea, input, select, option"
      )
    ) continue;

    const text = node.textContent || "";
    const start = text.indexOf(quote);

    if (start === -1) continue;

    if (request.action === "scrollTo") {
      parent.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });

      const previousOutline = parent.style.outline;
      parent.style.outline = "3px solid #d93025";

      setTimeout(() => {
        parent.style.outline = previousOutline;
      }, 2500);

      return;
    }

    if (request.action === "highlight") {
      // Avoid highlighting the same passage repeatedly.
      if (parent.closest("mark[data-iris-highlight]")) return;

      const fragment = document.createDocumentFragment();

      fragment.appendChild(
        document.createTextNode(text.slice(0, start))
      );

      const mark = document.createElement("mark");
      mark.dataset.irisHighlight = "true";
      mark.textContent = quote;
      mark.style.backgroundColor = "#fff176";
      mark.style.color = "#111";
      mark.style.fontWeight = "bold";
      mark.style.borderRadius = "3px";

      fragment.appendChild(mark);

      fragment.appendChild(
        document.createTextNode(text.slice(start + quote.length))
      );

      node.replaceWith(fragment);
      return;
    }
  }
});
