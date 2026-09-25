#!/usr/bin/env node
/*
 * 盲听第二轮：第一轮结论是"中文切段可用、英文音色本身不行"，这轮让新引擎上场。
 *
 *   英文 6 题（沿用第一轮的 q07-q12 课文），每题三个盲位：
 *     cur    线上现状（直接复用第一轮的文件）
 *     cv3    CosyVoice 3 + 切段（默认中文参考音跨语种，和现有音色同一个"人"）
 *     qwen   Qwen3-TTS 设计音 + 切段（VoiceDesign 设计的"圆圆老师"，Base 克隆）
 *   中文 2 题（第一轮切段版赢下的 q04/q05），同样三个盲位：
 *     cv2seg 第一轮的切段版（复用文件）
 *     cv3    CosyVoice 3 + 切段（同一条默认中文参考音）
 *     qwen   Qwen 设计音克隆中文（检验"换一个人"中文能不能打）
 *
 * 前置：
 *   9881 = CosyVoice 3 守护进程（tools/tts_server.py --port 9881 --model-dir .../Fun-CosyVoice3-0.5B）
 *   9882 = Qwen3-TTS Base 守护进程（tools/qwen_tts_server.py）
 *   build/voice-abtest2/ref/design-*.wav = qwen_voice_design.py 的产物
 *   build/voice-abtest/ = 第一轮产物（复用 cur / cv2seg）
 *
 * 用法：node tools/voice_abtest2.mjs [--force] [--design N] [--cv3-url ...] [--qwen-url ...]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");

const argv = process.argv.slice(2);
const flag = n => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FORCE = flag("force");
const CV3 = String(opt("cv3-url", "http://localhost:9881")).replace(/\/+$/, "");
const QWEN = String(opt("qwen-url", "http://localhost:9882")).replace(/\/+$/, "");
const R1 = path.join(S.ROOT, "build", "voice-abtest");
const OUT = path.join(S.ROOT, "build", "voice-abtest2");
const GAP_S = Number(opt("gap", 0.32));

/* ---------------- 题目（课文与第一轮同源；reuse 指从第一轮复用哪条管线的文件） ---------------- */
const ITEMS = [
  { id: "r01", lang: "en", file: "BC.MATH.G4.FLU.03", step: 0, label: "英文 · Grade 4 · Snack day 开场", reuse: "cur" },
  { id: "r02", lang: "en", file: "BC.MATH.G4.DAT.01", step: 3, label: "英文 · Grade 4 · Pictograph key", reuse: "cur" },
  { id: "r03", lang: "en", file: "BC.MATH.G5.FLU.01", step: 4, label: "英文 · Grade 5 · Arena 大数（超长段）", reuse: "cur" },
  { id: "r04", lang: "en", file: "BC.MATH.G7.DAT.01", step: 3, label: "英文 · Grade 7 · Circle graph 反推", reuse: "cur" },
  { id: "r05", lang: "en", file: "YY.MATH.ALG.EQ.BALANCE", step: 4, label: "英文 · 技能课 · Scale 常见错误", reuse: "cur" },
  { id: "r06", lang: "en", file: "BC.MATH.G4.FLU.02", step: 7, label: "英文 · Grade 4 · Big numbers 收尾", reuse: "cur" },
  { id: "r07", lang: "zh", file: "BC.MATH.G7.DAT.01", step: 2, label: "中文 · 七年级 · 扇形图百分数", reuse: "seg" },
  { id: "r08", lang: "zh", file: "YY.MATH.ALG.EQ.BALANCE", step: 3, label: "中文 · 技能课 · 天平方程", reuse: "seg" }
];
const REUSE_NAME = { cur: "cur", seg: "cv2seg" };   // 第一轮管线名 → 本轮盲位名
const PIPES = it => it.lang === "en" ? ["cur", "cv3", "qwen"] : ["cv2seg", "cv3", "qwen"];
const NAME = {
  cur: "线上现状（CosyVoice 2 整段）",
  cv2seg: "第一轮切段版（现有音色）",
  cv3: "CosyVoice 3 + 切段（现有音色升级）",
  qwen: "Qwen 设计音 + 切段（新音色）"
};

/* ---------------- ffmpeg / ffprobe ---------------- */
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

/* ---------------- 守护进程 / 切句 / 编码（与第一轮同一套做法） ---------------- */
const toWslPath = p => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? "/mnt/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/") : p.replace(/\\/g, "/");
};
async function synth(daemon, body, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(daemon + "/synth", {
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

const readStep = it => {
  const d = JSON.parse(fs.readFileSync(path.join(S.LESSON_PACK_DIR, it.lang, it.file + ".json"), "utf8"));
  const lesson = d.lesson || d;
  return String(lesson.steps[it.step].say || "").trim();
};
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
  const tmpDir = path.join(OUT, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  /* 第一轮解盲映射：找 cur / seg 的实际文件 */
  const r1m = JSON.parse(fs.readFileSync(path.join(R1, "manifest.json"), "utf8"));
  const r1file = (qid, pipe) => {
    const rec = r1m.items.find(x => x.id === qid);
    const slot = Object.keys(rec.slots).find(s => rec.slots[s] === pipe);
    return path.join(R1, "audio", qid + "-" + slot + ".m4a");
  };
  const R1_QID = { r01: "q07", r02: "q08", r03: "q09", r04: "q10", r05: "q11", r06: "q12", r07: "q04", r08: "q05" };

  /* 设计音：按时长挑（family 试听后可 --design N --force 换） */
  const refDir = path.join(OUT, "ref");
  const designText = fs.readFileSync(path.join(refDir, "design-text.txt"), "utf8").trim();
  let designPick = Number(opt("design", 0)) || 0;
  const pickFile = path.join(refDir, "PICKED.txt");
  if (!designPick && fs.existsSync(pickFile) && !FORCE) designPick = Number(fs.readFileSync(pickFile, "utf8").trim()) || 0;
  if (!designPick) {
    const expect = designText.length / 15;
    const durs = [];
    for (const f of fs.readdirSync(refDir).filter(f => /^design-\d+\.wav$/.test(f)))
      durs.push({ i: Number(f.match(/\d+/)[0]), d: await probeDur(path.join(refDir, f)) });
    if (!durs.length) { console.error("ref/ 里没有 design-*.wav，先跑 tools/qwen_voice_design.py"); process.exit(1); }
    durs.sort((a, b) => Math.abs(a.d - expect) - Math.abs(b.d - expect));
    designPick = durs[0].i;
    fs.writeFileSync(pickFile, String(designPick));
  }
  const designWsl = toWslPath(path.join(refDir, "design-" + designPick + ".wav"));
  console.log("[ref] Qwen 设计音用 design-" + designPick + ".wav");

  /* 两个新守护进程都得活着 */
  for (const [name, url] of [["CosyVoice3", CV3], ["Qwen3-TTS", QWEN]]) {
    const h = await fetch(url + "/health", { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
    if (!h.ok) { console.error(name + " 守护进程没就绪（" + url + "）：" + (h.error || "loading")); process.exit(1); }
  }

  const rnd = mulberry32(20260824);
  const manifest = {
    note: "盲听第二轮解盲文件。slots 里 1/2/3 → 管线名，NAME 是给家长看的说法。别给孩子看。",
    generatedAt: new Date().toISOString(),
    params: { gapSeconds: GAP_S, loudnorm: "I=-16:TP=-1.5:LRA=11", design: "design-" + designPick + ".wav", designText, names: NAME },
    items: []
  };

  for (const it of ITEMS) {
    const say = readStep(it);
    const pipes = PIPES(it);
    /* 洗牌出盲位排列 */
    const order = [...pipes];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const slots = Object.fromEntries(order.map((p, i) => [String(i + 1), p]));
    const rec = { id: it.id, label: it.label, lang: it.lang, lesson: it.file, step: it.step, textLen: say.length, slots, dur: {} };
    console.log("[" + it.id + "] " + it.label + "  len=" + say.length);

    for (const [slot, pipe] of Object.entries(slots)) {
      const dst = path.join(OUT, "audio", it.id + "-" + slot + ".m4a");
      if (!FORCE && fs.existsSync(dst) && fs.statSync(dst).size > 0) {
        rec.dur[slot] = await probeDur(dst);
        console.log("  盲位" + slot + " 已有，跳过（" + rec.dur[slot].toFixed(1) + "s）");
        continue;
      }
      if (pipe === "cur" || pipe === "cv2seg") {
        fs.copyFileSync(r1file(R1_QID[it.id], REUSE_NAME.cur === pipe ? "cur" : "seg"), dst);
        console.log("  盲位" + slot + " " + pipe + " ← 复用第一轮文件");
      } else {
        const chunks = splitSay(say, it.lang);
        console.log("  盲位" + slot + " " + pipe + " ← " + chunks.length + " 块");
        const files = [];
        for (let c = 0; c < chunks.length; c++) {
          const text = S.ttsSpeakable(chunks[c], it.lang);
          const body = pipe === "cv3"
            ? { text, lang: it.lang, mode: "zero_shot", speed: 1.0, refAudio: null, refText: null, refLang: "zh" }
            : { text, lang: it.lang, refAudio: designWsl, refText: designText };
          const wav = await synth(pipe === "cv3" ? CV3 : QWEN, body, it.id + " " + pipe + " 块" + (c + 1) + "/" + chunks.length);
          const f = path.join(tmpDir, it.id + "-" + pipe + "-" + c + ".wav");
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
  console.log("评分页  " + path.join(OUT, "index.html"));
}

/* ---------------- 评分页：三个盲位版 ---------------- */
function writeHtml(manifest) {
  const pub = manifest.items.map(it => ({ id: it.id, label: it.label, lang: it.lang }));
  const secret = Object.fromEntries(manifest.items.map(it => [it.id, it.slots]));
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>圆圆老师声音盲选 · 第二轮</title>
<style>
  :root { --ink:#2b2540; --bg:#eff6ff; --card:#ffffff; --line:#d8e6f5; --accent:#3d7bff; --ok:#3cab6e; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--ink); padding:20px 12px 60px; }
  .wrap { max-width:660px; margin:0 auto; }
  h1 { font-size:24px; text-align:center; margin:8px 0 4px; }
  .sub { text-align:center; color:#70809a; font-size:14px; margin-bottom:14px; }
  .bar { position:sticky; top:0; background:var(--bg); padding:8px 0; z-index:5; text-align:center; font-weight:600; }
  .card { background:var(--card); border:2px solid var(--line); border-radius:16px; padding:14px 16px; margin:14px 0; }
  .card h2 { font-size:17px; margin-bottom:10px; }
  .row { display:flex; align-items:center; gap:12px; padding:7px 0; }
  .tag { font-size:22px; width:36px; text-align:center; }
  .play { font-size:18px; border:none; border-radius:999px; padding:10px 22px; background:#dbe8ff; cursor:pointer; }
  .play.on { background:var(--accent); color:#fff; }
  .picks { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .pick { flex:1 1 30%; font-size:15px; padding:10px 6px; border-radius:12px; border:2px solid var(--line); background:#fff; cursor:pointer; }
  .pick.sel { border-color:var(--ok); background:#e8f7ee; font-weight:700; }
  .done-hint { text-align:center; color:#70809a; margin:20px 0; }
  #result { display:none; background:#fff; border:2px dashed var(--accent); border-radius:16px; padding:16px; margin-top:20px; }
  #result table { width:100%; border-collapse:collapse; font-size:13px; }
  #result td,#result th { border-bottom:1px solid var(--line); padding:6px 4px; text-align:left; }
  #result textarea { width:100%; height:110px; margin-top:10px; font-size:12px; }
  .btn { font-size:15px; border:none; border-radius:12px; padding:10px 18px; background:var(--accent); color:#fff; cursor:pointer; margin-top:8px; }
</style></head><body><div class="wrap">
<h1>🎧 圆圆老师声音盲选 · 第二轮</h1>
<div class="sub">这次每题有三个声音，选最好听的那个（可以反复听）</div>
<div class="bar" id="bar">已完成 0 / ${pub.length}</div>
<div id="list"></div>
<div class="done-hint">全部选完后，下面会出现结果 🎁</div>
<div id="result"></div>
</div><script>
const ITEMS = ${JSON.stringify(pub)};
const SECRET = ${JSON.stringify(secret)};
const NAME = ${JSON.stringify(NAME)};
const KEY = "yy-voice-abtest-v2";
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
const TAGS = { "1": "🅰", "2": "🅱", "3": "🅲" };
const CHOICES = [["1","🅰 最好听"],["2","🅱 最好听"],["3","🅲 最好听"],["tie","差不多"],["neither","都不好听"]];
const list = document.getElementById("list");
ITEMS.forEach((it, idx) => {
  const card = document.createElement("div"); card.className = "card";
  card.innerHTML = '<h2>第' + (idx+1) + '题 · ' + it.label + '</h2>';
  ["1","2","3"].forEach(slot => {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<div class="tag">' + TAGS[slot] + '</div>';
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
  const win = {};
  const rows = ITEMS.map((it, idx) => {
    const c = state[it.id];
    const pipe = c === "tie" || c === "neither" ? c : SECRET[it.id][c];
    win[pipe] = (win[pipe] || 0) + 1;
    return { idx: idx+1, label: it.label, choice: c === "tie" ? "差不多" : c === "neither" ? "都不好听" : NAME[pipe], raw: c, decode: SECRET[it.id] };
  });
  const parts = Object.entries(win).map(([k, n]) => (NAME[k] || (k === "tie" ? "差不多" : "都不好听")) + " <b>" + n + "</b>");
  box.innerHTML = "<h2>📋 结果（给家长看的解盲）</h2>"
    + "<p style='margin:8px 0'>" + parts.join(" ｜ ") + "</p>"
    + "<table><tr><th>#</th><th>题目</th><th>孩子的选择</th></tr>"
    + rows.map(r => "<tr><td>" + r.idx + "</td><td>" + r.label + "</td><td>" + r.choice + "</td></tr>").join("")
    + "</table><textarea readonly id='json'></textarea><br><button class='btn' onclick='copyJson()'>复制结果 JSON</button>";
  document.getElementById("json").value = JSON.stringify({ round: 2, finishedAt: new Date().toISOString(), summary: win, answers: rows }, null, 2);
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
