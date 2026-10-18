// Detects video/media requests per tab and keeps them in memory + session storage.
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|flv|avi|m3u8|mpd|ts|mp3|m4a)(\?|#|$)/i;
const STREAM_EXT = /\.(m3u8|mpd)(\?|#|$)/i;

// tabId -> Map(url -> item)
const found = new Map();

function getTabMap(tabId) {
  if (!found.has(tabId)) found.set(tabId, new Map());
  return found.get(tabId);
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function addItem(tabId, item) {
  if (tabId < 0) return;
  const map = getTabMap(tabId);
  if (map.has(item.url)) return;
  map.set(item.url, { ...item, time: Date.now() });
  updateBadge(tabId);
  persist();
}

function updateBadge(tabId) {
  const n = found.get(tabId)?.size || 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
}

function persist() {
  const obj = {};
  for (const [tabId, map] of found) obj[tabId] = [...map.values()];
  chrome.storage.session.set({ videos: obj });
}

async function restore() {
  const { videos } = await chrome.storage.session.get("videos");
  for (const [tabId, items] of Object.entries(videos || {})) {
    const map = getTabMap(Number(tabId));
    items.forEach((i) => map.set(i.url, i));
  }
}
const ready = restore();

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.type !== "media" && d.type !== "xmlhttprequest" && d.type !== "other") return;
    const type = header(d.responseHeaders, "content-type").toLowerCase();
    const size = parseInt(header(d.responseHeaders, "content-length"), 10) || 0;
    const isVideoType = type.startsWith("video/") || type.startsWith("audio/") ||
      type.includes("mpegurl") || type.includes("dash+xml");
    // Chunked player segments are not whole files; site.js handles YouTube/Facebook
    if (/googlevideo\.com\/videoplayback/.test(d.url) || /[?&](bytestart|byteend)=/.test(d.url)) return;
    const isVideoUrl = VIDEO_EXT.test(d.url);
    if (!isVideoType && !isVideoUrl) return;
    // Skip tiny segments (HLS .ts chunks, probes)
    if (size && size < 100 * 1024 && !STREAM_EXT.test(d.url)) return;
    if (/\.ts(\?|#|$)/i.test(d.url)) return;

    ready.then(() =>
      addItem(d.tabId, {
        url: d.url,
        type: type || "unknown",
        size,
        stream: STREAM_EXT.test(d.url) || type.includes("mpegurl") || type.includes("dash+xml"),
      })
    );
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Videos reported by content script (<video src>, <source>)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "dom-videos" && sender.tab) {
    ready.then(() => {
      msg.urls.forEach((url) =>
        addItem(sender.tab.id, { url, type: "video/dom", size: 0, stream: STREAM_EXT.test(url) })
      );
    });
  } else if (msg.type === "site-videos" && sender.tab) {
    ready.then(() => {
      const map = getTabMap(sender.tab.id);
      // Replace previous site entries (quality list can change per video)
      for (const [u, it] of map) if (it.title) map.delete(u);
      msg.items.forEach((it) => addItem(sender.tab.id, it));
      updateBadge(sender.tab.id);
      persist();
    });
  } else if (msg.type === "get-videos") {
    ready.then(() => {
      const items = [...(found.get(msg.tabId)?.values() || [])];
      sendResponse({ items });
    });
    return true; // async response
  } else if (msg.type === "download") {
    const name = msg.filename || undefined;
    chrome.downloads.download({ url: msg.url, filename: name, saveAs: !!msg.saveAs }, (id) => {
      sendResponse({ ok: !chrome.runtime.lastError, id, error: chrome.runtime.lastError?.message });
    });
    return true;
  } else if (msg.type === "clear") {
    found.delete(msg.tabId);
    updateBadge(msg.tabId);
    persist();
    sendResponse({ ok: true });
  }
});

// Reset list on navigation; clean up on tab close
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && (info.status === "loading" || /youtube\.com|facebook\.com/.test(info.url))) {
    found.delete(tabId);
    updateBadge(tabId);
    persist();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  found.delete(tabId);
  persist();
});
