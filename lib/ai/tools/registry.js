/*
 * Tool Registry（#26，#19 Phase 2）。零依赖。
 *
 * 一个 Tool 的定义：
 *   {
 *     name:        "questions.startQuiz"             组名.动作名，唯一
 *     description: "给 LLM 看的一句话"
 *     parameters:  JSON Schema 子集（lib/ai/tools/schema.js），描述 input
 *     roles:       ["student","parent"]               谁能调；ctx.role 不在里面 → PERMISSION
 *     risk:        "read" | "write" | "spend"          只读 / 写孩子数据 / 会花引擎额度（给 Harness 做审批和限流）
 *     timeoutMs:   数字                                超时 → TIMEOUT
 *     tags:        ["quiz"]                            可选，list() 过滤用
 *     run:         async (ctx, input) => result        必须转调 lib/actions，不复制业务逻辑
 *   }
 *
 * invoke(name, ctx, input) 永远 resolve 成同一个形状（不 reject，不让进程退出）：
 *   { ok:true,  result, meta:{ tool, traceId, ms, risk } }
 *   { ok:false, error:{ code, message, status, details? }, meta }
 *   code ∈ UNKNOWN_TOOL / INVALID_INPUT / PERMISSION / TIMEOUT / ACTION（Action 自己抛的 ActionError，status 原样带）/ INTERNAL
 * 每次 invoke 发一条 trace 给 onTrace（默认 log）：{ traceId, tool, role, kidId, ok, code?, ms, at }。input 不进 trace（可能有题目原文/图片）。
 */
"use strict";
const { check } = require("./schema.js");

const CODES = ["UNKNOWN_TOOL", "INVALID_INPUT", "PERMISSION", "TIMEOUT", "ACTION", "INTERNAL"];
const RISKS = ["read", "write", "spend"];
let traceSeq = 0;

function createRegistry(opts) {
  opts = opts || {};
  const log = opts.log || console.log;
  const now = opts.now || Date.now;
  const onTrace = opts.onTrace || (t => log(`[tool] ${t.tool} ${t.ok ? "ok" : "fail:" + t.code} ${t.ms}ms role=${t.role} kid=${t.kidId || "-"} trace=${t.traceId}`));
  const tools = new Map();

  function register(tool) {
    for (const k of ["name", "description", "parameters", "roles", "risk", "timeoutMs", "run"]) {
      if (tool[k] == null) throw new TypeError(`tool ${tool.name || "?"}: missing ${k}`);
    }
    if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(tool.name)) throw new TypeError(`tool name must look like group.action: ${tool.name}`);
    if (tools.has(tool.name)) throw new TypeError(`tool already registered: ${tool.name}`);
    if (!Array.isArray(tool.roles) || !tool.roles.length) throw new TypeError(`tool ${tool.name}: roles must be a non-empty array`);
    if (!RISKS.includes(tool.risk)) throw new TypeError(`tool ${tool.name}: risk must be ${RISKS.join("|")}`);
    if (typeof tool.run !== "function") throw new TypeError(`tool ${tool.name}: run must be a function`);
    tools.set(tool.name, Object.freeze(Object.assign({ tags: [] }, tool)));
    return tool.name;
  }
  const get = name => tools.get(name) || null;
  /* 给 Agent 看的清单：按角色过滤（ctx.role 不在 roles 里的不列），可再按 tags / 组名过滤 */
  function list(filter) {
    filter = filter || {};
    return [...tools.values()].filter(t =>
      (!filter.role || t.roles.includes(filter.role)) &&
      (!filter.tag || t.tags.includes(filter.tag)) &&
      (!filter.group || t.name.startsWith(filter.group + ".")));
  }
  /* LLM tool 定义（name / description / parameters），不带 run */
  function describe(filter) {
    return list(filter).map(t => ({ name: t.name, description: t.description, parameters: t.parameters, risk: t.risk }));
  }

  async function invoke(name, ctx, input) {
    const t0 = now();
    const traceId = "t" + t0.toString(36) + (++traceSeq).toString(36);
    const meta = { tool: name, traceId, ms: 0, risk: undefined };
    const fail = (code, message, extra) => {
      meta.ms = now() - t0;
      const error = Object.assign({ code, message }, extra || {});
      onTrace({ traceId, tool: name, role: ctx && ctx.role, kidId: ctx && ctx.kidId, ok: false, code, status: error.status, ms: meta.ms, at: t0 });
      return { ok: false, error, meta };
    };
    const tool = tools.get(name);
    if (!tool) return fail("UNKNOWN_TOOL", `no such tool: ${name}`, { status: 404 });
    meta.risk = tool.risk;
    if (!ctx || !tool.roles.includes(ctx.role)) return fail("PERMISSION", `${name} is not available to role ${ctx && ctx.role}`, { status: 403 });
    const v = check(tool.parameters, input === undefined ? {} : input);
    if (!v.ok) return fail("INVALID_INPUT", `invalid input for ${name}`, { status: 400, details: v.errors });
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.run(ctx, input === undefined ? {} : input)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${name} timed out after ${tool.timeoutMs}ms`), { code: "TIMEOUT" })), tool.timeoutMs); })
      ]);
      clearTimeout(timer);
      meta.ms = now() - t0;
      onTrace({ traceId, tool: name, role: ctx.role, kidId: ctx.kidId, ok: true, ms: meta.ms, at: t0 });
      return { ok: true, result, meta };
    } catch (e) {
      clearTimeout(timer);
      if (e && e.code === "TIMEOUT") return fail("TIMEOUT", e.message, { status: 504 });
      if (e && e.name === "ActionError") return fail("ACTION", e.message, { status: e.status, details: e.body });
      /* 未知异常：saveFailed 那类带 status 的原样带上，其它 500；message 不带堆栈 */
      return fail("INTERNAL", String((e && e.message) || e), { status: (e && e.status) || 500, ...(e && e.saveFailed ? { saveFailed: true } : {}) });
    }
  }

  return { register, get, list, describe, invoke, get size() { return tools.size; }, CODES, RISKS };
}

module.exports = { createRegistry, CODES, RISKS };
