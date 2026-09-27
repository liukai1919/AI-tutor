/*
 * Tutor Memory 服务（#34，#19 Phase 5）：临时 Session Memory（只在内存）+ 持久化 Learning Events（经注入的 store）
 * + 从事件重建的 Student Memory。零依赖、无模型、无网络；可信内部服务，不向模型或未认证 HTTP 开放。
 *
 *   const mem = createMemory({ store, now, sessionTtlMs, maxSessions, maxEntries, maxEvents });
 *   await mem.createSession(ctx, { stage? })                 → 快照
 *   await mem.getSession(ctx, sessionId)                     → 快照（不续期）
 *   await mem.updateSession(ctx, sessionId, patch)           → 快照（续期）；patch.type ∈ question / attempt / hint / observation / stage
 *   await mem.closeSession(ctx, sessionId)                   → { closed:true }
 *   await mem.appendEvent(ctx, input)                        → { event, duplicate }
 *   await mem.getEvents(ctx)                                 → 冻结事件数组（存储顺序）
 *   await mem.getStudentMemory(ctx)                          → 纯投影
 *
 * - ctx = { userId, kidId, role: student|parent }，按 JSON 编码的 [userId, kidId] 隔离；role 不参与所有者、不给跨所有者能力。
 * - 每个入口在第一个 await 之前同步读完 ctx、输入和服务时钟；之后调用方改原对象不影响本次操作。
 * - store 契约：read(owner) → doc|null；update(owner, transform) 在该所有者的队列里对最新文档同步调用 transform，
 *   transform 返回新文档或 null（不写），提交成功后才 resolve。服务只在 update 成功后返回新事件。
 * - 失败一律 reject MemoryError(code)，code 表见 docs/tutor-memory.md。
 */
"use strict";

const crypto = require("crypto");
const { MemoryError, readRecord, readMethods } = require("./errors.js");
const ev = require("./events.js");

const DEFAULTS = Object.freeze({ sessionTtlMs: 30 * 60 * 1000, maxSessions: 100, maxEntries: 32, maxEvents: 10000 });
const RANGES = { sessionTtlMs: [1000, 24 * 60 * 60 * 1000], maxSessions: [1, 10000], maxEntries: [1, 1000], maxEvents: [1, 100000] };
const SESSION_STAGES = Object.freeze(["understand", "explain", "hint", "practice", "check", "review"]);
const TEXT_MAX = 2000;
const TOOL_RE = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z][A-Za-z0-9]{0,31})?$/;
const SESSION_RE = /^s_[0-9a-f]{32}$/;
const ROLES = ["student", "parent"];

const isOwnerId = ev.isOwnerId;
const isText = v => typeof v === "string" && v.length >= 1 && v.length <= TEXT_MAX;

function readCtx(ctx) {
  const c = readRecord(ctx, ["userId", "kidId", "role"], "INVALID_CTX", "ctx");
  if (!isOwnerId(c.userId) || !isOwnerId(c.kidId) || typeof c.role !== "string" || !ROLES.includes(c.role))
    throw new MemoryError("INVALID_CTX", "ctx must be { userId, kidId: 1–128 chars without control characters, role: student|parent }");
  const owner = Object.freeze([c.userId, c.kidId]);
  return { owner, key: JSON.stringify(owner) };
}

/* patch 按 type 判别；每个 type 的键集合严格，R 必填、O 可选 */
const PATCH = {
  question: { text: ["R", isText], topicId: ["O", ev.isTopicId] },
  attempt: { answer: ["R", isText] },
  hint: { text: ["R", isText] },
  observation: { tool: ["R", v => typeof v === "string" && TOOL_RE.test(v)], summary: ["R", isText] },
  stage: { stage: ["R", v => typeof v === "string" && SESSION_STAGES.includes(v)] },
};
const PATCH_KEYS = ["type", "text", "topicId", "answer", "tool", "summary", "stage"];
function readPatch(patch) {
  const p = readRecord(patch, PATCH_KEYS, "INVALID_INPUT", "session patch");
  const bad = msg => new MemoryError("INVALID_INPUT", "session patch: " + msg);
  if (typeof p.type !== "string" || !Object.prototype.hasOwnProperty.call(PATCH, p.type)) throw bad("type must be one of " + Object.keys(PATCH).join(", "));
  const spec = PATCH[p.type];
  for (const k of Object.keys(p)) if (k !== "type" && !Object.prototype.hasOwnProperty.call(spec, k)) throw bad(`${k} is not allowed for ${p.type}`);
  for (const [k, [need, ok]] of Object.entries(spec)) {
    if (!(k in p)) { if (need === "R") throw bad(`${k} is required for ${p.type}`); continue; }
    if (!ok(p[k])) throw bad(`${k} is not valid (text fields are 1–${TEXT_MAX} characters)`);
  }
  return p;
}

function readSessionId(id) {
  if (typeof id !== "string" || !SESSION_RE.test(id)) throw new MemoryError("INVALID_INPUT", "sessionId is not valid");
  return id;
}

function createMemory(opts) {
  const o = readRecord(opts, ["store", "now", ...Object.keys(RANGES)], "INVALID_OPTIONS", "createMemory options");
  /* store 的方法只按数据属性读一次（getter 不执行、Proxy 异常收口）；之后换掉 store 上的方法不影响本服务 */
  const store = o.store;
  const { read: storeRead, update: storeUpdate } = readMethods(store, ["read", "update"], "INVALID_OPTIONS", "store");
  if (o.now !== undefined && typeof o.now !== "function") throw new MemoryError("INVALID_OPTIONS", "now must be a function");
  const now = o.now === undefined ? Date.now : o.now;
  const lim = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = k in o ? o[k] : DEFAULTS[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new MemoryError("INVALID_OPTIONS", `${k} must be an integer in ${lo}–${hi}`);
    lim[k] = v;
  }

  function tick() {
    let t;
    try { t = now(); } catch (_) { throw new MemoryError("INVALID_CLOCK", "clock failed"); }
    if (!Number.isSafeInteger(t) || t < 0) throw new MemoryError("INVALID_CLOCK", "clock must return a non-negative integer (ms)");
    return t;
  }
  /* 会话到期时间 now + TTL 必须仍是安全整数，否则当作时钟非法（在读写任何会话之前检查） */
  function deadline(t) {
    const d = t + lim.sessionTtlMs;
    if (!Number.isSafeInteger(d)) throw new MemoryError("INVALID_CLOCK", "clock is too large for the session TTL");
    return d;
  }
  /* store 的意外（非 MemoryError）一律收成 STORE_IO，原异常挂 cause 供排查 */
  async function viaStore(fn) {
    try { return await fn(); } catch (e) {
      if (e instanceof MemoryError) throw e;
      throw new MemoryError("STORE_IO", "event store failed", e);
    }
  }

  /* ------------------------------------------------------------ Learning Events */
  async function appendEvent(ctx, input) {
    const { owner } = readCtx(ctx);
    const e = ev.validateEventInput(input);
    const at = tick();
    let result = null;
    await viaStore(() => storeUpdate.call(store, owner, doc => {
      result = null;
      const st = ev.load(doc, owner);
      const prev = st.byId.get(e.eventId);
      if (prev) {
        if (!ev.sameContent(prev, e)) throw new MemoryError("EVENT_CONFLICT", "eventId already used with different content");
        result = { event: prev, duplicate: true };
        return null;
      }
      const code = ev.linkError(st, e);
      if (code === "EVENT_CONFLICT") throw new MemoryError(code, "attemptId already used");
      if (code === "ATTEMPT_NOT_FOUND") throw new MemoryError(code, "no attempt with this attemptId in this topic");
      if (code === "ATTEMPT_SETTLED") throw new MemoryError(code, "this attempt already has a result");
      if (st.events.length >= lim.maxEvents) throw new MemoryError("CAPACITY", `event history is full (${lim.maxEvents})`);
      const rec = ev.stamp(e, at);
      result = { event: rec, duplicate: false };
      return ev.makeDocument(owner, [...st.events, rec]);
    }));
    if (!result) throw new MemoryError("STORE_IO", "event store resolved without running the update");
    return Object.freeze(result);
  }

  async function loadEvents(owner) {
    const doc = await viaStore(() => storeRead.call(store, owner));
    return ev.load(doc, owner).events;
  }
  async function getEvents(ctx) {
    return loadEvents(readCtx(ctx).owner);
  }
  async function getStudentMemory(ctx) {
    return ev.project(await loadEvents(readCtx(ctx).owner));
  }

  /* ------------------------------------------------------------ Session（只在内存） */
  const sessions = new Map();   // sessionId → { key, stage, question, attempts, hints, observations, createdAt, updatedAt, expiresAt }

  function purge(t) { for (const [id, s] of sessions) if (t >= s.expiresAt) sessions.delete(id); }
  function find(key, id, t) {
    const s = sessions.get(id);
    if (s && t >= s.expiresAt) sessions.delete(id);
    else if (s && s.key === key) return s;
    throw new MemoryError("SESSION_NOT_FOUND", "session not found or expired");
  }
  /* 快照：新数组 + 冻结条目（条目本身入库时就冻结），调用方改不到内部状态 */
  const snapshot = (id, s) => Object.freeze({
    sessionId: id, stage: s.stage, question: s.question,
    attempts: Object.freeze(s.attempts.slice()), hints: Object.freeze(s.hints.slice()), observations: Object.freeze(s.observations.slice()),
    createdAt: s.createdAt, updatedAt: s.updatedAt, expiresAt: s.expiresAt,
  });

  async function createSession(ctx, init) {
    const { key } = readCtx(ctx);
    const i = init === undefined ? Object.create(null) : readRecord(init, ["stage"], "INVALID_INPUT", "session init");
    if ("stage" in i && !PATCH.stage.stage[1](i.stage)) throw new MemoryError("INVALID_INPUT", "stage must be one of " + SESSION_STAGES.join(", "));
    const t = tick(), expiresAt = deadline(t);
    purge(t);
    if (sessions.size >= lim.maxSessions) throw new MemoryError("SESSION_LIMIT", `too many active sessions (${lim.maxSessions})`);
    const id = "s_" + crypto.randomBytes(16).toString("hex");
    const s = { key, stage: "stage" in i ? i.stage : null, question: null, attempts: [], hints: [], observations: [], createdAt: t, updatedAt: t, expiresAt };
    sessions.set(id, s);
    return snapshot(id, s);
  }

  async function getSession(ctx, sessionId) {
    const { key } = readCtx(ctx);
    const id = readSessionId(sessionId);
    return snapshot(id, find(key, id, tick()));
  }

  async function updateSession(ctx, sessionId, patch) {
    const { key } = readCtx(ctx);
    const id = readSessionId(sessionId);
    const p = readPatch(patch);
    const t = tick(), expiresAt = deadline(t);   // 续期时间先算：不可安全表示就在任何状态变化（含清理过期）之前失败
    const s = find(key, id, t);
    const push = (list, entry) => {
      if (!s.question) throw new MemoryError("SESSION_STATE", "record a question first");
      if (list.length >= lim.maxEntries) throw new MemoryError("SESSION_LIMIT", `at most ${lim.maxEntries} ${p.type} records per question`);
      list.push(Object.freeze(entry));
    };
    switch (p.type) {
      case "question":
        s.question = Object.freeze({ text: p.text, topicId: "topicId" in p ? p.topicId : null, at: t });
        s.attempts = []; s.hints = []; s.observations = [];
        break;
      case "attempt": push(s.attempts, { answer: p.answer, at: t }); break;
      case "hint": push(s.hints, { text: p.text, at: t }); break;
      case "observation": push(s.observations, { tool: p.tool, summary: p.summary, at: t }); break;
      case "stage": s.stage = p.stage; break;
    }
    s.updatedAt = t;
    s.expiresAt = expiresAt;
    return snapshot(id, s);
  }

  async function closeSession(ctx, sessionId) {
    const { key } = readCtx(ctx);
    const id = readSessionId(sessionId);
    find(key, id, tick());
    sessions.delete(id);
    return Object.freeze({ closed: true });
  }

  return Object.freeze({ createSession, getSession, updateSession, closeSession, appendEvent, getEvents, getStudentMemory });
}

module.exports = { createMemory, MemoryError, EVENT_TYPES: ev.EVENT_TYPES, MISTAKES: ev.MISTAKES, STYLES: ev.STYLES, SESSION_STAGES, DEFAULTS };
