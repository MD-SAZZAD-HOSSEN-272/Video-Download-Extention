// Scans the DOM for <video>/<source> elements with direct http(s) URLs.
(function () {
  const sent = new Set();
  let observer;

  // After the extension is reloaded, this orphaned script can no longer reach it.
  function send(msg) {
    try {
      if (!chrome.runtime?.id) throw new Error("invalidated");
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      observer && observer.disconnect();
    }
  }

  function scan() {
    const urls = [];
    document.querySelectorAll("video, video source").forEach((el) => {
      const src = el.currentSrc || el.src;
      if (src && /^https?:/i.test(src) && !sent.has(src)) {
        sent.add(src);
        urls.push(src);
      }
    });
    if (urls.length) send({ type: "dom-videos", urls });
  }

  // Relay YouTube/Facebook results from site.js (MAIN world)
  if (window === window.top) {
    window.addEventListener("message", (e) => {
      if (e.source !== window || !e.data || e.data.source !== "vd-ext") return;
      send({ type: "site-videos", items: e.data.items });
    });
  }

  scan();
  observer = new MutationObserver(scan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
})();
