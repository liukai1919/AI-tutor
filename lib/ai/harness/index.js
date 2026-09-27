/*
 * 最小单智能体 Harness（#28，#19 Phase 3）。零依赖。
 *
 *   const h = createHarness({ registry, tools:["calculator.evaluate"], allowRisks:["read"],
 *                             maxSteps, maxInvalid, modelRetries, stepTimeoutMs, totalTimeoutMs, onTrace, onTraceError, now });
 *   const r = await h.run({ ctx, model, system, input, validateFinal, signal, deadlineAt });
 *
 * 循环：上下文 → model.next(req) → 回合
 *   { type:"tool_call", tool, input } → 名单检查 → registry.invoke(tool, ctx, input) → observation → 再问模型
 *   { type:"final", output }          → validateFinal(output, { calls, steps, evidence }) 通过 → 结束；不通过 → observation 回给模型
 *                                        evidence（#38）= 本 run 成功且未截断的工具调用 [{ tool, input, result }]（深拷贝，与模型看到的相同）
 *
 * 保证：
 * - run 永远 resolve：{ ok:true, output, steps, calls, runId } 或 { ok:false, error:{ code, message }, steps, calls, runId }，
 *   code ∈ STOP_CODES。不 reject，不留未处理拒绝；意外异常收口成 INTERNAL。
 * - 输入边界：system 是字符串；input 是字符串或纯 JSON 值；deadlineAt 是有限数字。不合格 → INVALID_INPUT，模型不被调用。
 * - ctx 只来自调用方（run 开始时拷贝冻结），模型回合里的任何字段都改不了它；模型拿到的 req 只有
 *   { system, messages, tools, step, signal }，messages / tools 是深拷贝后深冻结的，tools 是 describe() 的结果（没有 run）。
 * - 模型回合必须是纯 JSON 值（有限数字、纯对象 / 数组、无环、无函数 / BigInt / undefined / 类实例），否则按非法回合处理，
 *   不会被 JSON 序列化悄悄改掉（NaN 变 null、函数被丢掉）再塞进 Tool 入参。
 * - 工具只经 registry.invoke；不在本 Harness 名单里的 → TOOL_NOT_ALLOWED，不进 registry。
 *   名单里的 Tool 在构造时检查 risk ∈ allowRisks（默认只读），registry 里有写入 / 花钱工具不等于 Agent 能用。
 *   registry 回的形状不对（{ok:false} 没有 error.code、非对象…）→ INTERNAL observation。
 * - 预算：maxSteps 限模型回合数；totalTimeoutMs（及调用方 deadlineAt）同时约束模型调用、工具调用和异步 validateFinal；
 *   每次模型调用另受 stepTimeoutMs 约束。每次调用前先查「已取消 / 已到时」，到了就不调（不产生副作用）；
 *   结果到达时再查一次，过了截止时间的结果不采用（JS 不能打断同步阻塞，但拒绝它的结果并停止后续步骤）。
 *   模型 reject → 最多重试 modelRetries 次（与 generateOnce 的「再跑一次」同口径）；模型超时不重试。
 *   非法回合 / 不合格 final 合计最多给 maxInvalid 次修复机会。
 * - 工具永不由 Harness 自动重试。write / spend 工具 TIMEOUT / INTERNAL（结果未知）后，本 run 内再调同一工具（不论参数）
 *   直接给 UNCERTAIN_SIDE_EFFECT，不进 registry。
 * - 取消：signal abort → 立刻 CANCELLED；被丢下的模型 / 工具 / 校验 promise 结算后只发一条 kind:"late" trace，结果不被采用。
 * - trace 是旁路：{ runId, step, kind: model|retry|tool|final|invalid|stop|late, ok, code?, tool?, source?, ms, at }，
 *   不含提问原文和工具入参；onTrace 同步抛错 / reject 只交给 onTraceError，onTraceError 再出错也吞掉。
 */
"use strict";

const STOP_CODES = ["MAX_STEPS", "TIMEOUT", "CANCELLED", "MODEL_ERROR", "BAD_MODEL_OUTPUT", "INVALID_FINAL", "INVALID_CTX", "INVALID_INPUT", "INTERNAL"];
const ROLES = ["student", "parent"];
const OBS_LIMIT = 4000;
const MAX_DEPTH = 32;
let runSeq = 0;

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}
const posInt = (v, name) => { if (!Number.isInteger(v) || v < 1) throw new TypeError(`harness: ${name} must be a positive integer`); return v; };
const nonNegInt = (v, name) => { if (!Number.isInteger(v) || v < 0) throw new TypeError(`harness: ${name} must be a non-negative integer`); return v; };
const posMs = (v, name) => { if (typeof v !== "number" || !(v > 0) || !Number.isFinite(v)) throw new TypeError(`harness: ${name} must be a positive number of ms`); return v; };

/* 严格的「纯 JSON 值」检查：返回第一个问题的描述，合格返回 null。getter / Proxy 抛错也算不合格 */
function jsonProblem(v) {
  const seen = new Set();
  function walk(x, path, depth) {
    if (depth > MAX_DEPTH) return `${path}: nested too deep`;
    if (x === null || typeof x === "string" || typeof x === "boolean") return null;
    if (typeof x === "number") return Number.isFinite(x) ? null : `${path}: ${x} is not a JSON number`;
    if (typeof x !== "object") return `${path}: ${typeof x} is not a JSON value`;
    if (seen.has(x)) return `${path}: circular reference`;
    const proto = Object.getPrototypeOf(x);
    if (!Array.isArray(x) && proto !== Object.prototype && proto !== null) return `${path}: not a plain object`;
    seen.add(x);
    try {
      if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const p = walk(x[i], `${path}[${i}]`, depth + 1); if (p) return p; } }
      else for (const k of Object.keys(x)) { const p = walk(x[k], `${path}.${k}`, depth + 1); if (p) return p; }
    } finally { seen.delete(x); }
    return null;
  }
  try { return walk(v, "$", 0); } catch (e) { return `$: unreadable value (${(e && e.message) || e})`; }
}

/* 模型回合的形状检查：先要求整个回合是纯 JSON 值，再只认两种；多余字段一律不读（包括 ctx） */
function parseTurn(t) {
  if (!isPlainObject(t)) return { ok: false, message: `turn must be an object, got ${t === null ? "null" : Array.isArray(t) ? "array" : typeof t}` };
  const bad = jsonProblem(t);
  if (bad) return { ok: false, message: `turn is not plain JSON: ${bad}` };
  if (t.type === "tool_call") {
    if (typeof t.tool !== "string" || !t.tool || t.tool.length > 80) return { ok: false, message: "tool_call needs a tool name" };
    if (t.input !== undefined && !isPlainObject(t.input)) return { ok: false, message: "tool_call input must be an object" };
    return { ok: true, type: "tool_call", tool: t.tool, input: t.input === undefined ? {} : clone(t.input) };
  }
  if (t.type === "final") {
    if (!("output" in t)) return { ok: false, message: "final needs an output" };
    return { ok: true, type: "final", output: clone(t.output) };
  }
  return { ok: false, message: `unknown turn type ${JSON.stringify(t.type)}` };
}

/* registry.invoke 的回包必须是 {ok:true,…} 或 {ok:false, error:{code:string}}；别的形状一律当 INTERNAL（结果未知） */
function normalizeReply(v) {
  if (isPlainObject(v) && v.ok === true) return v;
  if (isPlainObject(v) && v.ok === false && isPlainObject(v.error) && typeof v.error.code === "string" && v.error.code) return v;
  return { ok: false, error: { code: "INTERNAL", message: "registry returned a malformed reply", status: 500 } };
}

/* observation 回给模型前截断：模型上下文有限，也避免把一大坨孩子数据反复塞回去 */
function observe(id, tool, r) {
  const body = r.ok ? { result: r.result } : { error: r.error };
  let s;
  try { s = JSON.stringify(body); } catch (_) { s = '{"error":{"code":"INTERNAL","message":"unserializable result"}}'; }
  if (s === undefined) s = "{}";
  if (s.length <= OBS_LIMIT) return Object.assign({ role: "tool", id, tool, ok: r.ok }, JSON.parse(s));
  return { role: "tool", id, tool, ok: r.ok, truncated: true, preview: s.slice(0, OBS_LIMIT) };
}

function createHarness(opts) {
  opts = opts || {};
  const registry = opts.registry;
  if (!registry || typeof registry.invoke !== "function" || typeof registry.get !== "function" || typeof registry.describe !== "function") {
    throw new TypeError("harness: registry with get/describe/invoke is required");
  }
  const allowRisks = opts.allowRisks || ["read"];
  const toolNames = opts.tools || [];
  if (!Array.isArray(toolNames)) throw new TypeError("harness: tools must be an array of tool names");
  for (const n of toolNames) {
    const t = registry.get(n);
    if (!t) throw new TypeError(`harness: tool not registered: ${n}`);
    if (!allowRisks.includes(t.risk)) throw new TypeError(`harness: tool ${n} has risk ${t.risk}, not in allowRisks [${allowRisks.join(",")}]`);
  }
  const allow = new Set(toolNames);
  const risks = new Map(toolNames.map(n => [n, registry.get(n).risk]));
  const maxSteps = posInt(opts.maxSteps == null ? 6 : opts.maxSteps, "maxSteps");
  const maxInvalid = nonNegInt(opts.maxInvalid == null ? 2 : opts.maxInvalid, "maxInvalid");
  const modelRetries = nonNegInt(opts.modelRetries == null ? 1 : opts.modelRetries, "modelRetries");
  const stepTimeoutMs = posMs(opts.stepTimeoutMs == null ? 30000 : opts.stepTimeoutMs, "stepTimeoutMs");
  const totalTimeoutMs = posMs(opts.totalTimeoutMs == null ? 90000 : opts.totalTimeoutMs, "totalTimeoutMs");
  const now = opts.now || Date.now;
  const onTrace = opts.onTrace || (() => {});
  const onTraceError = opts.onTraceError || ((e, t) => console.warn(`[harness] trace callback failed run=${t.runId} kind=${t.kind}: ${(e && e.message) || e}`));

  function reportTraceError(e, t) {
    try { const p = onTraceError(e, t); if (p && typeof p.then === "function") p.then(null, () => {}); }
    catch (_) { /* 上报通道也坏了：吞掉 */ }
  }
  function emit(t) {
    try { const p = onTrace(t); if (p && typeof p.then === "function") p.then(null, e => reportTraceError(e, t)); }
    catch (e) { reportTraceError(e, t); }
  }

  async function run(r) {
    r = r || {};
    const t0 = now();
    const runId = "h" + t0.toString(36) + (++runSeq).toString(36);
    const calls = [];
    let steps = 0, invalid = 0;
    const trace = (kind, extra) => emit(Object.assign({ runId, step: steps, kind, ms: now() - t0, at: t0 }, extra));
    /* 本 run 自己的 abort：外部取消转接过来；结束时也 abort，给还在跑的模型一个停下来的信号 */
    const ac = new AbortController();
    const outer = r.signal;
    const onOuterAbort = () => ac.abort();
    let stopped = false;
    const stop = res => {
      if (!stopped) {
        stopped = true;
        if (outer && typeof outer.removeEventListener === "function") outer.removeEventListener("abort", onOuterAbort);
        ac.abort();
        trace("stop", { ok: res.ok, code: res.ok ? undefined : res.error.code });
      }
      return Object.assign(res, { steps, calls, runId });
    };
    const fail = (code, message) => stop({ ok: false, error: { code, message } });

    try {
      if (outer && outer.aborted) return fail("CANCELLED", "cancelled before start");
      if (outer) outer.addEventListener("abort", onOuterAbort, { once: true });

      const c = r.ctx;
      if (!isPlainObject(c) || !ROLES.includes(c.role) || !(c.kidId === null || c.kidId === undefined || (typeof c.kidId === "string" && c.kidId.length > 0))) {
        return fail("INVALID_CTX", "ctx must come from the caller: { role: student|parent, kidId: string|null, userId }");
      }
      const ctx = Object.freeze({ kidId: c.kidId == null ? null : c.kidId, role: c.role, userId: c.userId == null ? null : String(c.userId) });
      if (r.system !== undefined && typeof r.system !== "string") return fail("INVALID_INPUT", "system must be a string");
      const inputProblem = typeof r.input === "string" ? null : jsonProblem(r.input === undefined ? null : r.input);
      if (inputProblem) return fail("INVALID_INPUT", `input must be a string or plain JSON: ${inputProblem}`);
      if (r.deadlineAt !== undefined && !(typeof r.deadlineAt === "number" && Number.isFinite(r.deadlineAt))) return fail("INVALID_INPUT", "deadlineAt must be a finite number");
      const model = r.model;
      if (!model || typeof model.next !== "function") return fail("MODEL_ERROR", "run needs a model with next(req)");
      const deadline = Math.min(t0 + totalTimeoutMs, r.deadlineAt === undefined ? Infinity : r.deadlineAt);
      const toolDefs = deepFreeze(clone(registry.describe({ role: ctx.role }).filter(d => allow.has(d.name))));
      const messages = [{ role: "user", content: typeof r.input === "string" ? r.input : clone(r.input === undefined ? null : r.input) }];
      const uncertain = new Set();
      const evidence = [];

      /* 把一次调用框进「截止时间 + 取消」里，永远 resolve 成 value / error / timeout / cancel：
       * - 调用前：已取消 / 已到时 → 根本不调 fn（不产生副作用）；
       * - 结算时：已取消 / 已过截止时间 → 结果不采用；
       * - 被丢下的 promise 结算后只发一条 late trace，拒绝被接住。 */
      function guard(fn, until, source) {
        const step = steps;
        if (ac.signal.aborted) return Promise.resolve({ kind: "cancel" });
        if (now() >= until) return Promise.resolve({ kind: "timeout" });
        return new Promise(resolve => {
          let done = false, timer = null;
          const onAbort = () => settle({ kind: "cancel" });
          function settle(x) {
            if (done) return false;
            done = true; clearTimeout(timer); ac.signal.removeEventListener("abort", onAbort);
            resolve(x); return true;
          }
          const late = ok => emit({ runId, step, kind: "late", source, ok, ms: now() - t0, at: t0 });
          const arrive = (ok, x) => {
            if (done) return late(ok);
            if (ac.signal.aborted) { settle({ kind: "cancel" }); return late(ok); }
            if (now() >= until) { settle({ kind: "timeout" }); return late(ok); }
            settle(x);
          };
          let p;
          try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
          p.then(v => arrive(true, { kind: "value", v }), e => arrive(false, { kind: "error", e }));
          /* fn 可能同步阻塞：它返回之后再查一次 */
          if (ac.signal.aborted) return void settle({ kind: "cancel" });
          const left = until - now();
          if (left <= 0) return void settle({ kind: "timeout" });
          ac.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => settle({ kind: "timeout" }), left);
        });
      }
      const interrupted = (g, what) => g.kind === "cancel"
        ? fail("CANCELLED", `cancelled while waiting for ${what}`)
        : fail("TIMEOUT", `${what} exceeded the time budget`);
      /* 提交点检查：采用任何结果之前，已取消 / 已过截止时间就停（trace 回调等同步代码可能刚 abort 或占掉了预算） */
      const halted = () => ac.signal.aborted ? fail("CANCELLED", "cancelled")
        : now() >= deadline ? fail("TIMEOUT", "time budget used up") : null;
      const repairOrStop = (code, message) => {
        invalid++;
        trace("invalid", { ok: false, code });
        if (invalid > maxInvalid) return fail(code, message);
        messages.push({ role: "harness", error: { code, message } });
        return null;
      };

      while (true) {
        const h0 = halted();
        if (h0) return h0;
        if (steps >= maxSteps) return fail("MAX_STEPS", `no final answer after ${maxSteps} model turns`);
        steps++;

        /* ---- 问模型（reject 重试 modelRetries 次；超时 / 取消不重试） ---- */
        let turn;
        for (let attempt = 0; ; attempt++) {
          const req = Object.freeze({ system: r.system, messages: deepFreeze(clone(messages)), tools: toolDefs, step: steps, signal: ac.signal });
          const g = await guard(() => model.next(req), Math.min(now() + stepTimeoutMs, deadline), "model");
          if (g.kind === "timeout" || g.kind === "cancel") return interrupted(g, "the model");
          if (g.kind === "value") { trace("model", { ok: true }); turn = g.v; break; }
          const msg = String((g.e && g.e.message) || g.e);
          if (attempt >= modelRetries) { trace("model", { ok: false, code: "MODEL_ERROR" }); return fail("MODEL_ERROR", msg.slice(0, 300)); }
          trace("retry", { ok: false, code: "MODEL_ERROR" });
        }

        const t = parseTurn(turn);
        if (!t.ok) { const s = repairOrStop("BAD_MODEL_OUTPUT", t.message); if (s) return s; continue; }

        /* ---- 工具调用：名单 → 副作用未知 → registry ---- */
        if (t.type === "tool_call") {
          const id = "c" + steps;
          messages.push({ role: "assistant", toolCall: { id, tool: t.tool, input: t.input } });
          let res;
          if (!allow.has(t.tool)) res = { ok: false, error: { code: "TOOL_NOT_ALLOWED", message: `${t.tool} is not available in this conversation` } };
          else if (uncertain.has(t.tool)) res = { ok: false, error: { code: "UNCERTAIN_SIDE_EFFECT", message: `${t.tool} already ran with an unknown outcome in this run; not calling it again` } };
          else {
            const g = await guard(() => registry.invoke(t.tool, ctx, clone(t.input)), deadline, "tool");
            if (g.kind === "timeout" || g.kind === "cancel") { trace("tool", { tool: t.tool, ok: false, code: g.kind === "cancel" ? "CANCELLED" : "TIMEOUT" }); return interrupted(g, `tool ${t.tool}`); }
            res = g.kind === "value" ? normalizeReply(g.v)
              : { ok: false, error: { code: "INTERNAL", message: String((g.e && g.e.message) || g.e), status: 500 } };
            if (!res.ok && risks.get(t.tool) !== "read" && (res.error.code === "TIMEOUT" || res.error.code === "INTERNAL")) uncertain.add(t.tool);
          }
          const code = res.ok ? undefined : res.error.code;
          calls.push(res.ok ? { tool: t.tool, ok: true } : { tool: t.tool, ok: false, code });
          trace("tool", { tool: t.tool, ok: res.ok, code });
          const obs = observe(id, t.tool, res);
          messages.push(obs);
          /* 证据（#38）：模型完整看到的成功结果，连同入参，交给 validateFinal 做「声明要有证据」的检查；被截断的结果不算证据 */
          if (res.ok && !obs.truncated) evidence.push({ tool: t.tool, input: clone(t.input), result: obs.result });
          continue;
        }

        /* ---- final：结果校验（可 async，也受总时限约束） ---- */
        let output = t.output;
        if (typeof r.validateFinal === "function") {
          const g = await guard(() => r.validateFinal(clone(output), { calls: clone(calls), steps, evidence: clone(evidence) }), deadline, "validate");
          if (g.kind === "timeout" || g.kind === "cancel") return interrupted(g, "result validation");
          if (g.kind === "error") {
            messages.push({ role: "assistant", final: output });
            const s = repairOrStop("INVALID_FINAL", String((g.e && g.e.message) || g.e).slice(0, 500));
            if (s) return s;
            continue;
          }
          if (g.v !== undefined) output = g.v;
        }
        const h2 = halted();
        if (h2) return h2;
        trace("final", { ok: true });
        return stop({ ok: true, output });
      }
    } catch (e) {
      /* 兜底：describe 抛错、调用方的对象读不了之类，run 也只 resolve 一个 INTERNAL */
      return fail("INTERNAL", String((e && e.message) || e).slice(0, 300));
    }
  }

  return { run, tools: [...allow], allowRisks: [...allowRisks] };
}

module.exports = { createHarness, STOP_CODES, jsonProblem };
