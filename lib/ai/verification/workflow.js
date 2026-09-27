/*
 * 工作流步骤后置条件（#38，#19 Phase 7）。纯函数、零依赖、无 I/O；不 require 工作流本身，也不复用 machine.decideAdapt——
 * 这里按文档里的规则独立重算一遍，工作流的实现和这份检查互相印证。
 *
 *   verifyStep(before, after, info) → 冻结 { ok, violations:[{ category, rule }] }
 *     before / after：步骤前后的状态快照（形状见 SNAPSHOT，工作流在步骤开始前同步取 before，发布结果前取 after）
 *     info = { workflowId, command, ok, attemptId: string|null, replyKind: string|null }
 *   category ∈ state（快照本身不自洽）/ transition（阶段 / 版本）/ counters（计数增量）/ association（题目–尝试–评分关联）/ completion（结束条件）
 *   rule 是固定的短标识，不含任何文本、答案或身份。
 *
 * SNAPSHOT = { phase, teachMode, plan, round, correct, wrong, uncertain, usedCount, usedDistinct, lastUsed, version, outcome, pending,
 *              question: null | { questionId, attempts, hints, lastAttemptId }, evaluation: null | { attemptId, outcome, mistake },
 *              evalAttemptId, limits: { maxRounds, targetCorrect, maxAttempts, maxHints } }
 */
"use strict";

const PHASES = ["diagnose", "teach", "practice", "answer", "evaluate", "adapt", "done"];
const PLANS = ["explain-concept", "socratic-teaching"];
/* 命令 → 允许的起始阶段 → 成功后的阶段 */
const MOVES = {
  diagnose: { diagnose: ["teach"] },
  teach: { teach: ["practice", "answer"] },
  practice: { practice: ["answer"] },
  hint: { answer: ["answer"] },
  submit: { answer: ["evaluate"] },
  evaluate: { evaluate: ["adapt"] },
  adapt: { adapt: ["teach", "practice", "done"] },
};
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const count = v => Number.isSafeInteger(v) && v >= 0;
const sameQuestion = (a, b) => !!a && !!b && a.questionId === b.questionId;

/* 快照本身：任何时刻都应成立的不变量 */
function stateRules(s, add) {
  const L = s.limits;
  if (!PHASES.includes(s.phase)) return add("state", "phase");
  if (![s.round, s.correct, s.wrong, s.uncertain, s.usedCount, s.version].every(count)) return add("state", "counts");
  if (s.round > L.maxRounds) add("counters", "round-limit");
  if (s.usedCount !== s.round || !s.usedDistinct) add("association", "used-questions");
  if (s.phase === "diagnose" ? s.plan !== null : !PLANS.includes(s.plan)) add("state", "plan");
  if (s.phase === "teach" ? !["lesson", "remediate"].includes(s.teachMode) : s.teachMode !== null) add("state", "teach-mode");
  const needsQuestion = ["answer", "evaluate", "adapt"].includes(s.phase) || (s.phase === "teach" && s.teachMode === "remediate");
  if (needsQuestion !== (s.question !== null)) add("association", "question-presence");
  if (s.question) {
    const q = s.question;
    if (q.questionId !== s.lastUsed) add("association", "question-not-current");
    if (!count(q.attempts) || q.attempts > L.maxAttempts || !count(q.hints) || q.hints > L.maxHints) add("counters", "question-limits");
    if ((q.attempts === 0) !== (q.lastAttemptId === null)) add("association", "last-attempt");
  }
  if (s.phase === "evaluate" && !(s.question && s.evalAttemptId !== null && s.evalAttemptId === s.question.lastAttemptId)) add("association", "evaluating-attempt");
  if (s.phase !== "evaluate" && s.evalAttemptId !== null && !s.pending) add("association", "stale-evaluating-attempt");
  if (s.phase === "adapt" && !(s.evaluation && s.question && s.evaluation.attemptId === s.question.lastAttemptId)) add("association", "evaluation-attempt");
  if (s.evaluation && s.evaluation.mistake !== null && s.evaluation.outcome !== "wrong") add("association", "mistake-outcome");
  /* 结束条件：done ⇔ 有 outcome；goal-reached 必须真的达标；round-limit 必须轮数用完且未达标；达标后只能停在 adapt（等决策）或 done */
  if ((s.phase === "done") !== (s.outcome !== null)) add("completion", "done-outcome");
  if (s.outcome === "goal-reached" && s.correct < L.targetCorrect) add("completion", "goal-not-reached");
  if (s.outcome === "round-limit" && (s.round < L.maxRounds || s.correct >= L.targetCorrect)) add("completion", "round-limit-early");
  if (s.outcome !== null && s.outcome !== "goal-reached" && s.outcome !== "round-limit") add("completion", "outcome");
  if (s.correct >= L.targetCorrect && s.phase !== "adapt" && s.phase !== "done") add("completion", "goal-not-closed");
}

/* Adapt 的期望去向：只看 before 的评分和计数 */
function expectedAdapt(b) {
  const L = b.limits;
  if (b.correct >= L.targetCorrect) return { phase: "done", outcome: "goal-reached" };
  if (b.evaluation.outcome === "wrong" && b.question.attempts < L.maxAttempts) return { phase: "teach", teachMode: "remediate" };
  if (b.round < L.maxRounds) return { phase: "practice" };
  return { phase: "done", outcome: "round-limit" };
}

/* 每个命令成功时**允许**变的字段；没列出的一律必须与步骤前逐字相同（失败时除 pending / version 外什么都不许变）。
 * question 的取值：省略 = 整道题（id、尝试数、提示数、最近 attemptId）不变；字段数组 = 同一道题、只有这些字段可变；
 * "replace" = 换成新题（practice）；"clear-or-keep" = 清空或原样保留（adapt） */
const MAY_CHANGE = {
  diagnose: { phase: 1, teachMode: 1, plan: 1 },
  teach: { phase: 1, teachMode: 1 },
  practice: { phase: 1, round: 1, usedCount: 1, usedDistinct: 1, lastUsed: 1, evaluation: 1, question: "replace" },
  hint: { question: ["hints"] },
  submit: { phase: 1, evaluation: 1, evalAttemptId: 1, question: ["attempts", "lastAttemptId"] },
  evaluate: { phase: 1, correct: 1, wrong: 1, uncertain: 1, evaluation: 1, evalAttemptId: 1 },
  adapt: { phase: 1, teachMode: 1, outcome: 1, question: "clear-or-keep" },
};
const FIELD_CATEGORY = {
  phase: "transition", teachMode: "transition", plan: "state", limits: "state",
  round: "counters", correct: "counters", wrong: "counters", uncertain: "counters", usedCount: "counters",
  usedDistinct: "association", lastUsed: "association", evaluation: "association", evalAttemptId: "association", outcome: "completion",
};
const Q_FIELDS = ["questionId", "attempts", "hints", "lastAttemptId"];
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
function preservation(b, a, may, add) {
  for (const f of Object.keys(FIELD_CATEGORY)) if (!hasOwn(may, f) && !same(b[f], a[f])) add(FIELD_CATEGORY[f], "unexpected-change:" + f);
  const q = hasOwn(may, "question") ? may.question : null;
  if (q === "replace") return;
  if (q === "clear-or-keep") { if (a.question !== null && !same(b.question, a.question)) add("association", "unexpected-change:question"); return; }
  if (Array.isArray(q)) {
    if (!b.question || !a.question || Q_FIELDS.some(k => !q.includes(k) && b.question[k] !== a.question[k])) add("association", "unexpected-change:question");
    return;
  }
  if (!same(b.question, a.question)) add("association", "unexpected-change:question");
}

function successRules(b, a, info, add) {
  const cmd = info.command;
  const from = hasOwn(MOVES, cmd) && hasOwn(MOVES[cmd], b.phase) ? MOVES[cmd][b.phase] : null;
  if (!from || !from.includes(a.phase)) add("transition", "phase");
  if (!(a.version > b.version)) add("transition", "version");
  if (a.pending) add("state", "pending-after-success");
  if (hasOwn(MAY_CHANGE, cmd)) preservation(b, a, MAY_CHANGE[cmd], add);
  const d = { correct: a.correct - b.correct, wrong: a.wrong - b.wrong, uncertain: a.uncertain - b.uncertain, round: a.round - b.round };
  const expectDelta = { correct: 0, wrong: 0, uncertain: 0, round: 0 };
  if (cmd === "practice") expectDelta.round = 1;
  if (cmd === "evaluate" && a.evaluation && hasOwn(expectDelta, a.evaluation.outcome)) expectDelta[a.evaluation.outcome] = 1;
  if (cmd === "evaluate" && !(a.evaluation && ["correct", "wrong", "uncertain"].includes(a.evaluation.outcome))) add("association", "evaluation-missing");
  if (Object.keys(expectDelta).some(k => d[k] !== expectDelta[k])) add("counters", "delta");
  if (a.outcome !== b.outcome && cmd !== "adapt") add("completion", "outcome-changed");

  const bq = b.question, aq = a.question;
  const expectReply = cmd === "teach" ? (b.teachMode === "lesson" && b.plan === "explain-concept" ? "answer" : "hint") : cmd === "hint" ? "hint" : null;
  if (info.replyKind !== expectReply) add("association", "reply-kind");
  switch (cmd) {
    case "diagnose":
      if (a.teachMode !== "lesson") add("transition", "lesson");
      break;
    case "teach":
      if (b.teachMode === "lesson" && a.phase !== "practice") add("transition", "lesson-next");
      if (b.teachMode === "remediate" && (a.phase !== "answer" || !sameQuestion(bq, aq) || aq.attempts !== bq.attempts || aq.hints !== bq.hints)) add("association", "remediate-question");
      break;
    case "practice":
      if (!aq || aq.attempts !== 0 || aq.hints !== 0 || aq.lastAttemptId !== null || a.usedCount !== b.usedCount + 1 || aq.questionId === b.lastUsed || a.evaluation !== null) add("association", "new-question");
      break;
    case "hint":
      if (!sameQuestion(bq, aq) || aq.hints !== bq.hints + 1 || aq.attempts !== bq.attempts) add("association", "hint-question");
      break;
    case "submit": {
      const id = `${info.workflowId}.q${b.round}.a${bq ? bq.attempts + 1 : 0}`;
      if (!sameQuestion(bq, aq) || aq.attempts !== bq.attempts + 1 || aq.hints !== bq.hints || aq.lastAttemptId !== id || info.attemptId !== id || a.evalAttemptId !== id) add("association", "attempt");
      break;
    }
    case "evaluate":
      if (!sameQuestion(bq, aq) || aq.attempts !== bq.attempts || !a.evaluation || a.evaluation.attemptId !== b.evalAttemptId || info.attemptId !== b.evalAttemptId || a.evalAttemptId !== null) add("association", "graded-attempt");
      break;
    case "adapt": {
      if (!b.evaluation || !bq) { add("association", "adapt-without-evaluation"); break; }
      const e = expectedAdapt(b);
      if (a.phase !== e.phase || (e.teachMode && a.teachMode !== e.teachMode) || (a.phase === "done" && a.outcome !== e.outcome)) add("completion", "adapt-decision");
      if (a.phase === "teach" && !sameQuestion(bq, aq)) add("association", "retry-question");
      if ((a.phase === "practice" || a.phase === "done") && aq !== null) add("association", "question-not-cleared");
      break;
    }
  }
}

/* 失败的步骤：除 pending 和 version（只能不减）外，任何字段都不许变——不前进、不改计数、不换题或尝试绑定、不改评分和结束状态 */
function failureRules(b, a, add) {
  preservation(b, a, {}, add);
  if (a.version < b.version) add("transition", "version");
}

function verifyStep(before, after, info) {
  const violations = [];
  const add = (category, rule) => { if (!violations.some(v => v.category === category && v.rule === rule)) violations.push(Object.freeze({ category, rule })); };
  try {
    stateRules(after, add);
    if (info.ok === true) successRules(before, after, info, add);
    else failureRules(before, after, add);
  } catch (_) {
    add("state", "unreadable");   // 快照形状不对：按违反处理，不抛
  }
  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
}

const CATEGORIES = Object.freeze(["state", "transition", "counters", "association", "completion"]);
module.exports = { verifyStep, CATEGORIES };
