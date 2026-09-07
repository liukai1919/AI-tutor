#!/usr/bin/env node
/*
 * 审已有题库：把 qbank.json 里现成的题逐份送审稿引擎，按题剔除有问题的，再让 pregen 补齐。
 *
 * 为什么要有它：2026-08-23 抽查 8/21 生成的 BC 题库，3 份里 2 份解析有数学错误——那批题从来
 * 没审过（账本里审稿调用 = 0）。生成时的审稿（pregen --judge）只管新题，老题得单独过一遍。
 *
 * 用法：
 *   node tools/audit_qbank.mjs                       # 审所有 BC.* 题库（老的大纲条目题库）
 *   node tools/audit_qbank.mjs --prefix YY.          # 审技能题库
 *   node tools/audit_qbank.mjs --limit 5 --dry       # 只审 5 份、只报告不改
 *   node tools/audit_qbank.mjs --judge claude        # 指定审稿引擎（默认按 providerByTask["judge:quiz"] 路由）
 *   node tools/audit_qbank.mjs --concurrency 2
 *
 * 做什么：
 *   1. 每份题库 → 审稿 → {pass, problems, bad:[题序号]}，结果逐份追加到 audit-report.jsonl（断点续跑用）
 *   2. bad 里的题从题库删掉（删掉的题原样记在报告里，要反悔能找回）；pass=false 但没给序号的只标记不动
 *   3. 改完存盘。然后跑 `node tools/pregen.mjs --only quiz --force --provider claude --judge` 补齐缺口：
 *      ensureQuizBank 只给「没做过的题不足 4 道」的难度级补题，所以没被剔的题库不会动
 *
 * 账本任务名 audit:quiz，和生成时的 judge:quiz 分开记。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../server.js");

const argv = process.argv.slice(2);
const flag = n => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const PREFIX = String(opt("prefix", "BC."));
const LIMIT = Number(opt("limit", 0)) || 0;
const DRY = flag("dry");
const CONCURRENCY = Math.max(1, Math.min(6, Number(opt("concurrency", 2)) || 2));
const JUDGE_CLI = opt("judge", null);
const REPORT = path.join(S.DATA_ROOT, "audit-report.jsonl");

await S.detectProviders();
const judgeProv = S.pickProvider(JUDGE_CLI, "judge:quiz");
if (!judgeProv) { console.error("没有可用的审稿引擎：--judge <引擎名>，或在 config.providerByTask 里配 judge:quiz"); process.exit(1); }

/* 断点续跑：报告里已经有的 key 跳过 */
const done = new Set();
try { for (const l of fs.readFileSync(REPORT, "utf8").split("\n")) { if (!l.trim()) continue; try { done.add(JSON.parse(l).key); } catch (_) {} } } catch (_) {}

const keys = Object.keys(S.qbank).filter(k => k.startsWith(PREFIX) && (S.qbank[k].questions || []).length && !done.has(k));
const todo = LIMIT ? keys.slice(0, LIMIT) : keys;
console.log(`审稿引擎 ${judgeProv}   题库前缀 ${PREFIX}   待审 ${todo.length} 份（已审跳过 ${done.size}）   并发 ${CONCURRENCY}${DRY ? "   [dry：只报告不改]" : ""}`);
if (!todo.length) process.exit(0);

const stats = { banks: 0, pass: 0, fail: 0, dropped: 0, noIndex: 0, err: 0 };
let n = 0;
const t00 = Date.now();

async function auditOne(key) {
  const [id, lang] = key.split("|");
  const found = S.findCurriculumItem(id);
  const bank = S.qbank[key];
  if (!found) { console.log(`  跳过 ${key}：找不到条目`); return; }
  // 只送审题目本身，去掉 qid/usedAt/tags；顺序不动，审稿返回的序号才对得上
  const qs = bank.questions.map(({ level, question, options, answerIndex, explain }) => ({ level, question, options, answerIndex, explain }));
  const t0 = Date.now();
  let v;
  try {
    v = await S.runEngine(judgeProv, "audit:quiz", S.judgeQuizPrompt(found.item, found.data, qs, lang),
      S.L(lang, "请审这份内容。", "Review this content."), null, null, lang,
      { schema: S.JUDGE_SCHEMA, hint: S.JUDGE_HINT_QUIZ[lang] }, S.validateJudge);
  } catch (e) {
    stats.err++;
    console.log(`[${String(++n).padStart(3)}/${todo.length}] ${key}  审稿出错：${String(e.message).slice(0, 80)}`);
    return;
  }
  stats.banks++;
  const bad = (v.bad || []).filter(i => i < qs.length);
  const rec = { key, at: Date.now(), pass: v.pass, problems: v.problems, bad, removed: [] };
  if (v.pass) stats.pass++;
  else {
    stats.fail++;
    if (!bad.length) { stats.noIndex++; rec.note = "审稿没给题序号，未改动，需人工看"; }
    else {
      rec.removed = bad.map(i => bank.questions[i]);
      if (!DRY) bank.questions = bank.questions.filter((_, i) => !bad.includes(i));
      stats.dropped += bad.length;
    }
  }
  fs.appendFileSync(REPORT, JSON.stringify(rec) + "\n");
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`[${String(++n).padStart(3)}/${todo.length}  ${Math.round((Date.now() - t00) / 60000)}min] ${v.pass ? "过  " : "不过"} ${key}  ${secs}s`
    + (v.pass ? "" : `  剔 ${bad.length}/${qs.length}${bad.length ? "" : "（无序号）"}  ${(v.problems[0] || "").slice(0, 90)}`));
}

async function pool(items, k, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => { for (;;) { const j = i++; if (j >= items.length) return; await worker(items[j]); } }));
}
let stop = false;
process.on("SIGINT", () => { if (stop) process.exit(130); stop = true; console.log("\n收到 Ctrl-C：手上这几份审完就停，已审的都记在报告里。"); });
await pool(todo, CONCURRENCY, async k => { if (!stop) await auditOne(k); });

if (!DRY) S.qbankSave();
console.log("");
console.log(`审了 ${stats.banks} 份：通过 ${stats.pass}，不过 ${stats.fail}（剔掉 ${stats.dropped} 道；${stats.noIndex} 份没给序号未改）；审稿出错 ${stats.err}`);
console.log(`报告：${REPORT}`);
if (!DRY && stats.dropped) console.log("下一步补齐缺口：node tools/pregen.mjs --only quiz --force --provider claude --judge");
process.exit(0);
