/*
 * 回复 verifier（#38，#19 Phase 7）：TutorAgent / 工作流把模型回复交给孩子之前的确定性检查。零依赖、无 I/O。
 * 只 require calculator.js、number.js 和 memory 的严格读取工具；不 require tutor（正文筛查由调用方以 screen 回调注入），依赖无环。
 *
 *   verifyResponse(output, opts) → 冻结 { ok, failures:[{ rule, message }], coverage }
 *     output = { kind, text, scope?, checks? }（TutorAgent 已按 FINAL_SCHEMA 校验过形状）
 *     opts   = { mode: answer|hint, strategy?, screen?(text)→ruleId|null, question?, context?, evidence? }
 *   extractEqualities(text, question?) → [{ chain, status: true|false|unknown, reason }]
 *   findAnswerLeak(text, answerKey, question?) → { covered, leak }
 *   readVerifyContext(raw) → 冻结 null 原型 { topicId?, allowedTopicIds?, answerKey? }，不合契约抛 VerificationError
 *
 * 规则（kind 为 refusal 时一条都不跑：拒答正文本来就换成固定模板）：
 *   已有（从 TutorAgent 抽出，文案逐字不变）：scope 必须是 math；hint 模式不许 kind answer；正文筛查（screen 回调）；checks 逐条用 calculator 复算（相对误差 1e-9）。
 *   新增、无条件：正文里显式的纯算术等式链（如 "37 × 24 = 888"、"3/4 = 6/8"）用精确有理数核对，假的就退回；
 *     边界不干净（紧贴字母 / % / √ / 数字分隔符 / 不在白名单里的词，或后面是问号）的一律不检查，只计入 notChecked。
 *   新增、只在有可信 context 时：课程 id 声明要有证据、「用计算器核对过」要有真实调用、hint 模式下不许用显式形式说出答案键、
 *     socratic-teaching 必须是问句。
 * coverage 只说「哪些规则跑了、没发现错误」；自然语言语义、一般事实、没有列出的形式都是 prose: "not-verified"，不是「已验证」。
 */
"use strict";

const calculator = require("../tools/calculator.js");
const { parseAnswerNumber, evaluateExact, equal } = require("./number.js");
const mem = require("../memory/errors.js");
const { isTopicId } = require("../memory/events.js");

class VerificationError extends Error {
  constructor(code, message) { super(message); this.name = "VerificationError"; this.code = code; }
}

/* 扫描用的规范化：全角 ASCII（数字、字母、运算符、括号、点）→ 半角，全角空格 → 空格，U+2212 负号 → "-"。
 * 不用 NFKC：它会把 4² 变成 42、1½ 变成 11⁄2。中文标点 ，：；！？ 保持原样（它们不会是数字分隔符，边界规则单独认）。
 * 之后所有下标都指这份文本 */
const CJK_PUNCT = "，：；！？";
const norm = s => String(s)
  .replace(/[！-～]/g, c => (CJK_PUNCT.includes(c) ? c : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
  .replace(/　/g, " ").replace(/−/g, "-");
const compact = s => norm(s).replace(/\s+/g, "").toLowerCase();
const MAX_SCAN = 8000;   // 扫描入口的输入上限（字符）；超出时 extractEqualities 返回 []、findAnswerLeak 报 not covered
const clip = s => (s.length > 80 ? s.slice(0, 77) + "..." : s);

/* ---------------- 显式算术等式 ---------------- */
const RUN_CHAR = /[0-9+\-*/×÷^()= \t]/;
function isRunChar(t, i) {
  const c = t[i];
  if (RUN_CHAR.test(c)) return true;
  return c === "." && /\d/.test(t[i - 1] || "") && /\d/.test(t[i + 1] || "");   // 只有夹在两个数字之间的点是小数点
}
/* 边界白名单：只有这些词 / 标点紧挨着等式链时才认为链是完整的一句话；「15% of 80」「3 乘 4」「2x + 3」「√16」「1,000」「10:30」都不算 */
const LEFT_WORDS_EN = new Set(["so", "then", "thus", "because", "since", "check"]);
const RIGHT_WORDS_EN = new Set(["so", "then", "because", "since"]);
const LEFT_WORDS_ZH = ["所以", "因为", "即", "也就是", "然后", "那么", "于是", "验算", "先算", "再算"];
const RIGHT_WORDS_ZH = ["所以", "因为", "然后", "那么", "于是"];
const isLetter = c => /[A-Za-z]/.test(c || "");

function leftSafe(t, idx) {
  let j = idx - 1, spaced = false;
  while (j >= 0 && (t[j] === " " || t[j] === "\t")) { j--; spaced = true; }
  if (j < 0) return true;
  const c = t[j];
  if (c === "\n" || c === "\r") return true;
  if (c === "(") return leftSafe(t, j);          // 剥掉的左括号：看它外面
  if (c === "。" || c === "、" || CJK_PUNCT.includes(c)) return true;
  if (c === "," || c === ";" || c === ":" || c === "!") return spaced || !/\d/.test(t[j - 1] || "");
  if (c === ".") return spaced && t[j - 1] !== ".";
  if (isLetter(c)) {
    let k = j;
    while (k >= 0 && isLetter(t[k])) k--;
    return spaced && LEFT_WORDS_EN.has(t.slice(k + 1, j + 1).toLowerCase());
  }
  return LEFT_WORDS_ZH.some(w => t.slice(j - w.length + 1, j + 1) === w);
}
function rightSafe(t, idx) {
  let j = idx, spaced = false;
  while (j < t.length && (t[j] === " " || t[j] === "\t")) { j++; spaced = true; }
  if (j >= t.length) return true;
  const c = t[j];
  if (c === "\n" || c === "\r") return true;
  if (c === ")") return rightSafe(t, j + 1);     // 剥掉的右括号：看它外面
  if (c === "。" || c === "、" || (CJK_PUNCT.includes(c) && c !== "？")) return true;   // 后面是问号 = 在问，不是断言
  if (c === "," || c === ";" || c === ":" || c === "!") return !/\d/.test(t[j + 1] || "");
  if (c === ".") return t[j + 1] !== "." && (j + 1 >= t.length || /\s/.test(t[j + 1]) || /[㐀-鿿]/.test(t[j + 1]));
  if (isLetter(c)) {
    let k = j;
    while (k < t.length && isLetter(t[k])) k++;
    return spaced && RIGHT_WORDS_EN.has(t.slice(j, k).toLowerCase());
  }
  return RIGHT_WORDS_ZH.some(w => t.startsWith(w, j));
}
const count = (s, ch) => s.split(ch).length - 1;

/* 一条等式链 → { chain, status, reason }；status: true / false / unknown */
function judgeRun(t, start, end, qCompact) {
  const run = t.slice(start, end);
  const parts = [];
  let from = 0;
  for (let i = 0; i <= run.length; i++) if (i === run.length || run[i] === "=") { parts.push({ s: from, e: i }); from = i + 1; }
  const sides = parts.map(p => ({ s: start + p.s, e: start + p.e }));
  const text = x => t.slice(x.s, x.e);
  const trimSide = x => { while (x.s < x.e && /\s/.test(t[x.s])) x.s++; while (x.e > x.s && /\s/.test(t[x.e - 1])) x.e--; return x; };
  sides.forEach(trimSide);
  const unknown = reason => ({ chain: clip(run.trim()), status: "unknown", reason });
  let lead = 0;
  while (lead < sides.length && sides[lead].s === sides[lead].e) lead++;
  const real = sides.slice(lead);
  if (lead > 1) return unknown("syntax");
  if (real.length < 2) return unknown("not-arithmetic");                       // x = 5、Area = 40：另一边不是纯算术
  if (real.some(x => x.s === x.e)) return unknown("incomplete");               // 8 + 7 = ?、3 + 4 == 7
  const first = real[0], last = real[real.length - 1];
  if (lead === 0) {
    while (t[first.s] === "(" && count(text(first), "(") > count(text(first), ")")) { first.s++; trimSide(first); }
    if (!leftSafe(t, first.s)) return unknown("boundary");
  }
  while (t[last.e - 1] === ")" && count(text(last), ")") > count(text(last), "(")) { last.e--; trimSide(last); }
  if (!rightSafe(t, last.e)) return unknown("boundary");
  const chain = clip(real.map(text).join(" = "));
  const vals = [];
  for (const x of real) {
    const r = evaluateExact(text(x));
    if (!r.ok) return r.reason === "div0" ? { chain, status: false, reason: "div0" } : { chain, status: "unknown", reason: r.reason };
    vals.push(r.value);
  }
  if (vals.every(v => equal(v, vals[0]))) return { chain, status: true, reason: "exact", value: vals[0] };
  /* 原样出现在问题里的等式是在引用孩子写的（「我算 45 ÷ 5 = 8，对吗？」），不当作模型的断言 */
  if (qCompact && qCompact.includes(real.map(x => text(x).replace(/\s+/g, "")).join("="))) return { chain, status: "unknown", reason: "quoted" };
  return { chain, status: false, reason: "false" };
}

/* 公开版本只给 { chain, status, reason }（没有 BigInt，可 JSON 化）；内部版本另带真等式的精确值，给计算器声明绑定用 */
function extractEqualities(text, question) {
  return scanEqualities(text, question).map(e => ({ chain: e.chain, status: e.status, reason: e.reason }));
}
function scanEqualities(text, question) {
  if (typeof text !== "string" || text.length > MAX_SCAN) return [];
  if (typeof question === "string" && question.length > MAX_SCAN) question = null;
  const t = norm(text);
  const q = typeof question === "string" ? compact(question) : null;
  const out = [];
  let i = 0;
  /* 完整扫描（输入已限 MAX_SCAN 字符，每条链的求值另有 200 字符上限），不在中途停下：后面的假等式不能因为前面链多就漏掉 */
  while (i < t.length) {
    if (!isRunChar(t, i)) { i++; continue; }
    let j = i;
    while (j < t.length && isRunChar(t, j)) j++;
    if (t.slice(i, j).includes("=")) out.push(judgeRun(t, i, j, q));
    i = j;
  }
  return out;
}

/* ---------------- 提示里显式说出答案键 ----------------
 * 只认这几种形式（numeral = number.js 支持的整数 / 小数（含 .5）/ 分数 / 带分数，值与答案键精确相等，写法不限；
 * numeral 前后必须是完整边界：后面接数字、小数部分、字母（4e2、4cm）、%、上标、千分位或运算的都不是一个完整的数，不截取前缀去比）：
 *   A. 「… = numeral」且 numeral 后面不再接运算（"12 ÷ 3 = 4"、"x = 4"）
 *   B. 「numeral = …」且 numeral 前面不是运算（"4 = 12 ÷ 3"）
 *   C. 短语：the answer / result / solution … is|=|: numeral、equals / is equal to / makes / you get / comes to numeral；
 *      答案 / 结果 / 得数 / 总数 / 乘积 是|为|就是|等于|: numeral、等于 / 得到 / 得出 / 算出 / 就是 numeral
 * 同一段（去空白后）原样出现在题目里的不算（题目本身就写着）；答案只作为运算数出现（"3 × 4 = 12" 里的 4）不算。 */
/* 带分数在前（最左优先）：「1 1/2」整体是一个数；再是整数 / 小数 / 分数；最后是没有整数部分的小数 .5 */
const NUM = "[+-]?(?:\\d+[ \\t]+\\d+[ \\t]*/[ \\t]*\\d+|\\d+(?:\\.\\d+)?(?:[ \\t]*/[ \\t]*\\d+)?|\\.\\d+)";
const LEAK_PHRASES = [
  new RegExp(`\\b(?:the\\s+)?(?:final\\s+)?(?:answer|result|solution)\\s*(?:is|was|would be|will be|should be|equals|=|:)\\s*(${NUM})`, "g"),
  new RegExp(`\\b(?:equals|is equal to|makes|you get|you'll get|gives you|comes to)\\s+(${NUM})`, "g"),
  new RegExp(`(?:答案|结果|得数|总数|乘积)\\s*(?:应该是|就是|是|为|等于|:)\\s*(${NUM})`, "g"),
  new RegExp(`(?:等于|得到|得出|算出|就是)\\s*(${NUM})`, "g"),
];
const OP_AFTER = /^\s*[-+*/×÷^(]/;
const MATH_SPAN = /[0-9.+\-*/×÷^() \t]/;

/* numeral 后面必须是完整边界：结尾、空白或句读（句末的点、逗号可以，但 .5 / ,000 / :30 这种接数字的不行），
 * 不能紧跟字母（4e2、4cm）、数字、%、上标、/ 等，空白之后也不能再接运算（4 + 1） */
function numeralEnds(t, end) {
  const rest = t.slice(end);
  if (rest === "") return true;
  if (/^[.,:;][0-9]/.test(rest) || /^\.\./.test(rest)) return false;
  if (!/^(?:\s|[.,;:!?)\]"'”’。、，：；！？）])/.test(rest)) return false;
  return !OP_AFTER.test(rest);
}
/* 等式所在的数学片段（只跨数字 / 运算符 / 空格，外加紧贴的单个字母变量），去空白后用来和题目比对 */
function mathSpan(t, s, e) {
  while (s > 0 && (MATH_SPAN.test(t[s - 1]) || t[s - 1] === "=")) s--;
  if (s > 0 && isLetter(t[s - 1]) && !isLetter(t[s - 2])) s--;
  while (e < t.length && (MATH_SPAN.test(t[e]) || t[e] === "=")) e++;
  return t.slice(s, e).replace(/\s+/g, "").toLowerCase();
}

function findAnswerLeak(text, answerKey, question) {
  const k = typeof answerKey === "string" ? parseAnswerNumber(answerKey) : { ok: false };
  if (!k.ok || typeof text !== "string" || text.length > MAX_SCAN || (typeof question === "string" && question.length > MAX_SCAN)) return { covered: false, leak: false };
  const t = norm(text);
  const lower = t.toLowerCase();
  const q = typeof question === "string" ? compact(question) : "";
  const isKey = s => { const n = parseAnswerNumber(s); return n.ok && equal(n.value, k.value); };
  const quoted = span => span.length > 0 && q.includes(span);
  /* A：= numeral */
  for (const m of t.matchAll(new RegExp(`=\\s*(${NUM})`, "g"))) {
    const eq = m.index, end = m.index + m[0].length;
    if (/[<>!=]/.test(t[eq - 1] || "") || !t.slice(0, eq).trim()) continue;
    if (!numeralEnds(t, end) || !isKey(m[1])) continue;
    if (!quoted(mathSpan(t, eq, end))) return { covered: true, leak: true };
  }
  /* B：numeral = */
  for (const m of t.matchAll(new RegExp(`(${NUM})\\s*=(?!=)`, "g"))) {
    const s = m.index;
    const before = t.slice(0, s);
    if (/[\d./A-Za-z]$/.test(before) || /[-+*/×÷^(]\s*$/.test(before)) continue;
    if (!isKey(m[1])) continue;
    if (!quoted(mathSpan(t, s, s + m[0].length))) return { covered: true, leak: true };
  }
  /* C：短语 */
  for (const re of LEAK_PHRASES) {
    for (const m of lower.matchAll(re)) {
      const end = m.index + m[0].length;
      if (!numeralEnds(lower, end) || !isKey(m[1])) continue;
      if (!quoted(m[0].replace(/\s+/g, ""))) return { covered: true, leak: true };
    }
  }
  return { covered: true, leak: false };
}

/* ---------------- 课程 id 与「用计算器核对过」声明 ---------------- */
const CID_RE = /\b[A-Z]{2,8}\.MATH(?:\.[A-Z0-9]{1,16}){1,6}\b/g;
const CALC_CLAIM = [
  /\b(?:i|we)(?:'ve| have)?\s+(?:double[- ]?)?(?:checked|verified|confirmed|calculated)\b[^.!?\n]{0,40}\bcalculator\b/,
  /\bcalculator\s+(?:shows|showed|says|said|confirms|confirmed|gives|gave)\b/,
  /我.{0,4}(?:用|拿)计算器/,
  /计算器(?:验算|核对|确认|算)(?:过|了)/,
  /计算器(?:显示|确认|算出)/,
];
/* 课程 id 证据：给定的 lookups（成功的 curriculum.findTopic）结果里出现的所有课程 id（有界遍历）。
 * 这只证明「这个 id 来自大纲数据」，不证明正文关于它的说法对 */
function evidenceIds(lookups) {
  const ids = new Set();
  let budget = 2000;
  const walk = (v, depth) => {
    if (budget-- <= 0 || depth > 8) return;
    if (typeof v === "string") { for (const m of v.matchAll(CID_RE)) ids.add(m[0]); return; }
    if (v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  for (const e of lookups) walk(e.result, 0);
  return ids;
}
const lookedUpId = e => (e && e.input && typeof e.input.curriculumId === "string" ? e.input.curriculumId : null);
/* 计算器证据绑定到值：一条成功的 calculator.evaluate 能支撑正文里一条真等式，当且仅当它算的式子的值等于这条等式的值
 * （式子能精确求值就精确比，否则用工具回的浮点值按 1e-9 相对误差比） */
function calculatorBacks(e, value) {
  if (!e || e.tool !== "calculator.evaluate") return false;
  const x = e.input && typeof e.input.expression === "string" ? evaluateExact(e.input.expression) : { ok: false };
  if (x.ok) return equal(x.value, value);
  const got = e.result && typeof e.result.value === "number" ? e.result.value : NaN;
  const want = Number(value.n) / Number(value.d);
  return Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
}

/* ---------------- 可信上下文 ---------------- */
const CONTEXT_KEYS = ["topicId", "allowedTopicIds", "answerKey"];
const MAX_ALLOWED = 20;
const KEY_MAX = 200;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BAD_CONTEXT = "verify must be a plain object with only topicId, allowedTopicIds (up to 20 topic ids) and answerKey (1–200 characters of text)";
function readVerifyContext(raw) {
  const bad = () => new VerificationError("INVALID_VERIFY", BAD_CONTEXT);
  let r;
  try { r = mem.readRecord(raw, CONTEXT_KEYS, "INVALID_VERIFY", "verify"); } catch (_) { throw bad(); }
  const out = Object.create(null);
  if ("topicId" in r) { if (!isTopicId(r.topicId)) throw bad(); out.topicId = r.topicId; }
  if ("allowedTopicIds" in r) {
    let list;
    try { list = mem.readArray(r.allowedTopicIds, "INVALID_VERIFY", "allowedTopicIds"); } catch (_) { throw bad(); }
    if (list.length > MAX_ALLOWED || !list.every(isTopicId)) throw bad();
    out.allowedTopicIds = Object.freeze(list);
  }
  if ("answerKey" in r) {
    const k = r.answerKey;
    if (typeof k !== "string" || !k.trim() || k.length > KEY_MAX || CONTROL_RE.test(k)) throw bad();
    out.answerKey = k;
  }
  return Object.freeze(out);
}

/* ---------------- 汇总入口 ---------------- */
const MAX_VERIFY_TEXT = 8000;
function verifyResponse(output, opts) {
  opts = opts || {};
  const failures = [];
  const fail = (rule, message) => failures.push(Object.freeze({ rule, message }));
  const ctx = opts.context || null;
  const evidence = Array.isArray(opts.evidence) ? opts.evidence : null;
  const coverage = {
    declaredChecks: 0,
    equalities: { checked: 0, notChecked: 0 },
    answerLeak: "not-applicable", curriculumClaims: "not-covered", calculatorClaims: "not-covered", socraticForm: "not-applicable",
    prose: "not-verified",
  };
  const done = () => Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures), coverage: Object.freeze(Object.assign(coverage, { equalities: Object.freeze(coverage.equalities) })) });
  const o = output;
  if (!o || typeof o !== "object" || typeof o.kind !== "string" || typeof o.text !== "string") { fail("shape", "output must be { kind, text }"); return done(); }
  /* 有界：TutorAgent / 工作流的正文上限是 4000，这里给公开入口一个硬上限，超长直接判不合格（不做可能是平方级的扫描） */
  if (o.text.length > MAX_VERIFY_TEXT || (typeof opts.question === "string" && opts.question.length > MAX_VERIFY_TEXT)) { fail("shape", `text and question must be at most ${MAX_VERIFY_TEXT} characters`); return done(); }
  if (o.kind === "refusal") return done();

  /* 已有规则（原文案） */
  if (o.scope !== undefined && o.scope !== "math") { fail("scope", `only math questions may be answered; scope "${o.scope}" needs kind "refusal"`); return done(); }
  if (opts.mode === "hint" && o.kind === "answer") fail("hint-kind", 'hint mode: give a hint (kind "hint"), not the answer');
  const hit = typeof opts.screen === "function" ? opts.screen(o.text) : null;
  if (hit) fail("screen", `answer text contains off-scope content (${hit}); keep to the math, no links`);
  const redact = !!(ctx && ctx.answerKey);   // 有答案键时，出错信息里不写复算出来的值（可能就是答案）
  for (const c of Array.isArray(o.checks) ? o.checks : []) {
    let val;
    try { val = calculator.evaluate(c.expression); } catch (e) { fail("check", `check "${c.expression}" cannot be evaluated: ${e.message}`); break; }
    if (Math.abs(val - c.value) > 1e-9 * Math.max(1, Math.abs(val))) {
      fail("check", redact ? `check failed: ${c.expression} is not ${c.value}; fix the answer` : `check failed: ${c.expression} = ${val}, not ${c.value}; fix the answer`);
      break;
    }
    coverage.declaredChecks++;
  }

  /* 新增、无条件：正文里显式的算术等式 */
  const eqs = scanEqualities(o.text, opts.question);
  for (const eq of eqs) {
    if (eq.status === true) coverage.equalities.checked++;
    else if (eq.status === "unknown") coverage.equalities.notChecked++;
    else {
      /* 有答案键时不回显等式（模型写的等式里可能正好有答案），只给固定文案 */
      const what = redact ? "an arithmetic equation" : eq.chain;
      fail("equality", eq.reason === "div0"
        ? `the text says ${what}, but that divides by zero; fix the text`
        : `the text says ${what}, which is not true; recompute it with calculator.evaluate and fix the text`);
      break;
    }
  }

  /* 新增、只在有可信上下文时 */
  if (ctx) {
    const text = norm(o.text);
    if (evidence) {
      /* 课程 id：有话题范围（topicId / allowedTopicIds）时，只有查的是范围内 id 的那几次 lookup 返回的 id 才算进来（如该话题的先修）；
       * 查了一个范围外的 id 并不会把它变成本课的话题。没有范围（verify: {}）时，任何成功 lookup 返回的 id 都算有出处 */
      coverage.curriculumClaims = "checked";
      const scope = new Set([ctx.topicId, ...(ctx.allowedTopicIds || [])].filter(Boolean));
      const lookups = evidence.filter(e => e && e.tool === "curriculum.findTopic" && (scope.size === 0 || scope.has(lookedUpId(e))));
      const allowed = evidenceIds(lookups);
      for (const id of scope) allowed.add(id);
      const stray = [...text.matchAll(CID_RE)].map(m => m[0]).find(id => !allowed.has(id));
      if (stray) fail("curriculum-claim", `curriculum id ${stray} is neither this lesson's topic nor returned by curriculum.findTopic for it in this conversation; do not name curriculum ids you have not looked up`);
      /* 「用计算器核对过」：正文里至少有一条真等式，而且每条真等式的值都有本 run 里一次成功的 calculator.evaluate 对上；
       * 只是「调用过计算器」不够 */
      coverage.calculatorClaims = "checked";
      const lower = text.toLowerCase();
      if (CALC_CLAIM.some(re => re.test(lower))) {
        const truths = eqs.filter(e => e.status === true);
        if (truths.length === 0 || !truths.every(e => evidence.some(ev => calculatorBacks(ev, e.value))))
          fail("calculator-claim", "the text says it was checked with the calculator, but its equations are not all backed by calculator.evaluate results in this conversation");
      }
    }
    if (opts.mode === "hint") {
      const leak = findAnswerLeak(o.text, ctx.answerKey, opts.question);
      coverage.answerLeak = leak.covered ? "checked" : "not-covered";
      if (leak.leak) fail("answer-leak", 'hint mode: the text states the final answer in an explicit form ("= answer" or "the answer is ..."); give a step or a guiding question instead');
    }
    if (opts.strategy === "socratic-teaching") {
      coverage.socraticForm = "checked";
      if (!/[?？]/.test(text)) fail("socratic", "socratic-teaching: reply with a guiding question for the child (it must contain a question mark)");
    }
  }
  return done();
}

module.exports = { verifyResponse, extractEqualities, findAnswerLeak, readVerifyContext, VerificationError, CID_RE };
