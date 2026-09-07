#!/usr/bin/env node
/*
 * 语音盲听包：给孩子对比「现状管线」和「切段+英文参考音」两种做法，决定要不要换。
 *
 * 出什么：build/voice-abtest/
 *   ├── index.html          评分页（双击就能开，file:// 可用，音频走相对路径）
 *   ├── audio/qNN-{1,2}.m4a 12 题 × 2 个盲位（1/2 是随机位，文件名不泄露是哪条管线）
 *   ├── ref/en-ref-*.wav    自举出来的英文参考音（同一"圆圆"音色，跨语种克隆过桥）
 *   └── manifest.json       解盲映射 + 时长 + 参数（家长看的，别给孩子）
 *
 * 两条管线（音色同源，孩子比的是韵律/节奏/完整度，不是换了个人）：
 *   cur：和线上完全一致——BC 课直接拿 data/voice 里已烘的文件；没烘的按随包参数
 *        现合成（600 字截断、整段一口气、中文参考音，英文走 cross_lingual）。
 *   seg：整段按句切成 6-12 秒的块，块间垫 0.32s 静音再拼接；不截断；中文仍用默认
 *        参考音走 zero_shot，英文用自举参考音也走 zero_shot（refLang=en）。
 *   两条都过一遍 loudnorm 统一响度，免得"响的听着好"。
 *
 * 前置：CosyVoice 守护进程在跑（tools/tts_server.py）+ ffmpeg。
 * 用法：node tools/voice_abtest.mjs            # 断点续跑，已有的文件跳过
 *       node tools/voice_abtest.mjs --force    # 全部重做
 *       node tools/voice_abtest.mjs --en-ref 2 # 换用 ref/en-ref-2.wav 重烘英文 seg
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");

const argv = process.argv.slice(2);
const flag = n => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FORCE = flag("force");
const DAEMON = String(opt("url", (S.cfg.tts && S.cfg.tts.url) || "http://localhost:9880")).replace(/\/+$/, "");
const OUT = path.join(S.ROOT, "build", "voice-abtest");
const GAP_S = Number(opt("gap", 0.32));          // 块间停顿秒数

/* ---------------- 12 段样本（评审时选定，覆盖各种旁白类型） ---------------- */
const ITEMS = [
  { id: "q01", lang: "zh", file: "BC.MATH.G4.FLU.01", step: 0, label: "中文 · 四年级 · 大数加减开场" },
  { id: "q02", lang: "zh", file: "BC.MATH.G4.DAT.02", step: 2, label: "中文 · 四年级 · 转盘与分数" },
  { id: "q03", lang: "zh", file: "BC.MATH.G4.FLU.02", step: 1, label: "中文 · 四年级 · 乘法拆一拆" },
  { id: "q04", lang: "zh", file: "BC.MATH.G7.DAT.01", step: 2, label: "中文 · 七年级 · 扇形图百分数" },
  { id: "q05", lang: "zh", file: "YY.MATH.ALG.EQ.BALANCE", step: 3, label: "中文 · 技能课 · 天平方程" },
  { id: "q06", lang: "zh", file: "BC.MATH.G8.NUM.04", step: 2, label: "中文 · 八年级 · 比与比率（长段）" },
  { id: "q07", lang: "en", file: "BC.MATH.G4.FLU.03", step: 0, label: "英文 · Grade 4 · Snack day 开场" },
  { id: "q08", lang: "en", file: "BC.MATH.G4.DAT.01", step: 3, label: "英文 · Grade 4 · Pictograph key" },
  { id: "q09", lang: "en", file: "BC.MATH.G5.FLU.01", step: 4, label: "英文 · Grade 5 · Arena 大数（超长段）" },
  { id: "q10", lang: "en", file: "BC.MATH.G7.DAT.01", step: 3, label: "英文 · Grade 7 · Circle graph 反推" },
  { id: "q11", lang: "en", file: "YY.MATH.ALG.EQ.BALANCE", step: 4, label: "英文 · 技能课 · Scale 常见错误" },
  { id: "q12", lang: "en", file: "BC.MATH.G4.FLU.02", step: 7, label: "英文 · Grade 4 · Big numbers 收尾" }
];

/* 英文参考音自举：用现在这条中文参考音跨语种合成一句英文，挑一条当英文 zero_shot 的锚。
 * 音色和现状同一个"人"，refText 必须和这句一字不差。 */
const EN_REF_TEXT = "Hello, my friend! I'm Miss Yuanyuan. Today we're going to explore some really fun math together, step by step.";

/* ---------------- 随包语音参数（cur 管线 + 查已烘文件的哈希） ---------------- */
const shippedTts = (() => {
  let example = {};
  try { example = JSON.parse(fs.readFileSync(path.join(S.ROOT, "config.example.json"), "utf8")).tts || {}; } catch (_) {}
  const t = S.deepMerge(S.DEFAULT_CONFIG.tts, example);
  return { mode: t.mode, speed: t.speed, refAudio: t.refAudio, refText: t.refText, refLang: t.refLang, instruct: t.instruct };
})();
const voiceId = (text, lang) => crypto.createHash("sha1").update(JSON.stringify(
  [shippedTts.mode, shippedTts.refAudio, shippedTts.refText, (shippedTts.instruct || {})[lang] || "", shippedTts.speed, lang, text]
)).digest("hex");

/* ---------------- ffmpeg / ffprobe（和 prevoice 一样翻 winget 目录） ---------------- */
const FFMPEG = (() => {
  const given = opt("ffmpeg", "");
  if (given) return given;
  const home = os.homedir();
  const guesses = [path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe")];
  const pkgs = path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages");
  try {
    for (const d of fs.readdirSync(pkgs)) {
      if (!/ffmpeg/i.test(d)) continue;
      for (const sub of fs.readdirSync(path.join(pkgs, d))) guesses.push(path.join(pkgs, d, sub, "bin", "ffmpeg.exe"));
    }
  } catch (_) {}
  for (const g of guesses) { try { if (fs.statSync(g).isFile()) return g; } catch (_) {} }
  return "ffmpeg";
})();
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : path.join(path.dirname(FFMPEG), "ffprobe.exe");

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { windowsHide: true });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; });
    c.stderr.on("data", d => { err += d; });
    c.on("error", reject);
    c.on("close", code => code === 0 ? resolve(out) : reject(new Error(bin + " 退出码 " + code + "：" + err.slice(-300))));
  });
}
const probeDur = async f => {
  try { return Number(await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])) || 0; }
  catch (_) { return 0; }
};

/* ---------------- 守护进程 ---------------- */
const toWslPath = p => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? "/mnt/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/") : p.replace(/\\/g, "/");
};
async function synth(body, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(DAEMON + "/synth", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(300000)
      });
      if (!r.ok) throw new Error("守护进程 " + r.status + "：" + (await r.text()).slice(0, 200));
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) throw new Error("回来的音频只有 " + buf.length + " 字节");
      return buf;
    } catch (e) {
      if (attempt >= 2) throw new Error(label + " 合成失败：" + e.message);
      console.log("  重试 " + label + "（" + e.message + "）");
    }
  }
}

/* ---------------- 切句：目标 6-12 秒一块 ---------------- */
function splitSay(text, lang) {
  const sents = lang === "zh" ? text.split(/(?<=[。！？；!?…])/) : text.split(/(?<=[.!?;])\s+/);
  const max = lang === "zh" ? 90 : 200, min = lang === "zh" ? 25 : 70;
  const out = [];
  let cur = "";
  for (const s0 of sents) {
    const s = s0.trim();
    if (!s) continue;
    if (cur && cur.length + s.length + 1 > max && cur.length >= min) { out.push(cur); cur = s; }
    else cur = cur ? cur + (lang === "zh" ? "" : " ") + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------------- 编码：wav/m4a → loudnorm → m4a（两条管线同一后处理，响度公平） ---------------- */
async function normEncode(src, dst) {
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-filter:a", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-ar", "24000", "-movflags", "+faststart", dst]);
}
async function concatNormEncode(chunkFiles, dst) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const f of chunkFiles) args.push("-i", f);
  const pads = chunkFiles.map((_, i) =>
    `[${i}:a]` + (i < chunkFiles.length - 1 ? `apad=pad_dur=${GAP_S}` : "anull") + `[a${i}]`);
  const filter = pads.join(";") + ";" + chunkFiles.map((_, i) => `[a${i}]`).join("") +
    `concat=n=${chunkFiles.length}:v=0:a=1[cat];[cat]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
  args.push("-filter_complex", filter, "-map", "[out]",
    "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-ar", "24000", "-movflags", "+faststart", dst);
  await run(FFMPEG, args);
}

/* ---------------- 主流程 ---------------- */
const readStep = it => {
  const d = JSON.parse(fs.readFileSync(path.join(S.LESSON_PACK_DIR, it.lang, it.file + ".json"), "utf8"));
  const lesson = d.lesson || d;
  return String(lesson.steps[it.step].say || "").trim();
};
/* 固定种子的洗牌：每题哪个盲位放哪条管线，重跑不变（断点续跑靠它） */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  fs.mkdirSync(path.join(OUT, "audio"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "ref"), { recursive: true });
  const tmpDir = path.join(OUT, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const h = await fetch(DAEMON + "/health", { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!h.ok) { console.error("CosyVoice 守护进程没就绪（" + DAEMON + "）：" + (h.error || "loading")); process.exit(1); }

  /* --- 1. 英文参考音自举：3 条候选，按时长挑最稳的一条 --- */
  const expect = EN_REF_TEXT.length / 15;                       // 英文约 15 字符/秒
  let refPick = Number(opt("en-ref", 0)) || 0;
  const pickFile = path.join(OUT, "ref", "PICKED.txt");
  if (!refPick && fs.existsSync(pickFile) && !FORCE) refPick = Number(fs.readFileSync(pickFile, "utf8").trim()) || 0;
  if (!refPick) {
    console.log("[ref] 自举英文参考音（3 条候选）…");
    const durs = [];
    for (let i = 1; i <= 3; i++) {
      const f = path.join(OUT, "ref", "en-ref-" + i + ".wav");
      const wav = await synth({ text: EN_REF_TEXT, lang: "en", mode: "zero_shot", speed: 1.0, refAudio: null, refText: null, refLang: "zh" }, "en-ref-" + i);
      fs.writeFileSync(f, wav);
      durs.push({ i, d: await probeDur(f) });
      console.log("  en-ref-" + i + ".wav  " + durs[durs.length - 1].d.toFixed(1) + "s");
    }
    durs.sort((a, b) => Math.abs(a.d - expect) - Math.abs(b.d - expect));
    refPick = durs[0].i;
    fs.writeFileSync(pickFile, String(refPick));
    console.log("[ref] 选了 en-ref-" + refPick + ".wav（时长最接近 " + expect.toFixed(1) + "s；试听后可 --en-ref N --force 换）");
  } else {
    console.log("[ref] 用 en-ref-" + refPick + ".wav");
  }
  const enRefWsl = toWslPath(path.join(OUT, "ref", "en-ref-" + refPick + ".wav"));

  /* --- 2. 盲位分配 --- */
  const rnd = mulberry32(20260823);
  const manifest = {
    note: "盲听包解盲文件：slots 里 1/2 → cur(现状管线)/seg(切段+英文参考音)。别把这个给孩子看。",
    generatedAt: new Date().toISOString(),
    params: { gapSeconds: GAP_S, loudnorm: "I=-16:TP=-1.5:LRA=11", enRef: "en-ref-" + refPick + ".wav", enRefText: EN_REF_TEXT, shippedTts },
    items: []
  };

  /* --- 3. 逐题两条管线 --- */
  for (const it of ITEMS) {
    const say = readStep(it);
    const flip = rnd() < 0.5;
    const slots = flip ? { 1: "seg", 2: "cur" } : { 1: "cur", 2: "seg" };
    const rec = { id: it.id, label: it.label, lang: it.lang, lesson: it.file, step: it.step, textLen: say.length, slots, dur: {} };
    console.log("[" + it.id + "] " + it.label + "  len=" + say.length + (say.length > 600 ? "（现状会截断到 600）" : ""));

    for (const [slot, pipe] of Object.entries(slots)) {
      const dst = path.join(OUT, "audio", it.id + "-" + slot + ".m4a");
      if (!FORCE && fs.existsSync(dst) && fs.statSync(dst).size > 0) {
        rec.dur[slot] = await probeDur(dst);
        console.log("  盲位" + slot + " 已有，跳过（" + rec.dur[slot].toFixed(1) + "s）");
        continue;
      }
      if (pipe === "cur") {
        /* 现状：优先直接拿线上已烘文件；没有就按随包参数现合成（600 截断 + 整段） */
        const capped = say.slice(0, 600);
        const baked = path.join(S.VOICE_PACK_DIR, voiceId(capped, it.lang) + ".m4a");
        let src;
        if (fs.existsSync(baked)) {
          src = baked;
          console.log("  盲位" + slot + " cur ← 线上已烘文件");
        } else {
          console.log("  盲位" + slot + " cur ← 按随包参数现合成（这段线上没烘过）");
          const wav = await synth({
            text: S.ttsSpeakable(capped, it.lang), lang: it.lang, mode: shippedTts.mode, speed: shippedTts.speed,
            refAudio: shippedTts.refAudio || null, refText: shippedTts.refText || null, refLang: shippedTts.refLang || "zh"
          }, it.id + "-cur");
          src = path.join(tmpDir, it.id + "-cur.wav");
          fs.writeFileSync(src, wav);
        }
        await normEncode(src, dst);
      } else {
        /* 切段：不截断，整段按句切块，zh 走默认参考音、en 走自举英文参考音，都 zero_shot */
        const chunks = splitSay(say, it.lang);
        console.log("  盲位" + slot + " seg ← " + chunks.length + " 块");
        const files = [];
        for (let c = 0; c < chunks.length; c++) {
          const body = it.lang === "en"
            ? { text: S.ttsSpeakable(chunks[c], "en"), lang: "en", mode: "zero_shot", speed: 1.0, refAudio: enRefWsl, refText: EN_REF_TEXT, refLang: "en" }
            : { text: S.ttsSpeakable(chunks[c], "zh"), lang: "zh", mode: "zero_shot", speed: 1.0, refAudio: null, refText: null, refLang: "zh" };
          const wav = await synth(body, it.id + " 块" + (c + 1) + "/" + chunks.length);
          const f = path.join(tmpDir, it.id + "-seg-" + c + ".wav");
          fs.writeFileSync(f, wav);
          files.push(f);
        }
        await concatNormEncode(files, dst);
      }
      rec.dur[slot] = await probeDur(dst);
      console.log("  盲位" + slot + " → " + path.basename(dst) + "  " + rec.dur[slot].toFixed(1) + "s");
    }
    manifest.items.push(rec);
  }

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeHtml(manifest);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log("\n完成：" + OUT);
  console.log("评分页  " + path.join(OUT, "index.html") + "（双击打开，做完 12 题后页面会给解盲汇总）");
}

/* ---------------- 评分页：单文件、无外部依赖、file:// 直接开 ---------------- */
function writeHtml(manifest) {
  const pub = manifest.items.map(it => ({ id: it.id, label: it.label, lang: it.lang }));
  const secret = Object.fromEntries(manifest.items.map(it => [it.id, it.slots]));
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>圆圆老师声音盲选</title>
<style>
  :root { --ink:#2b2540; --bg:#fff7ef; --card:#ffffff; --line:#f0e2d0; --accent:#ff8b3d; --ok:#3cab6e; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--ink); padding:20px 12px 60px; }
  .wrap { max-width:660px; margin:0 auto; }
  h1 { font-size:24px; text-align:center; margin:8px 0 4px; }
  .sub { text-align:center; color:#8a7f70; font-size:14px; margin-bottom:14px; }
  .bar { position:sticky; top:0; background:var(--bg); padding:8px 0; z-index:5; text-align:center; font-weight:600; }
  .card { background:var(--card); border:2px solid var(--line); border-radius:16px; padding:14px 16px; margin:14px 0; }
  .card h2 { font-size:17px; margin-bottom:10px; }
  .row { display:flex; align-items:center; gap:12px; padding:8px 0; }
  .tag { font-size:22px; width:36px; text-align:center; }
  .play { font-size:18px; border:none; border-radius:999px; padding:10px 22px; background:#ffe3c8; cursor:pointer; }
  .play.on { background:var(--accent); color:#fff; }
  .picks { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .pick { flex:1 1 40%; font-size:15px; padding:10px 6px; border-radius:12px; border:2px solid var(--line); background:#fff; cursor:pointer; }
  .pick.sel { border-color:var(--ok); background:#e8f7ee; font-weight:700; }
  .done-hint { text-align:center; color:#8a7f70; margin:20px 0; }
  #result { display:none; background:#fff; border:2px dashed var(--accent); border-radius:16px; padding:16px; margin-top:20px; }
  #result table { width:100%; border-collapse:collapse; font-size:13px; }
  #result td,#result th { border-bottom:1px solid var(--line); padding:6px 4px; text-align:left; }
  #result textarea { width:100%; height:110px; margin-top:10px; font-size:12px; }
  .btn { font-size:15px; border:none; border-radius:12px; padding:10px 18px; background:var(--accent); color:#fff; cursor:pointer; margin-top:8px; }
</style></head><body><div class="wrap">
<h1>🎧 圆圆老师声音盲选</h1>
<div class="sub">每一题有两个声音，听完选你更喜欢的那个（可以反复听）</div>
<div class="bar" id="bar">已完成 0 / ${pub.length}</div>
<div id="list"></div>
<div class="done-hint">全部选完后，下面会出现结果 🎁</div>
<div id="result"></div>
</div><script>
const ITEMS = ${JSON.stringify(pub)};
const SECRET = ${JSON.stringify(secret)};
const NAME = { cur: "现在的声音（线上管线）", seg: "新做法（切段 + 英文参考音）" };
const KEY = "yy-voice-abtest-v1";
/* 有的内嵌浏览器（data:/沙箱）禁 localStorage，碰一下就抛——退化成内存存档，别把整页搞挂 */
const store = (() => {
  try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); return localStorage; }
  catch (_) { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } }; }
})();
const state = JSON.parse(store.getItem(KEY) || "{}");
let playing = null;

function save(){ store.setItem(KEY, JSON.stringify(state)); refresh(); }
function refresh(){
  const done = ITEMS.filter(it => state[it.id]).length;
  document.getElementById("bar").textContent = "已完成 " + done + " / " + ITEMS.length;
  if (done === ITEMS.length) showResult();
}
function stopAll(){
  if (playing) { playing.audio.pause(); playing.audio.currentTime = 0; playing.btn.textContent = "▶ 播放"; playing.btn.classList.remove("on"); playing = null; }
}
function bindPlay(btn, src){
  const audio = new Audio(src);
  audio.onended = () => { btn.textContent = "▶ 播放"; btn.classList.remove("on"); playing = null; };
  btn.onclick = () => {
    if (playing && playing.btn === btn) { stopAll(); return; }
    stopAll();
    audio.play();
    btn.textContent = "⏸ 停止"; btn.classList.add("on");
    playing = { audio, btn };
  };
}
const CHOICES = [["1","🅰 更好听"],["2","🅱 更好听"],["tie","差不多"],["neither","都不喜欢"]];
const list = document.getElementById("list");
ITEMS.forEach((it, idx) => {
  const card = document.createElement("div"); card.className = "card";
  card.innerHTML = '<h2>第' + (idx+1) + '题 · ' + it.label + '</h2>';
  [["1","🅰"],["2","🅱"]].forEach(([slot, tag]) => {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<div class="tag">' + tag + '</div>';
    const btn = document.createElement("button"); btn.className = "play"; btn.textContent = "▶ 播放";
    bindPlay(btn, "audio/" + it.id + "-" + slot + ".m4a");
    row.appendChild(btn); card.appendChild(row);
  });
  const picks = document.createElement("div"); picks.className = "picks";
  CHOICES.forEach(([val, text]) => {
    const b = document.createElement("button"); b.className = "pick"; b.textContent = text;
    if (state[it.id] === val) b.classList.add("sel");
    b.onclick = () => { state[it.id] = val; picks.querySelectorAll(".pick").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); save(); };
    picks.appendChild(b);
  });
  card.appendChild(picks); list.appendChild(card);
});
function showResult(){
  const box = document.getElementById("result"); box.style.display = "block";
  const rows = ITEMS.map((it, idx) => {
    const c = state[it.id];
    const verdict = c === "tie" ? "差不多" : c === "neither" ? "都不喜欢" : NAME[SECRET[it.id][c]];
    return { idx: idx+1, label: it.label, choice: verdict, raw: c, decode: SECRET[it.id] };
  });
  const win = { cur: 0, seg: 0, tie: 0, neither: 0 };
  rows.forEach(r => { win[r.raw === "tie" || r.raw === "neither" ? r.raw : SECRET[ITEMS[r.idx-1].id][r.raw]]++; });
  box.innerHTML = "<h2>📋 结果（给家长看的解盲）</h2>"
    + "<p style='margin:8px 0'>新做法胜 <b>" + win.seg + "</b> ｜ 现状胜 <b>" + win.cur + "</b> ｜ 差不多 " + win.tie + " ｜ 都不喜欢 " + win.neither + "</p>"
    + "<table><tr><th>#</th><th>题目</th><th>孩子的选择</th></tr>"
    + rows.map(r => "<tr><td>" + r.idx + "</td><td>" + r.label + "</td><td>" + r.choice + "</td></tr>").join("")
    + "</table><textarea readonly id='json'></textarea><br><button class='btn' onclick='copyJson()'>复制结果 JSON</button>";
  document.getElementById("json").value = JSON.stringify({ finishedAt: new Date().toISOString(), summary: win, answers: rows }, null, 2);
}
function copyJson(){
  const ta = document.getElementById("json"); ta.select();
  try { document.execCommand("copy"); } catch (_) {}
  if (navigator.clipboard) navigator.clipboard.writeText(ta.value).catch(() => {});
}
refresh();
</script></body></html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
}

main().catch(e => { console.error(e); process.exit(1); });
