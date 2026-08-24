#!/usr/bin/env node
/* 极简静态文件服务器：给 build/ 下的产物（如语音盲听包）做本地预览用。
 * 用法：node tools/serve_static.mjs <目录> [端口=8931]，只听 127.0.0.1。 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const ROOT = path.resolve(process.argv[2] || ".");
const PORT = Number(process.argv[3] || 8931);
const MIME = {
  ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript",
  ".css": "text/css", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml"
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let f = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!path.resolve(f).startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  try {
    if (fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    const body = fs.readFileSync(f);
    res.writeHead(200, { "content-type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end("not found"); }
}).listen(PORT, "127.0.0.1", () => console.log("serving " + ROOT + " at http://127.0.0.1:" + PORT));
