#!/usr/bin/env node
/*
 * lib/ai/models 的 Router / 旧引擎桥 / 有界快照测试（#40，#19 Phase 8）。
 * 全部是合成数据和桩 provider / 桩 runEngine：不起服务器、不读 config / data、不调任何真实模型或网络。
 *
 *   node tools/test_model_routing.mjs
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const models = require("../lib/ai/models/index.js");
const { createModelRouter, RouterError, INTENTS, ROUTER_CODES, createLegacyProvider, LEGACY_ENGINES, LEGACY_TURN_CONTRACT, snapshotJson } = models;
const { LEGACY_TRANSCRIPT_PREFIX, LEGACY_TURN_SCHEMA, LEGACY_HINT } = require("../lib/ai/models/legacy.js");
const { createHarness } = require("../lib/ai/harness/index.js");
const { createTutorAgent, TUTOR_SYSTEM, CLASSIFIER_SYSTEM } = require("../lib/ai/tutor/index.js");
const { createTools } = require("../lib/ai/tools/index.js");
const { check, summary } = makeChecker();

const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECRET = "sk-SYNTHETIC-SECRET-4242";
const revoked = () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; };
const throwsCode = (f, code) => { try { f(); return false; } catch (e) { return e instanceof RouterError && e.code === code; } };
const configMsg = f => { try { f(); return null; } catch (e) { return e; } };
async function settle(p) { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, e }; } }
const isFrozenDeep = v => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v).every(isFrozenDeep));

/* 桩 provider：记下每次 invoke 的请求；behavior(request, io) 决定返回 */
function stub(id, capabilities, behavior, extra) {
  const calls = [];
  const p = Object.assign({ id, capabilities, invoke: (request, io) => { calls.push({ request, io }); return behavior ? behavior(request, io) : Promise.resolve({ type: "final", output: { by: id, intent: request.intent } }); } }, extra || {});
  return { p, calls };
}
const msgs = text => [{ role: "user", content: text }];

/* ================= 0. 旧导出兼容 ================= */
console.log("legacy exports");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yy-p8-"));
  const logs = []; const origLog = console.log; console.log = (...a) => logs.push(a.join(" "));
  let inst;
  try { inst = models.create({ cfg: { provider: "auto", providerByTask: {}, ollama: {}, claude: {}, anthropic: {}, openai: {} }, L: (l, z, e) => (l === "en" ? e : z), JSON_HINT: { zh: "", en: "" }, LESSON_SCHEMA: {}, DATA_ROOT: tmp }); }
  finally { console.log = origLog; }
  const keys = "which,resolveShim,runCmd,tmpWorkdir,cleanup,detected,detectProviders,PROVIDER_META,AUTO_ORDER,TASKS,pickProvider,ADAPTERS,LEDGER_FILE,ledgerAdd,ledgerRead,ledgerSummary,engineModel,runEngine";
  check("create(deps) still returns exactly the Phase 1 surface", Object.keys(inst).join() === keys, Object.keys(inst));
  check("pickProvider default behaviour unchanged (nothing detected → null)", inst.pickProvider("auto", "teach") === null);
  check("LEGACY_ENGINES mirrors the seven adapters", LEGACY_ENGINES.join() === Object.keys(inst.ADAPTERS).join());
  check("image engines mirror PROVIDER_META.supportsImage", require("../lib/ai/models/legacy.js").LEGACY_IMAGE_ENGINES.join() === Object.keys(inst.PROVIDER_META).filter(k => inst.PROVIDER_META[k].supportsImage).join());
  check("index.js keeps create as a function and adds the Phase 8 exports", typeof models.create === "function" && typeof createModelRouter === "function" && typeof createLegacyProvider === "function");
  check("INTENTS are the six capability intents", INTENTS.join() === "fast,reasoning,vision,cheap,local,privacy-sensitive" && Object.isFrozen(INTENTS));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ================= 1. 有界快照 ================= */
console.log("bounded snapshot");
{
  const src = { a: [1, "x", true, null, { b: 2 }] };
  const s = snapshotJson(src);
  check("plain JSON is copied and deep-frozen", s.ok && s.value !== src && JSON.stringify(s.value) === JSON.stringify(src) && isFrozenDeep(s.value));
  const polluted = JSON.parse('{"__proto__":{"polluted":1},"k":1}');
  const sp = snapshotJson(polluted);
  check("__proto__ key is copied as own data, prototype unchanged", sp.ok && Object.getPrototypeOf(sp.value) === Object.prototype && Object.prototype.hasOwnProperty.call(sp.value, "__proto__") && sp.value.polluted === undefined);
  let ran = false;
  const withGetter = {}; Object.defineProperty(withGetter, "g", { get() { ran = true; return 1; }, enumerable: true });
  check("getter → accessor, and the getter never runs", snapshotJson(withGetter).reason === "accessor" && !ran);
  const reasons = [
    [{ [Symbol("s")]: 1 }, "key"], [Object.defineProperty({}, "h", { value: 1, enumerable: false }), "key"],
    [new Date(0), "type"], [new Map(), "type"], [() => 1, "type"], [10n, "type"], [undefined, "type"], [NaN, "number"], [Infinity, "number"],
    [Object.create({ inherited: 1 }), "type"], [[1, , 3], "sparse"], [Object.assign([1], { extra: 2 }), "key"], [revoked(), "unreadable"],
    [new Proxy({}, { ownKeys() { throw revoked(); } }), "unreadable"],
  ];
  check("non-JSON shapes are rejected with a fixed reason code", reasons.every(([v, r]) => snapshotJson(v).reason === r), reasons.map(([v, r]) => [r, snapshotJson(v).reason]));
  const cyc = { a: {} }; cyc.a.b = cyc;
  check("cycle → cycle", snapshotJson(cyc).reason === "cycle");
  let deep = 0; for (let i = 0; i < 5000; i++) deep = [deep];
  check("5000-deep nesting stops at the depth limit (no stack overflow)", snapshotJson(deep).reason === "depth");
  check("long string → string", snapshotJson("x".repeat(100001)).reason === "string");
  check("too many nodes → nodes (checked before walking)", snapshotJson(new Array(30000).fill(0)).reason === "nodes");
  check("total characters → size", snapshotJson(new Array(30).fill("y".repeat(90000))).reason === "size");
  check("limits can be tightened per call", snapshotJson({ a: { b: 1 } }, { maxDepth: 1 }).reason === "depth" && snapshotJson([1, 2, 3], { maxNodes: 2 }).reason === "nodes");
  check("a shared (non-cyclic) sub-object is fine", snapshotJson((o => [o, o])({ z: 1 })).ok);
}

/* ================= 2. 配置校验与快照 ================= */
console.log("config validation");
const A = () => stub("remote-a", ["fast", "reasoning", "vision", "cheap"]);
const Lc = () => stub("local-l", ["fast", "cheap", "local", "privacy-sensitive"]);
{
  const a = A(), l = Lc();
  const ok = () => createModelRouter({ providers: [a.p, l.p], routes: { fast: ["remote-a"] } });
  check("a minimal valid config builds", !!ok().bind);
  const bad = [
    ["no providers", () => createModelRouter({ routes: {} })],
    ["empty providers", () => createModelRouter({ providers: [], routes: {} })],
    ["unknown option", () => createModelRouter({ providers: [a.p], routes: {}, retries: 3 })],
    ["provider extra field", () => createModelRouter({ providers: [Object.assign({ priority: 1 }, a.p)], routes: {} })],
    ["inherited invoke", () => createModelRouter({ providers: [Object.assign(Object.create({ invoke() {} }), { id: "x", capabilities: ["fast"] })], routes: {} })],
    ["bad id", () => createModelRouter({ providers: [{ ...a.p, id: "__proto__" }], routes: {} })],
    ["duplicate id", () => createModelRouter({ providers: [a.p, { ...l.p, id: "remote-a" }], routes: {} })],
    ["unknown capability", () => createModelRouter({ providers: [{ ...a.p, capabilities: ["fast", "gpu"] }], routes: {} })],
    ["duplicate capability", () => createModelRouter({ providers: [{ ...a.p, capabilities: ["fast", "fast"] }], routes: {} })],
    ["privacy-sensitive without local", () => createModelRouter({ providers: [{ ...a.p, capabilities: ["fast", "privacy-sensitive"] }], routes: {} })],
    ["unknown intent in routes", () => createModelRouter({ providers: [a.p], routes: { turbo: ["remote-a"] } })],
    ["unregistered provider in route", () => createModelRouter({ providers: [a.p], routes: { fast: ["nope"] } })],
    ["route to provider lacking the capability", () => createModelRouter({ providers: [a.p, l.p], routes: { reasoning: ["local-l"] } })],
    ["local route with a remote provider (hard constraint)", () => createModelRouter({ providers: [a.p, l.p], routes: { local: ["local-l", "remote-a"] } })],
    ["privacy-sensitive route with a remote provider", () => createModelRouter({ providers: [a.p, l.p], routes: { "privacy-sensitive": ["remote-a"] } })],
    ["duplicate id in a route", () => createModelRouter({ providers: [a.p], routes: { fast: ["remote-a", "remote-a"] } })],
    ["timeoutMs Infinity", () => createModelRouter({ providers: [a.p], routes: {}, timeoutMs: Infinity })],
    ["array-like providers", () => createModelRouter({ providers: { 0: a.p, length: 1 }, routes: {} })],
  ];
  const failed = bad.filter(([, f]) => !throwsCode(f, "INVALID_CONFIG")).map(([n]) => n);
  check("malformed configs → RouterError INVALID_CONFIG", failed.length === 0, failed);
  let getterRan = false;
  const gp = { capabilities: ["fast"], invoke() {} }; Object.defineProperty(gp, "id", { get() { getterRan = true; return "g"; }, enumerable: true });
  check("getter in provider config → INVALID_CONFIG, getter never runs", throwsCode(() => createModelRouter({ providers: [gp], routes: {} }), "INVALID_CONFIG") && !getterRan);
  const e1 = configMsg(() => createModelRouter(revoked()));
  check("revoked proxy options → INVALID_CONFIG with fixed text", e1 && e1.code === "INVALID_CONFIG" && /could not be read/.test(e1.message));
  const trap = new Proxy({ providers: [a.p], routes: {} }, { ownKeys() { throw new RouterError("INVALID_CONFIG", "leak " + SECRET); } });
  const e2 = configMsg(() => createModelRouter(trap));
  check("a caller-thrown RouterError is not passed through (no secret in message)", e2 && e2.code === "INVALID_CONFIG" && !e2.message.includes(SECRET));
  const e3 = configMsg(() => createModelRouter(new Proxy({}, { ownKeys() { throw revoked(); } })));
  check("trap throwing a revoked proxy → INVALID_CONFIG, no escape", e3 && e3.code === "INVALID_CONFIG");

  Object.prototype.fast = ["remote-a"];
  let r;
  try { r = createModelRouter({ providers: [a.p], routes: {} }); } finally { delete Object.prototype.fast; }
  const s = r.select("fast");
  check("Object.prototype pollution does not create a route", !s.ok && s.code === "NO_ROUTE");

  const provs = [A().p, Lc().p], routes = { fast: ["remote-a", "local-l"] };
  const r2 = createModelRouter({ providers: provs, routes });
  routes.fast.reverse(); provs[0].capabilities.push("local"); provs[0].id = "evil"; provs.pop();
  check("config is snapshotted: later mutation of routes / providers has no effect", r2.select("fast").provider === "remote-a" && r2.providers.length === 2 && r2.providers[0].capabilities.join() === "fast,reasoning,vision,cheap");
  check("router surface is frozen", Object.isFrozen(r2) && Object.isFrozen(r2.providers) && Object.isFrozen(r2.routes) && Object.isFrozen(r2.routes.fast));
  check("bind: unknown intent / bad require → INVALID_CONFIG", throwsCode(() => r2.bind("turbo"), "INVALID_CONFIG") && throwsCode(() => r2.bind("fast", { require: ["gpu"] }), "INVALID_CONFIG") && throwsCode(() => r2.bind("fast", { require: "local" }), "INVALID_CONFIG") && throwsCode(() => r2.bind("fast", { retries: 2 }), "INVALID_CONFIG") && throwsCode(() => r2.bind("fast", revoked()), "INVALID_CONFIG"));
  check("ROUTER_CODES lists every code", ["INVALID_CONFIG", "INVALID_REQUEST", "NO_ROUTE", "NO_PROVIDER", "CANCELLED", "TIMEOUT", "PROVIDER_ERROR", "BAD_OUTPUT"].every(c => ROUTER_CODES.includes(c)));
}

/* ================= 3. 六个 intent ================= */
console.log("six intents");
function world(opts) {
  opts = opts || {};
  const a = stub("remote-a", ["fast", "reasoning", "vision", "cheap"], null, opts.a);
  const v = stub("remote-v", ["reasoning", "vision"], null, opts.v);
  const l = stub("local-l", ["fast", "cheap", "local", "privacy-sensitive"], null, opts.l);
  const l2 = stub("local-l2", ["fast", "local"], null, opts.l2);
  const traces = [];
  const router = createModelRouter({
    providers: [a.p, v.p, l.p, l2.p],
    routes: { fast: ["remote-a", "local-l"], reasoning: ["remote-v", "remote-a"], vision: ["remote-v"], cheap: ["local-l", "remote-a"], local: ["local-l", "local-l2"], "privacy-sensitive": ["local-l"] },
    onTrace: t => traces.push(t), timeoutMs: opts.timeoutMs,
  });
  return { a, v, l, l2, router, traces };
}
{
  const w = world();
  const expect = { fast: "remote-a", reasoning: "remote-v", vision: "remote-v", cheap: "local-l", local: "local-l", "privacy-sensitive": "local-l" };
  const got = {};
  for (const intent of INTENTS) got[intent] = (await w.router.bind(intent).next({ system: "s", messages: msgs("q-" + intent) })).output;
  check("each intent routes to its first configured provider", INTENTS.every(i => got[i].by === expect[i] && got[i].intent === i), got);
  check("provider sees the intent it was bound to", w.v.calls.map(c => c.request.intent).join() === "reasoning,vision");
  check("select() agrees and invokes nothing", INTENTS.every(i => w.router.select(i).provider === expect[i]) && w.a.calls.length + w.v.calls.length + w.l.calls.length === 6);
  const req = w.l.calls[0].request;
  check("provider request is a deep-frozen snapshot with only the contract fields", isFrozenDeep(req) && Object.keys(req).join() === "intent,system,messages,tools,step,images");
  check("provider io has a signal and a deadline, frozen", Object.isFrozen(w.l.calls[0].io) && w.l.calls[0].io.signal instanceof AbortSignal && typeof w.l.calls[0].io.deadlineAt === "number");
}

/* ================= 4. 硬约束 ================= */
console.log("hard constraints");
{
  const w = world({ l: { available: () => false } });
  const r1 = await settle(w.router.bind("privacy-sensitive").next({ messages: msgs("secret") }));
  check("privacy-sensitive with the local provider down → NO_PROVIDER, no remote call", !r1.ok && r1.e.code === "NO_PROVIDER" && w.a.calls.length === 0 && w.v.calls.length === 0);
  const r2 = await settle(w.router.bind("fast", { require: ["local"] }).next({ messages: msgs("x") }));
  check("fast+require local skips remote-a (capability) and local-l (down) → NO_PROVIDER", !r2.ok && r2.e.code === "NO_PROVIDER" && w.a.calls.length === 0);
  const r3 = await settle(w.router.bind("local").next({ messages: msgs("x") }));
  check("local falls back only to another local provider", r3.ok && r3.v.output.by === "local-l2");
  const w2 = world();
  const r4 = await w2.router.bind("fast", { require: ["privacy-sensitive"] }).next({ messages: msgs("x") });
  check("require privacy-sensitive implies local and picks local-l over the first-ranked remote", r4.output.by === "local-l" && w2.a.calls.length === 0);
  const img = [{ mediaType: "image/png", data: "iVBORw0KGgo=" }];
  const r5 = await w2.router.bind("fast").next({ messages: msgs("pic"), images: img });
  check("a request with an image needs vision: fast → remote-a (declares vision), image passed through", r5.output.by === "remote-a" && w2.a.calls.at(-1).request.images[0].data === img[0].data);
  const before = w2.l.calls.length + w2.l2.calls.length + w2.a.calls.length;
  const r6 = await settle(w2.router.bind("local").next({ messages: msgs("pic"), images: img }));
  check("image + local intent → NO_PROVIDER (never dropped, never sent remote)", !r6.ok && r6.e.code === "NO_PROVIDER" && w2.l.calls.length + w2.l2.calls.length + w2.a.calls.length === before);
  const w3 = world({ a: { available: () => false } });
  const r7 = await settle(w3.router.bind("fast").next({ messages: msgs("pic"), images: img }));
  check("image on fast with remote-a down → NO_PROVIDER, local-l (no vision) is not used", !r7.ok && r7.e.code === "NO_PROVIDER" && w3.l.calls.length === 0);
  check("select() honours images too", w2.router.select("local", { images: img }).code === "NO_PROVIDER" && w2.router.select("fast", { images: img }).provider === "remote-a");
}

/* ================= 5. 调用前 fallback / 无路由 / 无匹配 ================= */
console.log("pre-call fallback");
{
  let promiseRejections = 0;
  const cases = [
    ["available() false", () => false], ["available() throws", () => { throw new Error(SECRET); }],
    ["available() returns a promise", () => Promise.reject(new Error("async")).finally(() => promiseRejections++)], ["available() returns truthy non-true", () => 1],
  ];
  for (const [name, available] of cases) {
    const w = world({ a: { available } });
    const r = await w.router.bind("fast").next({ messages: msgs("x") });
    const t = w.traces.at(-1);
    check(`${name} → skipped, next in order used, trace lists the skip`, r.output.by === "local-l" && w.a.calls.length === 0 && t.provider === "local-l" && t.skipped.join() === "remote-a" && t.ok === true);
  }
  await sleep(5);
  check("a rejected availability promise is caught (no unhandled rejection)", promiseRejections === 1 && unhandled.length === 0);
  const w = world({ a: { available: () => true } });
  check("available() === true → used", (await w.router.bind("fast").next({ messages: msgs("x") })).output.by === "remote-a");
  const bare = createModelRouter({ providers: [A().p], routes: { fast: ["remote-a"] } });
  const nr = await settle(bare.bind("vision").next({ messages: msgs("x") }));
  check("intent without a route → NO_ROUTE", !nr.ok && nr.e.code === "NO_ROUTE" && nr.e.intent === "vision" && nr.e.message === "no route is configured for this intent");
  const all = world({ a: { available: () => false }, l: { available: () => false } });
  const np = await settle(all.router.bind("fast").next({ messages: msgs("x") }));
  check("every candidate unavailable → NO_PROVIDER, trace lists both", !np.ok && np.e.code === "NO_PROVIDER" && all.traces.at(-1).skipped.join() === "remote-a,local-l" && all.traces.at(-1).provider === null);
}

/* ================= 6. 调用后失败不换商 ================= */
console.log("no vendor retry after invocation");
{
  const failing = [
    ["rejects", () => Promise.reject(new Error("boom " + SECRET)), "PROVIDER_ERROR"],
    ["throws synchronously", () => { throw new Error(SECRET); }, "PROVIDER_ERROR"],
    ["rejects with a revoked proxy", () => Promise.reject(revoked()), "PROVIDER_ERROR"],
    ["rejects with throwing getters", () => Promise.reject({ get message() { throw new Error("x"); }, get code() { throw new Error("y"); } }), "PROVIDER_ERROR"],
    ["returns NaN", () => Promise.resolve({ type: "final", output: NaN }), "BAD_OUTPUT"],
    ["returns a function", () => Promise.resolve(() => 1), "BAD_OUTPUT"],
    ["returns a cycle", () => { const o = { type: "final" }; o.output = o; return Promise.resolve(o); }, "BAD_OUTPUT"],
    ["resolves to a revoked proxy (then-lookup throws → rejection)", () => Promise.resolve(revoked()), "PROVIDER_ERROR"],
    ["returns a plain value with a getter", () => ({ get type() { throw new Error(SECRET); } }), "BAD_OUTPUT"],
  ];
  for (const [name, beh, code] of failing) {
    const a = stub("remote-a", ["fast"], beh), l = stub("local-l", ["fast", "local"]);
    const router = createModelRouter({ providers: [a.p, l.p], routes: { fast: ["remote-a", "local-l"] } });
    const t0 = Date.now();
    const r = await settle(router.bind("fast").next({ messages: msgs("x") }));
    check(`provider ${name} → ${code}, fixed text, next provider NOT called`, !r.ok && r.e instanceof RouterError && r.e.code === code && r.e.provider === "remote-a" && !String(r.e.message).includes(SECRET) && l.calls.length === 0 && a.calls.length === 1 && Date.now() - t0 < 200);
  }
  /* Harness 的 modelRetries 管重试：第二次 next 重新选路（同一个 provider 仍可用就还是它） */
  let n = 0;
  const a = stub("remote-a", ["fast"], () => (++n === 1 ? Promise.reject(new Error("once")) : Promise.resolve({ type: "final", output: "ok" })));
  const l = stub("local-l", ["fast", "local"]);
  const router = createModelRouter({ providers: [a.p, l.p], routes: { fast: ["remote-a", "local-l"] } });
  const reg = createTools({ actions: {}, findCurriculumItem: () => null, onTrace: () => {} });
  const h = createHarness({ registry: reg, tools: [], modelRetries: 1, onTrace: () => {} });
  const hr = await h.run({ ctx: { role: "student", kidId: "k1" }, model: router.bind("fast"), input: "q" });
  check("Harness modelRetries re-selects via the router: same provider twice, fallback untouched", hr.ok && hr.output === "ok" && a.calls.length === 2 && l.calls.length === 0);
}

/* ================= 7. 同 tick 修改 / 并发 ================= */
console.log("snapshots and concurrency");
{
  const w = world();
  const src = { system: "sys-original", messages: [{ role: "user", content: "original" }], tools: [{ name: "calc", parameters: { type: "object" } }], step: 1 };
  const p = w.router.bind("fast").next(src);
  src.system = "changed"; src.messages[0].content = "changed"; src.messages.push({ role: "user", content: "added" }); src.tools[0].name = "evil";
  await p;
  const seen = w.a.calls[0].request;
  check("same-tick mutation of the request does not reach the provider", seen.system === "sys-original" && seen.messages.length === 1 && seen.messages[0].content === "original" && seen.tools[0].name === "calc" && seen.step === 1);
  const out = { type: "final", output: { n: 1 } };
  const a = stub("remote-a", ["fast"], () => Promise.resolve(out));
  const router = createModelRouter({ providers: [a.p], routes: { fast: ["remote-a"] } });
  const got = await router.bind("fast").next({ messages: msgs("x") });
  out.output.n = 999;
  check("provider output is snapshotted: mutating it afterwards changes nothing", got.output.n === 1 && got !== out && Object.isFrozen(got));

  const delays = [30, 5, 20, 0, 12, 25, 3, 18, 8, 1, 27, 14];
  const echo = id => (request) => new Promise(r => setTimeout(() => r({ type: "final", output: { by: id, intent: request.intent, echo: request.messages[0].content } }), delays[Number(request.messages[0].content.split("-")[1]) % delays.length]));
  const pa = stub("remote-a", ["fast", "reasoning", "vision", "cheap"], echo("remote-a")), pl = stub("local-l", ["fast", "cheap", "local", "privacy-sensitive"], echo("local-l"));
  const cr = createModelRouter({ providers: [pa.p, pl.p], routes: { fast: ["remote-a"], reasoning: ["remote-a"], cheap: ["local-l"], local: ["local-l"], "privacy-sensitive": ["local-l"] } });
  const intents = ["fast", "reasoning", "cheap", "local", "privacy-sensitive"];
  const bound = Object.fromEntries(intents.map(i => [i, cr.bind(i)]));
  const jobs = Array.from({ length: 24 }, (_, i) => ({ i, intent: intents[i % intents.length] }));
  const res = await Promise.all(jobs.map(j => bound[j.intent].next({ messages: msgs("m-" + j.i) })));
  const expectBy = { fast: "remote-a", reasoning: "remote-a", cheap: "local-l", local: "local-l", "privacy-sensitive": "local-l" };
  check("24 concurrent calls across 5 intents settle out of order, each with its own request and route", res.every((r, k) => r.output.echo === "m-" + jobs[k].i && r.output.intent === jobs[k].intent && r.output.by === expectBy[jobs[k].intent]));
}

/* ================= 8. 取消 / 超时 / 迟到结果 ================= */
console.log("cancellation and timeouts");
{
  const ac0 = new AbortController(); ac0.abort();
  const w = world();
  const r0 = await settle(w.router.bind("fast").next({ messages: msgs("x"), signal: ac0.signal }));
  check("pre-aborted signal → CANCELLED, nothing selected or invoked", !r0.ok && r0.e.code === "CANCELLED" && w.a.calls.length === 0 && w.l.calls.length === 0);

  let providerSignal, lateResolve;
  const traces = [];
  const a = stub("remote-a", ["fast"], (req, io) => { providerSignal = io.signal; return new Promise(r => { lateResolve = r; }); });
  const router = createModelRouter({ providers: [a.p], routes: { fast: ["remote-a"] }, onTrace: t => traces.push(t) });
  const ac = new AbortController();
  const t0 = Date.now();
  const p = router.bind("fast").next({ messages: msgs("x"), signal: ac.signal });
  setTimeout(() => ac.abort(), 15);
  const r1 = await settle(p);
  check("abort while waiting → CANCELLED promptly; provider's signal is aborted", !r1.ok && r1.e.code === "CANCELLED" && Date.now() - t0 < 200 && providerSignal.aborted);
  lateResolve({ type: "final", output: "too late" });
  await sleep(5);
  check("late result is dropped with one route-late trace", traces.filter(t => t.kind === "route-late").length === 1 && traces.at(-1).kind === "route-late" && traces.at(-1).ok === true);

  const hang = stub("remote-a", ["fast"], (req, io) => { providerSignal = io.signal; return new Promise((_, rej) => setTimeout(() => rej(new Error("late " + SECRET)), 80)); });
  const tr = [];
  const router2 = createModelRouter({ providers: [hang.p], routes: { fast: ["remote-a"] }, onTrace: t => tr.push(t) });
  const t1 = Date.now();
  const r2 = await settle(router2.bind("fast", { timeoutMs: 25 }).next({ messages: msgs("x") }));
  check("bind timeoutMs → TIMEOUT near the budget; provider signal aborted", !r2.ok && r2.e.code === "TIMEOUT" && Date.now() - t1 < 150 && providerSignal.aborted);
  await sleep(100);
  check("late rejection after timeout is caught (route-late ok:false, no unhandled rejection)", tr.some(t => t.kind === "route-late" && t.ok === false) && unhandled.length === 0);

  const block = stub("remote-a", ["fast"], () => { const e = Date.now() + 40; while (Date.now() < e) { } return Promise.resolve({ type: "final", output: 1 }); });
  const router3 = createModelRouter({ providers: [block.p], routes: { fast: ["remote-a"] }, timeoutMs: 20 });
  const r3 = await settle(router3.bind("fast").next({ messages: msgs("x") }));
  check("a synchronously blocking provider past the deadline → TIMEOUT, result not used", !r3.ok && r3.e.code === "TIMEOUT");

  const ac4 = new AbortController();
  const router4 = createModelRouter({ providers: [stub("remote-a", ["fast"], () => { ac4.abort(); return Promise.resolve({ type: "final", output: 1 }); }).p], routes: { fast: ["remote-a"] } });
  const r4 = await settle(router4.bind("fast").next({ messages: msgs("x"), signal: ac4.signal }));
  check("abort during a synchronous invoke → CANCELLED, resolved value not used", !r4.ok && r4.e.code === "CANCELLED");

  const fake = { aborted: false, addEventListener() {}, removeEventListener() {} };
  const w5 = world();
  const r5 = await settle(w5.router.bind("fast").next({ messages: msgs("x"), signal: fake }));
  const r6 = await settle(w5.router.bind("fast").next({ messages: msgs("x"), signal: new Proxy(new AbortController().signal, {}) }));
  check("fake / proxied signals → INVALID_REQUEST (brand-checked), provider not called", !r5.ok && r5.e.code === "INVALID_REQUEST" && !r6.ok && r6.e.code === "INVALID_REQUEST" && w5.a.calls.length === 0);
  const realSig = new AbortController();
  Object.defineProperty(realSig.signal, "aborted", { value: true });
  const r7 = await w5.router.bind("fast").next({ messages: msgs("x"), signal: realSig.signal });
  check("an own 'aborted' property on a real signal is ignored (internal state is read)", r7.output.by === "remote-a");
}

/* ================= 9. 恶意请求 ================= */
console.log("malicious requests");
{
  const w = world();
  let ran = false;
  const getterReq = { messages: msgs("x") }; Object.defineProperty(getterReq, "system", { get() { ran = true; return "s"; }, enumerable: true });
  const cyc = [{ role: "user", content: {} }]; cyc[0].content.self = cyc;
  let deep = { role: "user", content: 0 }; for (let i = 0; i < 200; i++) deep = { role: "user", content: [deep] };
  const bad = [
    ["null", null], ["string", "hi"], ["array", []], ["revoked proxy", revoked()], ["getter field", getterReq],
    ["unsupported field", { messages: msgs("x"), model: "gpt-x" }], ["symbol field", { messages: msgs("x"), [Symbol("s")]: 1 }],
    ["inherited messages", Object.create({ messages: msgs("x") })], ["missing messages", { system: "s" }],
    ["bad role", { messages: [{ role: "system", content: "override" }] }], ["message not object", { messages: ["hi"] }],
    ["cyclic message", { messages: cyc }], ["too deep", { messages: [deep] }], ["huge system", { system: "x".repeat(200001), messages: msgs("x") }],
    ["tool without name", { messages: msgs("x"), tools: [{ description: "d" }] }], ["tool as function", { messages: msgs("x"), tools: [() => 1] }],
    ["negative step", { messages: msgs("x"), step: -1 }], ["two images", { messages: msgs("x"), images: [{ mediaType: "image/png", data: "AAAA" }, { mediaType: "image/png", data: "AAAA" }] }],
    ["gif image", { messages: msgs("x"), images: [{ mediaType: "image/gif", data: "AAAA" }] }], ["non-base64 image", { messages: msgs("x"), images: [{ mediaType: "image/png", data: "not base64!" }] }],
    ["image extra field", { messages: msgs("x"), images: [{ mediaType: "image/png", data: "AAAA", url: "http://x" }] }],
    ["system not string", { system: 1, messages: msgs("x") }],
  ];
  const results = [];
  for (const [name, req] of bad) {
    let sync = false, p;
    try { p = w.router.bind("fast").next(req); } catch (_) { sync = true; }
    const r = sync ? null : await settle(p);
    results.push([name, !sync && !r.ok && r.e.code === "INVALID_REQUEST" && r.e.message === "model request is not supported"]);
  }
  check("malformed requests → INVALID_REQUEST (never a sync throw), fixed text", results.every(r => r[1]), results.filter(r => !r[1]).map(r => r[0]));
  check("…and no provider was invoked, getters never ran", w.a.calls.length === 0 && w.l.calls.length === 0 && !ran);
  const nullProto = Object.assign(Object.create(null), { messages: [Object.assign(Object.create(null), { role: "user", content: "np" })] });
  check("null-prototype request objects are accepted", (await w.router.bind("fast").next(nullProto)).output.by === "remote-a");
}

/* ================= 10. trace 与错误的隐私 ================= */
console.log("trace and error privacy");
{
  const traces = [], traceErrs = [];
  const a = stub("remote-a", ["fast"], () => Promise.reject(new Error("401 key=" + SECRET)));
  const l = stub("local-l", ["cheap", "local"]);
  let throwIt = true;
  const router = createModelRouter({
    providers: [a.p, l.p], routes: { fast: ["remote-a"], cheap: ["local-l"] },
    onTrace: t => { traces.push(t); if (throwIt) throw new Error("trace sink down"); },
    onTraceError: (e, t) => { traceErrs.push(t.kind); throw new Error("error sink down too"); },
  });
  const sys = "SYSTEM-TEXT-" + SECRET, userText = "CHILD-QUESTION-TEXT";
  const r1 = await settle(router.bind("fast").next({ system: sys, messages: msgs(userText) }));
  const r2 = await router.bind("cheap").next({ system: sys, messages: msgs(userText) });
  throwIt = false;
  const blob = JSON.stringify(traces) + JSON.stringify(r1.e) + r1.e.message + String(r1.e.stack);
  check("provider error → fixed message; the original error / secret appears nowhere", !r1.ok && r1.e.code === "PROVIDER_ERROR" && !blob.includes(SECRET) && !blob.includes("401"));
  check("traces carry no prompt / message text", !JSON.stringify(traces).includes("SYSTEM-TEXT") && !JSON.stringify(traces).includes(userText));
  const keys = new Set(traces.flatMap(t => Object.keys(t)));
  check("trace fields are only kind / intent / provider / ok / code / skipped / ms / at", [...keys].every(k => ["kind", "intent", "provider", "ok", "code", "skipped", "ms", "at"].includes(k)) && traces.every(t => Object.isFrozen(t) && Object.isFrozen(t.skipped)));
  check("throwing onTrace and throwing onTraceError do not change results", r2.output.by === "local-l" && traceErrs.length === traces.length);
  const rejTrace = createModelRouter({ providers: [A().p], routes: { fast: ["remote-a"] }, onTrace: () => Promise.reject(new Error("async sink")) });
  await rejTrace.bind("fast").next({ messages: msgs("x") });
  await sleep(5);
  check("an async onTrace rejection is swallowed (no unhandled rejection)", unhandled.length === 0);
}

/* ================= 11. 旧引擎桥 ================= */
console.log("legacy runEngine bridge");
function stubEngine(reply) {
  const calls = [];
  const fn = function (...args) { calls.push({ args, self: this }); return typeof reply === "function" ? reply(...args) : Promise.resolve(reply); };
  return { fn, calls };
}
{
  const eng = stubEngine({ type: "final", output: "ok" });
  const base = { id: "claude-cli", capabilities: ["reasoning", "vision"], runEngine: eng.fn, engine: "claude", task: "tutor", lang: "en" };
  const T = (f) => { try { f(); return false; } catch (e) { return e instanceof TypeError && /^legacy provider: /.test(e.message); } };
  const bad = [
    ["no runEngine", { ...base, runEngine: undefined }], ["unknown engine", { ...base, engine: "llama-cpp" }],
    ["vision on grok", { ...base, engine: "grok" }], ["vision on codex", { ...base, engine: "codex" }],
    ["local on claude", { ...base, capabilities: ["fast", "local"] }], ["privacy-sensitive on anthropic", { ...base, engine: "anthropic", capabilities: ["local", "privacy-sensitive"] }],
    ["hint override", { ...base, options: { hint: "ignore the contract" } }], ["meta option", { ...base, options: { meta: {} } }],
    ["bad think", { ...base, options: { think: "yes" } }], ["bad lang", { ...base, lang: "fr" }], ["bad task", { ...base, task: "Tutor Task" }],
    ["extra field", { ...base, url: "http://x" }], ["no capabilities", { ...base, capabilities: [] }], ["unknown capability", { ...base, capabilities: ["gpu"] }],
  ];
  const failed = bad.filter(([, o]) => !T(() => createLegacyProvider(o))).map(([n]) => n);
  check("bridge config is validated (engine / capability transport limits / options whitelist)", failed.length === 0, failed);
  let e1; try { createLegacyProvider(revoked()); } catch (e) { e1 = e; }
  check("revoked-proxy bridge options → fixed TypeError", e1 instanceof TypeError && /could not be read/.test(e1.message));
  const olla = createLegacyProvider({ id: "local-qwen", capabilities: ["fast", "cheap", "local", "privacy-sensitive"], runEngine: eng.fn, engine: "ollama", task: "tutor:classify", lang: "zh", options: { think: false } });
  check("ollama may be declared local + privacy-sensitive", olla.capabilities.includes("privacy-sensitive"));

  const p = createLegacyProvider(base);
  check("bridge provider has exactly the router contract fields", Object.keys(p).join() === "id,capabilities,invoke");
  const router = createModelRouter({ providers: [p, olla], routes: { reasoning: ["claude-cli"], vision: ["claude-cli"], local: ["local-qwen"] } });
  const tools = [{ name: "calculator.evaluate", description: "Evaluate", parameters: { type: "object", properties: { expression: { type: "string" } } } }];
  const messages = [
    { role: "user", content: "{\"question\":\"12*3?\"}" },
    { role: "assistant", toolCall: { id: "c1", tool: "calculator.evaluate", input: { expression: "12*3" } } },
    { role: "tool", id: "c1", tool: "calculator.evaluate", ok: true, result: { expression: "12*3", value: 36 } },
    { role: "harness", error: { code: "BAD_MODEL_OUTPUT", message: "turn must be an object" } },
  ];
  const out = await router.bind("reasoning").next({ system: "SYS", messages, tools, step: 3 });
  const c = eng.calls[0];
  const [engine, task, sys, question, imgB64, mediaType, lang, callOpts, validate] = c.args;
  check("runEngine gets engine / task / lang as injected; system = request system + turn contract", engine === "claude" && task === "tutor" && sys === "SYS" + LEGACY_TURN_CONTRACT && lang === "en" && c.args.length === 9);
  check("runEngine is called with this = undefined", c.self === undefined);
  const parsed = JSON.parse(question.slice(LEGACY_TRANSCRIPT_PREFIX.length));
  check("question = prefix + JSON {tools, messages}: tools stay data, full history incl. tool observation and harness note", question.startsWith(LEGACY_TRANSCRIPT_PREFIX) && JSON.stringify(parsed) === JSON.stringify({ tools, messages }));
  check("opts: fixed non-empty hint + turn schema, nothing else; no validate; no image", callOpts.hint === LEGACY_HINT && LEGACY_HINT.trim().length > 0 && JSON.stringify(callOpts.schema) === JSON.stringify(LEGACY_TURN_SCHEMA) && Object.keys(callOpts).join() === "hint,schema" && validate === undefined && imgB64 === null && mediaType === null);
  check("default schema is deep-frozen and each call gets its own mutable copy", isFrozenDeep(LEGACY_TURN_SCHEMA) && callOpts.schema !== LEGACY_TURN_SCHEMA && !Object.isFrozen(callOpts.schema.required));
  check("turn contract describes all four roles and both turn types", ["\"user\"", "\"assistant\"", "\"tool\"", "\"harness\"", "tool_call", "final", "truncated"].every(s => LEGACY_TURN_CONTRACT.includes(s)));
  check("engine result comes back through the router", out.type === "final" && out.output === "ok");
  await router.bind("local").next({ messages: msgs("x") });
  check("think option is passed through for ollama", eng.calls[1].args[0] === "ollama" && eng.calls[1].args[1] === "tutor:classify" && eng.calls[1].args[7].think === false && eng.calls[1].args[6] === "zh");
  await router.bind("vision").next({ messages: msgs("see image"), images: [{ mediaType: "image/jpeg", data: "/9j/4AAQ" }] });
  check("vision: the single image reaches runEngine as imageB64 + mediaType", eng.calls[2].args[4] === "/9j/4AAQ" && eng.calls[2].args[5] === "image/jpeg");
  const direct = await settle(olla.invoke(Object.freeze({ intent: "local", system: "", messages: [], tools: [], step: null, images: [{ mediaType: "image/png", data: "AAAA" }] }), {}));
  check("bridge refuses an image for a provider not declared vision (never drops it)", !direct.ok && eng.calls.length === 3);
  const ac = new AbortController(); ac.abort();
  const pre = await settle(p.invoke(Object.freeze({ intent: "reasoning", system: "", messages: [], tools: [], step: null, images: [] }), { signal: ac.signal }));
  check("bridge does not call runEngine when already cancelled", !pre.ok && eng.calls.length === 3);

  const errEng = stubEngine(() => Promise.reject(new Error("引擎出错（退出码 1）：token " + SECRET)));
  const pe = createLegacyProvider({ ...base, runEngine: errEng.fn });
  const r = await settle(createModelRouter({ providers: [pe], routes: { reasoning: ["claude-cli"] } }).bind("reasoning").next({ messages: msgs("x") }));
  check("runEngine failure → PROVIDER_ERROR without the engine's raw text", !r.ok && r.e.code === "PROVIDER_ERROR" && !r.e.message.includes(SECRET) && !r.e.message.includes("引擎"));

  let finishEngine;
  const slowEng = stubEngine(() => new Promise(res => { finishEngine = res; }));
  const ps = createLegacyProvider({ ...base, runEngine: slowEng.fn });
  const tr = [];
  const rs = createModelRouter({ providers: [ps], routes: { reasoning: ["claude-cli"] }, onTrace: t => tr.push(t) });
  const r2 = await settle(rs.bind("reasoning", { timeoutMs: 20 }).next({ messages: msgs("x") }));
  finishEngine({ type: "final", output: "late" });
  await sleep(5);
  check("router timeout: RouterError TIMEOUT, but the legacy engine was already called once and finishes on its own (late trace)", !r2.ok && r2.e.code === "TIMEOUT" && slowEng.calls.length === 1 && tr.some(t => t.kind === "route-late" && t.ok));

  const avail = createLegacyProvider({ ...base, available: function () { return this === undefined ? false : true; } });
  check("injected available() is used as given (called with this = undefined)", createModelRouter({ providers: [avail], routes: { reasoning: ["claude-cli"] } }).select("reasoning").code === "NO_PROVIDER");
}

/* ================= 12. 真实 TutorAgent + Harness 工具循环（经 Router + 旧引擎桥） ================= */
console.log("real TutorAgent tool cycle through router + legacy bridge");
{
  const registry = createTools({ actions: {}, findCurriculumItem: () => null, onTrace: () => {} });
  const engineCalls = [];
  /* 桩 runEngine：按 system 区分分类 / 作答；作答时看 transcript 里有没有 tool observation */
  async function scriptedEngine(engine, task, sys, question, imageB64, mediaType, lang, opts) {
    const t = JSON.parse(question.slice(LEGACY_TRANSCRIPT_PREFIX.length));
    engineCalls.push({ engine, task, sys, t, lang, hint: opts.hint });
    if (sys === CLASSIFIER_SYSTEM + LEGACY_TURN_CONTRACT) return { type: "final", output: { label: "math", reason: "arithmetic" } };
    const obs = t.messages.find(m => m.role === "tool");
    if (!obs) return { type: "tool_call", tool: "calculator.evaluate", input: { expression: "12*3" } };
    return { type: "final", output: { kind: "answer", text: "12 × 3 = " + obs.result.value, scope: "math", checks: [{ expression: "12*3", value: obs.result.value }] } };
  }
  const local = createLegacyProvider({ id: "local-qwen", capabilities: ["fast", "cheap", "local", "privacy-sensitive"], runEngine: scriptedEngine, engine: "ollama", task: "tutor:classify", lang: "en" });
  const remote = createLegacyProvider({ id: "claude-cli", capabilities: ["reasoning"], runEngine: scriptedEngine, engine: "claude", task: "tutor", lang: "en" });
  const traces = [];
  const router = createModelRouter({ providers: [local, remote], routes: { fast: ["local-qwen"], reasoning: ["claude-cli"] }, onTrace: t => traces.push(t) });
  const agent = createTutorAgent({ registry, model: router.bind("reasoning"), classifierModel: router.bind("fast"), onTrace: () => {} });
  const r = await agent.ask({ role: "student", kidId: "k1", userId: "k1" }, { question: "What is 12 times 3?", lang: "en" });
  check("TutorAgent answers through router-bound models", r.ok && r.kind === "answer" && r.text === "12 × 3 = 36" && r.gate.label === "math", r);
  check("the real calculator tool ran once via the registry", r.calls.length === 1 && r.calls[0].tool === "calculator.evaluate" && r.calls[0].ok);
  check("three engine calls: classify (ollama / tutor:classify), then two tutor turns (claude / tutor)", engineCalls.map(c => c.engine + "/" + c.task).join() === "ollama/tutor:classify,claude/tutor,claude/tutor");
  check("Skill system prompts reach the engine verbatim, followed only by the turn contract", engineCalls[0].sys === CLASSIFIER_SYSTEM + LEGACY_TURN_CONTRACT && engineCalls[1].sys === TUTOR_SYSTEM + LEGACY_TURN_CONTRACT && engineCalls[2].sys === TUTOR_SYSTEM + LEGACY_TURN_CONTRACT);
  check("classifier sees no tools; tutor sees both tool definitions as data (with parameters)", engineCalls[0].t.tools.length === 0 && engineCalls[1].t.tools.map(d => d.name).sort().join() === "calculator.evaluate,curriculum.findTopic" && engineCalls[1].t.tools.every(d => d.parameters && d.parameters.type === "object"));
  const second = engineCalls[2].t.messages;
  check("second tutor turn carries the full history: user → assistant toolCall → tool observation", second.map(m => m.role).join() === "user,assistant,tool" && second[1].toolCall.tool === "calculator.evaluate" && second[2].id === second[1].toolCall.id && second[2].result.value === 36);
  check("tool definitions carry no run function", JSON.stringify(engineCalls[1].t.tools).indexOf("\"run\"") === -1);
  check("route traces: fast→local-qwen once, reasoning→claude-cli twice, all ok", traces.filter(t => t.kind === "route").map(t => t.intent + ":" + t.provider + ":" + t.ok).join() === "fast:local-qwen:true,reasoning:claude-cli:true,reasoning:claude-cli:true");

  /* Harness 的修复语义保留：形状错的回合不在桥里判，交给 Harness 退回，下一次 transcript 里有 harness 消息 */
  const seen = [];
  let k = 0;
  const repairEngine = async (engine, task, sys, question) => { seen.push(JSON.parse(question.slice(LEGACY_TRANSCRIPT_PREFIX.length)).messages); return ++k === 1 ? { type: "bogus" } : { type: "final", output: "fixed" }; };
  const rp = createLegacyProvider({ id: "claude-cli", capabilities: ["reasoning"], runEngine: repairEngine, engine: "claude", task: "tutor", lang: "zh" });
  const h = createHarness({ registry, tools: [], onTrace: () => {} });
  const hr = await h.run({ ctx: { role: "student", kidId: null }, model: createModelRouter({ providers: [rp], routes: { reasoning: ["claude-cli"] } }).bind("reasoning"), input: "q" });
  check("a malformed engine turn becomes a Harness repair message (not a provider failure)", hr.ok && hr.output === "fixed" && seen[1].at(-1).role === "harness" && seen[1].at(-1).error.code === "BAD_MODEL_OUTPUT");

  /* Harness 取消：run 被 abort → router CANCELLED → run CANCELLED，引擎的迟到结果被丢掉 */
  let release;
  const slow = createLegacyProvider({ id: "claude-cli", capabilities: ["reasoning"], runEngine: () => new Promise(res => { release = res; }), engine: "claude", task: "tutor", lang: "zh" });
  const ac = new AbortController();
  const h2 = createHarness({ registry, tools: [], onTrace: () => {} });
  const pr = h2.run({ ctx: { role: "student", kidId: null }, model: createModelRouter({ providers: [slow], routes: { reasoning: ["claude-cli"] } }).bind("reasoning"), input: "q", signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  const hr2 = await pr;
  release({ type: "final", output: "late" });
  await sleep(5);
  check("Harness cancel with a router-bound legacy model → CANCELLED, late engine result ignored", !hr2.ok && hr2.error.code === "CANCELLED");
}

/* ================= 13. 早期复核意见（build/phase8/review-feedback.md）的永久回归 ================= */
console.log("review findings: cancellation during selection");
{
  for (const ret of [false, true]) {
    const ac = new AbortController();
    let invokes = 0, later = 0;
    const router = createModelRouter({ providers: [
      { id: "first", capabilities: ["fast"], available() { ac.abort(); return ret; }, invoke() { invokes++; return {}; } },
      { id: "second", capabilities: ["fast"], available() { later++; return true; }, invoke() { invokes++; return {}; } },
    ], routes: { fast: ["first", "second"] } });
    const r = await settle(router.bind("fast").next({ messages: msgs("x"), signal: ac.signal }));
    check(`available() aborts and returns ${ret} → CANCELLED, no later availability check, no invocation`, !r.ok && r.e.code === "CANCELLED" && invokes === 0 && later === 0);
  }
  /* 最后 / 唯一一个候选的 available() 取消或耗尽时限后返回 false：报 CANCELLED / TIMEOUT，不报 NO_PROVIDER（final review） */
  for (const mode of ["cancel", "deadline"]) {
    const ac = new AbortController();
    let clk = 0, inv = 0, laterChecks = 0;
    const lastOnly = createModelRouter({ now: () => clk, timeoutMs: 20, providers: [
      { id: "last", capabilities: ["fast"], available() { if (mode === "cancel") ac.abort(); else clk = 25; return false; }, invoke() { inv++; return {}; } },
    ], routes: { fast: ["last"] } });
    const r1 = await settle(lastOnly.bind("fast").next({ messages: msgs("x"), signal: ac.signal }));
    const ac2 = new AbortController();
    let clk2 = 0;
    const lastOfTwo = createModelRouter({ now: () => clk2, timeoutMs: 20, providers: [
      { id: "first", capabilities: ["fast"], available() { laterChecks++; return false; }, invoke() { inv++; return {}; } },
      { id: "last", capabilities: ["fast"], available() { if (mode === "cancel") ac2.abort(); else clk2 = 25; return false; }, invoke() { inv++; return {}; } },
    ], routes: { fast: ["first", "last"] } });
    const r2 = await settle(lastOfTwo.bind("fast").next({ messages: msgs("x"), signal: ac2.signal }));
    const want = mode === "cancel" ? "CANCELLED" : "TIMEOUT";
    check(`only / last available() ${mode === "cancel" ? "aborts" : "runs past the deadline"} then returns false → ${want}, not NO_PROVIDER; no invocation`,
      !r1.ok && r1.e.code === want && !r2.ok && r2.e.code === want && inv === 0 && laterChecks === 1, [r1.e && r1.e.code, r2.e && r2.e.code]);
  }
  const plain = createModelRouter({ providers: [{ id: "down", capabilities: ["fast"], available: () => false, invoke() { return {}; } }], routes: { fast: ["down"] } });
  const np = await settle(plain.bind("fast").next({ messages: msgs("x"), signal: new AbortController().signal }));
  check("an ordinary unavailable last candidate (no abort, time left) is still NO_PROVIDER", !np.ok && np.e.code === "NO_PROVIDER");

  let clock = 0, invokes = 0;
  const router = createModelRouter({ now: () => clock, timeoutMs: 20, providers: [{ id: "slow-check", capabilities: ["fast"], available() { clock = 100; return true; }, invoke() { invokes++; return {}; } }], routes: { fast: ["slow-check"] } });
  const r = await settle(router.bind("fast").next({ messages: msgs("x") }));
  check("availability check that runs past the deadline → TIMEOUT before any invocation", !r.ok && r.e.code === "TIMEOUT" && invokes === 0);
}

console.log("review findings: injected clock failures");
{
  const uncaught = [];
  const onUncaught = e => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  const CLOCK = "CLOCK_" + SECRET;
  const scenarios = [
    ["throws on the first read", () => { throw new Error(CLOCK); }, () => ({ type: "final", output: 1 }), true],
    ["returns NaN", () => NaN, () => ({ type: "final", output: 1 }), true],
    ["returns a string", () => "0", () => ({ type: "final", output: 1 }), true],
    ["throws once the provider resolves", (n => () => { if (++n > 2) throw new Error(CLOCK); return 0; })(0), () => ({ type: "final", output: 1 }), false],
    ["throws while a provider hangs", (n => () => { if (++n > 3) throw new Error(CLOCK); return 0; })(0), () => new Promise(() => {}), false],
    ["throws only inside trace timing", (n => () => { if (++n > 4) throw new Error(CLOCK); return 0; })(0), () => ({ type: "final", output: 1 }), false],
  ];
  for (const [name, now, beh, noInvoke] of scenarios) {
    let invokes = 0, settled = null;
    const router = createModelRouter({ now, timeoutMs: 20, providers: [{ id: "fixture", capabilities: ["fast"], invoke: (...a) => { invokes++; return beh(...a); } }], routes: { fast: ["fixture"] } });
    router.bind("fast").next({ messages: msgs("x") }).then(v => { settled = { v }; }, e => { settled = { e }; });
    await sleep(60);
    const blob = settled ? JSON.stringify(settled) + String(settled.e && settled.e.message) : "";
    check(`clock ${name} → settles with a fixed error, never echoes the clock error${noInvoke ? ", provider not called" : ""}`,
      settled && settled.e instanceof RouterError && ["INTERNAL", "TIMEOUT"].includes(settled.e.code) && !blob.includes(SECRET) && (!noInvoke || invokes === 0), settled && settled.e && settled.e.code);
  }
  await sleep(20);
  process.off("uncaughtException", onUncaught);
  check("no uncaught exception or unhandled rejection from a broken clock", uncaught.length === 0 && unhandled.length === 0, uncaught.map(String));
  const traces = [];
  const r = createModelRouter({ now: () => { throw new Error(CLOCK); }, providers: [A().p], routes: { fast: ["remote-a"] }, onTrace: t => traces.push(t) });
  await settle(r.bind("fast").next({ messages: msgs("x") }));
  check("with a broken clock the trace has ms / at = null and no clock text", traces.length === 1 && traces[0].ms === null && traces[0].at === null && traces[0].code === "INTERNAL" && !JSON.stringify(traces).includes(SECRET));
}

console.log("review findings: strict arrays and own contract fields");
{
  const hidden = []; Object.defineProperty(hidden, "0", { value: "x", enumerable: false });
  check("snapshot rejects a non-enumerable array index", snapshotJson(hidden).reason === "key" && snapshotJson(["visible"]).ok);
  const router = createModelRouter({ providers: [A().p], routes: { fast: ["remote-a"] } });
  const decorated = []; decorated.extra = "x";
  const inherited = []; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  const symbolic = []; symbolic[Symbol("s")] = 1;
  check("empty require: [] ok; decorated / re-prototyped / symbol-keyed empty arrays → INVALID_CONFIG",
    !!router.bind("fast", { require: [] }) && ["decorated", "inherited", "symbolic"].every((_, i) => throwsCode(() => router.bind("fast", { require: [decorated, inherited, symbolic][i] }), "INVALID_CONFIG")));
  const hiddenCap = ["fast"]; Object.defineProperty(hiddenCap, "0", { value: "fast", enumerable: false });
  check("non-enumerable index in a capability list → INVALID_CONFIG", throwsCode(() => createModelRouter({ providers: [{ id: "x", capabilities: hiddenCap, invoke() {} }], routes: {} }), "INVALID_CONFIG"));
  let invokes = 0, code;
  Object.defineProperty(Object.prototype, "role", { value: "user", configurable: true, writable: true });
  Object.defineProperty(Object.prototype, "name", { value: "inherited", configurable: true, writable: true });
  try {
    const r = createModelRouter({ providers: [{ id: "p", capabilities: ["fast"], invoke: () => { invokes++; return null; } }], routes: { fast: ["p"] } });
    const a = await settle(r.bind("fast").next({ messages: [{}] }));
    const b = await settle(r.bind("fast").next({ messages: msgs("x"), tools: [{}] }));
    code = [a.ok ? "ok" : a.e.code, b.ok ? "ok" : b.e.code].join();
  } finally { delete Object.prototype.role; delete Object.prototype.name; }
  check("polluted Object.prototype.role / name cannot make {} a message or a tool → INVALID_REQUEST, no invocation", code === "INVALID_REQUEST,INVALID_REQUEST" && invokes === 0, code);
}

console.log("review findings: legacy schema isolation");
{
  let second;
  const base = { capabilities: ["fast"], engine: "openai", task: "tutor", lang: "en" };
  const a = createLegacyProvider({ ...base, id: "one", runEngine: (...args) => { try { args[7].schema.required.push("unexpected"); args[7].schema.properties.type.enum.push("x"); } catch (_) { } return { type: "final", output: 1 }; } });
  const b = createLegacyProvider({ ...base, id: "two", runEngine: (...args) => { second = JSON.stringify(args[7].schema); return { type: "final", output: 2 }; } });
  const req = Object.freeze({ intent: "fast", system: "S", messages: msgs("x"), tools: [], step: null, images: [] });
  await a.invoke(req, {}); await a.invoke(req, {}); await b.invoke(req, {});
  check("one runEngine mutating its schema copy cannot contaminate later calls or other providers", second === JSON.stringify(LEGACY_TURN_SCHEMA) && LEGACY_TURN_SCHEMA.required.join() === "type");
}

console.log("review findings: the turn contract reaches every real adapter transport");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yy-p8-adapters-"));
  const cliLog = path.join(tmp, "cli.jsonl");
  /* 合成 CLI：记下收到的提示词（-p 参数 / --prompt-file 内容 / codex exec 的最后一个参数），按各引擎的信封格式回一个 final 回合 */
  const stubCli = path.join(tmp, "stub-cli.js");
  fs.writeFileSync(stubCli, [
    "const fs = require('fs'); const a = process.argv.slice(2); let prompt = '';",
    "const pf = a.indexOf('--prompt-file'); const p = a.indexOf('-p');",
    "if (a[0] === 'exec') prompt = a[a.length - 1]; else if (pf >= 0) prompt = fs.readFileSync(a[pf + 1], 'utf8'); else if (p >= 0) prompt = a[p + 1];",
    "fs.appendFileSync(process.env.YY_P8_CLI_LOG, JSON.stringify({ prompt }) + '\\n');",
    "const turn = { type: 'final', output: 'cli-ok' };",
    "if (pf >= 0) process.stdout.write(JSON.stringify({ structuredOutput: turn }));",
    "else if (a.includes('--output-format')) process.stdout.write(JSON.stringify({ result: JSON.stringify(turn) }));",
    "else process.stdout.write(JSON.stringify(turn));",
  ].join("\n"));
  const prevLog = process.env.YY_P8_CLI_LOG;
  process.env.YY_P8_CLI_LOG = cliLog;
  const cfg = { provider: "auto", providerByTask: {}, ollama: { url: "http://synthetic.invalid", structured: false }, claude: {}, anthropic: { apiKey: "SYNTHETIC-KEY", model: "synthetic" }, openai: { apiKey: "SYNTHETIC-KEY", baseUrl: "http://synthetic.invalid/v1", model: "synthetic" } };
  const origLog = console.log; console.log = () => {};
  let inst;
  try { inst = models.create({ cfg, L: (l, z, e) => (l === "en" ? e : z), JSON_HINT: { zh: "OLD-LESSON-HINT", en: "OLD-LESSON-HINT" }, LESSON_SCHEMA: { old: true }, DATA_ROOT: tmp }); }
  finally { console.log = origLog; }
  for (const id of ["claude", "grok", "gemini", "codex"]) inst.detected[id] = { available: true, bin: stubCli };
  inst.detected.ollama = { available: true, model: "synthetic" };
  const sent = [];
  const origFetch = globalThis.fetch;
  const turnText = JSON.stringify({ type: "final", output: "http-ok" });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), body });
    const payload = /anthropic/.test(url) ? { content: [{ type: "text", text: turnText }] } : /chat\/completions/.test(url) ? { choices: [{ message: { content: turnText } }] } : { message: { content: turnText } };
    return { ok: true, json: async () => payload, text: async () => "" };
  };
  const system = "SKILL-SYSTEM", tools = [{ name: "calculator.evaluate", parameters: { type: "object" } }];
  const messages = [{ role: "user", content: "q" }, { role: "tool", id: "c1", tool: "calculator.evaluate", ok: true, result: { value: 36 } }];
  const outbound = {};
  try {
    for (const engine of LEGACY_ENGINES) {
      for (const structured of engine === "ollama" ? [false, true] : [false]) {
        cfg.ollama.structured = structured;
        const key = engine + (structured ? "(structured)" : "");
        const p = createLegacyProvider({ id: "p-" + engine, capabilities: ["reasoning"], runEngine: inst.runEngine, engine, task: "tutor", lang: "en" });
        const before = sent.length;
        const r = await settle(createModelRouter({ providers: [p], routes: { reasoning: [p.id] }, timeoutMs: 20000 }).bind("reasoning").next({ system, messages, tools }));
        let text;
        if (["claude", "grok", "gemini", "codex"].includes(engine)) { const lines = fs.readFileSync(cliLog, "utf8").trim().split("\n"); text = JSON.parse(lines.at(-1)).prompt; }
        else { const b = sent[before].body; text = JSON.stringify(b.system || "") + JSON.stringify(b.messages || []); }   // HTTP 引擎：看真正发出的 body（JSON 转义形式）
        outbound[key] = { ok: r.ok && r.v.type === "final", text };
      }
    }
  } finally { globalThis.fetch = origFetch; if (prevLog === undefined) delete process.env.YY_P8_CLI_LOG; else process.env.YY_P8_CLI_LOG = prevLog; }
  const contractIn = t => t.includes(LEGACY_TURN_CONTRACT) || t.includes(JSON.stringify(LEGACY_TURN_CONTRACT).slice(1, -1));
  const bad = Object.entries(outbound).filter(([, o]) => !(o.ok && contractIn(o.text) && o.text.includes("SKILL-SYSTEM") && o.text.includes("calculator.evaluate") && !o.text.includes("OLD-LESSON-HINT"))).map(([k]) => k);
  check("all 7 real adapters (ollama in both modes) send system + turn contract + transcript, never the old lesson hint", Object.keys(outbound).length === 8 && bad.length === 0, bad);
  const schemaSent = sent.filter(s => s.body.format || s.body.output_config).map(s => JSON.stringify(s.body.format || s.body.output_config.format.schema));
  check("structured transports get the turn schema, not the lesson schema", schemaSent.length === 2 && schemaSent.every(s => s === JSON.stringify(LEGACY_TURN_SCHEMA)));
  const ledger = fs.readFileSync(path.join(tmp, "usage.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  check("runEngine still writes its ledger (temp dir): one ok row per call, task = injected name", ledger.length === 8 && ledger.every(l => l.task === "tutor" && l.ok === true));
  check("no request reached anything but the fetch mock (no real network)", sent.every(s => s.url.startsWith("http://synthetic.invalid") || s.url.startsWith("https://api.anthropic.com")) && sent.length === 4);
  fs.rmSync(tmp, { recursive: true, force: true });
}

await sleep(20);
check("no unhandled promise rejections anywhere", unhandled.length === 0, unhandled.map(e => String(e && e.message)));
process.exitCode = summary() ? 0 : 1;
