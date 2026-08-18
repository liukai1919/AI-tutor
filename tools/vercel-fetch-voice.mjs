#!/usr/bin/env node
/*
 * 仅 Vercel 构建期用：把预烘语音包（data/voice/，161MB / 1075 条，见
 * tools/prevoice.mjs）从 GitHub Release 资产下载解包到 data/voice/，
 * 赶在 vercel.json 的 includeFiles 把函数打包之前。
 *
 * 语音包不进 git（见 .gitignore："进了 git 历史就永远删不掉"）——这个脚本
 * 就是绕开那条限制的办法：资产挂在 Release 上，不是 git 对象，repo 本身
 * 干干净净。本地开发、真实安装包都不走这条路：data/voice/ 要么没有（自动
 * 退回浏览器语音），要么是你自己跑 tools/prevoice.mjs 生成的。
 *
 * 重新烘语音包后，用同目录的 pack-voice-for-release.mjs 重新打包上传，
 * 然后这里改 VOICE_PACK_URL 指向新 Release。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "voice");
const VOICE_PACK_URL = process.env.VOICE_PACK_URL
  || "https://github.com/liukai1919/AI-tutor/releases/download/demo-voice-v1/voice-pack.tar.gz";

async function main() {
  if (fs.existsSync(OUT) && fs.readdirSync(OUT).some(f => f.endsWith(".m4a"))) {
    console.log("[voice] data/voice/ already has clips, skipping download");
    return;
  }
  console.log("[voice] downloading " + VOICE_PACK_URL);
  const r = await fetch(VOICE_PACK_URL);
  if (!r.ok) throw new Error("download failed: HTTP " + r.status);
  const gz = Buffer.from(await r.arrayBuffer());
  console.log("[voice] downloaded " + (gz.length / 1048576).toFixed(1) + " MB, unpacking...");
  const buf = zlib.gunzipSync(gz);
  fs.mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(buf.toString("ascii", off + 124, off + 136).replace(/\0.*$/, "").trim() || "0", 8);
    const body = off + 512;
    if (name.endsWith(".m4a")) {
      fs.writeFileSync(path.join(OUT, path.basename(name)), buf.subarray(body, body + size));
      n++;
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  console.log("[voice] unpacked " + n + " clip(s) into " + path.relative(ROOT, OUT));
}

main().catch(e => { console.error("[voice] " + e.message); process.exit(1); });
