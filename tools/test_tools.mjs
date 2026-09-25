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

console.log("tool definitions wrap the real actions");
const calls = [];
const stubActions = new Proxy({}, { get: (_, group) => new Proxy({}, { get: (_, fn) => (ctx, input) => { calls.push(group + "." + fn); return { group, fn, input }; } }) });
const tools = createTools({ actions: stubActions, findCurriculumItem: id => id === "XYZ" ? { item: { id: "XYZ", en: "x", zh: "叉", strand: "number" } } : null, onTrace: () => {} });
check("13 tools registered across the five groups", tools.size === 13 && ["student", "curriculum", "questions", "learning", "calculator"].every(g => tools.list({ group: g }).length > 0), tools.size);
check("every tool has description / parameters / roles / risk / timeoutMs", tools.list().every(t => t.description && t.parameters.type === "object" && t.roles.length && t.risk && t.timeoutMs > 0));
r = await tools.invoke("student.getProgress", kid, { grade: 4 });
check("student.getProgress -> actions.progress.get", r.ok && calls.at(-1) === "progress.get" && r.result.input.grade === 4);
r = await tools.invoke("questions.answerQuiz", kid, { session: "abcdefgh", picked: 5 });
check("questions.answerQuiz rejects picked=5 before touching the action", !r.ok && r.error.code === "INVALID_INPUT" && calls.at(-1) !== "quiz.answer");
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
r = await tools.invoke("calculator.evaluate", kid, { expression: "3407 - 3470" });
check("calculator.evaluate tool -> {expression, value}", r.ok && r.result.value === -63 && r.meta.risk === "read");
r = await tools.invoke("calculator.evaluate", kid, { expression: "1/0" });
check("calculator error -> INTERNAL with the message, no crash", !r.ok && r.error.code === "INTERNAL" && /division by zero/.test(r.error.message));

process.exit(summary() ? 0 : 1);
