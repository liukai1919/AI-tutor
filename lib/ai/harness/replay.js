/*
 * 确定性回放 Provider（#28，#19 Phase 3）。零依赖、零网络、零引擎成本。
 * 实现 Harness 的模型接口 `next(req) => Promise<turn>`，按脚本顺序给出回合：
 *
 *   { type:"tool_call", tool, input }      原样作为模型回合返回（拷贝）
 *   { type:"final", output }               同上
 *   { raw: 任意值 }                        原样返回这个值（测非法回合：字符串、null、缺字段…）
 *   { error: "msg" }                       reject 一个 Error(msg)（测模型异常）
 *   { hang: true }                         永不结算（测超时 / 取消）
 *   { delayMs: n, then: <上面任一种> }      等 n 毫秒再按 then 处理（不理会 abort，模拟最坏的迟到结果）
 *
 * 脚本用完再调 → reject「replay exhausted」。每次请求（Harness 给的冻结对象）都记在 calls 里供断言。
 * fixture 全部是合成数据；本模块不录制真实调用，也不读学生数据。
 */
"use strict";

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function createReplayModel(turns) {
  if (!Array.isArray(turns)) throw new TypeError("replay turns must be an array");
  const script = clone(turns);
  const calls = [];
  let i = 0;
  function play(t) {
    if (t && typeof t === "object" && !Array.isArray(t)) {
      if ("delayMs" in t) return new Promise(r => setTimeout(r, Number(t.delayMs) || 0)).then(() => play(t.then));
      if (t.hang) return new Promise(() => {});
      if ("error" in t) return Promise.reject(new Error(String(t.error)));
      if ("raw" in t) return Promise.resolve(clone(t.raw));
    }
    return Promise.resolve(clone(t));
  }
  return {
    calls,
    get turns() { return clone(script); },
    get remaining() { return script.length - i; },
    next(req) {
      calls.push(req);
      if (i >= script.length) return Promise.reject(new Error(`replay exhausted after ${script.length} turns`));
      return play(script[i++]);
    },
  };
}

module.exports = { createReplayModel };
