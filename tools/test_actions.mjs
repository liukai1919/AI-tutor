#!/usr/bin/env node
/*
 * lib/actions/ 的单元测试（#24）：不起 HTTP，用桩 deps 直接调 Action，钉住校验顺序、错误码和输出形状。
 *
 *   node tools/test_actions.mjs
 *
 * 端到端的行为（真题库、真进度）在 smoke_flows / golden_cases 里；这里只管「Action 自己那层」的规矩。
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const { create, ActionError } = require("../lib/actions/index.js");
const M = require("../lib/domain/mastery.js");
const Q = require("../lib/domain/quiz.js");
const { check, summary } = makeChecker();

const fails = (fn, status, key) => { try { fn(); return false; } catch (e) { return e instanceof ActionError && e.status === status && (!key || e.body[key] === true || key in e.body); } };
const failsAsync = async (fn, status, key) => { try { await fn(); return false; } catch (e) { return e instanceof ActionError && e.status === status && (!key || key in e.body); } };

/* ---- 桩：一个孩子、两个知识点、一份题库 ---- */
const progress = { "BC.MATH.G4.NUM.01": { taught: 1, right: 0, wrong: 0, lastAt: 0, solid: false, rightDays: [], lessonIds: ["L1"] }, "YY.MATH.X": { taught: 2 } };
const buckets = { k1: { progress } };
const items = { "BC.MATH.G4.NUM.01": { id: "BC.MATH.G4.NUM.01", en: "n", zh: "数", strand: "number" }, "BC.MATH.G4.NUM.02": { id: "BC.MATH.G4.NUM.02", en: "d", zh: "小", strand: "number" } };
const gradeData = { source: { url: "x" }, items: Object.values(items) };
const saved = [], logs = [], ledger = [];
const mk = (lv, i) => ({ qid: `q${lv}${i}`, level: lv, question: "?", options: ["a", "b", "c", "d"], answerIndex: i % 4, explain: "why" });
const qbank = { "BC.MATH.G4.NUM.01|en": { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3].map(i => mk(lv, i))) } };
const quizOpen = new Map();
let sidSeq = 0;
const deps = {
  kd: id => buckets[id] || (buckets[id] = { progress: {} }),
  kidSave: (id, key) => saved.push(id + "/" + key),
  kidTxn: fn => fn(),
  progressRecord: (id, cid, ev, lessonId) => M.applyEvent(deps.kd(id).progress, cid, ev, { now: 1000, lessonId }),
  progressStatus: (id, cid) => M.statusOf(M.levelOf(deps.kd(id).progress[cid])),
  progressLevel: (id, cid) => M.levelOf(deps.kd(id).progress[cid]),
  remediationFor: () => null, missRecord: () => {},
  findCurriculumItem: id => items[id] ? { item: items[id], data: gradeData } : null,
  INTERNAL_EVENTS: M.INTERNAL_EVENTS, PARENT_ONLY_EVENTS: M.PARENT_ONLY_EVENTS,
  curriculum: new Map([[4, gradeData]]), curriculumGrades: () => [4], curriculumCourses: () => [], curriculumBooks: () => [], curriculumSkillsPreviews: () => [],
  curriculumKey: raw => /^\d+$/.test(String(raw)) ? Number(raw) : String(raw || ""), learnView: k => deps.curriculum.get(k), viewKey: k => k,
  strandGroups: (d, map) => [{ strand: "number", items: d.items.map(map) }], STRANDS: [["number", "数", "Number"]],
  Q, L: (lang, zh, en) => lang === "en" ? en : zh, normLang: l => l === "zh" ? "zh" : "en",
  pickProvider: () => null, qbankPlayable: (id, lang) => qbank[id + "|" + lang] || null, ensureQuizBank: async () => { throw new Error("no engine in test"); },
  ledgerAdd: e => ledger.push(e), shuffleArr: a => a,
  quizOpen, quizOpenCreate: (userId, cid, lang, byLevel) => { const sid = "s" + (++sidSeq); quizOpen.set(sid, { userId, cid, lang, state: Q.newState(byLevel), at: 1 }); return sid; },
  quizOpenGet: (sid, userId, cid) => { const o = quizOpen.get(sid); return o && o.userId === userId && (cid == null || o.cid === cid) ? o : null; },
  quizOpenTake: (sid, userId, cid) => { const o = deps.quizOpenGet(sid, userId, cid); if (o) quizOpen.delete(sid); return o; },
  quizNextPublic: (open, bank) => { const qid = Q.nextQuestion(open.state); const q = qid && bank.questions.find(x => x.qid === qid); return q ? Q.publicQuestion(q) : null; },
  qbank, qbankKey: (id, lang) => id + "|" + lang, qbankSave: () => saved.push("qbank"),
  log: m => logs.push(m),
};
const A = create(deps);
const kid = { kidId: "k1", role: "student", userId: "k1" };
const parent = { kidId: "k1", role: "parent", userId: "p1" };
const parentNoKid = { kidId: null, role: "parent", userId: "p1" };

console.log("progress.get");
let r = A.progress.get(kid, { grade: "4" });
check("grade filter keeps only BC.MATH.G4.*, adds status", Object.keys(r.items).join() === "BC.MATH.G4.NUM.01" && r.items["BC.MATH.G4.NUM.01"].status === "seen", r);
check("no grade -> everything", Object.keys(A.progress.get(kid, {}).items).length === 2);
check("no kid -> 400 kidRequired", fails(() => A.progress.get(parentNoKid, {}), 400, "kidRequired"));

console.log("progress.record");
check("internal event -> 400 (same wording as unknown, before kid check)", fails(() => A.progress.record(parentNoKid, { event: "quiz-pass", curriculumId: "BC.MATH.G4.NUM.01" }), 400) && !fails(() => A.progress.record(parentNoKid, { event: "quiz-pass" }), 400, "kidRequired"));
check("mark-solid by student -> 403 parentRequired", fails(() => A.progress.record(kid, { event: "mark-solid", curriculumId: "BC.MATH.G4.NUM.01" }), 403, "parentRequired"));
check("parent without kid -> 400 kidRequired", fails(() => A.progress.record(parentNoKid, { event: "practiced-right", curriculumId: "BC.MATH.G4.NUM.01" }), 400, "kidRequired"));
check("unknown item -> 400", fails(() => A.progress.record(kid, { event: "practiced-right", curriculumId: "nope" }), 400));
check("unknown event -> 400", fails(() => A.progress.record(kid, { event: "whatever", curriculumId: "BC.MATH.G4.NUM.01" }), 400));
r = A.progress.record(kid, { event: "practiced-right", curriculumId: "BC.MATH.G4.NUM.02" });
check("practiced-right -> {ok, status, entry}, entry right=1", r.ok === true && r.status === "seen" && r.entry.right === 1, r);
r = A.progress.record(parent, { event: "mark-solid", curriculumId: "BC.MATH.G4.NUM.02" });
check("parent mark-solid -> solid", r.status === "solid" && r.entry.solid === true);

console.log("progress.clear");
r = A.progress.clear(parent);
check("clear -> {ok}, progress emptied, saved, logged", r.ok === true && Object.keys(deps.kd("k1").progress).length === 0 && saved.includes("k1/progress") && logs.some(l => /cleared \(kid=k1\)/.test(l)));

console.log("curriculum.view");
r = A.curriculum.view(parentNoKid, {});
check("no grade -> catalog, no kid needed", r.grades.join() === "4" && "courses" in r && "books" in r && "skillsPreviews" in r, r);
check("unknown grade -> 404 with grades", fails(() => A.curriculum.view(kid, { grade: "9" }), 404, "grades"));
check("grade but no kid -> 400 kidRequired", fails(() => A.curriculum.view(parentNoKid, { grade: "4" }), 400, "kidRequired"));
deps.kd("k1").progress["BC.MATH.G4.NUM.01"] = Object.assign(M.newEntry(), { taught: 1, lessonIds: ["L9", "L8"] });
r = A.curriculum.view(kid, { grade: "4" });
check("grade -> strands with status + latest lessonId + unitKey", r.grade === 4 && r.strands[0].items[0].status === "seen" && r.strands[0].items[0].lessonId === "L9" && r.strands[0].items[1].lessonId === "" && r.unitKey === "4", r);

console.log("quiz.start / answer / finish");
check("unknown item -> 400", await failsAsync(() => A.quiz.start(kid, { curriculumId: "nope", lang: "en" }), 400));
check("no bank + no engine -> 503 needsEngine", await failsAsync(() => A.quiz.start(kid, { curriculumId: "BC.MATH.G4.NUM.02", lang: "en" }), 503, "needsEngine"));
r = await A.quiz.start(kid, { curriculumId: "BC.MATH.G4.NUM.01", lang: "en" });
check("start -> session/rules/level 1/n 1/first question without answer", typeof r.session === "string" && r.rules.passNeed === 2 && r.level === 1 && r.n === 1 && r.question.qid === "q10" && !("answerIndex" in r.question), r);
check("bank hit recorded in the ledger as provider=bank", ledger.length === 1 && ledger[0].provider === "bank");
const sid = r.session;
const ticket = () => quizOpen.get(sid).state;
check("answer: someone else's ticket -> 400 staleSession", fails(() => A.quiz.answer({ ...kid, userId: "other" }, { session: sid, qid: "q10", picked: 0 }), 400, "staleSession"));
check("answer: bad index -> 400", fails(() => A.quiz.answer(kid, { session: sid, qid: "q10", picked: 7 }), 400));
/* #23 复审：答题必须带 qid（当前题），缺了不许退回「答当前那题」的旧行为 */
check("answer: no qid -> 400 needQid, nothing consumed", fails(() => A.quiz.answer(kid, { session: sid, picked: 0 }), 400, "needQid") && ticket().results.length === 0 && ticket().cur === "q10");
check("answer: qid that isn't the current question -> 409 staleQuestion, nothing consumed", fails(() => A.quiz.answer(kid, { session: sid, qid: "q20", picked: 0 }), 409, "staleQuestion") && ticket().results.length === 0 && ticket().cur === "q10");
r = A.quiz.answer(kid, { session: sid, qid: "q10", picked: 0 });
check("answer q10 right -> correct, answerIndex/explain revealed, level 2, next is L2", r.correct === true && r.answerIndex === 0 && r.explain === "why" && r.level === 2 && r.next.qid === "q20" && r.finished === false && r.picked === 0 && !r.replay, r);
const first = r;
/* 回包丢了、同一请求原样重放：原样回第一次的结果，不当成下一题（q20）作答 */
r = A.quiz.answer(kid, { session: sid, qid: "q10", picked: 0 });
check("replay of q10 -> same reply marked replay, ticket not advanced", r.replay === true && r.correct === true && r.next.qid === "q20" && r.n === first.n && ticket().results.length === 1 && ticket().cur === "q20" && ticket().answered === false, { r, st: ticket() });
r = A.quiz.answer(kid, { session: sid, qid: "q10", picked: 2 });
check("replay of q10 with another pick -> still the first recorded pick, not re-judged", r.replay === true && r.picked === 0 && r.correct === true && ticket().results.length === 1 && ticket().results[0].picked === 0, r);
r = A.quiz.answer(kid, { session: sid, qid: "q20", picked: 3 });
check("answer q20 wrong -> back to level 1", r.correct === false && r.level === 1 && r.next.level === 1 && !r.replay && ticket().results.length === 2);
check("answer: an older question (q10, not the last one) -> 409 staleQuestion", fails(() => A.quiz.answer(kid, { session: sid, qid: "q10", picked: 0 }), 409, "staleQuestion") && ticket().results.length === 2);
check("finish: unknown item -> 400", fails(() => A.quiz.finish(kid, { session: sid, curriculumId: "nope" }), 400));
check("finish: no kid -> 400 kidRequired", fails(() => A.quiz.finish(parentNoKid, { session: sid, curriculumId: "BC.MATH.G4.NUM.01" }), 400, "kidRequired"));
r = A.quiz.finish(kid, { session: sid, curriculumId: "BC.MATH.G4.NUM.01" });
check("finish -> {ok, passed:false, right 1, total 2, status, level}, usedAt stamped, qbank saved", r.ok === true && r.passed === false && r.right === 1 && r.total === 2 && r.status === "seen" && qbank["BC.MATH.G4.NUM.01|en"].questions[0].usedAt === undefined ? false : (qbank["BC.MATH.G4.NUM.01|en"].questions.find(q => q.qid === "q10").usedAt > 0 && saved.includes("qbank")), r);
check("finish again -> 400 staleSession (one-shot)", fails(() => A.quiz.finish(kid, { session: sid, curriculumId: "BC.MATH.G4.NUM.01" }), 400, "staleSession"));
check("answer after settle -> 400 staleSession", fails(() => A.quiz.answer(kid, { session: sid, qid: "q10", picked: 0 }), 400, "staleSession"));

/* 最后一题的回包丢了：重放拿回 finished 的那次结果，而不是 400 finished */
{
  const bank = { questions: [1, 2, 3].flatMap(lv => [0, 1].map(i => mk(lv, i))) };
  const D = create({ ...deps, qbank: { "BC.MATH.G4.NUM.02|en": bank }, qbankPlayable: (id, lang) => id === "BC.MATH.G4.NUM.02" ? bank : null });
  const k8 = { kidId: "k8", role: "student", userId: "k8" };   // 别动 k1 的进度（后面 report 组要用）
  const s = await D.quiz.start(k8, { curriculumId: "BC.MATH.G4.NUM.02", lang: "en" });
  let cur = s.question, last, lastQid;
  while (cur) { lastQid = cur.qid; last = D.quiz.answer(k8, { session: s.session, qid: cur.qid, picked: bank.questions.find(q => q.qid === cur.qid).answerIndex }); cur = last.next; }
  const again = D.quiz.answer(k8, { session: s.session, qid: lastQid, picked: 0 });
  check("replay of the finishing answer -> same finished reply", last.finished === true && again.replay === true && again.finished === true && again.topRight === last.topRight && quizOpen.get(s.session).state.results.length === 4, { last, again });
  const fin = D.quiz.finish(k8, { session: s.session, curriculumId: "BC.MATH.G4.NUM.02" });
  check("…and settles exactly the 4 answers once", fin.total === 4 && fin.right === 4 && fin.passed === true, fin);
}

/* #24 复审：DELETE /api/qbank 之后题库对象可能被整个换掉（或原地清空）。Action 不能攥着开局时那个对象：
 * 清库后旧票的题不在新库里 → answer 400 staleSession、finish 什么都不记；新生成的题开局后能正常答、能结算。 */
{
  /* 契约：题库容器对象全程不换（server.js 的 const qbank + qbankClear 原地清空），create() 会浅拷 deps，
   * 所以「整个换对象」不是支持的用法；server 那一侧由 test_quiz_flow D 组用真实 server.js 钉住 */
  const live = { qbank: { "BC.MATH.G4.NUM.01|en": { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3].map(i => mk(lv, i))) } } };
  const D = create({ ...deps, qbank: live.qbank, qbankPlayable: (id, lang) => live.qbank[id + "|" + lang] || null });
  const bucketBefore = JSON.stringify(deps.kd("k9").progress);
  const k9 = { kidId: "k9", role: "student", userId: "k9" };
  const old = await D.quiz.start(k9, { curriculumId: "BC.MATH.G4.NUM.01", lang: "en" });
  for (const k of Object.keys(live.qbank)) delete live.qbank[k];   // 家长清库：同一个容器原地清空
  check("after clear: old ticket answer -> 400 staleSession", fails(() => D.quiz.answer(k9, { session: old.session, qid: old.question.qid, picked: 0 }), 400, "staleSession"));
  // 确定性桩代替引擎：往当前题库里「生成」一批新 qid
  live.qbank["BC.MATH.G4.NUM.01|en"] = { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3].map(i => ({ ...mk(lv, i), qid: "NEW" + lv + i }))) };
  const fresh = await D.quiz.start(k9, { curriculumId: "BC.MATH.G4.NUM.01", lang: "en" });
  let a;
  try { a = D.quiz.answer(k9, { session: fresh.session, qid: fresh.question.qid, picked: 0 }); } catch (e) { a = { status: e.status, ...e.body }; }
  check("after clear + regenerate: new question answerable", fresh.question.qid === "NEW10" && a.correct === true && a.next && a.next.qid === "NEW20", a);
  const f1 = D.quiz.finish(k9, { session: old.session, curriculumId: "BC.MATH.G4.NUM.01" });
  check("old ticket settles nothing from the old bank", f1.total === 0 && f1.right === 0, f1);
  const f2 = D.quiz.finish(k9, { session: fresh.session, curriculumId: "BC.MATH.G4.NUM.01" });
  check("new ticket settles its answer from the new bank", f2.total === 1 && f2.right === 1 && live.qbank["BC.MATH.G4.NUM.01|en"].questions.find(q => q.qid === "NEW10").usedAt > 0 && deps.kd("k9").progress["BC.MATH.G4.NUM.01"].right === 1, { f2, bucketBefore });
}

/* #24 二次复审：先答一题 → 家长清库 → 同 qid 重放。重放不能拿清库前缓存的回包冒充当前题库（应 400 staleSession），
 * 结算不记旧库成绩；清库前的正常重放仍然只记一次；清库后新题照常能答 */
{
  const live = { "BC.MATH.G4.NUM.01|en": { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3].map(i => mk(lv, i))) } };
  const D = create({ ...deps, qbank: live, qbankPlayable: (id, lang) => live[id + "|" + lang] || null });
  const k7 = { kidId: "k7", role: "student", userId: "k7" };
  const s = await D.quiz.start(k7, { curriculumId: "BC.MATH.G4.NUM.01", lang: "en" });
  const st = () => quizOpen.get(s.session).state;
  const a = D.quiz.answer(k7, { session: s.session, qid: s.question.qid, picked: 0 });
  const rp = D.quiz.answer(k7, { session: s.session, qid: s.question.qid, picked: 0 });
  const rp2 = D.quiz.answer(k7, { session: s.session, qid: s.question.qid, picked: 2 });
  check("before clear: replays (same / other pick) succeed, one answer recorded", a.correct === true && rp.replay === true && rp2.replay === true && rp2.picked === 0 && st().results.length === 1, { rp, rp2 });
  for (const k of Object.keys(live)) delete live[k];   // 家长清库
  const err = fn => { try { fn(); return null; } catch (e) { return e instanceof ActionError ? { status: e.status, ...e.body } : { thrown: String(e) }; } };
  const e1 = err(() => D.quiz.answer(k7, { session: s.session, qid: s.question.qid, picked: 0 }));
  const e2 = err(() => D.quiz.answer(k7, { session: s.session, qid: s.question.qid, picked: 3 }));
  check("after clear: replay (same pick) -> 400 staleSession, no cached old-bank reply", e1 && e1.status === 400 && e1.staleSession === true && !("answerIndex" in e1), e1);
  check("after clear: replay (other pick) -> 400 staleSession", e2 && e2.status === 400 && e2.staleSession === true, e2);
  const e3 = err(() => D.quiz.answer(k7, { session: s.session, qid: a.next.qid, picked: 0 }));
  check("after clear: the ticket's next question -> 400 staleSession too", e3 && e3.status === 400 && e3.staleSession === true, e3);
  const f = D.quiz.finish(k7, { session: s.session, curriculumId: "BC.MATH.G4.NUM.01" });
  check("after clear: finish records nothing from the old bank", f.total === 0 && f.right === 0 && !(deps.kd("k7").progress["BC.MATH.G4.NUM.01"] || {}).right, f);
  live["BC.MATH.G4.NUM.01|en"] = { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3].map(i => ({ ...mk(lv, i), qid: "R" + lv + i }))) };
  const n = await D.quiz.start(k7, { curriculumId: "BC.MATH.G4.NUM.01", lang: "en" });
  const na = D.quiz.answer(k7, { session: n.session, qid: n.question.qid, picked: 0 });
  const nr = D.quiz.answer(k7, { session: n.session, qid: n.question.qid, picked: 0 });
  const nf = D.quiz.finish(k7, { session: n.session, curriculumId: "BC.MATH.G4.NUM.01" });
  check("after clear + regenerate: new question answers, its replay works, settles once", n.question.qid === "R10" && na.correct === true && nr.replay === true && nf.total === 1 && nf.right === 1, { na, nr, nf });
}

/* ---------- 第二片（#25）：history / fsa / unitTest / report / lesson ---------- */
const ids = { n: 0 };
const withId = (kidId, key) => (id, rec) => { rec.id = "r" + (++ids.n); deps.kd(id)[key].unshift(rec); return rec; };
buckets.k1.history = []; buckets.k1.fsaSets = []; buckets.k1.unitTests = []; buckets.k1.reports = [];
const extra = {
  historyAdd: withId("k1", "history"), historySummary: r => ({ id: r.id, mode: r.mode }),
  fsaSetsAdd: withId("k1", "fsaSets"), fsaSetSummary: r => ({ id: r.id, grade: r.grade }),
  unitTestsAdd: withId("k1", "unitTests"), unitTestSummary: r => ({ id: r.id, grade: r.grade, strand: r.strand }),
  reportsAdd: withId("k1", "reports"), reportSummary: r => ({ id: r.id }),
  saveWarn: err => err ? { saveFailed: true, warning: err.message } : {},
  standardEvidence: (kid, id) => ({ level: deps.kd(kid).progress[id] ? "developing" : "emerging", manualSolid: false, taught: 0, right: 0, wrong: 0, lastAt: 0, skills: null }),
  itemTerms: () => [{ en: "place value", zh: "数位" }, { en: "Place Value", zh: "重复" }],
  userById: id => id === "k1" ? { id: "k1", role: "kid", name: "Kiki", familyId: "f" } : null, publicUser: u => ({ id: u.id, role: u.role, name: u.name }),
  buildReportDigest: (kid, g) => g === 4 ? { totals: { total: 2 } } : null, reportPrompt: () => "sys", REPORT_SCHEMA: {}, REPORT_HINT: { en: "", zh: "" }, validateFullReport: x => x,
  fsaPrompt: () => "sys", FSA_SET_SCHEMA: {}, FSA_HINT: { en: "", zh: "" }, validateFsaSet: x => x,
  unitPackGet: (g, strand, lang) => (g === 4 && strand === "number" && lang === "en") ? { title: "", questions: [{ curriculumId: "BC.MATH.G4.NUM.01", level: 1, question: "?", options: ["a", "b", "c", "d"], answerIndex: 1, explain: "e" }, { curriculumId: "", level: 2, question: "?", options: ["a", "b", "c", "d"], answerIndex: 2, explain: "e" }] } : null,
  unitTestPrompt: () => "sys", UNIT_TEST_SCHEMA: {}, UNIT_TEST_HINT: { en: "", zh: "" }, validateUnitTest: x => x,
  lessonPackGet: (id, lang) => id === "BC.MATH.G4.NUM.01" && lang === "en" ? { title: "Packed", isMath: true, steps: [{ say: "hi" }], answer: "", practice: { question: "", answer: "" } } : null,
  ttsAvailable: () => false, ttsStates: () => { throw new Error("should not be called when tts is off"); },
  PROVIDER_META: { fake: { label: "假", labelEn: "Fake", supportsImage: false } },
  systemPromptTeach: () => "sys", systemPrompt: () => "sys", validateLesson: x => x,
  runEngine: async () => { throw new Error("engine down"); },
};
const B = create({ ...deps, ...extra });
const PARENT = { kidId: "k1", role: "parent", userId: "p1" };

console.log("history");
extra.historyAdd("k1", { time: 1, question: "q", mode: "teach" });
r = B.history.list(kid);
check("list -> items via historySummary", r.items.length === 1 && r.items[0].mode === "teach" && !("question" in r.items[0]), r);
check("get unknown -> 404", fails(() => B.history.get(kid, { id: "zzz" }), 404));
check("get -> {record}", B.history.get(kid, { id: r.items[0].id }).record.question === "q");
check("remove -> {ok}, saved, then 404", B.history.remove(PARENT, { id: r.items[0].id }).ok === true && saved.includes("k1/history") && fails(() => B.history.get(kid, { id: r.items[0].id }), 404));
check("clear -> {ok} + log", B.history.clear(PARENT).ok === true && logs.some(l => /\[history\] cleared/.test(l)));

console.log("fsa");
check("generate: unknown grade -> 404", await failsAsync(() => B.fsa.generate(kid, { grade: 9, lang: "en" }), 404));
check("generate: no engine -> 503 without needsEngine (FSA has no pack path)", await (async () => { try { await B.fsa.generate(kid, { grade: 4, lang: "en" }); return false; } catch (e) { return e.status === 503 && !("needsEngine" in e.body); } })());
extra.fsaSetsAdd("k1", { time: 1, grade: 4, strand: "number", lang: "en", questions: [{}, {}, {}], attempts: [] });
extra.fsaSetsAdd("k1", { time: 1, grade: 7, strand: "", lang: "en", questions: [{}], attempts: [] });
check("list filters by grade", B.fsa.list(kid, { grade: "4" }).items.length === 1 && B.fsa.list(kid, {}).items.length === 2);
const fsaId = B.fsa.list(kid, { grade: "4" }).items[0].id;
check("attempt: unknown set -> 404", fails(() => B.fsa.attempt(kid, { id: "zzz", right: 1 }), 404));
r = B.fsa.attempt(kid, { id: fsaId, right: 99, ms: -5 });
const fsaRec = B.fsa.get(kid, { id: fsaId }).record;
check("attempt clamps right to total, ms to >= 0, keeps 10 newest", r.ok === true && fsaRec.attempts[0].right === 3 && fsaRec.attempts[0].total === 3 && fsaRec.attempts[0].ms === 0, fsaRec.attempts[0]);
check("remove -> ok; clear -> ok + log", B.fsa.remove(PARENT, { id: fsaId }).ok === true && B.fsa.clear(PARENT).ok === true && deps.kd("k1").fsaSets.length === 0 && logs.some(l => /\[fsa\] practice sets cleared/.test(l)));

console.log("unitTest");
check("generate: no data -> 404", await failsAsync(() => B.unitTest.generate(kid, { grade: "9", strand: "number", lang: "en" }), 404));
check("generate: unknown unit -> 400", await failsAsync(() => B.unitTest.generate(kid, { grade: "4", strand: "nope", lang: "en" }), 400));
r = await B.unitTest.generate(kid, { grade: "4", strand: "number", lang: "en" });
check("generate: pack hit -> {set, provider:pack, ms:0, packed:true}, title falls back to unit name, ledger pack", r.packed === true && r.provider === "pack" && r.ms === 0 && r.set.title === "Number" && r.set.unitName.zh === "数" && r.set.grade === "4" && ledger.some(e => e.task === "unit" && e.provider === "pack"), r);
check("generate: fresh + no engine -> 503 needsEngine", await failsAsync(() => B.unitTest.generate(kid, { grade: "4", strand: "number", lang: "en", fresh: true }), 503, "needsEngine"));
check("generate: zh has no pack in the stub -> 503 needsEngine", await failsAsync(() => B.unitTest.generate(kid, { grade: "4", strand: "number", lang: "zh" }), 503, "needsEngine"));
const utId = r.set.id;
check("list: grade '4' also matches 'skills-g4'; strand filter", B.unitTest.list(kid, { grade: "4" }).items.length === 1 && B.unitTest.list(kid, { grade: "4", strand: "x" }).items.length === 0);
check("attempt: unknown -> 404", fails(() => B.unitTest.attempt(kid, { id: "zzz", answers: [0] }), 404));
r = B.unitTest.attempt(kid, { id: utId, answers: [null, false] });
check("attempt: nothing valid -> skipped, no attempt stored", r.skipped === true && r.answered === 0 && B.unitTest.get(kid, { id: utId }).record.attempts.length === 0, r);
const rightBefore = (deps.kd("k1").progress["BC.MATH.G4.NUM.01"] || {}).right || 0;
r = B.unitTest.attempt(kid, { id: utId, answers: [1, 7], ms: 12.6 });
const utRec = B.unitTest.get(kid, { id: utId }).record;
const utDiag = { ok: r.ok === true, right: r.right === 1, total: r.total === 2, answered: r.answered === 1, done: utRec.attempts[0].done === false, ms: utRec.attempts[0].ms === 13, answers: utRec.attempts[0].answers.join() === "1,-1", progress: deps.kd("k1").progress["BC.MATH.G4.NUM.01"].right === rightBefore + 1, rightBefore, rightAfter: deps.kd("k1").progress["BC.MATH.G4.NUM.01"].right };
check("attempt: scores server-side, out-of-range = unanswered, progress only for items with curriculumId", Object.values(utDiag).every(v => v === true || typeof v === "number"), utDiag);
check("remove -> ok; clear -> ok + log", B.unitTest.remove(PARENT, { id: utId }).ok === true && B.unitTest.clear(PARENT).ok === true && logs.some(l => /\[unit\] tests cleared/.test(l)));

console.log("report");
check("view: unknown grade -> 404 with grades", fails(() => B.report.view(PARENT, { grade: "9" }), 404, "grades"));
r = B.report.view(PARENT, { grade: "4" });
check("view -> strands with level/status, totals, de-duplicated terms, kid", r.grade === 4 && r.strands[0].total === 2 && r.strands[0].seen === 1 && r.totals.seen === 1 && r.terms.length === 1 && r.kid.name === "Kiki" && r.strands[0].items[0].status === "seen" && !("skills" in r.strands[0].items[0]), r);
check("generateFull: no digest -> 404", await failsAsync(() => B.report.generateFull(PARENT, { grade: "9", lang: "en" }), 404));
check("generateFull: no engine -> 503", await failsAsync(() => B.report.generateFull(PARENT, { grade: "4", lang: "en" }), 503));
extra.reportsAdd("k1", { time: 1, content: {} });
const repId = B.report.listFull(PARENT).items[0].id;
check("listFull / getFull / removeFull", B.report.getFull(PARENT, { id: repId }).record.id === repId && B.report.removeFull(PARENT, { id: repId }).ok === true && fails(() => B.report.getFull(PARENT, { id: repId }), 404) && saved.includes("k1/reports"));

console.log("lesson");
check("teach: unknown item -> 400", await failsAsync(() => B.lesson.create(kid, { mode: "teach", curriculumId: "nope", lang: "en" }), 400));
check("solve: empty question and no image -> 400", await failsAsync(() => B.lesson.create(kid, { lang: "en", question: "" }), 400));
const taughtBefore = (deps.kd("k1").progress["BC.MATH.G4.NUM.01"] || {}).taught || 0;
r = await B.lesson.create(kid, { mode: "teach", curriculumId: "BC.MATH.G4.NUM.01", lang: "en", grade: "Grade 4" });
const lsDiag = { packed: r.packed === true, provider: r.provider === "pack", title: r.lesson.title === "Packed", tts: r.tts === false, status: r.status === "seen", lessonId: typeof r.lessonId === "string",
  histQ: deps.kd("k1").history[0].question === "n", histMode: deps.kd("k1").history[0].mode === "teach", taught: deps.kd("k1").progress["BC.MATH.G4.NUM.01"].taught === taughtBefore + 1, lessonIds: deps.kd("k1").progress["BC.MATH.G4.NUM.01"].lessonIds[0] === r.lessonId, histQValue: deps.kd("k1").history[0].question };
check("teach: pack hit -> packed response, history record with the topic name as question, progress taught, lessonId", Object.values(lsDiag).every(v => v === true || typeof v === "string"), lsDiag);
check("teach: fresh + no engine -> 503 needsEngine", await failsAsync(() => B.lesson.create(kid, { mode: "teach", curriculumId: "BC.MATH.G4.NUM.01", lang: "en", fresh: true }), 503, "needsEngine"));
check("solve: no engine -> 503 needsEngine", await failsAsync(() => B.lesson.create(kid, { question: "2+2", lang: "en" }), 503, "needsEngine"));
const C = create({ ...deps, ...extra, pickProvider: () => "fake" });
check("solve with image on an engine that cannot see -> 400", await failsAsync(() => C.lesson.create(kid, { question: "", imageB64: "AAAA", lang: "en" }), 400));
check("solve: engine failing twice -> the engine error propagates (not an ActionError)", await (async () => { try { await C.lesson.create(kid, { question: "2+2", lang: "en" }); return false; } catch (e) { return !(e instanceof ActionError) && /engine down/.test(e.message) && logs.some(l => /\[lesson\] first try failed/.test(l)); } })());

process.exit(summary() ? 0 : 1);
