/*
 * 答案 verifier 与确定性 grader（#38，#19 Phase 7）。零依赖（只用 number.js），无 I/O。
 *
 *   verifyAnswer(answer, answerKey) → 冻结 { status: correct|wrong|uncertain, reason }
 *   createAnswerGrader()            → 冻结 { grade(req) }，可直接作为 Phase 6 工作流的 grader
 *
 * 判定（都是精确有理数比较，没有容差）：
 *   - 作答和答案键都能按 number.js 解析：值不同 → wrong；值相同且规范写法相同 → correct；
 *     值相同但写法不同（4/8 与 1/2、0.5 与 1/2、4 与 4.0、0.5 与 0.50）→ uncertain（不知道题目是否要求最简 / 位数 / 形式）。
 *   - 答案键为空 / null / 不受支持，或作答不受支持（单位、%、代数、文字、多个数…）→ uncertain。
 * 结果只有状态和原因码，不含答案键或作答原文；从不给误因（答错本身不是任何一类误因的证据）。
 */
"use strict";

const { parseAnswerNumber, equal } = require("./number.js");

const STATUSES = Object.freeze(["correct", "wrong", "uncertain"]);
const result = (status, reason) => Object.freeze({ status, reason });

function verifyAnswer(answer, answerKey) {
  if (answerKey === null || answerKey === undefined || answerKey === "") return result("uncertain", "no-key");
  const k = parseAnswerNumber(answerKey);
  if (!k.ok) return result("uncertain", "key-unsupported");
  const a = parseAnswerNumber(answer);
  if (!a.ok) return result("uncertain", a.reason === "empty" ? "answer-empty" : "answer-unsupported");
  if (!equal(a.value, k.value)) return result("wrong", "value-differs");
  if (a.canon !== k.canon) return result("uncertain", "equivalent-form");
  return result("correct", "exact-match");
}

/* req 是外部对象：同步只读 answerKey / answer 两个自有数据属性（getter 不执行，Proxy / 撤销的 Proxy 抛错都收成 uncertain）。
 * 工作流给的 req 还有 ctx、topicId、questionId、prompt、attemptId，这里不读。 */
function readField(req, k) {
  const d = Reflect.getOwnPropertyDescriptor(req, k);
  if (!d) return undefined;
  if (!("value" in d)) throw new TypeError("accessor");
  return d.value;
}
function createAnswerGrader() {
  function grade(req) {
    let key, answer;
    try {
      if (req === null || typeof req !== "object") return Object.freeze({ outcome: "uncertain" });
      key = readField(req, "answerKey");
      answer = readField(req, "answer");
    } catch (_) {
      return Object.freeze({ outcome: "uncertain" });
    }
    return Object.freeze({ outcome: verifyAnswer(answer, key).status });
  }
  return Object.freeze({ grade });
}

module.exports = { verifyAnswer, createAnswerGrader, STATUSES };
