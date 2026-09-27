/*
 * 辅导工作流的 HTTP 接缝（#61，#19 Phase 9d）：server.js 的 /api/tutor/workflow* 只做「开关 / 鉴权 / 读 body / ctx / 话题」，
 * 其余（练习题筛选、评分器、按孩子分的学习事件、限速、引擎检查、给孩子看的视图、错误码 → HTTP 状态）都在这里，便于不起服务器单测。
 *
 *   const svc = createWorkflowService({
 *     tutor,                        // { ask(ctx, req) }：问老师 service 的 agentAsk（同一套选引擎和 agent 缓存）
 *     engineReady: () => bool,      // 现在有没有能用的引擎：会调模型的命令（teach / hint）先查这个
 *     memoryFor: kidId => memory|null,   // 这个孩子的 createMemory（appendEvent / getStudentMemory）；孩子已删 → null
 *     bankFor: (topicId, lang) => bank|null,   // 随包 / 已有题库（qbankPlayable），不现出题
 *     settings: () => cfg.tutorWorkflow,       // 每次现读：{ perMinute }
 *     now, log, random,
 *   });
 *   await svc.start(ctx, body, { topic:{ id, title, goal }, accountId })  → { status, body }
 *   await svc.get(ctx, workflowId) / send(ctx, workflowId, body, { accountId }) / close(ctx, workflowId)
 *
 * ctx = { userId: familyId, kidId, role }：家长和孩子看同一个孩子的同一组工作流和学习事件（所有者 = [familyId, kidId]）。
 * accountId 是登录账号本身，只用来限速。
 *
 * 练习题（practiceFrom）：只收正确选项能按 number.js 解析成一个数、其它选项和它不等值、没有 visual、qid 合事件 id 规则的题；
 * 题目 = 题干 + 不带字母的选项列表 + 「写出答案的数」，答案键 = 正确选项原文，评分用确定性 createAnswerGrader（写法不同 → uncertain，从不给误因）。
 * 家庭「孩子只给提示」不强制到工作流：首课只交话题名和目标；提示 / 补救步本来就强制 hint，题面（含选项）会交给模型，
 * 显式说出答案（数字形式）由 #38 本地复核拦，换说法的泄露和「问老师」里孩子贴带选项的题一样拦不住。
 * 名额：每家同时 MAX_PER_FAMILY 个活跃工作流；做完（completed / ended）的立即关掉，不占名额。
 * 限额只扣「真的会问模型」的 teach / hint（willAskModel）：原样重放、在途、挂起、会被拒的命令都不扣、也不查引擎。
 */
"use strict";
const crypto = require("crypto");
const { createTutorWorkflow, WorkflowError } = require("./index.js");
const { MemoryError } = require("../memory/errors.js");
const { isEventId } = require("../memory/events.js");
const { createAnswerGrader } = require("../verification/answer.js");
const { parseAnswerNumber, equal } = require("../verification/number.js");

const WINDOW_MS = 60000;
const DEFAULTS = Object.freeze({ enabled: false, perMinute: 6 });
const PER_MINUTE = [1, 120];
const MODEL_COMMANDS = ["teach", "hint"];
const START_KEYS = ["curriculumId", "lang", "commandId", "kid"];
const COMMAND_KEYS = ["type", "commandId", "expectedVersion", "questionId", "answer"];
const PROMPT_MAX = 1000;
const MAX_ROUNDS = 5;        // 工作流默认的轮数；合格题不够时按题数收
const MAX_PER_FAMILY = 6;    // 每家同时活跃的工作流（工作流模块自己另有每个孩子 3 个、整个进程 100 个）

/* WorkflowError（什么都没发生）→ HTTP 状态；不在表里的一律 500 */
const STATUS = {
  INVALID_INPUT: 400, INVALID_CTX: 400, NOT_FOUND: 404,
  ILLEGAL_COMMAND: 409, STALE: 409, COMMAND_CONFLICT: 409, PENDING_OPERATION: 409,
  BUSY: 429, LIMIT: 429, CAPACITY: 429,
};
const MSG = {
  badBody: { error: "请求格式不对 / Malformed request", code: "INVALID_INPUT" },
  noPractice: { error: "这一节还没有能在这里练的题（要有数字答案的随附题）/ No practice questions with number answers for this topic yet", code: "NO_PRACTICE", noPractice: true },
  rate: { error: "问得太快啦，歇一分钟再问 / Too many requests — wait a minute", code: "RATE_LIMITED", rateLimited: true },
  noEngine: { error: "没有可用的 AI 引擎，请家长在设置里检查 / No AI engine available — ask a parent to check settings", code: "NO_ENGINE", noEngine: true },
};

function readSettings(raw) {
  const v = raw && typeof raw === "object" ? raw.perMinute : undefined;
  return { perMinute: Number.isSafeInteger(v) && v >= PER_MINUTE[0] && v <= PER_MINUTE[1] ? v : DEFAULTS.perMinute };
}

/* 只认列出的自有字段；值的内容由工作流自己校验（readStart / readCommand），这里不重复 */
function plainBody(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const k of Object.keys(body)) if (!keys.includes(k)) return null;
  return body;
}

/* 一道题库题 → 工作流的练习题，或 null（不合格） */
function practiceFrom(q, topicId, lang) {
  if (!q || typeof q !== "object" || q.visual != null) return null;
  if (!isEventId(q.qid) || typeof q.question !== "string" || !q.question.trim()) return null;
  const opts = q.options;
  if (!Array.isArray(opts) || opts.length < 2 || opts.length > 6 || !opts.every(o => typeof o === "string" && o.trim())) return null;
  const ai = q.answerIndex;
  if (!Number.isInteger(ai) || ai < 0 || ai >= opts.length) return null;
  const key = parseAnswerNumber(opts[ai]);
  if (!key.ok) return null;
  for (let i = 0; i < opts.length; i++) {
    if (i === ai) continue;
    const o = parseAnswerNumber(opts[i]);
    if (o.ok && equal(o.value, key.value)) return null;   // 两个选项等值：写哪个都说不清对错
  }
  /* 选项不带字母：这段题面也会交给模型（提示 / 补救步），带字母的话「答案是 C」这种泄露本地复核拦不住（它只认数字答案键） */
  const head = lang === "en" ? "Choices:" : "可选答案：";
  const tail = lang === "en" ? "Type the number." : "写出答案的数。";
  const prompt = q.question.trim() + "\n" + head + "\n" + opts.map(o => "• " + o.trim()).join("\n") + "\n" + tail;
  if (prompt.length > PROMPT_MAX) return null;
  return { questionId: q.qid, topicId, prompt, answerKey: opts[ai].trim() };
}
function eligible(bank, topicId, lang) {
  const out = [];
  for (const q of (bank && Array.isArray(bank.questions) ? bank.questions : [])) { const p = practiceFrom(q, topicId, lang); if (p) out.push(p); }
  return out;
}

/* 给孩子看的视图：去掉 plan（策略会间接反映历史好坏）；家长原样 */
function viewFor(v, role) {
  if (!v || role !== "student") return v;
  const out = Object.assign({}, v);
  delete out.plan;
  return out;
}

function createWorkflowService(opts) {
  opts = opts || {};
  for (const k of ["tutor", "engineReady", "memoryFor", "bankFor", "settings"]) if (!opts[k]) throw new TypeError("workflow service: " + k + " is required");
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const random = opts.random || (n => crypto.randomInt(n));
  const hits = new Map();   // accountId → [ts...]
  /* 本服务自己的账：家庭 → 活跃工作流（每家上限，免得一家占满进程级的 maxWorkflows）；
   * 会调模型的命令哪些已经成功过（原样重放拿缓存，不再扣限额）；每个工作流在途的 commandId（BUSY / 双击不扣） */
  const families = new Map();   // familyKey → Map(workflowId → { ctx, startKey })
  const succeeded = new Map();  // workflowId → Set(commandId)
  const inflight = new Map();   // workflowId → commandId
  const forget = id => { succeeded.delete(id); inflight.delete(id); for (const m of families.values()) m.delete(id); };

  const gone = () => new MemoryError("STORE_IO", "this child's learning record is not available");
  const memory = Object.freeze({
    appendEvent(ctx, input) { const m = opts.memoryFor(ctx.kidId); return m ? m.appendEvent(ctx, input) : Promise.reject(gone()); },
    getStudentMemory(ctx) { const m = opts.memoryFor(ctx.kidId); return m ? m.getStudentMemory(ctx) : Promise.reject(gone()); },
  });
  const practice = Object.freeze({
    next(req) {
      const list = eligible(opts.bankFor(req.topicId, req.lang), req.topicId, req.lang).filter(p => !req.exclude.includes(p.questionId));
      if (!list.length) throw new Error("no practice questions left");
      return list[random(list.length)];
    },
  });
  const wf = createTutorWorkflow({
    tutor: opts.tutor, memory, practice, grader: createAnswerGrader(),
    /* trace 里没有孩子文字；只留阶段去向 */
    onTrace: t => { if (t && t.kind === "workflow") log(`[workflow] ${t.command} ${t.from || "-"}→${t.to || "-"} ${t.ok ? "ok" : "fail:" + t.code}`); },
  });

  function rateHit(id, limit) {
    const t = now();
    const list = (hits.get(id) || []).filter(x => t - x < WINDOW_MS);
    if (list.length >= limit) { hits.set(id, list); return false; }
    list.push(t);
    hits.set(id, list);
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.some(x => t - x < WINDOW_MS)) hits.delete(k);
    return true;
  }
  function fail(e) {
    if (e instanceof WorkflowError) return { status: STATUS[e.code] || 500, body: { error: e.message, code: e.code } };
    log("[workflow] unexpected error: " + (e && e.message));
    return { status: 500, body: { error: "服务器出错了 / Server error", code: "INTERNAL" } };
  }

  /* 这一家现在的活跃工作流：过期 / 关掉 / 已结束的顺手清掉 */
  async function activeOf(fk) {
    const m = families.get(fk);
    if (!m) return new Map();
    for (const [id, rec] of [...m]) {
      let alive = false;
      try { alive = (await wf.get(rec.ctx, id)).status === "active"; } catch (_) { /* NOT_FOUND 等 */ }
      if (!alive) forget(id);
    }
    if (!m.size) families.delete(fk);
    return m;
  }

  async function start(ctx, body, io) {
    const b = plainBody(body, START_KEYS);
    const topic = io && io.topic;
    if (!b || !topic || (b.lang != null && b.lang !== "zh" && b.lang !== "en")) return { status: 400, body: MSG.badBody };
    const lang = b.lang === "en" ? "en" : "zh";
    const n = eligible(opts.bankFor(topic.id, lang), topic.id, lang).length;
    if (!n) return { status: 409, body: MSG.noPractice };
    const fk = String(ctx && ctx.userId), startKey = JSON.stringify([ctx && ctx.kidId, b.commandId]);
    const mine = await activeOf(fk);
    const replay = [...mine.values()].some(r => r.startKey === startKey);
    if (!replay && mine.size >= MAX_PER_FAMILY) return { status: 429, body: { error: `一家最多同时开 ${MAX_PER_FAMILY} 个 / At most ${MAX_PER_FAMILY} active workflows per family`, code: "CAPACITY" } };
    try {
      /* 轮数不超过合格题数：题不够时不会做到一半卡在 PRACTICE_FAILED（targetCorrect 由工作流取 min(3, maxRounds)） */
      const v = await wf.start(ctx, { commandId: b.commandId, topicId: topic.id, title: topic.title, goal: topic.goal, lang, maxRounds: Math.min(MAX_ROUNDS, n) });
      if (!families.has(fk)) families.set(fk, new Map());
      families.get(fk).set(v.workflowId, { ctx: Object.freeze(Object.assign({}, ctx)), startKey });
      return { status: 200, body: viewFor(v, ctx.role) };
    } catch (e) { return fail(e); }
  }

  /* 这条命令会不会真的问模型：只有会问的才查引擎、扣限额。
   * 不会问的：不是 teach / hint、已经成功过（原样重放）、这个工作流有命令在途（BUSY 或双击共享）、有挂起（原命令重发不再问，别的命令 PENDING_OPERATION）、
   * 当前不允许（ILLEGAL_COMMAND / 提示用完）、版本或题号对不上（STALE）、带了这类命令不收的字段（INVALID_INPUT） */
  function willAskModel(id, v, cmd) {
    if (!MODEL_COMMANDS.includes(cmd.type)) return false;
    if ((succeeded.get(id) || new Set()).has(cmd.commandId) || inflight.has(id) || v.pending) return false;
    if (!v.allowed.includes(cmd.type)) return false;
    if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== v.version) return false;
    if ("answer" in cmd) return false;
    if (cmd.type === "teach" && "questionId" in cmd) return false;
    if (cmd.type === "hint" && (!v.question || cmd.questionId !== v.question.questionId)) return false;
    return true;
  }

  async function get(ctx, workflowId) {
    try { return { status: 200, body: viewFor(await wf.get(ctx, workflowId), ctx.role) }; }
    catch (e) { return fail(e); }
  }

  async function send(ctx, workflowId, body, io) {
    const b = plainBody(body, COMMAND_KEYS.concat("kid"));
    if (!b) return { status: 400, body: MSG.badBody };
    const cmd = {};
    for (const k of COMMAND_KEYS) if (b[k] !== undefined) cmd[k] = b[k];
    let mark = false;
    try {
      if (MODEL_COMMANDS.includes(cmd.type)) {
        const v = await wf.get(ctx, workflowId);
        /* 从这里到登记在途之间没有 await：并发的第二个请求一定看得到在途，不会重复扣额 */
        if (willAskModel(workflowId, v, cmd)) {
          if (!opts.engineReady()) return { status: 503, body: MSG.noEngine };
          if (!rateHit(String(io && io.accountId), readSettings(opts.settings()).perMinute)) return { status: 429, body: MSG.rate };
        }
      }
      if (!inflight.has(workflowId)) { inflight.set(workflowId, cmd.commandId); mark = true; }
      const r = await wf.send(ctx, workflowId, cmd);
      if (r.ok && MODEL_COMMANDS.includes(cmd.type)) {
        if (!succeeded.has(workflowId)) succeeded.set(workflowId, new Set());
        succeeded.get(workflowId).add(cmd.commandId);
      }
      /* 做完了（completed / ended）就关掉：不占每个孩子 3 个、每家 MAX_PER_FAMILY 个的名额；最后的 view 就在这次回包里 */
      if (r.view && r.view.status !== "active") {
        try { await wf.close(ctx, workflowId); } catch (_) { /* 已经不在了 */ }
        forget(workflowId); mark = false;
      }
      return { status: 200, body: Object.assign({}, r, { view: viewFor(r.view, ctx.role) }) };
    } catch (e) { return fail(e); }
    finally { if (mark && inflight.get(workflowId) === cmd.commandId) inflight.delete(workflowId); }
  }

  async function close(ctx, workflowId) {
    try {
      const v = await wf.close(ctx, workflowId);
      forget(workflowId);
      return { status: 200, body: viewFor(v, ctx.role) };
    } catch (e) { return fail(e); }
  }

  return Object.freeze({ start, get, send, close });
}

module.exports = { createWorkflowService, practiceFrom, readSettings, WORKFLOW_SERVICE_DEFAULTS: DEFAULTS };
