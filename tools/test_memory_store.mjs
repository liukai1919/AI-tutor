#!/usr/bin/env node
/*
 * Tutor Memory 文件适配器单测（#34，#19 Phase 5 片 2）。零成本：不起服务器、不读 data/、不调模型；
 * 只在 fs.mkdtemp 建的临时目录里读写，finally 删除该目录。
 *
 *   node tools/test_memory_store.mjs
 *
 * 验证：rootDir 必填且无默认；文件名由所有者哈希得到、路径输入不逃逸；重启恢复；同进程两个服务 / 两个适配器并发不丢事件；
 * open / write / rename / unlink 故障时旧文件字节不变、不发布、重试只应用一次、清理不碰原文件；
 * 损坏 JSON / 空文件 / 非 UTF-8 / 未来版本 / owner 不符 / 坏事件 / 目录占位 / 超大文件读写都拒绝且不覆盖；
 * transform 契约（async / undefined / 非法文档 / 抛错）；字节与事件容量明确失败不截断；落盘只有白名单结构。
 * 故障注入靠 createFileStore({ fs }) 注入的 fs 包装，不改全局原型。
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const storeMod = require("../lib/ai/memory/file-store.js");
const { createFileStore, DEFAULT_MAX_BYTES } = storeMod;
const { createMemory, MemoryError } = require("../lib/ai/memory/index.js");
const { check, summary } = makeChecker();

const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));

async function code(p) {
  try { await p; return "OK"; } catch (e) { return e instanceof MemoryError ? e.code : "FOREIGN:" + (e && (e.code || e.name)); }
}
function syncCode(fn) {
  try { fn(); return "OK"; } catch (e) { return e instanceof MemoryError ? e.code : "FOREIGN:" + (e && e.name); }
}
const J = v => JSON.stringify(v);
const fileOf = (userId, kidId) => crypto.createHash("sha256").update(J([userId, kidId])).digest("hex") + ".json";
const A = Object.freeze({ userId: "u1", kidId: "k1", role: "student" });
const B = Object.freeze({ userId: "u1", kidId: "k2", role: "parent" });
const OWNER_A = Object.freeze(["u1", "k1"]);
let clock = 1000;
const now = () => clock;
const ce = (id, topicId = "T") => ({ eventId: id, type: "concept_explained", topicId });
const WHITELIST = new Set(["eventId", "type", "at", "topicId", "attemptId", "mistake", "prerequisiteTopicId", "style"]);

/* 注入的 fs：真实 fs/promises 加覆盖；记录每次调用的路径参数 */
function spyFs(overrides = {}) {
  const calls = [];
  const wrap = name => async (...args) => {
    calls.push({ name, paths: args.slice(0, name === "rename" ? 2 : 1).filter(a => typeof a === "string") });   // open 的第二个参数是 flag，不是路径
    return (overrides[name] || fsp[name])(...args);
  };
  const out = { calls };
  for (const n of ["realpath", "stat", "lstat", "readFile", "open", "rename", "unlink"]) out[n] = wrap(n);
  return out;
}
const listTmp = async dir => (await fsp.readdir(dir)).filter(f => f.endsWith(".tmp"));

const base = await fsp.mkdtemp(path.join(os.tmpdir(), "yy-memory-store-"));
const root = path.join(base, "root");
await fsp.mkdir(root);
const realRoot = await fsp.realpath(root);
const inRoot = p => {
  const norm = x => (process.platform === "win32" ? x.toLowerCase() : x);
  const r = path.resolve(p);
  return norm(r) === norm(root) || norm(r) === norm(realRoot) || norm(r).startsWith(norm(realRoot) + path.sep) || norm(r).startsWith(norm(root) + path.sep);
};

try {
  /* -------------------------------------------------------------- 选项与无默认目录 */
  console.log("options");
  check("file-store exports createFileStore and DEFAULT_MAX_BYTES only (no default instance)", Object.keys(storeMod).sort().join() === "DEFAULT_MAX_BYTES,createFileStore");
  check("DEFAULT_MAX_BYTES is 8 MiB", DEFAULT_MAX_BYTES === 8 * 1024 * 1024);
  const badOpts = [
    ["no options", undefined], ["empty object (no rootDir)", {}], ["rootDir empty", { rootDir: "" }], ["relative rootDir", { rootDir: "data/memory" }],
    ["rootDir with NUL", { rootDir: root + "\u0000x" }], ["rootDir not a string", { rootDir: 5 }], ["unknown option", { rootDir: root, dir: root }],
    ["maxBytes 0", { rootDir: root, maxBytes: 0 }], ["maxBytes NaN", { rootDir: root, maxBytes: NaN }], ["maxBytes 1.5", { rootDir: root, maxBytes: 1.5 }],
    ["maxBytes too big", { rootDir: root, maxBytes: 2 ** 40 }], ["fs missing rename", { rootDir: root, fs: { ...fsp, rename: undefined } }],
    ["inherited rootDir", Object.create({ rootDir: root })],
  ];
  for (const [name, o] of badOpts) check("createFileStore rejects " + name + " with INVALID_OPTIONS", syncCode(() => createFileStore(o)) === "INVALID_OPTIONS");
  const missing = path.join(base, "does-not-exist");
  const sm = createFileStore({ rootDir: missing });
  check("a missing rootDir fails with STORE_IO on use", await code(sm.read(OWNER_A)) === "STORE_IO" && await code(sm.update(OWNER_A, () => ({ version: 1, owner: ["u1", "k1"], events: [] }))) === "STORE_IO");
  check("…and is not created", await fsp.stat(missing).then(() => false, () => true));
  const aFile = path.join(base, "a-file");
  await fsp.writeFile(aFile, "x");
  check("a rootDir that is a file fails with STORE_IO", await code(createFileStore({ rootDir: aFile }).read(OWNER_A)) === "STORE_IO");
  await fsp.rm(aFile);
  const st0 = createFileStore({ rootDir: root });
  check("the store object is frozen and exposes only read / update", Object.isFrozen(st0) && Object.keys(st0).sort().join() === "read,update");
  for (const [name, o] of [["string owner", "u1,k1"], ["one-element owner", ["u1"]], ["numeric parts", [1, 2]], ["three parts", ["a", "b", "c"]], ["empty part", ["", "k"]]])
    check("store rejects " + name + " with INVALID_INPUT", await code(st0.read(o)) === "INVALID_INPUT" && await code(st0.update(o, () => null)) === "INVALID_INPUT");
  check("store rejects a non-function transform with INVALID_INPUT", await code(st0.update(OWNER_A, null)) === "INVALID_INPUT");
  check("fresh owner reads as null", (await st0.read(OWNER_A)) === null);

  /* -------------------------------------------------------------- 基本读写与重启恢复 */
  console.log("round trip and restart");
  {
    const mem = createMemory({ store: createFileStore({ rootDir: root }), now });
    clock = 1000;
    await mem.appendEvent(A, { eventId: "a1", type: "question_attempt", topicId: "BC.MATH.G5.DEC3", attemptId: "t1" });
    clock = 2000;
    await mem.appendEvent(A, { eventId: "a2", type: "answer_wrong", topicId: "BC.MATH.G5.DEC3", attemptId: "t1", mistake: "reading" });
    await mem.appendEvent(A, { eventId: "a3", type: "preference_set", style: "concrete" });
    const target = path.join(root, fileOf("u1", "k1"));
    const doc = JSON.parse(await fsp.readFile(target, "utf8"));
    check("the file is <sha256 of JSON [userId,kidId]>.json in rootDir", (await fsp.readdir(root)).join() === fileOf("u1", "k1"));
    check("the document is exactly { version:1, owner, events } with stored order and service times",
      Object.keys(doc).join() === "version,owner,events" && doc.version === 1 && J(doc.owner) === J(["u1", "k1"]) && doc.events.map(e => e.eventId + "@" + e.at).join() === "a1@1000,a2@2000,a3@2000", doc);
    const before = { events: J(await mem.getEvents(A)), memory: J(await mem.getStudentMemory(A)) };
    /* 「重启」：新的适配器 + 新的服务实例 */
    const mem2 = createMemory({ store: createFileStore({ rootDir: root }), now });
    check("after restart the events replay identically", J(await mem2.getEvents(A)) === before.events);
    check("after restart the student memory is identical", J(await mem2.getStudentMemory(A)) === before.memory);
    clock = 9000;
    const again = await mem2.appendEvent(A, { eventId: "a2", type: "answer_wrong", topicId: "BC.MATH.G5.DEC3", attemptId: "t1", mistake: "reading" });
    check("an idempotent retry after restart returns the original record (original at)", again.duplicate === true && again.event.at === 2000);
    check("…and a second result for the settled attempt is still refused", await code(mem2.appendEvent(A, { eventId: "a4", type: "answer_correct", topicId: "BC.MATH.G5.DEC3", attemptId: "t1" })) === "ATTEMPT_SETTLED");
    check("store.read returns the envelope-checked document", J(await createFileStore({ rootDir: root }).read(OWNER_A)) === J(doc));
  }

  /* -------------------------------------------------------------- 并发：两个服务 × 两个适配器 */
  console.log("concurrency");
  {
    const variant = process.platform === "win32" ? root.toUpperCase() + path.sep + "." : root + path.sep + ".";
    const s1 = createFileStore({ rootDir: root }), s2 = createFileStore({ rootDir: variant });
    const m1 = createMemory({ store: s1, now }), m2 = createMemory({ store: s2, now });
    const C = { userId: "u-conc", kidId: "k", role: "student" };
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? m1 : m2).appendEvent(C, ce("c" + i))));
    const evs = await m1.getEvents(C);
    check("40 interleaved appends from two services on two adapters (different spellings of rootDir) → 40 events",
      res.every(r => !r.duplicate) && evs.length === 40 && new Set(evs.map(e => e.eventId)).size === 40, evs.length);
    const same = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? m1 : m2).appendEvent(C, ce("dup"))));
    check("one eventId appended 6× concurrently across both → stored once, same at everywhere",
      same.filter(r => !r.duplicate).length === 1 && new Set(same.map(r => r.event.at)).size === 1 && (await m2.getEvents(C)).length === 41);
    await m1.appendEvent(C, { eventId: "qa", type: "question_attempt", topicId: "T", attemptId: "race" });
    const race = await Promise.all([
      code(m1.appendEvent(C, { eventId: "r1", type: "answer_correct", topicId: "T", attemptId: "race" })),
      code(m2.appendEvent(C, { eventId: "r2", type: "answer_wrong", topicId: "T", attemptId: "race" })),
    ]);
    check("two services racing to settle one attempt → exactly one wins", race.sort().join() === "ATTEMPT_SETTLED,OK", race);
    const direct = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? s1 : s2).update(["u-direct", "k"], cur => {
      const events = cur ? cur.events : [];
      return { version: 1, owner: ["u-direct", "k"], events: [...events, { eventId: "d" + i, type: "topic_mastered", at: i, topicId: "T" }] };
    })));
    const dd = await s1.read(["u-direct", "k"]);
    check("20 raw store.update calls across two adapters each see the latest document (no lost update)", direct.every(r => r.written) && dd.events.length === 20);
    check("no temp files left behind", (await listTmp(root)).length === 0);
  }

  /* -------------------------------------------------------------- 故障注入 */
  console.log("fault injection");
  {
    const F = { userId: "u-fault", kidId: "k", role: "student" };
    const target = path.join(root, fileOf("u-fault", "k"));
    const good = createMemory({ store: createFileStore({ rootDir: root }), now });

    /* 第一次写就失败：不留目标文件 */
    const failRename = spyFs({ rename: async () => { throw Object.assign(new Error("EIO rename"), { code: "EIO" }); } });
    const mBad = createMemory({ store: createFileStore({ rootDir: root, fs: failRename }), now });
    let err; try { await mBad.appendEvent(F, ce("f0")); } catch (e) { err = e; }
    check("rename failure on the first write → STORE_IO (cause kept)", err instanceof MemoryError && err.code === "STORE_IO" && err.cause && err.cause.code === "EIO");
    check("…no target file was created and the temp file was removed", await fsp.stat(target).then(() => false, () => true) && (await listTmp(root)).length === 0);
    check("…and nothing is published", (await good.getEvents(F)).length === 0);

    await good.appendEvent(F, ce("f1"));
    const bytes0 = await fsp.readFile(target);
    check("rename failure on an existing file → STORE_IO", await code(mBad.appendEvent(F, ce("f2"))) === "STORE_IO");
    check("…old file bytes unchanged, no temp left, no new event or count",
      (await fsp.readFile(target)).equals(bytes0) && (await listTmp(root)).length === 0 && (await good.getEvents(F)).length === 1 && (await good.getStudentMemory(F)).eventCount === 1);
    check("…every unlink during cleanup targeted only a temp file, never the original",
      failRename.calls.filter(c => c.name === "unlink").length >= 2 && failRename.calls.filter(c => c.name === "unlink").every(c => c.paths.every(p => p.endsWith(".tmp") && path.resolve(p) !== path.resolve(target))));
    const r1 = await good.appendEvent(F, ce("f2"));
    const r2 = await good.appendEvent(F, ce("f2"));
    check("retrying the failed event applies it exactly once", r1.duplicate === false && r2.duplicate === true && (await good.getEvents(F)).map(e => e.eventId).join() === "f1,f2");

    const bytes1 = await fsp.readFile(target);
    const partial = spyFs({
      open: async (p, flags) => {
        const fh = await fsp.open(p, flags);
        return { writeFile: async data => { await fh.writeFile(data.subarray(0, 7)); throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); }, sync: () => fh.sync(), close: () => fh.close() };
      },
    });
    check("a write that fails half way → STORE_IO", await code(createMemory({ store: createFileStore({ rootDir: root, fs: partial }), now }).appendEvent(F, ce("f3"))) === "STORE_IO");
    check("…old bytes unchanged and the partial temp file removed", (await fsp.readFile(target)).equals(bytes1) && (await listTmp(root)).length === 0);
    const syncFail = spyFs({
      open: async (p, flags) => { const fh = await fsp.open(p, flags); return { writeFile: d => fh.writeFile(d), sync: async () => { throw Object.assign(new Error("EIO sync"), { code: "EIO" }); }, close: () => fh.close() }; },
    });
    check("an fsync failure → STORE_IO, old bytes unchanged, no temp", await code(createMemory({ store: createFileStore({ rootDir: root, fs: syncFail }), now }).appendEvent(F, ce("f3"))) === "STORE_IO"
      && (await fsp.readFile(target)).equals(bytes1) && (await listTmp(root)).length === 0);
    const openFail = spyFs({ open: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } });
    check("open failure → STORE_IO, old bytes unchanged", await code(createMemory({ store: createFileStore({ rootDir: root, fs: openFail }), now }).appendEvent(F, ce("f3"))) === "STORE_IO"
      && (await fsp.readFile(target)).equals(bytes1));
    const bothFail = spyFs({
      rename: async () => { throw Object.assign(new Error("EIO rename"), { code: "EIO" }); },
      unlink: async () => { throw Object.assign(new Error("EPERM unlink"), { code: "EPERM" }); },
    });
    let e2; try { await createMemory({ store: createFileStore({ rootDir: root, fs: bothFail }), now }).appendEvent(F, ce("f3")); } catch (e) { e2 = e; }
    const stray = await listTmp(root);
    check("rename and cleanup both failing → STORE_IO for the rename (cleanup error swallowed)", e2 && e2.code === "STORE_IO" && e2.cause && e2.cause.code === "EIO");
    check("…old bytes unchanged; one stray temp file is left (documented limitation)", (await fsp.readFile(target)).equals(bytes1) && stray.length === 1 && stray[0].startsWith(fileOf("u-fault", "k") + "."));
    check("a stray temp file is ignored by later reads and writes", (await good.appendEvent(F, ce("f3"))).duplicate === false && (await good.getEvents(F)).map(e => e.eventId).join() === "f1,f2,f3");
    await fsp.rm(path.join(root, stray[0]));
    const readFail = spyFs({ readFile: async () => { throw Object.assign(new Error("EIO read"), { code: "EIO" }); } });
    const mRead = createMemory({ store: createFileStore({ rootDir: root, fs: readFail }), now });
    const bytes2 = await fsp.readFile(target);
    check("a read failure → STORE_IO on read and append, nothing written", await code(mRead.getEvents(F)) === "STORE_IO" && await code(mRead.appendEvent(F, ce("f4"))) === "STORE_IO"
      && (await fsp.readFile(target)).equals(bytes2) && readFail.calls.every(c => c.name !== "open"));
  }

  /* -------------------------------------------------------------- 坏档：拒绝且不覆盖 */
  console.log("corrupt / unknown documents");
  {
    const mem = createMemory({ store: createFileStore({ rootDir: root }), now });
    const small = createMemory({ store: createFileStore({ rootDir: root, maxBytes: 2048 }), now });
    const cases = [
      ["garbage JSON", Buffer.from("{ not json"), "STORE_CORRUPT", mem],
      ["empty file", Buffer.alloc(0), "STORE_CORRUPT", mem],
      ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), "STORE_CORRUPT", mem],
      ["UTF-8 BOM", Buffer.from("\uFEFF" + J({ version: 1, owner: ["u-bad", "k"], events: [] })), "STORE_CORRUPT", mem],
      ["JSON null", Buffer.from("null"), "STORE_CORRUPT", mem],
      ["future version 2", Buffer.from(J({ version: 2, owner: ["u-bad", "k"], events: [] })), "STORE_VERSION", mem],
      ["no version", Buffer.from(J({ owner: ["u-bad", "k"], events: [] })), "STORE_VERSION", mem],
      ["owner of someone else", Buffer.from(J({ version: 1, owner: ["u1", "k1"], events: [] })), "STORE_CORRUPT", mem],
      ["cached summary next to events", Buffer.from(J({ version: 1, owner: ["u-bad", "k"], events: [], summary: { mastered: true } })), "STORE_CORRUPT", mem],
      ["event with free text", Buffer.from(J({ version: 1, owner: ["u-bad", "k"], events: [{ eventId: "1", type: "concept_explained", at: 1, topicId: "T", message: "hi" }] })), "STORE_CORRUPT", mem],
      ["outcome without attempt", Buffer.from(J({ version: 1, owner: ["u-bad", "k"], events: [{ eventId: "1", type: "answer_correct", at: 1, topicId: "T", attemptId: "a" }] })), "STORE_CORRUPT", mem],
      ["oversize file", Buffer.from(J({ version: 1, owner: ["u-bad", "k"], events: [], pad: "x".repeat(4096) })), "STORE_TOO_LARGE", small],
    ];
    const U = { userId: "u-bad", kidId: "k", role: "student" };
    const target = path.join(root, fileOf("u-bad", "k"));
    for (const [name, buf, want, m] of cases) {
      await fsp.writeFile(target, buf);
      const codes = [await code(m.getEvents(U)), await code(m.getStudentMemory(U)), await code(m.appendEvent(U, ce("new")))];
      check(name + ": read / summary / append → " + want, codes.every(c => c === want), codes);
      check(name + ": file bytes unchanged (not overwritten as empty)", (await fsp.readFile(target)).equals(buf));
    }
    await fsp.rm(target);
    await fsp.mkdir(target);
    check("a directory at the target path → STORE_CORRUPT and it is left alone", await code(mem.appendEvent(U, ce("new"))) === "STORE_CORRUPT" && (await fsp.stat(target)).isDirectory());
    await fsp.rmdir(target);
    check("no temp files left behind after the corrupt cases", (await listTmp(root)).length === 0);
  }

  /* -------------------------------------------------------------- transform 契约 */
  console.log("transform contract");
  {
    const st = createFileStore({ rootDir: root });
    const O = ["u-tx", "k"], target = path.join(root, fileOf("u-tx", "k"));
    const ok = await st.update(O, () => ({ version: 1, owner: ["u-tx", "k"], events: [{ eventId: "x1", type: "topic_mastered", at: 5, topicId: "T" }] }));
    check("a valid transform writes and resolves { doc, written:true }", ok.written === true && ok.doc.events.length === 1);
    const bytes = await fsp.readFile(target);
    const invalid = [
      ["async transform", async cur => cur],
      ["async transform that rejects", async () => { throw new Error("late"); }],
      ["thenable", () => ({ then() {} })],
      ["undefined (forgot to return)", () => undefined],
      ["extra envelope key", cur => ({ ...cur, summary: {} })],
      ["other owner", () => ({ version: 1, owner: ["u1", "k1"], events: [] })],
      ["future version", () => ({ version: 2, owner: O, events: [] })],
      ["event with free text", cur => ({ ...cur, events: [...cur.events, { eventId: "x2", type: "concept_explained", at: 6, topicId: "T", text: "raw" }] })],
      ["event with NaN at", cur => ({ ...cur, events: [...cur.events, { eventId: "x2", type: "concept_explained", at: NaN, topicId: "T" }] })],
      ["event with a function", cur => ({ ...cur, events: [...cur.events, { eventId: "x2", type: "concept_explained", at: 6, topicId: "T", attemptId: () => 1 }] })],
      ["BigInt", cur => ({ ...cur, events: [...cur.events, { eventId: "x2", type: "concept_explained", at: 6n, topicId: "T" }] })],
      ["duplicate eventId", cur => ({ ...cur, events: [...cur.events, cur.events[0]] })],
    ];
    for (const [name, fn] of invalid) {
      const r = await code(st.update(O, fn));
      check("transform " + name + " → INVALID_TRANSFORM, nothing written", r === "INVALID_TRANSFORM" && (await fsp.readFile(target)).equals(bytes), r);
    }
    class Custom extends Error {}
    let got; try { await st.update(O, () => { throw new Custom("mine"); }); } catch (e) { got = e; }
    check("a throwing transform rejects with that same error, nothing written", got instanceof Custom && (await fsp.readFile(target)).equals(bytes));
    const noop = await st.update(O, () => null);
    check("transform returning null → written:false, current doc returned, file untouched", noop.written === false && noop.doc.events.length === 1 && (await fsp.readFile(target)).equals(bytes));
    let seen;
    await st.update(O, cur => { seen = cur; cur.events.length = 0; cur.version = 99; return null; });
    check("the transform gets its own parsed copy (mutating it changes nothing on disk)", seen && (await fsp.readFile(target)).equals(bytes) && (await st.read(O)).events.length === 1);
    check("no temp files after transform failures", (await listTmp(root)).length === 0);
  }

  /* -------------------------------------------------------------- 容量：明确失败不截断 */
  console.log("capacity");
  {
    const K = { userId: "u-cap", kidId: "k", role: "student" };
    const m = createMemory({ store: createFileStore({ rootDir: root, maxBytes: 1024 }), now });
    let n = 0, last = "OK";
    while (n < 100) { last = await code(m.appendEvent(K, ce("cap-" + n))); if (last !== "OK") break; n++; }
    const target = path.join(root, fileOf("u-cap", "k"));
    const bytes = await fsp.readFile(target);
    check("appends under maxBytes 1024 stop with CAPACITY", last === "CAPACITY" && n > 3 && n < 100, { n, last });
    check("…the file holds exactly the first n events, in order, under the limit",
      bytes.length <= 1024 && JSON.parse(bytes).events.map(e => e.eventId).join() === Array.from({ length: n }, (_, i) => "cap-" + i).join());
    check("…further appends keep failing and change nothing", await code(m.appendEvent(K, ce("cap-x"))) === "CAPACITY" && (await fsp.readFile(target)).equals(bytes));
    check("…an idempotent retry of a stored event still succeeds", (await m.appendEvent(K, ce("cap-0"))).duplicate === true);

    /* 默认上限能装下 10000 条最长的事件 */
    const W = ["u-worst", "k"];
    const pad = (s, n) => (s + "x".repeat(n)).slice(0, n);
    const worst = Array.from({ length: 10000 }, (_, i) => ({ eventId: pad("e" + i + "-", 64), type: "prerequisite_gap_detected", at: 8.64e15 - i, topicId: pad("T" + i + "-", 96), prerequisiteTopicId: pad("P" + i + "-", 96) }));
    const st = createFileStore({ rootDir: root });
    const w = await st.update(W, () => ({ version: 1, owner: W, events: worst }));
    const size = (await fsp.stat(path.join(root, fileOf(...W)))).size;
    check("10000 worst-case events fit under DEFAULT_MAX_BYTES with room to spare", w.written && size < DEFAULT_MAX_BYTES * 0.6, size);
    const mw = createMemory({ store: st, now });
    const WK = { userId: W[0], kidId: W[1], role: "student" };
    check("at the default maxEvents (10000) the next append → CAPACITY and history is kept whole",
      await code(mw.appendEvent(WK, ce("one-more"))) === "CAPACITY" && (await mw.getEvents(WK)).length === 10000);
  }

  /* -------------------------------------------------------------- 路径输入与所有者编码 */
  console.log("paths and owners");
  {
    const spy = spyFs();
    const m = createMemory({ store: createFileStore({ rootDir: root, fs: spy }), now });
    const nasty = ["../../evil", "..\\..\\evil", "C:\\Windows\\System32", "/etc/passwd", "a/b", "CON", "NUL.txt", "孩子", "  spaced  ", ".", "..", "x".repeat(128)];
    for (const [i, id] of nasty.entries()) await m.appendEvent({ userId: id, kidId: nasty[(i + 1) % nasty.length], role: "parent" }, ce("p" + i));
    const files = await fsp.readdir(root);
    check("every file in rootDir is <64 hex>.json (ids never become path segments)", files.every(f => /^[0-9a-f]{64}\.json$/.test(f)), files);
    check("nothing was written outside rootDir", J((await fsp.readdir(base)).sort()) === J(["root"]));
    check("every fs call stayed inside rootDir", spy.calls.every(c => c.paths.every(inRoot)), spy.calls.filter(c => !c.paths.every(inRoot)));
    let allBack = true;
    for (const [i, id] of nasty.entries()) {
      const evs = await m.getEvents({ userId: id, kidId: nasty[(i + 1) % nasty.length], role: "student" });
      allBack = allBack && evs.length === 1 && evs[0].eventId === "p" + i;
    }
    check("each nasty owner reads back exactly its own event", allBack);
    const X = { userId: "a,b", kidId: "c", role: "student" }, Y = { userId: "a", kidId: "b,c", role: "student" };
    await m.appendEvent(X, ce("x"));
    check("separator-colliding owners get different files and histories", fileOf("a,b", "c") !== fileOf("a", "b,c") && (await m.getEvents(Y)).length === 0);
    check("a parent ctx of another kid sees nothing of kid A", (await m.getEvents(A)).length > 0 && (await m.getEvents(B)).length === 0);
  }

  /* -------------------------------------------------------------- 落盘白名单、Session 不落盘 */
  console.log("persisted data whitelist");
  {
    const m = createMemory({ store: createFileStore({ rootDir: root }), now });
    const s = await m.createSession(A);
    await m.updateSession(A, s.sessionId, { type: "question", text: "PRIVATE-QUESTION what is 37×24", topicId: "BC.MATH.G5.MUL" });
    await m.updateSession(A, s.sessionId, { type: "attempt", answer: "PRIVATE-ANSWER 888" });
    await m.updateSession(A, s.sessionId, { type: "hint", text: "PRIVATE-HINT split 24" });
    await m.updateSession(A, s.sessionId, { type: "observation", tool: "calculator.evaluate", summary: "PRIVATE-OBS 888" });
    await m.appendEvent(A, { eventId: "w1", type: "question_attempt", topicId: "BC.MATH.G5.MUL", attemptId: "w-att" });
    await m.appendEvent(A, { eventId: "w2", type: "answer_correct", topicId: "BC.MATH.G5.MUL", attemptId: "w-att" });
    await m.closeSession(A, s.sessionId);
    let clean = true, onlyWhitelist = true;
    for (const f of await fsp.readdir(root)) {
      const text = await fsp.readFile(path.join(root, f), "utf8");
      if (/PRIVATE|37×24/.test(text)) clean = false;
      const d = JSON.parse(text);
      if (Object.keys(d).join() !== "version,owner,events") onlyWhitelist = false;
      for (const e of d.events) if (!Object.keys(e).every(k => WHITELIST.has(k))) onlyWhitelist = false;
    }
    check("no session text (question / answer / hint / observation) is in any file", clean);
    check("every file is the envelope plus whitelisted event fields only", onlyWhitelist);
  }

  /* -------------------------------------------------------------- 独立复核回归（build/phase5/root-findings.md） */
  console.log("review regressions");
  const revoked = t => { const r = Proxy.revocable(t, {}); r.revoke(); return r.proxy; };
  {
    /* F8 坏历史：直接用 store API 也读不出、盖不掉，字节不变 */
    const st = createFileStore({ rootDir: root });
    const O = ["u-hist", "k"], target = path.join(root, fileOf(...O));
    const histories = [
      ["outcome without attempt", [{ eventId: "r", type: "answer_correct", at: 1, topicId: "M", attemptId: "missing" }]],
      ["duplicate eventId", [{ eventId: "d", type: "topic_mastered", at: 1, topicId: "M" }, { eventId: "d", type: "concept_explained", at: 2, topicId: "M" }]],
      ["two results for one attempt", [{ eventId: "a", type: "question_attempt", at: 1, topicId: "M", attemptId: "x" }, { eventId: "b", type: "answer_correct", at: 2, topicId: "M", attemptId: "x" }, { eventId: "c", type: "answer_wrong", at: 3, topicId: "M", attemptId: "x" }]],
      ["free-text key on an event", [{ eventId: "t", type: "concept_explained", at: 1, topicId: "M", answer: "raw" }]],
      ["unsafe at", [{ eventId: "t", type: "concept_explained", at: 2 ** 60, topicId: "M" }]],
    ];
    for (const [name, events] of histories) {
      const bytes = J({ version: 1, owner: O, events });
      await fsp.writeFile(target, bytes);
      const codes = [await code(st.read(O)), await code(st.update(O, () => ({ version: 1, owner: O, events: [] }))), await code(st.update(O, () => null))];
      check("F8: stored history with " + name + " → STORE_CORRUPT on direct read / replace / no-op update", codes.every(c => c === "STORE_CORRUPT"), codes);
      check("F8: …the bad history is byte-identical afterwards", await fsp.readFile(target, "utf8") === bytes);
    }
    await fsp.rm(target);
    await st.update(O, () => ({ version: 1, owner: O, events: [{ eventId: "ok", type: "topic_mastered", at: 3, topicId: "M" }] }));
    const r1 = await st.read(O);
    check("F8: store.read returns the canonical validated document", J(r1) === J({ version: 1, owner: O, events: [{ eventId: "ok", type: "topic_mastered", at: 3, topicId: "M" }] }));
    r1.events.length = 0; r1.owner[0] = "evil";
    check("F8: mutating what read returned changes nothing", (await st.read(O)).events.length === 1);
  }
  {
    /* F9 owner 严格：恰好两个自有数据字符串、满足服务的 id 边界；非法 owner 在任何 fs 调用之前被拒 */
    const spy = spyFs();
    const st = createFileStore({ rootDir: root, fs: spy });
    const getterOwner = Object.defineProperty(["u", "k"], "1", { get() { throw new Error("synthetic"); } });
    const owners = [
      ["sparse new Array(2)", new Array(2)], ["hole in second slot", ["u", , ][0] === "u" ? Object.assign(new Array(2), { 0: "u" }) : null], // eslint-disable-line no-sparse-arrays
      ["index getter that throws", getterOwner], ["index accessor", Object.defineProperty(["u", "k"], "0", { get: () => "u" })],
      ["extra raw-text property", Object.assign(["u", "k"], { note: "the kid said 42" })], ["revoked proxy", revoked(["u", "k"])],
      ["control character", ["u\u0001", "k"]], ["129-char id", ["u".repeat(129), "k"]], ["String objects", [new String("u"), "k"]],
      ["array-like object", { 0: "u", 1: "k", length: 2 }],
    ];
    for (const [name, o] of owners) {
      const before = spy.calls.length;
      const codes = [await code(st.read(o)), await code(st.update(o, () => null))];
      check("F9: owner " + name + " → INVALID_INPUT before any fs call", codes.every(c => c === "INVALID_INPUT") && spy.calls.length === before, codes);
    }
    check("F9: a valid frozen owner still works", await code(st.read(Object.freeze(["u", "k"]))) === "OK");
  }
  {
    /* F10 transform 返回值探测受控：then getter 抛错 / 撤销的 Proxy → INVALID_TRANSFORM，不写，队列还能用 */
    const st = createFileStore({ rootDir: root });
    const O = ["u-then", "k"], target = path.join(root, fileOf(...O));
    await st.update(O, () => ({ version: 1, owner: O, events: [{ eventId: "base", type: "topic_mastered", at: 1, topicId: "M" }] }));
    const bytes = await fsp.readFile(target);
    const bad = [
      ["then getter that throws", () => Object.defineProperty({ version: 1, owner: O, events: [] }, "then", { get() { throw new Error("synthetic"); } })],
      ["revoked proxy", () => revoked({ version: 1, owner: O, events: [] })],
      ["events getter", () => Object.defineProperty({ version: 1, owner: O }, "events", { get() { throw new Error("synthetic"); }, enumerable: true })],
      ["events with toJSON smuggling text", cur => ({ ...cur, events: Object.assign([...cur.events], { toJSON: () => ["raw text"] }) })],
      ["a function", () => () => {}],
      ["a number", () => 5],
    ];
    for (const [name, fn] of bad) {
      const c = await code(st.update(O, fn));
      check("F10: transform returning " + name + " → INVALID_TRANSFORM, bytes unchanged", c === "INVALID_TRANSFORM" && (await fsp.readFile(target)).equals(bytes), c);
    }
    const ok = await st.update(O, cur => ({ ...cur, events: [...cur.events, { eventId: "next", type: "concept_explained", at: 2, topicId: "M" }] }));
    check("F10: the queue is still usable after those failures", ok.written && (await st.read(O)).events.length === 2);
    check("F10: no temp files left", (await listTmp(root)).length === 0);
  }
  {
    /* F2 注入的 fs：方法按数据属性读一次，getter / Proxy 抛错 → INVALID_OPTIONS；fs 回包畸形 → STORE_IO */
    let ran = 0;
    const fsCases = [
      ["realpath getter that throws", Object.defineProperty({ ...fsp }, "realpath", { get() { throw new Error("synthetic"); }, enumerable: true })],
      ["realpath accessor", Object.defineProperty({ ...fsp }, "realpath", { get() { ran++; return fsp.realpath; }, enumerable: true })],
      ["revoked proxy", revoked({ ...fsp })],
      ["throwing descriptor trap", new Proxy({ ...fsp }, { getOwnPropertyDescriptor() { throw new MemoryError("OK", "forged"); } })],
    ];
    for (const [name, f] of fsCases) {
      let e; try { createFileStore({ rootDir: root, fs: f }); } catch (x) { e = x; }
      check("F2: fs " + name + " → INVALID_OPTIONS (our own error)", e instanceof MemoryError && e.code === "INVALID_OPTIONS" && e.message !== "forged", e && e.message);
    }
    check("F2: fs accessors are never executed", ran === 0);
    const O = ["u-fsodd", "k"], target = path.join(root, fileOf(...O));
    await createFileStore({ rootDir: root }).update(O, () => ({ version: 1, owner: O, events: [] }));
    const bytes = await fsp.readFile(target);
    const odd = [
      ["lstat result whose isFile throws", { lstat: async () => ({ isFile() { throw new Error("synthetic"); }, size: 1 }) }],
      ["readFile returning a string", { readFile: async () => "{}" }],
      ["open returning a handle with a throwing writeFile getter", { open: async (p, fl) => { const fh = await fsp.open(p, fl); return Object.defineProperty({ sync: () => fh.sync(), close: () => fh.close() }, "writeFile", { get() { throw new Error("synthetic"); } }); } }],
      ["realpath returning a number", { realpath: async () => 5 }],
      ["an fs error whose code getter throws", { lstat: async () => { throw Object.defineProperty(new Error("x"), "code", { get() { throw new Error("synthetic"); } }); } }],
    ];
    for (const [name, over] of odd) {
      const st = createFileStore({ rootDir: root, fs: { ...fsp, ...over } });
      const c = await code(st.update(O, cur => ({ ...cur, events: [{ eventId: "z", type: "concept_explained", at: 1, topicId: "M" }] })));
      check("F2: " + name + " → STORE_IO, bytes unchanged, no temp", c === "STORE_IO" && (await fsp.readFile(target)).equals(bytes) && (await listTmp(root)).length === 0, c);
    }
  }
} finally {
  await fsp.rm(base, { recursive: true, force: true });
}
check("the temp directory was removed", await fsp.stat(base).then(() => false, () => true));
check("no unhandled rejections", unhandled.length === 0, unhandled.map(String));
process.exit(summary() ? 0 : 1);
