#!/usr/bin/env node
/*
 * 给 AITutor-APPLE（Swift 版）打一个内容包：大纲 + 技能图谱 + 课程 + 题库 + 单元卷 + 语音。
 * 全是生成好、审过稿的内容，两个平台没理由各烤一遍。
 *
 * 目录按对方报告里规划的布局（docs/handoff-apple.md §3）：
 *   apple-export/
 *   ├── manifest.json                         数量、引擎、语音哈希公式、注意事项
 *   ├── curriculum/bc/*.json                  BC 大纲（G4-G9 + 高中三门），原样
 *   ├── curriculum/skills/*.json              技能图谱（g4-g9 + misconceptions），原样
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
 *
 * 英文逐题审稿 v2 的导出（#45；不带 --review v2 时上面的行为不变）：
 *   node tools/export_apple.mjs --review v2 --skill YY.MATH.FRAC.EQUIV.VISUAL,YY.MATH.DATA.LINE.READ --judge claude --out <目录> [--no-voice] [--dry]
 *     点名条目的英文题库（<id>|en）只导出有当前通过证据的题：--judge（或 config.providerByTask["judge:quiz"] / config.provider）这个审稿引擎
 *     此刻的身份（claude 看 config 的 model / effort）对这道题此刻的内容 + brief / 课文 / 规则 / rubric 有有效非 dry pass，
 *     并且没有任何引擎对同一版本更新的 revise / needs-human。审稿模型不确定（exact:false，比如 claude 没钉 model）→ 证明不了任何题。
 *     字段 = 审稿白名单（qid / level / question / options / answerIndex / explain / tags / visual），usedAt、draft / 审稿元数据一概不带；
 *     qbank-review/ 旁路文件不进包。题库里审不过 / 没审过的老题不删，只是不进这份产物；某一级一道合格的都没有 → 这份题库整份不导出
 *     （manifest 里记 withheld），退出码 2。其余题库（没点名的、中文）按老规则导出。
 *     预检（选条目、审稿引擎、旁路记录读不动、判资格出错）在清空 --out 之前做完，出错退出码 1、上一份导出原样留着。
 *   所有模式：--out 是源码根 / 数据根或它们的上级、或落在 data/、语音 / 课程包、用户数据、qbank-review/ 里 → 报错，不删。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseCli, failArgs, resolveSelection, exportV2Bank, exportJudge, unsafeOutput } from "./lib/qbank_v2_cli.mjs";

/* 先查参数再加载 server.js（--review / --skill 的检查见 qbank_v2_cli.mjs） */
const CLI = parseCli(process.argv.slice(2), "export");
if (CLI.errors.length) { failArgs(CLI.errors, "用法见 tools/export_apple.mjs 文件头。"); process.exit(1); }
const V2 = CLI.review === "v2";

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

/* 输出目录先整个删掉再写：删之前先确认它不是源码 / 数据根（或上级）、不在课程源数据 / 用户数据里（所有模式都查） */
const unsafe = unsafeOutput(OUT, S);
if (unsafe) { failArgs([unsafe]); process.exit(1); }

/* v2 预检：选条目、定审稿引擎身份、读全部正式审稿记录、逐题判资格——全部在清空输出目录之前做完，出错就停，上一份导出原样留着 */
let v2Sel = null, v2Plan = null;
if (V2) {
  let pre = null, preErr = null;
  try {
    const QB = require("../lib/ai/qbank/index.js");
    const sel = resolveSelection(S, CLI.v2.skills);
    for (const s of sel.selected) if (s.id.startsWith("AOPS.")) sel.errors.push(`--skill ${s.id}：AoPS 书籍题库不进内容包（版权）`);
    if (sel.errors.length) pre = { errors: sel.errors };
    else {
      const judge = exportJudge(S, sel.selected[0], CLI.v2.judge);
      if (judge.error) pre = { errors: [judge.error] };
      else {
        const listed = S.qbankReviewStore().listRecords({ dry: false });
        if (listed.errors.length) pre = { errors: listed.errors.map(e => "审稿记录读不动：qbank-review/records/" + e.file + " — " + e.message
          + "（v2 导出要全部记录都可读才能判断资格：坏记录可能正好是某道题最新的「不过」。修好或移走再导）") };
        else pre = { judge, banks: new Map(sel.selected.map(s => [s.key, { sel: s, r: exportV2Bank(S, QB, s, listed.records, judge.identity) }])) };
      }
    }
  } catch (e) { preErr = e; }
  if (preErr) { failArgs(["v2 导出预检出错（输出目录没动）：" + String((preErr && preErr.message) || preErr)]); process.exit(1); }
  if (pre.errors) { failArgs(pre.errors); process.exit(1); }
  v2Sel = new Map([...pre.banks].map(([k, v]) => [k, v.sel]));
  v2Plan = pre;
}
const v2Summary = {};

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

/* ---- 3. 题库：剥 usedAt，AOPS 不进（v2 点名的英文题库：只导出有当前通过证据的题，见文件头） ---- */
if (V2) for (const [key, sel] of v2Sel) {
  const r = v2Plan.banks.get(key).r;
  const kind = sel.id.startsWith("YY.") ? "by-skill" : "legacy-by-standard";
  v2Summary[key] = { exported: r.playable ? r.questions.length : 0, inBank: r.total, levels: r.levels, excluded: r.excluded, briefId: r.briefId, lesson: r.lesson,
    withheld: r.playable ? null : !r.total ? "no English bank" : !r.judge.exact ? "judge model unknown: cannot certify any question" : "some level has no question with current passing review evidence" };
  if (!r.playable) { bump("qbank.v2.withheld"); continue; }
  writeJson(path.join(OUT, "qbank", kind, "en", sel.id + ".json"), { id: sel.id, lang: "en", questions: r.questions });
  bump("qbank." + kind + ".en"); bump("qbank.questions", r.questions.length); bump("qbank.v2.banks"); bump("qbank.v2.questions", r.questions.length);
}
for (const [key, bank] of Object.entries(S.qbank)) {
  if (V2 && v2Sel.has(key)) continue;
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
const voiceId = (text, lang) => S.ttsIdWith(tts, text, lang);   // 哈希只此一份，见 server.js
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
  note: "index[lang][lessonId][stepIndex] = 文件名或 null（该步没有预烘语音，退回设备 TTS）。文件名 = sha1(JSON.stringify([mode, refAudio, refText, instruct[lang], speed, lang, say.trim().slice(0,2000)]))，唯一实现见 server.js 的 ttsIdWith。",
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
    "qbank 每题的 tags 与 options 位置对齐：正确项 'ok'，干扰项是 misconceptions.json 里的误区 id（或 'other'）。这是离线内容 / 维护包，tags（和 qid、visual）按原样保留，供判分后的误区诊断和回补；孩子作答时的界面 / 接口绝不能在作答前展示或下发 tags——'ok' 的位置就是答案。Node 端的答题 HTTP（/api/quiz/session）本来就不下发 answerIndex / explain / tags，由服务端判分。",
    "answerIndex 指向 options 原数组；题库入库时已做答案位置打散，整体分布均匀。",
    "课程 steps[].visual 的唯一事实源是 curriculum/visual-contract.json（本包里就有）：图型白名单 + 每种图的 nums 约定 + 合法范围。共 41 个值（none + 40 种可画）。",
    "越界一律降级成无图（不画）——不要钳位后硬画：看图模式下图就是正文，画错严格差于不画。web 端 public/visual-check.js 和这份契约是同一套判断。",
    "steps[].headline 是可选的新字段：没图的步骤用它撑住看图模式，解码用 decodeIfPresent，老内容不带它。",
    "AoPS 书籍课程、AOPS.* 题库、孩子的进度和做题记录（usedAt）都不在包里。",
    "BC 大纲原文为 BC 省 Crown copyright，展示时保留来源标注（source.url / version）。"
  ]
};
/* v2：只记数量和审稿引擎（模型意见，不是人工审核）；draftId / reviewKey / runId / 报告一概不进包 */
if (V2) manifest.qbankReview = {
  mode: "v2", lang: "en", selected: [...v2Sel.values()].map(s => s.id),
  judge: v2Plan.judge.identity,
  rule: "only questions with a valid non-dry pass from this judge identity for the current content + teaching brief / lesson / rules / rubric, and no later revise / needs-human for the same version from any judge; other banks follow the default export",
  humanApproval: "none", note: "model review only: not a human approval and not proof of educational correctness",
  banks: v2Summary
};
writeJson(path.join(OUT, "manifest.json"), manifest);

console.log((DRY ? "[dry] " : "") + "输出：" + OUT);
for (const [k, v] of Object.entries(counts).sort()) console.log("  " + k.padEnd(34) + String(v).padStart(7));
if (!DRY) {
  const size = (function walk(d) { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? walk(p) : fs.statSync(p).size; } return n; })(OUT);
  console.log("  总大小 " + (size / 1048576).toFixed(1) + " MB");
}
let exitCode = 0;
if (V2) {
  console.log("");
  for (const [key, b] of Object.entries(v2Summary)) {
    const ex = Object.entries(b.excluded).filter(([, n]) => n).map(([k, n]) => k + " " + n).join("  ");
    console.log(`  v2 ${key}：导出 ${b.exported}/${b.inBank}（L1 ${b.levels[1]} / L2 ${b.levels[2]} / L3 ${b.levels[3]}）` + (ex ? "   没导出：" + ex : "") + (b.withheld ? "   ✗ 整份没导出：" + b.withheld : ""));
  }
  if (Object.values(v2Summary).some(b => b.withheld)) { exitCode = 2; console.log("有点名的题库整份没导出（退出码 2）：先补审 / 补题（pregen / audit_qbank --review v2）再导。"); }
}
process.exit(exitCode);
