/*
 * Tutor Memory 的错误约定和「读外部对象」小工具（#34，#19 Phase 5）。
 * 所有公开入口失败都抛 / reject MemoryError(code, message)；message 只提字段名，不回显调用方文本。
 */
"use strict";

class MemoryError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/* 把调用方给的对象读成我们自己的 null 原型记录：只认纯对象（原型是 Object.prototype 或 null），
 * 自有键只能是 allowed 里的字符串，且必须是可枚举的数据属性（getter 不执行）。多余键、Symbol、数组、类实例、
 * 原型上的字段都失败；读的过程中的任何异常（撤销的 Proxy、陷阱抛错，包括伪造的 MemoryError）都收成 code。
 * 每个字段只读一次，之后调用方改原对象不影响结果。 */
function readRecord(value, allowed, code, what) {
  const bad = () => new MemoryError(code, `${what} must be a plain object with only: ${allowed.join(", ")}`);
  const read = fn => { try { return fn(); } catch (_) { throw bad(); } };
  if (value === null || typeof value !== "object") throw bad();
  const proto = read(() => Object.getPrototypeOf(value));
  if (proto !== Object.prototype && proto !== null) throw bad();
  const out = Object.create(null);
  for (const k of read(() => Reflect.ownKeys(value))) {
    if (typeof k !== "string" || !allowed.includes(k)) throw bad();
    const d = read(() => Reflect.getOwnPropertyDescriptor(value, k));
    if (!d || !("value" in d) || !d.enumerable) throw bad();
    out[k] = d.value;
  }
  return out;
}

/* 把外部数组读成我们自己的普通数组：必须是真数组（含数组 Proxy），恰好有 length 和 0..n-1 这些自有键，
 * 每一项都是数据属性（没有洞、没有 getter、没有多余的字符串 / Symbol 属性）。任何读取异常都收成 code。 */
function readArray(value, code, what, length) {
  const bad = msg => new MemoryError(code, `${what} ${msg}`);
  const read = fn => { try { return fn(); } catch (_) { throw bad("could not be read"); } };
  if (!read(() => Array.isArray(value))) throw bad("must be an array");
  const ld = read(() => Reflect.getOwnPropertyDescriptor(value, "length"));
  const n = ld && ld.value;
  if (!Number.isSafeInteger(n) || n < 0 || (length !== undefined && n !== length)) throw bad(length === undefined ? "has a bad length" : `must have exactly ${length} items`);
  if (read(() => Reflect.ownKeys(value)).length !== n + 1) throw bad("must be a dense array without extra properties");
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = read(() => Reflect.getOwnPropertyDescriptor(value, String(i)));
    if (!d || !("value" in d)) throw bad(`[${i}] must be a plain value`);
    out[i] = d.value;
  }
  return out;
}

/* 从注入的对象（store / fs）上取方法：沿原型链找第一个同名描述符，只接受值为函数的数据属性（getter 不执行），
 * 每个方法只读一次；Proxy 陷阱抛错、撤销的 Proxy 都收成 code。类实例的原型方法可以用。 */
function readMethods(obj, names, code, what) {
  const bad = () => new MemoryError(code, `${what} must be an object with methods: ${names.join(", ")}`);
  const read = fn => { try { return fn(); } catch (_) { throw bad(); } };
  if (obj === null || typeof obj !== "object") throw bad();
  const out = Object.create(null);
  for (const name of names) {
    let o = obj, d;
    for (let depth = 0; o !== null && depth < 32 && !d; depth++) {
      const cur = o;
      d = read(() => Reflect.getOwnPropertyDescriptor(cur, name));
      if (!d) o = read(() => Object.getPrototypeOf(cur));
    }
    if (!d || !("value" in d) || typeof d.value !== "function") throw bad();
    out[name] = d.value;
  }
  return out;
}

/* 没有 own property 就当没有：Object.prototype 上被污染的同名字段读不到 */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

module.exports = { MemoryError, readRecord, readArray, readMethods, hasOwn };
