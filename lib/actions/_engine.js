/*
 * 现场调模型的公共小步（#25）：runEngine 一次，失败原样再跑一次。
 * 这就是以前在 lesson / fsa / unit-test / report 四条路由里各复制一份的模板；
 * Phase 3 的 Harness 会把它收进去，这里先只做「合成一份」。
 */
"use strict";

module.exports = function createEngineHelper(deps) {
  const { runEngine } = deps;
  const log = deps.log || console.log;
  return async function generateOnce(tag, providerId, task, sys, q, imageB64, mediaType, lang, opts, validate) {
    try { return await runEngine(providerId, task, sys, q, imageB64, mediaType, lang, opts, validate); }
    catch (e1) {
      log(`[${tag}] first try failed (${e1.message}), retrying once...`);
      return await runEngine(providerId, task, sys, q, imageB64, mediaType, lang, opts, validate);
    }
  };
};
