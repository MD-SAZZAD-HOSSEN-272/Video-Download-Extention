# Video Downloader (Chrome Extension)

An IDM-style Chrome extension (Manifest V3, plain JavaScript) that detects videos on the page you are viewing and lets you download them. It also includes a small local helper that uses `yt-dlp` for YouTube and Facebook.

> Only download videos you own or have permission to save. YouTube and Facebook terms of service restrict downloading. This project is for personal use and is not meant for the Chrome Web Store.

## Features

- Detects video/audio files from network traffic (`content-type: video/*`, `.mp4`, `.webm`, `.m3u8`, `.mpd`, etc.) and from `<video>` / `<source>` tags.
- Per-tab list in the popup with name, quality and size, plus a badge count on the extension icon.
- **Download** (through Chrome's download manager) and **Copy URL** buttons.
- **YouTube:** lists formats that have a direct link (muxed 360p/720p, video-only, audio-only). Size is estimated (`~`) when YouTube does not provide it.
- **Facebook:** reads direct HD/SD links from the page and from GraphQL/API responses, filtered to the current video's ID (works for reels and private-group videos you can open while logged in).
- **Download (best):** sends the page URL to the local helper, which runs `yt-dlp` and hands the finished file to Chrome, so it appears in Chrome's download list.
- Output prefers H.264 + AAC, so the `.mp4` plays in QuickTime.

## Project structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension config, permissions, content scripts, icons |
| `background.js` | Service worker: detects media requests, keeps a per-tab list, badge, downloads |
| `content.js` | Isolated-world script: scans `<video>` tags, relays data from `site.js` |
| `site.js` | MAIN-world script for YouTube/Facebook: reads player data and Facebook responses |
| `popup.html/.css/.js` | Popup UI, download buttons, helper progress |
| `helper/helper.js` | Local HTTP server (`127.0.0.1:9614`) that runs `yt-dlp` |
| `icons/` | Extension icons (16, 32, 48, 128 px) |

## Setup

### 1. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. After any code change, click the refresh icon on the extension and **refresh the open tab** (Cmd+R). Old tabs keep the previous content script.

### 2. Install the helper tools (once)

```bash
brew install yt-dlp ffmpeg
```

### 3. Start the helper (each time you want "Download (best)")

```bash
cd "/Users/classvel/Next Level/Sazzad Hossen/Video Download Extention"
node helper/helper.js
```

Keep that terminal open. If you see `EADDRINUSE`, a helper is already running. To restart it:

```bash
pkill -f helper/helper.js; node helper/helper.js
```

## Usage

1. Open a page with a video and play it for a few seconds.
2. Click the extension icon.
3. Pick an entry:
   - **Download**: direct file through Chrome (works for plain MP4/WebM links and Facebook HD/SD).
   - **Download (best)**: `yt-dlp` through the helper (YouTube best quality, merged video+audio).
   - **Copy URL** / **Copy yt-dlp cmd**: copy for use elsewhere.

## How it works

1. `background.js` listens to `webRequest.onHeadersReceived` and stores media URLs per tab.
2. `site.js` runs in the page's own context, so it can read YouTube's player response and hook `fetch`/`XMLHttpRequest` on Facebook. It posts results to `content.js`, which sends them to `background.js`.
3. For **Download (best)** the popup calls the helper:
   - `POST /download` starts `yt-dlp` into a temp folder.
   - `GET /status?id=...` reports progress.
   - `GET /file?id=...` serves the finished file; the popup passes this URL to `chrome.downloads`, then the temp file is deleted.
4. The helper only listens on `127.0.0.1` and only accepts download requests from a `chrome-extension://` origin.

## Known limitations

- **YouTube direct links often fail.** Links are tied to the browser session (PO token / signature), so the direct **Download** button can save a `videoplayback.txt` error file. Use **Download (best)** instead.
- **Ciphered YouTube formats** are skipped (no direct URL).
- **HLS/DASH (`.m3u8`, `.mpd`)** streams are not merged in the browser. Use **Copy URL** with `yt-dlp` or `ffmpeg`.
- **DRM-protected video** cannot be downloaded.
- **Facebook:** `yt-dlp`'s Facebook extractor sometimes breaks (`Cannot parse data`). Run `brew upgrade yt-dlp`, or use the HD/SD **Download** entries. Direct links expire, so refresh the page for a fresh link. Size is shown as "unknown size".
- **Private/friends-only Facebook videos** do not work with `yt-dlp` unless it has your cookies: `COOKIES_BROWSER=chrome node helper/helper.js` (macOS shows a Keychain prompt). The HD/SD **Download** entries work without this because Chrome sends your login.
- **4K/1440p on YouTube** uses VP9/AV1, which QuickTime cannot play. Use VLC or IINA. H.264 usually stops at 1080p.
- No multi-connection speed-up like real IDM.
- The helper must be started manually after a restart.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Helper not running` | Start `node helper/helper.js` |
| `Failed: forbidden` | An old helper is still running. `pkill -f helper/helper.js`, then start again |
| `yt-dlp not installed` | `brew install yt-dlp ffmpeg` |
| `Extension context invalidated` | Extension was reloaded; refresh the tab |
| Downloaded `file.json` / `videoplayback.txt` | Server rejected the request; use **Download (best)** |
| QuickTime: "media isn't compatible" | Codec is VP9/AV1/Opus; restart the helper (it now prefers H.264/AAC) and download again, or use VLC |
| Wrong Facebook video listed | Open the video's own page (URL contains `/reel/<id>` or `/watch/?v=<id>`) and refresh |
| No Facebook HD/SD entry | Play the video, wait a few seconds, reopen the popup; Facebook may have changed its data keys |
