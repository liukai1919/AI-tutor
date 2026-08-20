#!/usr/bin/env node
/*
 * 构建期：把「跟大纲学」的课和闯关题一次性生成好，随安装包发出去。
 *
 * 为什么要有它：讲课本来按需现场生成，装完机器上没有 AI 引擎就什么都点不动。
 * 预生成一份课程包（data/lessons/<lang>/<条目id>.json）和题库（qbank.json）之后，
 * 「跟大纲学」和「闯关」变成秒开、免费、断网也能用；拍照出题那类还是得有引擎。
 *
 * 用法：
 *   node tools/pregen.mjs                    # BC 全年级、中英双语、课 + 题
 *   node tools/pregen.mjs --grades 5,6       # 只做某几个年级
 *   node tools/pregen.mjs --langs zh         # 只做一种语言
 *   node tools/pregen.mjs --only lessons     # 只做课（quiz 只做闯关题库，unit 只做单元测试卷）
 *   node tools/pregen.mjs --provider claude  # 指定引擎（默认按 config.json 自动挑）
 *   node tools/pregen.mjs --concurrency 3    # 并发（默认 2；CLI 类引擎别开太大）
 *   node tools/pregen.mjs --limit 3          # 只做前 N 个（先验货再开大批）
 *   node tools/pregen.mjs --force            # 已生成的也重做
 *   node tools/pregen.mjs --books            # 书籍课程也算进来（版权自负，默认只做 BC）
 *   node tools/pregen.mjs --dry              # 只列要做什么，不真跑
 *
 * 断点续跑：已有的默认跳过，中途 Ctrl-C 再跑一次接着做。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");   // 只借提示词和引擎适配器，require 进来不会监听端口

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flag = name => argv.includes("--" + name);
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const LANGS = String(opt("langs", "zh,en")).split(",").map(s => s.trim()).filter(s => s === "zh" || s === "en");
const ONLY = String(opt("only", "all"));
const CONCURRENCY = Math.max(1, Math.min(8, Number(opt("concurrency", 2)) || 2));
const FORCE = flag("force");
const WITH_BOOKS = flag("books");
const DRY = flag("dry");
const GRADES = String(opt("grades", "")).split(",").map(s => s.trim()).filter(Boolean);
const doLessons = ONLY === "all" || ONLY === "lessons";
const doQuiz = ONLY === "all" || ONLY === "quiz";
const doUnit = ONLY === "all" || ONLY === "unit";

/* ---------------- 工作清单 ---------------- */
function sources() {
  const out = [];
  for (const g of S.curriculumGrades()) {
    if (GRADES.length && !GRADES.includes(String(g))) continue;
    out.push(S.curriculum.get(g));
  }
  if (WITH_BOOKS) for (const b of S.curriculumBooks()) out.push(S.curriculum.get(b.id));
  return out;
}
const jobs = [];
for (const data of sources()) {
  for (const item of data.items || []) {
    for (const lang of LANGS) jobs.push({ item, data, lang });
  }
}

/* 单元 = 大纲的一条主线 / 教材的一章。卷子内容只由（年级, 单元, 语言）决定，所以能预生成。 */
const unitJobs = [];
for (const data of sources()) {
  const gradeKey = data.type === "book" ? String(data.bookId) : String(data.grade);
  for (const strand of [...new Set((data.items || []).map(it => it.strand))]) {
    const def = (data.strandDefs || S.STRANDS).find(s => s[0] === strand);
    if (!def) continue;
    for (const lang of LANGS) unitJobs.push({ data, gradeKey, strand, def, lang });
  }
}
const unitFile = (gradeKey, strand, lang) => path.join(S.UNIT_PACK_DIR, lang, gradeKey + "-" + strand + ".json");
function unitDone(j) { return !!S.unitPackGet(j.gradeKey, j.strand, j.lang); }

const lessonFile = (id, lang) => path.join(S.LESSON_PACK_DIR, lang, id + ".json");
function lessonDone(j) { try { return fs.statSync(lessonFile(j.item.id, j.lang)).size > 0; } catch (_) { return false; } }
function quizDone(j) { return !!S.qbankPlayable(j.item.id, j.lang); }

const LIMIT = Number(opt("limit", 0)) || 0;
const cap = a => LIMIT ? a.slice(0, LIMIT) : a;
const todoLessons = cap(doLessons ? jobs.filter(j => FORCE || !lessonDone(j)) : []);
const todoQuiz = cap(doQuiz ? jobs.filter(j => FORCE || !quizDone(j)) : []);
const todoUnit = cap(doUnit ? unitJobs.filter(j => FORCE || !unitDone(j)) : []);

/* ---------------- 小工具 ---------------- */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
  fs.renameSync(tmp, file);
}
const hhmmss = ms => {
  const s = Math.round(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};
async function pool(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }));
}

let stop = false;
process.on("SIGINT", () => {
  if (stop) process.exit(130);
  stop = true;
  console.log("");
  console.log("收到 Ctrl-C：手上这几个跑完就停。已生成的都留着，下次跑接着做。");
});

const t00 = Date.now();
const stats = { lessonOk: 0, lessonFail: 0, quizOk: 0, quizFail: 0, unitOk: 0, unitFail: 0 };
const failures = [];

/* ---------------- 生成一节课 ---------------- */
async function genLesson(j, provider) {
  // 和 /api/lesson 的 teach 分支保持一致；孩子名传空，包里的课对谁都一样
  const sys = S.systemPromptTeach(j.item, j.data, "", j.lang);
  const question = j.lang === "en" ? j.item.en : j.item.zh + "（" + j.item.en + "）";
  const t0 = Date.now();
  let lesson;
  try {
    lesson = await S.runEngine(provider, "pregen:teach", sys, question, null, null, j.lang, null, S.validateLesson);
  } catch (e1) {
    lesson = await S.runEngine(provider, "pregen:teach", sys, question, null, null, j.lang, null, S.validateLesson);   // 和服务器一样，失败重试一次
  }
  writeJson(lessonFile(j.item.id, j.lang), {
    v: 1, curriculumId: j.item.id, lang: j.lang,
    title: j.lang === "en" ? j.item.en : j.item.zh,
    provider, at: new Date().toISOString().slice(0, 10),
    lesson
  });
  return { steps: lesson.steps.length, ms: Date.now() - t0 };
}

/* ---------------- 生成一张单元测试卷 ---------------- */
const UNIT_COUNT = Math.max(6, Math.min(12, Number(opt("unit-count", 8)) || 8));
async function genUnit(j, provider) {
  const sys = S.unitTestPrompt(j.data, j.strand, j.lang, UNIT_COUNT);
  const q = j.lang === "en" ? "Please write this unit test." : "请出这张单元测验。";
  const opts = { schema: S.UNIT_TEST_SCHEMA, hint: S.UNIT_TEST_HINT[j.lang] };
  const t0 = Date.now();
  let set;
  try {
    set = await S.runEngine(provider, "pregen:unit", sys, q, null, null, j.lang, opts, x => S.validateUnitTest(x, j.data, j.strand, UNIT_COUNT));
  } catch (e1) {
    set = await S.runEngine(provider, "pregen:unit", sys, q, null, null, j.lang, opts, x => S.validateUnitTest(x, j.data, j.strand, UNIT_COUNT));
  }
  writeJson(unitFile(j.gradeKey, j.strand, j.lang), {
    v: 1, grade: j.gradeKey, strand: j.strand, lang: j.lang,
    unitName: { zh: j.def[1], en: j.def[2] },
    provider, at: new Date().toISOString().slice(0, 10),
    set: { title: set.title || (j.lang === "en" ? j.def[2] : j.def[1]), questions: set.questions }
  });
  return { n: set.questions.length, ms: Date.now() - t0 };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  await S.detectProviders();
  const provider = S.pickProvider(opt("provider", null));
  if (!provider) {
    console.error("没有可用的 AI 引擎。装一个再来：");
    console.error("  npm i -g @anthropic-ai/claude-code   然后跑一次 claude 登录");
    console.error("或者 gemini / grok / codex / ollama，或者在 config.json 里填 anthropic.apiKey。");
    process.exit(1);
  }

  const meta = S.PROVIDER_META[provider];
  console.log("引擎:     " + provider + (meta ? "（" + meta.label + "）" : ""));
  console.log("范围:     " + sources().map(d => d.type === "book" ? d.bookId : "G" + d.grade).join("、")
    + "   语言 " + LANGS.join("+") + "   并发 " + CONCURRENCY);
  console.log("课程:     " + (doLessons ? todoLessons.length + " 节要生成（共 " + jobs.length + " 节，其余已有）" : "跳过"));
  console.log("题库:     " + (doQuiz ? todoQuiz.length + " 组要生成（共 " + jobs.length + " 组，其余已有）" : "跳过"));
  console.log("单元卷:   " + (doUnit ? todoUnit.length + " 张要生成（共 " + unitJobs.length + " 张，其余已有）" : "跳过"));
  console.log("");

  if (DRY) {
    for (const j of todoLessons) console.log("  课  " + j.lang + "  " + j.item.id + "   " + j.item.zh);
    for (const j of todoQuiz) console.log("  题  " + j.lang + "  " + j.item.id + "   " + j.item.zh);
    for (const j of todoUnit) console.log("  卷  " + j.lang + "  " + j.gradeKey + "-" + j.strand + "   " + j.def[1]);
    return;
  }
  if (!todoLessons.length && !todoQuiz.length && !todoUnit.length) { console.log("没有要做的，已经齐了。"); return; }

  let n = 0;
  const total = todoLessons.length + todoQuiz.length + todoUnit.length;
  const tick = (tag, j, note) => {
    n++;
    const pct = String(Math.round(n / total * 100)).padStart(3, " ");
    console.log("[" + pct + "% " + String(n).padStart(3, " ") + "/" + total + "  " + hhmmss(Date.now() - t00) + "]  "
      + tag + " " + j.lang + " " + j.item.id + "   " + note);
  };

  if (todoLessons.length) {
    console.log("--- 生成课程 ---");
    await pool(todoLessons, CONCURRENCY, async j => {
      if (stop) return;
      try {
        const r = await genLesson(j, provider);
        stats.lessonOk++;
        tick("课", j, r.steps + " 步  " + Math.round(r.ms / 1000) + "s");
      } catch (e) {
        stats.lessonFail++;
        failures.push("课 " + j.lang + " " + j.item.id + "：" + e.message);
        tick("课", j, "失败 — " + e.message);
      }
    });
  }

  if (todoQuiz.length && !stop) {
    console.log("");
    console.log("--- 生成闯关题库 ---");
    await pool(todoQuiz, CONCURRENCY, async j => {
      if (stop) return;
      try {
        const bank = await S.ensureQuizBank(j.item, j.data, j.lang, provider, "pregen:quiz");
        stats.quizOk++;
        tick("题", j, bank.questions.length + " 道");
      } catch (e) {
        stats.quizFail++;
        failures.push("题 " + j.lang + " " + j.item.id + "：" + e.message);
        tick("题", j, "失败 — " + e.message);
      }
    });
  }

  if (todoUnit.length && !stop) {
    console.log("");
    console.log("--- 生成单元测试卷 ---");
    await pool(todoUnit, CONCURRENCY, async j => {
      if (stop) return;
      const label = j.gradeKey + "-" + j.strand;
      try {
        const r = await genUnit(j, provider);
        stats.unitOk++;
        n++;
        console.log("[" + String(Math.round(n / total * 100)).padStart(3, " ") + "% " + String(n).padStart(3, " ") + "/" + total
          + "  " + hhmmss(Date.now() - t00) + "]  卷 " + j.lang + " " + label + "   " + r.n + " 题  " + Math.round(r.ms / 1000) + "s");
      } catch (e) {
        stats.unitFail++; n++;
        failures.push("卷 " + j.lang + " " + label + "：" + e.message);
        console.log("[" + String(n).padStart(3, " ") + "/" + total + "]  卷 " + j.lang + " " + label + "   失败 — " + e.message);
      }
    });
  }

  console.log("");
  console.log("用时 " + hhmmss(Date.now() - t00)
    + "   课 " + stats.lessonOk + " 成 / " + stats.lessonFail + " 败"
    + "   题 " + stats.quizOk + " 成 / " + stats.quizFail + " 败"
    + "   卷 " + stats.unitOk + " 成 / " + stats.unitFail + " 败");
  if (failures.length) {
    console.log("");
    console.log("没成的（再跑一次这个脚本会自动重试，已成的不会重做）：");
    for (const f of failures.slice(0, 40)) console.log("  " + f);
    if (failures.length > 40) console.log("  …还有 " + (failures.length - 40) + " 条");
  }
  const packed = ["zh", "en"].reduce((a, l) => {
    try { return a + fs.readdirSync(path.join(S.LESSON_PACK_DIR, l)).filter(f => f.endsWith(".json")).length; } catch (_) { return a; }
  }, 0);
  console.log("");
  console.log("课程包现在 " + packed + " 节（data/lessons/）。启动 server.js 时开机横幅会报出来。");
}

main().catch(e => { console.error(e); process.exit(1); });
