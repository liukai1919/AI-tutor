/*
 * TutorAgent 的 HTTP 接缝（#53，#19 Phase 9a）：server.js 的 POST /api/tutor/ask 只做「开关 / 鉴权 / 读 body / ctx」，
 * 其余（选引擎、按引擎 × 语言懒建 agent、限速、在途互斥、回包白名单）都在这里，便于不起服务器单测。
 *
 *   const svc = createTutorService({
 *     registry,                         // lib/ai/tools 的 registry（TutorAgent 自己只挑两个只读工具）
 *     runEngine, pickProvider,          // lib/ai/models create(deps) 的同名函数，原样注入
 *     isAvailable: engine => bool,      // 桥在调用前问一次（detected[engine].available）
 *     settings: () => cfg.tutorAgent,   // 每次 ask 现读：{ perMinute, stepTimeoutMs, totalTimeoutMs }
 *     now, log,
 *   });
 *   const { status, body } = await svc.ask(ctx, reqBody, { signal });
 *
 * 模型接入走 Phase 8：每个 (engine, stepTimeoutMs, totalTimeoutMs, lang) 一对 createLegacyProvider（账本任务名 tutor / tutor:classify）+ 一个 createModelRouter，
 * TutorAgent 的作答绑 reasoning、分类绑 fast。引擎由 pickProvider(null, "tutor") 选：家长可以在 providerByTask.tutor 指定，
 * 否则按全局 provider / 自动顺序。这里不探测引擎、不读配置文件、不碰孩子数据。
 *
 * 限制（诚实版）：
 * - runEngine 不收 signal：客户端断开 / 超时后 ask 立即收口，但底层 CLI 进程或 HTTP 请求会跑到自己的超时，照样记账。
 *   在途互斥在 ask 收口时就释放，所以断开后马上重问可能让两次引擎调用同时在跑；每分钟限额是这里唯一的花费上界。
 * - 限速与在途表都在进程内存，重启清零，多实例不共享。
 * - mode 可以由调用方用 io.forceMode 强制（#55：家庭设置「孩子只给提示」时路由对学生传 "hint"）；strategy 仍由请求方选。
 */
"use strict";
const { createTutorAgent } = require("./index.js");
const { createModelRouter, createLegacyProvider, LEGACY_ENGINES } = require("../models/index.js");
const { selectTutorSkills } = require("../skills/index.js");

const WINDOW_MS = 60000;
const DEFAULTS = Object.freeze({ perMinute: 6, stepTimeoutMs: 120000, totalTimeoutMs: 300000 });
const LIMITS = Object.freeze({ perMinute: [1, 120], stepTimeoutMs: [1000, 600000], totalTimeoutMs: [1000, 1800000] });
const BODY_KEYS = ["question", "lang", "mode", "strategy", "kid"];

const MSG = {
  badBody: { error: "请求格式不对 / Malformed request", code: "INVALID_INPUT" },
  rate: { error: "问得太快啦，歇一分钟再问 / Too many questions — wait a minute", code: "RATE_LIMITED", rateLimited: true },
  busy: { error: "上一个问题还在想，等它答完再问 / Still working on your last question", code: "BUSY", busy: true },
  noEngine: { error: "没有可用的 AI 引擎，请家长在设置里检查 / No AI engine available — ask a parent to check settings", code: "NO_ENGINE", noEngine: true },
};

/* 配置值不合规就用默认（不抛）：config.json 是人手写的，写错一个数不该让整个路由 500 */
function readSettings(raw) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = raw && typeof raw === "object" ? raw[k] : undefined;
    const [lo, hi] = LIMITS[k];
    out[k] = Number.isSafeInteger(v) && v >= lo && v <= hi ? v : DEFAULTS[k];
  }
  if (out.stepTimeoutMs > out.totalTimeoutMs) out.stepTimeoutMs = out.totalTimeoutMs;
  return out;
}

/* body 只认列出的字段、类型对的才往下传；内容本身（长度、mode / strategy 取值）由 TutorAgent 校验，这里不重复 */
function readBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const k of Object.keys(body)) if (!BODY_KEYS.includes(k)) return null;
  if (typeof body.question !== "string") return null;
  for (const k of ["lang", "mode", "strategy", "kid"]) if (body[k] != null && typeof body[k] !== "string") return null;
  if (body.lang != null && body.lang !== "zh" && body.lang !== "en") return null;
  const req = { question: body.question, lang: body.lang === "en" ? "en" : "zh" };
  if (body.mode != null) req.mode = body.mode;
  if (body.strategy != null) req.strategy = body.strategy;
  return req;
}

/* 实际输出模式：give-hint / socratic-teaching 和 mode:hint 都强制提示（与 TutorAgent 同一张选择表）；选不出来（非法 strategy）按请求的 */
function effectiveMode(req) {
  try { return selectTutorSkills({ strategy: req.strategy, mode: req.mode || "answer" }).mode; }
  catch (_) { return req.mode || "answer"; }
}

/* 回包白名单：孩子只看到 kind + 正文（拒答 / 安全 / 出错是 TutorAgent 的固定模板）；checks、工具调用、步数、门控细节、verification 都不给 */
function shape(r, lang) {
  const out = { kind: r.kind, text: r.text, lang };
  if (r.strategy) out.strategy = r.strategy;
  if (r.kind === "error") out.code = (r.error && r.error.code) || "INTERNAL";
  return out;
}

/* 一个引擎、一种语言的 TutorAgent：作答绑 reasoning、分类绑 fast，都走旧引擎桥（账本任务名 tutor / tutor:classify）。
 * service 按 (引擎, 时限, 语言) 缓存它；tools/eval_tutor_live.mjs（#65）用同一个函数，评的就是线上这条路。
 * settings 要已经过 readSettings；available 在每次调用前问一次，可省（= 总是可用） */
function createEngineAgent({ registry, runEngine, engine, lang, settings: s, available, onTrace }) {
  const tutorP = createLegacyProvider({ id: "legacy-" + engine, capabilities: ["reasoning"], runEngine, engine, task: "tutor", lang, available });
  const classP = createLegacyProvider({ id: "legacy-" + engine + "-classify", capabilities: ["fast"], runEngine, engine, task: "tutor:classify", lang, available });
  /* 单步时限只让 Harness 管（stepTimeoutMs）：Router 的时限要是和它一样长，Router 的 TIMEOUT 先到时 Harness 会当模型失败重试，
   * 多出一次取消不了的引擎调用。Router 只兜总时限 */
  const router = createModelRouter({ providers: [tutorP, classP], routes: { reasoning: [tutorP.id], fast: [classP.id] }, timeoutMs: s.totalTimeoutMs });
  return createTutorAgent({
    registry, model: router.bind("reasoning"), classifierModel: router.bind("fast"),
    stepTimeoutMs: s.stepTimeoutMs, totalTimeoutMs: s.totalTimeoutMs, onTrace,
  });
}

function createTutorService(opts) {
  opts = opts || {};
  for (const k of ["registry", "runEngine", "pickProvider", "isAvailable", "settings"]) if (!opts[k]) throw new TypeError("tutor service: " + k + " is required");
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const agents = new Map();   // `${engine}|${settingsKey}|${lang}` → agent
  const hits = new Map();     // userId → [ts...]（窗口内）
  const inflight = new Set(); // userId

  function agentFor(engine, lang, s) {
    const key = [engine, s.stepTimeoutMs, s.totalTimeoutMs, lang].join("|");
    let a = agents.get(key);
    if (a) return a;
    a = createEngineAgent({ registry: opts.registry, runEngine: opts.runEngine, engine, lang, settings: s,
      available: () => !!opts.isAvailable(engine),
      /* trace 里本来就没有问题原文；这里只留最后一条的去向，方便看日志 */
      onTrace: t => { if (t && t.kind === "tutor") log(`[tutor] ${engine} ${lang} ${t.outcome}${t.code ? " " + t.code : ""} (${t.stage}${t.label ? "/" + t.label : ""})`); },
    });
    agents.set(key, a);
    return a;
  }

  function rateHit(userId, limit) {
    const t = now();
    const list = (hits.get(userId) || []).filter(x => t - x < WINDOW_MS);
    if (list.length >= limit) { hits.set(userId, list); return false; }
    list.push(t);
    hits.set(userId, list);
    /* 顺手清掉窗口外没人再问的 key，免得表只增不减 */
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.some(x => t - x < WINDOW_MS)) hits.delete(k);
    return true;
  }

  async function ask(ctx, body, io) {
    const req = readBody(body);
    if (!req) return { status: 400, body: MSG.badBody };
    const s = readSettings(opts.settings());
    const who = String(ctx && ctx.userId);
    if (inflight.has(who)) return { status: 429, body: MSG.busy };
    if (!rateHit(who, s.perMinute)) return { status: 429, body: MSG.rate };
    const engine = opts.pickProvider(null, "tutor");
    if (!engine || !LEGACY_ENGINES.includes(engine)) return { status: 503, body: MSG.noEngine };
    /* io.forceMode（#55）：可信调用方按家庭设置强制的模式（孩子 → "hint"）；请求里写什么都盖掉 */
    if (io && io.forceMode) req.mode = io.forceMode;
    inflight.add(who);
    try {
      const r = await agentFor(engine, req.lang, s).ask(ctx, Object.assign({}, req, io && io.signal ? { signal: io.signal } : {}));
      const inputErr = r.kind === "error" && r.error && (r.error.code === "INVALID_INPUT" || r.error.code === "INVALID_CTX");
      /* asked：这次实际交给 TutorAgent 的问题和模式，给路由写对话记录用（不进回包） */
      return { status: inputErr ? 400 : 200, body: shape(r, req.lang), asked: { question: req.question, mode: effectiveMode(req) } };
    } finally { inflight.delete(who); }
  }

  /* 工作流（#61）用的窄接口：同一套选引擎和 agent 缓存；不限速、不互斥（工作流一次只跑一个命令，限速在 lib/ai/workflows/service.js）。
   * req 原样交给 TutorAgent（工作流给的 question / lang / mode / strategy / verify / signal）。
   * 没有引擎 → TutorAgent 形状的 error 结果（工作流收成 TUTOR_ERROR）；调用方应先用 engineReady() 挡掉 */
  function engineReady() {
    const engine = opts.pickProvider(null, "tutor");
    return !!engine && LEGACY_ENGINES.includes(engine);
  }
  async function agentAsk(ctx, req) {
    const engine = opts.pickProvider(null, "tutor");
    if (!engine || !LEGACY_ENGINES.includes(engine)) return { ok: false, kind: "error", text: "", error: { code: "NO_ENGINE" } };
    return agentFor(engine, req && req.lang === "en" ? "en" : "zh", readSettings(opts.settings())).ask(ctx, req);
  }

  return Object.freeze({ ask, agentAsk, engineReady });
}

module.exports = { createTutorService, createEngineAgent, readSettings, TUTOR_SERVICE_DEFAULTS: DEFAULTS };
