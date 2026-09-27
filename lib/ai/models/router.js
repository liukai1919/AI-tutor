/*
 * 按能力选模型的 Router（#40，#19 Phase 8）。零依赖、零网络、无 I/O。
 *
 *   const router = createModelRouter({ providers, routes, timeoutMs, onTrace, onTraceError, now });
 *   const model = router.bind("reasoning", { require: ["cheap"], timeoutMs });   // → { intent, next(req) }
 *   createTutorAgent({ registry, model, classifierModel: router.bind("fast") });  // 直接当 Harness / TutorAgent 的 model 用
 *   router.select("fast", { require, images })                                     // 只选不调：{ ok, provider, skipped } | { ok:false, code, skipped }
 *
 * provider（可信配置，构造时快照）：{ id, capabilities:[...], invoke(request, { signal, deadlineAt }), available?() }
 *   capabilities ⊆ CAPABILITIES；privacy-sensitive 必须同时声明 local。能力是配置方的声明，Router 不探测、不证明部署真的在本机。
 * routes（可信配置）：{ <intent>: [providerId, ...] }，顺序即优先级；每个 provider 必须声明该 intent 的能力，否则构造时 INVALID_CONFIG。
 *
 * 选路（每次 next 独立，无共享可变状态）：
 *   需要的能力 = {intent} ∪ require ∪（有图片 → vision）∪（privacy-sensitive → local）
 *   按 routes[intent] 顺序：能力不全 → 跳过；available() 不是同步返回 true → 跳过；第一个通过的调用一次。
 *   没有该 intent 的路由 → NO_ROUTE；全被跳过 → NO_PROVIDER。硬约束只靠能力过滤，所以永远不会退到没声明 local 的 provider。
 * 调用后：provider 失败 → PROVIDER_ERROR，输出不是有界纯 JSON → BAD_OUTPUT；都**不**换下一个 provider 重试（避免重复花钱）。
 *   Harness 的 modelRetries 会再调 next，那是一次全新的选路（同顺序、同过滤），由 Harness 负责。
 * 取消 / 超时：调用前 signal 已 abort → CANCELLED（不选路不调用）；等待中 abort → CANCELLED；超过 timeoutMs → TIMEOUT。
 *   选路期间每次调 available() 之前、以及调用 provider 之前都再查一次取消 / 截止时间（available 本身可能 abort 或占掉预算）。
 *   两种情况都 abort 交给 provider 的 signal；provider 迟到的结果不采用，只发一条 route-late trace，拒绝被接住。
 *   注入的时钟 now() 抛错 / 返回非有限数 → INTERNAL（调用前发现就不调用），永远结算，不留挂起的 promise、不漏未处理异常。
 *   Router 不能替 provider 停掉已经发出的请求：没理会 signal 的 provider（例如 legacy runEngine）会继续跑、继续花钱。
 * 错误：RouterError { code, intent, provider? }，message 是固定文案。Router 从不读取 provider 抛出的错误对象
 *   （不回显原文 / 密钥，撤销的 Proxy、抛错的 getter 也卡不住它）。
 * trace：冻结的 { kind: route|route-late, intent, provider, ok, code?, skipped, ms, at }，没有提示词、消息、错误原文。
 */
"use strict";
const { snapshotJson } = require("./snapshot.js");

const INTENTS = Object.freeze(["fast", "reasoning", "vision", "cheap", "local", "privacy-sensitive"]);
const CAPABILITIES = INTENTS;
const ROUTER_CODES = Object.freeze(["INVALID_CONFIG", "INVALID_REQUEST", "NO_ROUTE", "NO_PROVIDER", "CANCELLED", "TIMEOUT", "PROVIDER_ERROR", "BAD_OUTPUT", "INTERNAL"]);
const MESSAGE_ROLES = Object.freeze(["user", "assistant", "tool", "harness"]);
const REQUEST_KEYS = Object.freeze(["system", "messages", "tools", "step", "signal", "images"]);
const IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg"]);
const LIMITS = Object.freeze({ maxSystem: 200000, maxImageChars: 10000000, maxProviders: 32, maxRoute: 16, maxTimeoutMs: 3600000 });
const DEFAULT_TIMEOUT_MS = 300000;
const ID_RE = /^[a-z][a-z0-9._-]{0,47}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const TEXT = {
  INVALID_REQUEST: "model request is not supported",
  NO_ROUTE: "no route is configured for this intent",
  NO_PROVIDER: "no configured provider is available for this intent",
  CANCELLED: "model call cancelled",
  TIMEOUT: "model call timed out",
  PROVIDER_ERROR: "model provider failed",
  BAD_OUTPUT: "model provider returned an unsupported value",
  INTERNAL: "model router failed",
};

class RouterError extends Error {
  constructor(code, message, extra) {
    super(message || TEXT[code] || code);
    this.name = "RouterError";
    this.code = code;
    if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) this[k] = extra[k];
  }
}
/* 只有本模块自己造的配置错误才原样抛出：调用方的 Proxy 陷阱抛出的 RouterError（哪怕消息里夹着密钥）也会被换成固定文案。
 * 用 WeakSet 判定，不对外来异常做 instanceof / 读属性（撤销的 Proxy 会让那些操作再抛） */
const OWN = new WeakSet();
const configError = msg => { const e = new RouterError("INVALID_CONFIG", "model router config: " + msg); OWN.add(e); return e; };
const isOwn = e => { try { return OWN.has(e); } catch (_) { return false; } };
/* AbortSignal 只认真的：拒绝 Proxy（Node 的 getter 会穿过 Proxy 读内部符号），用原型上的 getter / 方法而不是实例上的属性。
 * 每次读取、挂 / 摘监听都包 try：出错按「已取消」处理（fail closed），不会从计时器或回调里抛出去 */
const { isProxy } = require("node:util").types;
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD = EventTarget.prototype.addEventListener, REMOVE = EventTarget.prototype.removeEventListener;
function isSignal(s) {
  try { return !isProxy(s) && typeof Reflect.apply(ABORTED, s, []) === "boolean"; } catch (_) { return false; }
}
function isAborted(s) { try { return Reflect.apply(ABORTED, s, []) !== false; } catch (_) { return true; } }
function listen(s, fn) { try { Reflect.apply(ADD, s, ["abort", fn, { once: true }]); return true; } catch (_) { return false; } }
function unlisten(s, fn) { try { Reflect.apply(REMOVE, s, ["abort", fn]); } catch (_) { } }

/* 只读自有数据属性；getter、继承字段、多余键 → 抛 INVALID_CONFIG。Proxy 陷阱抛错由调用方统一收口 */
function ownData(obj, allowed, what) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw configError(`${what} must be a plain object`);
  const proto = Reflect.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) throw configError(`${what} must be a plain object`);
  const out = Object.create(null);
  for (const k of Reflect.ownKeys(obj)) {
    if (typeof k !== "string" || !allowed.includes(k)) throw configError(`${what} has an unsupported field`);
    const d = Reflect.getOwnPropertyDescriptor(obj, k);
    if (!d || !("value" in d)) throw configError(`${what}.${k} must be a data property`);
    out[k] = d.value;
  }
  return out;
}
/* 真数组、无空位、只按下标读一次 */
function ownArray(arr, max, what, min) {
  min = min === undefined ? 1 : min;
  if (!Array.isArray(arr) || Reflect.getPrototypeOf(arr) !== Array.prototype) throw configError(`${what} must be an array`);
  const lenD = Reflect.getOwnPropertyDescriptor(arr, "length");
  const len = lenD && lenD.value;
  if (!Number.isInteger(len) || len < min || len > max) throw configError(`${what} must have ${min}-${max} items`);
  if (Reflect.ownKeys(arr).length !== len + 1) throw configError(`${what} must be a plain array`);   // 下标 + length，多出来的是自定义属性 / Symbol
  const out = [];
  for (let i = 0; i < len; i++) {
    const d = Reflect.getOwnPropertyDescriptor(arr, String(i));
    if (!d || !("value" in d) || !d.enumerable) throw configError(`${what} must be a plain array`);
    out.push(d.value);
  }
  return out;
}
function readTimeout(v, what) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > LIMITS.maxTimeoutMs) throw configError(`${what} must be a number of ms in (0, ${LIMITS.maxTimeoutMs}]`);
  return v;
}
function readCaps(v, what, allowEmpty) {
  if (v === undefined && allowEmpty) return [];
  const caps = ownArray(v, CAPABILITIES.length, what, allowEmpty ? 0 : 1);   // 空数组也走同一个严格读取（原型、自定义属性照查）
  for (const c of caps) if (typeof c !== "string" || !CAPABILITIES.includes(c)) throw configError(`${what} has an unknown capability`);
  if (new Set(caps).size !== caps.length) throw configError(`${what} has duplicates`);
  return caps;
}

function readProvider(raw, i) {
  const p = ownData(raw, ["id", "capabilities", "invoke", "available"], `providers[${i}]`);
  if (typeof p.id !== "string" || !ID_RE.test(p.id)) throw configError(`providers[${i}].id must match ${ID_RE}`);
  const caps = readCaps(p.capabilities, `provider ${p.id} capabilities`, false);
  if (caps.includes("privacy-sensitive") && !caps.includes("local")) throw configError(`provider ${p.id} declares privacy-sensitive without local`);
  if (typeof p.invoke !== "function") throw configError(`provider ${p.id} needs invoke(request, options)`);
  if (p.available !== undefined && typeof p.available !== "function") throw configError(`provider ${p.id} available must be a function`);
  return Object.freeze({ id: p.id, caps: Object.freeze(new Set(caps)), capabilities: Object.freeze(caps.slice()), invoke: p.invoke, available: p.available || null });
}

function readConfig(opts) {
  const o = ownData(opts, ["providers", "routes", "timeoutMs", "onTrace", "onTraceError", "now"], "options");
  const providers = new Map();
  ownArray(o.providers, LIMITS.maxProviders, "providers").forEach((raw, i) => {
    const p = readProvider(raw, i);
    if (providers.has(p.id)) throw configError(`provider id ${p.id} is used twice`);
    providers.set(p.id, p);
  });
  const routes = new Map();
  const r = ownData(o.routes, INTENTS, "routes");
  for (const intent of INTENTS) {
    if (!(intent in r)) continue;
    const ids = ownArray(r[intent], LIMITS.maxRoute, `routes.${intent}`);
    for (const id of ids) {
      if (typeof id !== "string" || !providers.has(id)) throw configError(`routes.${intent} names an unregistered provider`);
      const need = intent === "privacy-sensitive" ? ["privacy-sensitive", "local"] : [intent];
      for (const c of need) if (!providers.get(id).caps.has(c)) throw configError(`routes.${intent}: provider ${id} does not declare ${c}`);
    }
    if (new Set(ids).size !== ids.length) throw configError(`routes.${intent} has duplicates`);
    routes.set(intent, Object.freeze(ids));
  }
  for (const k of ["onTrace", "onTraceError", "now"]) if (o[k] !== undefined && typeof o[k] !== "function") throw configError(`${k} must be a function`);
  return {
    providers, routes,
    timeoutMs: o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : readTimeout(o.timeoutMs, "timeoutMs"),
    onTrace: o.onTrace || (() => {}),
    onTraceError: o.onTraceError || ((e, t) => console.warn(`[model-router] trace callback failed kind=${t.kind} intent=${t.intent}`)),
    now: o.now || Date.now,
  };
}

/* ---------------- 请求快照（next 里同步完成） ---------------- */
const BAD = reason => ({ ok: false, reason });
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function readImages(v) {
  if (v === undefined) return { ok: true, value: Object.freeze([]) };
  if (!Array.isArray(v) || Reflect.getPrototypeOf(v) !== Array.prototype) return BAD("images");
  const lenD = Reflect.getOwnPropertyDescriptor(v, "length");
  if (!lenD || !Number.isInteger(lenD.value) || lenD.value > 1 || Reflect.ownKeys(v).length !== lenD.value + 1) return BAD("images");
  const out = [];
  for (let i = 0; i < lenD.value; i++) {
    const d = Reflect.getOwnPropertyDescriptor(v, String(i));
    if (!d || !("value" in d) || !d.enumerable) return BAD("images");
    let img;
    try { img = ownData(d.value, ["mediaType", "data"], "image"); } catch (_) { return BAD("images"); }
    if (!IMAGE_TYPES.includes(img.mediaType)) return BAD("images");
    if (typeof img.data !== "string" || !img.data || img.data.length > LIMITS.maxImageChars || img.data.length % 4 !== 0 || !B64_RE.test(img.data)) return BAD("images");
    out.push(Object.freeze({ mediaType: img.mediaType, data: img.data }));
  }
  return { ok: true, value: Object.freeze(out) };
}
function readRequest(req) {
  let r;
  try { r = ownData(req, REQUEST_KEYS, "request"); } catch (_) { return BAD("shape"); }
  const system = r.system === undefined ? "" : r.system;
  if (typeof system !== "string" || system.length > LIMITS.maxSystem) return BAD("system");
  const m = snapshotJson(r.messages);
  if (!m.ok || !Array.isArray(m.value)) return BAD("messages");
  /* 契约字段只认自有属性：Object.prototype.role / name 被污染时，{} 不能冒充消息 / 工具定义 */
  for (const msg of m.value) if (msg === null || typeof msg !== "object" || Array.isArray(msg) || !hasOwn(msg, "role") || !MESSAGE_ROLES.includes(msg.role)) return BAD("messages");
  const t = snapshotJson(r.tools === undefined ? [] : r.tools);
  if (!t.ok || !Array.isArray(t.value)) return BAD("tools");
  for (const d of t.value) if (d === null || typeof d !== "object" || Array.isArray(d) || !hasOwn(d, "name") || typeof d.name !== "string" || !d.name) return BAD("tools");
  if (r.step !== undefined && !(Number.isInteger(r.step) && r.step >= 0)) return BAD("step");
  if (r.signal !== undefined && !isSignal(r.signal)) return BAD("signal");
  const images = readImages(r.images);
  if (!images.ok) return images;
  return { ok: true, system, messages: m.value, tools: t.value, step: r.step === undefined ? null : r.step, signal: r.signal, images: images.value };
}

function createModelRouter(opts) {
  let cfg;
  try { cfg = readConfig(opts); }
  catch (e) { throw isOwn(e) ? e : configError("could not be read"); }   // 撤销的 Proxy / 陷阱抛错：不透传外部异常
  const { providers, routes, now, onTrace, onTraceError } = cfg;

  function emit(t) {
    Object.freeze(t);
    const swallow = e => { try { const p = onTraceError(e, t); if (p && typeof p.then === "function") p.then(null, () => {}); } catch (_) { } };
    try { const p = onTrace(t); if (p && typeof p.then === "function") p.then(null, swallow); } catch (e) { swallow(e); }
  }

  function readBind(intent, o) {
    if (typeof intent !== "string" || !INTENTS.includes(intent)) throw configError("unknown intent");
    const b = o === undefined ? {} : ownData(o, ["require", "timeoutMs"], "bind options");
    const req = readCaps(b.require, "bind require", true);
    return { intent, require: Object.freeze(req), timeoutMs: b.timeoutMs === undefined ? cfg.timeoutMs : readTimeout(b.timeoutMs, "bind timeoutMs") };
  }
  const safeBindRead = (intent, o) => { try { return readBind(intent, o); } catch (e) { throw isOwn(e) ? e : configError("bind options could not be read"); } };

  /* 时钟读数：抛错 / 非有限数一律 NaN，调用方按 INTERNAL 处理，不回显异常 */
  function tick() {
    let v;
    try { v = now(); } catch (_) { return NaN; }
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  }

  /* 能力过滤 + 可用性，按路由顺序；返回 { ok, provider, skipped } 或 { ok:false, code, skipped }。
   * halt() 在每次调 available() 之前查取消 / 截止时间 / 时钟：available 可能 abort 或拖过时限，之后一个都不再调 */
  function choose(intent, extra, hasImage, halt) {
    const ids = routes.get(intent);
    if (!ids) return { ok: false, code: "NO_ROUTE", skipped: Object.freeze([]) };
    const need = new Set([intent, ...extra]);
    if (hasImage) need.add("vision");
    if (need.has("privacy-sensitive")) need.add("local");
    const skipped = [];
    for (const id of ids) {
      const p = providers.get(id);
      let ok = true;
      for (const c of need) if (!p.caps.has(c)) { ok = false; break; }
      if (ok && p.available) {
        const h = halt();
        if (h) return { ok: false, code: h, skipped: Object.freeze(skipped) };
        let v = false;
        try {
          v = Reflect.apply(p.available, undefined, []);
          /* 只认同步 true；返回 promise 的丢弃结果并接住拒绝 */
          if (v !== true && v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function") v.then(null, () => {});
        } catch (_) { v = false; }
        ok = v === true;
      }
      if (ok) return { ok: true, provider: p, skipped: Object.freeze(skipped) };
      skipped.push(id);
    }
    return { ok: false, code: "NO_PROVIDER", skipped: Object.freeze(skipped) };
  }

  function select(intent, o) {
    let b, hasImage = false;
    try {
      const x = o === undefined ? {} : ownData(o, ["require", "images"], "select options");
      b = readBind(intent, x.require === undefined ? undefined : { require: x.require });
      if (x.images !== undefined) { const im = readImages(x.images); if (!im.ok) throw configError("select images are not supported"); hasImage = im.value.length > 0; }
    } catch (e) { throw isOwn(e) ? e : configError("select options could not be read"); }
    const c = choose(b.intent, b.require, hasImage, () => null);
    return Object.freeze(c.ok ? { ok: true, provider: c.provider.id, skipped: c.skipped } : { ok: false, code: c.code, skipped: c.skipped });
  }

  function bind(intent, o) {
    const b = safeBindRead(intent, o);
    function next(req) {
      const t0 = tick();
      const at = Number.isFinite(t0) ? t0 : null;
      const elapsed = () => { const t = tick(); return at !== null && Number.isFinite(t) ? Math.max(0, t - at) : null; };   // 时钟坏了 trace 里是 null
      const trace = (provider, ok, code, skipped) => emit(Object.assign({ kind: "route", intent: b.intent, provider, ok }, code ? { code } : {}, { skipped: skipped || Object.freeze([]), ms: elapsed(), at }));
      const reject = (code, skipped) => { const e = new RouterError(code, null, { intent: b.intent }); trace(null, false, code, skipped); return Promise.reject(e); };

      let r;
      try { r = readRequest(req); } catch (_) { r = BAD("shape"); }
      if (!r.ok) return reject("INVALID_REQUEST");
      if (at === null) return reject("INTERNAL");
      const signal = r.signal;
      const deadlineAt = at + b.timeoutMs;
      /* 取消 / 时钟 / 截止时间：任何一步之前都可以再查，返回停止码或 null */
      const halt = () => {
        if (signal && isAborted(signal)) return "CANCELLED";
        const t = tick();
        if (!Number.isFinite(t)) return "INTERNAL";
        return t >= deadlineAt ? "TIMEOUT" : null;
      };
      const h0 = halt();
      if (h0) return reject(h0);
      const c = choose(b.intent, b.require, r.images.length > 0, halt);
      if (!c.ok && c.code !== "NO_PROVIDER") return reject(c.code, c.skipped);
      /* available() 可能刚 abort 或拖过了时限：调用 provider 之前最后查一次，不产生付费调用。
       * 选不出 provider 时也先查：最后一个 available() 取消 / 耗尽时限再返回 false，报 CANCELLED / TIMEOUT，而不是 NO_PROVIDER */
      const h1 = halt();
      if (h1) return reject(h1, c.skipped);
      if (!c.ok) return reject(c.code, c.skipped);
      const p = c.provider;
      const request = Object.freeze({ intent: b.intent, system: r.system, messages: r.messages, tools: r.tools, step: r.step, images: r.images });
      const ac = new AbortController();

      return new Promise((resolve, rejectP) => {
        let done = false, timer = null;
        const onAbort = () => finish("CANCELLED");
        /* 先结算 promise，再做 abort / trace（它们都不会抛，也不会让结算落空） */
        function finish(code, value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (signal) unlisten(signal, onAbort);
          if (code) rejectP(new RouterError(code, null, { intent: b.intent, provider: p.id }));
          else resolve(value);
          if (code) { try { ac.abort(); } catch (_) { } }
          trace(p.id, !code, code, c.skipped);
        }
        const late = ok => emit({ kind: "route-late", intent: b.intent, provider: p.id, ok, ms: elapsed(), at });
        const arrive = (ok, v) => {
          if (done) return late(ok);
          const h = halt();
          if (h) { finish(h); return late(ok); }
          if (!ok) return finish("PROVIDER_ERROR");
          const s = snapshotJson(v);
          return s.ok ? finish(null, s.value) : finish("BAD_OUTPUT");
        };
        const guarded = (ok, v) => { try { arrive(ok, v); } catch (_) { finish("INTERNAL"); } };
        let pr;
        try { pr = Promise.resolve(Reflect.apply(p.invoke, undefined, [request, Object.freeze({ signal: ac.signal, deadlineAt })])); }
        catch (_) { pr = Promise.reject(new Error("sync throw")); }   // 同步抛错也算「已调用后失败」，不换 provider
        pr.then(v => guarded(true, v), () => guarded(false));
        if (done) return;
        /* invoke 可能同步阻塞：返回之后再查一次取消 / 时限 / 时钟 */
        const h2 = halt();
        if (h2) return finish(h2);
        const left = deadlineAt - tick();
        if (!(left > 0)) return finish(Number.isFinite(left) ? "TIMEOUT" : "INTERNAL");
        if (signal && !listen(signal, onAbort)) return finish("CANCELLED");
        timer = setTimeout(() => finish("TIMEOUT"), left);
      });
    }
    /* next 永远返回 promise，不同步抛错（兜底：理论上走不到） */
    const safeNext = req => { try { return next(req); } catch (_) { return Promise.reject(new RouterError("INVALID_REQUEST", null, { intent: b.intent })); } };
    return Object.freeze({ intent: b.intent, require: b.require, next: safeNext });
  }

  const providerList = Object.freeze([...providers.values()].map(p => Object.freeze({ id: p.id, capabilities: p.capabilities })));
  const routeView = Object.freeze(Object.fromEntries([...routes.entries()]));
  return Object.freeze({ bind, select, providers: providerList, routes: routeView });
}

module.exports = { createModelRouter, RouterError, INTENTS, CAPABILITIES, ROUTER_CODES, LIMITS, DEFAULT_TIMEOUT_MS };
