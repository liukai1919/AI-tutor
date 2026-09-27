/*
 * Learning Events：严格白名单 schema、重放校验、纯投影（#34，#19 Phase 5）。
 * 零依赖、无 I/O。持久化的只有这里定义的结构化字段；题干 / 回答 / 对话 / 模型原文没有字段可放。
 *
 *   validateEventInput(input)   调用方输入 → 冻结的规范事件（不含 at），不合法抛 INVALID_INPUT
 *   load(doc, owner)            文档 → { events, byId, attempts }，逐条按追加规则重放，坏文档抛 STORE_CORRUPT / STORE_VERSION
 *   replay(doc, owner)          load(...).events
 *   project(events)             纯投影：只来自明确事件的计数，不推断掌握 / 偏好 / 特征
 */
"use strict";

const { MemoryError, readRecord, readArray, hasOwn } = require("./errors.js");

const DOC_VERSION = 1;
const EVENT_TYPES = Object.freeze(["question_attempt", "hint_requested", "answer_correct", "answer_wrong", "concept_explained",
  "prerequisite_gap_detected", "topic_mastered", "preference_set"]);
const MISTAKES = Object.freeze(["concept", "calculation", "reading", "careless", "prerequisite-gap"]);
const STYLES = Object.freeze(["visual", "step-by-step", "concrete", "symbolic"]);

/* 标识不是自由文本：首字符字母数字（所以 __proto__ 不可能合法），其余只许 . _ : -；eventId / attemptId ≤64，话题 ≤96 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const isEventId = v => typeof v === "string" && ID_RE.test(v);
const isTopicId = v => typeof v === "string" && TOPIC_RE.test(v);
/* 所有者 id（userId / kidId）：1–128 个字符、无控制字符；服务和文件适配器共用这一条 */
const OWNER_ID_MAX = 128;
const isOwnerId = v => typeof v === "string" && v.length >= 1 && v.length <= OWNER_ID_MAX && !/[\u0000-\u001f\u007f]/.test(v);
/* 外部给的 owner：恰好两个自有数据字符串项，读一次拷成冻结数组；否则 code */
function readOwner(owner, code) {
  const o = readArray(owner, code, "owner", 2);
  if (!isOwnerId(o[0]) || !isOwnerId(o[1])) throw new MemoryError(code, "owner must be [userId, kidId]: 1–128 chars without control characters");
  return Object.freeze(o);
}

/* 每类事件除 eventId / type（/ at）外允许的字段：R 必填，O 可选 */
const SPEC = {
  question_attempt: { topicId: "R", attemptId: "R" },
  hint_requested: { topicId: "R", attemptId: "O" },
  answer_correct: { topicId: "R", attemptId: "R" },
  answer_wrong: { topicId: "R", attemptId: "R", mistake: "O" },
  concept_explained: { topicId: "R" },
  prerequisite_gap_detected: { topicId: "R", prerequisiteTopicId: "R" },
  topic_mastered: { topicId: "R" },
  preference_set: { style: "R" },
};
const FIELD_OK = {
  topicId: isTopicId,
  attemptId: isEventId,
  mistake: v => typeof v === "string" && MISTAKES.includes(v),
  prerequisiteTopicId: isTopicId,
  style: v => typeof v === "string" && STYLES.includes(v),
};
const KEY_ORDER = ["eventId", "type", "at", "topicId", "attemptId", "mistake", "prerequisiteTopicId", "style"];
const INPUT_KEYS = KEY_ORDER.filter(k => k !== "at");
const CONTENT_KEYS = INPUT_KEYS;

function normalize(raw, withAt, code) {
  const what = withAt ? "stored event" : "event";
  const fail = msg => new MemoryError(code, `${what}: ${msg}`);
  const r = readRecord(raw, withAt ? KEY_ORDER : INPUT_KEYS, code, what);
  if (typeof r.type !== "string" || !EVENT_TYPES.includes(r.type)) throw fail("type must be one of " + EVENT_TYPES.join(", "));
  const spec = SPEC[r.type];
  for (const k of Object.keys(r)) if (k !== "eventId" && k !== "type" && k !== "at" && !hasOwn(spec, k)) throw fail(`${k} is not allowed for ${r.type}`);
  if (!isEventId(r.eventId)) throw fail("eventId must match " + ID_RE);
  if (withAt && !(Number.isSafeInteger(r.at) && r.at >= 0)) throw fail("at must be a non-negative integer");
  for (const [k, need] of Object.entries(spec)) {
    const present = k in r;
    if (!present && need === "R") throw fail(`${k} is required for ${r.type}`);
    if (present && !FIELD_OK[k](r[k])) throw fail(`${k} is not valid`);
  }
  if (r.type === "prerequisite_gap_detected" && r.prerequisiteTopicId === r.topicId) throw fail("prerequisiteTopicId must differ from topicId");
  const out = {};
  for (const k of KEY_ORDER) if (k in r) out[k] = r[k];
  return Object.freeze(out);
}

const validateEventInput = input => normalize(input, false, "INVALID_INPUT");
const stamp = (e, at) => { const out = {}; for (const k of KEY_ORDER) { if (k === "at") out.at = at; else if (hasOwn(e, k)) out[k] = e[k]; } return Object.freeze(out); };
const sameContent = (a, b) => CONTENT_KEYS.every(k => hasOwn(a, k) === hasOwn(b, k) && a[k] === b[k]);

/* 状态：按存储顺序的事件、eventId 索引、尝试表 attemptId → { topicId, settled } */
const newState = () => ({ events: [], byId: new Map(), attempts: new Map() });

/* 追加规则（eventId 重复另行处理）：返回 null 或错误码 */
function linkError(st, e) {
  if (e.type === "question_attempt") return st.attempts.has(e.attemptId) ? "EVENT_CONFLICT" : null;
  if (e.type === "answer_correct" || e.type === "answer_wrong") {
    const a = st.attempts.get(e.attemptId);
    if (!a || a.topicId !== e.topicId) return "ATTEMPT_NOT_FOUND";
    return a.settled ? "ATTEMPT_SETTLED" : null;
  }
  if (e.type === "hint_requested" && hasOwn(e, "attemptId")) {
    const a = st.attempts.get(e.attemptId);
    return !a || a.topicId !== e.topicId ? "ATTEMPT_NOT_FOUND" : null;
  }
  return null;
}
function apply(st, e) {
  st.events.push(e);
  st.byId.set(e.eventId, e);
  if (e.type === "question_attempt") st.attempts.set(e.attemptId, { topicId: e.topicId, settled: false });
  else if (e.type === "answer_correct" || e.type === "answer_wrong") st.attempts.get(e.attemptId).settled = true;
}

/* 已存事件按顺序重放；任何一条不合法、重复或违反关联规则都算坏档 */
function foldEvents(raw) {
  const corrupt = msg => new MemoryError("STORE_CORRUPT", "event document is corrupt: " + msg);
  const list = readArray(raw, "STORE_CORRUPT", "event list");   // 快照：洞 / getter / 多余属性 / 撤销的 Proxy 都是坏档
  const st = newState();
  for (let i = 0; i < list.length; i++) {
    const e = normalize(list[i], true, "STORE_CORRUPT");
    if (st.byId.has(e.eventId)) throw corrupt(`events[${i}] repeats an eventId`);
    const code = linkError(st, e);
    if (code) throw corrupt(`events[${i}] breaks attempt linkage (${code})`);
    apply(st, e);
  }
  Object.freeze(st.events);
  return st;
}

/* 文档信封：恰好 { version, owner, events }；先认版本（未知版本不当空档），再认形状和所有者 */
const ENVELOPE_KEYS = ["version", "owner", "events"];
function checkDocument(doc, owner) {
  const corrupt = msg => new MemoryError("STORE_CORRUPT", "event document is corrupt: " + msg);
  if (doc === null || typeof doc !== "object") throw corrupt("not an object");
  let isArray, vd;
  try { isArray = Array.isArray(doc); vd = Object.getOwnPropertyDescriptor(doc, "version"); } catch (_) { throw corrupt("unreadable"); }
  if (isArray) throw corrupt("not an object");
  if (!vd || !("value" in vd) || vd.value !== DOC_VERSION) throw new MemoryError("STORE_VERSION", "unsupported event document version");
  const r = readRecord(doc, ENVELOPE_KEYS, "STORE_CORRUPT", "event document");
  for (const k of ENVELOPE_KEYS) if (!(k in r)) throw corrupt(k + " missing");
  const o = readArray(r.owner, "STORE_CORRUPT", "event document owner", 2);
  if (o[0] !== owner[0] || o[1] !== owner[1]) throw corrupt("owner does not match");
  return { version: DOC_VERSION, owner: o, events: readArray(r.events, "STORE_CORRUPT", "event list") };
}

/* 文档 → 重放状态。null / undefined = 空历史（事件数组同样冻结）。任何意外（不是我们的 MemoryError）都算坏档 */
function load(doc, owner) {
  try {
    return foldEvents(doc === null || doc === undefined ? [] : checkDocument(doc, owner).events);
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError("STORE_CORRUPT", "event document could not be read");
  }
}
const replay = (doc, owner) => load(doc, owner).events;
const makeDocument = (owner, events) => ({ version: DOC_VERSION, owner: [owner[0], owner[1]], events });

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}
const zeroMistakes = () => { const m = {}; for (const k of MISTAKES) m[k] = 0; return m; };

/* 纯投影：同一事件列表 → 逐字相同的结果；不改入参；话题按首次出现顺序 */
function project(events) {
  const st = foldEvents(events);
  const topics = new Map(), totals = zeroMistakes();
  let preference = null;
  for (const e of st.events) {
    if (e.type === "preference_set") { preference = { style: e.style, at: e.at }; continue; }
    let t = topics.get(e.topicId);
    if (!t) {
      t = { topicId: e.topicId, attempts: 0, correct: 0, wrong: 0, unsettled: 0, hints: 0, explanations: 0, gaps: new Map(),
        mistakes: zeroMistakes(), mastered: false, masteredAt: null, firstAt: e.at, lastAt: e.at };
      topics.set(e.topicId, t);
    }
    t.firstAt = Math.min(t.firstAt, e.at); t.lastAt = Math.max(t.lastAt, e.at);
    switch (e.type) {
      case "question_attempt": t.attempts++; t.unsettled++; break;
      case "answer_correct": t.correct++; t.unsettled--; break;
      case "answer_wrong":
        t.wrong++; t.unsettled--;
        if (hasOwn(e, "mistake")) { t.mistakes[e.mistake]++; totals[e.mistake]++; }   // 只认事件自己的字段，原型污染不算误因
        break;
      case "hint_requested": t.hints++; break;
      case "concept_explained": t.explanations++; break;
      case "prerequisite_gap_detected": t.gaps.set(e.prerequisiteTopicId, (t.gaps.get(e.prerequisiteTopicId) || 0) + 1); break;
      case "topic_mastered": if (!t.mastered) { t.mastered = true; t.masteredAt = e.at; } break;
    }
  }
  return deepFreeze({
    eventCount: st.events.length,
    topics: [...topics.values()].map(t => ({
      topicId: t.topicId, attempts: t.attempts, correct: t.correct, wrong: t.wrong, unsettled: t.unsettled, hints: t.hints, explanations: t.explanations,
      prerequisiteGaps: [...t.gaps].map(([topicId, count]) => ({ topicId, count })),
      mistakes: t.mistakes, mastered: t.mastered, masteredAt: t.masteredAt, firstAt: t.firstAt, lastAt: t.lastAt,
    })),
    mistakes: totals,
    preference,
  });
}

module.exports = {
  DOC_VERSION, EVENT_TYPES, MISTAKES, STYLES, ID_RE, TOPIC_RE, isEventId, isTopicId, isOwnerId, readOwner,
  validateEventInput, stamp, sameContent, linkError, load, replay, project, checkDocument, makeDocument,
};
