#!/usr/bin/env node
/*
 * lib/domain/quiz.js 的单元测试（#23）。不起服务器、不读盘。
 *
 *   node tools/test_quiz.mjs
 *
 * 钉住的是 2026-09-25 前写在 public/index.html 里的那套规则：借题顺序、升降级、通关阈值、8 题上限，
 * 以及「发给客户端的题没有答案」。端到端的通关 / 不通关路径在 golden_cases 里。
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const Q = require("../lib/domain/quiz.js");
const { check, summary } = makeChecker();
const ident = a => a;
const mk = (lv, i, extra) => Object.assign({ qid: `L${lv}-${i}`, level: lv, question: "q", options: ["a", "b", "c", "d"], answerIndex: i % 4, explain: "e" }, extra || {});
const bank = { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3, 4, 5].map(i => mk(lv, i))) };

console.log("rules");
check("constants match docs/qbank-standard.md", Q.MAX_QUESTIONS === 8 && Q.PASS_NEED === 2 && Q.TOP_LEVEL === 3 && Q.SESSION_PER_LEVEL === 4 && Q.PER_LEVEL_NEW === 4 && Q.LEVEL_CAP === 12);
check("RULES object is what the client sees", JSON.stringify(Q.RULES) === JSON.stringify({ maxQuestions: 8, passNeed: 2, topLevel: 3 }));

console.log("pickSession");
let bl = Q.pickSession(bank, ident);
check("4 per level, fresh first in given order", bl[1].join() === "L1-0,L1-1,L1-2,L1-3" && bl[3].length === 4, bl);
const usedBank = { questions: bank.questions.map(q => q.level === 1 && q.qid !== "L1-5" ? { ...q, usedAt: 100 - Number(q.qid.slice(-1)) } : q) };
bl = Q.pickSession(usedBank, ident);
check("fresh one first, then used by oldest usedAt", bl[1].join() === "L1-5,L1-4,L1-3,L1-2", bl[1]);
bl = Q.pickSession({ questions: [mk(1, 0), mk(3, 0)] }, ident);
check("a level with no questions yields an empty list", bl[1].length === 1 && bl[2].length === 0 && bl[3].length === 1, bl);

console.log("nextQuestion: borrow order");
check("borrowOrder", Q.borrowOrder(1).join() === "1,2,3" && Q.borrowOrder(2).join() === "2,1,3" && Q.borrowOrder(3).join() === "3,2,1");
let st = Q.newState({ 1: [], 2: ["L2-0"], 3: ["L3-0"] });
let qid = Q.nextQuestion(st);
check("L1 empty -> borrows L2 and moves level to 2, n=1", qid === "L2-0" && st.level === 2 && st.n === 1 && st.cur === "L2-0" && st.answered === false, st);
st = Q.newState({ 1: [], 2: [], 3: [] });
check("no questions at all -> null", Q.nextQuestion(st) === null && st.n === 0);
st = Q.newState({ 1: ["a"], 2: [], 3: [] }); st.level = 3;
check("at L3 with only L1 left -> borrows L1 (3,2,1 order)", Q.nextQuestion(st) === "a" && st.level === 1);

console.log("judge / applyAnswer");
const q1 = mk(1, 2);
check("judge: valid + correct", JSON.stringify(Q.judge(q1, 2)) === '{"valid":true,"correct":true}');
check("judge: valid + wrong", JSON.stringify(Q.judge(q1, 0)) === '{"valid":true,"correct":false}');
check("judge: invalid indexes", [null, -1, 4, 1.5, "2", true, undefined, {}].every(p => Q.judge(q1, p).valid === false));
st = Q.newState({ 1: ["L1-2"], 2: ["L2-1"], 3: ["L3-0", "L3-1", "L3-2"] });
Q.nextQuestion(st);
check("answering a question that is not current -> null", Q.applyAnswer(st, mk(2, 1), 1) === null);
check("invalid index -> null, state untouched", Q.applyAnswer(st, q1, 9) === null && st.answered === false && st.results.length === 0);
let r = Q.applyAnswer(st, q1, 2);
check("right at L1 -> level 2, result logged, not finished", r.correct === true && r.finished === false && st.level === 2 && st.results[0].ok === true && st.results[0].level === 1, st);
check("same question twice -> null", Q.applyAnswer(st, q1, 2) === null);
Q.nextQuestion(st); r = Q.applyAnswer(st, mk(2, 1), 3);
check("wrong at L2 -> back to level 1", r.correct === false && st.level === 1 && st.topRight === 0);
st.level = 3; Q.nextQuestion(st);
check("borrowed from L3 pool", st.cur === "L3-0" && st.level === 3);
r = Q.applyAnswer(st, mk(3, 0), 0);
check("right at L3 -> topRight 1, level stays 3, not finished", r.correct && st.topRight === 1 && st.level === 3 && r.finished === false);
Q.nextQuestion(st); r = Q.applyAnswer(st, mk(3, 1), 1);
check("second right at L3 -> finished (PASS_NEED)", r.finished === true && st.topRight === 2 && Q.isFinished(st));
check("nextQuestion after finished -> null", Q.nextQuestion(st) === null);
check("tally", JSON.stringify(Q.tally(st)) === JSON.stringify({ right: 3, wrong: 1, total: 4, passed: true }));

console.log("8-question cap");
st = Q.newState({ 1: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], 2: [], 3: [] });
let count = 0;
for (;;) { const id = Q.nextQuestion(st); if (!id) break; count++; Q.applyAnswer(st, mk(1, 0, { qid: id }), 3); }
check("all wrong at L1: stops after MAX_QUESTIONS, level pinned at 1", count === 8 && st.n === 8 && st.level === 1 && Q.isFinished(st) && !Q.tally(st).passed, { count, st });

console.log("publicQuestion / missTag");
const pq = Q.publicQuestion(mk(2, 1, { tags: ["m1", "ok", "m2", "other"], visual: { type: "barModel", nums: [1] }, usedAt: 5 }));
check("client copy has no answerIndex / explain / tags / usedAt, keeps visual", !("answerIndex" in pq) && !("explain" in pq) && !("tags" in pq) && !("usedAt" in pq) && pq.visual.type === "barModel" && pq.options.length === 4, pq);
const tq = mk(1, 1, { tags: ["m1", "ok", "m2", "other"] });
check("missTag: misconception id for a wrong pick", Q.missTag(tq, 0) === "m1" && Q.missTag(tq, 2) === "m2");
check("missTag: ok / other / no tags / out of range -> empty", Q.missTag(tq, 1) === "" && Q.missTag(tq, 3) === "" && Q.missTag(mk(1, 1), 0) === "" && Q.missTag(tq, 7) === "");

process.exit(summary() ? 0 : 1);
