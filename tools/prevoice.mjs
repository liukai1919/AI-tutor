#!/usr/bin/env node
/*
 * 构建期：把课程包里每一步的旁白提前用 CosyVoice 合成好，压成 m4a 装进安装包。
 *
 * 装完机器上没有 CosyVoice 的人（绝大多数）也能听到自然的真人声，而不是浏览器
 * 那个生硬的合成音。包是只读的：server.js 播放时先查 tts-cache/<id>.wav（本机现场
 * 合成的），再查 data/voice/<id>.m4a（这个包）。
 *
 * 文件名的 sha1 必须和用户那台机器算出来的一致，所以这里**按随安装包发的配置**
 * （DEFAULT_CONFIG + config.example.json）算哈希，而不是本机 config.json——本机
 * 可能改过 speed / refAudio，那样烘出来的包用户根本命中不了。
 *
 * 前置：CosyVoice 守护进程跑着（tools/tts_server.py，见 README）+ ffmpeg 在 PATH 里。
 *
 * 用法：
 *   node tools/prevoice.mjs                  # 课程包里所有中文课
 *   node tools/prevoice.mjs --langs zh,en    # 中英都烘（体积翻倍）
 *   node tools/prevoice.mjs --url http://localhost:9880
 *   node tools/prevoice.mjs --limit 20       # 先烘几条听听
 *   node tools/prevoice.mjs --bitrate 40k    # 默认 48k 单声道
 *   node tools/prevoice.mjs --keep-wav       # 不压，直接存 wav（体积约 10 倍）
 *   node tools/prevoice.mjs --dry            # 只统计要烘多少条、大概多大
 *
 * 断点续跑：已有的跳过，Ctrl-C 之后再跑接着来。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flag = name => argv.includes("--" + name);
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const LANGS = String(opt("langs", "zh")).split(",").map(s => s.trim()).filter(s => s === "zh" || s === "en");
const LIMIT = Number(opt("limit", 0)) || 0;
const BITRATE = String(opt("bitrate", "48k"));
const KEEP_WAV = flag("keep-wav");
const DRY = flag("dry");
const DAEMON = String(opt("url", (S.cfg.tts && S.cfg.tts.url) || "http://localhost:9880")).replace(/\/+$/, "");

/* winget 装的 ffmpeg 只把自己的 bin 加进用户 PATH，当前这个 shell 往往还看不到，
 * 所以 PATH 里找不到就去它的包目录翻一下。--ffmpeg 可以直接指定。 */
const FFMPEG = (() => {
  const given = opt("ffmpeg", "");
  if (given) return given;
  const home = os.homedir();
  const guesses = [path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe")];
  const pkgs = path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages");
  try {
    for (const d of fs.readdirSync(pkgs)) {
      if (!/ffmpeg/i.test(d)) continue;
      for (const sub of fs.readdirSync(path.join(pkgs, d))) {
        guesses.push(path.join(pkgs, d, sub, "bin", "ffmpeg.exe"));
      }
    }
  } catch (_) {}
  for (const g of guesses) { try { if (fs.statSync(g).isFile()) return g; } catch (_) {} }
  return "ffmpeg";   // 交给 PATH
})();

/* ---------------- 随包发的语音参数（决定文件名哈希） ---------------- */
const shippedTts = (() => {
  let example = {};
  try { example = JSON.parse(fs.readFileSync(path.join(S.ROOT, "config.example.json"), "utf8")).tts || {}; } catch (_) {}
  const t = S.deepMerge(S.DEFAULT_CONFIG.tts, example);
  // url / command / cacheDir 之类不参与哈希，清掉免得看花眼
  return { mode: t.mode, speed: t.speed, refAudio: t.refAudio, refText: t.refText, refLang: t.refLang, instruct: t.instruct };
})();
function voiceId(text, lang) {
  const t = shippedTts;
  return crypto.createHash("sha1").update(JSON.stringify(
    [t.mode, t.refAudio, t.refText, (t.instruct || {})[lang] || "", t.speed, lang, text]
  )).digest("hex");
}

/* ---------------- 工作清单：课程包里每一步的 say ---------------- */
function collect() {
  const seen = new Set(), out = [];
  for (const lang of LANGS) {
    let files = [];
    try { files = fs.readdirSync(path.join(S.LESSON_PACK_DIR, lang)).filter(f => f.endsWith(".json")); } catch (_) {}
    for (const f of files.sort()) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(S.LESSON_PACK_DIR, lang, f), "utf8")); } catch (_) { continue; }
      const lesson = d.lesson || d;
      if (!lesson || lesson.isMath === false || !Array.isArray(lesson.steps)) continue;
      for (const step of lesson.steps) {
        // 和 ttsStates 的取词一致：trim + 600 字上限，否则哈希对不上
        const text = String(step.say || "").trim().slice(0, 600);
        if (!text) continue;
        const id = voiceId(text, lang);
        if (seen.has(id)) continue;      // 不同课撞上同一句：只烘一次
        seen.add(id);
        out.push({ id, text, lang, from: d.curriculumId || f });
      }
    }
  }
  return out;
}

const outPath = id => path.join(S.VOICE_PACK_DIR, id + (KEEP_WAV ? ".wav" : ".m4a"));
function done(id) {
  for (const ext of [".m4a", ".mp3", ".wav"]) {
    try { if (fs.statSync(path.join(S.VOICE_PACK_DIR, id + ext)).size > 0) return true; } catch (_) {}
  }
  return false;
}

/* ---------------- 合成 + 压缩 ---------------- */
async function synth(item) {
  const r = await fetch(DAEMON + "/synth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: S.ttsSpeakable(item.text, item.lang), lang: item.lang,   // 读音归一（Ms. → Miss），哈希仍按原文
      mode: shippedTts.mode, speed: shippedTts.speed,
      refAudio: shippedTts.refAudio || null, refText: shippedTts.refText || null,
      refLang: shippedTts.refLang || "zh",
      instruct: (shippedTts.instruct || {})[item.lang] || ""
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) throw new Error("守护进程 " + r.status + "：" + (await r.text()).slice(0, 200));
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error("回来的音频只有 " + buf.length + " 字节，不像是真的");
  return buf;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { windowsHide: true });
    let err = "";
    c.stderr.on("data", d => { err += d; });
    c.on("error", reject);
    c.on("close", code => code === 0 ? resolve() : reject(new Error(bin + " 退出码 " + code + "：" + err.slice(-300))));
  });
}

async function encode(wavBuf, id) {
  fs.mkdirSync(S.VOICE_PACK_DIR, { recursive: true });
  const dst = outPath(id);
  if (KEEP_WAV) { fs.writeFileSync(dst, wavBuf); return fs.statSync(dst).size; }
  const tmp = path.join(os.tmpdir(), "yy-voice-" + id.slice(0, 12) + ".wav");
  fs.writeFileSync(tmp, wavBuf);
  try {
    // 语音单声道 24k 足够；-movflags faststart 让浏览器不用下完整个文件就能起播
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp,
      "-c:a", "aac", "-b:a", BITRATE, "-ac", "1", "-ar", "24000", "-movflags", "+faststart", dst]);
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  return fs.statSync(dst).size;
}

/* ---------------- 主流程 ---------------- */
const mb = n => (n / 1048576).toFixed(1) + " MB";
const hhmmss = ms => {
  const s = Math.round(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

let stop = false;
process.on("SIGINT", () => {
  if (stop) process.exit(130);
  stop = true;
  console.log("");
  console.log("收到 Ctrl-C：这条烘完就停。已烘的都留着，下次接着来。");
});

async function main() {
  const all = collect();
  const todo = (LIMIT ? all.filter(i => !done(i.id)).slice(0, LIMIT) : all.filter(i => !done(i.id)));

  console.log("语音参数: mode=" + shippedTts.mode + " speed=" + shippedTts.speed
    + (shippedTts.refAudio ? " refAudio=" + path.basename(shippedTts.refAudio) : " refAudio=（无）")
    + "   ← 按 config.example.json 算哈希，用户装完才对得上");
  const liveId = S.ttsId(all[0] ? all[0].text : "x", "zh");
  const packId = voiceId(all[0] ? all[0].text : "x", "zh");
  if (all.length && liveId !== packId) {
    console.log("注意:     本机 config.json 的语音参数和随包发的不一样。");
    console.log("          烘出来的包用户能命中，但你本机现场合成的缓存跟它对不上（不影响正确性，只是各存一份）。");
  }
  console.log("守护进程: " + DAEMON);
  console.log("课程包:   " + LANGS.join("+") + " 共 " + all.length + " 句不重复的旁白");
  console.log("要烘:     " + todo.length + " 句（其余已有）");
  console.log("");

  if (DRY) {
    const per = KEEP_WAV ? 900000 : 60000;   // 粗估：wav 约 0.9MB/句，48k 的 m4a 约 60KB/句
    console.log("预计体积 " + mb(todo.length * per) + " 左右（" + (KEEP_WAV ? "wav" : "m4a " + BITRATE) + "）");
    return;
  }
  if (!todo.length) { console.log("没有要烘的，已经齐了。"); return; }

  try {
    const h = await fetch(DAEMON + "/health", { signal: AbortSignal.timeout(8000) }).then(r => r.json());
    if (!h.ok) throw new Error(h.error || (h.loading ? "模型还在加载" : "没准备好"));
  } catch (e) {
    console.error("连不上 CosyVoice 守护进程（" + DAEMON + "）：" + e.message);
    console.error("先把它跑起来：python tools/tts_server.py --port 9880（通常在 WSL 里，见 README）");
    process.exit(1);
  }
  if (!KEEP_WAV) {
    try { await run(FFMPEG, ["-hide_banner", "-version"]); }
    catch (_) {
      console.error("PATH 里没有 ffmpeg，压不了 m4a。装一个（winget install Gyan.FFmpeg），");
      console.error("或者加 --keep-wav 直接存 wav（体积大约 10 倍）。");
      process.exit(1);
    }
  }

  const t0 = Date.now();
  let ok = 0, fail = 0, bytes = 0;
  const failures = [];
  // GPU 上守护进程本来就是一条一条排队的，这里不并发，省得白排
  for (let i = 0; i < todo.length; i++) {
    if (stop) break;
    const it = todo[i];
    try {
      const size = await encode(await synth(it), it.id);
      ok++; bytes += size;
      console.log("[" + String(Math.round((i + 1) / todo.length * 100)).padStart(3, " ") + "% "
        + String(i + 1).padStart(4, " ") + "/" + todo.length + "  " + hhmmss(Date.now() - t0) + "]  "
        + it.lang + " " + it.from + "  " + (size / 1024).toFixed(0) + " KB  " + it.text.slice(0, 28));
    } catch (e) {
      fail++; failures.push(it.from + "（" + it.text.slice(0, 20) + "）：" + e.message);
      console.log("[" + String(i + 1).padStart(4, " ") + "/" + todo.length + "]  失败 " + it.from + " — " + e.message);
    }
  }

  let total = 0, count = 0;
  try {
    for (const f of fs.readdirSync(S.VOICE_PACK_DIR)) {
      total += fs.statSync(path.join(S.VOICE_PACK_DIR, f)).size; count++;
    }
  } catch (_) {}
  console.log("");
  console.log("用时 " + hhmmss(Date.now() - t0) + "   成 " + ok + " / 败 " + fail + "   本次 " + mb(bytes));
  console.log("语音包现在 " + count + " 条，共 " + mb(total) + "（data/voice/）");
  if (failures.length) {
    console.log("");
    console.log("没成的（再跑一次会自动重试）：");
    for (const f of failures.slice(0, 20)) console.log("  " + f);
    if (failures.length > 20) console.log("  …还有 " + (failures.length - 20) + " 条");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
