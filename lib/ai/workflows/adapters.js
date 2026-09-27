/*
 * 辅导工作流与外部组件之间的边界（#36，#19 Phase 6）：
 *   readQuestion   可信练习题接口的回包 → 冻结题目；答案键只留在私有状态里交给评分器
 *   readGrade      可信评分接口的回包 → { outcome, mistake? }；任何不认识的形状都是 GRADER_INVALID，从不猜「对」
 *   readTutorReply TutorAgent 的结果 → 成功（本步要的 kind + 正文）或失败码 + 固定模板；拒答 / 安全不透传模型文字
 *   *Question      交给 TutorAgent 的问题文本：模板 + 明确列出的字段，长度有界，没有答案键、学生历史或身份
 * 零依赖（只用本仓库模块），无 I/O。
 */
"use strict";

const { WorkflowError, readPlain } = require("./errors.js");
const { isText, LIMITS } = require("./machine.js");
const { isEventId, MISTAKES } = require("../memory/events.js");
const { TEXTS, classifyScope } = require("../tutor/index.js");

const QUESTION_KEYS = ["questionId", "topicId", "prompt", "answerKey"];
/* ctx = { topicId: 工作流的话题, used: 本工作流已出过的 questionId } */
function readQuestion(reply, ctx) {
  const q = readPlain(reply, QUESTION_KEYS, "PRACTICE_INVALID", "practice question");
  const bad = msg => new WorkflowError("PRACTICE_INVALID", "practice question: " + msg);
  if (!isEventId(q.questionId)) throw bad("questionId is not valid");
  if (q.topicId !== ctx.topicId) throw bad("topicId must be the workflow's topic");
  if (!isText(q.prompt, LIMITS.prompt)) throw bad(`prompt must be 1–${LIMITS.prompt} characters of text`);
  if ("answerKey" in q && !isText(q.answerKey, LIMITS.answerKey)) throw bad(`answerKey must be 1–${LIMITS.answerKey} characters of text`);
  if (ctx.used.includes(q.questionId)) throw bad("questionId was already used in this workflow");
  return Object.freeze({ questionId: q.questionId, topicId: q.topicId, prompt: q.prompt, answerKey: "answerKey" in q ? q.answerKey : null });
}

const OUTCOMES = Object.freeze(["correct", "wrong", "uncertain"]);
function readGrade(reply) {
  const g = readPlain(reply, ["outcome", "mistake"], "GRADER_INVALID", "grade");
  const bad = msg => new WorkflowError("GRADER_INVALID", "grade: " + msg);
  if (typeof g.outcome !== "string" || !OUTCOMES.includes(g.outcome)) throw bad("outcome must be correct, wrong or uncertain");
  if ("mistake" in g) {
    if (g.outcome !== "wrong") throw bad("mistake is only allowed with outcome wrong");
    if (typeof g.mistake !== "string" || !MISTAKES.includes(g.mistake)) throw bad("mistake must be one of " + MISTAKES.join(", "));
    return Object.freeze(Object.assign(Object.create(null), { outcome: g.outcome, mistake: g.mistake }));
  }
  /* null 原型：没给 mistake 就真的没有，Object.prototype.mistake 被污染也读不出来 */
  return Object.freeze(Object.assign(Object.create(null), { outcome: g.outcome }));
}

/* TutorAgent 的结果只读自有数据属性 ok / kind / text（getter 不执行、Proxy 异常收口）。
 * kinds = 本步认可的成功类型；拒答 / 安全换成 TutorAgent 自己的固定模板，其它一律 TUTOR_ERROR + 出错模板。 */
const TUTOR_TEXT_MAX = 4000;
const errorReply = lang => Object.freeze({ kind: "error", text: TEXTS[lang === "en" ? "en" : "zh"].error });
function readTutorReply(r, lang, kinds) {
  const T = TEXTS[lang === "en" ? "en" : "zh"];
  const error = () => ({ ok: false, code: "TUTOR_ERROR", reply: errorReply(lang) });
  let ok, kind, text;
  try {
    if (r === null || typeof r !== "object") return error();
    const own = k => { const d = Reflect.getOwnPropertyDescriptor(r, k); return d && "value" in d ? d.value : undefined; };
    ok = own("ok"); kind = own("kind"); text = own("text");
  } catch (_) { return error(); }
  if (kind === "safety") return { ok: false, code: "TUTOR_SAFETY", reply: Object.freeze({ kind: "safety", text: T.safety }) };
  if (kind === "refusal") {
    const templates = [T.non_academic, T.mixed, T.injection, T.other_academic];
    return { ok: false, code: "TUTOR_REFUSED", reply: Object.freeze({ kind: "refusal", text: templates.includes(text) ? text : T.non_academic }) };
  }
  if (ok === true && kinds.includes(kind) && typeof text === "string" && text.length >= 1 && text.length <= TUTOR_TEXT_MAX && text.trim())
    return { ok: true, reply: Object.freeze({ kind, text }) };
  return error();
}

/* 孩子提交的作答只交给评分器，不经过 TutorAgent；这里先过一遍 TutorAgent 的确定性预闸，只认 unsafe（自伤等求助）：
 * 命中就给安全模板、不记尝试。其它标签（闲聊、注入样的文字）不拦——作答不是给模型的指令，评分器照常判。 */
function screenAnswer(lang, answer) {
  if (classifyScope(answer).label !== "unsafe") return null;
  return { ok: false, code: "TUTOR_SAFETY", reply: Object.freeze({ kind: "safety", text: TEXTS[lang === "en" ? "en" : "zh"].safety }) };
}

/* ---------------- 给 TutorAgent 的问题（字段 + 长度都有界：title ≤120、goal ≤300、prompt ≤1000、answer ≤500，拼好 < 2000） ---------------- */
function lessonQuestion(lang, title, goal) {
  return lang === "en"
    ? `Teach a short lesson on this math topic: explain the idea and why the method works, with one small example.\nTopic: ${title}\nLearning goal: ${goal}`
    : `请围绕下面这个数学知识点给学生上一小课：讲清楚概念和方法为什么成立，配一个小例子。\n知识点：${title}\n学习目标：${goal}`;
}
function hintQuestion(lang, prompt) {
  return lang === "en"
    ? `This is a math practice question the student is working on. Give one hint or the next step, not the answer.\nQuestion: ${prompt}`
    : `这是学生正在做的一道数学练习题。请给一个提示或下一步，不要给出答案。\n题目：${prompt}`;
}
/* mistake 只可能是评分器给的五类枚举之一（或没有） */
function remediateQuestion(lang, prompt, answer, mistake) {
  return lang === "en"
    ? `The student answered this math practice question, but the answer is not right. Help the student find which step most likely went wrong. Do not give the correct answer.\nQuestion: ${prompt}\nStudent's answer: ${answer}` +
      (mistake ? `\nMistake category from the grader: ${mistake}` : "")
    : `学生做了下面这道数学练习题，但回答不对。请帮学生找出最可能错在哪一步，不要给出正确答案。\n题目：${prompt}\n学生的回答：${answer}` +
      (mistake ? `\n评分给出的误因类别：${mistake}` : "");
}

module.exports = { readQuestion, readGrade, readTutorReply, errorReply, screenAnswer, lessonQuestion, hintQuestion, remediateQuestion, OUTCOMES };
