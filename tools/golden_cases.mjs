#!/usr/bin/env node
/*
 * 辅导黄金用例（issue #20，#19 Phase 0）。
 *
 *   node tools/golden_cases.mjs            # 跑并和 tools/golden/expected.json 比对
 *   node tools/golden_cases.mjs --update   # 重新录制快照（改了掌握度规则时人工确认后再更新）
 *   node tools/golden_cases.mjs --only quiz-pass-minimal
 *   node tools/golden_cases.mjs --expected /tmp/x.json   # 换一份快照文件（tools/test_golden_gate.mjs 用它，不碰仓库快照）
 *
 * 判定口径（Codex 复审 20260925-9c0a8d8）：
 *   - 只有「题库里没这一节且没引擎」（/api/quiz/session 503 needsEngine）算缺 fixture，记 skip；
 *   - 任何接口状态码不等于预期（成功路径 200；只有用例专门验证的拒绝路径显式声明 4xx）、判题和用例预期不符、
 *     用例抛错，都算 FAIL，退出码非零；
 *   - --update 只要有一条 FAIL 就整份不写、退出码 1；skip 的用例保留旧快照原样，不删不改。
 *
 * 和 smoke_flows 的分工：smoke 管「流程能不能跑通」，这里管「同样的输入必须得到同样的判定」。
 * 每个用例在同一台隔离服务器上用一个全新的孩子跑，输出被归一化（去掉 id / 时间戳），
 * 存成 JSON 快照。后续把 progressRecord / progressStatus / progressLevel / quizSession /
 * 单元卷判分抽成 Action 时，这份快照就是「行为没变」的证据。
 *
 * 全程零成本：走随包课程、随包卷子、题库；见 tools/lib/isolated_server.mjs。
 *
 * 已知缺口：YY_DEMO=1 会连技能图谱一起跳过，所以「误区命中两次触发回补建议」这条最重要的
 * 辅导规则在这里录不了（见 docs/ai-native-refactor-audit.md）。
 */
import fs from "node:fs";
import path from "node:path";
import { launch, ROOT } from "./lib/isolated_server.mjs";

const args = process.argv.slice(2);
const argVal = flag => {
  if (!args.includes(flag)) return null;
  const v = args[args.indexOf(flag) + 1];
  if (!v || v.startsWith("--")) { console.error(flag + " needs a value"); process.exit(2); }
  return v;
};
const EXPECTED = path.resolve(argVal("--expected") || path.join(ROOT, "tools", "golden", "expected.json"));
const UPDATE = args.includes("--update");
const ONLY = argVal("--only");

/* 用例里抛这两个：CaseSkip 只给「明确缺 fixture」，其余一律 CaseFail（或任何别的异常，同样算失败） */
class CaseFail extends Error {}
class CaseSkip extends Error {}

let srv = null;
const G4 = { grade: "Grade 4", gradeCode: "4", lang: "en" };
let kidSeq = 0, parentTok = "";

/* 用例里的接口调用都走这里：状态码必须等于 expect（成功路径一律 200），否则本用例 FAIL、--update 整份不写。
 * 只有用例专门验证的拒绝路径才显式传 expect=4xx（manual-solid 的孩子越权 403、内部事件 400）。
 * 唯一放行的是 POST /api/quiz/session 的 503 needsEngine（缺题库），交给 quiz() 记 skip。别的接口回错不是缺 fixture：
 * mastery-table 以前不看讲课 / 记练习的返回码，接口拒了（503 / 400 / 403）照样录出 taught=0 的坏快照（Codex 第二轮复审） */
const missingBank = (method, p, r) =>
  method === "POST" && p.split("?")[0] === "/api/quiz/session" && r.status === 503 && !!r.body && r.body.needsEngine === true;
async function call(method, p, body, tok, expect = 200) {
  const r = await srv.call(method, p, body, tok);
  if (r.status !== expect && !missingBank(method, p, r))
    throw new CaseFail(`${method} ${p.split("?")[0]} -> ${r.status} (expected ${expect}) ${JSON.stringify(r.body).slice(0, 160)}`);
  return r;
}

/* 每个用例一个新孩子，返回 { token, kidId } */
async function freshKid() {
  const name = "K" + (++kidSeq), pin = String(1000 + kidSeq);
  await call("POST", "/api/kids", { name, pin }, parentTok);
  const list = (await call("GET", "/api/auth/profiles", undefined, "")).body.kids;
  const kidId = list.find(x => x.name === name).id;
  const token = (await call("POST", "/api/auth/login", { kidId, pin }, "")).body.token;
  return { token, kidId, name };
}
const item = async (tok, grade, idx = 0) => (await call("GET", `/api/curriculum?grade=${grade}`, undefined, tok)).body.strands[0].items[idx];
const teach = (tok, cid, lang = "en") => call("POST", "/api/lesson", { mode: "teach", curriculumId: cid, ...G4, lang }, tok);
const progressOf = async (tok, cid) => {
  const p = (await call("GET", "/api/progress?grade=4", undefined, tok)).body.items[cid] || {};
  return { status: p.status || "new", taught: p.taught || 0, right: p.right || 0, wrong: p.wrong || 0, solid: !!p.solid, quizPassed: !!p.quizPassedAt, missKeys: Object.keys(p.miss || {}) };
};
const reportItem = async (kidId, cid) => {
  const rep = (await call("GET", "/api/report?grade=4&kid=" + kidId, undefined, parentTok)).body;
  const it = (rep.strands || []).flatMap(s => s.items).find(i => i.id === cid) || {};
  return { level: it.level, status: it.status, manualSolid: !!it.manualSolid, totals: rep.totals };
};
const curriculumStatus = async (tok, cid) => {
  const cur = (await call("GET", "/api/curriculum?grade=4", undefined, tok)).body;
  return (cur.strands.flatMap(s => s.items).find(i => i.id === cid) || {}).status;
};
async function quiz(tok, cid, plan) {
  /* plan: [[level, right?, n], ...] 展开成一串「答对 / 答错」；难度由服务端决定，plan 里的 level 只是
   * 写用例时的预期，实际走过的难度记在 path 里（#23 起答案不下发，答对靠先答一次拿 answerIndex 是不行的，
   * 所以「答错」= 先问服务端要不到答案就随便选，再按返回的 answerIndex 校准：见下面 pickFor） */
  const s = await call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" }, tok);
  /* 缺 fixture（503 needsEngine）才 skip；其它非 200 / 没题都算接口坏了（Codex 复审 20260925-82d9cc0） */
  if (s.status === 503 && s.body.needsEngine === true) throw new CaseSkip("no quiz bank for " + cid + " (503 needsEngine)");
  if (s.status !== 200 || !s.body.question) throw new CaseFail("quiz/session " + s.status + " " + JSON.stringify(s.body).slice(0, 160));
  const seq = plan.flatMap(([, right, n]) => Array(n).fill(!!right));
  const path = [];
  let cur = s.body.question, level = s.body.level, answered = 0;
  for (const right of seq) {
    if (!cur) break;
    path.push(level);
    /* 题库是随包数据（launch 拷进 DATA 的就是服务器用的那份），测试进程直接读它拿答案；产品客户端拿不到。
     * 找不到这道题 = 服务器发了一道不在自己题库里的题，是错不是缺 fixture */
    const bankQ = bankQuestion(cid, "en", cur.qid);
    if (!bankQ) throw new CaseFail("server sent qid not in its own bank: " + cur.qid);
    const picked = right ? bankQ.answerIndex : (bankQ.answerIndex + 1) % 4;
    const a = await call("POST", "/api/quiz/answer", { session: s.body.session, qid: cur.qid, picked }, tok);
    /* 逐题接口坏了、或判题和题库答案对不上，都是回归，不能跳过（Codex 复审 20260925-9c0a8d8） */
    if (a.status !== 200) throw new CaseFail(`quiz/answer #${answered + 1} -> ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
    if (a.body.correct !== right) throw new CaseFail(`quiz/answer #${answered + 1} judged correct=${a.body.correct}, picked ${picked} expected correct=${right} (qid ${cur.qid})`);
    answered++;
    cur = a.body.next; level = a.body.level;
    if (a.body.finished) break;
  }
  const f = await call("POST", "/api/quiz/finish", { curriculumId: cid, lang: "en", session: s.body.session }, tok);
  if (f.status !== 200) throw new CaseFail("quiz/finish " + f.status + " " + JSON.stringify(f.body).slice(0, 160));
  /* finish 的键和 #23 前的快照保持同名同序（status 是进度状态，不是 HTTP 码）；right/total 是新加的响应字段，不进快照 */
  const finish = { status: f.body.status, ok: f.body.ok, passed: f.body.passed, level: f.body.level };
  if (f.body.remediate) finish.remediate = f.body.remediate;
  return { rules: s.body.rules, finish, answered, path };
}
let bankCache = null;
function bankQuestion(cid, lang, qid) {
  if (!bankCache) bankCache = JSON.parse(fs.readFileSync(path.join(srv.DATA, "qbank.json"), "utf8"));
  const b = bankCache[cid + "|" + lang];
  return b && b.questions.find(q => q.qid === qid) || null;
}

const CASES = {
  /* 1. 只讲一次课：new -> seen，taught=1，报告级别 */
  async "teach-once"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    const before = await progressOf(k.token, it.id);
    const r = await teach(k.token, it.id);
    return { item: it.id, before, lesson: { packed: r.body.packed, provider: r.body.provider, title: r.body.lesson.title, steps: r.body.lesson.steps.length, hasPractice: !!(r.body.lesson.practice && r.body.lesson.practice.question) },
      after: await progressOf(k.token, it.id), curriculum: await curriculumStatus(k.token, it.id), report: await reportItem(k.kidId, it.id) };
  },
  /* 2. 中文课程包也在，且是另一份内容 */
  async "teach-zh"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    const en = await teach(k.token, it.id, "en"), zh = await teach(k.token, it.id, "zh");
    return { item: it.id, en: { packed: en.body.packed, title: en.body.lesson.title }, zh: { packed: zh.body.packed, title: zh.body.lesson.title, differs: zh.body.lesson.title !== en.body.lesson.title },
      after: await progressOf(k.token, it.id), history: (await call("GET", "/api/history", undefined, k.token)).body.items.map(h => h.lang) };
  },
  /* 3. 闯关最短通关路径：L1 对 1，L2 对 1，L3 对 passNeed */
  async "quiz-pass-minimal"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    await teach(k.token, it.id);
    const q = await quiz(k.token, it.id, [[1, true, 1], [2, true, 1], [3, true, 2]]);
    return { item: it.id, quiz: q, after: await progressOf(k.token, it.id), curriculum: await curriculumStatus(k.token, it.id), report: await reportItem(k.kidId, it.id) };
  },
  /* 4. 没讲课直接闯关也能通关（闯关不依赖 taught） */
  async "quiz-pass-without-teach"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    const q = await quiz(k.token, it.id, [[1, true, 1], [2, true, 1], [3, true, 2]]);
    return { item: it.id, quiz: q, after: await progressOf(k.token, it.id), curriculum: await curriculumStatus(k.token, it.id), report: await reportItem(k.kidId, it.id) };
  },
  /* 5. 全错：不通关，wrong 累加，级别 */
  async "quiz-fail-all-wrong"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    await teach(k.token, it.id);
    const q = await quiz(k.token, it.id, [[1, false, 3]]);
    return { item: it.id, quiz: q, after: await progressOf(k.token, it.id), curriculum: await curriculumStatus(k.token, it.id), report: await reportItem(k.kidId, it.id) };
  },
  /* 6. 到了 L3 但只对 1 题（< passNeed）：不通关 */
  async "quiz-top-level-short"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    await teach(k.token, it.id);
    const q = await quiz(k.token, it.id, [[1, true, 1], [2, true, 1], [3, true, 1], [3, false, 2]]);
    return { item: it.id, quiz: q, after: await progressOf(k.token, it.id), curriculum: await curriculumStatus(k.token, it.id), report: await reportItem(k.kidId, it.id) };
  },
  /* 7. 通关后再闯一次全错：solid 会不会掉 */
  async "quiz-pass-then-fail"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    const first = await quiz(k.token, it.id, [[1, true, 1], [2, true, 1], [3, true, 2]]);
    const second = await quiz(k.token, it.id, [[1, false, 3]]);
    return { item: it.id, first: first.finish, second: second.finish, after: await progressOf(k.token, it.id), curriculum: await curriculumStatus(k.token, it.id), report: await reportItem(k.kidId, it.id) };
  },
  /* 8. 随包单元卷：一半对：每个标准的进度增量 + 报告级别 */
  async "unit-test-half-right"() {
    const k = await freshKid();
    const ut = await call("POST", "/api/unit-test", { grade: 4, strand: "number", count: 8, lang: "en" }, k.token);
    const set = ut.body.set;
    const answers = set.questions.map((q, i) => i % 2 ? q.answerIndex : (q.answerIndex + 1) % 4);
    const att = await call("POST", "/api/unit-test/attempt", { id: set.id, answers, ms: 5000 }, k.token);
    const prog = (await call("GET", "/api/progress?grade=4", undefined, k.token)).body.items;
    const rep = (await call("GET", "/api/report?grade=4&kid=" + k.kidId, undefined, parentTok)).body;
    const touched = [...new Set(set.questions.map(q => q.curriculumId))].sort();
    return { paper: { packed: ut.body.packed, title: set.title, n: set.questions.length, standards: touched, levels: set.questions.map(q => q.level) },
      attempt: { status: att.status, right: att.body.right, total: att.body.total, answered: att.body.answered },
      perStandard: Object.fromEntries(touched.map(id => [id, { right: prog[id]?.right || 0, wrong: prog[id]?.wrong || 0, status: prog[id]?.status || "new",
        level: (rep.strands.flatMap(s => s.items).find(i => i.id === id) || {}).level }])),
      totals: rep.totals };
  },
  /* 9. 随包单元卷全对 */
  async "unit-test-all-right"() {
    const k = await freshKid();
    const ut = await call("POST", "/api/unit-test", { grade: 4, strand: "number", count: 8, lang: "en" }, k.token);
    const set = ut.body.set;
    const att = await call("POST", "/api/unit-test/attempt", { id: set.id, answers: set.questions.map(q => q.answerIndex), ms: 5000 }, k.token);
    const prog = (await call("GET", "/api/progress?grade=4", undefined, k.token)).body.items;
    const rep = (await call("GET", "/api/report?grade=4&kid=" + k.kidId, undefined, parentTok)).body;
    const touched = [...new Set(set.questions.map(q => q.curriculumId))].sort();
    return { attempt: { right: att.body.right, total: att.body.total },
      perStandard: Object.fromEntries(touched.map(id => [id, { right: prog[id]?.right || 0, wrong: prog[id]?.wrong || 0, status: prog[id]?.status || "new",
        level: (rep.strands.flatMap(s => s.items).find(i => i.id === id) || {}).level }])),
      totals: rep.totals };
  },
  /* 10. 掌握度函数的输入输出表：不同的练习对错序列 -> status / level */
  async "mastery-table"() {
    const k = await freshKid();
    const items = (await call("GET", "/api/curriculum?grade=4", undefined, k.token)).body.strands.flatMap(s => s.items).map(i => i.id);
    const seqs = { "taught-only": "T", "R": "R", "RR": "RR", "RRR": "RRR", "W": "W", "WW": "WW", "RW": "RW", "RWRW": "RWRW", "RRRRR": "RRRRR", "WWRRR": "WWRRR", "T+RRR": "TRRR" };
    const out = {};
    let i = 0;
    for (const [name, seq] of Object.entries(seqs)) {
      const cid = items[i++];
      for (const ch of seq) {
        if (ch === "T") await teach(k.token, cid);
        else await call("POST", "/api/progress", { curriculumId: cid, event: ch === "R" ? "practiced-right" : "practiced-wrong" }, k.token);
      }
      const p = await progressOf(k.token, cid), r = await reportItem(k.kidId, cid);
      out[name] = { status: p.status, level: r.level, right: p.right, wrong: p.wrong, taught: p.taught };
    }
    return out;
  },
  /* 11. 家长手动标「扎实」/ 取消：状态、级别、manualSolid；孩子不能标（403）、内部事件不接受（400）——这两条是有意的拒绝路径 */
  async "manual-solid"() {
    const k = await freshKid(); const it = await item(k.token, 4);
    const byKid = await call("POST", "/api/progress", { curriculumId: it.id, event: "mark-solid" }, k.token, 403);
    const mark = await call("POST", "/api/progress", { curriculumId: it.id, event: "mark-solid", kid: k.kidId }, parentTok);
    const afterMark = { p: await progressOf(k.token, it.id), r: await reportItem(k.kidId, it.id), c: await curriculumStatus(k.token, it.id) };
    const unmark = await call("POST", "/api/progress", { curriculumId: it.id, event: "unmark-solid", kid: k.kidId }, parentTok);
    const afterUnmark = { p: await progressOf(k.token, it.id), r: await reportItem(k.kidId, it.id), c: await curriculumStatus(k.token, it.id) };
    const internal = await call("POST", "/api/progress", { curriculumId: it.id, event: "quiz-pass", kid: k.kidId }, parentTok, 400);
    return { kidMark: byKid.status, mark: mark.status, afterMark, unmark: unmark.status, afterUnmark, internalEventRejected: internal.status };
  },
  /* 12. 报告的汇总口径：孩子什么都没做时的 totals，以及 grade 列表 */
  async "report-empty"() {
    const k = await freshKid();
    const rep = (await call("GET", "/api/report?grade=4&kid=" + k.kidId, undefined, parentTok)).body;
    return { totals: rep.totals, grades: rep.grades, strands: rep.strands.map(s => ({ strand: s.strand, total: s.total, seen: s.seen, solid: s.solid, levels: [...new Set(s.items.map(i => i.level))] })) };
  }
};

/* 拼错的 --only 以前会一条不跑、0 passed 绿着退出；只认自有属性，toString / constructor 这类继承名同样是未知用例 */
if (ONLY && !Object.prototype.hasOwnProperty.call(CASES, ONLY)) { console.error(`unknown case "${ONLY}"; known: ${Object.keys(CASES).join(", ")}`); process.exit(2); }

srv = await launch({ prefix: "yy-golden-" });
let exitCode = 1;
try {
  const reg = await srv.call("POST", "/api/auth/register", { username: "golden", password: "golden123", name: "Golden", registrationCode: "iso" }, "");
  if (reg.status !== 200) throw new Error("register failed " + JSON.stringify(reg));
  parentTok = reg.body.token;
  const expected = fs.existsSync(EXPECTED) ? JSON.parse(fs.readFileSync(EXPECTED, "utf8")) : {};
  const actual = {};
  const failed = [], skippedNames = [];
  let pass = 0;
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY && name !== ONLY) continue;
    let out;
    try { out = await fn(); }
    catch (e) {
      if (e instanceof CaseSkip) { skippedNames.push(name); console.log("  skip  " + name + "  " + e.message); }
      else { failed.push(name); console.log("  FAIL  " + name + "  " + (e instanceof CaseFail ? e.message : e && e.stack || e)); }
      continue;
    }
    actual[name] = out;
    const s = JSON.stringify(out);
    if (UPDATE) { console.log("  rec   " + name); continue; }
    if (!(name in expected)) { failed.push(name); console.log("  NEW   " + name + " (no snapshot; run with --update)"); continue; }
    if (JSON.stringify(expected[name]) === s) { pass++; console.log("  ok    " + name); }
    else { failed.push(name); console.log("  DIFF  " + name + "\n    expected: " + JSON.stringify(expected[name]).slice(0, 600) + "\n    actual:   " + s.slice(0, 600)); }
  }
  const skipped = skippedNames.length, fail = failed.length;
  if (UPDATE && fail) {
    /* 有一条失败就整份不写：失败的用例没有可信的「实际结果」，别的用例录进去也会让人误以为这次录制是好的 */
    console.log(`\nrefusing to update: ${fail} failed (${failed.join(", ")}); ${path.relative(ROOT, EXPECTED) || EXPECTED} left untouched`);
    exitCode = 1;
  } else if (UPDATE) {
    /* skip 的用例（缺 fixture）不在 actual 里，旧快照原样保留 */
    const merged = { ...expected, ...actual };
    fs.mkdirSync(path.dirname(EXPECTED), { recursive: true });
    const tmp = EXPECTED + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    fs.renameSync(tmp, EXPECTED);
    console.log(`\nrecorded ${Object.keys(actual).length} case(s), ${Object.keys(merged).length} in snapshot -> ${path.relative(ROOT, EXPECTED) || EXPECTED}`);
    if (skipped) console.log(`${skipped} skipped for missing fixture, old snapshot kept: ${skippedNames.join(", ")}`);
    exitCode = 0;
  } else {
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
    exitCode = fail === 0 ? 0 : 1;
  }
} catch (e) {
  console.error("\ngolden aborted:", e && e.stack || e);
  console.error(srv.log.slice(-1200));
} finally {
  await srv.stop();
  srv.cleanup();
}
process.exit(exitCode);
