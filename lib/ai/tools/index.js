/*
 * Tool 定义（#26，#19 Phase 2）：把 lib/actions 包成 Agent Tool 并登记进 registry。
 * 这里只有「参数 schema + 转调哪个 Action」，没有业务逻辑；UI 路由和 Agent 调的是同一份 Action。
 *
 * 分组沿用 #19 的建议：student.* / curriculum.* / questions.* / learning.* / calculator.*
 * risk：read 只读；write 写孩子数据；spend 可能调引擎花额度（Harness 据此审批 / 限流）。
 */
"use strict";
const { createRegistry } = require("./registry.js");
const calculator = require("./calculator.js");

const KID_ID = { type: "string", minLength: 1, maxLength: 64 };
const CURRICULUM_ID = { type: "string", minLength: 3, maxLength: 80 };
const LANG = { type: "string", enum: ["zh", "en"] };
const GRADE = { anyOf: [{ type: "integer", minimum: 1, maximum: 12 }, { type: "string", minLength: 1, maxLength: 32 }] };
const obj = (properties, required) => ({ type: "object", properties, required: required || [], additionalProperties: false });
const BOTH = ["student", "parent"], PARENT = ["parent"];

function createTools(deps) {
  const { actions, findCurriculumItem } = deps;
  const reg = createRegistry({ log: deps.log, onTrace: deps.onTrace, now: deps.now });
  const T = (name, description, parameters, roles, risk, timeoutMs, run, tags) => reg.register({ name, description, parameters, roles, risk, timeoutMs, run, tags: tags || [name.split(".")[0]] });

  /* ---- student.* ：这个孩子的状态 ---- */
  T("student.getProgress", "This student's learning progress per curriculum item (status new/seen/solid, counts). Optional grade filters to BC.MATH.G<grade>.* items.",
    obj({ grade: { type: "integer", minimum: 1, maximum: 12 } }), BOTH, "read", 3000,
    (ctx, input) => actions.progress.get(ctx, input));
  T("student.getHistory", "Summaries of lessons this student has been taught (id, title, question, mode).",
    obj({}), BOTH, "read", 3000,
    (ctx) => actions.history.list(ctx));
  T("student.getLesson", "The full record of one past lesson by id (for replaying or referring back).",
    obj({ id: { type: "string", minLength: 6, maxLength: 24 } }, ["id"]), BOTH, "read", 3000,
    (ctx, input) => actions.history.get(ctx, input));

  /* ---- curriculum.* ：大纲 ---- */
  T("curriculum.getView", "The curriculum list for a grade/course/book with this student's status per item. Without grade: the catalog of grades, courses, books.",
    obj({ grade: GRADE, view: { type: "string", enum: ["standards"] } }), BOTH, "read", 3000,
    (ctx, input) => actions.curriculum.view(ctx, input));
  T("curriculum.findTopic", "Look up one curriculum item by id: its English/Chinese name, strand and (for skills) prerequisites and misconceptions.",
    obj({ curriculumId: CURRICULUM_ID }, ["curriculumId"]), BOTH, "read", 1000,
    (ctx, input) => {
      const found = findCurriculumItem(input.curriculumId);
      if (!found) { const { ActionError, UNKNOWN_ITEM } = require("../../actions/errors.js"); throw new ActionError(404, UNKNOWN_ITEM); }
      const it = found.item;
      return { id: it.id, en: it.en, zh: it.zh, strand: it.strand, elaborations: it.elaborations || [], terms: it.terms || [], ...(it.skill ? { skill: it.skill } : {}) };
    });

  /* ---- questions.* ：闯关 / 单元卷 ---- */
  T("questions.startQuiz", "Start a Solid Quiz on a curriculum item: returns a session ticket, the rules and the first question (no answer). May generate questions with an engine if the bank is short.",
    obj({ curriculumId: CURRICULUM_ID, lang: LANG }, ["curriculumId"]), BOTH, "spend", 660000,
    (ctx, input) => actions.quiz.start(ctx, input));
  T("questions.answerQuiz", "Submit the student's pick (0-3) for the current quiz question; returns correct/answerIndex/explain and the next question.",
    obj({ session: { type: "string", minLength: 8, maxLength: 64 }, picked: { type: "integer", minimum: 0, maximum: 3 } }, ["session", "picked"]), BOTH, "write", 3000,
    (ctx, input) => actions.quiz.answer(ctx, input));
  T("questions.finishQuiz", "Settle a quiz session: records right/wrong per question into progress, returns passed/status/level.",
    obj({ session: { type: "string", minLength: 8, maxLength: 64 }, curriculumId: CURRICULUM_ID, lang: LANG }, ["session", "curriculumId"]), BOTH, "write", 5000,
    (ctx, input) => actions.quiz.finish(ctx, input));
  T("questions.listUnitTests", "This student's archived unit tests (optionally for a grade key and unit/strand).",
    obj({ grade: { type: "string", maxLength: 32 }, strand: { type: "string", maxLength: 64 } }), BOTH, "read", 3000,
    (ctx, input) => actions.unitTest.list(ctx, input));
  T("questions.getUnitTest", "One archived unit test with its questions and attempts.",
    obj({ id: { type: "string", minLength: 6, maxLength: 24 } }, ["id"]), BOTH, "read", 3000,
    (ctx, input) => actions.unitTest.get(ctx, input));

  /* ---- learning.* ：记录与评估 ---- */
  T("learning.recordPractice", "Record a practice outcome for a curriculum item (practiced-right / practiced-wrong). Parent-only events (mark-solid) are rejected for students by the action.",
    obj({ curriculumId: CURRICULUM_ID, event: { type: "string", enum: ["practiced-right", "practiced-wrong", "mark-solid", "unmark-solid"] } }, ["curriculumId", "event"]), BOTH, "write", 3000,
    (ctx, input) => actions.progress.record(ctx, input));
  T("learning.getReport", "Parent report for a grade: per-strand items with BC level (emerging/developing/proficient/extending), totals and bilingual terms.",
    obj({ grade: GRADE }, ["grade"]), PARENT, "read", 5000,
    (ctx, input) => actions.report.view(ctx, input));

  /* ---- calculator.* ：确定性工具 ---- */
  T("calculator.evaluate", "Evaluate an arithmetic expression exactly (+ - * / % ^, parentheses, sqrt/abs/round/floor/ceil/min/max, pi, e). Use it to verify any number before stating it.",
    obj({ expression: { type: "string", minLength: 1, maxLength: 200 } }, ["expression"]), BOTH, "read", 200,
    (ctx, input) => ({ expression: input.expression, value: calculator.evaluate(input.expression) }), ["calculator", "verifier"]);

  return reg;
}

module.exports = { createTools, createRegistry, calculator };
