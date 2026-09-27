/*
 * 辅导工作流的纯状态机（#36，#19 Phase 6）：阶段表、命令表、命令 / 启动参数校验、Diagnose 策略选择、Adapt 决策。
 * 零依赖、无 I/O、无时钟；外层服务（index.js）只按这里的表转换阶段，模型产出的文字从不参与这些决定。
 *
 *   phase：diagnose → teach → practice → answer → evaluate → adapt → (teach | answer | practice | done)
 *   stage（对外的生命周期名）：Diagnose / Teach / Practice（practice + answer）/ Evaluate / Adapt / Done
 */
"use strict";

const { WorkflowError, readPlain, hasOwn } = require("./errors.js");
const { isEventId, isTopicId } = require("../memory/events.js");

const PHASES = Object.freeze(["diagnose", "teach", "practice", "answer", "evaluate", "adapt", "done"]);
const COMMANDS = Object.freeze(["diagnose", "teach", "practice", "hint", "submit", "evaluate", "adapt"]);
const ALLOWED = Object.freeze({
  diagnose: Object.freeze(["diagnose"]),
  teach: Object.freeze(["teach"]),
  practice: Object.freeze(["practice"]),
  answer: Object.freeze(["hint", "submit"]),
  evaluate: Object.freeze(["evaluate"]),
  adapt: Object.freeze(["adapt"]),
  done: Object.freeze([]),
});
const STAGE_OF = Object.freeze({ diagnose: "diagnose", teach: "teach", practice: "practice", answer: "practice", evaluate: "evaluate", adapt: "adapt", done: "done" });

/* 只查自有键：__proto__ / toString 之类的名字不会从原型链上「允许」出来 */
const commandAllowed = (phase, type) => typeof phase === "string" && hasOwn(ALLOWED, phase) && ALLOWED[phase].includes(type);

/* ---------------- 文本与标识 ---------------- */
/* 1–max 个字符、去空白后非空、除 \t \n \r 外没有控制字符；只收原始字符串 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max && v.trim().length > 0 && !CONTROL_RE.test(v);
const LIMITS = Object.freeze({ title: 120, goal: 300, answer: 500, prompt: 1000, answerKey: 200 });
const LANGS = Object.freeze(["zh", "en"]);

/* ---------------- 命令 ---------------- */
const CMD_SPEC = {
  diagnose: {}, teach: {}, practice: {}, evaluate: {}, adapt: {},
  hint: { questionId: "R" },
  submit: { questionId: "R", answer: "R" },
};
const CMD_KEYS = ["type", "commandId", "expectedVersion", "questionId", "answer"];
const CMD_FIELD_OK = {
  questionId: isEventId,
  answer: v => isText(v, LIMITS.answer),
};

/* → 冻结的规范命令（固定键序）；不合法抛 INVALID_INPUT。每个字段只读一次，之后调用方改原对象不影响 */
function readCommand(cmd) {
  const c = readPlain(cmd, CMD_KEYS, "INVALID_INPUT", "command");
  const bad = msg => new WorkflowError("INVALID_INPUT", "command: " + msg);
  if (typeof c.type !== "string" || !COMMANDS.includes(c.type)) throw bad("type must be one of " + COMMANDS.join(", "));
  const spec = CMD_SPEC[c.type];
  if (!isEventId(c.commandId)) throw bad("commandId must be 1–64 characters: letters, digits and . _ : - (starting with a letter or digit)");
  if ("expectedVersion" in c && !(Number.isSafeInteger(c.expectedVersion) && c.expectedVersion >= 0)) throw bad("expectedVersion must be a non-negative integer");
  for (const k of Object.keys(c)) if (!["type", "commandId", "expectedVersion"].includes(k) && !hasOwn(spec, k)) throw bad(`${k} is not allowed for ${c.type}`);
  for (const k of Object.keys(spec)) {
    if (!(k in c)) throw bad(`${k} is required for ${c.type}`);
    if (!CMD_FIELD_OK[k](c[k])) throw bad(`${k} is not valid` + (k === "answer" ? ` (1–${LIMITS.answer} characters of text)` : ""));
  }
  const out = Object.create(null);   // null 原型：没给的可选字段（expectedVersion…）不会从 Object.prototype 继承
  for (const k of CMD_KEYS) if (k in c) out[k] = c[k];
  return Object.freeze(out);
}
/* 同一 commandId 的「内容是否相同」：规范命令的 JSON（键序固定） */
const fingerprint = cmd => JSON.stringify(cmd);

/* ---------------- 启动参数 ---------------- */
const START_KEYS = ["commandId", "topicId", "title", "goal", "lang", "maxRounds", "targetCorrect", "maxAttempts", "maxHints"];
const START_RANGES = { maxRounds: [1, 20, 5], maxAttempts: [1, 5, 2], maxHints: [0, 5, 2] };
function readStart(input) {
  const s = readPlain(input, START_KEYS, "INVALID_INPUT", "start input");
  const bad = msg => new WorkflowError("INVALID_INPUT", "start input: " + msg);
  if (!isEventId(s.commandId)) throw bad("commandId is not valid");
  if (!isTopicId(s.topicId)) throw bad("topicId is not valid");
  if (!isText(s.title, LIMITS.title)) throw bad(`title must be 1–${LIMITS.title} characters of text`);
  if (!isText(s.goal, LIMITS.goal)) throw bad(`goal must be 1–${LIMITS.goal} characters of text`);
  if (typeof s.lang !== "string" || !LANGS.includes(s.lang)) throw bad("lang must be zh or en");
  const n = {};
  for (const [k, [lo, hi, def]] of Object.entries(START_RANGES)) {
    const v = k in s ? s[k] : def;
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw bad(`${k} must be an integer in ${lo}–${hi}`);
    n[k] = v;
  }
  const target = "targetCorrect" in s ? s.targetCorrect : Math.min(3, n.maxRounds);
  if (!Number.isSafeInteger(target) || target < 1 || target > n.maxRounds) throw bad("targetCorrect must be an integer in 1–maxRounds");
  return Object.freeze({ commandId: s.commandId, topicId: s.topicId, title: s.title, goal: s.goal, lang: s.lang,
    maxRounds: n.maxRounds, targetCorrect: target, maxAttempts: n.maxAttempts, maxHints: n.maxHints });
}

/* ---------------- Diagnose：只看投影里本话题的结构化计数 ----------------
 * 没有历史 / 有先修缺口 / 有 concept 或 prerequisite-gap 误因 / 错多于对 → 先讲概念；否则 → 苏格拉底式引导。
 * 已掌握也照样教一遍（工作流不跳过 Teach）；历史本身不交给模型、不进公开视图。 */
function chooseStrategy(t) {
  if (!t || !(t.attempts > 0)) return "explain-concept";
  const m = t.mistakes || {};
  if ((t.prerequisiteGaps && t.prerequisiteGaps.length > 0) || m.concept > 0 || m["prerequisite-gap"] > 0 || t.wrong > t.correct) return "explain-concept";
  return "socratic-teaching";
}
const hintStrategy = plan => (plan === "socratic-teaching" ? "socratic-teaching" : "give-hint");

/* ---------------- Adapt：只看结构化评分和计数 ----------------
 * in = { outcome: correct|wrong|uncertain, correct, round, maxRounds, targetCorrect, attempts, maxAttempts }
 * → 冻结的 { phase, teachMode?, outcome?, reason }。从不产生「已掌握」。 */
function decideAdapt(x) {
  const roundsLeft = x.round < x.maxRounds;
  const done = () => Object.freeze({ phase: "done", outcome: "round-limit", reason: "round-limit" });
  switch (x.outcome) {
    case "correct":
      if (x.correct >= x.targetCorrect) return Object.freeze({ phase: "done", outcome: "goal-reached", reason: "goal-reached" });
      return roundsLeft ? Object.freeze({ phase: "practice", reason: "next-question" }) : done();
    case "wrong":
      if (x.attempts < x.maxAttempts) return Object.freeze({ phase: "teach", teachMode: "remediate", reason: "retry-question" });
      return roundsLeft ? Object.freeze({ phase: "practice", reason: "next-question" }) : done();
    case "uncertain":
      return roundsLeft ? Object.freeze({ phase: "practice", reason: "ungraded" }) : done();
    default:
      throw new Error("decideAdapt: unknown outcome");
  }
}

module.exports = {
  PHASES, COMMANDS, ALLOWED, STAGE_OF, LIMITS, LANGS, commandAllowed, isText,
  readCommand, fingerprint, readStart, chooseStrategy, hintStrategy, decideAdapt,
};
