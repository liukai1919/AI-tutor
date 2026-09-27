/*
 * 结构化辅导工作流（#36，#19 Phase 6）：Diagnose → Teach → Practice → Evaluate → Adapt 的会话服务。零依赖、无网络。
 *
 *   const wf = createTutorWorkflow({ tutor, memory, practice, grader, now, ttlMs, maxWorkflows, maxPerOwner, maxCommands, adapterTimeoutMs, tutorTimeoutMs, onTrace, onTraceError });
 *   await wf.start(ctx, { commandId, topicId, title, goal, lang, maxRounds?, targetCorrect?, maxAttempts?, maxHints? })  → view
 *   await wf.get(ctx, workflowId)                                                                                          → view
 *   await wf.send(ctx, workflowId, { type, commandId, expectedVersion?, questionId?, answer? })                          → { ok, code, detail, view, reply }
 *   await wf.close(ctx, workflowId)                                                                                        → view（status closed）
 *
 * - 注入：tutor = 真实 TutorAgent（ask）；memory = Phase 5 createMemory（appendEvent、getStudentMemory）；
 *   practice.next(req) → 结构化题目；grader.grade(req) → { outcome, mistake? }。方法构造时按数据属性各读一次。
 * - 阶段只按 machine.js 的表转换；模型只产出本步给孩子看的文字，从不决定阶段、评分或学习事件。
 * - 契约错误（什么都没发生）reject WorkflowError；这一步试过了（成功或失败）resolve 冻结结果，失败时阶段不前进。
 * - 学习事件只经 memory.appendEvent，事件 id 全部由 workflowId 派生。写失败时本步结果挂在私有 pending 里；
 *   pending 只属于创建它的那一条命令（commandId + 内容），只有原样重发这条命令才能继续，别的命令一律 PENDING_OPERATION；
 *   继续时只重做没完成的那部分（不重问模型、不重新评分），memory 按 eventId 去重，所以同一副作用最多记一次。
 * - 可选字段一律按自有属性读、规范化结果用 null 原型：Object.prototype 被污染也补不出缺省的字段。
 * - 工作流状态只在本进程内存里（有 TTL / 容量上限），重启即丢；已写入的学习事件不丢。细节见 docs/tutor-workflow.md。
 */
"use strict";

const crypto = require("crypto");
const { WorkflowError, readPlain, readMethods, hasOwn } = require("./errors.js");
const m = require("./machine.js");
const ad = require("./adapters.js");
const { MemoryError } = require("../memory/errors.js");
const { isOwnerId } = require("../memory/events.js");
const { verifyResponse } = require("../verification/response.js");
const { verifyStep } = require("../verification/workflow.js");

const DEFAULTS = Object.freeze({ ttlMs: 30 * 60 * 1000, maxWorkflows: 100, maxPerOwner: 3, maxCommands: 500, adapterTimeoutMs: 10000, tutorTimeoutMs: 120000 });
const RANGES = { ttlMs: [1000, 24 * 60 * 60 * 1000], maxWorkflows: [1, 10000], maxPerOwner: [1, 100], maxCommands: [10, 10000], adapterTimeoutMs: [1, 120000], tutorTimeoutMs: [1, 600000] };
const OPTION_KEYS = ["tutor", "memory", "practice", "grader", "now", "onTrace", "onTraceError", ...Object.keys(RANGES)];
const WORKFLOW_RE = /^w[0-9a-f]{24}$/;
const ROLES = ["student", "parent"];

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}
/* 带可选字段的输出一律 null 原型：缺的字段读出来就是 undefined，不会从被污染的 Object.prototype 上继承 */
const rec = fields => Object.assign(Object.create(null), fields);
const own = (o, k) => (o !== null && typeof o === "object" && hasOwn(o, k) ? o[k] : undefined);

function readCtx(ctx) {
  const c = readPlain(ctx, ["userId", "kidId", "role"], "INVALID_CTX", "ctx");
  if (!isOwnerId(c.userId) || !isOwnerId(c.kidId) || typeof c.role !== "string" || !ROLES.includes(c.role))
    throw new WorkflowError("INVALID_CTX", "ctx must be { userId, kidId: 1–128 chars without control characters, role: student|parent }");
  return Object.freeze({ userId: c.userId, kidId: c.kidId, role: c.role, key: JSON.stringify([c.userId, c.kidId]) });
}
/* 交给 TutorAgent / memory / 适配器的 ctx：每次一个新的冻结对象，只有这三个字段 */
const callerCtx = c => Object.freeze({ userId: c.userId, kidId: c.kidId, role: c.role });

function readWorkflowId(id) {
  if (typeof id !== "string" || !WORKFLOW_RE.test(id)) throw new WorkflowError("INVALID_INPUT", "workflowId is not valid");
  return id;
}

/* 投影里本话题的计数 → 只含 Diagnose 需要的数字的新对象；只读自有属性，形状不对就抛（按 STORE_FAILED 收口） */
function topicSummary(sm, topicId) {
  const count = v => { if (!Number.isSafeInteger(v) || v < 0) throw new Error("bad count"); return v; };
  const topics = own(sm, "topics");
  if (!Array.isArray(topics)) throw new Error("bad projection");
  const t = topics.find(x => own(x, "topicId") === topicId);
  if (!t) return null;
  const gaps = own(t, "prerequisiteGaps"), mistakes = own(t, "mistakes");
  if (!Array.isArray(gaps) || !mistakes) throw new Error("bad topic");
  return {
    attempts: count(own(t, "attempts")), correct: count(own(t, "correct")), wrong: count(own(t, "wrong")),
    prerequisiteGaps: gaps.length > 0 ? [true] : [],   // 只有「有没有」参与决定
    mistakes: { concept: count(own(mistakes, "concept")), "prerequisite-gap": count(own(mistakes, "prerequisite-gap")) },
  };
}

const CLOSED = Object.freeze({ ok: false, code: "CLOSED" });

function createTutorWorkflow(opts) {
  const o = readPlain(opts, OPTION_KEYS, "INVALID_OPTIONS", "createTutorWorkflow options");
  const { tutor, memory, practice, grader } = o;
  const { ask } = readMethods(tutor, ["ask"], "INVALID_OPTIONS", "tutor");
  const { appendEvent, getStudentMemory } = readMethods(memory, ["appendEvent", "getStudentMemory"], "INVALID_OPTIONS", "memory");
  const { next: practiceNext } = readMethods(practice, ["next"], "INVALID_OPTIONS", "practice");
  const { grade } = readMethods(grader, ["grade"], "INVALID_OPTIONS", "grader");
  for (const k of ["now", "onTrace", "onTraceError"]) if (k in o && typeof o[k] !== "function") throw new WorkflowError("INVALID_OPTIONS", `${k} must be a function`);
  const now = "now" in o ? o.now : Date.now;
  const onTrace = "onTrace" in o ? o.onTrace : () => {};
  /* 默认上报只写 trace 的 kind（我们自己的常量）：回调抛出的错误信息可能带任意文本，不打印 */
  const onTraceError = "onTraceError" in o ? o.onTraceError : (e, t) => console.warn(`[workflow] trace callback failed kind=${t.kind}`);
  const lim = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = k in o ? o[k] : DEFAULTS[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new WorkflowError("INVALID_OPTIONS", `${k} must be an integer in ${lo}–${hi}`);
    lim[k] = v;
  }

  /* ------------------------------------------------------------ 时钟 / trace */
  function tick() {
    let t;
    try { t = now(); } catch (_) { throw new WorkflowError("INVALID_CLOCK", "clock failed"); }
    if (!Number.isSafeInteger(t) || t < 0) throw new WorkflowError("INVALID_CLOCK", "clock must return a non-negative integer (ms)");
    return t;
  }
  function deadline(t) {
    const d = t + lim.ttlMs;
    if (!Number.isSafeInteger(d)) throw new WorkflowError("INVALID_CLOCK", "clock is too large for the workflow TTL");
    return d;
  }
  const safeTick = fallback => { try { return tick(); } catch (_) { return fallback; } };
  /* trace 是旁路：回调同步抛错 / reject 只交给 onTraceError，那里再出错也吞掉，业务结果不变 */
  function emit(fields) {
    const t = Object.freeze(rec(fields));
    const report = e => { try { const p = onTraceError(e, t); if (p && typeof p.then === "function") p.then(null, () => {}); } catch (_) { /* 吞掉 */ } };
    try { const p = onTrace(t); if (p && typeof p.then === "function") p.then(null, report); } catch (e) { report(e); }
  }

  /* ------------------------------------------------------------ 会话表 */
  const flows = new Map();    // workflowId → 工作流（私有可变状态）
  const starts = new Map();   // ownerKey \0 start commandId → workflowId（启动幂等）

  function drop(w) { flows.delete(w.id); if (starts.get(w.startKey) === w.id) starts.delete(w.startKey); }
  /* 在途命令的工作流不过期（命令结束时续期）；在途时长由各外部调用的上限约束，只有已提交的 memory 写入不设上限（见 write） */
  function purge(t) { for (const w of [...flows.values()]) if (!w.inflight && t >= w.expiresAt) drop(w); }
  function find(key, id, t) {
    const w = flows.get(id);
    if (w && !w.inflight && t >= w.expiresAt) drop(w);
    else if (w && w.key === key) return w;
    throw new WorkflowError("NOT_FOUND", "workflow not found or expired");
  }

  const statusOf = w => (w.failed ? "failed" : w.closed ? "closed" : w.phase !== "done" ? "active" : w.outcome === "goal-reached" ? "completed" : "ended");
  function allowedNow(w) {
    if (w.failed || w.closed || w.phase === "done") return [];
    if (w.pending) return [w.pending.type];
    return m.ALLOWED[w.phase].filter(c => c !== "hint" || w.question.hints < w.limits.maxHints);
  }
  const evaluationOut = e => rec(Object.assign({ attemptId: e.attemptId, outcome: e.outcome }, hasOwn(e, "mistake") ? { mistake: e.mistake } : {}));
  /* 公开视图：新对象、深冻结；没有答案键、作答文本、模型原文、学生历史 */
  function view(w) {
    const q = w.question, e = w.evaluation;
    return deepFreeze({
      workflowId: w.id, version: w.version, status: statusOf(w), phase: w.phase, stage: m.STAGE_OF[w.phase], teachMode: w.teachMode,
      topicId: w.topicId, lang: w.lang, limits: Object.assign({}, w.limits),
      plan: w.plan ? { strategy: w.plan } : null,
      round: w.round, correct: w.correct, wrong: w.wrong, uncertain: w.uncertain,
      question: q ? { questionId: q.questionId, prompt: q.prompt, attempts: q.attempts, hints: q.hints } : null,
      evaluation: e ? evaluationOut(e) : null,
      pending: w.pending ? { type: w.pending.type, commandId: w.pending.commandId } : null,
      outcome: w.failed ? null : w.outcome,   // 后置条件失败的工作流不宣称任何结束结果
      allowed: allowedNow(w),
      createdAt: w.createdAt, updatedAt: w.updatedAt, expiresAt: w.expiresAt,
    });
  }
  /* pending 只属于创建它的那条命令：commandId + 规范内容指纹，内容本身不可变 */
  const makePending = (cmd, fields) => Object.assign({ type: cmd.type, commandId: cmd.commandId, fp: m.fingerprint(cmd) }, fields);

  /* ------------------------------------------------------------ 外部调用 */
  /* 拒绝值是外部值：instanceof 碰到撤销的 Proxy 会抛，MemoryError 的 code 也可能是会抛错的 getter。
   * 这里必须是全函数——检查过程中出任何问题都退回 STORE_IO；detail 只收错误码形状的字符串，不带自由文本 */
  const STORE_IO_FAIL = Object.freeze({ ok: false, code: "STORE_FAILED", detail: "STORE_IO" });
  const DETAIL_RE = /^[A-Z][A-Z_]{0,31}$/;
  function storeFail(e) {
    let detail = "STORE_IO";
    try {
      if (e instanceof MemoryError) { const c = e.code; if (typeof c === "string" && DETAIL_RE.test(c)) detail = c; }
    } catch (_) { detail = "STORE_IO"; }
    return { ok: false, code: "STORE_FAILED", detail };
  }
  /* 可取消、限时的外部调用：close（signal）→ cancel；超过 ms → timeout；之后才到的结果不采用，只发一条 late trace。
   * 只用于可以放弃的调用（TutorAgent、题目 / 评分接口、只读的 memory 读取）。 */
  function race(w, source, fn, signal, ms) {
    if (signal.aborted) return Promise.resolve({ kind: "cancel" });
    return new Promise(resolve => {
      let done = false;
      const finish = x => {
        if (done) return false;
        done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort);
        resolve(x);
        return true;
      };
      const onAbort = () => finish({ kind: "cancel" });
      const timer = setTimeout(() => finish({ kind: "timeout" }), ms);
      signal.addEventListener("abort", onAbort, { once: true });
      const late = ok => emit({ kind: "late", workflowId: w.id, source, ok, at: safeTick(0) });
      let p;
      try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
      p.then(v => { if (!finish({ kind: "value", value: v })) late(true); }, e => { if (!finish({ kind: "error", error: e })) late(false); });
    });
  }
  /* 事件写入一旦交给 memory 就不能撤销，也不做超时竞速（超时后它仍可能提交，报「失败」会让重试语义说谎）；
   * 只有 close 能让命令不再等它（命令以 CLOSED 结束），写入本身仍可能在之后落盘。 */
  function write(c, event, signal) {
    let p;
    try { p = Promise.resolve(appendEvent.call(memory, callerCtx(c), event)); } catch (e) { p = Promise.reject(e); }
    /* settled 永远 resolve（storeFail 是全函数，另加一道兜底），所以不会有未处理拒绝，也不会让命令一直挂着、工作流一直 BUSY */
    const settled = p.then(() => ({ ok: true }), e => storeFail(e)).catch(() => STORE_IO_FAIL);
    if (signal.aborted) return Promise.resolve(CLOSED);
    return new Promise(resolve => {
      const onAbort = () => resolve(CLOSED);
      signal.addEventListener("abort", onAbort, { once: true });
      const finish = r => { signal.removeEventListener("abort", onAbort); resolve(r); };
      settled.then(finish, () => finish(STORE_IO_FAIL));
    });
  }
  /* TutorAgent：限时（tutorTimeoutMs，另有它自己的 totalTimeoutMs）；超时或 close 都 abort 交给它的 signal，让 Harness 停下。
   * #38：请求带本地验证上下文 verify = { topicId, answerKey? }（TutorAgent 只在结果校验里用，不交给模型），TutorAgent 在自己的有限重试里修正；
   * 拿回来的文字在这里再本地核对一次（注入的 tutor 未必是真 TutorAgent）：显式算术等式为假、hint 模式下显式说出答案键、
   * socratic-teaching 不是问句 → TUTOR_ERROR / VERIFICATION。 */
  async function askTutor(w, c, question, mode, strategy, kinds, signal, answerKey) {
    const ac = new AbortController();
    const onOuter = () => ac.abort();
    signal.addEventListener("abort", onOuter, { once: true });
    const verify = Object.freeze(Object.assign(Object.create(null), { topicId: w.topicId }, answerKey ? { answerKey } : {}));
    const req = Object.freeze({ question, lang: w.lang, mode, strategy, verify, signal: ac.signal });
    const g = await race(w, "tutor", () => ask.call(tutor, callerCtx(c), req), signal, lim.tutorTimeoutMs);
    signal.removeEventListener("abort", onOuter);
    if (g.kind !== "value") ac.abort();
    if (g.kind === "cancel") return CLOSED;
    if (g.kind === "timeout") return { ok: false, code: "TUTOR_TIMEOUT", reply: ad.errorReply(w.lang) };
    const r = ad.readTutorReply(g.kind === "value" ? g.value : null, w.lang, kinds);
    if (!r.ok) return r;
    /* 本地复核用可信的 strategy 和本地上下文（有答案键时带上）：socratic-teaching 的回复必须是问句，hint 不许显式说出答案键；
     * 这里没有工具证据，课程 id / 计算器声明两条不查（TutorAgent 那一层查） */
    const v = verifyResponse(r.reply, { mode, strategy, question, context: answerKey ? { answerKey } : {} });
    if (!v.ok) return { ok: false, code: "TUTOR_ERROR", detail: "VERIFICATION", reply: ad.errorReply(w.lang) };
    return r;
  }

  /* ------------------------------------------------------------ 各步（每个 await 之后先看是否已关闭） */
  const STEPS = {
    async diagnose(w, c, cmd, signal) {
      const g = await race(w, "memory", () => getStudentMemory.call(memory, callerCtx(c)), signal, lim.adapterTimeoutMs);
      if (w.closed || g.kind === "cancel") return CLOSED;
      if (g.kind === "timeout") return { ok: false, code: "STORE_FAILED", detail: "TIMEOUT" };
      if (g.kind === "error") return storeFail(g.error);
      let summary;
      try { summary = topicSummary(g.value, w.topicId); } catch (_) { return { ok: false, code: "STORE_FAILED", detail: "BAD_PROJECTION" }; }
      w.plan = m.chooseStrategy(summary);
      w.phase = "teach"; w.teachMode = "lesson"; w.version++;
      return { ok: true };
    },

    async teach(w, c, cmd, signal) {
      if (w.teachMode === "remediate") {
        const q = w.question;
        const mistake = hasOwn(w.evaluation, "mistake") ? w.evaluation.mistake : null;
        const r = await askTutor(w, c, ad.remediateQuestion(w.lang, q.prompt, q.lastAnswer, mistake), "hint", "diagnose-error", ["hint"], signal, q.answerKey);
        if (w.closed) return CLOSED;
        if (!r.ok) return r;
        w.phase = "answer"; w.teachMode = null; w.version++;
        return { ok: true, reply: r.reply };
      }
      /* 首课的事件要和策略对得上：explain-concept 必须回来讲解（kind answer）才记 concept_explained；
       * socratic-teaching 只是引导提问（kind hint），现有事件表里没有合适的类型，不记事件（同 remediate） */
      const explain = w.plan === "explain-concept";
      if (!w.pending) {
        const r = await askTutor(w, c, ad.lessonQuestion(w.lang, w.title, w.goal), explain ? "answer" : "hint", w.plan, explain ? ["answer"] : ["hint"], signal);
        if (w.closed) return CLOSED;
        if (!r.ok) return r;
        if (!explain) {
          w.phase = "practice"; w.teachMode = null; w.version++;
          return { ok: true, reply: r.reply };
        }
        w.pending = makePending(cmd, { reply: r.reply, event: Object.freeze({ eventId: w.id + ".c", type: "concept_explained", topicId: w.topicId }) });
        w.version++;
      }
      const wr = await write(c, w.pending.event, signal);
      if (w.closed) return CLOSED;
      if (!wr.ok) return wr;
      const reply = w.pending.reply;
      w.pending = null; w.phase = "practice"; w.teachMode = null; w.version++;
      return { ok: true, reply };
    },

    async practice(w, c, cmd, signal) {
      const req = Object.freeze({ ctx: callerCtx(c), topicId: w.topicId, lang: w.lang, round: w.round + 1, exclude: Object.freeze(w.used.slice()) });
      const g = await race(w, "practice", () => practiceNext.call(practice, req), signal, lim.adapterTimeoutMs);
      if (w.closed || g.kind === "cancel") return CLOSED;
      if (g.kind === "timeout") return { ok: false, code: "PRACTICE_TIMEOUT" };
      if (g.kind === "error") return { ok: false, code: "PRACTICE_FAILED" };
      let q;
      try { q = ad.readQuestion(g.value, { topicId: w.topicId, used: w.used }); } catch (_) { return { ok: false, code: "PRACTICE_INVALID" }; }
      w.round++;
      w.used.push(q.questionId);
      w.question = { questionId: q.questionId, prompt: q.prompt, answerKey: q.answerKey, attempts: 0, hints: 0, lastAttemptId: null, lastAnswer: null };
      w.evaluation = null; w.phase = "answer"; w.version++;
      return { ok: true };
    },

    async hint(w, c, cmd, signal) {
      const q = w.question;
      if (!w.pending) {
        const r = await askTutor(w, c, ad.hintQuestion(w.lang, q.prompt), "hint", m.hintStrategy(w.plan), ["hint"], signal, q.answerKey);
        if (w.closed) return CLOSED;
        if (!r.ok) return r;
        const event = { eventId: `${w.id}.q${w.round}.h${q.hints + 1}`, type: "hint_requested", topicId: w.topicId };
        if (q.lastAttemptId !== null) event.attemptId = q.lastAttemptId;   // 答错之后的提示挂到那次尝试上
        w.pending = makePending(cmd, { reply: r.reply, event: Object.freeze(event) });
        w.version++;
      }
      const wr = await write(c, w.pending.event, signal);
      if (w.closed) return CLOSED;
      if (!wr.ok) return wr;
      const reply = w.pending.reply;
      w.pending = null; q.hints++; w.version++;
      return { ok: true, reply };
    },

    async submit(w, c, cmd, signal) {
      const q = w.question;
      /* 挂起的尝试只属于原命令：attemptId 和作答都不可变（原样重发的命令内容本来就相同），不会把已提交的尝试换绑到别的作答上 */
      if (!w.pending) {
        const unsafe = ad.screenAnswer(w.lang, cmd.answer);
        if (unsafe) return unsafe;
        w.pending = makePending(cmd, { attemptId: `${w.id}.q${w.round}.a${q.attempts + 1}`, answer: cmd.answer });
        w.version++;
      }
      const p = w.pending;
      const wr = await write(c, { eventId: p.attemptId + ".qa", type: "question_attempt", topicId: w.topicId, attemptId: p.attemptId }, signal);
      if (w.closed) return CLOSED;
      if (!wr.ok) return Object.assign(wr, { attemptId: p.attemptId });
      q.attempts++; q.lastAttemptId = p.attemptId; q.lastAnswer = p.answer;
      w.evalState = { attemptId: p.attemptId, answer: p.answer };
      w.pending = null; w.evaluation = null; w.phase = "evaluate"; w.version++;
      return { ok: true, attemptId: p.attemptId };
    },

    async evaluate(w, c, cmd, signal) {
      const es = w.evalState, q = w.question;
      if (!w.pending) {
        const req = Object.freeze({ ctx: callerCtx(c), topicId: w.topicId, questionId: q.questionId, prompt: q.prompt, answerKey: q.answerKey, answer: es.answer, attemptId: es.attemptId });
        const g = await race(w, "grader", () => grade.call(grader, req), signal, lim.adapterTimeoutMs);
        if (w.closed || g.kind === "cancel") return CLOSED;
        if (g.kind === "timeout") return { ok: false, code: "GRADER_TIMEOUT", attemptId: es.attemptId };
        if (g.kind === "error") return { ok: false, code: "GRADER_FAILED", attemptId: es.attemptId };
        let gr;
        try { gr = ad.readGrade(g.value); } catch (_) { return { ok: false, code: "GRADER_INVALID", attemptId: es.attemptId }; }
        if (gr.outcome === "uncertain") {
          /* 不确定：不写结果事件（尝试在投影里保持 unsettled），不算对也不算错 */
          w.uncertain++;
          w.evaluation = rec({ attemptId: es.attemptId, outcome: "uncertain" });
          w.evalState = null; w.phase = "adapt"; w.version++;
          return { ok: true, attemptId: es.attemptId };
        }
        const event = { eventId: es.attemptId + ".r", type: gr.outcome === "correct" ? "answer_correct" : "answer_wrong", topicId: w.topicId, attemptId: es.attemptId };
        if (hasOwn(gr, "mistake")) event.mistake = gr.mistake;
        /* 评分已拿到：先私下存住，写失败时重试只重写这条事件，不再问评分器，同一次尝试不会得到两个结果 */
        w.pending = makePending(cmd, { grade: gr, event: Object.freeze(event) });
        w.version++;
      }
      const wr = await write(c, w.pending.event, signal);
      if (w.closed) return CLOSED;
      if (!wr.ok) return Object.assign(wr, { attemptId: es.attemptId });
      const gr = w.pending.grade;
      if (gr.outcome === "correct") w.correct++; else w.wrong++;
      w.evaluation = rec(Object.assign({ attemptId: es.attemptId, outcome: gr.outcome }, hasOwn(gr, "mistake") ? { mistake: gr.mistake } : {}));
      w.pending = null; w.evalState = null; w.phase = "adapt"; w.version++;
      return { ok: true, attemptId: es.attemptId };
    },

    async adapt(w) {
      const d = m.decideAdapt({ outcome: w.evaluation.outcome, correct: w.correct, round: w.round, maxRounds: w.limits.maxRounds,
        targetCorrect: w.limits.targetCorrect, attempts: w.question.attempts, maxAttempts: w.limits.maxAttempts });
      w.phase = d.phase;
      if (d.phase === "teach") w.teachMode = d.teachMode;
      if (d.phase === "practice" || d.phase === "done") w.question = null;   // 丢掉题面、答案键和上次作答
      if (d.phase === "done") w.outcome = d.outcome;
      w.version++;
      return { ok: true };
    },
  };

  /* 后置条件用的状态快照（#38）：只有结构化字段，没有题面、答案键、作答或模型文字；形状见 lib/ai/verification/workflow.js */
  function snapshot(w) {
    const q = w.question, e = w.evaluation;
    return {
      phase: w.phase, teachMode: w.teachMode, plan: w.plan, round: w.round, correct: w.correct, wrong: w.wrong, uncertain: w.uncertain,
      usedCount: w.used.length, usedDistinct: new Set(w.used).size === w.used.length, lastUsed: w.used.length ? w.used[w.used.length - 1] : null,
      version: w.version, outcome: w.outcome, pending: w.pending !== null,
      question: q ? { questionId: q.questionId, attempts: q.attempts, hints: q.hints, lastAttemptId: q.lastAttemptId } : null,
      evaluation: e ? { attemptId: e.attemptId, outcome: e.outcome, mistake: hasOwn(e, "mistake") ? e.mistake : null } : null,
      evalAttemptId: w.evalState ? w.evalState.attemptId : null,
      limits: w.limits,
    };
  }

  async function execute(w, c, cmd, signal, slot, entry) {
    const from = w.phase, t0 = safeTick(0);
    const before = snapshot(w);   // 同步取：第一个 await 之前
    let out;
    try { out = await STEPS[cmd.type](w, c, cmd, signal); } catch (_) { out = { ok: false, code: "INTERNAL" }; } finally { if (w.inflight === slot) w.inflight = null; }
    const ok = out.ok === true;
    /* 后置条件（#38）：发布 / 缓存结果之前检查阶段转换、计数、题目–尝试–评分关联和结束条件。不通过就不发布这一步的结果：
     * 工作流标记 failed 并移出会话表（之后 get / send → NOT_FOUND），结果 ok:false INVARIANT_FAILED，view 的 outcome 为 null，不宣称完成。
     * 这一步里已经交给 memory 的事件不能撤销，照原样留在 Learning Events 里（见 docs/tutor-verification.md）。 */
    if (!w.closed) {
      let chk;
      try {
        chk = verifyStep(before, snapshot(w), { workflowId: w.id, command: cmd.type, ok, attemptId: hasOwn(out, "attemptId") ? out.attemptId : null,
          replyKind: ok && hasOwn(out, "reply") && out.reply ? out.reply.kind : null });
      } catch (_) { chk = { ok: false, violations: [{ category: "state" }] }; }
      if (!chk.ok) {
        w.failed = true; w.closed = true; w.pending = null;
        drop(w);
        const failed = deepFreeze({ ok: false, code: "INVARIANT_FAILED", detail: String(chk.violations[0].category).toUpperCase(), view: view(w), reply: null });
        w.question = null; w.evalState = null;
        emit({ kind: "workflow", workflowId: w.id, command: cmd.type, from, to: w.phase, ok: false, code: "INVARIANT_FAILED", at: t0, ms: Math.max(0, safeTick(t0) - t0) });
        return failed;
      }
    }
    if (!w.closed) {
      const t = safeTick(null);
      if (t !== null && Number.isSafeInteger(t + lim.ttlMs)) { w.updatedAt = t; w.expiresAt = t + lim.ttlMs; }
    }
    const result = deepFreeze({ ok, code: ok ? null : out.code, detail: hasOwn(out, "detail") ? out.detail : null, view: view(w), reply: hasOwn(out, "reply") ? out.reply : null });
    /* 成功 → 缓存结果供原样重放；失败 → 记下失败时的 version：之后只有状态没变（或它自己的 pending 还在）才能原样重发 */
    if (!w.closed) { if (ok) entry.result = result; else entry.failedVersion = w.version; }
    const tr = { kind: "workflow", workflowId: w.id, command: cmd.type, from, to: w.phase, ok, code: result.code, at: t0, ms: Math.max(0, safeTick(t0) - t0) };
    if (hasOwn(cmd, "questionId")) tr.questionId = cmd.questionId;
    else if (w.question) tr.questionId = w.question.questionId;
    if (hasOwn(out, "attemptId")) tr.attemptId = out.attemptId;
    emit(tr);
    return result;
  }

  /* ------------------------------------------------------------ 公开入口：每个都在第一个 await 之前读完 ctx、输入和时钟 */
  async function start(ctx, input) {
    const c = readCtx(ctx);
    const s = m.readStart(input);
    const t = tick(), expiresAt = deadline(t);
    purge(t);
    const startKey = c.key + "\u0000" + s.commandId, fp = JSON.stringify(s);
    const prev = flows.get(starts.get(startKey));
    if (prev) {
      if (prev.startFp !== fp) throw new WorkflowError("COMMAND_CONFLICT", "start commandId already used with different content");
      return view(prev);
    }
    if (flows.size >= lim.maxWorkflows) throw new WorkflowError("CAPACITY", `too many active workflows (${lim.maxWorkflows})`);
    let mine = 0;
    for (const x of flows.values()) if (x.key === c.key) mine++;
    if (mine >= lim.maxPerOwner) throw new WorkflowError("CAPACITY", `too many active workflows for this student (${lim.maxPerOwner})`);
    const id = "w" + crypto.randomBytes(12).toString("hex");
    const w = {
      id, key: c.key, startKey, startFp: fp, topicId: s.topicId, title: s.title, goal: s.goal, lang: s.lang,
      limits: Object.freeze({ maxRounds: s.maxRounds, targetCorrect: s.targetCorrect, maxAttempts: s.maxAttempts, maxHints: s.maxHints }),
      phase: "diagnose", teachMode: null, plan: null, round: 0, correct: 0, wrong: 0, uncertain: 0,
      question: null, used: [], evaluation: null, evalState: null, pending: null, outcome: null,
      version: 1, createdAt: t, updatedAt: t, expiresAt, commands: new Map(), inflight: null, closed: false,
    };
    flows.set(id, w);
    starts.set(startKey, id);
    emit({ kind: "workflow", workflowId: id, command: "start", from: null, to: "diagnose", ok: true, code: null, at: t, ms: 0 });
    return view(w);
  }

  async function get(ctx, workflowId) {
    const c = readCtx(ctx);
    const id = readWorkflowId(workflowId);
    return view(find(c.key, id, tick()));
  }

  /* 检查顺序：在途（双击共享 / BUSY）→ 同 commandId 内容冲突 → 已成功的原样重放 → pending 归属 → 失败命令是否过期
   * → expectedVersion → 阶段 → questionId → 上限。原样重发 pending 的原命令跳过版本 / 阶段检查：version 是被它自己的 pending 抬高的。 */
  async function send(ctx, workflowId, command) {
    const c = readCtx(ctx);
    const id = readWorkflowId(workflowId);
    const cmd = m.readCommand(command);
    const t = tick();
    deadline(t);   // 续期时间不可安全表示 → INVALID_CLOCK，在任何状态变化之前
    const w = find(c.key, id, t);
    const fp = m.fingerprint(cmd);
    if (w.inflight) {
      if (w.inflight.commandId !== cmd.commandId) throw new WorkflowError("BUSY", "another command is running on this workflow");
      if (w.inflight.fp !== fp) throw new WorkflowError("COMMAND_CONFLICT", "commandId already used with different content");
      return w.inflight.promise;   // 双击：共享同一次执行
    }
    const seen = w.commands.get(cmd.commandId);
    if (seen && seen.fp !== fp) throw new WorkflowError("COMMAND_CONFLICT", "commandId already used with different content");
    if (seen && seen.result) return seen.result;   // 已成功的命令原样重放
    const resuming = w.pending !== null && w.pending.commandId === cmd.commandId && w.pending.fp === fp;
    if (w.pending && !resuming) throw new WorkflowError("PENDING_OPERATION", `an unfinished ${w.pending.type} must be retried with its original command first`);
    if (!resuming) {
      if (seen && seen.failedVersion !== w.version) throw new WorkflowError("STALE", "this command failed earlier and the workflow has changed since");
      if (hasOwn(cmd, "expectedVersion") && cmd.expectedVersion !== w.version) throw new WorkflowError("STALE", "workflow version changed");
      if (!m.commandAllowed(w.phase, cmd.type)) throw new WorkflowError("ILLEGAL_COMMAND", `${cmd.type} is not allowed now; allowed: ${allowedNow(w).join(", ") || "none"}`);
      if (hasOwn(cmd, "questionId") && cmd.questionId !== w.question.questionId) throw new WorkflowError("STALE", "questionId is not the current question");
      if (cmd.type === "hint" && w.question.hints >= w.limits.maxHints) throw new WorkflowError("LIMIT", `at most ${w.limits.maxHints} hints per question`);
      if (!seen && w.commands.size >= lim.maxCommands) throw new WorkflowError("LIMIT", `at most ${lim.maxCommands} commands per workflow`);
    }
    const entry = seen || { fp, result: null, failedVersion: null };
    if (!seen) w.commands.set(cmd.commandId, entry);
    const slot = { commandId: cmd.commandId, fp, ac: new AbortController(), promise: null };
    w.inflight = slot;
    slot.promise = execute(w, c, cmd, slot.ac.signal, slot, entry);
    return slot.promise;
  }

  /* 随时可关、立即返回：在途命令的 TutorAgent / 适配器 / memory 读取被 abort，等待中的写入不再等（命令以 CLOSED 结束）；
   * 已经交给 memory 的那一次写入仍可能落盘。工作流从表里删除后不会被迟到的回调复活。 */
  async function close(ctx, workflowId) {
    const c = readCtx(ctx);
    const id = readWorkflowId(workflowId);
    const t = tick();
    const w = find(c.key, id, t);
    w.closed = true;
    drop(w);
    if (w.inflight) w.inflight.ac.abort();
    const v = view(w);
    w.question = null; w.evalState = null; w.pending = null;   // 私有文本随之丢弃
    emit({ kind: "workflow", workflowId: id, command: "close", from: w.phase, to: w.phase, ok: true, code: null, at: t, ms: 0 });
    return v;
  }

  return Object.freeze({ start, get, send, close });
}

module.exports = { createTutorWorkflow, WorkflowError, DEFAULTS };
