#!/usr/bin/env node
/*
 * 把预烘语音包打成 voice-pack.tar.gz，传到 GitHub Release 给 Vercel demo 用。
 * tools/vercel-fetch-voice.mjs 的注释一直提到这个脚本，但仓库里以前没有（2026-09-16 补）。
 *
 * 为什么要挑一个子集而不是整包：Vercel 的函数解包后有 250MB 上限，而
 * data/voice/ 全量（zh+en 约 6000 条）就 340MB 了，全塞进去部署直接失败。
 * 所以默认只打中文、并且有一道体积闸门，超了就报错，不许悄悄发一个部署不了的包。
 *
 * 用法：
 *   node tools/pack-voice-for-release.mjs                    # 中文全量 -> build/voice-pack.tar.gz
 *   node tools/pack-voice-for-release.mjs --langs zh,en      # 中英都要（注意体积）
 *   node tools/pack-voice-for-release.mjs --prefix BC.,YY.   # 只要这些课程 id 开头的
 *   node tools/pack-voice-for-release.mjs --max-mb 200       # 体积闸门（默认 200）
 *   node tools/pack-voice-for-release.mjs --out /path/x.tar.gz
 *
 * 发布（不要覆盖旧的 Release，出问题还得回退）：
 *   gh release create demo-voice-v2 build/voice-pack.tar.gz --notes "Kokoro-82M 重烘"
 *   然后改 tools/vercel-fetch-voice.mjs 里的 VOICE_PACK_URL
 *
 * 文件名的 sha1 必须和用户那台机器算出来的一致，所以这里和 prevoice.mjs 一样
 * **按随安装包发的配置**（DEFAULT_CONFIG + config.example.json）算，不看本机 config.json。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");

const argv = process.argv.slice(2);
const flag = n => argv.includes("--" + n);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const LANGS = String(opt("langs", "zh")).split(",").map(s => s.trim()).filter(s => s === "zh" || s === "en");
const PREFIXES = String(opt("prefix", "")).split(",").map(s => s.trim()).filter(Boolean);
const MAX_MB = Number(opt("max-mb", 200));
const OUT = path.resolve(opt("out", path.join(S.ROOT, "build", "voice-pack.tar.gz")));
const DRY = flag("dry");

/* 随包发的语音参数：和 prevoice.mjs 同一套口径，哈希调 server.js 的唯一实现 */
const shippedTts = (() => {
  let example = {};
  try { example = JSON.parse(fs.readFileSync(path.join(S.ROOT, "config.example.json"), "utf8")).tts || {}; } catch (_) {}
  return S.deepMerge(S.DEFAULT_CONFIG.tts, example);
})();

/* 课程包里每一步的旁白 -> 需要的文件名（和 prevoice.mjs 的 collect 同口径：
 * trim + 2000 字上限，改一处三处都要改） */
function collect() {
  const seen = new Set(), out = [];
  for (const lang of LANGS) {
    let files = [];
    try { files = fs.readdirSync(path.join(S.LESSON_PACK_DIR, lang)).filter(f => f.endsWith(".json")); } catch (_) {}
    for (const f of files.sort()) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(S.LESSON_PACK_DIR, lang, f), "utf8")); } catch (_) { continue; }
      const lesson = d.lesson || d;
      const id = String(d.curriculumId || f.replace(/\.json$/, ""));
      if (PREFIXES.length && !PREFIXES.some(p => id.startsWith(p))) continue;
      if (!lesson || lesson.isMath === false || !Array.isArray(lesson.steps)) continue;
      for (const step of lesson.steps) {
        const text = String(step.say || "").trim().slice(0, 2000);
        if (!text) continue;
        const h = S.ttsIdWith(shippedTts, text, lang);
        if (seen.has(h)) continue;
        seen.add(h);
        out.push({ id: h, lang, from: id });
      }
    }
  }
  return out;
}

/* ---------------- 最小 tar（ustar）----------------
 * 只打平铺的一层文件，够 vercel-fetch-voice.mjs 解，也能被 tar -tzf 正常列出。 */
function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("000644 \0", 100, 8, "ascii");          // mode
  h.write("000000 \0", 108, 8, "ascii");          // uid
  h.write("000000 \0", 116, 8, "ascii");          // gid
  h.write(size.toString(8).padStart(11, "0") + " ", 124, 12, "ascii");
  h.write("00000000000 ", 136, 12, "ascii");      // mtime 归零：同样的输入打出同样的包
  h.write("        ", 148, 8, "ascii");           // 校验和先填空格
  h.write("0", 156, 1, "ascii");                  // 普通文件
  h.write("ustar\0" + "00", 257, 8, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function main() {
  const want = collect();
  const parts = [];
  let bytes = 0, missing = 0;
  const missingBy = {};
  for (const it of want) {
    let file = null, ext = null;
    for (const e of [".m4a", ".mp3", ".wav"]) {
      const p = path.join(S.VOICE_PACK_DIR, it.id + e);
      try { if (fs.statSync(p).size > 0) { file = p; ext = e; break; } } catch (_) {}
    }
    if (!file) { missing++; missingBy[it.lang] = (missingBy[it.lang] || 0) + 1; continue; }
    const body = fs.readFileSync(file);
    parts.push(tarHeader(it.id + ext, body.length), body,
      Buffer.alloc((512 - body.length % 512) % 512));
    bytes += body.length;
  }
  const mb = n => (n / 1048576).toFixed(1) + " MB";
  console.log("语音参数: engine=" + ((shippedTts.voice || {}).engine || "（无）")
    + " 音色=" + LANGS.map(l => l + ":" + ((shippedTts.voice || {})[l] || "?")).join(" ")
    + " speed=" + shippedTts.speed);
  console.log("课程包:   " + LANGS.join("+") + (PREFIXES.length ? "（只要 " + PREFIXES.join(" / ") + " 开头）" : "")
    + " 共 " + want.length + " 句");
  console.log("有音频:   " + (want.length - missing) + " 条，" + mb(bytes) + "（未压缩）");
  if (missing) {
    console.log("缺音频:   " + missing + " 条 " + JSON.stringify(missingBy) + " —— 先跑 tools/prevoice.mjs 补齐");
  }
  if (!parts.length) { console.error("一条都没有，不打包了。"); process.exit(1); }

  const tar = Buffer.concat([...parts, Buffer.alloc(1024)]);   // 收尾两个空块
  const gz = zlib.gzipSync(tar, { level: 9 });
  console.log("压缩后:   " + mb(gz.length) + "（m4a 本来就压过了，gzip 基本不缩）");
  /* Vercel 的函数是解包后算大小的，所以闸门看未压缩体积。超了宁可现在停，
   * 也别发一个部署时才失败的包。 */
  if (bytes / 1048576 > MAX_MB) {
    console.error("");
    console.error("超过 --max-mb " + MAX_MB + "：Vercel 函数解包后有 250MB 上限，还要留给课程包和代码。");
    console.error("缩一缩：--langs zh（只发中文）或 --prefix BC.（只发某套课程）。");
    process.exit(1);
  }
  if (DRY) { console.log("（--dry，没写文件）"); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, gz);
  console.log("");
  console.log("写好了: " + OUT);
  console.log("发布:   gh release create demo-voice-v2 " + path.relative(S.ROOT, OUT) + " --notes \"Kokoro-82M 重烘\"");
  console.log("        然后改 tools/vercel-fetch-voice.mjs 的 VOICE_PACK_URL");
}

main();
