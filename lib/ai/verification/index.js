/*
 * 显式验证（#38，#19 Phase 7）。零依赖、无 I/O、不调模型。说明见 docs/tutor-verification.md。
 *
 *   答案：verifyAnswer(answer, answerKey) → { status: correct|wrong|uncertain, reason }；createAnswerGrader() → { grade(req) → { outcome } }
 *   回复：verifyResponse(output, opts) → { ok, failures, coverage }；extractEqualities；findAnswerLeak；readVerifyContext
 *   工作流：verifyStep(before, after, info) → { ok, violations }
 *   数字：parseAnswerNumber、evaluateExact（有界精确有理数）
 */
"use strict";

const number = require("./number.js");
const answer = require("./answer.js");
const response = require("./response.js");
const workflow = require("./workflow.js");

module.exports = {
  verifyAnswer: answer.verifyAnswer, createAnswerGrader: answer.createAnswerGrader, ANSWER_STATUSES: answer.STATUSES,
  verifyResponse: response.verifyResponse, extractEqualities: response.extractEqualities, findAnswerLeak: response.findAnswerLeak,
  readVerifyContext: response.readVerifyContext, VerificationError: response.VerificationError,
  verifyStep: workflow.verifyStep, STEP_CATEGORIES: workflow.CATEGORIES,
  parseAnswerNumber: number.parseAnswerNumber, evaluateExact: number.evaluateExact,
};
