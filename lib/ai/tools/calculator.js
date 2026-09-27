/*
 * 安全算术求值器（#26）：给 calculator.evaluate 和 Phase 7 的答案 verifier 用。零依赖，不用 eval / Function。
 * 支持：整数、小数、+ - * / % ^、括号、一元负号、函数 sqrt abs round floor ceil min max、常量 pi e。
 * 不支持变量、赋值、字符串。表达式上限 200 字符。除以零 / 非法 token / 深度过深 / 参数个数不对都抛 Error。
 * 函数参数个数严格：sqrt abs round floor ceil 恰好 1 个（round(1.234,2) 不静默算成 1），min max 至少 1 个。
 */
"use strict";

/* [实现, 最少参数, 最多参数] */
const FUNCS = { sqrt: [Math.sqrt, 1, 1], abs: [Math.abs, 1, 1], round: [Math.round, 1, 1], floor: [Math.floor, 1, 1], ceil: [Math.ceil, 1, 1], min: [Math.min, 1, Infinity], max: [Math.max, 1, Infinity] };
const CONSTS = { pi: Math.PI, e: Math.E };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ t: "num", v: Number(m[1]) }); i += m[1].length; continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const m = /^[a-zA-Z]+/.exec(src.slice(i));
      out.push({ t: "id", v: m[0].toLowerCase() }); i += m[0].length; continue;
    }
    if ("+-*/%^(),".includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === "×") { out.push({ t: "*" }); i++; continue; }
    if (c === "÷") { out.push({ t: "/" }); i++; continue; }
    throw new Error(`unexpected character "${c}" at ${i}`);
  }
  return out;
}

/* 递归下降：expr = term (('+'|'-') term)* ; term = unary (('*'|'/'|'%') unary)* ; unary = '-' unary | power ; power = atom ('^' unary)? */
function evaluate(src) {
  if (typeof src !== "string") throw new TypeError("expression must be a string");
  if (src.length > 200) throw new Error("expression too long");
  const toks = tokenize(src);
  let p = 0, depth = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const expect = t => { const k = next(); if (!k || k.t !== t) throw new Error(`expected "${t}"`); };
  function expr() {
    let v = term();
    while (peek() && (peek().t === "+" || peek().t === "-")) { const op = next().t; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() && (peek().t === "*" || peek().t === "/" || peek().t === "%")) {
      const op = next().t; const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new Error("division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function unary() {
    if (peek() && peek().t === "-") { next(); return -unary(); }
    if (peek() && peek().t === "+") { next(); return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek() && peek().t === "^") { next(); return Math.pow(base, unary()); }
    return base;
  }
  function atom() {
    if (++depth > 50) throw new Error("expression too deep");
    try {
      const k = next();
      if (!k) throw new Error("unexpected end");
      if (k.t === "num") return k.v;
      if (k.t === "(") { const v = expr(); expect(")"); return v; }
      if (k.t === "id") {
        if (hasOwn(CONSTS, k.v)) return CONSTS[k.v];
        if (hasOwn(FUNCS, k.v)) {
          const [fn, min, max] = FUNCS[k.v];
          expect("(");
          const args = [expr()];
          while (peek() && peek().t === ",") { next(); args.push(expr()); }
          expect(")");
          if (args.length < min || args.length > max) {
            throw new Error(min === max ? `${k.v} expects exactly ${min} argument, got ${args.length}` : `${k.v} expects at least ${min} argument, got ${args.length}`);
          }
          return fn(...args);
        }
        throw new Error(`unknown name "${k.v}"`);
      }
      throw new Error(`unexpected "${k.t}"`);
    } finally { depth--; }
  }
  const v = expr();
  if (p < toks.length) throw new Error(`unexpected "${toks[p].t}" after expression`);
  if (!Number.isFinite(v)) throw new Error("result is not a finite number");
  return v;
}

module.exports = { evaluate };
