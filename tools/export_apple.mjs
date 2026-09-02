#!/usr/bin/env node
/*
 * 给 AITutor-APPLE（Swift 版）打一个内容包：大纲 + 技能图谱 + 课程 + 题库 + 单元卷 + 语音。
 * 全是生成好、审过稿的内容，两个平台没理由各烤一遍。
 *
 * 目录按对方报告里规划的布局（docs/handoff-apple.md §3）：
 *   apple-export/
 *   ├── manifest.json                         数量、引擎、语音哈希公式、注意事项
 *   ├── curriculum/bc/*.json                  BC 大纲（G4-G9 + 高中三门），原样
 *   ├── curriculum/skills/*.json              技能图谱（g4-g7 + misconceptions），原样
 *   ├── lessons/standards/<lang>/<条目id>.json  老的大纲条目课（现在是主题总览课）
 *   ├── lessons/skills/<lang>/<技能id>.json     技能微课
 *   ├── qbank/legacy-by-standard/<lang>/<id>.json
 *   ├── qbank/by-skill/<lang>/<skillId>.json   每题 {qid, level, question, options, answerIndex, explain, tags?}
 *   ├── unit-tests/<lang>/<key>-<unit>.json    老的主线卷 + 新的主题卷
 *   ├── voice/<sha1>.m4a                       预烘语音（可 --no-voice 跳过，330MB+）
 *   └── voice/index.json                       { lang: { lessonId: [每步的文件名或 null] } }——对方不用复刻哈希
 *
 * 不进包的：AoPS 书籍（版权）、AOPS.* 题库、孩子的进度/做题记录（usedAt 会剥掉）。
 *
 * 用法：
 *   node tools/export_apple.mjs                     # 输出到 build/apple-export/
 *   node tools/export_apple.mjs --out D:\x\export   # 指定目录
 *   node tools/export_apple.mjs --no-voice          # 不拷语音
 *   node tools/export_apple.mjs --dry               # 只数数，不写
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");
const ROOT = S.ROOT;

const argv = process.argv.slice(2);
const flag = n => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const OUT = path.resolve(opt("out", path.join(ROOT, "build", "apple-export")));
const DRY = flag("dry");
const NO_VOICE = flag("no-voice");
const LANGS = ["zh", "en"];

const counts = {};
const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
const mkdirp = p => { if (!DRY) fs.mkdirSync(p, { recursive: true }); };
const writeJson = (p, obj) => { bump("files"); if (DRY) return; mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 1), "utf8"); };
const copy = (src, dst) => { bump("files"); if (DRY) return; mkdirp(path.dirname(dst)); fs.copyFileSync(src, dst); };

if (!DRY) { fs.rmSync(OUT, { recursive: true, force: true }); mkdirp(OUT); }

/* ---- 1. 大纲 + 技能图谱：原样 ---- */
for (const f of fs.readdirSync(path.join(ROOT, "data", "curriculum", "bc")).filter(f => f.endsWith(".json"))) {
  copy(path.join(ROOT, "data", "curriculum", "bc", f), path.join(OUT, "curriculum", "bc", f)); bump("curriculum.bc");
}
for (const f of fs.readdirSync(path.join(ROOT, "data", "curriculum", "skills")).filter(f => f.endsWith(".json") || f.endsWith(".md"))) {
  copy(path.join(ROOT, "data", "curriculum", "skills", f), path.join(OUT, "curriculum", "skills", f)); bump("curriculum.skills");
}
/* 配图契约：Apple 端 LessonValidator 照它判合法性，别再各抄一份名单 */
copy(path.join(ROOT, "data", "curriculum", "visual-contract.json"), path.join(OUT, "curriculum", "visual-contract.json")); bump("curriculum.visualContract");

/* ---- 2. 课程：按 id 前缀分 standards / skills ---- */
const lessonIndex = {};   // lang -> id -> lesson（语音索引要用）
for (const lang of LANGS) {
  lessonIndex[lang] = {};
  const dir = path.join(S.LESSON_PACK_DIR, lang);
  let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch (_) {}
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    if (id.startsWith("AOPS.")) { bump("skipped.aopsLessons"); continue; }
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const kind = id.startsWith("YY.") ? "skills" : "standards";
    copy(path.join(dir, f), path.join(OUT, "lessons", kind, lang, f));
    bump("lessons." + kind + "." + lang);
    lessonIndex[lang][id] = d.lesson || d;
  }
}

/* ---- 3. 题库：剥 usedAt，AOPS 不进 ---- */
for (const [key, bank] of Object.entries(S.qbank)) {
  const [id, lang] = key.split("|");
  if (!LANGS.includes(lang) || !bank || !(bank.questions || []).length) continue;
  if (id.startsWith("AOPS.")) { bump("skipped.aopsBanks"); continue; }
  const kind = id.startsWith("YY.") ? "by-skill" : "legacy-by-standard";
  const questions = bank.questions.map(({ usedAt, ...q }) => q);   // usedAt 是这个家的做题记录
  writeJson(path.join(OUT, "qbank", kind, lang, id + ".json"), { id, lang, questions });
  bump("qbank." + kind + "." + lang); bump("qbank.questions", questions.length);
}

/* ---- 4. 单元卷 ---- */
for (const lang of LANGS) {
  const dir = path.join(S.UNIT_PACK_DIR, lang);
  let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch (_) {}
  for (const f of files) {
    if (/^aops-/.test(f)) { bump("skipped.aopsUnits"); continue; }
    copy(path.join(dir, f), path.join(OUT, "unit-tests", lang, f));
    bump("unitTests." + (f.startsWith("skills-") ? "topic" : "strand") + "." + lang);
  }
}

/* ---- 5. 语音：文件 + 索引（按随包默认配置算哈希，和 prevoice 一致）---- */
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
const tts = Object.assign({}, S.DEFAULT_CONFIG.tts, example.tts || {});
const voiceId = (text, lang) => crypto.createHash("sha1").update(JSON.stringify(
  [tts.mode, tts.refAudio, tts.refText, (tts.instruct || {})[lang] || "", tts.speed, lang, text])).digest("hex");
const haveVoice = new Set();
try { for (const f of fs.readdirSync(S.VOICE_PACK_DIR)) if (f.endsWith(".m4a")) haveVoice.add(f.replace(/\.m4a$/, "")); } catch (_) {}
const voiceIndex = {};
const used = new Set();
for (const lang of LANGS) {
  voiceIndex[lang] = {};
  for (const [id, lesson] of Object.entries(lessonIndex[lang])) {
    voiceIndex[lang][id] = (lesson.steps || []).map(step => {
      const text = String(step.say || "").trim().slice(0, 2000);    // 和 prevoice / ttsStates 的取词一致
      if (!text) return null;
      const h = voiceId(text, lang);
      if (!haveVoice.has(h)) { bump("voice.missing." + lang); return null; }
      used.add(h); bump("voice.steps." + lang);
      return h + ".m4a";
    });
  }
}
if (!NO_VOICE) {
  for (const h of used) copy(path.join(S.VOICE_PACK_DIR, h + ".m4a"), path.join(OUT, "voice", h + ".m4a"));
  bump("voice.files", used.size);
}
writeJson(path.join(OUT, "voice", "index.json"), {
  note: "index[lang][lessonId][stepIndex] = 文件名或 null（该步没有预烘语音，退回设备 TTS）。文件名 = sha1(JSON.stringify([mode, refAudio, refText, instruct[lang], speed, lang, say.trim().slice(0,2000)])).",
  params: { mode: tts.mode, refAudio: tts.refAudio, refText: tts.refText, instruct: tts.instruct, speed: tts.speed },
  format: "m4a (AAC 48k mono)",
  index: voiceIndex
});

/* ---- 6. manifest ---- */
const manifest = {
  exportedAt: new Date().toISOString(),
  source: "ai-tutor (Node) dev branch",
  counts,
  engines: { lessons: "Claude Opus 5 (effort high) via Claude Code CLI, judged", quizBanks: "same; skill banks 100% judged with per-question rejection", voice: "CosyVoice 2 (tools/tts_server.py), baked by tools/prevoice.mjs" },
  notes: [
    "qbank 每题的 tags 与 options 位置对齐：正确项 'ok'，干扰项是 misconceptions.json 里的误区 id（或 'other'）。tags 只供诊断/回补，绝不能下发给客户端——'ok' 的位置就是答案。",
    "answerIndex 指向 options 原数组；题库入库时已做答案位置打散，整体分布均匀。",
    "课程 steps[].visual 的唯一事实源是 curriculum/visual-contract.json（本包里就有）：图型白名单 + 每种图的 nums 约定 + 合法范围。共 41 个值（none + 40 种可画）。",
    "越界一律降级成无图（不画）——不要钳位后硬画：看图模式下图就是正文，画错严格差于不画。web 端 public/visual-check.js 和这份契约是同一套判断。",
    "steps[].headline 是可选的新字段：没图的步骤用它撑住看图模式，解码用 decodeIfPresent，老内容不带它。",
    "AoPS 书籍课程、AOPS.* 题库、孩子的进度和做题记录（usedAt）都不在包里。",
    "BC 大纲原文为 BC 省 Crown copyright，展示时保留来源标注（source.url / version）。"
  ]
};
writeJson(path.join(OUT, "manifest.json"), manifest);

console.log((DRY ? "[dry] " : "") + "输出：" + OUT);
for (const [k, v] of Object.entries(counts).sort()) console.log("  " + k.padEnd(34) + String(v).padStart(7));
if (!DRY) {
  const size = (function walk(d) { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? walk(p) : fs.statSync(p).size; } return n; })(OUT);
  console.log("  总大小 " + (size / 1048576).toFixed(1) + " MB");
}
process.exit(0);
