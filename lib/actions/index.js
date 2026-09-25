/*
 * Action 层入口（#24，#19 Phase 1 第四刀）。
 *
 * 一个 Action = (ctx, input) => output：
 *   ctx    { kidId | null, role: "parent" | "student", userId }   由路由用 allow / resolveKid 算好
 *   input  已解析的请求体 / query                                   Action 自己校验、归一化
 *   output 现在路由发的 JSON 原样（前端硬依赖字段见 docs/ai-native-refactor-audit.md §4 第 7 条）
 * 出错抛 ActionError(status, body)；saveFailed 那类错误原样往外抛，由 server.js 统一 catch。
 *
 * 基础设施（kd / kidSave / progressRecord / qbank / 引擎选路…）由 create(deps) 注入，server.js 组装。
 * UI 路由和将来的 Agent Tool（Phase 2）调的是同一份 Action。
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

function create(deps) {
  const d = Object.assign({}, deps);
  if (!d.generateOnce && d.runEngine) d.generateOnce = require("./_engine.js")(d);   // 现场调模型的公共小步（失败再跑一次）
  return {
    progress: require("./progress.js")(d),
    curriculum: require("./curriculum.js")(d),
    quiz: require("./quiz.js")(d),
    history: require("./history.js")(d),
    fsa: require("./fsa.js")(d),
    unitTest: require("./unitTest.js")(d),
    report: require("./report.js")(d),
    lesson: require("./lesson.js")(d),
  };
}

module.exports = { create, ActionError, needKid };
