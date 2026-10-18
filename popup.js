const list = document.getElementById("list");
const empty = document.getElementById("empty");

function fmtSize(b) {
  if (!b) return "unknown size";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fileName(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop());
    return last || "video";
  } catch {
    return "video";
  }
}

function safeName(name, item) {
  // downloads API needs a relative, sanitized path
  let n = name.replace(/[\\/:*?"<>|]/g, "_");
  if (!/\.\w{2,5}$/.test(n)) {
    const ext = item.type.includes("webm") ? "webm" : "mp4";
    n += "." + ext;
  }
  return n;
}

const HELPER = "http://127.0.0.1:9614";

// Sends the page URL to the local helper (yt-dlp) and shows progress in the meta line.
async function helperDownload(url, btn, meta) {
  btn.disabled = true;
  try {
    const r = await fetch(`${HELPER}/download`, { method: "POST", body: JSON.stringify({ url }) });
    const { id } = await r.json();
    for (;;) {
      await new Promise((res) => setTimeout(res, 1000));
      const s = await (await fetch(`${HELPER}/status?id=${id}`)).json();
      if (s.state === "running") { meta.textContent = s.progress; continue; }
      if (s.state === "done") {
        // Hand the finished file to Chrome so it shows in the browser's download list
        await chrome.downloads.download({ url: `${HELPER}/file?id=${id}` });
        meta.textContent = "Sent to Chrome downloads";
      } else {
        meta.textContent = `Failed: ${s.error}`;
      }
      break;
    }
  } catch {
    meta.textContent = "Helper not running. Start it: node helper/helper.js";
  }
  btn.disabled = false;
}

function render(items) {
  list.innerHTML = "";
  empty.hidden = items.length > 0;
  items.sort((a, b) => b.time - a.time).forEach((item) => {
    const li = document.createElement("li");
    const name = item.title ? `${item.title} [${item.label}].${item.ext || "mp4"}` : fileName(item.url);

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name"></div><div class="meta"></div>`;
    info.querySelector(".name").textContent = item.title || name;
    info.querySelector(".name").title = item.url;
    info.querySelector(".meta").textContent = item.cmd
      ? `${item.label} · needs yt-dlp installed`
      : `${item.label || (item.stream ? "Stream (HLS/DASH)" : item.type)} · ${item.approx ? "~" : ""}${fmtSize(item.size)}`;

    const copy = document.createElement("button");
    copy.className = "secondary";
    copy.textContent = item.cmd ? "Copy yt-dlp cmd" : "Copy URL";
    copy.onclick = () =>
      navigator.clipboard.writeText(item.cmd ? `yt-dlp "${item.url}"` : item.url);

    const dl = document.createElement("button");
    dl.textContent = "Download";
    dl.onclick = async () => {
      const res = await chrome.runtime.sendMessage({
        type: "download",
        url: item.url,
        filename: safeName(name, item),
      });
      dl.textContent = res.ok ? "Started" : "Failed";
      if (!res.ok) dl.title = res.error;
    };

    li.append(info, copy);
    if (item.cmd) {
      const best = document.createElement("button");
      best.textContent = "Download (best)";
      best.onclick = () => helperDownload(item.url, best, info.querySelector(".meta"));
      li.append(best);
    }
    // Playlists (.m3u8/.mpd) are not a single file; offer copy only (use ffmpeg/yt-dlp).
    if (!item.stream && !item.cmd) li.append(dl);
    list.append(li);
  });
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { items } = await chrome.runtime.sendMessage({ type: "get-videos", tabId: tab.id });
  render(items);
  document.getElementById("clear").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "clear", tabId: tab.id });
    render([]);
  };
}
load();
