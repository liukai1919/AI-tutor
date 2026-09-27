/*
 * 英文题库出题链的纯模块（#43，#8 子任务 A）。零 I/O、不调模型；server.js 只做薄接缝（读已跟踪文件、传原文）。
 *
 *   TeachingBrief：buildTeachingBrief(input) → 冻结对象（briefHash / briefId）；renderGeneratorBrief / renderJudgeBrief
 *   硬校验：validateEnglishQbankBatch(raw, requested, { brief, checkVisual, allowedTags, existingQids })
 *   schema / 格式说明：englishQbankSchema(base, brief)、englishQbankHint(base, brief)
 *
 * 还没做（#44 / #45）：逐题 v2 审稿、报告落盘、有限修复、draft 身份、pregen/audit 的新命令行参数。
 */
"use strict";

const brief = require("./brief.js");
const validate = require("./validate.js");

module.exports = Object.assign({}, brief, validate);
