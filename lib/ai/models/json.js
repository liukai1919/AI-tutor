/*
 * 模型输出的 JSON 解析与修复（纯函数，零依赖）。#22，#19 Phase 1 第三刀。
 * 代码从 server.js 原样搬来，一个字没改；规则说明见各函数上方注释。
 */
"use strict";

/* 模型手写 JSON 最常见的毛病：字符串里夹着没转义的英文双引号（中文课文爱用 "..." 引东西）和裸换行。
 * 修法：逐字符走一遍，字符串内遇到 " 时往后看——后面（跳过空白）不是 , } ] : 之一，就当它是正文里的引号转义掉。
 * 只在 JSON.parse 失败后才走这条路，修不好照旧抛错让上层重试。 */
function repairJson(t) {
  let out = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) {
      if (c === '"') {
        // qwen 的一个固定毛病：值后面多粘一个引号，后面紧跟 , } ] 就丢掉它。
        //   数字后：{"level":2"，{"answerIndex":1"
        //   字符串后：["ok","other"","ok"]、"explain":"…"" —— 合法 JSON 里字符串收尾引号后面
        //   只可能跟 , } ] :，绝不会再来一个引号，所以这里丢掉它是安全的
        //   （空字符串 "" 走的是 inStr 分支，到不了这里）
        const prev = out.replace(/\s+$/, "").slice(-1);
        let j = i + 1; while (j < t.length && /\s/.test(t[j])) j++;
        if (/[0-9el"]/.test(prev) && j < t.length && ",}]".includes(t[j])) continue;
        inStr = true;
      }
      out += c; continue;
    }
    if (c === "\\") {
      // 字符串里的反斜杠：合法 JSON 转义原样过；\frac \times \begin 这种 LaTeX 命令（\f \t \b \n \r 后面紧跟字母）
      // 和 \( \s \c 这类非法转义，都是模型忘了双写反斜杠，补一个
      const n = t[i + 1] || "";
      const validJson = '"\\/bfnrtu'.includes(n);
      const latexLike = /[fbnrt]/.test(n) && /[A-Za-z]/.test(t[i + 2] || "");
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(i + 2, i + 6))) { out += "\\u"; i++; continue; }
      if (!validJson || latexLike || n === "u") { out += "\\\\"; continue; }
      out += c + n; i++; continue;
    }
    if (c === "\n") { out += "\\n"; continue; }
    if (c === "\r" || c === "\t") { out += c === "\t" ? "\\t" : ""; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && /\s/.test(t[j])) j++;
      // 后面紧跟一个多余引号、再后面才是 , } ] :（"other"" 这种）：当前这个才是收尾引号，
      // 多余那个留给上面「值后多粘引号」的规则丢掉。不这么判的话收尾引号会被当成内容转义进字符串。
      let stray = false;
      if (t[j] === '"') {
        let k = j + 1;
        while (k < t.length && /\s/.test(t[k])) k++;
        stray = k >= t.length || ",}]:".includes(t[k]);
      }
      if (j >= t.length || ",}]:".includes(t[j]) || stray) { inStr = false; out += c; }
      else out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}
function extractJson(text) {
  if (!text) throw new Error("引擎没有返回内容");
  let t = String(text);
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) t = fenced[1];
  /* 顶层可能是对象也可能是数组：模型偶尔直接吐一个数组（尤其被 format/schema 约束时）。
   * 只按 { } 截会把数组里第一个对象抠出来当整体，报 "Unexpected non-whitespace after JSON"。
   * 取两者中先出现的那个作为起点，配对的收尾符号作为终点。 */
  const so = t.indexOf("{"), sa = t.indexOf("[");
  const useArr = sa >= 0 && (so < 0 || sa < so);
  const s = useArr ? sa : so, e = useArr ? t.lastIndexOf("]") : t.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("返回内容里找不到 JSON");
  const body = t.slice(s, e + 1);
  try { return JSON.parse(body); }
  catch (err) {
    try { return JSON.parse(repairJson(body)); }
    catch (_) { throw err; }
  }
}

module.exports = { repairJson, extractJson };
