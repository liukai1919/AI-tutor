/*
 * 英文题库出题链的纯模块（#43 / #44，#8 子任务 A / B）。零全局 I/O、不调模型；server.js 只做薄接缝（读已跟踪文件、注入依赖）。
 *
 *   TeachingBrief：buildTeachingBrief(input) → 冻结对象（briefHash / briefId）；renderGeneratorBrief / renderJudgeBrief
 *   硬校验：validateEnglishQbankBatch(raw, requested, ctx)（带老门槛）/ checkEnglishQuestions(raw, ctx)（逐题、不设门槛）
 *   schema / 格式说明：englishQbankSchema(base, brief)、englishQbankHint(base, brief)
 *   逐题审稿 v2（#44）：review.js（协议、严格解析、v1 适配器、哈希）、coordinator.js（runReviewV2 编排）、
 *     store.js（createReviewStore：DATA_ROOT 下的旁路记录，写失败就抛）
 *
 * 还没做（#45）：pregen / audit 的新命令行参数与生产接线。
 */
"use strict";

const brief = require("./brief.js");
const validate = require("./validate.js");
const review = require("./review.js");
const coordinator = require("./coordinator.js");
const store = require("./store.js");

module.exports = Object.assign({}, brief, validate, review, coordinator, store);
