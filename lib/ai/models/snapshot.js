/*
 * 有界 JSON 快照（#40，#19 Phase 8）。零依赖、无 I/O。router 用它同步复制模型请求 / 配置里的 JSON 片段和 provider 的输出。
 *
 *   snapshotJson(value, limits?) → { ok:true, value }（深冻结的副本） | { ok:false, reason }
 *
 * 只认纯 JSON 值：null / 布尔 / 有限数字 / 字符串 / 真数组（无空位）/ 纯对象（原型是 Object.prototype 或 null）。
 * 对象只读自有、可枚举、字符串键的数据属性：getter 不执行（直接拒绝）、Symbol 键 / 不可枚举属性 / 类实例 / 函数 / BigInt / undefined / 环都拒绝。
 * "__proto__" 这类键按普通数据复制成自有属性（defineProperty），不会改副本的原型。
 * 上限（limits 可逐项覆盖）：深度、节点数、单个字符串长度、总字符数（字符串 + 键）。先到哪个上限就停，不会为病态输入走完整棵树。
 * 读取中的任何异常（撤销的 Proxy、陷阱抛错）都只变成 reason:"unreadable"；reason 是固定短码，不含输入内容。
 */
"use strict";

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 20000, maxString: 100000, maxTotalChars: 2000000 });
const REASONS = Object.freeze(["depth", "nodes", "string", "size", "type", "number", "cycle", "accessor", "key", "sparse", "unreadable"]);

const FAIL = Object.freeze({});   // 模块私有的哨兵：catch 里只做 === 比较，不对外来异常做 instanceof / 读属性（撤销的 Proxy 会让那些操作再抛）

function readLimits(limits) {
  if (limits === undefined) return DEFAULT_LIMITS;
  const out = {};
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const d = Object.prototype.hasOwnProperty.call(limits, k) ? Object.getOwnPropertyDescriptor(limits, k) : null;
    const v = d ? d.value : DEFAULT_LIMITS[k];
    if (!Number.isInteger(v) || v < 1) throw new TypeError(`snapshot: limits.${k} must be a positive integer`);
    out[k] = v;
  }
  return Object.freeze(out);
}

function snapshotJson(value, limits) {
  const L = readLimits(limits);
  let nodes = 0, chars = 0;
  const stack = new Set();
  let reason = "unreadable";
  const fail = r => { reason = r; throw FAIL; };
  const str = s => {
    if (s.length > L.maxString) fail("string");
    chars += s.length;
    if (chars > L.maxTotalChars) fail("size");
    return s;
  };
  function walk(x, depth) {
    if (++nodes > L.maxNodes) fail("nodes");
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "number") return Number.isFinite(x) ? x : fail("number");
    if (typeof x === "string") return str(x);
    if (typeof x !== "object") return fail("type");
    if (depth >= L.maxDepth) fail("depth");
    if (stack.has(x)) fail("cycle");
    const isArr = Array.isArray(x);
    const proto = Reflect.getPrototypeOf(x);
    if (!isArr && proto !== Object.prototype && proto !== null) fail("type");
    if (isArr && proto !== Array.prototype) fail("type");
    stack.add(x);
    let out;
    if (isArr) {
      const lenD = Reflect.getOwnPropertyDescriptor(x, "length");
      const len = lenD && lenD.value;
      if (!Number.isInteger(len) || len < 0) fail("type");
      if (len > L.maxNodes - nodes) fail("nodes");
      const keys = Reflect.ownKeys(x);
      if (keys.length !== len + 1) fail(keys.length < len + 1 ? "sparse" : "key");   // 下标 + length，多出来的是自定义属性 / Symbol
      out = new Array(len);
      for (let i = 0; i < len; i++) {
        const d = Reflect.getOwnPropertyDescriptor(x, String(i));
        if (!d) fail("sparse");
        if (!("value" in d)) fail("accessor");
        if (!d.enumerable) fail("key");   // 不可枚举的下标：JSON.stringify 会照样输出，但不是「普通数据」，与对象属性同一规则
        out[i] = walk(d.value, depth + 1);
      }
    } else {
      out = {};
      const keys = Reflect.ownKeys(x);
      if (keys.length > L.maxNodes - nodes) fail("nodes");
      for (const k of keys) {
        if (typeof k !== "string") fail("key");
        const d = Reflect.getOwnPropertyDescriptor(x, k);
        if (!d) fail("unreadable");
        if (!("value" in d)) fail("accessor");
        if (!d.enumerable) fail("key");
        str(k);
        Object.defineProperty(out, k, { value: walk(d.value, depth + 1), enumerable: true, writable: false, configurable: false });
      }
    }
    stack.delete(x);
    return Object.freeze(out);
  }
  try { return { ok: true, value: walk(value, 0) }; }
  catch (e) { return { ok: false, reason: e === FAIL ? reason : "unreadable" }; }
}

module.exports = { snapshotJson, DEFAULT_LIMITS, REASONS };
