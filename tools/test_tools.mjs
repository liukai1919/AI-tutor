#!/usr/bin/env node
/*
 * lib/ai/tools/ 的单元测试（#26）：schema 校验、registry 的五种错误归一化、超时、trace、
 * Tool 定义是否只转调 Action、calculator。不起服务器。
 *
 *   node tools/test_tools.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const { check: schemaCheck } = require("../lib/ai/tools/schema.js");
const { createRegistry, CODES } = require("../lib/ai/tools/registry.js");
const { createTools, calculator } = require("../lib/ai/tools/index.js");
const { ActionError } = require("../lib/actions/errors.js");
const { check, summary } = makeChecker();

console.log("schema");
const S = { type: "object", properties: { a: { type: "integer", minimum: 0, maximum: 3 }, s: { type: "string", enum: ["x", "y"] }, l: { type: "array", items: { type: "number" }, maxItems: 2 }, g: { anyOf: [{ type: "integer" }, { type: "string" }] } }, required: ["a"], additionalProperties: false };
check("valid", schemaCheck(S, { a: 2, s: "x", l: [1, 2], g: "pc11" }).ok);
check("missing required", schemaCheck(S, {}).errors.join() === "$.a: required");
check("integer rejects 1.5 and range", !schemaCheck(S, { a: 1.5 }).ok && !schemaCheck(S, { a: 4 }).ok && !schemaCheck(S, { a: -1 }).ok);
check("enum / items / maxItems / additionalProperties", !schemaCheck(S, { a: 1, s: "z" }).ok && !schemaCheck(S, { a: 1, l: ["q"] }).ok && !schemaCheck(S, { a: 1, l: [1, 2, 3] }).ok && schemaCheck(S, { a: 1, extra: 1 }).errors.join() === "$.extra: not allowed");
check("anyOf", schemaCheck(S, { a: 1, g: 4 }).ok && !schemaCheck(S, { a: 1, g: true }).ok);
check("non-object input against object schema", !schemaCheck(S, "nope").ok && !schemaCheck(S, null).ok);
/* 声明 / required 只认 own property：Object.prototype 上的 constructor / toString / __proto__ 不算声明过的字段 */
const S0 = { type: "object", properties: {}, additionalProperties: false };
const protoKeys = ['{"constructor":1}', '{"__proto__":{"polluted":1}}', '{"toString":1}', '{"hasOwnProperty":1}', '{"valueOf":{}}'];
check("additionalProperties:false rejects prototype-named keys", protoKeys.every(j => { const v = schemaCheck(S0, JSON.parse(j)); return !v.ok && v.errors.length === 1 && / not allowed$/.test(v.errors[0]); }), protoKeys.map(j => schemaCheck(S0, JSON.parse(j))));
check("…and checking a __proto__ key does not pollute Object.prototype", ({}).polluted === undefined && schemaCheck(S, JSON.parse('{"a":1,"__proto__":{"polluted":1}}')).errors.join() === "$.__proto__: not allowed");
check("inherited properties are not declared properties", !schemaCheck({ type: "object", properties: Object.create({ sneaky: { type: "string" } }), additionalProperties: false }, { sneaky: "x" }).ok);
check("required uses own properties (toString / constructor missing -> required)", schemaCheck({ type: "object", required: ["toString", "constructor"] }, {}).errors.join() === "$.toString: required,$.constructor: required" && schemaCheck({ type: "object", properties: { toString: { type: "string" } }, required: ["toString"] }, JSON.parse('{"toString":"x"}')).ok);
check("a declared prototype-named key is still validated", !schemaCheck({ type: "object", properties: { constructor: { type: "string" } } }, JSON.parse('{"constructor":1}')).ok);
check("number rejects NaN / Infinity / -Infinity", [NaN, Infinity, -Infinity].every(n => !schemaCheck({ type: "number" }, n).ok && !schemaCheck({ type: "number", minimum: 0 }, n).ok && !schemaCheck({ type: ["number", "null"] }, n).ok) && schemaCheck({ type: "number" }, 1.5).ok && schemaCheck({ type: ["number", "null"] }, null).ok);
check("anyOf does not skip sibling constraints", !schemaCheck({ anyOf: [{ type: "integer" }, { type: "string" }], enum: [1, "a"] }, 2).ok && schemaCheck({ anyOf: [{ type: "integer" }, { type: "string" }], enum: [1, "a"] }, "a").ok && !schemaCheck({ anyOf: [{ type: "integer" }, { type: "string" }], minimum: 0 }, -1).ok && !schemaCheck({ type: "object", required: ["a"], anyOf: [{ type: "object" }] }, {}).ok && schemaCheck({ anyOf: [{ type: "integer" }, { type: "string" }] }, true).errors.join() === "$: matches none of anyOf");

console.log("registry");
const traces = [];
let clock = 1000;
const reg = createRegistry({ onTrace: t => traces.push(t), now: () => clock });
check("register validates the definition", ["name", "roles", "risk", "run"].every(k => { try { const d = { name: "a.b", description: "d", parameters: {}, roles: ["student"], risk: "read", timeoutMs: 10, run: () => 1 }; delete d[k]; reg.register(d); return false; } catch (e) { return e instanceof TypeError; } }));
check("register rejects bad names / risk / duplicates", [() => reg.register({ name: "bad", description: "d", parameters: {}, roles: ["student"], risk: "read", timeoutMs: 10, run: () => 1 }), () => reg.register({ name: "a.b", description: "d", parameters: {}, roles: ["student"], risk: "huge", timeoutMs: 10, run: () => 1 })].every(f => { try { f(); return false; } catch (e) { return e instanceof TypeError; } }));
reg.register({ name: "t.echo", description: "echo", parameters: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false }, roles: ["student", "parent"], risk: "read", timeoutMs: 50, run: (ctx, i) => ({ x: i.x, kid: ctx.kidId }) });
reg.register({ name: "t.slow", description: "slow", parameters: { type: "object" }, roles: ["student"], risk: "read", timeoutMs: 20, run: () => new Promise(r => setTimeout(() => r("late"), 200)) });
reg.register({ name: "t.parentOnly", description: "p", parameters: { type: "object" }, roles: ["parent"], risk: "write", timeoutMs: 20, run: () => "secret" });
reg.register({ name: "t.actionErr", description: "a", parameters: { type: "object" }, roles: ["student"], risk: "read", timeoutMs: 20, run: () => { throw new ActionError(404, { error: "nope / Not found", missing: true }); } });
reg.register({ name: "t.boom", description: "b", parameters: { type: "object" }, roles: ["student"], risk: "read", timeoutMs: 20, run: () => { throw Object.assign(new Error("disk"), { status: 500, saveFailed: true }); } });
reg.register({ name: "t.sync", description: "s", parameters: { type: "object" }, roles: ["student"], risk: "read", timeoutMs: 20, run: () => { throw new Error("sync throw"); } });
check("duplicate name rejected", (() => { try { reg.register({ name: "t.echo", description: "d", parameters: {}, roles: ["student"], risk: "read", timeoutMs: 10, run: () => 1 }); return false; } catch (e) { return true; } })());
const kid = { kidId: "k1", role: "student", userId: "k1" };
let r = await reg.invoke("t.echo", kid, { x: 3 });
check("ok: {ok, result, meta.tool/traceId/ms/risk}", r.ok === true && r.result.x === 3 && r.result.kid === "k1" && r.meta.tool === "t.echo" && /^t/.test(r.meta.traceId) && r.meta.ms === 0 && r.meta.risk === "read", r);
r = await reg.invoke("t.nope", kid, {});
check("UNKNOWN_TOOL -> 404", !r.ok && r.error.code === "UNKNOWN_TOOL" && r.error.status === 404);
r = await reg.invoke("t.echo", kid, { x: "3" });
check("INVALID_INPUT -> 400 with details", !r.ok && r.error.code === "INVALID_INPUT" && r.error.status === 400 && r.error.details[0].includes("$.x"), r.error);
r = await reg.invoke("t.echo", kid, undefined);
check("undefined input is treated as {} (then fails required)", !r.ok && r.error.code === "INVALID_INPUT");
r = await reg.invoke("t.parentOnly", kid, {});
check("PERMISSION -> 403 for a student on a parent tool", !r.ok && r.error.code === "PERMISSION" && r.error.status === 403);
r = await reg.invoke("t.parentOnly", { kidId: "k1", role: "parent", userId: "p" }, {});
check("parent may call it", r.ok && r.result === "secret");
r = await reg.invoke("t.slow", kid, {});
check("TIMEOUT -> 504", !r.ok && r.error.code === "TIMEOUT" && r.error.status === 504 && /timed out after 20ms/.test(r.error.message), r.error);
r = await reg.invoke("t.actionErr", kid, {});
check("ACTION -> status and body from the ActionError", !r.ok && r.error.code === "ACTION" && r.error.status === 404 && r.error.details.missing === true, r.error);
r = await reg.invoke("t.boom", kid, {});
check("INTERNAL -> keeps status + saveFailed, no stack", !r.ok && r.error.code === "INTERNAL" && r.error.status === 500 && r.error.saveFailed === true && !("stack" in r.error), r.error);
r = await reg.invoke("t.sync", kid, {});
check("a synchronous throw inside run is also normalized", !r.ok && r.error.code === "INTERNAL" && r.error.message === "sync throw");
check("every failure code is one of CODES", traces.filter(t => !t.ok).every(t => CODES.includes(t.code)));
check("trace per invoke, without input, with role/kid/ms", traces.length === 10 && traces.every(t => t.traceId && t.tool && "ok" in t && typeof t.ms === "number" && !("input" in t)) && traces[0].kidId === "k1" && traces[0].role === "student", traces[0]);
check("list filters by role / group / tag; describe has no run", reg.list({ role: "student" }).length === 5 && reg.list({ group: "t" }).length === 6 && reg.describe({ role: "parent" }).every(d => !("run" in d) && d.parameters && d.description));

console.log("registry: a failing trace callback never breaks invoke");
/* onTrace 同步抛错 / 异步 reject / 默认 log 抛错：invoke 照常 resolve 业务结果或原错误，trace 每次只调一次，不留未处理拒绝 */
const unhandled = [];
const onUnhandled = e => unhandled.push(e);
process.on("unhandledRejection", onUnhandled);
const settle = p => Promise.resolve(p).then(v => v, e => ({ rejected: String(e && e.message || e) }));
const tick = () => new Promise(res => setTimeout(res, 10));
function traceReg(opts) {
  const g = createRegistry(Object.assign({ now: () => clock }, opts));
  g.register({ name: "t.echo", description: "echo", parameters: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false }, roles: ["student"], risk: "read", timeoutMs: 50, run: (ctx, i) => ({ x: i.x }) });
  g.register({ name: "t.actionErr", description: "a", parameters: { type: "object" }, roles: ["student"], risk: "read", timeoutMs: 20, run: () => { throw new ActionError(409, { error: "busy" }); } });
  g.register({ name: "t.boom", description: "b", parameters: { type: "object" }, roles: ["student"], risk: "read", timeoutMs: 20, run: () => { throw new Error("disk"); } });
  return g;
}
async function traceFaultCase(label, onTrace, extra) {
  let calls = 0; const errs = [];
  const g = traceReg(Object.assign({ onTrace: t => { calls++; return onTrace(t); }, onTraceError: e => errs.push(e) }, extra));
  const ok = await settle(g.invoke("t.echo", kid, { x: 7 }));
  const unknown = await settle(g.invoke("t.nope", kid, {}));
  const invalid = await settle(g.invoke("t.echo", kid, { x: "7" }));
  const perm = await settle(g.invoke("t.echo", { kidId: "k1", role: "parent" }, { x: 1 }));
  const act = await settle(g.invoke("t.actionErr", kid, {}));
  const boom = await settle(g.invoke("t.boom", kid, {}));
  await tick();
  check(`${label}: ok invoke resolves with the business result`, ok.ok === true && ok.result.x === 7, ok);
  check(`${label}: UNKNOWN_TOOL / INVALID_INPUT / PERMISSION still resolve normalized`, unknown.ok === false && unknown.error.code === "UNKNOWN_TOOL" && invalid.error && invalid.error.code === "INVALID_INPUT" && perm.error && perm.error.code === "PERMISSION", [unknown, invalid, perm]);
  check(`${label}: ACTION / INTERNAL keep the original error`, act.error && act.error.code === "ACTION" && act.error.status === 409 && act.error.details.error === "busy" && boom.error && boom.error.code === "INTERNAL" && boom.error.message === "disk", [act, boom]);
  check(`${label}: trace called exactly once per invoke, each failure reported once`, calls === 6 && errs.length === 6 && errs.every(e => e instanceof Error), { calls, errs: errs.length });
}
await traceFaultCase("sync throw", () => { throw new Error("trace sync boom"); });
await traceFaultCase("async reject", async () => { throw new Error("trace async boom"); });
await traceFaultCase("thenable whose then throws", () => ({ get then() { throw new Error("bad thenable"); } }));
{
  /* 默认 onTrace（走 log）而 log 抛错 */
  let logs = 0; const errs = [];
  const g = traceReg({ log: () => { logs++; throw new Error("log down"); }, onTraceError: e => errs.push(e) });
  const ok = await settle(g.invoke("t.echo", kid, { x: 1 }));
  const unknown = await settle(g.invoke("t.nope", kid, {}));
  check("default log throws: invoke still resolves, log called once per invoke", ok.ok === true && ok.result.x === 1 && unknown.ok === false && unknown.error.code === "UNKNOWN_TOOL" && logs === 2 && errs.length === 2, { ok, unknown, logs });
  /* 也不给 onTraceError：兜底上报自己出错也不能冒出来 */
  const origWarn = console.warn; let warned = 0;
  console.warn = () => { warned++; throw new Error("warn down too"); };
  let r2;
  try { r2 = await settle(traceReg({ log: () => { throw new Error("log down"); } }).invoke("t.echo", kid, { x: 2 })); }
  finally { console.warn = origWarn; }
  check("no onTraceError and console.warn also throws: still resolves", r2.ok === true && r2.result.x === 2 && warned === 1, { r2, warned });
  const g2 = traceReg({ onTrace: () => { throw new Error("x"); }, onTraceError: () => { throw new Error("reporter down"); } });
  const r3 = await settle(g2.invoke("t.echo", kid, { x: 3 }));
  const g3 = traceReg({ onTrace: async () => { throw new Error("x"); }, onTraceError: async () => { throw new Error("reporter down async"); } });
  const r4 = await settle(g3.invoke("t.echo", kid, { x: 4 }));
  await tick();
  check("a throwing / rejecting onTraceError is contained too", r3.ok === true && r3.result.x === 3 && r4.ok === true && r4.result.x === 4, [r3, r4]);
}
await tick();
process.off("unhandledRejection", onUnhandled);
check("no unhandled rejections from trace failures", unhandled.length === 0, unhandled.map(String));

console.log("tool definitions wrap the real actions");
const calls = [];
const stubActions = new Proxy({}, { get: (_, group) => new Proxy({}, { get: (_, fn) => (ctx, input) => { calls.push(group + "." + fn); return { group, fn, input }; } }) });
const tools = createTools({ actions: stubActions, findCurriculumItem: id => id === "XYZ" ? { item: { id: "XYZ", en: "x", zh: "叉", strand: "number" } } : null, onTrace: () => {} });
check("13 tools registered across the five groups", tools.size === 13 && ["student", "curriculum", "questions", "learning", "calculator"].every(g => tools.list({ group: g }).length > 0), tools.size);
check("every tool has description / parameters / roles / risk / timeoutMs", tools.list().every(t => t.description && t.parameters.type === "object" && t.roles.length && t.risk && t.timeoutMs > 0));
r = await tools.invoke("student.getProgress", kid, { grade: 4 });
check("student.getProgress -> actions.progress.get", r.ok && calls.at(-1) === "progress.get" && r.result.input.grade === 4);
r = await tools.invoke("questions.answerQuiz", kid, { session: "abcdefgh", qid: "q1", picked: 5 });
check("questions.answerQuiz rejects picked=5 before touching the action", !r.ok && r.error.code === "INVALID_INPUT" && calls.at(-1) !== "quiz.answer");
/* #23 复审：作答绑定题号，缺 qid 的调用不许到 Action（否则重放会被当成下一题） */
r = await tools.invoke("questions.answerQuiz", kid, { session: "abcdefgh", picked: 1 });
check("questions.answerQuiz requires qid", !r.ok && r.error.code === "INVALID_INPUT" && calls.at(-1) !== "quiz.answer", r);
r = await tools.invoke("questions.answerQuiz", kid, { session: "abcdefgh", qid: "q1", picked: 1 });
check("questions.answerQuiz passes session/qid/picked to actions.quiz.answer", r.ok && calls.at(-1) === "quiz.answer" && r.result.input.qid === "q1" && r.result.input.picked === 1, r);
r = await tools.invoke("learning.getReport", kid, { grade: 4 });
check("learning.getReport is parent-only", !r.ok && r.error.code === "PERMISSION");
r = await tools.invoke("learning.recordPractice", kid, { curriculumId: "BC.MATH.G4.NUM.01", event: "quiz-pass" });
check("learning.recordPractice: internal events are not even in the enum", !r.ok && r.error.code === "INVALID_INPUT");
r = await tools.invoke("curriculum.findTopic", kid, { curriculumId: "XYZ" });
check("curriculum.findTopic -> item summary", r.ok && r.result.en === "x" && r.result.strand === "number");
r = await tools.invoke("curriculum.findTopic", kid, { curriculumId: "nope" });
check("curriculum.findTopic unknown -> ACTION 404", !r.ok && r.error.code === "ACTION" && r.error.status === 404);
const src = ["progress", "curriculum", "quiz", "history", "unitTest", "report"].map(f => fs.readFileSync(new URL("../lib/actions/" + f + ".js", import.meta.url), "utf8")).join("\n");
const toolSrc = fs.readFileSync(new URL("../lib/ai/tools/index.js", import.meta.url), "utf8");
check("no business logic copied into tool definitions (no kd/kidSave/progressRecord/qbank in tools/index.js)", !/\b(kd|kidSave|kidTxn|progressRecord|qbank|quizOpen)\b/.test(toolSrc) && src.length > 1000);

console.log("calculator");
const ev = calculator.evaluate;
check("precedence and parentheses", ev("2+3*4") === 14 && ev("(2+3)*4") === 20 && ev("2^3^2") === 512 && ev("-2^2") === -4 && ev("10-4-3") === 3 && ev("8/2/2") === 2);
check("decimals, %, unicode operators, functions, constants", ev("0.1+0.2") === 0.1 + 0.2 && ev("7%3") === 1 && ev("6×7") === 42 && ev("9÷3") === 3 && ev("sqrt(16)+abs(-2)+round(2.5)+floor(2.9)+ceil(2.1)+min(1,2)+max(1,2)") === 4 + 2 + 3 + 2 + 3 + 1 + 2 && Math.abs(ev("pi") - Math.PI) < 1e-12);
check("errors: division by zero, unknown name, junk, unbalanced, too long, non-string", ["1/0", "x+1", "2 $ 3", "(1+2", "1 2"].every(s => { try { ev(s); return false; } catch (e) { return e instanceof Error; } }) && (() => { try { ev("1+".repeat(101) + "1"); return false; } catch (e) { return /too long/.test(e.message); } })() && (() => { try { ev(5); return false; } catch (e) { return e instanceof TypeError; } })());
const throwsLike = (s, re) => { try { ev(s); return false; } catch (e) { return e instanceof Error && re.test(e.message); } };
check("unary functions take exactly one argument", ["sqrt(4,9)", "abs(-2,100)", "round(1.234,2)", "floor(2.9,1)", "ceil(2.1,1)", "SQRT(4, 9)"].every(s => throwsLike(s, /expects exactly 1 argument, got 2/)), ["sqrt(4,9)", "abs(-2,100)", "round(1.234,2)"].map(s => { try { return ev(s); } catch (e) { return e.message; } }));
check("min / max need at least one argument; one or many is fine", throwsLike("min()", /./) && throwsLike("max()", /./) && ev("min(3)") === 3 && ev("max(1,5,2)") === 5 && ev("min(4,-1,2)") === -1 && ev("sqrt(max(9,16))") === 4);
check("no function takes zero arguments; stray commas are errors", ["sqrt()", "abs()", "sqrt(4,)", "max(1,,2)", "1,2", "(1,2)"].every(s => throwsLike(s, /./)));
check("Object.prototype names are not constants or functions", ["constructor", "constructor^0", "constructor(2)*3", "(constructor)^0+1"].every(s => throwsLike(s, /unknown name "constructor"/)), ["constructor^0", "constructor(2)*3"].map(s => { try { return ev(s); } catch (e) { return e.message; } }));
r = await tools.invoke("calculator.evaluate", kid, { expression: "sqrt(4,9)" });
check("calculator.evaluate tool: arity error is a normalized failure", !r.ok && r.error.code === "INTERNAL" && /sqrt expects exactly 1 argument/.test(r.error.message), r);
r = await tools.invoke("calculator.evaluate", kid, { expression: "3407 - 3470" });
check("calculator.evaluate tool -> {expression, value}", r.ok && r.result.value === -63 && r.meta.risk === "read");
r = await tools.invoke("calculator.evaluate", kid, { expression: "1/0" });
check("calculator error -> INTERNAL with the message, no crash", !r.ok && r.error.code === "INTERNAL" && /division by zero/.test(r.error.message));

process.exit(summary() ? 0 : 1);
