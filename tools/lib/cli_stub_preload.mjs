/*
 * 命令行脚本（pregen / audit_qbank / export_apple）的隔离测试预载器（#45）。只给测试用：
 *
 *   YY_DATA_DIR=<临时目录> YY_STUB_SCRIPT=<脚本.json> node --import <本文件的 file:// URL> tools/pregen.mjs ...
 *
 * 在被测脚本 require server.js 之前先把它加载进同一个 require 缓存，然后：
 *   - 7 个内置引擎适配器全部换成「一调就抛错」，引擎探测换成空操作——不联网、不起任何真实 CLI、不花钱；
 *   - 脚本里声明的假引擎（可以用内置的名字，比如 claude）挂进 ADAPTERS / detected，detected[id].model 是它声明的模型；
 *   - 假引擎按脚本回答：出题（按条目排队的批次）、v2 审稿（按题干子串 / qid 的规则逐题给结论）、修复、v1 审稿；
 *   - 可选的故障 / 覆盖：报告写失败、qbank.json 写失败、qbank.json 写完就崩、已跟踪文件（课文 / 契约）的读取覆盖、规则版本改动。
 * 每次调用追加一行到 <DATA>/stub-calls.jsonl，出题队列的消耗记在 <DATA>/stub-state.json（跨进程续跑也接得上）。
 *
 * 安全闸（都在加载 server.js 之前）：YY_DATA_DIR 必须是真实存在、规范路径（realpath，符号链接展开后）在系统临时目录之下的目录，
 * 而且已经用 tools/lib/test_fixtures.mjs 初始化过（.migrated-from-app、config.json、qbank.json、data/ 都在）——
 * 否则 server.js 会把它当成新数据目录，从仓库根目录「接管」个人数据 / 配置。任何一条不满足 → 退出码 97，什么都不加载。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const refuse = why => { console.error("cli_stub_preload: refusing to run — " + why); process.exit(97); };
const real = p => { try { return fs.realpathSync.native(p); } catch (_) { return null; } };
const RAW = process.env.YY_DATA_DIR || "";
const DATA = RAW ? real(path.resolve(RAW)) : null;
const TMP = real(os.tmpdir());
const within = (p, dir) => { const r = path.relative(dir.toLowerCase(), p.toLowerCase()); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
if (!DATA || !TMP || !fs.statSync(DATA).isDirectory()) refuse("YY_DATA_DIR must be an existing directory (got " + JSON.stringify(RAW) + ")");
if (!within(DATA, TMP) || within(real(ROOT), DATA) || DATA.toLowerCase() === (real(ROOT) || "").toLowerCase()) refuse("YY_DATA_DIR must resolve inside the system temp folder and away from the repository: " + DATA);
for (const f of [".migrated-from-app", "config.json", "qbank.json", "data"]) if (!fs.existsSync(path.join(DATA, f))) refuse("YY_DATA_DIR is not an initialized isolated data dir (missing " + f + "; use prepareIsolatedDataDir)");
if (process.env.YY_DEMO) refuse("YY_DEMO must not be set (skills are not loaded under demo)");

const script = process.env.YY_STUB_SCRIPT ? JSON.parse(fs.readFileSync(process.env.YY_STUB_SCRIPT, "utf8")) : {};
const CALLS = path.join(DATA, "stub-calls.jsonl"), STATE = path.join(DATA, "stub-state.json");
const realWrite = fs.writeFileSync, realRename = fs.renameSync, realRead = fs.readFileSync, realAppend = fs.appendFileSync;
const logCall = o => realAppend.call(fs, CALLS, JSON.stringify(o) + "\n");
const readState = () => { try { return JSON.parse(realRead.call(fs, STATE, "utf8")); } catch (_) { return { gen: {} }; } };
const writeState = s => realWrite.call(fs, STATE, JSON.stringify(s));

/* ---- 文件故障 / 覆盖（只认脚本点名的路径） ---- */
const faults = script.faults || {};
/* server 用的是 path.resolve(YY_DATA_DIR)，这里比较时两种写法（原样 / realpath）都认，不分大小写 */
const ROOTS = [...new Set([DATA, path.resolve(RAW)].map(p => p.toLowerCase()))];
const isQbankFile = p => ROOTS.some(r => path.resolve(String(p)).toLowerCase() === path.join(r, "qbank.json"));
const inReports = p => ROOTS.some(r => within(path.resolve(String(p)), path.join(r, "qbank-review", "reports")));
let qbankWrites = 0;
fs.writeFileSync = function (p, ...a) {
  if (faults.reportsWrite && typeof p === "string" && inReports(p)) throw Object.assign(new Error("EIO: injected report write failure"), { code: "EIO" });
  return realWrite.call(fs, p, ...a);
};
fs.renameSync = function (a, b) {
  const q = isQbankFile(b);
  if (faults.qbankWrite && q) throw Object.assign(new Error("EPERM: injected qbank.json rename failure"), { code: "EPERM" });
  const r = realRename.call(fs, a, b);
  if (q && faults.crashAfterQbankWrite && ++qbankWrites >= faults.crashAfterQbankWrite) {
    logCall({ kind: "crash", after: "qbank.json write " + qbankWrites });
    process.exit(9);
  }
  return r;
};
const overlay = new Map(Object.entries(script.overlay || {}).map(([rel, v]) => [path.join(ROOT, rel), v]));
fs.readFileSync = function (p, ...a) {
  const s = typeof p === "string" ? path.resolve(p) : null;
  if (s && overlay.has(s)) {
    const v = overlay.get(s);
    if (v === null) throw Object.assign(new Error("ENOENT: overlay says missing: " + s), { code: "ENOENT" });
    return v;
  }
  return realRead.call(fs, p, ...a);
};

/* ---- 加载 server.js（静音），拆掉真实引擎 ---- */
const log = console.log;
console.log = () => {};
let S;
try { S = require("../../server.js"); } finally { console.log = log; }
if ((real(S.DATA_ROOT) || "").toLowerCase() !== DATA.toLowerCase()) { console.error("cli_stub_preload: server.js did not pick up YY_DATA_DIR"); process.exit(97); }
const QB = require("../../lib/ai/qbank/index.js");
if (script.rulesVersion) QB.DEFAULT_RULES.version = script.rulesVersion;
for (const id of Object.keys(S.ADAPTERS)) S.ADAPTERS[id] = async () => { throw new Error("cli_stub_preload: real engine " + id + " is disabled in tests"); };
for (const k of Object.keys(S.detected)) delete S.detected[k];
S.detectProviders = async () => { logCall({ kind: "detect" }); };

/* ---- 假引擎 ---- */
const clone = v => JSON.parse(JSON.stringify(v));
const itemsOf = sys => JSON.parse(sys.slice(sys.lastIndexOf("\n[") + 1));
/* 规则按 qid 或题干子串匹配；unless = 题目 JSON 里出现这段文字就不算（修好之后的版本不再命中） */
const firstRule = (list, it) => (list || []).find(r => ((r.qid && r.qid === it.qid) || (r.match && String(it.question || "").includes(r.match)))
  && !(r.unless && JSON.stringify(it).includes(r.unless)));
function verdictFor(it, lessonPresent, rule) {
  const kind = rule ? rule.verdict : "pass";
  const briefLike = { lesson: { status: lessonPresent ? "present" : "missing" } };
  const [status, failCheck] = String(kind).split(":");
  const checks = {};
  for (const id of QB.CHECK_IDS) {
    const allowed = QB.allowedResults(id, it, briefLike);
    let result = allowed.includes("pass") ? "pass" : allowed[0];
    if (status === "revise" && id === (failCheck || "answer_unique")) result = "fail";
    if (status === "human" && id === "answer_unique") result = "not_verified";   // 诚实的「确认不了」
    checks[id] = { result, evidence: "scripted " + id };
  }
  const options = [0, 1, 2, 3].map(i => ({ correct: i === it.answerIndex, reason: "scripted solve" }));
  if (status === "malformed") return { id: it.id, status: "pass", options, checks: {}, findings: [] };
  if (status === "revise") {
    const c = failCheck || "answer_unique";
    return { id: it.id, status: "revise", options, checks, findings: [{ category: c, field: "", evidence: "scripted evidence", reason: "scripted problem", suggestedFix: "scripted fix" }] };
  }
  if (status === "human") return { id: it.id, status: "needs-human", options, checks, findings: [{ category: "skill_level", field: "", evidence: "scripted", reason: "scripted: cannot confirm", suggestedFix: "" }] };
  return { id: it.id, status: "pass", options, checks, findings: [] };
}
function genFor(sys) {
  const st = readState();
  for (const [itemId, batches] of Object.entries(script.gen || {})) {
    const f = S.findCurriculumItem(itemId);
    if (!f || !(sys.includes(f.item.en) || (f.item.zh && sys.includes(f.item.zh)))) continue;
    const n = st.gen[itemId] || 0;
    if (n >= batches.length) throw new Error("stub generator: no batch left for " + itemId);
    st.gen[itemId] = n + 1; writeState(st);
    return { itemId, n, out: clone(batches[n]) };
  }
  /* 老路径回归用：不认条目、按语言给同一批（不消耗） */
  const lang = /[一-鿿]/.test(sys.slice(0, 200)) ? "zh" : "en";
  if (script.genAny && script.genAny[lang]) return { itemId: "*", n: 0, out: clone(script.genAny[lang]) };
  throw new Error("stub generator: no batch scripted for this prompt");
}
async function answer(engine, sys, question, lang, opts) {
  const bid = /Teaching brief (tb1-[0-9a-f]+)/.exec(sys);
  const call = { engine, lang, sawUsedAt: /usedAt/.test(sys), briefId: bid ? bid[1] : null };
  if (question === "Review these questions.") {
    const items = itemsOf(sys);
    call.kind = "judge"; call.ids = items.map(i => i.id); call.qids = items.map(i => i.qid); call.stems = items.map(i => String(i.question).slice(0, 60));
    call.items = items;   // 审稿人实际看到的题目对象（测试拿它和发布 / 导出的对象逐字段比）
    logCall(call);
    const rules = items.map(it => firstRule(script.judge, it));
    if (rules.some(r => r && r.verdict === "hang")) return new Promise(() => {});
    if (rules.some(r => r && r.verdict === "throw")) throw new Error("scripted judge failure");
    if (rules.some(r => r && r.verdict === "garbage")) return { nope: true };
    const lessonPresent = !/The lesson is (missing|unreadable)/.test(sys);
    return { items: items.map((it, i) => verdictFor(it, lessonPresent, rules[i])) };
  }
  if (question === "Rewrite this one question.") {
    const cur = JSON.parse(sys.slice(sys.lastIndexOf("\n{") + 1));
    call.kind = "repair"; call.stem = String(cur.question).slice(0, 60);
    logCall(call);
    const r = (script.repair || []).find(x => String(cur.question).includes(x.match));
    if (!r) throw new Error("stub repair: nothing scripted for " + call.stem);
    return Object.assign(clone(cur), clone(r.set || {}));
  }
  if (question === "Please write this batch of questions." || question === "请出这批题。") {
    const g = genFor(sys);
    call.kind = "gen"; call.itemId = g.itemId; call.n = g.n;
    const ask = /Write \d+ original multiple-choice questions: [^.]*\./.exec(sys);
    call.ask = ask ? ask[0] : null;
    logCall(call);
    return g.out;
  }
  if (question === "Review this content." || question === "请审这份内容。") {
    call.kind = "judge-v1";
    logCall(call);
    return clone(script.judgeV1 || { pass: true, problems: [], bad: [] });
  }
  logCall(Object.assign(call, { kind: "unexpected", question }));
  throw new Error("stub engine: unexpected request " + JSON.stringify(question));
}
for (const [id, e] of Object.entries(script.engines || {})) {
  S.ADAPTERS[id] = (sys, question, img, mt, lang, opts) => answer(id, sys, question, lang, opts);
  if (e.available !== false) S.detected[id] = Object.assign({ available: true }, e.model ? { model: e.model } : {});
  else S.detected[id] = { available: false };
}
