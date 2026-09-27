/*
 * 有界精确有理数（#38，#19 Phase 7）。零依赖，不用 eval / Function，不用浮点比较。
 *
 *   parseAnswerNumber(text) → { ok:true, value:{n,d}, canon } | { ok:false, reason }
 *     孩子作答 / 答案键里的一个数：整数、小数、分数 a/b、带分数「w a/b」。canon 是规范写法（去前导零、去 +、-0 → 0），
 *     用来区分「值相同但写法不同」（4/8 vs 1/2、4 vs 4.0）。其它写法（单位、%、千分位、科学计数、代数、中文数字、上标、½ 这类字符）→ unsupported。
 *   evaluateExact(src) → { ok:true, value } | { ok:false, reason: syntax|div0|too-large }
 *     正文里等式一侧的纯算术式：数字、+ - * / × ÷ ^、括号、一元正负号。^ 的指数必须是 |k| ≤ 64 的整数。
 *   equal(a, b)、format(v)
 *
 * 值用 BigInt 分子 / 分母表示（分母 > 0、已约分），位数有界：每个数字串 ≤ 30 位、中间结果 ≤ 1024 bit，超出 → too-large（当作不确定，不当作相等）。
 */
"use strict";

const MAX_DIGITS = 30;
const MAX_TEXT = 64;
const MAX_EXPR = 200;
const MAX_BITS = 1024n;
const MAX_EXP = 64;
const MAX_DEPTH = 50;

class TooLarge extends Error {}
class Syntax extends Error {}
class DivZero extends Error {}

const abs = x => (x < 0n ? -x : x);
function gcd(a, b) { a = abs(a); b = abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
function bits(x) { return BigInt(abs(x).toString(2).length); }
function make(n, d) {
  if (d === 0n) throw new DivZero("division by zero");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  n /= g; d /= g;
  if (bits(n) > MAX_BITS || bits(d) > MAX_BITS) throw new TooLarge("number too large");
  return Object.freeze({ n, d });
}
const add = (a, b) => make(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => make(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => make(a.n * b.n, a.d * b.d);
const div = (a, b) => { if (b.n === 0n) throw new DivZero("division by zero"); return make(a.n * b.d, a.d * b.n); };
function pow(a, e) {
  if (e.d !== 1n || abs(e.n) > BigInt(MAX_EXP)) throw new Syntax("exponent must be a small integer");
  const k = Number(e.n);
  if (k < 0 && a.n === 0n) throw new DivZero("division by zero");
  let r = make(1n, 1n);
  for (let i = 0; i < Math.abs(k); i++) r = mul(r, a);
  return k < 0 ? div(make(1n, 1n), r) : r;
}
const equal = (a, b) => a.n * b.d === b.n * a.d;
const format = v => (v.d === 1n ? v.n.toString() : `${v.n}/${v.d}`);

/* 十进制串 → 有理数；数字串长度已由调用方限制 */
function fromDecimal(intPart, fracPart) {
  const scale = 10n ** BigInt(fracPart.length);
  return make(BigInt(intPart || "0") * scale + BigInt(fracPart || "0"), scale);
}
const strip = s => s.replace(/^0+(?=\d)/, "");

/* 作答规范化：先只许数字（半角 / 全角）、+ - − . / ⁄ 和空白——上标（4² 经 NFKC 会变成 42）、½ 之类（1½ 会变成 11⁄2）、字母、% 都在这里挡掉；
 * 再 NFKC（全角 → 半角）、U+2212 负号、U+2044 分数线、空白合一、去首尾空白。不合格返回 null */
const ANSWER_CHARS = /^[\s0-9０-９+\-−＋－.．/／⁄]*$/;
function normalizeAnswer(s) {
  if (!ANSWER_CHARS.test(s)) return null;
  return s.normalize("NFKC").replace(/−/g, "-").replace(/⁄/g, "/").replace(/\s+/g, " ").trim().replace(/\s*\/\s*/g, "/");
}
const D = `\\d{1,${MAX_DIGITS}}`;
const INT_RE = new RegExp(`^([+-]?)(${D})$`);
const DEC_RE = new RegExp(`^([+-]?)(\\d{0,${MAX_DIGITS}})\\.(${D})$`);
const FRAC_RE = new RegExp(`^([+-]?)(${D})/(${D})$`);
const MIXED_RE = new RegExp(`^([+-]?)(${D}) (${D})/(${D})$`);

function parseAnswerNumber(text) {
  if (typeof text !== "string") return { ok: false, reason: "not-text" };
  if (text.length > MAX_TEXT * 4) return { ok: false, reason: "too-long" };
  const s = normalizeAnswer(text);
  if (s === null) return { ok: false, reason: "unsupported" };
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > MAX_TEXT) return { ok: false, reason: "too-long" };
  let m, value, canon;
  try {
    if ((m = INT_RE.exec(s))) {
      value = make(BigInt(m[2]), 1n);
      canon = strip(m[2]);
    } else if ((m = DEC_RE.exec(s))) {
      value = fromDecimal(m[2], m[3]);
      canon = (strip(m[2]) || "0") + "." + m[3];
    } else if ((m = FRAC_RE.exec(s))) {
      if (/^0+$/.test(m[3])) return { ok: false, reason: "zero-denominator" };
      value = make(BigInt(m[2]), BigInt(m[3]));
      canon = strip(m[2]) + "/" + strip(m[3]);
    } else if ((m = MIXED_RE.exec(s))) {
      const w = BigInt(m[2]), n = BigInt(m[3]), d = BigInt(m[4]);
      if (d === 0n) return { ok: false, reason: "zero-denominator" };
      if (n === 0n || n >= d) return { ok: false, reason: "unsupported" };   // 带分数只认真分数部分
      value = make(w * d + n, d);
      canon = strip(m[2]) + " " + strip(m[3]) + "/" + strip(m[4]);
    } else {
      return { ok: false, reason: "unsupported" };
    }
  } catch (e) {
    return { ok: false, reason: e instanceof TooLarge ? "too-large" : "unsupported" };
  }
  if (m[1] === "-") { value = make(-value.n, value.d); if (value.n !== 0n) canon = "-" + canon; }
  return { ok: true, value, canon };
}

/* ---------------- 纯算术式（正文等式的一侧） ---------------- */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c >= "0" && c <= "9") {
      const m = /^(\d+)(?:\.(\d+))?/.exec(src.slice(i));
      if (m[1].length > MAX_DIGITS || (m[2] && m[2].length > MAX_DIGITS)) throw new TooLarge("number too long");
      out.push({ t: "num", v: fromDecimal(m[1], m[2] || "") });
      i += m[0].length;
      continue;
    }
    if ("+-*/^()".includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === "×") { out.push({ t: "*" }); i++; continue; }
    if (c === "÷") { out.push({ t: "/" }); i++; continue; }
    if (c === "−") { out.push({ t: "-" }); i++; continue; }
    throw new Syntax("unexpected character");
  }
  return out;
}

/* 与 calculator.js 同一文法（expr / term / unary / power / atom），只是值是精确有理数，且没有函数、常量、% */
function evaluateExact(src) {
  try {
    if (typeof src !== "string" || !src.trim() || src.length > MAX_EXPR) throw new Syntax("bad expression");
    const toks = tokenize(src);
    let p = 0, depth = 0;
    const peek = () => toks[p], next = () => toks[p++];
    function expr() {
      let v = term();
      while (peek() && (peek().t === "+" || peek().t === "-")) { const op = next().t; const r = term(); v = op === "+" ? add(v, r) : sub(v, r); }
      return v;
    }
    function term() {
      let v = unary();
      while (peek() && (peek().t === "*" || peek().t === "/")) { const op = next().t; const r = unary(); v = op === "*" ? mul(v, r) : div(v, r); }
      return v;
    }
    function unary() {
      if (peek() && peek().t === "-") { next(); const v = unary(); return make(-v.n, v.d); }
      if (peek() && peek().t === "+") { next(); return unary(); }
      return power();
    }
    function power() {
      const base = atom();
      if (peek() && peek().t === "^") { next(); return pow(base, unary()); }
      return base;
    }
    function atom() {
      if (++depth > MAX_DEPTH) throw new Syntax("too deep");
      try {
        const k = next();
        if (!k) throw new Syntax("unexpected end");
        if (k.t === "num") return k.v;
        if (k.t === "(") { const v = expr(); const c = next(); if (!c || c.t !== ")") throw new Syntax("expected )"); return v; }
        throw new Syntax("unexpected token");
      } finally { depth--; }
    }
    const v = expr();
    if (p < toks.length) throw new Syntax("trailing tokens");
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof DivZero) return { ok: false, reason: "div0" };
    if (e instanceof TooLarge) return { ok: false, reason: "too-large" };
    if (e instanceof Syntax) return { ok: false, reason: "syntax" };
    return { ok: false, reason: "syntax" };   // RangeError 之类：一律当作解析不了
  }
}

module.exports = { parseAnswerNumber, evaluateExact, equal, format, normalizeAnswer, MAX_DIGITS, MAX_TEXT };
