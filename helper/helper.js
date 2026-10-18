// Local helper: runs yt-dlp on request from the extension. No dependencies.
// Usage: node helper/helper.js   (needs yt-dlp and ffmpeg installed)
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 9614;
const fs = require("fs");
const crypto = require("crypto");
// yt-dlp saves here; the extension then hands the file to Chrome's download manager
const OUT_DIR = path.join(os.tmpdir(), "video-helper");
fs.mkdirSync(OUT_DIR, { recursive: true });
const jobs = new Map(); // id -> { state, progress, file, error }

function cors(req, res) {
  const origin = req.headers.origin || "";
  const fromExtension = origin.startsWith("chrome-extension://");
  // Chrome omits Origin on same-permission GETs from the extension, so read-only
  // requests may have none. Anything that starts a download must come from the extension.
  if (origin && !fromExtension) return false;
  if (req.method !== "GET" && !fromExtension) return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startJob(url) {
  const id = crypto.randomUUID();
  const job = { state: "running", progress: "starting...", error: "", file: "" };
  jobs.set(id, job);
  const args = [
    // Prefer H.264 + AAC so the mp4 plays in QuickTime (YouTube's VP9/AV1 + Opus does not)
    "-f", "bv*+ba/b",
    "-S", "vcodec:h264,res,acodec:m4a",
    "--merge-output-format", "mp4",
    "--newline", "--quiet", "--progress", "--no-simulate",
    "--print", "after_move:filepath",
    "-o", path.join(OUT_DIR, "%(title).150B [%(id)s].%(ext)s"),
  ];
  // Opt-in: set COOKIES_BROWSER=chrome to use logged-in cookies (triggers a macOS Keychain prompt)
  if (process.env.COOKIES_BROWSER) args.push("--cookies-from-browser", process.env.COOKIES_BROWSER);
  args.push("--", url);
  const p = spawn("yt-dlp", args);
  const onData = (buf) => {
    const lines = buf.toString().split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      if (path.isAbsolute(l)) job.file = l;
      else job.progress = l;
    }
  };
  p.stdout.on("data", onData);
  p.stderr.on("data", (b) => { job.error = b.toString().trim().split("\n").pop(); });
  p.on("error", (e) => {
    job.state = "error";
    job.error = e.code === "ENOENT" ? "yt-dlp not installed (brew install yt-dlp ffmpeg)" : e.message;
  });
  p.on("close", (code) => {
    if (job.state === "error") return;
    job.state = code === 0 && job.file ? "done" : "error";
    if (job.state === "done") job.progress = "done";
    else if (!job.error) job.error = "download failed";
  });
  return id;
}

http
  .createServer((req, res) => {
    if (!cors(req, res)) return json(res, 403, { error: "forbidden" });
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && u.pathname === "/health") return json(res, 200, { ok: true });

    if (req.method === "GET" && u.pathname === "/status") {
      const job = jobs.get(u.searchParams.get("id"));
      if (!job) return json(res, 404, { error: "no such job" });
      return json(res, 200, { state: job.state, progress: job.progress, error: job.error });
    }

    // Serves the finished file so Chrome downloads it (shows in Chrome's download list)
    if (req.method === "GET" && u.pathname === "/file") {
      const job = jobs.get(u.searchParams.get("id"));
      if (!job || job.state !== "done" || !fs.existsSync(job.file)) return json(res, 404, { error: "no file" });
      const name = path.basename(job.file);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": fs.statSync(job.file).size,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      const stream = fs.createReadStream(job.file);
      stream.pipe(res);
      stream.on("end", () => fs.unlink(job.file, () => jobs.delete(u.searchParams.get("id"))));
      return;
    }

    if (req.method === "POST" && u.pathname === "/download") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on("end", () => {
        let url;
        try { url = new URL(JSON.parse(body).url); } catch { return json(res, 400, { error: "bad url" }); }
        if (!/^https?:$/.test(url.protocol)) return json(res, 400, { error: "bad url" });
        json(res, 200, { id: startJob(url.href) });
      });
      return;
    }
    json(res, 404, { error: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Helper listening on http://127.0.0.1:${PORT}, temp dir ${OUT_DIR}`));
