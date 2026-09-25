/*
 * 讲课历史 Action（#25）：list / get / remove / clear。逻辑从 /api/history* 原样搬来。
 * deps：kd, kidSave, historySummary, log
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

module.exports = function createHistoryActions(deps) {
  const { kd, kidSave, historySummary } = deps;
  const log = deps.log || console.log;
  const NOT_FOUND = { error: "记录不存在 / Not found" };
  const find = (kidId, id) => { const list = kd(kidId).history; const i = list.findIndex(r => r.id === String(id || "")); return { list, i }; };

  return {
    list(ctx) { const kidId = needKid(ctx); return { items: kd(kidId).history.map(historySummary) }; },
    get(ctx, input) {
      const kidId = needKid(ctx);
      const { list, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      return { record: list[i] };
    },
    /* 删除是家长动作（防误删、防「藏起错题」）；权限由路由 allow 把关 */
    remove(ctx, input) {
      const kidId = needKid(ctx);
      const { list, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      list.splice(i, 1);
      kidSave(kidId, "history");
      return { ok: true };
    },
    clear(ctx) {
      const kidId = needKid(ctx);
      kd(kidId).history = [];
      kidSave(kidId, "history");
      log(`[history] cleared (kid=${kidId})`);
      return { ok: true };
    }
  };
};
