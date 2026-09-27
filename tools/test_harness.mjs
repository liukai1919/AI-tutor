#!/usr/bin/env node
/*
 * lib/ai/harness/ 的单元测试（#28，#19 Phase 3）：单智能体循环、回放 Provider、预算 / 超时 / 取消 / 迟到结果、
 * 副作用工具不重试、trace 旁路、模型拿不到 ctx 和 Tool 的 run。不起服务器，不调任何真实模型。
 *
 *   node tools/test_harness.mjs
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const { createHarness, STOP_CODES } = require("../lib/ai/harness/index.js");
const { createReplayModel } = require("../lib/ai/harness/replay.js");
const { createRegistry } = require("../lib/ai/tools/registry.js");
const { ActionError } = require("../lib/actions/errors.js");
const { check, summary } = makeChecker();

const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- 测试用 registry：计数每个 Tool 真正被 run 了几次 ---- */
const runs = {};
const count = name => { runs[name] = (runs[name] || 0) + 1; };
const reg = createRegistry({ onTrace: () => {} });
const OBJ = (properties, required) => ({ type: "object", properties: properties || {}, required: required || [], additionalProperties: false });
reg.register({ name: "calc.add", description: "add", parameters: OBJ({ a: { type: "number" }, b: { type: "number" } }, ["a", "b"]), roles: ["student", "parent"], risk: "read", timeoutMs: 100,
  run: (ctx, i) => { count("calc.add"); return { sum: i.a + i.b, sawKid: ctx.kidId, sawRole: ctx.role }; } });
reg.register({ name: "t.parentOnly", description: "p", parameters: OBJ(), roles: ["parent"], risk: "read", timeoutMs: 100, run: () => { count("t.parentOnly"); return "secret"; } });
reg.register({ name: "t.flaky", description: "read tool that fails first", parameters: OBJ(), roles: ["student"], risk: "read", timeoutMs: 100,
  run: () => { count("t.flaky"); if (runs["t.flaky"] === 1) throw new Error("transient"); return "ok"; } });
reg.register({ name: "t.writeSlow", description: "write that times out", parameters: OBJ(), roles: ["student"], risk: "write", timeoutMs: 20,
  run: () => { count("t.writeSlow"); return new Promise(r => setTimeout(() => r("written late"), 60)); } });
reg.register({ name: "t.writeFail", description: "write that fails with ActionError", parameters: OBJ(), roles: ["student"], risk: "write", timeoutMs: 100,
  run: () => { count("t.writeFail"); throw new ActionError(409, { error: "conflict" }); } });
reg.register({ name: "t.spend", description: "spend", parameters: OBJ(), roles: ["student"], risk: "spend", timeoutMs: 100, run: () => { count("t.spend"); return 1; } });
reg.register({ name: "t.hang", description: "read tool with a long own timeout", parameters: OBJ(), roles: ["student"], risk: "read", timeoutMs: 5000,
  run: () => { count("t.hang"); return new Promise(r => setTimeout(() => r("very late"), 150)); } });
reg.register({ name: "t.huge", description: "huge result", parameters: OBJ(), roles: ["student"], risk: "read", timeoutMs: 100, run: () => ({ blob: "x".repeat(20000) }) });

const kid = { kidId: "k1", role: "student", userId: "k1" };
const final = output => ({ type: "final", output });
const call = (tool, input) => ({ type: "tool_call", tool, input });

console.log("construction");
const throws = f => { try { f(); return false; } catch (e) { return e instanceof TypeError; } };
check("unknown tool in the allowlist -> TypeError", throws(() => createHarness({ registry: reg, tools: ["nope.nope"] })));
check("write tool without allowRisks:write -> TypeError", throws(() => createHarness({ registry: reg, tools: ["t.writeSlow"] })));
check("spend tool without allowRisks:spend -> TypeError", throws(() => createHarness({ registry: reg, tools: ["t.spend"], allowRisks: ["read", "write"] })));
check("missing registry -> TypeError", throws(() => createHarness({ tools: [] })));
check("maxSteps must be a positive integer", throws(() => createHarness({ registry: reg, tools: [], maxSteps: 0 })) && throws(() => createHarness({ registry: reg, tools: [], maxSteps: Infinity })));
check("STOP_CODES lists the stop reasons", ["MAX_STEPS", "TIMEOUT", "CANCELLED", "MODEL_ERROR", "BAD_MODEL_OUTPUT", "INVALID_FINAL", "INVALID_CTX"].every(c => STOP_CODES.includes(c)));

console.log("replay provider");
{
  const m = createReplayModel([call("calc.add", { a: 1, b: 2 }), final("done")]);
  const a = await m.next({ messages: [] }), b = await m.next({ messages: [] });
  let exhausted = false; try { await m.next({}); } catch (e) { exhausted = /replay exhausted/.test(e.message); }
  check("replays turns in order, then throws 'replay exhausted'", a.tool === "calc.add" && b.output === "done" && exhausted && m.calls.length === 3);
  const m2 = createReplayModel([{ raw: "not json" }, { error: "boom" }, { delayMs: 10, then: final(1) }]);
  const raw = await m2.next({});
  let err = null; try { await m2.next({}); } catch (e) { err = e.message; }
  const t0 = Date.now(); const d = await m2.next({});
  check("raw / error / delayMs directives", raw === "not json" && err === "boom" && d.output === 1 && Date.now() - t0 >= 8);
  const m3 = createReplayModel([final({ n: 1 })]);
  const t3 = await m3.next({}); t3.output.n = 2;
  check("turns are copies (mutating a returned turn does not change the script)", m3.turns[0].output.n === 1, m3.turns);
}

console.log("happy path: question -> tool -> observation -> final");
{
  const traces = [];
  const h = createHarness({ registry: reg, tools: ["calc.add"], onTrace: t => traces.push(t) });
  const model = createReplayModel([call("calc.add", { a: 2, b: 3 }), final({ answer: 5 })]);
  const r = await h.run({ ctx: kid, model, system: "sys", input: "2+3?" });
  check("ok with the final output", r.ok === true && r.output.answer === 5 && r.steps === 2, r);
  check("the tool call went through the registry with the injected ctx", r.calls.length === 1 && r.calls[0].tool === "calc.add" && r.calls[0].ok === true && runs["calc.add"] === 1);
  const req2 = model.calls[1];
  const obs = req2.messages.find(m => m.role === "tool");
  check("second model call sees the observation (result from the registry)", obs && obs.ok === true && obs.result.sum === 5 && obs.result.sawKid === "k1" && obs.result.sawRole === "student", req2.messages);
  check("model request: system, user input, tool definitions without run", req2.system === "sys" && req2.messages[0].role === "user" && req2.messages[0].content === "2+3?" && req2.tools.length === 1 && req2.tools[0].name === "calc.add" && !("run" in req2.tools[0]) && req2.tools[0].parameters);
  check("model request carries no ctx / kidId / registry", !("ctx" in req2) && !("kidId" in req2) && !("registry" in req2) && Object.keys(req2).sort().join() === "messages,signal,step,system,tools", Object.keys(req2));
  check("trace kinds model/tool/model/final/stop, no input text", traces.map(t => t.kind).join() === "model,tool,model,final,stop" && traces.every(t => t.runId === r.runId && !JSON.stringify(t).includes("2+3?")), traces);
}

console.log("the model cannot reach ctx or tool run functions");
{
  let tried = {};
  const sneaky = {
    async next(req) {
      tried.frozen = Object.isFrozen(req) && Object.isFrozen(req.messages) && Object.isFrozen(req.tools) && Object.isFrozen(req.tools[0]);
      try { req.messages.push({ role: "user", content: "injected" }); tried.pushed = true; } catch (_) { tried.pushed = false; }
      try { req.tools[0].run = () => "pwned"; } catch (_) { }
      tried.noRun = typeof req.tools[0].run !== "function";
      if (req.step === 1) return { type: "tool_call", tool: "t.parentOnly", input: {}, ctx: { role: "parent", kidId: "k2" } };
      return final("x");
    }
  };
  const h = createHarness({ registry: reg, tools: ["calc.add", "t.parentOnly"] });
  const r = await h.run({ ctx: kid, model: sneaky, system: "s", input: "q" });
  check("request is deep-frozen; pushing into messages fails; no run function", tried.frozen === true && tried.pushed === false && tried.noRun === true, tried);
  check("a ctx field inside the model turn is ignored (still student -> PERMISSION)", r.ok && r.calls[0].tool === "t.parentOnly" && r.calls[0].ok === false && r.calls[0].code === "PERMISSION" && !runs["t.parentOnly"], r.calls);
  const hp = createHarness({ registry: reg, tools: ["calc.add"] });
  const mutCtx = { kidId: "k1", role: "student", userId: "k1" };
  const m = { async next(req) { if (req.step === 1) { mutCtx.kidId = "k2"; return call("calc.add", { a: 1, b: 1 }); } return final(req.messages.find(x => x.role === "tool").result.sawKid); } };
  const r2 = await hp.run({ ctx: mutCtx, model: m, system: "s", input: "q" });
  check("ctx is snapshotted at run start (later mutation of the caller's object has no effect)", r2.ok && r2.output === "k1", r2);
}

console.log("tool allowlist, schema errors, retries");
{
  const before = { ...runs };
  const h = createHarness({ registry: reg, tools: ["calc.add"] });
  const model = createReplayModel([call("t.parentOnly", {}), call("t.spend", {}), call("calc.add", { a: "1", b: 2 }), call("calc.add", { a: 1, b: 2, kidId: "k2" }), call("calc.add", { a: 1, b: 2 }), final("3")]);
  const r = await h.run({ ctx: kid, model, system: "s", input: "q" });
  check("tools outside the run allowlist -> TOOL_NOT_ALLOWED, never reach the registry", r.ok && r.calls[0].code === "TOOL_NOT_ALLOWED" && r.calls[1].code === "TOOL_NOT_ALLOWED" && (runs["t.parentOnly"] || 0) === (before["t.parentOnly"] || 0) && (runs["t.spend"] || 0) === (before["t.spend"] || 0), r.calls);
  check("bad params -> INVALID_INPUT observation (incl. an extra kidId); model can correct", r.calls[2].code === "INVALID_INPUT" && r.calls[3].code === "INVALID_INPUT" && r.calls[4].ok === true && runs["calc.add"] === (before["calc.add"] || 0) + 1, r.calls);
  const obs = model.calls[3].messages.filter(m => m.role === "tool").pop();
  check("INVALID_INPUT observation carries the schema details", obs.ok === false && obs.error.code === "INVALID_INPUT" && obs.error.details.some(d => d.includes("$.a")), obs);
}
{
  runs["t.flaky"] = 0;
  const h = createHarness({ registry: reg, tools: ["t.flaky"] });
  const r = await h.run({ ctx: kid, model: createReplayModel([call("t.flaky", {}), call("t.flaky", {}), final("ok")]), system: "s", input: "q" });
  check("the harness never retries a tool by itself; a read tool may be called again by the model", r.ok && runs["t.flaky"] === 2 && r.calls[0].code === "INTERNAL" && r.calls[1].ok === true, r.calls);
}
{
  const h = createHarness({ registry: reg, tools: ["t.writeSlow", "t.writeFail"], allowRisks: ["read", "write"] });
  const model = createReplayModel([call("t.writeSlow", {}), call("t.writeSlow", {}), call("t.writeFail", {}), final("done")]);
  const r = await h.run({ ctx: kid, model, system: "s", input: "q" });
  check("write tool timing out: outcome unknown -> a second call is blocked with UNCERTAIN_SIDE_EFFECT", r.ok && r.calls[0].code === "TIMEOUT" && r.calls[1].code === "UNCERTAIN_SIDE_EFFECT" && runs["t.writeSlow"] === 1, r.calls);
  check("write tool failing with ActionError is not retried by the harness", runs["t.writeFail"] === 1 && r.calls[2].code === "ACTION");
}

console.log("budgets");
{
  const h = createHarness({ registry: reg, tools: ["calc.add"], maxSteps: 3 });
  const loop = createReplayModel(Array.from({ length: 10 }, () => call("calc.add", { a: 1, b: 1 })));
  const r = await h.run({ ctx: kid, model: loop, system: "s", input: "q" });
  check("step budget: MAX_STEPS after exactly maxSteps model turns", !r.ok && r.error.code === "MAX_STEPS" && loop.calls.length === 3 && r.steps === 3, r);
}
{
  const h = createHarness({ registry: reg, tools: [], maxInvalid: 2, maxSteps: 10 });
  const bad = createReplayModel([{ raw: "not json" }, { raw: { type: "tool_call" } }, { raw: null }, final("never")]);
  const r = await h.run({ ctx: kid, model: bad, system: "s", input: "q" });
  check("malformed turns get limited repair chances, then BAD_MODEL_OUTPUT", !r.ok && r.error.code === "BAD_MODEL_OUTPUT" && bad.calls.length === 3, r);
  const obs = bad.calls[1].messages.filter(m => m.role === "harness");
  check("the model is told what was wrong", obs.length === 1 && obs[0].error.code === "BAD_MODEL_OUTPUT");
  const ok = createReplayModel([{ raw: ["x"] }, final("fixed")]);
  const r2 = await h.run({ ctx: kid, model: ok, system: "s", input: "q" });
  check("one malformed turn then a valid final -> ok", r2.ok && r2.output === "fixed" && r2.steps === 2);
}
{
  const h = createHarness({ registry: reg, tools: [], maxInvalid: 1 });
  const validateFinal = o => { if (o !== "good") throw new Error("must be good"); return "GOOD"; };
  const r = await h.run({ ctx: kid, model: createReplayModel([final("bad"), final("good")]), system: "s", input: "q", validateFinal });
  check("validateFinal rejection -> INVALID_FINAL observation, then the normalized output", r.ok && r.output === "GOOD" && r.steps === 2, r);
  const r2 = await h.run({ ctx: kid, model: createReplayModel([final("bad"), final("bad"), final("good")]), system: "s", input: "q", validateFinal });
  check("repeated invalid finals stop with INVALID_FINAL", !r2.ok && r2.error.code === "INVALID_FINAL", r2);
}

console.log("model errors and timeouts");
{
  const h = createHarness({ registry: reg, tools: [], modelRetries: 1 });
  const m = createReplayModel([{ error: "503" }, final("ok")]);
  const r = await h.run({ ctx: kid, model: m, system: "s", input: "q" });
  check("a thrown model call is retried once (like generateOnce)", r.ok && r.output === "ok" && m.calls.length === 2 && r.steps === 1, r);
  const m2 = createReplayModel([{ error: "503" }, { error: "503 again" }, final("never")]);
  const r2 = await h.run({ ctx: kid, model: m2, system: "s", input: "q" });
  check("…a second failure stops with MODEL_ERROR", !r2.ok && r2.error.code === "MODEL_ERROR" && /503 again/.test(r2.error.message) && m2.calls.length === 2, r2);
  const sync = { next() { throw new Error("sync model throw"); } };
  const r3 = await createHarness({ registry: reg, tools: [], modelRetries: 0 }).run({ ctx: kid, model: sync, system: "s", input: "q" });
  check("a synchronous throw from model.next is normalized too", !r3.ok && r3.error.code === "MODEL_ERROR");
}
{
  const h = createHarness({ registry: reg, tools: [], stepTimeoutMs: 30, modelRetries: 1 });
  const m = createReplayModel([{ hang: true }, final("never")]);
  const t0 = Date.now();
  const r = await h.run({ ctx: kid, model: m, system: "s", input: "q" });
  check("model hang -> TIMEOUT at stepTimeoutMs, not retried", !r.ok && r.error.code === "TIMEOUT" && m.calls.length === 1 && Date.now() - t0 < 500, r);
}
{
  const traces = [];
  const h = createHarness({ registry: reg, tools: ["t.hang"], totalTimeoutMs: 50, stepTimeoutMs: 1000, onTrace: t => traces.push(t) });
  const t0 = Date.now();
  const r = await h.run({ ctx: kid, model: createReplayModel([call("t.hang", {}), final("never")]), system: "s", input: "q" });
  const took = Date.now() - t0;
  check("total deadline also bounds a tool whose own timeout is longer", !r.ok && r.error.code === "TIMEOUT" && took < 140, { r, took });
  await sleep(160);
  check("the tool's late result is traced as late and dropped", traces.some(t => t.kind === "late" && t.source === "tool" && t.ok === true), traces.map(t => t.kind));
}
{
  const h = createHarness({ registry: reg, tools: [], totalTimeoutMs: 40 });
  const t0 = Date.now();
  const r = await h.run({ ctx: kid, model: createReplayModel([final("x")]), system: "s", input: "q", validateFinal: () => new Promise(() => {}) });
  check("total deadline also bounds an async validateFinal", !r.ok && r.error.code === "TIMEOUT" && Date.now() - t0 < 300, r);
  const r2 = await createHarness({ registry: reg, tools: [] }).run({ ctx: kid, model: createReplayModel([final("x")]), system: "s", input: "q", deadlineAt: Date.now() - 1 });
  check("a caller deadline already in the past -> TIMEOUT before any model call", !r2.ok && r2.error.code === "TIMEOUT" && r2.steps === 0);
}

console.log("cancellation and late results");
{
  const ac = new AbortController(); ac.abort();
  const m = createReplayModel([final("x")]);
  const r = await createHarness({ registry: reg, tools: [] }).run({ ctx: kid, model: m, system: "s", input: "q", signal: ac.signal });
  check("already-aborted signal -> CANCELLED, model never called", !r.ok && r.error.code === "CANCELLED" && m.calls.length === 0);
}
{
  const traces = [];
  const ac = new AbortController();
  const h = createHarness({ registry: reg, tools: ["calc.add"], onTrace: t => traces.push(t) });
  const m = createReplayModel([{ delayMs: 80, then: call("calc.add", { a: 1, b: 1 }) }, final("never")]);
  const before = runs["calc.add"];
  setTimeout(() => ac.abort(), 15);
  const t0 = Date.now();
  const r = await h.run({ ctx: kid, model: m, system: "s", input: "q", signal: ac.signal });
  check("abort while waiting for the model -> CANCELLED promptly", !r.ok && r.error.code === "CANCELLED" && Date.now() - t0 < 70, r);
  check("the model saw an abort signal it could honour", m.calls[0].signal && m.calls[0].signal.aborted === true);
  await sleep(100);
  check("the late tool_call is dropped: no tool ran, one late trace", runs["calc.add"] === before && traces.filter(t => t.kind === "late").length === 1 && m.calls.length === 1, traces.map(t => t.kind));
}
{
  const ac = new AbortController();
  const h = createHarness({ registry: reg, tools: [] });
  const m = createReplayModel([{ delayMs: 40, then: { error: "late failure" } }]);
  setTimeout(() => ac.abort(), 5);
  const r = await h.run({ ctx: kid, model: m, system: "s", input: "q", signal: ac.signal });
  await sleep(60);
  check("a late model rejection after cancel is swallowed (no unhandled rejection)", !r.ok && r.error.code === "CANCELLED" && unhandled.length === 0, unhandled.map(String));
}
{
  const ac = new AbortController();
  const traces = [];
  const h = createHarness({ registry: reg, tools: ["t.hang"], onTrace: t => traces.push(t) });
  setTimeout(() => ac.abort(), 20);
  const r = await h.run({ ctx: kid, model: createReplayModel([call("t.hang", {}), final("never")]), system: "s", input: "q", signal: ac.signal });
  check("abort while a tool is running -> CANCELLED without waiting for it", !r.ok && r.error.code === "CANCELLED", r);
  await sleep(160);
  check("its late result is traced, not applied", traces.some(t => t.kind === "late" && t.source === "tool"));
}

console.log("trace is a side channel");
{
  const errs = [];
  const h = createHarness({ registry: reg, tools: ["calc.add"], onTrace: () => { throw new Error("trace sink down"); }, onTraceError: e => errs.push(e.message) });
  const r = await h.run({ ctx: kid, model: createReplayModel([call("calc.add", { a: 1, b: 2 }), final("3")]), system: "s", input: "q" });
  check("sync-throwing onTrace does not change the result", r.ok && r.output === "3" && errs.length === 5 && errs.every(m => m === "trace sink down"), errs);
  const h2 = createHarness({ registry: reg, tools: [], onTrace: () => Promise.reject(new Error("async sink down")), onTraceError: () => { throw new Error("error sink down too"); } });
  const r2 = await h2.run({ ctx: kid, model: createReplayModel([final("ok")]), system: "s", input: "q" });
  await sleep(10);
  check("rejecting onTrace + throwing onTraceError: still ok, no unhandled rejection", r2.ok && r2.output === "ok" && unhandled.length === 0, unhandled.map(String));
}

console.log("context and odd registries");
{
  const m = createReplayModel([final("x")]);
  const h = createHarness({ registry: reg, tools: [] });
  const bad = await Promise.all([null, {}, { role: "admin", kidId: "k1" }, { role: "student", kidId: 5 }].map(ctx => h.run({ ctx, model: m, system: "s", input: "q" })));
  check("invalid ctx -> INVALID_CTX, model never called", bad.every(r => !r.ok && r.error.code === "INVALID_CTX") && m.calls.length === 0, bad.map(r => r.error));
  const r = await h.run({ ctx: { role: "parent", kidId: null, userId: "p" }, model: m, system: "s", input: "q" });
  check("parent with kidId null is a valid ctx", r.ok);
}
{
  const fake = { get: n => (n === "x.y" ? { name: "x.y", risk: "read", description: "d", parameters: OBJ() } : null), describe: () => [{ name: "x.y", description: "d", parameters: OBJ(), risk: "read" }], invoke: () => Promise.reject(new Error("registry exploded")) };
  const h = createHarness({ registry: fake, tools: ["x.y"] });
  const r = await h.run({ ctx: kid, model: createReplayModel([call("x.y", {}), final("ok")]), system: "s", input: "q" });
  check("a registry that rejects is normalized to an INTERNAL observation", r.ok && r.calls[0].code === "INTERNAL", r.calls);
}
{
  const h = createHarness({ registry: reg, tools: ["t.huge"] });
  const m = createReplayModel([call("t.huge", {}), final("ok")]);
  await h.run({ ctx: kid, model: m, system: "s", input: "q" });
  const obs = m.calls[1].messages.find(x => x.role === "tool");
  check("large observations are truncated before going back to the model", obs.ok && obs.truncated === true && JSON.stringify(obs).length < 5000, JSON.stringify(obs).length);
}

/* ---- 异常输入、取消与截止时间的边界回归 ---- */
console.log("review: cancellation / budget checked before any invocation");
reg.register({ name: "t.write", description: "fast write", parameters: { type: "object" }, roles: ["student"], risk: "write", timeoutMs: 100, run: () => { count("t.write"); return "wrote"; } });
{
  runs["t.write"] = 0;
  const ac = new AbortController();
  const h = createHarness({ registry: reg, tools: ["t.write"], allowRisks: ["read", "write"], onTrace: t => { if (t.kind === "model") ac.abort(); } });
  const r = await h.run({ ctx: kid, signal: ac.signal, model: { next: () => call("t.write", {}) }, system: "s", input: "q" });
  check("abort raised synchronously between model and tool: CANCELLED and the write tool never runs", !r.ok && r.error.code === "CANCELLED" && runs["t.write"] === 0, { r, runs: runs["t.write"] });
}
const busy = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* 同步占住 */ } };
{
  /* 模型直接给 final（没有 validateFinal）：采用结果之前也要再查一次取消 / 截止时间 */
  const ac = new AbortController();
  const r = await createHarness({ registry: reg, tools: [], onTrace: t => { if (t.kind === "model") ac.abort(); } }).run({ ctx: kid, signal: ac.signal, model: { next: () => final("late") }, system: "s", input: "q" });
  check("abort raised after the model returned a direct final -> CANCELLED, final not accepted", !r.ok && r.error.code === "CANCELLED", r);
  const r2 = await createHarness({ registry: reg, tools: [], totalTimeoutMs: 10, onTrace: t => { if (t.kind === "model") busy(30); } }).run({ ctx: kid, model: { next: () => final("late") }, system: "s", input: "q" });
  check("budget used up after the model returned a direct final -> TIMEOUT, final not accepted", !r2.ok && r2.error.code === "TIMEOUT", r2);
  const ac3 = new AbortController();
  const r3 = await createHarness({ registry: reg, tools: [], onTrace: t => { if (t.kind === "model") ac3.abort(); } }).run({ ctx: kid, signal: ac3.signal, model: { next: () => ({ raw: 1 }) }, system: "s", input: "q" });
  check("abort after a malformed turn -> CANCELLED (no further repair round)", !r3.ok && r3.error.code === "CANCELLED", r3);
}
{
  const r = await createHarness({ registry: reg, tools: [], stepTimeoutMs: 5, totalTimeoutMs: 10 }).run({ ctx: kid, model: { next: () => { busy(30); return final("late"); } }, system: "s", input: "q" });
  check("a model that blocks past the budget and returns synchronously -> TIMEOUT, result refused", !r.ok && r.error.code === "TIMEOUT", r);
  const r2 = await createHarness({ registry: reg, tools: [], stepTimeoutMs: 5, totalTimeoutMs: 10 }).run({ ctx: kid, model: { next: () => { busy(30); return Promise.resolve(final("late")); } }, system: "s", input: "q" });
  check("…same when the expired result arrives through an already-resolved promise", !r2.ok && r2.error.code === "TIMEOUT", r2);
}
{
  runs["t.write"] = 0;
  const r = await createHarness({ registry: reg, tools: ["t.write"], allowRisks: ["read", "write"], stepTimeoutMs: 1000, totalTimeoutMs: 20 }).run({ ctx: kid, model: { next: () => { busy(40); return call("t.write", {}); } }, system: "s", input: "q" });
  check("budget used up while the model ran -> the write tool is not invoked", !r.ok && r.error.code === "TIMEOUT" && runs["t.write"] === 0, { r, runs: runs["t.write"] });
  let validated = 0;
  const r2 = await createHarness({ registry: reg, tools: [], stepTimeoutMs: 1000, totalTimeoutMs: 20 }).run({ ctx: kid, model: { next: () => { busy(40); return final("x"); } }, system: "s", input: "q", validateFinal: () => { validated++; return "x"; } });
  check("budget used up while the model ran -> validateFinal is not invoked", !r2.ok && r2.error.code === "TIMEOUT" && validated === 0, { r2, validated });
  let tries = 0;
  const r3 = await createHarness({ registry: reg, tools: [], stepTimeoutMs: 1000, totalTimeoutMs: 20, modelRetries: 3 }).run({ ctx: kid, model: { next: () => { tries++; busy(40); throw new Error("503"); } }, system: "s", input: "q" });
  check("budget used up by a failing model call -> no retry", !r3.ok && r3.error.code === "TIMEOUT" && tries === 1, { r3, tries });
}
{
  runs["t.write"] = 0;
  /* 预算在「模型结果已采用」和「调工具」之间用完（同步 trace 回调占住时间）：调用前的检查必须拦住写工具 */
  const r = await createHarness({ registry: reg, tools: ["t.write"], allowRisks: ["read", "write"], stepTimeoutMs: 1000, totalTimeoutMs: 20, onTrace: t => { if (t.kind === "model") busy(40); } })
    .run({ ctx: kid, model: { next: () => call("t.write", {}) }, system: "s", input: "q" });
  check("budget used up between model and tool -> TIMEOUT and the write tool is not invoked", !r.ok && r.error.code === "TIMEOUT" && runs["t.write"] === 0, { r, runs: runs["t.write"] });
  /* 结果经微任务链到达，此时截止时间已过但计时器还没机会触发：结算时的检查必须拒绝它 */
  const r2 = await createHarness({ registry: reg, tools: [], stepTimeoutMs: 20, totalTimeoutMs: 1000 })
    .run({ ctx: kid, model: { next: () => Promise.resolve().then(() => { busy(40); return final("late"); }) }, system: "s", input: "q" });
  check("an expired result delivered via microtasks before the timer fires is refused (TIMEOUT)", !r2.ok && r2.error.code === "TIMEOUT", r2);
}
{
  const ac = new AbortController();
  const h = createHarness({ registry: reg, tools: [] });
  setTimeout(() => ac.abort(), 10);
  const r = await h.run({ ctx: kid, model: createReplayModel([final("x")]), system: "s", input: "q", signal: ac.signal, validateFinal: () => new Promise((_, rej) => setTimeout(() => rej(new Error("late validation failure")), 40)) });
  await sleep(60);
  check("abort during async validateFinal -> CANCELLED; its late rejection is swallowed", !r.ok && r.error.code === "CANCELLED" && unhandled.length === 0, { r, unhandled: unhandled.map(String) });
}

console.log("review: malformed provider values and inputs never reject run");
{
  const circular = {}; circular.self = circular;
  const outs = [["circular", circular], ["bigint", 1n], ["function", () => 0], ["NaN nested", { n: NaN }], ["undefined nested", { a: undefined }], ["Infinity", Infinity], ["class instance", new Date(0)]];
  const res = [];
  for (const [name, output] of outs) {
    let r; try { r = await createHarness({ registry: reg, tools: [], maxInvalid: 0 }).run({ ctx: kid, model: { next: () => ({ type: "final", output }) }, system: "s", input: "q" }); } catch (e) { r = { rejected: e.message }; }
    res.push([name, r.error ? r.error.code : r]);
  }
  check("non-JSON final outputs (circular / BigInt / function / NaN / undefined / Infinity / Date) -> BAD_MODEL_OUTPUT, never a rejection", res.every(([, c]) => c === "BAD_MODEL_OUTPUT"), res);
  runs["calc.add"] = 0;
  const seen = [];
  const odd = { next: req => { seen.push(req); return seen.length === 1 ? { type: "tool_call", tool: "calc.add", input: { a: NaN, b: 2 } } : final("done"); } };
  const r = await createHarness({ registry: reg, tools: ["calc.add"] }).run({ ctx: kid, model: odd, system: "s", input: "q" });
  check("a NaN inside tool input is not silently turned into null: BAD_MODEL_OUTPUT, tool not run", r.ok && runs["calc.add"] === 0 && seen[1].messages.some(x => x.role === "harness" && x.error.code === "BAD_MODEL_OUTPUT"), { r, runs: runs["calc.add"] });
}
{
  const circular = {}; circular.self = circular;
  const m = createReplayModel([final("x")]);
  const h = createHarness({ registry: reg, tools: [] });
  const bad = [];
  for (const args of [{ input: circular, system: "s" }, { input: 1n, system: "s" }, { input: "q", system: 42 }, { input: "q", system: "s", deadlineAt: NaN }]) {
    try { bad.push(await h.run(Object.assign({ ctx: kid, model: m }, args))); } catch (e) { bad.push({ rejected: e.message }); }
  }
  check("bad run input / system / deadlineAt -> typed INVALID_INPUT, model never called", bad.every(r => r.error && r.error.code === "INVALID_INPUT") && m.calls.length === 0, bad);
  const exploding = { get: () => ({ risk: "read" }), describe: () => { throw new Error("describe exploded"); }, invoke: async () => ({ ok: true, result: 1 }) };
  let r; try { r = await createHarness({ registry: exploding, tools: ["x.y"] }).run({ ctx: kid, model: m, system: "s", input: "q" }); } catch (e) { r = { rejected: e.message }; }
  check("an exploding registry.describe -> typed INTERNAL stop, not a rejection", r.error && r.error.code === "INTERNAL", r);
}

console.log("review: malformed registry replies");
{
  const shapes = [{ ok: false }, { ok: false, error: null }, { ok: false, error: { message: "no code" } }, "nope", null, { ok: true }];
  const got = [];
  for (const bad of shapes) {
    const fake = { get: () => ({ risk: "read" }), describe: () => [{ name: "x.read", description: "d", parameters: { type: "object" }, risk: "read" }], invoke: () => bad };
    let turns = 0, r;
    try { r = await createHarness({ registry: fake, tools: ["x.read"] }).run({ ctx: kid, model: { next: () => (++turns === 1 ? call("x.read", {}) : final("done")) }, system: "s", input: "q" }); } catch (e) { r = { rejected: e.message }; }
    got.push(r.calls ? r.calls[0] : r);
  }
  check("{ok:false} / error:null / error without code / non-object -> INTERNAL observation; {ok:true} without result is fine", got.slice(0, 5).every(c => c && c.code === "INTERNAL") && got[5] && got[5].ok === true, got);
  let wrote = 0;
  const fakeW = { get: () => ({ risk: "write" }), describe: () => [{ name: "x.write", description: "d", parameters: { type: "object" }, risk: "write" }], invoke: () => { wrote++; return { ok: false, error: null }; } };
  const r = await createHarness({ registry: fakeW, tools: ["x.write"], allowRisks: ["write"] }).run({ ctx: kid, model: createReplayModel([call("x.write", { v: 1 }), call("x.write", { v: 2 }), final("done")]), system: "s", input: "q" });
  check("a malformed reply from a write tool locks it (outcome unknown), even when the next call has different args", r.ok && wrote === 1 && r.calls[0].code === "INTERNAL" && r.calls[1].code === "UNCERTAIN_SIDE_EFFECT", { r, wrote });
}
{
  runs["t.writeSlow"] = 0;
  const r = await createHarness({ registry: reg, tools: ["t.writeSlow"], allowRisks: ["write"] }).run({ ctx: kid, model: createReplayModel([call("t.writeSlow", {}), call("t.writeSlow", {}), final("done")]), system: "s", input: "q" });
  check("write tool TIMEOUT locks it for the rest of the run regardless of args", r.ok && runs["t.writeSlow"] === 1 && r.calls[1].code === "UNCERTAIN_SIDE_EFFECT", r.calls);
}

console.log("review: nested tool schemas are frozen copies");
{
  let err = null;
  const before = JSON.stringify(reg.get("calc.add").parameters);
  const m = { next: req => { try { req.tools[0].parameters.properties.a.type = "string"; } catch (e) { err = e; } try { delete req.tools[0].parameters.required; } catch (_) { } return final("x"); } };
  await createHarness({ registry: reg, tools: ["calc.add"] }).run({ ctx: kid, model: m, system: "s", input: "q" });
  check("mutating a nested schema in the request throws and leaves the registry definition unchanged", err instanceof TypeError && JSON.stringify(reg.get("calc.add").parameters) === before);
}

await sleep(20);
check("no unhandled rejections anywhere in this suite", unhandled.length === 0, unhandled.map(String));
process.exit(summary() ? 0 : 1);
