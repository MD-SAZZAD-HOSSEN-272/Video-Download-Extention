// Runs in the page's MAIN world so it can read the YouTube player and Facebook page data.
// Results are posted to content.js (isolated world), which relays them to the background script.
(function () {
  const host = location.hostname;
  const isYT = /(^|\.)youtube\.com$/.test(host);
  const isFB = /(^|\.)(facebook\.com|fb\.watch)$/.test(host);
  let lastKey = "";

  function send(items) {
    const key = items.map((i) => i.url).join("|");
    if (key === lastKey) return;
    lastKey = key;
    window.postMessage({ source: "vd-ext", items }, "*");
  }

  function extFromMime(mime) {
    if (mime.startsWith("audio/mp4")) return "m4a";
    if (mime.startsWith("audio/webm")) return "weba";
    if (mime.startsWith("video/webm")) return "webm";
    return "mp4";
  }

  function ytScan() {
    const player = document.querySelector("#movie_player");
    const pr = (player && player.getPlayerResponse && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
    if (!pr || !pr.videoDetails) return;
    const title = pr.videoDetails.title || document.title;
    const items = [];
    const sd = pr.streamingData || {};
    for (const f of [...(sd.formats || []), ...(sd.adaptiveFormats || [])]) {
      if (!f.url) continue; // ciphered formats are skipped (need yt-dlp)
      const mime = (f.mimeType || "").split(";")[0];
      const isVideo = mime.startsWith("video/");
      let label;
      if (isVideo && f.audioQuality) label = `${f.qualityLabel} (video+audio)`;
      else if (isVideo) label = `${f.qualityLabel} video only`;
      else label = `audio only ${Math.round((f.bitrate || 0) / 1000)}kbps`;
      let size = Number(f.contentLength) || 0;
      let approx = false;
      if (!size) {
        // contentLength is often missing on muxed formats; estimate from bitrate x duration
        const secs = Number(f.approxDurationMs) / 1000 || Number(pr.videoDetails.lengthSeconds) || 0;
        const bps = f.averageBitrate || f.bitrate || 0;
        size = Math.round((bps * secs) / 8);
        approx = size > 0;
      }
      items.push({
        url: f.url, type: mime, size, approx,
        title, label, ext: extFromMime(mime), stream: false,
      });
    }
    // Always offer the yt-dlp fallback (works for ciphered / best-quality merges)
    items.push({ url: location.href, type: "yt-dlp", size: 0, title, label: "Best quality (merged)", cmd: true });
    send(items);
  }

  // Facebook: collect direct URLs from page HTML and from GraphQL/API responses.
  const FB_RE = /"(browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url|hd_src|sd_src)":"(https:[^"]+)"/g;
  const FB_VIDEO_PAGE = /\/(watch|reel|reels|videos|share\/[vr])\b|^fb\.watch$/;
  const fbFound = new Map(); // url -> item
  let fbHref = location.href;

  // Newer Facebook/Reels format: {"progressive_url":"https:...","metadata":{"quality":"HD"}}
  const FB_PROGRESSIVE_RE = /"progressive_url":"(https:[^"]+)"([^}]{0,300}?"quality":"(\w+)")?/g;

  // The page preloads other videos too; keep only URLs found near the current video's ID.
  function fbVideoId() {
    const m = location.pathname.match(/\/(?:reel|reels|videos)\/(\d+)/);
    return m ? m[1] : new URLSearchParams(location.search).get("v") || "";
  }
  function nearId(text, index, id) {
    return !id || text.slice(Math.max(0, index - 4000), index + 4000).includes(id);
  }
  function fbTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    const t = ((og && og.content) || document.title || "").replace(/^\(\d+\+?\)\s*/, "").trim();
    return t && t !== "Facebook" ? t : `facebook-video-${fbVideoId() || Date.now()}`;
  }

  function fbCollect(text) {
    let m;
    const id = fbVideoId();
    FB_PROGRESSIVE_RE.lastIndex = 0;
    while ((m = FB_PROGRESSIVE_RE.exec(text))) {
      if (!nearId(text, m.index, id)) continue;
      let url;
      try { url = JSON.parse('"' + m[1] + '"'); } catch { continue; }
      if (fbFound.has(url)) continue;
      fbFound.set(url, {
        url, type: "video/mp4", size: 0, title: document.title || "facebook-video",
        label: m[3] || "video", ext: "mp4", stream: false,
      });
    }
    FB_RE.lastIndex = 0;
    while ((m = FB_RE.exec(text))) {
      if (!nearId(text, m.index, id)) continue;
      let url;
      try { url = JSON.parse('"' + m[2] + '"'); } catch { continue; }
      if (fbFound.has(url)) continue;
      fbFound.set(url, {
        url, type: "video/mp4", size: 0, title: document.title || "facebook-video",
        label: /hd/i.test(m[1]) ? "HD" : "SD", ext: "mp4", stream: false,
      });
    }
  }

  function fbScan() {
    if (location.href !== fbHref) { fbHref = location.href; fbFound.clear(); }
    fbCollect(document.documentElement.innerHTML);
    const title = fbTitle();
    const items = [...fbFound.values()].map((i) => ({ ...i, title }));
    // yt-dlp can handle any video page, even when no direct link was captured
    if (items.length || FB_VIDEO_PAGE.test(location.pathname) || host === "fb.watch") {
      items.push({ url: location.href, type: "yt-dlp", size: 0, title, label: "Best quality (merged)", cmd: true });
    }
    if (items.length) send(items);
  }

  function hookFacebookNetwork() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = String(args[0] && args[0].url ? args[0].url : args[0]);
        if (/graphql|\/api\//.test(u)) res.clone().text().then(fbCollect).catch(() => {});
      } catch {}
      return res;
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
      this.addEventListener("load", () => {
        try {
          if (/graphql|\/api\//.test(this.responseURL) && (this.responseType === "" || this.responseType === "text"))
            fbCollect(this.responseText);
        } catch {}
      });
      return origSend.apply(this, a);
    };
  }

  let timer;
  function schedule(fn, delay) {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  }

  if (isYT) {
    document.addEventListener("yt-navigate-finish", () => { lastKey = ""; schedule(ytScan, 1500); });
    window.addEventListener("load", () => schedule(ytScan, 1500));
    setInterval(ytScan, 5000);
  } else if (isFB) {
    hookFacebookNetwork();
    new MutationObserver(() => schedule(fbScan, 3000)).observe(document.documentElement, { childList: true, subtree: true });
    schedule(fbScan, 2000);
  }
})();
