#!/usr/bin/env node
/*
 * Tutor Memory 单测（#34，#19 Phase 5 片 1）。零成本：不起服务器、不读 data/、不调模型、不碰磁盘。
 *
 *   node tools/test_memory.mjs
 *
 * 验证：事件白名单 / 标识格式 / 原型与 Symbol / 非法输入；幂等与冲突；尝试—结果关联只结算一次；容量不截断；
 * 纯投影与重放确定性；损坏 / 未知版本文档拒绝；同 tick 输入变异；并发与失败不发布；跨所有者隔离；
 * Session 的题目 / 尝试 / 提示 / 工具观察 / 阶段、切题清理、每类与活跃上限、TTL 边界、关闭、快照不可污染。
 * 文件适配器见 tools/test_memory_store.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const memoryMod = require("../lib/ai/memory/index.js");
const eventsMod = require("../lib/ai/memory/events.js");
const { createMemory, MemoryError, EVENT_TYPES, MISTAKES, STYLES, SESSION_STAGES, DEFAULTS } = memoryMod;
const { project, replay, DOC_VERSION } = eventsMod;
const { check, summary } = makeChecker();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));

/* 结果码：resolve → "OK"，MemoryError → 它的 code，其他异常 → "FOREIGN:<name>" */
async function code(p) {
  try { await p; return "OK"; } catch (e) { return e instanceof MemoryError ? e.code : "FOREIGN:" + (e && e.name); }
}
function syncCode(fn) {
  try { fn(); return "OK"; } catch (e) { return e instanceof MemoryError ? e.code : "FOREIGN:" + (e && e.name); }
}
const isDeepFrozen = v => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const J = v => JSON.stringify(v);

/* 桩 store：按 ownerKey 存 JSON 字符串、promise 队列串行、记录每次调用；failWrites 让接下来 n 次写失败 */
function fakeStore() {
  const docs = new Map(), calls = [];
  let tail = Promise.resolve(), failWrites = 0;
  const q = fn => { const r = tail.then(fn); tail = r.catch(() => {}); return r; };
  return {
    docs, calls,
    failNext(n = 1) { failWrites = n; },
    read(owner) {
      calls.push({ op: "read", owner: J(owner), frozen: Object.isFrozen(owner) });
      return q(async () => { const k = J(owner); return docs.has(k) ? JSON.parse(docs.get(k)) : null; });
    },
    update(owner, transform) {
      calls.push({ op: "update", owner: J(owner), frozen: Object.isFrozen(owner) });
      return q(async () => {
        const k = J(owner);
        const cur = docs.has(k) ? JSON.parse(docs.get(k)) : null;
        const next = transform(cur);
        if (next === null) return { doc: cur, written: false };
        if (failWrites > 0) { failWrites--; throw Object.assign(new Error("EIO: disk on fire"), { code: "EIO" }); }
        docs.set(k, JSON.stringify(next));
        return { doc: next, written: true };
      });
    },
  };
}

let clock = 1000;
const now = () => clock;
const A = Object.freeze({ userId: "u1", kidId: "k1", role: "student" });
const A_PARENT = Object.freeze({ userId: "u1", kidId: "k1", role: "parent" });
const B = Object.freeze({ userId: "u1", kidId: "k2", role: "parent" });
const fresh = extra => { const store = fakeStore(); return { store, mem: createMemory({ store, now, ...(extra || {}) }) }; };

const SAMPLE = {
  question_attempt: { eventId: "e-qa", type: "question_attempt", topicId: "BC.MATH.G5.DEC3", attemptId: "att-1" },
  hint_requested: { eventId: "e-h", type: "hint_requested", topicId: "BC.MATH.G5.DEC3" },
  answer_correct: { eventId: "e-ok", type: "answer_correct", topicId: "BC.MATH.G5.DEC3", attemptId: "att-1" },
  answer_wrong: { eventId: "e-bad", type: "answer_wrong", topicId: "BC.MATH.G5.DEC3", attemptId: "att-1", mistake: "calculation" },
  concept_explained: { eventId: "e-c", type: "concept_explained", topicId: "BC.MATH.G5.DEC3" },
  prerequisite_gap_detected: { eventId: "e-g", type: "prerequisite_gap_detected", topicId: "BC.MATH.G5.DEC3", prerequisiteTopicId: "BC.MATH.G4.PLACE" },
  topic_mastered: { eventId: "e-m", type: "topic_mastered", topicId: "BC.MATH.G5.DEC3" },
  preference_set: { eventId: "e-p", type: "preference_set", style: "visual" },
};
/* 结果类事件要先有尝试 */
const NEEDS_ATTEMPT = new Set(["answer_correct", "answer_wrong"]);
const REQUIRED = {
  question_attempt: ["eventId", "type", "topicId", "attemptId"],
  hint_requested: ["eventId", "type", "topicId"],
  answer_correct: ["eventId", "type", "topicId", "attemptId"],
  answer_wrong: ["eventId", "type", "topicId", "attemptId"],
  concept_explained: ["eventId", "type", "topicId"],
  prerequisite_gap_detected: ["eventId", "type", "topicId", "prerequisiteTopicId"],
  topic_mastered: ["eventId", "type", "topicId"],
  preference_set: ["eventId", "type", "style"],
};
const FIELDS = ["topicId", "attemptId", "mistake", "prerequisiteTopicId", "style"];
const FIELD_SAMPLE = { topicId: "T9", attemptId: "att-9", mistake: "reading", prerequisiteTopicId: "T8", style: "concrete" };
const ALLOWED = {
  question_attempt: ["topicId", "attemptId"], hint_requested: ["topicId", "attemptId"], answer_correct: ["topicId", "attemptId"],
  answer_wrong: ["topicId", "attemptId", "mistake"], concept_explained: ["topicId"], prerequisite_gap_detected: ["topicId", "prerequisiteTopicId"],
  topic_mastered: ["topicId"], preference_set: ["style"],
};

/* ---------------------------------------------------------------- 模块形状与隔离 */
console.log("module shape and isolation");
check("index exports createMemory / MemoryError / enums / DEFAULTS only",
  Object.keys(memoryMod).sort().join() === ["createMemory", "MemoryError", "EVENT_TYPES", "MISTAKES", "STYLES", "SESSION_STAGES", "DEFAULTS"].sort().join(), Object.keys(memoryMod));
check("event types are exactly the 7 of the issue + preference_set",
  J(EVENT_TYPES) === J(["question_attempt", "hint_requested", "answer_correct", "answer_wrong", "concept_explained", "prerequisite_gap_detected", "topic_mastered", "preference_set"]));
check("mistakes are the five #31 categories", J(MISTAKES) === J(["concept", "calculation", "reading", "careless", "prerequisite-gap"]));
check("styles are a small closed set", J(STYLES) === J(["visual", "step-by-step", "concrete", "symbolic"]));
check("session stages are a closed set", J(SESSION_STAGES) === J(["understand", "explain", "hint", "practice", "check", "review"]));
check("defaults: 30 min TTL, 100 sessions, 32 per category, 10000 events",
  DEFAULTS.sessionTtlMs === 30 * 60 * 1000 && DEFAULTS.maxSessions === 100 && DEFAULTS.maxEntries === 32 && DEFAULTS.maxEvents === 10000);
check("exported enums and DEFAULTS are frozen", [EVENT_TYPES, MISTAKES, STYLES, SESSION_STAGES, DEFAULTS].every(Object.isFrozen));
{
  const dir = path.join(ROOT, "lib/ai/memory");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
  const reqs = files.flatMap(f => [...fs.readFileSync(path.join(dir, f), "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]));
  const okReq = new Set(["crypto", "fs", "path", "node:crypto", "node:fs", "node:path", "./errors.js", "./events.js"]);
  check("lib/ai/memory requires only node crypto/fs/path and its own modules (zero deps, no server, no model, no actions)",
    files.length >= 4 && reqs.length > 0 && reqs.every(r => okReq.has(r)), reqs);
  const src = files.map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  check("lib/ai/memory never names server.js, data/kids, qbank, config.json, usage.jsonl or an http module",
    !/server\.js|data[\\/]+kids|qbank|config\.json|usage\.jsonl|require\(["'](node:)?https?["']\)/.test(src));
  const toolSrc = fs.readdirSync(path.join(ROOT, "lib/ai/tools")).map(f => fs.readFileSync(path.join(ROOT, "lib/ai/tools", f), "utf8")).join("\n")
    + fs.readFileSync(path.join(ROOT, "lib/ai/tutor/index.js"), "utf8") + fs.readFileSync(path.join(ROOT, "lib/ai/harness/index.js"), "utf8");
  check("no tool, the tutor or the harness references the memory module (model gets no store)", !/ai\/memory|\.\.\/memory/.test(toolSrc));
  const { TUTOR_TOOLS } = require("../lib/ai/tutor/index.js");
  check("TutorAgent tool list is still the two read-only tools", J([...TUTOR_TOOLS]) === J(["calculator.evaluate", "curriculum.findTopic"]));
}

/* ---------------------------------------------------------------- createMemory 选项 */
console.log("createMemory options");
{
  const store = fakeStore();
  const bad = [
    ["no options", undefined], ["null", null], ["array", [store]], ["no store", { now }],
    ["store without update", { store: { read: store.read } }], ["store without read", { store: { update: store.update } }],
    ["unknown option", { store, sessionTTL: 5 }], ["now not a function", { store, now: 5 }],
    ["maxEvents 0", { store, maxEvents: 0 }], ["maxEvents -1", { store, maxEvents: -1 }], ["maxEvents 1.5", { store, maxEvents: 1.5 }],
    ["maxEvents NaN", { store, maxEvents: NaN }], ["maxEvents Infinity", { store, maxEvents: Infinity }], ["maxEvents '10'", { store, maxEvents: "10" }],
    ["maxEvents 1e6", { store, maxEvents: 1e6 }], ["sessionTtlMs 999", { store, sessionTtlMs: 999 }], ["maxSessions 0", { store, maxSessions: 0 }],
    ["maxEntries 1001", { store, maxEntries: 1001 }], ["class instance", new (class { constructor() { this.store = store; } })()],
    ["getter option", Object.defineProperty({ store }, "maxEvents", { get: () => 5, enumerable: true })],
    ["symbol key", { store, [Symbol("x")]: 1 }],
    ["throwing proxy", new Proxy({ store }, { ownKeys() { throw new Error("trap"); } })],
  ];
  for (const [name, opts] of bad) check("createMemory rejects " + name + " with INVALID_OPTIONS", syncCode(() => createMemory(opts)) === "INVALID_OPTIONS");
  check("null-prototype options are accepted", syncCode(() => createMemory(Object.assign(Object.create(null), { store }))) === "OK");
  const m = createMemory({ store });
  check("the service object is frozen and exposes exactly the seven operations (no store)",
    Object.isFrozen(m) && Object.keys(m).sort().join() === ["appendEvent", "closeSession", "createSession", "getEvents", "getSession", "getStudentMemory", "updateSession"].sort().join()
    && !Object.values(m).some(v => v === store));
  /* Object.prototype 上被污染的选项不生效 */
  let polluted;
  Object.prototype.maxEvents = 1;
  try { polluted = createMemory({ store: fakeStore(), now }); } finally { delete Object.prototype.maxEvents; }
  await polluted.appendEvent(A, { eventId: "p1", type: "concept_explained", topicId: "T" });
  check("an Object.prototype.maxEvents pollution does not become the limit", await code(polluted.appendEvent(A, { eventId: "p2", type: "concept_explained", topicId: "T" })) === "OK");
}

/* ---------------------------------------------------------------- ctx */
console.log("ctx");
{
  const { store, mem } = fresh();
  const badCtx = [
    ["undefined", undefined], ["null", null], ["string", "u1"], ["missing kidId", { userId: "u1", role: "student" }],
    ["missing userId", { kidId: "k1", role: "student" }], ["empty userId", { userId: "", kidId: "k1", role: "student" }],
    ["empty kidId", { userId: "u1", kidId: "", role: "student" }], ["numeric userId", { userId: 7, kidId: "k1", role: "student" }],
    ["null kidId", { userId: "u1", kidId: null, role: "parent" }], ["control char", { userId: "u\u0000", kidId: "k1", role: "student" }],
    ["too long userId", { userId: "u".repeat(129), kidId: "k1", role: "student" }], ["bad role", { userId: "u1", kidId: "k1", role: "admin" }],
    ["missing role", { userId: "u1", kidId: "k1" }], ["extra key", { userId: "u1", kidId: "k1", role: "student", superuser: true }],
    ["String object", { userId: new String("u1"), kidId: "k1", role: "student" }],
    ["getter", Object.defineProperty({ kidId: "k1", role: "student" }, "userId", { get: () => "u1", enumerable: true })],
    ["symbol key", { userId: "u1", kidId: "k1", role: "student", [Symbol("r")]: 1 }],
    ["inherited fields", Object.create({ userId: "u1", kidId: "k1", role: "student" })],
    ["throwing proxy", new Proxy({ userId: "u1", kidId: "k1", role: "student" }, { getOwnPropertyDescriptor() { throw new MemoryError("OK", "forged"); } })],
  ];
  const ev = { eventId: "c1", type: "concept_explained", topicId: "T" };
  for (const [name, ctx] of badCtx) {
    const codes = [await code(mem.appendEvent(ctx, ev)), await code(mem.getEvents(ctx)), await code(mem.getStudentMemory(ctx)), await code(mem.createSession(ctx))];
    check("ctx " + name + " → INVALID_CTX on every entry point", codes.every(c => c === "INVALID_CTX"), codes);
  }
  check("rejected ctx never reached the store", store.calls.length === 0, store.calls);
  check("a null-prototype ctx is accepted", await code(mem.getEvents(Object.assign(Object.create(null), A))) === "OK");
}

/* ---------------------------------------------------------------- 事件白名单 */
console.log("event whitelist");
for (const type of EVENT_TYPES) {
  const { store, mem } = fresh();
  if (NEEDS_ATTEMPT.has(type)) await mem.appendEvent(A, SAMPLE.question_attempt);
  const r = await mem.appendEvent(A, SAMPLE[type]);
  const { at, ...rest } = r.event;
  check(type + ": valid sample stored with service time and exactly its fields", r.duplicate === false && at === clock && J(rest) === J(SAMPLE[type]) && isDeepFrozen(r), r);
  for (const k of REQUIRED[type]) {
    const input = { ...SAMPLE[type], eventId: "miss-" + k }; delete input[k];
    if (k === "eventId") delete input.eventId;
    check(type + ": missing " + k + " → INVALID_INPUT", await code(mem.appendEvent(A, input)) === "INVALID_INPUT");
  }
  for (const f of FIELDS.filter(f => !ALLOWED[type].includes(f)))
    check(type + ": forbidden field " + f + " → INVALID_INPUT", await code(mem.appendEvent(A, { ...SAMPLE[type], eventId: "x-" + f, [f]: FIELD_SAMPLE[f] })) === "INVALID_INPUT");
  for (const k of ["at", "question", "answer", "message", "text", "note", "score", "mastery"])
    check(type + ": caller field " + k + " → INVALID_INPUT", await code(mem.appendEvent(A, { ...SAMPLE[type], eventId: "y-" + k, [k]: k === "at" ? 1 : "free text" })) === "INVALID_INPUT");
  const evs = await mem.getEvents(A);
  check(type + ": rejected inputs left the event list untouched", evs.length === (NEEDS_ATTEMPT.has(type) ? 2 : 1), evs);
  void store;
}
{
  const { store, mem } = fresh();
  const base = { eventId: "v1", type: "concept_explained", topicId: "T" };
  const badInputs = [
    ["undefined", undefined], ["null", null], ["array", [base]], ["string", "concept_explained"], ["Date", new Date()],
    ["unknown type", { ...base, type: "question_asked" }], ["type not string", { ...base, type: 3 }],
    ["eventId empty", { ...base, eventId: "" }], ["eventId with space", { ...base, eventId: "a b" }], ["eventId leading _", { ...base, eventId: "_x" }],
    ["eventId 65 chars", { ...base, eventId: "e".repeat(65) }], ["eventId non-ascii", { ...base, eventId: "é1" }], ["eventId with slash", { ...base, eventId: "a/b" }],
    ["eventId number", { ...base, eventId: 5 }], ["eventId String object", { ...base, eventId: new String("v1") }],
    ["topicId __proto__", { ...base, topicId: "__proto__" }], ["topicId 97 chars", { ...base, topicId: "T".repeat(97) }], ["topicId with newline", { ...base, topicId: "T\n1" }],
    ["own __proto__ key", JSON.parse('{"eventId":"v1","type":"concept_explained","topicId":"T","__proto__":{"x":1}}')],
    ["inherited fields", Object.create(base)], ["class instance", new (class { constructor() { Object.assign(this, base); } })()],
    ["symbol key", { ...base, [Symbol("s")]: 1 }], ["non-enumerable field", Object.defineProperty({ eventId: "v1", type: "concept_explained" }, "topicId", { value: "T", enumerable: false })],
    ["mistake unknown", { eventId: "v2", type: "answer_wrong", topicId: "T", attemptId: "a", mistake: "silly" }],
    ["mistake null", { eventId: "v2", type: "answer_wrong", topicId: "T", attemptId: "a", mistake: null }],
    ["style unknown", { eventId: "v3", type: "preference_set", style: "fun" }], ["style free text", { eventId: "v3", type: "preference_set", style: "likes pictures of cats" }],
    ["prerequisite = topic", { eventId: "v4", type: "prerequisite_gap_detected", topicId: "T", prerequisiteTopicId: "T" }],
    ["attemptId bad", { eventId: "v5", type: "question_attempt", topicId: "T", attemptId: "a b" }],
    ["optional field set to undefined", { ...SAMPLE.hint_requested, attemptId: undefined }],
  ];
  for (const [name, input] of badInputs) check("input " + name + " → INVALID_INPUT", await code(mem.appendEvent(A, input)) === "INVALID_INPUT");
  let getterRan = 0;
  const g = Object.defineProperty({ eventId: "v6", type: "concept_explained" }, "topicId", { get: () => { getterRan++; return "T"; }, enumerable: true });
  check("getter field → INVALID_INPUT and the getter never runs", await code(mem.appendEvent(A, g)) === "INVALID_INPUT" && getterRan === 0);
  const forged = new Proxy(base, { ownKeys() { throw new MemoryError("OK", "forged"); } });
  let e; try { await mem.appendEvent(A, forged); } catch (x) { e = x; }
  check("a throwing proxy becomes our own INVALID_INPUT (forged error not passed through)", e instanceof MemoryError && e.code === "INVALID_INPUT" && e.message !== "forged");
  let echoed = false;
  try { await mem.appendEvent(A, { ...base, question: "SECRET-QUESTION-TEXT" }); } catch (x) { echoed = String(x.message).includes("SECRET"); }
  check("error messages do not echo caller text", echoed === false);
  check("invalid inputs never reached the store", store.calls.length === 0, store.calls);
  check("null-prototype input is accepted", await code(mem.appendEvent(A, Object.assign(Object.create(null), base))) === "OK");
  check("topicId 'constructor' / 'toString' are plain ids", await code(mem.appendEvent(A, { eventId: "v7", type: "concept_explained", topicId: "constructor" })) === "OK"
    && await code(mem.appendEvent(A, { eventId: "v8", type: "concept_explained", topicId: "toString" })) === "OK");
  const sm = await mem.getStudentMemory(A);
  const ctor = sm.topics.find(t => t.topicId === "constructor");
  check("projection counts 'constructor' from zero (no prototype leakage)", ctor && ctor.explanations === 1 && ctor.attempts === 0 && sm.topics.length === 3, sm);
}

/* ---------------------------------------------------------------- 幂等与冲突 */
console.log("idempotency and conflicts");
{
  const { store, mem } = fresh();
  clock = 1000;
  const first = await mem.appendEvent(A, SAMPLE.question_attempt);
  clock = 5000;
  const again = await mem.appendEvent(A, { ...SAMPLE.question_attempt });
  check("same eventId + same content → duplicate:true, original record and original at", again.duplicate === true && again.event.at === 1000 && J(again.event) === J(first.event));
  check("the duplicate did not write", store.calls.filter(c => c.op === "update").length === 2 && JSON.parse(store.docs.get(J(["u1", "k1"]))).events.length === 1);
  const conflicts = [
    ["different topic", { ...SAMPLE.question_attempt, topicId: "OTHER" }],
    ["different type", { ...SAMPLE.concept_explained, eventId: "e-qa" }],
    ["different attemptId", { ...SAMPLE.question_attempt, attemptId: "att-2" }],
  ];
  for (const [name, input] of conflicts) check("same eventId, " + name + " → EVENT_CONFLICT", await code(mem.appendEvent(A, input)) === "EVENT_CONFLICT");
  check("reusing an attemptId under a new eventId → EVENT_CONFLICT", await code(mem.appendEvent(A, { ...SAMPLE.question_attempt, eventId: "e-qa2" })) === "EVENT_CONFLICT");
  check("reusing an attemptId in another topic → EVENT_CONFLICT", await code(mem.appendEvent(A, { ...SAMPLE.question_attempt, eventId: "e-qa3", topicId: "OTHER" })) === "EVENT_CONFLICT");

  check("outcome for an unknown attempt → ATTEMPT_NOT_FOUND", await code(mem.appendEvent(A, { ...SAMPLE.answer_correct, attemptId: "nope" })) === "ATTEMPT_NOT_FOUND");
  check("outcome referencing an attempt of another topic → ATTEMPT_NOT_FOUND", await code(mem.appendEvent(A, { ...SAMPLE.answer_correct, topicId: "OTHER" })) === "ATTEMPT_NOT_FOUND");
  check("hint referencing an unknown attempt → ATTEMPT_NOT_FOUND", await code(mem.appendEvent(A, { ...SAMPLE.hint_requested, attemptId: "nope" })) === "ATTEMPT_NOT_FOUND");
  check("hint referencing an attempt of another topic → ATTEMPT_NOT_FOUND", await code(mem.appendEvent(A, { ...SAMPLE.hint_requested, topicId: "OTHER", attemptId: "att-1" })) === "ATTEMPT_NOT_FOUND");
  check("hint linked to its attempt → OK", await code(mem.appendEvent(A, { ...SAMPLE.hint_requested, attemptId: "att-1" })) === "OK");

  clock = 6000;
  const ok1 = await mem.appendEvent(A, SAMPLE.answer_correct);
  check("first outcome settles the attempt", ok1.duplicate === false && ok1.event.at === 6000);
  clock = 7000;
  const okDup = await mem.appendEvent(A, SAMPLE.answer_correct);
  check("retrying the same outcome eventId → duplicate with original at", okDup.duplicate === true && okDup.event.at === 6000);
  check("a second correct under a new eventId → ATTEMPT_SETTLED", await code(mem.appendEvent(A, { ...SAMPLE.answer_correct, eventId: "e-ok2" })) === "ATTEMPT_SETTLED");
  check("a contradicting wrong after correct → ATTEMPT_SETTLED", await code(mem.appendEvent(A, SAMPLE.answer_wrong)) === "ATTEMPT_SETTLED");
  check("same outcome eventId but now wrong → EVENT_CONFLICT", await code(mem.appendEvent(A, { ...SAMPLE.answer_wrong, eventId: "e-ok" })) === "EVENT_CONFLICT");
  check("hint on a settled attempt is still fine", await code(mem.appendEvent(A, { ...SAMPLE.hint_requested, eventId: "e-h2", attemptId: "att-1" })) === "OK");
  const t = (await mem.getStudentMemory(A)).topics.find(x => x.topicId === SAMPLE.question_attempt.topicId);
  check("projection counts one attempt, one correct, zero wrong, two hints", t.attempts === 1 && t.correct === 1 && t.wrong === 0 && t.unsettled === 0 && t.hints === 2, t);

  /* answer_wrong 的 mistake 有无也算内容 */
  await mem.appendEvent(A, { eventId: "w-a", type: "question_attempt", topicId: "W", attemptId: "w1" });
  await mem.appendEvent(A, { eventId: "w-r", type: "answer_wrong", topicId: "W", attemptId: "w1" });
  check("answer_wrong retried with a mistake added → EVENT_CONFLICT", await code(mem.appendEvent(A, { eventId: "w-r", type: "answer_wrong", topicId: "W", attemptId: "w1", mistake: "careless" })) === "EVENT_CONFLICT");
  check("answer_wrong retried identically → duplicate", (await mem.appendEvent(A, { eventId: "w-r", type: "answer_wrong", topicId: "W", attemptId: "w1" })).duplicate === true);
}

/* ---------------------------------------------------------------- 容量 */
console.log("capacity");
{
  const { store, mem } = fresh({ maxEvents: 3 });
  for (let i = 1; i <= 3; i++) await mem.appendEvent(A, { eventId: "c" + i, type: "concept_explained", topicId: "T" });
  const before = store.docs.get(J(["u1", "k1"]));
  check("the 4th event with maxEvents 3 → CAPACITY", await code(mem.appendEvent(A, { eventId: "c4", type: "concept_explained", topicId: "T" })) === "CAPACITY");
  check("capacity failure wrote nothing and truncated nothing", store.docs.get(J(["u1", "k1"])) === before && (await mem.getEvents(A)).map(e => e.eventId).join() === "c1,c2,c3");
  check("an idempotent retry still works when full", (await mem.appendEvent(A, { eventId: "c1", type: "concept_explained", topicId: "T" })).duplicate === true);
  check("other owners are not affected by one owner being full", await code(mem.appendEvent(B, { eventId: "c4", type: "concept_explained", topicId: "T" })) === "OK");
}

/* ---------------------------------------------------------------- 投影与重放 */
console.log("projection and replay");
{
  const { mem } = fresh();
  clock = 100;
  const seq = [
    { eventId: "1", type: "question_attempt", topicId: "T1", attemptId: "a1" },
    { eventId: "2", type: "answer_correct", topicId: "T1", attemptId: "a1" },
    { eventId: "3", type: "question_attempt", topicId: "T2", attemptId: "a2" },
    { eventId: "4", type: "hint_requested", topicId: "T2", attemptId: "a2" },
    { eventId: "5", type: "answer_wrong", topicId: "T2", attemptId: "a2", mistake: "concept" },
    { eventId: "6", type: "question_attempt", topicId: "T2", attemptId: "a3" },
    { eventId: "7", type: "answer_wrong", topicId: "T2", attemptId: "a3" },
    { eventId: "8", type: "prerequisite_gap_detected", topicId: "T2", prerequisiteTopicId: "T0" },
    { eventId: "9", type: "prerequisite_gap_detected", topicId: "T2", prerequisiteTopicId: "T0" },
    { eventId: "10", type: "prerequisite_gap_detected", topicId: "T2", prerequisiteTopicId: "T00" },
    { eventId: "11", type: "concept_explained", topicId: "T2" },
    { eventId: "12", type: "question_attempt", topicId: "T2", attemptId: "a4" },
    { eventId: "13", type: "preference_set", style: "visual" },
    { eventId: "14", type: "topic_mastered", topicId: "T3" },
    { eventId: "15", type: "topic_mastered", topicId: "T3" },
    { eventId: "16", type: "preference_set", style: "step-by-step" },
  ];
  for (const e of seq) { clock += 10; await mem.appendEvent(A, e); }
  const sm = await mem.getStudentMemory(A);
  const expected = {
    eventCount: 16,
    topics: [
      { topicId: "T1", attempts: 1, correct: 1, wrong: 0, unsettled: 0, hints: 0, explanations: 0, prerequisiteGaps: [],
        mistakes: { concept: 0, calculation: 0, reading: 0, careless: 0, "prerequisite-gap": 0 }, mastered: false, masteredAt: null, firstAt: 110, lastAt: 120 },
      { topicId: "T2", attempts: 3, correct: 0, wrong: 2, unsettled: 1, hints: 1, explanations: 1, prerequisiteGaps: [{ topicId: "T0", count: 2 }, { topicId: "T00", count: 1 }],
        mistakes: { concept: 1, calculation: 0, reading: 0, careless: 0, "prerequisite-gap": 0 }, mastered: false, masteredAt: null, firstAt: 130, lastAt: 220 },
      { topicId: "T3", attempts: 0, correct: 0, wrong: 0, unsettled: 0, hints: 0, explanations: 0, prerequisiteGaps: [],
        mistakes: { concept: 0, calculation: 0, reading: 0, careless: 0, "prerequisite-gap": 0 }, mastered: true, masteredAt: 240, firstAt: 240, lastAt: 250 },
    ],
    mistakes: { concept: 1, calculation: 0, reading: 0, careless: 0, "prerequisite-gap": 0 },
    preference: { style: "step-by-step", at: 260 },
  };
  check("student memory = exact projection of the explicit events", J(sm) === J(expected), sm);
  check("one correct answer does not mark T1 mastered; only topic_mastered marks T3", sm.topics[0].mastered === false && sm.topics[2].mastered === true);
  check("a wrong answer without a mistake adds no mistake category", sm.topics[1].mistakes.concept === 1 && Object.values(sm.mistakes).reduce((a, b) => a + b) === 1);
  check("student memory is deep-frozen", isDeepFrozen(sm));
  check("no inferred traits: projection keys are exactly the documented ones",
    Object.keys(sm).join() === "eventCount,topics,mistakes,preference" && sm.topics.every(t => Object.keys(t).join() === "topicId,attempts,correct,wrong,unsettled,hints,explanations,prerequisiteGaps,mistakes,mastered,masteredAt,firstAt,lastAt"));

  const evs = await mem.getEvents(A);
  check("getEvents returns stored order, deep-frozen", evs.map(e => e.eventId).join() === seq.map(e => e.eventId).join() && isDeepFrozen(evs));
  const copy = JSON.parse(J(evs));
  const p1 = project(copy), p2 = project(JSON.parse(J(evs)));
  check("project is deterministic (same events → identical output)", J(p1) === J(p2) && J(p1) === J(sm));
  check("project does not mutate its input", J(copy) === J(evs));
  check("project accepts frozen input", syncCode(() => project(evs)) === "OK");
  const rp = replay({ version: DOC_VERSION, owner: ["u1", "k1"], events: copy }, ["u1", "k1"]);
  check("replay of the stored document yields the same events", J(rp) === J(evs));
  check("replay(null) is an empty history", J(replay(null, ["u1", "k1"])) === "[]");
  const doc = events => ({ version: 1, owner: ["u1", "k1"], events });
  const e1 = { eventId: "1", type: "question_attempt", at: 1, topicId: "T", attemptId: "a" };
  const corrupt = [
    ["events not an array", { version: 1, owner: ["u1", "k1"], events: {} }],
    ["extra envelope key", { version: 1, owner: ["u1", "k1"], events: [], summary: {} }],
    ["missing owner", { version: 1, events: [] }],
    ["owner mismatch", { version: 1, owner: ["u1", "k2"], events: [] }],
    ["owner as joined string", { version: 1, owner: "u1,k1", events: [] }],
    ["event with unknown key", doc([{ ...e1, question: "2+2" }])],
    ["event without at", doc([{ eventId: "1", type: "question_attempt", topicId: "T", attemptId: "a" }])],
    ["event with negative at", doc([{ ...e1, at: -1 }])],
    ["event with fractional at", doc([{ ...e1, at: 1.5 }])],
    ["event with string at", doc([{ ...e1, at: "1" }])],
    ["duplicate eventId", doc([e1, { ...e1, attemptId: "b" }])],
    ["outcome before its attempt", doc([{ eventId: "2", type: "answer_correct", at: 1, topicId: "T", attemptId: "a" }, e1])],
    ["two outcomes for one attempt", doc([e1, { eventId: "2", type: "answer_correct", at: 2, topicId: "T", attemptId: "a" }, { eventId: "3", type: "answer_wrong", at: 3, topicId: "T", attemptId: "a" }])],
    ["unknown event type", doc([{ eventId: "1", type: "chat", at: 1, topicId: "T" }])],
    ["null event", doc([null])],
    ["doc is an array", []],
  ];
  for (const [name, d] of corrupt) check("replay rejects " + name + " with STORE_CORRUPT", syncCode(() => replay(d, ["u1", "k1"])) === "STORE_CORRUPT");
  for (const v of [0, 2, "1", null, undefined])
    check("replay rejects version " + J(v) + " with STORE_VERSION", syncCode(() => replay({ version: v, owner: ["u1", "k1"], events: [] }, ["u1", "k1"])) === "STORE_VERSION");
}

/* ---------------------------------------------------------------- 服务遇到坏文档 */
console.log("service over a bad document");
{
  const { store, mem } = fresh();
  const k = J(["u1", "k1"]);
  for (const [name, raw, want] of [
    ["future version", J({ version: 2, owner: ["u1", "k1"], events: [] }), "STORE_VERSION"],
    ["corrupt event", J({ version: 1, owner: ["u1", "k1"], events: [{ eventId: "1", type: "x", at: 1 }] }), "STORE_CORRUPT"],
  ]) {
    store.docs.set(k, raw);
    const codes = [await code(mem.getEvents(A)), await code(mem.getStudentMemory(A)), await code(mem.appendEvent(A, { eventId: "n", type: "concept_explained", topicId: "T" }))];
    check(name + ": read, summary and append all fail with " + want, codes.every(c => c === want), codes);
    check(name + ": the document was not overwritten as empty", store.docs.get(k) === raw);
  }
}

/* ---------------------------------------------------------------- 同 tick 变异、时钟、失败不发布、并发 */
console.log("snapshots, clock, failures, concurrency");
{
  const { store, mem } = fresh();
  clock = 42;
  const ctx = { userId: "u1", kidId: "k1", role: "student" };
  const input = { eventId: "m1", type: "question_attempt", topicId: "T1", attemptId: "a1" };
  const p = mem.appendEvent(ctx, input);
  ctx.kidId = "k2"; ctx.role = "admin"; input.topicId = "EVIL"; input.question = "leak"; clock = 999;
  const r = await p;
  check("same-tick mutation of ctx / input / clock does not affect the append", r.event.topicId === "T1" && r.event.at === 42 && !("question" in r.event));
  check("the event landed under the original owner, and the store got a frozen owner copy",
    (await mem.getEvents(A)).length === 1 && (await mem.getEvents(B)).length === 0 && store.calls.every(c => c.frozen) && store.calls[0].op === "update" && store.calls[0].owner === J(["u1", "k1"]));

  for (const [name, fn] of [["NaN", () => NaN], ["1.5", () => 1.5], ["negative", () => -5], ["string", () => "1"], ["throws", () => { throw new Error("clock"); }]]) {
    const s = fakeStore();
    const m2 = createMemory({ store: s, now: fn });
    const codes = [await code(m2.appendEvent(A, { eventId: "k", type: "concept_explained", topicId: "T" })), await code(m2.createSession(A))];
    check("clock " + name + " → INVALID_CLOCK, nothing written", codes.every(c => c === "INVALID_CLOCK") && s.calls.length === 0, codes);
  }

  const f = fakeStore();
  const mf = createMemory({ store: f, now });
  f.failNext(1);
  let err; try { await mf.appendEvent(A, { eventId: "f1", type: "concept_explained", topicId: "T" }); } catch (e) { err = e; }
  check("store write failure → STORE_IO with the original error as cause", err instanceof MemoryError && err.code === "STORE_IO" && err.cause && err.cause.code === "EIO");
  check("a failed write publishes nothing", (await mf.getEvents(A)).length === 0 && (await mf.getStudentMemory(A)).eventCount === 0);
  const retry = await mf.appendEvent(A, { eventId: "f1", type: "concept_explained", topicId: "T" });
  check("the retry is applied exactly once", retry.duplicate === false && (await mf.getEvents(A)).length === 1);
  const passStore = { read: async () => null, update: async () => { throw new MemoryError("CAPACITY", "full"); } };
  check("a MemoryError from the store passes through unchanged", await code(createMemory({ store: passStore, now }).appendEvent(A, { eventId: "z", type: "concept_explained", topicId: "T" })) === "CAPACITY");
  const weird = { read: async () => { throw "boom"; }, update: async () => { throw undefined; } };
  const mw = createMemory({ store: weird, now });
  check("non-Error store failures become STORE_IO", await code(mw.getEvents(A)) === "STORE_IO" && await code(mw.appendEvent(A, { eventId: "z", type: "concept_explained", topicId: "T" })) === "STORE_IO");

  const { mem: mc } = fresh();
  clock = 100;
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => mc.appendEvent(A, { eventId: "p" + i, type: "concept_explained", topicId: "T" })));
  check("20 concurrent appends on one service → 20 events, none lost", many.every(x => !x.duplicate) && (await mc.getEvents(A)).length === 20);
  const same = await Promise.all(Array.from({ length: 5 }, () => mc.appendEvent(A, { eventId: "same", type: "concept_explained", topicId: "T" })));
  check("5 concurrent appends of one eventId → one stored, four duplicates, same at", same.filter(x => !x.duplicate).length === 1 && new Set(same.map(x => x.event.at)).size === 1 && (await mc.getEvents(A)).length === 21);
  await mc.appendEvent(A, { eventId: "qa", type: "question_attempt", topicId: "T", attemptId: "race" });
  const race = await Promise.all([
    code(mc.appendEvent(A, { eventId: "r1", type: "answer_correct", topicId: "T", attemptId: "race" })),
    code(mc.appendEvent(A, { eventId: "r2", type: "answer_wrong", topicId: "T", attemptId: "race" })),
  ]);
  const tt = (await mc.getStudentMemory(A)).topics[0];
  check("two concurrent outcomes for one attempt → exactly one settles", race.sort().join() === "ATTEMPT_SETTLED,OK" && tt.correct + tt.wrong === 1, race);
}

/* ---------------------------------------------------------------- 所有者隔离 */
console.log("owner isolation");
{
  const { mem } = fresh();
  await mem.appendEvent(A, { eventId: "o1", type: "topic_mastered", topicId: "T" });
  check("a parent of the same (userId, kidId) sees the same history", (await mem.getEvents(A_PARENT)).length === 1);
  check("a parent with another kidId sees nothing (role grants no cross-owner access)", (await mem.getEvents(B)).length === 0 && (await mem.getStudentMemory(B)).eventCount === 0);
  const X = { userId: "a,b", kidId: "c", role: "student" }, Y = { userId: "a", kidId: "b,c", role: "student" };
  await mem.appendEvent(X, { eventId: "x1", type: "concept_explained", topicId: "T" });
  check("owners that would collide under separator joining stay apart", (await mem.getEvents(Y)).length === 0);
  check("the same eventId in another owner is independent", (await mem.appendEvent(Y, { eventId: "x1", type: "topic_mastered", topicId: "T" })).duplicate === false);
}

/* ---------------------------------------------------------------- Session */
console.log("session");
{
  const { store, mem } = fresh();
  clock = 10_000;
  const s = await mem.createSession(A);
  check("createSession returns a deep-frozen snapshot with the documented shape",
    isDeepFrozen(s) && Object.keys(s).join() === "sessionId,stage,question,attempts,hints,observations,createdAt,updatedAt,expiresAt"
    && /^s_[0-9a-f]{32}$/.test(s.sessionId) && s.stage === null && s.question === null && s.attempts.length === 0 && s.expiresAt === 10_000 + DEFAULTS.sessionTtlMs, s);
  const id = s.sessionId;
  check("attempt before a question → SESSION_STATE", await code(mem.updateSession(A, id, { type: "attempt", answer: "12" })) === "SESSION_STATE");
  check("hint before a question → SESSION_STATE", await code(mem.updateSession(A, id, { type: "hint", text: "look" })) === "SESSION_STATE");
  check("observation before a question → SESSION_STATE", await code(mem.updateSession(A, id, { type: "observation", tool: "calculator.evaluate", summary: "x" })) === "SESSION_STATE");
  clock = 11_000;
  let snap = await mem.updateSession(A, id, { type: "question", text: "PRIVATE-QUESTION 37 × 24", topicId: "BC.MATH.G5.MUL" });
  check("question recorded with topic and time", snap.question.text === "PRIVATE-QUESTION 37 × 24" && snap.question.topicId === "BC.MATH.G5.MUL" && snap.question.at === 11_000);
  snap = await mem.updateSession(A, id, { type: "attempt", answer: "PRIVATE-ANSWER 888" });
  snap = await mem.updateSession(A, id, { type: "hint", text: "PRIVATE-HINT split 24" });
  snap = await mem.updateSession(A, id, { type: "observation", tool: "calculator.evaluate", summary: "PRIVATE-OBS 37*24=888" });
  snap = await mem.updateSession(A, id, { type: "stage", stage: "check" });
  check("attempt / hint / observation / stage recorded",
    J(snap.attempts) === J([{ answer: "PRIVATE-ANSWER 888", at: 11_000 }]) && J(snap.hints) === J([{ text: "PRIVATE-HINT split 24", at: 11_000 }])
    && J(snap.observations) === J([{ tool: "calculator.evaluate", summary: "PRIVATE-OBS 37*24=888", at: 11_000 }]) && snap.stage === "check", snap);
  check("updates renew expiry", snap.updatedAt === 11_000 && snap.expiresAt === 11_000 + DEFAULTS.sessionTtlMs);
  snap = await mem.updateSession(A, id, { type: "question", text: "next question" });
  check("a new question clears attempts, hints and observations (stage kept, topicId null)",
    snap.question.text === "next question" && snap.question.topicId === null && snap.attempts.length === 0 && snap.hints.length === 0 && snap.observations.length === 0 && snap.stage === "check", snap);

  let threw = false;
  try { snap.attempts.push({ answer: "evil" }); } catch (_) { threw = true; }
  let threw2 = false;
  try { snap.question.text = "evil"; } catch (_) { threw2 = true; }
  check("snapshots cannot be edited and edits do not reach the session", threw && threw2 && (await mem.getSession(A, id)).question.text === "next question");
  const patch = { type: "hint", text: "original hint" };
  const pp = mem.updateSession(A, id, patch);
  patch.text = "mutated"; patch.type = "question";
  const afterPatch = await pp;
  check("same-tick mutation of the patch does not change the update", afterPatch.hints.length === 1 && afterPatch.hints[0].text === "original hint" && afterPatch.question.text === "next question");

  const badPatches = [
    ["undefined", undefined], ["unknown type", { type: "chat", text: "x" }], ["missing type", { text: "x" }], ["extra key", { type: "hint", text: "x", role: "parent" }],
    ["empty text", { type: "hint", text: "" }], ["text 2001", { type: "hint", text: "x".repeat(2001) }], ["answer 2001", { type: "attempt", answer: "x".repeat(2001) }],
    ["question 2001", { type: "question", text: "q".repeat(2001) }], ["summary 2001", { type: "observation", tool: "calculator.evaluate", summary: "s".repeat(2001) }],
    ["text number", { type: "hint", text: 5 }], ["bad tool name", { type: "observation", tool: "../etc", summary: "x" }], ["missing tool", { type: "observation", summary: "x" }],
    ["bad stage", { type: "stage", stage: "celebrate" }], ["stage null", { type: "stage", stage: null }], ["bad topicId", { type: "question", text: "q", topicId: "__proto__" }],
    ["own __proto__", JSON.parse('{"type":"hint","text":"x","__proto__":{}}')], ["inherited", Object.create({ type: "hint", text: "x" })],
    ["symbol key", { type: "hint", text: "x", [Symbol("k")]: 1 }], ["array", ["hint"]],
  ];
  for (const [name, p] of badPatches) check("patch " + name + " → INVALID_INPUT", await code(mem.updateSession(A, id, p)) === "INVALID_INPUT");
  check("2000-char texts are accepted", await code(mem.updateSession(A, id, { type: "attempt", answer: "a".repeat(2000) })) === "OK"
    && await code(mem.updateSession(A, id, { type: "question", text: "q".repeat(2000) })) === "OK");
  for (const bid of [undefined, 5, "", "s_xyz", "s_" + "0".repeat(31), "../s"])
    check("sessionId " + J(bid) + " → INVALID_INPUT", await code(mem.getSession(A, bid)) === "INVALID_INPUT");
  check("unknown well-formed sessionId → SESSION_NOT_FOUND", await code(mem.getSession(A, "s_" + "0".repeat(32))) === "SESSION_NOT_FOUND");

  const beforeOther = J(await mem.getSession(A, id));
  const other = [await code(mem.getSession(B, id)), await code(mem.updateSession(B, id, { type: "hint", text: "x" })), await code(mem.closeSession(B, id)),
    await code(mem.getSession({ userId: "u2", kidId: "k1", role: "parent" }, id))];
  check("another owner (incl. a parent of another kid / another user) cannot get / update / close", other.every(c => c === "SESSION_NOT_FOUND"), other);
  check("the session is untouched by those attempts", J(await mem.getSession(A, id)) === beforeOther);
  check("the parent of the same owner can read it (role is not part of ownership)", await code(mem.getSession(A_PARENT, id)) === "OK");

  const hints = await Promise.all(Array.from({ length: 10 }, (_, i) => mem.updateSession(A, id, { type: "hint", text: "h" + i })));
  const last = await mem.getSession(A, id);
  check("10 concurrent updates on one session → none lost, in call order", last.hints.slice(-10).map(h => h.text).join() === Array.from({ length: 10 }, (_, i) => "h" + i).join() && hints.length === 10);

  check("closeSession → { closed:true }", J(await mem.closeSession(A, id)) === J({ closed: true }));
  check("closed session is gone (get / update / close → SESSION_NOT_FOUND)",
    [await code(mem.getSession(A, id)), await code(mem.updateSession(A, id, { type: "hint", text: "x" })), await code(mem.closeSession(A, id))].every(c => c === "SESSION_NOT_FOUND"));
  check("session operations never touched the store", store.calls.length === 0, store.calls);
  await mem.appendEvent(A, { eventId: "after-session", type: "concept_explained", topicId: "BC.MATH.G5.MUL" });
  const persisted = [...store.docs.values()].join("\n");
  check("session text never reaches the event store", !/PRIVATE|next question|original hint/.test(persisted), persisted);

  const sInit = await mem.createSession(A, { stage: "explain" });
  check("createSession accepts an initial stage", sInit.stage === "explain");
  for (const [name, init] of [["unknown key", { question: "x" }], ["bad stage", { stage: "x" }], ["array", []], ["null", null]])
    check("createSession init " + name + " → INVALID_INPUT", await code(mem.createSession(A, init)) === "INVALID_INPUT");
}
{
  const { mem } = fresh({ maxEntries: 32 });
  clock = 0;
  const { sessionId: id } = await mem.createSession(A);
  await mem.updateSession(A, id, { type: "question", text: "q" });
  for (let i = 0; i < 32; i++) await mem.updateSession(A, id, { type: "hint", text: "h" + i });
  check("33rd hint → SESSION_LIMIT (not silently dropped)", await code(mem.updateSession(A, id, { type: "hint", text: "h32" })) === "SESSION_LIMIT");
  const s = await mem.getSession(A, id);
  check("the first 32 hints are intact", s.hints.length === 32 && s.hints[0].text === "h0" && s.hints[31].text === "h31");
  for (let i = 0; i < 32; i++) await mem.updateSession(A, id, { type: "attempt", answer: "a" + i });
  for (let i = 0; i < 32; i++) await mem.updateSession(A, id, { type: "observation", tool: "curriculum.findTopic", summary: "o" + i });
  check("attempts and observations have their own 32 limits", await code(mem.updateSession(A, id, { type: "attempt", answer: "x" })) === "SESSION_LIMIT"
    && await code(mem.updateSession(A, id, { type: "observation", tool: "curriculum.findTopic", summary: "x" })) === "SESSION_LIMIT");
  check("a new question resets the category counters", (await mem.updateSession(A, id, { type: "question", text: "q2" })).hints.length === 0
    && await code(mem.updateSession(A, id, { type: "hint", text: "again" })) === "OK");
}
{
  const { mem } = fresh({ maxSessions: 3, sessionTtlMs: 1000 });
  clock = 0;
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await mem.createSession(i === 2 ? B : A)).sessionId);
  check("4th active session → SESSION_LIMIT (limit is global, oldest not evicted)", await code(mem.createSession(A)) === "SESSION_LIMIT"
    && await code(mem.getSession(A, ids[0])) === "OK");
  await mem.closeSession(A, ids[0]);
  check("closing one frees a slot", await code(mem.createSession(A)) === "OK");
  clock = 999;
  check("at expiresAt - 1 the session is alive", await code(mem.getSession(A, ids[1])) === "OK");
  check("getSession does not renew", (await mem.getSession(A, ids[1])).expiresAt === 1000);
  const renewed = await mem.updateSession(A, ids[1], { type: "stage", stage: "practice" });
  check("updateSession renews to now + ttl", renewed.expiresAt === 1999);
  clock = 1000;
  check("at expiresAt an un-renewed session is gone", await code(mem.getSession(B, ids[2])) === "SESSION_NOT_FOUND"
    && await code(mem.updateSession(B, ids[2], { type: "stage", stage: "review" })) === "SESSION_NOT_FOUND");
  check("the renewed one is still alive at 1000", await code(mem.getSession(A, ids[1])) === "OK");
  clock = 1999;
  check("the renewed one expires at its new expiresAt", await code(mem.getSession(A, ids[1])) === "SESSION_NOT_FOUND");
  check("expired sessions free their slots (3 new sessions fit)", (await Promise.all([mem.createSession(A), mem.createSession(A), mem.createSession(B)])).length === 3
    && await code(mem.createSession(A)) === "SESSION_LIMIT");
}

/* ---------------------------------------------------------------- 独立复核回归（build/phase5/root-findings.md） */
console.log("review regressions");
const revoked = target => { const r = Proxy.revocable(target, {}); r.revoke(); return r.proxy; };
const ce2 = id => ({ eventId: id, type: "concept_explained", topicId: "T" });
{
  /* F1 新所有者的空历史也是冻结快照 */
  const { mem } = fresh();
  const empty = await mem.getEvents({ userId: "nobody", kidId: "k", role: "student" });
  check("F1: an owner with no history gets a frozen empty array", Array.isArray(empty) && empty.length === 0 && Object.isFrozen(empty));
  const nullStore = createMemory({ store: { read: () => null, update: () => {} }, now });
  check("F1: a store that returns null (not a promise) also yields a frozen empty array", Object.isFrozen(await nullStore.getEvents(A)));
  check("F1: the empty student memory is deep-frozen", isDeepFrozen(await mem.getStudentMemory({ userId: "nobody", kidId: "k", role: "student" })));
}
{
  /* F2 注入的 store：方法只按数据属性读一次，getter / Proxy 抛错都收成 INVALID_OPTIONS */
  let getterRan = 0;
  const cases = [
    ["read getter that throws", Object.defineProperty({ update() {} }, "read", { get() { throw new Error("synthetic"); }, enumerable: true })],
    ["read accessor that does not throw", Object.defineProperty({ update() {} }, "read", { get() { getterRan++; return () => null; }, enumerable: true })],
    ["update on an accessor in the prototype", Object.create(Object.defineProperty({}, "update", { get() { getterRan++; return () => null; } }), { read: { value: () => null } })],
    ["revoked proxy store", revoked({ read() {}, update() {} })],
    ["proxy whose descriptor trap throws", new Proxy({ read() {}, update() {} }, { getOwnPropertyDescriptor() { throw new MemoryError("OK", "forged"); } })],
    ["function as store", Object.assign(() => {}, { read() {}, update() {} })],
  ];
  for (const [name, store] of cases) {
    let e; try { createMemory({ store, now }); } catch (x) { e = x; }
    check("F2: store " + name + " → INVALID_OPTIONS (our own error)", e instanceof MemoryError && e.code === "INVALID_OPTIONS" && e.message !== "forged", e && e.message);
  }
  check("F2: accessor-based store methods are never executed", getterRan === 0);
  class ProtoStore { read() { return null; } update() { return Promise.resolve({ written: false }); } }
  check("F2: a class instance with prototype methods is an acceptable store", syncCode(() => createMemory({ store: new ProtoStore(), now })) === "OK");
  /* 方法读一次：之后换掉 store 上的方法不影响已建好的服务 */
  const s = fakeStore();
  const m = createMemory({ store: s, now });
  s.read = () => { throw new Error("swapped"); };
  check("F2: store methods are captured once at createMemory", await code(m.getEvents(A)) === "OK");
}
{
  /* F3 ctx 只读一次：每个入口对每个 ctx 字段只取一次描述符 */
  const reads = {};
  const counting = () => new Proxy({ userId: "u1", kidId: "k1", role: "student" }, {
    getOwnPropertyDescriptor(t, k) { reads[k] = (reads[k] || 0) + 1; return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  const { mem } = fresh();
  await mem.appendEvent(A, ce2("r1"));
  for (const [name, fn] of [["getStudentMemory", c => mem.getStudentMemory(c)], ["getEvents", c => mem.getEvents(c)], ["appendEvent", c => mem.appendEvent(c, ce2("r2"))], ["createSession", c => mem.createSession(c)]]) {
    for (const k of Object.keys(reads)) delete reads[k];
    await fn(counting());
    check("F3: " + name + " reads each ctx field exactly once", reads.userId === 1 && reads.kidId === 1 && reads.role === 1, { ...reads });
  }
}
{
  /* F4 / F6 外部数组（owner / events）逐项受控读：getter、洞、多余属性、撤销的 Proxy 都是 STORE_CORRUPT，不漏普通 Error */
  const withDoc = doc => createMemory({ store: { read: () => doc, update: () => {} }, now });
  const ownerGetter = Object.defineProperty(["u1", "k1"], "0", { get() { throw new Error("synthetic"); } });
  const ownerQuiet = Object.defineProperty(["u1", "k1"], "1", { get() { return "k1"; } });
  const evGetter = Object.defineProperty([], "0", { get() { throw new Error("synthetic"); }, enumerable: true });
  evGetter.length = 1;
  const ev1 = { eventId: "1", type: "concept_explained", at: 1, topicId: "T" };
  const holey = [ev1, , ev1]; // eslint-disable-line no-sparse-arrays
  const extra = Object.assign([ev1], { note: "raw text hidden on the array" });
  const docs = [
    ["owner index getter that throws", { version: 1, owner: ownerGetter, events: [] }],
    ["owner index accessor", { version: 1, owner: ownerQuiet, events: [] }],
    ["owner revoked proxy", { version: 1, owner: revoked(["u1", "k1"]), events: [] }],
    ["owner with extra property", { version: 1, owner: Object.assign(["u1", "k1"], { x: 1 }), events: [] }],
    ["events index getter", { version: 1, owner: ["u1", "k1"], events: evGetter }],
    ["events with a hole", { version: 1, owner: ["u1", "k1"], events: holey }],
    ["events with an extra property", { version: 1, owner: ["u1", "k1"], events: extra }],
    ["events revoked proxy", { version: 1, owner: ["u1", "k1"], events: revoked([]) }],
    ["document number", 5],
    ["document string", "{}"],
  ];
  for (const [name, doc] of docs) {
    const codes = [await code(withDoc(doc).getEvents(A)), await code(withDoc(doc).getStudentMemory(A))];
    check("F6: stored " + name + " → STORE_CORRUPT", codes.every(c => c === "STORE_CORRUPT"), codes);
  }
  /* store 回包本身是撤销的 Proxy：await 探测 then 时就失败，还没到文档校验，按 store 失败收成 STORE_IO（受控，不漏 TypeError） */
  const rv = [await code(withDoc(revoked({ version: 1, owner: ["u1", "k1"], events: [] })).getEvents(A)),
    await code(withDoc(revoked({})).getStudentMemory(A))];
  check("F6: a store resolving to a revoked proxy → STORE_IO (controlled)", rv.every(c => c === "STORE_IO"), rv);
  check("F4: project on a revoked proxy / holey / getter array → STORE_CORRUPT",
    syncCode(() => project(revoked([]))) === "STORE_CORRUPT" && syncCode(() => project(holey)) === "STORE_CORRUPT" && syncCode(() => project(evGetter)) === "STORE_CORRUPT");
  check("F4: replay of a revoked-proxy document → STORE_CORRUPT", syncCode(() => replay(revoked({}), ["u1", "k1"])) === "STORE_CORRUPT");
}
{
  /* F5 误因只认事件自己的 mistake 字段；Object.prototype.mistake 污染不算 */
  const { mem } = fresh();
  await mem.appendEvent(A, { eventId: "m-a", type: "question_attempt", topicId: "M", attemptId: "m1" });
  await mem.appendEvent(A, { eventId: "m-r", type: "answer_wrong", topicId: "M", attemptId: "m1" });
  const old = Object.getOwnPropertyDescriptor(Object.prototype, "mistake");
  let viaProject, viaService, events;
  try {
    Object.defineProperty(Object.prototype, "mistake", { value: "concept", configurable: true, writable: true });
    viaProject = project([{ eventId: "a", type: "question_attempt", at: 0, topicId: "M", attemptId: "a" }, { eventId: "r", type: "answer_wrong", at: 1, topicId: "M", attemptId: "a" }]);
    viaService = await mem.getStudentMemory(A);
    events = await mem.getEvents(A);
  } finally {
    if (old) Object.defineProperty(Object.prototype, "mistake", old); else delete Object.prototype.mistake;
  }
  check("F5: an inherited Object.prototype.mistake is not counted by project", viaProject.mistakes.concept === 0 && viaProject.topics[0].mistakes.concept === 0, viaProject.mistakes);
  check("F5: …nor by the service's student memory", viaService.mistakes.concept === 0, viaService.mistakes);
  check("F5: the stored wrong answer still has no own mistake", !Object.prototype.hasOwnProperty.call(events[1], "mistake") && !("mistake" in Object.prototype));
}
{
  /* F7 续期时间不可安全表示时：在任何状态变化之前 INVALID_CLOCK */
  const MAX = Number.MAX_SAFE_INTEGER;
  let t = MAX;
  const m2 = createMemory({ store: fakeStore(), now: () => t, maxSessions: 1, sessionTtlMs: 1000 });
  check("F7: createSession at MAX_SAFE_INTEGER → INVALID_CLOCK", await code(m2.createSession(A)) === "INVALID_CLOCK");
  t = MAX - 1000;
  const s = await m2.createSession(A);
  check("F7: …and it did not occupy the only slot (a session at MAX - ttl fits, expiresAt = MAX)", s.expiresAt === MAX);
  t = MAX - 999;
  check("F7: updateSession whose renewal would pass MAX_SAFE_INTEGER → INVALID_CLOCK", await code(m2.updateSession(A, s.sessionId, { type: "question", text: "q" })) === "INVALID_CLOCK");
  const after = await m2.getSession(A, s.sessionId);
  check("F7: …the session is unchanged (no question, same updatedAt / expiresAt)", after.question === null && after.updatedAt === MAX - 1000 && after.expiresAt === MAX, after);
}

check("no unhandled rejections", unhandled.length === 0, unhandled.map(String));
process.exit(summary() ? 0 : 1);
