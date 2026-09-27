#!/usr/bin/env node
/*
 * 显式验证单测 + 组合测试（#38，#19 Phase 7）。零成本：不起服务器、不读 data/、不调真实模型、不联网。
 *
 *   node tools/test_verification.mjs
 *
 * 片 A：精确数字、答案 verifier、grader（外部 req 的严格读取）。
 * 片 B：正文等式 / 泄露 / 上下文规则、verifyResponse 与旧文案兼容、可信上下文的严格读取；真实 TutorAgent（回放模型 + 真实工具注册表）接入。
 * 片 C：工作流后置条件的纯函数反例；真实工作流 + Phase 5 memory（fs.mkdtemp 临时目录的文件 store）+ 回放 TutorAgent + 确定性 grader 的端到端路径。
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const V = require("../lib/ai/verification/index.js");
const { parseAnswerNumber, evaluateExact, verifyAnswer, createAnswerGrader, verifyResponse, extractEqualities, findAnswerLeak, readVerifyContext, VerificationError, verifyStep } = V;
const { createTutorAgent, TEXTS, screenText } = require("../lib/ai/tutor/index.js");
const { createReplayModel } = require("../lib/ai/harness/replay.js");
const { createTools } = require("../lib/ai/tools/index.js");
const { createTutorWorkflow } = require("../lib/ai/workflows/index.js");
const machine = require("../lib/ai/workflows/machine.js");
const adapters = require("../lib/ai/workflows/adapters.js");
const { createMemory } = require("../lib/ai/memory/index.js");
const { createFileStore } = require("../lib/ai/memory/file-store.js");
const { check, summary } = makeChecker();

const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));
const J = v => JSON.stringify(v);
const isDeepFrozen = v => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/* ================= 片 A：数字与答案 ================= */
console.log("numbers: bounded exact rationals");
{
  const val = s => { const r = parseAnswerNumber(s); return r.ok ? `${r.value.n}/${r.value.d}|${r.canon}` : "x:" + r.reason; };
  const table = [
    ["42", "42/1|42"], ["-0", "0/1|0"], ["+007", "7/1|7"], ["0.50", "1/2|0.50"], [".5", "1/2|0.5"], ["-3/6", "-1/2|-3/6"], ["1 1/2", "3/2|1 1/2"],
    ["１２", "12/1|12"], ["−3", "-3/1|-3"], ["3 / 4", "3/4|3/4"], [" 42 ", "42/1|42"],
    ["4²", "x:unsupported"], ["½", "x:unsupported"], ["1,000", "x:unsupported"], ["1e3", "x:unsupported"], ["50%", "x:unsupported"], ["3 cm", "x:unsupported"],
    ["3/0", "x:zero-denominator"], ["1 3/2", "x:unsupported"], ["", "x:empty"], ["   ", "x:empty"], ["5.", "x:unsupported"], ["--5", "x:unsupported"],
    ["1".repeat(31), "x:unsupported"], ["1".repeat(1000), "x:too-long"], ["二分之一", "x:unsupported"],
  ];
  const got = table.map(([s]) => val(s));
  check("answer-number syntax table (integers, decimals, fractions, mixed numbers; everything else unsupported)", J(got) === J(table.map(t => t[1])), table.map((t, i) => [t[0], got[i]]).filter((x, i) => x[1] !== table[i][1]));
  check("non-strings are not numbers", [42, null, undefined, {}, ["4"]].every(x => !parseAnswerNumber(x).ok));
  const ev = s => { const r = evaluateExact(s); return r.ok ? `${r.value.n}/${r.value.d}` : r.reason; };
  const et = [["0.1 + 0.2", "3/10"], ["1/2 - 1/3", "1/6"], ["37 × 24", "888/1"], ["45 ÷ 5", "9/1"], ["2^10", "1024/1"], ["2^-2", "1/4"], ["-2^2", "-4/1"], ["(3+4)*5", "35/1"],
    ["1/0", "div0"], ["0^-1", "div0"], ["2^0.5", "syntax"], ["3(4)", "syntax"], ["2^100^2", "syntax"], ["9".repeat(30) + "^64", "too-large"], ["(".repeat(60) + "1" + ")".repeat(60), "syntax"],
    ["1+".repeat(120) + "1", "syntax"], ["", "syntax"], ["sqrt(4)", "syntax"], ["3 % 2", "syntax"]];
  const eg = et.map(([s]) => ev(s));
  check("exact evaluator: no float rounding (0.1+0.2 = 3/10), div-by-zero / syntax / too-large are distinct, depth and length bounded", J(eg) === J(et.map(t => t[1])), et.map((t, i) => [t[0], eg[i]]).filter((x, i) => x[1] !== et[i][1]));
}

console.log("answers: correct / wrong / uncertain");
{
  const T = [
    ["42", "42", "correct", "exact-match"], ["042", "42", "correct", "exact-match"], ["-0", "0", "correct", "exact-match"], [" 3/4", "3/4", "correct", "exact-match"],
    ["41", "42", "wrong", "value-differs"], ["0.30000000000000004", "0.3", "wrong", "value-differs"], ["0.333333333333", "1/3", "wrong", "value-differs"],
    ["9007199254740993", "9007199254740992", "wrong", "value-differs"], ["123456789012345678901234567890", "123456789012345678901234567891", "wrong", "value-differs"],
    ["-5", "5", "wrong", "value-differs"],
    ["4/8", "1/2", "uncertain", "equivalent-form"], ["0.5", "1/2", "uncertain", "equivalent-form"], ["4.0", "4", "uncertain", "equivalent-form"], ["0.50", "0.5", "uncertain", "equivalent-form"],
    ["1 1/2", "3/2", "uncertain", "equivalent-form"],
    ["42", null, "uncertain", "no-key"], ["42", "", "uncertain", "no-key"], ["42", "x = 42", "uncertain", "key-unsupported"], ["42", "ZK:42:7f3a", "uncertain", "key-unsupported"],
    ["forty-two", "42", "uncertain", "answer-unsupported"], ["42 cm", "42", "uncertain", "answer-unsupported"], ["x=42", "42", "uncertain", "answer-unsupported"],
    ["", "42", "uncertain", "answer-empty"], [42, "42", "uncertain", "answer-unsupported"], ["4²", "16", "uncertain", "answer-unsupported"],
  ];
  const got = T.map(([a, k]) => verifyAnswer(a, k));
  check("verifyAnswer table: exact values, conservative forms, unsupported → uncertain", got.every((r, i) => r.status === T[i][2] && r.reason === T[i][3]),
    T.map((t, i) => [t[0], t[1], got[i]]).filter((x, i) => x[2].status !== T[i][2] || x[2].reason !== T[i][3]));
  check("results are frozen and carry only status + reason (no key or answer text)", got.every(r => Object.isFrozen(r) && Object.keys(r).join() === "status,reason") && !J(got).includes("9007199254740992"));
  const t0 = Date.now();
  for (const s of ["9".repeat(100000), "1/" + "0".repeat(50), "(".repeat(5000), "1 ".repeat(5000)]) verifyAnswer(s, "1");
  check("malicious long inputs resolve quickly as uncertain", Date.now() - t0 < 200);
}

console.log("grader: trusted seam for the Phase 6 workflow");
{
  const g = createAnswerGrader();
  check("grader is frozen with only grade()", Object.isFrozen(g) && Object.keys(g).join() === "grade");
  const r1 = g.grade({ answerKey: "42", answer: "42", ctx: {}, topicId: "T", questionId: "Q", prompt: "p", attemptId: "a" });
  const r2 = g.grade({ answerKey: "42", answer: "41" });
  const r3 = g.grade({ answerKey: "42", answer: "about 40" });
  check("correct / wrong / uncertain; never a mistake category (a wrong answer is not evidence of a misconception)",
    r1.outcome === "correct" && r2.outcome === "wrong" && r3.outcome === "uncertain" && [r1, r2, r3].every(r => !("mistake" in r) && Object.isFrozen(r) && Object.keys(r).join() === "outcome"));
  check("grader results pass the workflow's strict readGrade", [r1, r2, r3].every(r => adapters.readGrade(r).outcome === r.outcome));
  let touched = false;
  const getter = { answerKey: "42", get answer() { touched = true; return "42"; } };
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } });
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const odd = [getter, throwing, revoked, null, 42, "42", Object.create({ answerKey: "42", answer: "42" })];
  check("getter not executed, Proxy traps / revoked Proxy / non-objects / inherited fields → uncertain",
    odd.every(x => g.grade(x).outcome === "uncertain") && !touched);
  Object.prototype.answerKey = "42"; Object.prototype.answer = "42";
  let polluted;
  try { polluted = g.grade({}); } finally { delete Object.prototype.answerKey; delete Object.prototype.answer; }
  check("Object.prototype pollution cannot supply a key or an answer", polluted.outcome === "uncertain");
  const req = { answerKey: "42", answer: "42" };
  const out = g.grade(req); req.answer = "41";
  check("grade reads the request synchronously, once", out.outcome === "correct");
}

/* ================= 片 B：回复验证 ================= */
console.log("response: explicit arithmetic equalities");
{
  const st = t => extractEqualities(t).map(e => e.status);
  const checked = [
    ["37 × 24 = 888. Split it: 37 × 20 = 740 and 37 × 4 = 148, then 740 + 148 = 888.", [true, "unknown", "unknown", true]],
    ["先通分：3/4 = 6/8，6/8 + 1/8 = 7/8（也就是 0.875）。", [true, "unknown"]],
    ["1/2 - 1/3 = 1/6，所以 1/2 更大。", [true]], ["0.1 + 0.2 = 0.3", [true]], ["3 − 5 = −2", [true]], ["3.5 = 7/2.", [true]],
    ["3 + 4 = 8", [false]], ["所以 3 + 4 = 8，", [false]], ["(3 + 4 = 8)", [false]], ["２＋２＝５。", [false]], ["then 740 + 148 = 887.", [false]], ["10 ÷ 0 = 0.", [false]],
  ];
  const bad = checked.filter(([t, want]) => J(st(t)) !== J(want)).map(([t]) => [t, extractEqualities(t)]);
  check("clean equalities are checked exactly (true / false), including zh punctuation and full-width digits", bad.length === 0, bad);
  const notChecked = ["15% of 80 = 0.15 × 80 = 12.", "2x + 3 = 11", "√16 = 4", "4² = 16", "1,000 = 1000", "10:30 = 3", "3 乘 4 = 12", "3 + 4 = 8?", "Is 7 × 8 = 54 right?",
    "13 ÷ 4 = 3……1", "13 ÷ 4 = 3 R1", "7 ÷ 2 = 3 and 1/2", "6 = 2(x+1)", "x = 5", "Area = 8 × 5 = 45 square cm", "8 + 7 = ?", "你算的 45 ÷ 5 = 8 对吗？", "2 x 3 = 7",
    "0.1 + 0.2 = 0.3 (1 tenth + 2 tenths = 3 tenths).", "Think of it as 10 × 5 = 51 plus"];
  const fp = notChecked.filter(t => extractEqualities(t).some(e => e.status !== "unknown"));
  check("ambiguous boundaries (%, words, variables, √, superscripts, separators, remainders, questions, implicit products) are never judged", fp.length === 0, fp.map(t => [t, extractEqualities(t)]));
  check("Unicode is never folded into different math: 2² = 22 / 2² = 4 / 1½ = 11/2 are not judged, and 2² / 1½ are not answers",
    ["2² = 22", "2² = 4", "1½ = 11/2", "½ = 1/2"].every(t => extractEqualities(t).every(e => e.status === "unknown")) &&
    verifyAnswer("2²", "22").status === "uncertain" && verifyAnswer("1½", "11/2").status === "uncertain" && verifyAnswer("1½", "1 1/2").status === "uncertain");
  const many = "1 = 1; ".repeat(50);
  const longFalse = verifyResponse({ kind: "answer", text: many + "2 + 2 = 5.", scope: "math" }, { mode: "answer" });
  const longTrue = verifyResponse({ kind: "answer", text: many + "2 + 2 = 4.", scope: "math" }, { mode: "answer" });
  check("the scan is complete: a false equation after 50 true ones still fails; a true one is counted (51 checked)",
    !longFalse.ok && longFalse.failures[0].rule === "equality" && longTrue.ok && longTrue.coverage.equalities.checked === 51, [longFalse.coverage, longTrue.coverage]);
  check("an equality quoted from the question (the child's own work) is not the model's claim",
    extractEqualities("45 ÷ 5 = 8, that's not right.", "我算 45 ÷ 5 = 8，对吗？")[0].status === "unknown" && extractEqualities("45 ÷ 5 = 8, that's not right.")[0].status === false);
}

console.log("response: explicit answer leaks (hint mode, numeric key)");
{
  const L = (t, k, q) => findAnswerLeak(t, k, q).leak;
  const leaks = [["12 ÷ 3 = 4", "4"], ["x = 4", "4"], ["so 2x = 8, then x = 4.", "4"], ["4 = 12 ÷ 3", "4"], ["The answer is 42.", "42"], ["It makes 42 in total", "42"],
    ["答案是 15。", "15"], ["8 + 7 等于 15", "15"], ["The answer is 4/8", "1/2"], ["Try 10 + 5 = 15 first", "15", "8 + 7 = ?"], ["结果为 0.5", "1/2"]];
  const ok = [["Use 3 × 4 = 12 to help.", "4", "If 3 × 4 = 12, what is 12 ÷ 3?"], ["What is 4 × 1?", "4", "What is 4 × 1?"], ["Remember 3 × 4 = 12", "12", "If 3 × 4 = 12, what is 3 × 4 + 0?"],
    ["等于 40 ÷ 5 吗", "8"], ["3 × 4 = 12", "4"], ["x ≥ 4", "4"], ["= 40%", "40"], ["If x = 4 then", "4", "Is x = 4 a solution of 2x = 8?"], ["Count 4 more: 5, 6, 7, 8.", "8"],
    ["The answer is 42.5", "42"], ["We need 4 groups", "4"]];
  const missed = leaks.filter(([t, k, q]) => !L(t, k, q)), wrongly = ok.filter(([t, k, q]) => L(t, k, q));
  check("documented explicit forms are caught (= key, key =, answer is / equals / 答案是 / 等于), any numeric form of the key", missed.length === 0, missed);
  check("not every occurrence of the key numeral is a leak: operands, text already in the question, other values, counting", wrongly.length === 0, wrongly);
  check("non-numeric keys are not covered (reported, never guessed)", J(findAnswerLeak("x = 42", "ZK:42:7f3a")) === J({ covered: false, leak: false }));
  const gram = [["The answer is .5.", "0.5", true], ["The answer is 1 1/2.", "1.5", true], ["The answer is 1 1/2.", "3/2", true], ["The answer is 4.", "4", true], ["2 + 2 = 4.", "4", true],
    ["结果为 -3。", "-3", true], ["The answer is 4e2.", "4", false], ["x = 4cm", "4", false], ["= 4,000 in all", "4", false], ["The answer is 4.5", "4", false], ["2 + 2 = 4²", "4", false],
    ["It makes 42.", "42", true], ["It makes 42%.", "42", false]];
  const gramBad = gram.filter(([t, k, want]) => findAnswerLeak(t, k, "What is it?").leak !== want);
  check("numeral boundaries match the supported number grammar (.5, mixed numbers, sentence-final periods) and never truncate 4e2 / 4cm / 4,000 / 4.5 / 4² into a matching prefix", gramBad.length === 0, gramBad);
}

console.log("response: verifyResponse compatibility and context rules");
{
  const screen = screenText;
  const vr = (o, opts) => verifyResponse(o, Object.assign({ mode: "answer", screen }, opts));
  const msgs = [
    vr({ kind: "answer", text: "x", scope: "non_academic" }).failures[0].message,
    vr({ kind: "answer", text: "x", scope: "math" }, { mode: "hint" }).failures[0].message,
    vr({ kind: "answer", text: "see www.example.com", scope: "math" }).failures[0].message,
    vr({ kind: "answer", text: "x", scope: "math", checks: [{ expression: "2+2", value: 5 }] }).failures[0].message,
    vr({ kind: "answer", text: "x", scope: "math", checks: [{ expression: "2+", value: 5 }] }).failures[0].message,
  ];
  check("legacy messages are byte-for-byte the TutorAgent's (scope, hint kind, screen, check failed, check cannot be evaluated)", J(msgs) === J([
    'only math questions may be answered; scope "non_academic" needs kind "refusal"', 'hint mode: give a hint (kind "hint"), not the answer',
    "answer text contains off-scope content (link); keep to the math, no links", "check failed: 2+2 = 4, not 5; fix the answer", 'check "2+" cannot be evaluated: unexpected end']), msgs);
  check("declared checks keep the 1e-9 relative tolerance for JSON number values", vr({ kind: "answer", text: "x", scope: "math", checks: [{ expression: "1/2-1/3", value: 0.16666666667 }] }).ok);
  check("refusal output: nothing is checked", vr({ kind: "refusal", text: "3 + 4 = 8", scope: "non_academic" }).ok);
  const eq = vr({ kind: "hint", text: "Hint: 3 + 4 = 8, so try again.", scope: "math", checks: [{ expression: "3+4", value: 7 }] });
  check("a false text equality fails even when the self-reported checks are correct and the kind is hint", !eq.ok && eq.failures[0].rule === "equality" && /3 \+ 4 = 8/.test(eq.failures[0].message));
  const good = vr({ kind: "answer", text: "37 × 24 = 888.", scope: "math" });
  check("coverage says what ran; prose is never 'verified'", good.ok && good.coverage.equalities.checked === 1 && good.coverage.prose === "not-verified" &&
    !J(good.coverage).includes('"verified"') && isDeepFrozen(good) && good.coverage.answerLeak === "not-applicable" && good.coverage.curriculumClaims === "not-covered");
  const ctx = readVerifyContext({ topicId: "BC.MATH.G5.N2", allowedTopicIds: ["BC.MATH.G5.N1"], answerKey: "7921" });
  const lookup = (id, result) => ({ tool: "curriculum.findTopic", input: { curriculumId: id }, result });
  const inScope = [lookup("BC.MATH.G5.N2", { id: "BC.MATH.G5.N2", skill: { prerequisites: ["BC.MATH.G4.N9"] } })];
  const outOfScope = [lookup("BC.MATH.G5.N3", { id: "BC.MATH.G5.N3", skill: { prerequisites: ["BC.MATH.G4.N8"] } })];
  const C = (text, extra) => vr({ kind: "answer", text, scope: "math" }, Object.assign({ context: ctx, evidence: [] }, extra));
  check("curriculum ids: topic / allowed ids / ids returned by a lookup of an in-scope id pass; any other id fails", C("See BC.MATH.G5.N2 and BC.MATH.G5.N1.").ok &&
    C("BC.MATH.G5.N2 builds on BC.MATH.G4.N9.", { evidence: inScope }).ok && C("Next is BC.MATH.G6.N1.").failures[0].rule === "curriculum-claim" &&
    C("BC.MATH.G5.N3 is next.").failures[0].rule === "curriculum-claim");
  check("looking up an out-of-scope id does not bring it (or its prerequisites) into the lesson's scope; without a scope any lookup is a source",
    C("BC.MATH.G5.N3 builds on BC.MATH.G4.N8.", { evidence: outOfScope }).failures[0].rule === "curriculum-claim" &&
    vr({ kind: "answer", text: "BC.MATH.G5.N3 builds on BC.MATH.G4.N8.", scope: "math" }, { context: readVerifyContext({}), evidence: outOfScope }).ok);
  const calc = (expression, value) => ({ tool: "calculator.evaluate", input: { expression }, result: { expression, value } });
  check("calculator claims are bound to values: no call / a call for another value / an unbacked second equation / no equation at all → fail; every equation backed → pass; asking the child to check is not a claim",
    C("I checked it with the calculator: 7 × 8 = 56.").failures[0].rule === "calculator-claim" &&
    C("I checked it with the calculator: 7 × 8 = 56.", { evidence: [calc("2+2", 4)] }).failures[0].rule === "calculator-claim" &&
    C("I checked it with the calculator: 7 × 8 = 56, then 6 × 9 = 54.", { evidence: [calc("7*8", 56)] }).failures[0].rule === "calculator-claim" &&
    C("I checked it with the calculator: 7 × 8 = 56, then 6 × 9 = 54.", { evidence: [calc("7*8", 56), calc("54", 54)] }).ok &&
    C("I checked it with the calculator: 7 × 8 = 56.", { evidence: [calc("7*8", 56)] }).ok &&
    C("我用计算器验算过了。", { evidence: [calc("7*8", 56)] }).failures[0].rule === "calculator-claim" && C("你可以用计算器验算一下。").ok);
  const H = (text, extra) => vr({ kind: "hint", text, scope: "math" }, Object.assign({ mode: "hint", context: ctx, evidence: [], question: "What is 89 × 89?" }, extra));
  check("hint mode + key: explicit leak fails, operand use passes, coverage says checked", H("89 × 89 = 7921").failures[0].rule === "answer-leak" &&
    H("Start with 89 × 90 = 8010. What do you take away?").ok && H("Start with 89 × 90 = 8010. What do you take away?").coverage.answerLeak === "checked");
  check("leak and check messages never contain the key or a recomputed value when a key is present",
    !J(H("89 × 89 = 7921").failures).includes("7921") && !J(H("Hint: 7921 + 1 = 7921.").failures).includes("7921") && !J(vr({ kind: "hint", text: "t", scope: "math", checks: [{ expression: "89*90", value: 1 }] }, { mode: "hint", context: ctx }).failures).includes("8010"));
  check("socratic-teaching with context must ask a question (ASCII ? or full-width ？)", !H("Think about place value.", { strategy: "socratic-teaching" }).ok &&
    H("What is 89 × 90?", { strategy: "socratic-teaching" }).ok && H("一排有几个？", { strategy: "socratic-teaching" }).ok && !H("想一想位值。", { strategy: "socratic-teaching" }).ok);
  check("without evidence (e.g. the workflow's local re-check) curriculum / calculator claims are reported not-covered, not passed",
    vr({ kind: "answer", text: "BC.MATH.G9.X1", scope: "math" }, { context: ctx }).ok && vr({ kind: "answer", text: "x", scope: "math" }, { context: ctx }).coverage.curriculumClaims === "not-covered");
  check("malformed output → shape failure (no throw)", verifyResponse(null).failures[0].rule === "shape" && verifyResponse({ kind: 1, text: "x" }).failures[0].rule === "shape");
  const t0 = Date.now();
  const heavy = [verifyResponse({ kind: "hint", text: "=1".repeat(2000), scope: "math" }, { mode: "hint", context: readVerifyContext({ answerKey: "1" }), question: "1=".repeat(1000) }),
    verifyResponse({ kind: "answer", text: "(".repeat(3999) + "=", scope: "math" }), verifyResponse({ kind: "answer", text: "1+".repeat(1999) + "1=2", scope: "math" })];
  check("bounded work: adversarial 4000-character texts finish quickly; over the 8000-character cap → shape failure",
    Date.now() - t0 < 1000 && heavy.every(r => Object.isFrozen(r)) && verifyResponse({ kind: "answer", text: "x".repeat(8001) }).failures[0].rule === "shape", Date.now() - t0);
}

console.log("response: trusted context is read strictly");
{
  const vc = raw => { try { return readVerifyContext(raw); } catch (e) { return e instanceof VerificationError ? e.code : "FOREIGN"; } };
  const good = vc({ topicId: "BC.MATH.G5.N2", answerKey: "42" });
  check("valid context → frozen null-prototype copy", Object.isFrozen(good) && Object.getPrototypeOf(good) === null && good.answerKey === "42" && vc({}) !== "INVALID_VERIFY");
  let touched = false;
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const bads = [null, 42, "k", [], { extra: 1 }, { answerKey: "" }, { answerKey: "  " }, { answerKey: 42 }, { answerKey: "x".repeat(201) }, { answerKey: "4\u0000" },
    { topicId: "../x" }, { topicId: "__proto__" }, { allowedTopicIds: "T" }, { allowedTopicIds: Array(21).fill("T") }, { allowedTopicIds: ["ok", "b a d"] },
    { get answerKey() { touched = true; return "42"; } }, new Proxy({}, { ownKeys() { throw new Error("trap"); } }), revoked, new (class { constructor() { this.answerKey = "4"; } })()];
  const got = bads.map(vc);
  check("every malformed context → INVALID_VERIFY; getters are not executed", got.every(c => c === "INVALID_VERIFY") && !touched, got);
  let msg = "";
  try { readVerifyContext({ answerKey: "SECRET-" + "9".repeat(300) }); } catch (e) { msg = e.message; }
  check("the error message does not echo the content", msg && !msg.includes("SECRET"));
}

console.log("dependencies: verification never requires the tutor or the workflow service");
{
  const r = spawnSync(process.execPath, ["-e", "require('./lib/ai/verification/index.js');console.log(JSON.stringify(Object.keys(require.cache).map(p=>p.replace(/\\\\/g,'/'))))"], { cwd: rootDir, encoding: "utf8", windowsHide: true });
  let loaded = [];
  try { loaded = JSON.parse(r.stdout); } catch (_) { }
  check("loading lib/ai/verification pulls in no tutor / workflows / harness / skills module", loaded.length > 0 && !loaded.some(p => /lib\/ai\/(tutor|workflows|harness|skills)\//.test(p)), loaded);
}

/* ---------------- 真实 TutorAgent ---------------- */
const actionCalls = [];
const stubActions = new Proxy({}, { get: (_, g) => new Proxy({}, { get: (__, fn) => () => { actionCalls.push(`${String(g)}.${String(fn)}`); throw new Error("no actions"); } }) });
const findCurriculumItem = id => (id === "BC.MATH.G5.N2" ? { item: { id, en: "Decimals to thousandths", zh: "小数", strand: "number", skill: { prerequisites: ["BC.MATH.G4.N3"] } } } : null);
const registry = createTools({ actions: stubActions, findCurriculumItem, onTrace: () => {} });
const MATHL = { type: "final", output: { label: "math", reason: "math" } };
const fin = (kind, text, checks) => ({ type: "final", output: Object.assign({ kind, text, scope: "math" }, checks ? { checks } : {}) });
const KID = Object.freeze({ kidId: "k1", role: "student", userId: "u1" });
function agentWith(turns, n = 1) {
  const model = createReplayModel(turns), classifierModel = createReplayModel(Array(n).fill(MATHL));
  const traces = [];
  const agent = createTutorAgent({ registry, model, classifierModel, onTrace: t => traces.push(t) });
  const modelText = () => J([...model.calls, ...classifierModel.calls].map(r => ({ system: r.system, messages: r.messages, tools: r.tools })));
  return { agent, model, classifierModel, traces, modelText };
}

console.log("TutorAgent: default path unchanged, new unconditional arithmetic rule");
{
  const a = agentWith([fin("answer", "7 + 5 = 12.", [{ expression: "7+5", value: 12 }])]);
  const r = await a.agent.ask(KID, { question: "What is 7 + 5?", lang: "en" });
  const input = JSON.parse(a.model.calls[0].messages[0].content);
  check("no verify: result keys and model input are exactly the Phase 3 shape", r.kind === "answer" && J(Object.keys(r)) === J(["ok", "kind", "text", "gate", "steps", "calls", "checks"]) &&
    J(Object.keys(input)) === J(["question", "lang", "mode"]));
  const b = agentWith([fin("answer", "7 + 5 = 13."), fin("answer", "7 + 5 = 12. Count on from 7.")]);
  const rb = await b.agent.ask(KID, { question: "What is 7 + 5?", lang: "en" });
  const repair = b.model.calls[1].messages.find(m => m.role === "harness");
  check("a false equation in the text (no checks declared) is sent back and the rewrite is shown", rb.kind === "answer" && rb.text.startsWith("7 + 5 = 12") && b.model.calls.length === 2 &&
    repair && repair.error.code === "INVALID_FINAL" && /7 \+ 5 = 13/.test(repair.error.message));
  const c = agentWith([fin("hint", "Hint: 5 × 8 = 45, so try again."), fin("hint", "Hint: 5 × 8 = 45, so try again."), fin("hint", "Hint: 5 × 8 = 45, so try again.")]);
  const rc = await c.agent.ask(KID, { question: "Hint for 45 ÷ 5?", lang: "en", mode: "hint" });
  check("the rule applies to hints too; persisting → fixed error template, rejected text never shown", rc.kind === "error" && rc.text === TEXTS.en.error && rc.error.code === "INVALID_FINAL" && !rc.text.includes("45"));
  const many = "1 = 1; ".repeat(50);
  const lf = agentWith([fin("answer", many + "2 + 2 = 5."), fin("answer", many + "2 + 2 = 4.")]);
  const rlf = await lf.agent.ask(KID, { question: "What is 2 + 2?", lang: "en" });
  check("real TutorAgent: a false equation after 50 true ones is sent back; the all-true rewrite is shown", rlf.kind === "answer" && rlf.text.endsWith("2 + 2 = 4.") && lf.model.calls.length === 2);
  const d = agentWith([fin("answer", "45 ÷ 5 = 8, that's not right: 5 × 9 = 45, so 45 ÷ 5 = 9.")]);
  const rd = await d.agent.ask(KID, { question: "I got 45 ÷ 5 = 8. Is that right?", lang: "en", strategy: "evaluate-answer" });
  check("quoting the child's own wrong equation from the question is not rejected", rd.kind === "answer" && d.model.calls.length === 1);
}

console.log("TutorAgent: trusted verify context (local only)");
{
  const KEY = "7921";
  const a = agentWith([fin("hint", "89 × 89 = 7921"), fin("hint", "Start from 89 × 90 = 8010. How much do you take away?", [{ expression: "89*90", value: 8010 }])]);
  const vreq = { question: "What is 89 × 89?", lang: "en", mode: "hint", verify: { answerKey: KEY, topicId: "BC.MATH.G5.N2" } };
  const p = a.agent.ask(KID, vreq);
  vreq.verify.answerKey = "8010";   // 同一个 tick 里改：不影响这次 ask（公开入口同步快照）
  const r = await p;
  check("hint that states the key is sent back; the rewrite (key only as a later result, not stated) passes", r.kind === "hint" && r.text.startsWith("Start from") && a.model.calls.length === 2);
  check("verify is snapshotted synchronously at the public entry", r.kind === "hint");
  const firstMsgs = J(a.model.calls.map(c => c.messages[0])), repairs = J(a.model.calls.map(c => c.messages.filter(m => m.role === "harness")));
  check("the context never reaches a model request: no key in the user input or repair notes, no verify / answerKey / topic id anywhere",
    !firstMsgs.includes(KEY) && !repairs.includes(KEY) && !/answerKey|BC\.MATH\.G5\.N2/.test(a.modelText()) &&
    a.model.calls.every(c => J(Object.keys(JSON.parse(c.messages[0].content))) === J(["question", "lang", "mode"])), { firstMsgs, repairs });
  check("…nor any trace", !J(a.traces).includes(KEY) && !J(a.traces).includes("answerKey"));
  check("result carries a frozen coverage summary (leak checked, prose not verified) and no key",
    Object.isFrozen(r.verification) && r.verification.answerLeak === "checked" && r.verification.prose === "not-verified" && !J(r).includes(KEY));
  const b = agentWith([fin("hint", "89 × 89 = 7921"), fin("hint", "The answer is 7921."), fin("hint", "x = 7921")]);
  const rb = await b.agent.ask(KID, { question: "What is 89 × 89?", lang: "en", mode: "hint", verify: { answerKey: KEY } });
  check("persistent leak → error template; error message and result contain no key", rb.kind === "error" && rb.text === TEXTS.en.error && !J(rb).includes(KEY) &&
    b.model.calls.slice(1).every(c => c.messages.filter(m => m.role === "harness").every(m => !J(m).includes(KEY))));
  const c = agentWith([fin("hint", "Any number times 1 stays the same. What is 4 × 1?")]);
  const rc = await c.agent.ask(KID, { question: "What is 4 × 1?", lang: "en", mode: "hint", verify: { answerKey: "4" } });
  check("the key numeral already in the question is not a leak", rc.kind === "hint" && c.model.calls.length === 1);
  const d = agentWith([fin("answer", "BC.MATH.G6.N7 comes next."), fin("answer", "BC.MATH.G5.N2 is about decimals.")]);
  const rd = await d.agent.ask(KID, { question: "What is BC.MATH.G5.N2 about?", lang: "en", strategy: "curriculum-navigation", verify: { topicId: "BC.MATH.G5.N2" } });
  check("topic conflict: a curriculum id that is neither the topic nor looked up is sent back", rd.kind === "answer" && rd.text.startsWith("BC.MATH.G5.N2") && d.model.calls.length === 2);
  const e = agentWith([{ type: "tool_call", tool: "curriculum.findTopic", input: { curriculumId: "BC.MATH.G5.N2" } }, fin("answer", "Review BC.MATH.G4.N3 first, then BC.MATH.G5.N2.")]);
  const re = await e.agent.ask(KID, { question: "What should I review first?", lang: "en", strategy: "curriculum-navigation", verify: {} });
  check("evidence binds claims: ids returned by curriculum.findTopic in this run are accepted", re.kind === "answer" && re.verification.curriculumClaims === "checked");
  const f = agentWith([fin("answer", "I checked it with the calculator: 7 × 8 = 56."), { type: "tool_call", tool: "calculator.evaluate", input: { expression: "7*8" } }, fin("answer", "I checked it with the calculator: 7 × 8 = 56.")]);
  const rf = await f.agent.ask(KID, { question: "What is 7 × 8?", lang: "en", verify: {} });
  check("fabricated evidence: 'checked with the calculator' without a call is sent back; after a real call it passes", rf.kind === "answer" && f.model.calls.length === 3);
  const g = agentWith([fin("hint", "Think about 8 rows of 5."), fin("hint", "How many squares are in one row?")]);
  const rg = await g.agent.ask(KID, { question: "长方形长 8、宽 5，面积多少？", lang: "zh", strategy: "socratic-teaching", verify: {} });
  check("socratic-teaching with verify: a statement is sent back, a guiding question passes", rg.kind === "hint" && g.model.calls.length === 2 && rg.verification.socraticForm === "checked");
  const gz = agentWith([fin("hint", "想一想：每排有 8 个。"), fin("hint", "你能先数一数一排有几个小方块吗？")]);
  const rgz = await gz.agent.ask(KID, { question: "长方形长 8、宽 5，面积多少？", lang: "zh", strategy: "socratic-teaching", verify: {} });
  check("real TutorAgent, Chinese: a statement is sent back, a question ending in ？ passes", rgz.kind === "hint" && rgz.text.endsWith("？") && gz.model.calls.length === 2);
  const h = agentWith([fin("answer", "89 × 89 = 7921.")]);
  const rh = await h.agent.ask(KID, { question: "What is 89 × 89?", lang: "en", verify: { answerKey: KEY } });
  check("answer mode may state the answer (leak rule is hint-only)", rh.kind === "answer" && rh.verification.answerLeak === "not-applicable");
  let touched = false;
  const bads = [{ answerKey: 42 }, { extra: 1 }, null, "x", { get answerKey() { touched = true; return "1"; } }];
  const i = agentWith([]);
  const rs = [];
  for (const v of bads) rs.push(await i.agent.ask(KID, { question: "What is 2 + 2?", lang: "en", verify: v }));
  const getterReq = { question: "What is 2 + 2?", lang: "en" };
  Object.defineProperty(getterReq, "verify", { get() { touched = true; return {}; }, enumerable: true });
  rs.push(await i.agent.ask(KID, getterReq));
  check("invalid verify → INVALID_INPUT before any model call; getters not executed; message is fixed",
    rs.every(x => x.kind === "error" && x.error.code === "INVALID_INPUT" && x.gate.stage === "input" && !/42|extra/.test(x.error.message)) && i.model.calls.length === 0 && i.classifierModel.calls.length === 0 && !touched, rs.map(x => x.error));
  const j = agentWith([fin("answer", "2 + 2 = 4.")]);
  const rj = await j.agent.ask(KID, { question: "What is 2 + 2?", lang: "en", verify: undefined });
  check("verify: undefined is the default path (no verification field)", rj.kind === "answer" && !("verification" in rj));
}

/* ================= 片 C：工作流 ================= */
console.log("workflow postconditions: pure counterexamples");
{
  const L = Object.freeze({ maxRounds: 3, targetCorrect: 2, maxAttempts: 2, maxHints: 2 });
  const base = { phase: "answer", teachMode: null, plan: "explain-concept", round: 1, correct: 0, wrong: 0, uncertain: 0, usedCount: 1, usedDistinct: true, lastUsed: "Q1",
    version: 5, outcome: null, pending: false, question: { questionId: "Q1", attempts: 0, hints: 0, lastAttemptId: null }, evaluation: null, evalAttemptId: null, limits: L };
  const S = (from, over) => Object.assign(JSON.parse(J(from)), { limits: L }, over);
  const info = (command, extra) => Object.assign({ workflowId: "W", command, ok: true, attemptId: null, replyKind: null }, extra);
  const cats = r => r.violations.map(v => v.category);
  const submitted = S(base, { phase: "evaluate", version: 7, question: { questionId: "Q1", attempts: 1, hints: 0, lastAttemptId: "W.q1.a1" }, evalAttemptId: "W.q1.a1" });
  const graded = S(submitted, { phase: "adapt", version: 9, correct: 1, evaluation: { attemptId: "W.q1.a1", outcome: "correct", mistake: null }, evalAttemptId: null });
  const next = S(graded, { phase: "practice", version: 10, question: null });
  const valid = [
    verifyStep(base, submitted, info("submit", { attemptId: "W.q1.a1" })),
    verifyStep(submitted, graded, info("evaluate", { attemptId: "W.q1.a1" })),
    verifyStep(graded, next, info("adapt")),
    verifyStep(base, S(base, { version: 7, question: { questionId: "Q1", attempts: 0, hints: 1, lastAttemptId: null } }), info("hint", { replyKind: "hint" })),
    verifyStep(next, S(next, { phase: "answer", version: 11, round: 2, usedCount: 2, lastUsed: "Q2", evaluation: null, question: { questionId: "Q2", attempts: 0, hints: 0, lastAttemptId: null } }), info("practice")),
    verifyStep(base, S(base, { version: 6, pending: true }), info("submit", { ok: false })),
  ];
  check("valid steps (submit, evaluate, adapt, hint, practice, failure with pending) pass", valid.every(r => r.ok && Object.isFrozen(r)), valid.map(r => r.violations));
  const bad = [
    ["transition: command out of order (evaluate from answer)", verifyStep(base, submitted, info("evaluate", { attemptId: "W.q1.a1" })), "transition"],
    ["transition: version did not advance", verifyStep(base, S(submitted, { version: 5 }), info("submit", { attemptId: "W.q1.a1" })), "transition"],
    ["transition: failed step moved on", verifyStep(base, submitted, info("submit", { ok: false })), "transition"],
    ["counters: hint changed correct", verifyStep(base, S(base, { version: 7, correct: 1, question: { questionId: "Q1", attempts: 0, hints: 1, lastAttemptId: null } }), info("hint", { replyKind: "hint" })), "counters"],
    ["counters: evaluate counted wrong for a correct grade", verifyStep(submitted, S(graded, { correct: 0, wrong: 1 }), info("evaluate", { attemptId: "W.q1.a1" })), "counters"],
    ["counters: hints over the limit", verifyStep(base, S(base, { version: 7, question: { questionId: "Q1", attempts: 0, hints: 3, lastAttemptId: null } }), info("hint", { replyKind: "hint" })), "counters"],
    ["association: attempt id does not follow the round/attempt", verifyStep(base, S(submitted, { question: { questionId: "Q1", attempts: 1, hints: 0, lastAttemptId: "W.q1.a2" }, evalAttemptId: "W.q1.a2" }), info("submit", { attemptId: "W.q1.a2" })), "association"],
    ["association: grade attached to another attempt", verifyStep(submitted, S(graded, { evaluation: { attemptId: "W.q0.a1", outcome: "correct", mistake: null } }), info("evaluate", { attemptId: "W.q1.a1" })), "association"],
    ["association: mistake with a correct grade", verifyStep(submitted, S(graded, { evaluation: { attemptId: "W.q1.a1", outcome: "correct", mistake: "concept" } }), info("evaluate", { attemptId: "W.q1.a1" })), "association"],
    ["association: practice reused a question", verifyStep(next, S(next, { phase: "answer", version: 11, round: 2, usedCount: 2, usedDistinct: false, lastUsed: "Q1", question: { questionId: "Q1", attempts: 0, hints: 0, lastAttemptId: null } }), info("practice")), "association"],
    ["association: hint reply missing", verifyStep(base, S(base, { version: 7, question: { questionId: "Q1", attempts: 0, hints: 1, lastAttemptId: null } }), info("hint")), "association"],
    ["completion: goal-reached below target", verifyStep(graded, S(graded, { phase: "done", version: 10, question: null, outcome: "goal-reached" }), info("adapt")), "completion"],
    ["completion: target reached but workflow continues", verifyStep(S(graded, { correct: 2 }), S(next, { correct: 2 }), info("adapt")), "completion"],
    ["completion: round-limit with rounds left", verifyStep(graded, S(graded, { phase: "done", version: 10, question: null, outcome: "round-limit" }), info("adapt")), "completion"],
    ["completion: done without an outcome", verifyStep(graded, S(graded, { phase: "done", version: 10, question: null }), info("adapt")), "completion"],
    ["completion: wrong with attempts left must retry, not move on", verifyStep(S(graded, { correct: 0, wrong: 1, evaluation: { attemptId: "W.q1.a1", outcome: "wrong", mistake: null } }),
      S(next, { correct: 0, wrong: 1, evaluation: { attemptId: "W.q1.a1", outcome: "wrong", mistake: null } }), info("adapt")), "completion"],
  ];
  for (const [name, r, cat] of bad) check(name, !r.ok && cats(r).includes(cat), r.violations);
  const junk = verifyStep(null, null, info("adapt"));
  check("unreadable snapshots → a 'state' violation, never a throw", !junk.ok && cats(junk).includes("state"));
  check("violations carry only fixed category / rule ids", bad.every(([, r]) => r.violations.every(v => Object.keys(v).join() === "category,rule" && /^[a-z-]+(:[A-Za-z]+)?$/.test(v.rule))));
  /* 字段保持：每个命令只许改它自己的字段，其余（尤其题目的尝试数 / 提示数 / 最近 attemptId）必须原样 */
  const wrongGraded = S(graded, { correct: 0, wrong: 1, evaluation: { attemptId: "W.q1.a1", outcome: "wrong", mistake: null } });
  const remediate = S(wrongGraded, { phase: "teach", teachMode: "remediate", version: 10 });
  const hinted = S(base, { version: 7, question: { questionId: "Q1", attempts: 0, hints: 1, lastAttemptId: null } });
  const retried = S(wrongGraded, { phase: "answer", version: 11 });   // 答错、remediate 之后回到同一题
  const preserve = [
    ["adapt → remediate resets the attempt count / last attempt", verifyStep(wrongGraded, S(remediate, { question: { questionId: "Q1", attempts: 0, hints: 0, lastAttemptId: null } }), info("adapt"))],
    ["a failed hint rebinds the last attempt to another workflow's attempt", verifyStep(submitted, S(submitted, { version: 8, pending: true, question: { questionId: "Q1", attempts: 1, hints: 0, lastAttemptId: "OTHER.q1.a1" } }), info("hint", { ok: false }))],
    ["a successful evaluate also changes the hint count", verifyStep(submitted, S(graded, { question: { questionId: "Q1", attempts: 1, hints: 1, lastAttemptId: "W.q1.a1" } }), info("evaluate", { attemptId: "W.q1.a1" }))],
    ["a successful hint swaps the last attempt id", verifyStep(retried, S(retried, { version: 12, question: { questionId: "Q1", attempts: 1, hints: 1, lastAttemptId: "W.q1.a9" } }), info("hint", { replyKind: "hint" }))],
    ["a hint changes the plan", verifyStep(base, S(hinted, { plan: "socratic-teaching" }), info("hint", { replyKind: "hint" }))],
    ["a failed step changes the limits", verifyStep(base, S(base, { limits: Object.assign({}, L, { maxHints: 5 }) }), info("hint", { ok: false }))],
  ];
  for (const [name, r] of preserve) check("preservation: " + name, !r.ok, r.violations);
  const validPaths = [
    verifyStep(submitted, wrongGraded, info("evaluate", { attemptId: "W.q1.a1" })),
    verifyStep(submitted, S(graded, { correct: 0, uncertain: 1, evaluation: { attemptId: "W.q1.a1", outcome: "uncertain", mistake: null } }), info("evaluate", { attemptId: "W.q1.a1" })),
    verifyStep(submitted, S(wrongGraded, { evaluation: { attemptId: "W.q1.a1", outcome: "wrong", mistake: "calculation" } }), info("evaluate", { attemptId: "W.q1.a1" })),
    verifyStep(wrongGraded, remediate, info("adapt")),
    verifyStep(remediate, S(remediate, { phase: "answer", teachMode: null, version: 11 }), info("teach", { replyKind: "hint" })),
    verifyStep(retried, S(retried, { phase: "evaluate", version: 13, evaluation: null,
      question: { questionId: "Q1", attempts: 2, hints: 0, lastAttemptId: "W.q1.a2" }, evalAttemptId: "W.q1.a2" }), info("submit", { attemptId: "W.q1.a2" })),
    verifyStep(submitted, S(submitted, { version: 8, pending: true }), info("evaluate", { ok: false })),
  ];
  check("valid wrong / uncertain / wrong-with-mistake grades, adapt → remediate, remediation, second attempt and a failed evaluate with pending all pass",
    validPaths.every(r => r.ok), validPaths.map(r => r.violations));
}

/* ---------------- 真实工作流 + memory + 回放 TutorAgent + 确定性 grader ---------------- */
const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), "yy-verify-"));
const R = Object.freeze({ userId: "user-secret-7", kidId: "kid-secret-3", role: "student" });
const EN = { topicId: "BC.MATH.G3.ADD2D", title: "Two-digit addition", goal: "Add two-digit numbers with regrouping", lang: "en", maxRounds: 2, targetCorrect: 1, maxAttempts: 2 };
const LESSON = () => fin("answer", "Add the ones, then the tens. Example: 12 + 13 = 25.", [{ expression: "12+13", value: 25 }]);
async function world(o = {}) {
  const root = await fsp.mkdtemp(path.join(tmpBase, "w-"));
  const memory = createMemory({ store: createFileStore({ rootDir: root }) });
  const model = createReplayModel(o.tutor || []), classifierModel = createReplayModel(Array(o.classify || 0).fill(MATHL));
  const agent = o.fakeTutor || createTutorAgent({ registry, model, classifierModel, onTrace: () => {} });
  const qs = (o.questions || []).slice();
  const x = { root, memory, model, traces: [], results: [], graderCalls: [] };
  const inner = createAnswerGrader();
  const grader = { grade: req => { x.graderCalls.push(req); return inner.grade(req); } };
  x.wf = createTutorWorkflow({ tutor: agent, memory, practice: { next: () => (qs.length ? qs.shift() : Promise.reject(new Error("none"))) }, grader, onTrace: t => x.traces.push(t), adapterTimeoutMs: 500 });
  let n = 0;
  x.send = async (id, cmd) => { const r = await x.wf.send(R, id, Object.assign({ commandId: "c" + (++n) }, cmd)); x.results.push(r); return r; };
  x.start = extra => x.wf.start(R, Object.assign({ commandId: "s" + (++n) }, EN, extra));
  x.types = async () => (await memory.getEvents(R)).map(e => e.type);
  x.modelText = () => J([...model.calls, ...classifierModel.calls].map(r => ({ system: r.system, messages: r.messages })));
  x.disk = async () => { const out = []; for (const f of (await fsp.readdir(root)).filter(f => f.endsWith(".json"))) out.push(await fsp.readFile(path.join(root, f), "utf8")); return out; };
  return x;
}
const Q = (id, prompt, answerKey) => ({ questionId: id, topicId: EN.topicId, prompt, answerKey });

try {
  console.log("integration: correct path with the deterministic grader");
  {
    const x = await world({ classify: 1, tutor: [LESSON()], questions: [Q("q1", "What is 23 + 19?", "42")] });
    const v = await x.start();
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    await x.send(v.workflowId, { type: "submit", questionId: "q1", answer: "42" });
    const e = await x.send(v.workflowId, { type: "evaluate" });
    const d = await x.send(v.workflowId, { type: "adapt" });
    check("42 vs key 42 → correct → goal reached (completed), every step passed its postconditions", e.ok && e.view.evaluation.outcome === "correct" && d.view.status === "completed" && d.view.outcome === "goal-reached" &&
      x.results.every(r => r.ok));
    check("events: concept_explained, question_attempt, answer_correct; never topic_mastered", J(await x.types()) === J(["concept_explained", "question_attempt", "answer_correct"]));
    check("the lesson request carried a local verify context that never reached the model", x.model.calls.length === 1 && !x.modelText().includes("BC.MATH.G3") && !x.modelText().includes("verify"));
  }

  console.log("integration: wrong → diagnose-error remediation → correct");
  {
    const x = await world({ classify: 2, tutor: [LESSON(), fin("hint", "Look at the ones: 3 + 9 is more than 10. What do you carry?", [{ expression: "3+9", value: 12 }])], questions: [Q("q1", "What is 23 + 19?", "42")] });
    const v = await x.start();
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    await x.send(v.workflowId, { type: "submit", questionId: "q1", answer: "32" });
    const e = await x.send(v.workflowId, { type: "evaluate" });
    check("32 vs 42 → wrong with no invented mistake category", e.ok && e.view.evaluation.outcome === "wrong" && !("mistake" in e.view.evaluation));
    await x.send(v.workflowId, { type: "adapt" });
    const t = await x.send(v.workflowId, { type: "teach" });
    await x.send(v.workflowId, { type: "submit", questionId: "q1", answer: " 42 " });
    await x.send(v.workflowId, { type: "evaluate" });
    const d = await x.send(v.workflowId, { type: "adapt" });
    const events = await x.memory.getEvents(R);
    check("remediation hint passes (no leak), retry correct → completed", t.ok && t.reply.kind === "hint" && d.view.status === "completed" && x.results.every(r => r.ok));
    check("answer_wrong on disk has no mistake field", events.filter(e => e.type === "answer_wrong").every(e => !("mistake" in e)) &&
      J(events.map(e => e.type)) === J(["concept_explained", "question_attempt", "answer_wrong", "question_attempt", "answer_correct"]));
    const disk = (await x.disk()).join("");
    check("on disk: no prompt, answers or key", !/23 \+ 19|"32"|"42"/.test(disk));
    check("model requests: no key, no owner ids, no topic id, no verify context", !/user-secret|kid-secret|BC\.MATH\.G3|answerKey|verify/.test(x.modelText()));
    check("traces carry no answers or key", !/"42"|"32"|answerKey/.test(J(x.traces)));
  }

  console.log("integration: uncertain answers are never counted right or wrong");
  {
    const x = await world({ classify: 1, tutor: [LESSON()], questions: [Q("q1", "What is 23 + 19?", "42"), Q("q2", "What is 1/4 + 1/4?", "1/2")], });
    const v = await x.start();
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    await x.send(v.workflowId, { type: "submit", questionId: "q1", answer: "forty-two" });
    const e1 = await x.send(v.workflowId, { type: "evaluate" });
    await x.send(v.workflowId, { type: "adapt" });
    await x.send(v.workflowId, { type: "practice" });
    await x.send(v.workflowId, { type: "submit", questionId: "q2", answer: "2/4" });
    const e2 = await x.send(v.workflowId, { type: "evaluate" });
    const d = await x.send(v.workflowId, { type: "adapt" });
    const sm = await x.memory.getStudentMemory(R);
    check("unsupported answer and equivalent-but-different form → uncertain; no result events; attempts stay unsettled",
      e1.view.evaluation.outcome === "uncertain" && e2.view.evaluation.outcome === "uncertain" && d.view.uncertain === 2 && d.view.correct === 0 && d.view.wrong === 0 &&
      sm.topics[0].unsettled === 2 && sm.topics[0].correct === 0 && sm.topics[0].wrong === 0 && d.view.status === "ended" && d.view.outcome === "round-limit");
  }

  console.log("integration: hint leak is blocked before it reaches the child");
  {
    const leak = fin("hint", "23 + 19 = 42");
    const x = await world({ classify: 3, tutor: [LESSON(), leak, leak, leak, fin("hint", "Add the ones first: 3 + 9 = 12. What do you write and what do you carry?", [{ expression: "3+9", value: 12 }])],
      questions: [Q("q1", "What is 23 + 19?", "42")] });
    const v = await x.start();
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    const hint = { type: "hint", questionId: "q1", commandId: "h1" };
    const h1 = await x.wf.send(R, v.workflowId, hint);
    check("TutorAgent sends the leaking hint back (bounded retries) → TUTOR_ERROR with the fixed error template, no hint event",
      !h1.ok && h1.code === "TUTOR_ERROR" && h1.reply.text === TEXTS.en.error && J(await x.types()) === J(["concept_explained"]) && !J(h1).includes("= 42"));
    const h2 = await x.wf.send(R, v.workflowId, hint);
    check("resending the same command asks again; a non-leaking hint is shown and recorded once", h2.ok && h2.reply.text.startsWith("Add the ones") && (await x.types()).filter(t => t === "hint_requested").length === 1);
    check("the model never received the key as data (only its own leaked text, which was rejected)", !/answerKey|verify/.test(x.modelText()) && !x.modelText().includes("\"42\""));
  }

  console.log("integration: local re-check when the injected tutor is not the real TutorAgent");
  {
    const fake = { ask: (ctx, req) => ({ ok: true, kind: req.mode === "hint" ? "hint" : "answer", text: req.mode === "hint" ? "The answer is 42." : "Lesson: 2 + 2 = 5." }) };
    const x = await world({ fakeTutor: fake, questions: [Q("q1", "What is 23 + 19?", "42")] });
    const v = await x.start();
    await x.send(v.workflowId, { type: "diagnose" });
    const t = await x.send(v.workflowId, { type: "teach" });
    check("a false equation in a lesson → TUTOR_ERROR / VERIFICATION, no concept_explained", !t.ok && t.code === "TUTOR_ERROR" && t.detail === "VERIFICATION" && (await x.types()).length === 0 && t.reply.text === TEXTS.en.error);
  }
  {
    const fake = { ask: (ctx, req) => ({ ok: true, kind: req.mode === "hint" ? "hint" : "answer", text: req.mode === "hint" ? "The answer is 42." : "Lesson: 2 + 2 = 4." }) };
    const x = await world({ fakeTutor: fake, questions: [Q("q1", "What is 23 + 19?", "42")] });
    const v = await x.start();
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    const h = await x.send(v.workflowId, { type: "hint", questionId: "q1" });
    check("'The answer is 42' from an injected tutor → TUTOR_ERROR / VERIFICATION, no hint event, still answerable", !h.ok && h.detail === "VERIFICATION" && h.view.phase === "answer" &&
      !(await x.types()).includes("hint_requested") && h.reply.text === TEXTS.en.error && !J(h.reply).includes("42"));
  }

  console.log("integration: socratic form is enforced by the workflow's local re-check too");
  {
    let text = "Take 3 away from both sides.";
    const fake = { ask: () => ({ ok: true, kind: "hint", text }) };
    const x = await world({ fakeTutor: fake });
    await x.memory.appendEvent(R, { eventId: "h1", type: "question_attempt", topicId: EN.topicId, attemptId: "old-1" });
    await x.memory.appendEvent(R, { eventId: "h2", type: "answer_correct", topicId: EN.topicId, attemptId: "old-1" });
    const v = await x.start();
    const d = await x.send(v.workflowId, { type: "diagnose" });
    const bad = await x.send(v.workflowId, { type: "teach" });
    text = "What could you take away from both sides?";
    const good = await x.send(v.workflowId, { type: "teach" });
    check("injected tutor: a socratic lesson that is not a question → TUTOR_ERROR / VERIFICATION and stays in teach; a question advances",
      d.view.plan.strategy === "socratic-teaching" && !bad.ok && bad.detail === "VERIFICATION" && bad.view.phase === "teach" && good.ok && good.view.phase === "practice");
  }
  {
    const x = await world({ classify: 1, tutor: [fin("hint", "想一想：一排有几个小方块？一共有几排？")] });
    await x.memory.appendEvent(R, { eventId: "h1", type: "question_attempt", topicId: EN.topicId, attemptId: "old-1" });
    await x.memory.appendEvent(R, { eventId: "h2", type: "answer_correct", topicId: EN.topicId, attemptId: "old-1" });
    const v = await x.wf.start(R, Object.assign({ commandId: "zh-start" }, EN, { lang: "zh", title: "两位数加法", goal: "会做进位加法" }));
    await x.send(v.workflowId, { type: "diagnose" });
    const t = await x.send(v.workflowId, { type: "teach" });
    check("real TutorAgent + workflow, Chinese socratic lesson with ？ passes both checks", t.ok && t.reply.kind === "hint" && t.reply.text.endsWith("？") && t.view.phase === "practice");
  }

  console.log("integration: a postcondition failure is not published as success");
  {
    const orig = machine.decideAdapt;
    const x = await world({ classify: 1, tutor: [LESSON()], questions: [Q("q1", "What is 23 + 19?", "42"), Q("q2", "What is 1 + 1?", "2")] });
    const v = await x.start({ targetCorrect: 2 });
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    await x.send(v.workflowId, { type: "submit", questionId: "q1", answer: "42" });
    await x.send(v.workflowId, { type: "evaluate" });
    machine.decideAdapt = () => Object.freeze({ phase: "done", outcome: "goal-reached", reason: "goal-reached" });   // 模拟有 bug 的决策：1 对就宣称达标（目标 2）
    let r;
    try { r = await x.send(v.workflowId, { type: "adapt" }); } finally { machine.decideAdapt = orig; }
    check("buggy adapt claiming goal-reached with 1/2 correct → INVARIANT_FAILED / COMPLETION, status failed, outcome null (no completion claimed)",
      !r.ok && r.code === "INVARIANT_FAILED" && r.detail === "COMPLETION" && r.view.status === "failed" && r.view.outcome === null && r.view.allowed.length === 0 && r.reply === null);
    let gone = "";
    try { await x.wf.get(R, v.workflowId); } catch (e) { gone = e.code; }
    check("the failed workflow is removed (get → NOT_FOUND); committed events stay as they were; no topic_mastered", gone === "NOT_FOUND" &&
      J(await x.types()) === J(["concept_explained", "question_attempt", "answer_correct"]));
    check("trace records the failure without text", x.traces.some(t => t.code === "INVARIANT_FAILED" && t.command === "adapt") && !/"42"/.test(J(x.traces)));
  }
  {
    const orig = machine.decideAdapt;
    const x = await world({ classify: 1, tutor: [LESSON()], questions: [Q("q1", "What is 23 + 19?", "42")] });
    const v = await x.start({ targetCorrect: 2 });
    for (const t of ["diagnose", "teach", "practice"]) await x.send(v.workflowId, { type: t });
    await x.send(v.workflowId, { type: "submit", questionId: "q1", answer: "42" });
    await x.send(v.workflowId, { type: "evaluate" });
    machine.decideAdapt = () => Object.freeze({ phase: "evaluate", reason: "bogus" });   // 非法转换
    let r;
    try { r = await x.send(v.workflowId, { type: "adapt" }); } finally { machine.decideAdapt = orig; }
    check("an illegal transition (adapt → evaluate) → INVARIANT_FAILED, not cached as success", !r.ok && r.code === "INVARIANT_FAILED" && ["TRANSITION", "ASSOCIATION", "COMPLETION", "STATE"].includes(r.detail));
  }
} finally {
  await fsp.rm(tmpBase, { recursive: true, force: true });
}

await new Promise(r => setTimeout(r, 50));
check("no action was ever called", actionCalls.length === 0, actionCalls);
check("no unhandled rejections", unhandled.length === 0, unhandled.map(String));
process.exit(summary() ? 0 : 1);
