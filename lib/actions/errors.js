/*
 * Action 层的错误约定（#24，#19 Phase 1 第四刀）。
 * Action 不知道 HTTP，但要能说「这是调用方的错、该回什么」：抛 ActionError(status, body)，
 * server.js 的 runAction 原样 send；saveFailed 那类错误不走这里，照旧交给统一 catch。
 */
"use strict";

class ActionError extends Error {
  constructor(status, body) {
    super((body && body.error) || ("action error " + status));
    this.name = "ActionError";
    this.status = status;
    this.body = body || { error: this.message };
  }
}

const NEED_KID = { error: "请指定要查看的孩子 / Please pick which child", kidRequired: true };
const PARENT_ONLY = { error: "需要家长权限 / Parent access required", parentRequired: true };
const UNKNOWN_ITEM = { error: "未知的知识点 / Unknown curriculum item" };

/* 大多数 Action 的第一句：没有孩子上下文就是 400 kidRequired（路由把 resolveKid 的结果原样传进来，可能是 null） */
function needKid(ctx) {
  if (!ctx || !ctx.kidId) throw new ActionError(400, NEED_KID);
  return ctx.kidId;
}

module.exports = { ActionError, needKid, NEED_KID, PARENT_ONLY, UNKNOWN_ITEM };
