/*
 * 学习进度 Action（#24）：get / record / clear。逻辑从 /api/progress 三条路由原样搬来。
 * deps：kd, kidSave, progressRecord, progressStatus, findCurriculumItem, INTERNAL_EVENTS, PARENT_ONLY_EVENTS, log
 */
"use strict";
const { ActionError, needKid, PARENT_ONLY, UNKNOWN_ITEM } = require("./errors.js");

module.exports = function createProgressActions(deps) {
  const { kd, kidSave, progressRecord, progressStatus, findCurriculumItem, INTERNAL_EVENTS, PARENT_ONLY_EVENTS } = deps;
  const log = deps.log || console.log;
  const UNKNOWN_EVENT = { error: "未知的事件 / Unknown event" };

  return {
    /* 一个孩子的进度条目；grade 给了就只要 BC.MATH.G<g>. 前缀的（技能/课程/书籍条目过滤不出来——审计 §3 已记） */
    get(ctx, input) {
      const kidId = needKid(ctx);
      const g = Number((input && input.grade) || 0);
      const prefix = g ? `BC.MATH.G${g}.` : "";
      const items = {};
      for (const [id, e] of Object.entries(kd(kidId).progress)) {
        if (prefix && !id.startsWith(prefix)) continue;
        items[id] = Object.assign({}, e, { status: progressStatus(kidId, id) });
      }
      return { items };
    },

    /* 从客户端来的进度事件：内部事件不认；标扎实/取消标扎实只有家长能做；孩子只能自报练习对错 */
    record(ctx, input) {
      const event = String((input && input.event) || "");
      // 内部事件不从这里进：跟不认识的事件一样回 400，不额外告诉调用方它存在
      if (INTERNAL_EVENTS.has(event)) throw new ActionError(400, UNKNOWN_EVENT);
      if (PARENT_ONLY_EVENTS.has(event) && ctx.role !== "parent") throw new ActionError(403, PARENT_ONLY);
      const kidId = needKid(ctx);
      const id = String((input && input.curriculumId) || "");
      if (!findCurriculumItem(id)) throw new ActionError(400, UNKNOWN_ITEM);
      const e = progressRecord(kidId, id, event);
      if (!e) throw new ActionError(400, UNKNOWN_EVENT);
      return { ok: true, status: progressStatus(kidId, id), entry: e };
    },

    /* 清空（家长专属；权限由路由 allow 把关，这里只做事） */
    clear(ctx) {
      const kidId = needKid(ctx);
      kd(kidId).progress = {};
      kidSave(kidId, "progress");
      log(`[progress] cleared (kid=${kidId})`);
      return { ok: true };
    }
  };
};
