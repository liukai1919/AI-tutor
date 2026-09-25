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
  progressRecord: (id, cid, ev) => M.applyEvent(deps.kd(id).progress, cid, ev, { now: 1000 }),
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
deps.kd("k1").progress["BC.MATH.G4.NUM.01"] = { taught: 1, lessonIds: ["L9", "L8"] };
r = A.curriculum.view(kid, { grade: "4" });
check("grade -> strands with status + latest lessonId + unitKey", r.grade === 4 && r.strands[0].items[0].status === "seen" && r.strands[0].items[0].lessonId === "L9" && r.strands[0].items[1].lessonId === "" && r.unitKey === "4", r);

console.log("quiz.start / answer / finish");
check("unknown item -> 400", await failsAsync(() => A.quiz.start(kid, { curriculumId: "nope", lang: "en" }), 400));
check("no bank + no engine -> 503 needsEngine", await failsAsync(() => A.quiz.start(kid, { curriculumId: "BC.MATH.G4.NUM.02", lang: "en" }), 503, "needsEngine"));
r = await A.quiz.start(kid, { curriculumId: "BC.MATH.G4.NUM.01", lang: "en" });
check("start -> session/rules/level 1/n 1/first question without answer", typeof r.session === "string" && r.rules.passNeed === 2 && r.level === 1 && r.n === 1 && r.question.qid === "q10" && !("answerIndex" in r.question), r);
check("bank hit recorded in the ledger as provider=bank", ledger.length === 1 && ledger[0].provider === "bank");
const sid = r.session;
check("answer: someone else's ticket -> 400 staleSession", fails(() => A.quiz.answer({ ...kid, userId: "other" }, { session: sid, picked: 0 }), 400, "staleSession"));
check("answer: bad index -> 400", fails(() => A.quiz.answer(kid, { session: sid, picked: 7 }), 400));
r = A.quiz.answer(kid, { session: sid, picked: 0 });
check("answer q10 right -> correct, answerIndex/explain revealed, level 2, next is L2", r.correct === true && r.answerIndex === 0 && r.explain === "why" && r.level === 2 && r.next.qid === "q20" && r.finished === false, r);
r = A.quiz.answer(kid, { session: sid, picked: 3 });
check("answer q20 wrong -> back to level 1", r.correct === false && r.level === 1 && r.next.level === 1);
check("finish: unknown item -> 400", fails(() => A.quiz.finish(kid, { session: sid, curriculumId: "nope" }), 400));
check("finish: no kid -> 400 kidRequired", fails(() => A.quiz.finish(parentNoKid, { session: sid, curriculumId: "BC.MATH.G4.NUM.01" }), 400, "kidRequired"));
r = A.quiz.finish(kid, { session: sid, curriculumId: "BC.MATH.G4.NUM.01" });
check("finish -> {ok, passed:false, right 1, total 2, status, level}, usedAt stamped, qbank saved", r.ok === true && r.passed === false && r.right === 1 && r.total === 2 && r.status === "seen" && qbank["BC.MATH.G4.NUM.01|en"].questions[0].usedAt === undefined ? false : (qbank["BC.MATH.G4.NUM.01|en"].questions.find(q => q.qid === "q10").usedAt > 0 && saved.includes("qbank")), r);
check("finish again -> 400 staleSession (one-shot)", fails(() => A.quiz.finish(kid, { session: sid, curriculumId: "BC.MATH.G4.NUM.01" }), 400, "staleSession"));
check("answer after settle -> 400 staleSession", fails(() => A.quiz.answer(kid, { session: sid, picked: 0 }), 400, "staleSession"));

process.exit(summary() ? 0 : 1);
