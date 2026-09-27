/* 「问老师」回答的排版（#59）—— 浏览器和 node 共用同一份实现（同 visual-check.js 的做法）。
 *
 *   formatRichText(s, { katex })  → 安全的 HTML 字符串
 *
 * 模型回答是纯文本，但常夹着 LaTeX 公式和 Markdown 粗体：
 *   - \( … \) / $ … $ 行内公式，\[ … \] / $$ … $$ 独立公式 → KaTeX（不开 trust，\href 之类不会变成链接）；
 *     KaTeX 没加载或公式有错 → 原样转义显示，不会炸；
 *   - **粗体** → <b>，可以包着公式；单独的 * 不处理；
 *   - 其余一律转义，换行原样保留（气泡是 pre-wrap）。
 * 钱数里的 $ 不当公式：开头 $ 后面紧跟空白、结尾 $ 前面是空白或后面紧跟数字的都不算（Pandoc 同款规则），
 * 行内公式不跨行。所以「$3 和 $4」「$5+$3=$8」都按文字显示。
 * 题库的 mathText（public/index.html）是另一套，别混用：那边题目文字不认粗体。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YYRichText = api;
})(typeof self !== "undefined" ? self : this, function () {
  const esc = x => String(x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /* 顺序即优先级：先认 \[ \] 和 $$，再认行内；$$ 必须排在 $ 前面 */
  const MATH = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\((.+?)\\\)|\$(?=\S)([^$\n]*?\S)\$(?!\d)/g;
  const BOLD = /\*\*(?=\S)([^\n]*?\S)\*\*/g;
  const MARK_A = "\uE000", MARK_B = "\uE001";   // 私用区字符当占位符，输入里原有的先删掉

  function renderTex(katex, tex, display, raw) {
    if (katex && typeof katex.renderToString === "function") {
      try {
        const html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, maxSize: 10, maxExpand: 200 });
        if (typeof html === "string" && html) return html;
      } catch (_) { /* 公式有错：下面按原文显示 */ }
    }
    return esc(raw);
  }

  function formatRichText(s, opts) {
    const katex = opts && opts.katex;
    s = String(s == null ? "" : s).split(MARK_A).join("").split(MARK_B).join("");
    const parts = [];
    let text = "", last = 0, m;
    MATH.lastIndex = 0;
    while ((m = MATH.exec(s))) {
      const display = m[1] != null || m[2] != null;
      const tex = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      let before = s.slice(last, m.index);
      let end = m.index + m[0].length;
      if (display) {   // 独立公式本身是块，紧挨着的一个换行吃掉，免得多空一行
        before = before.replace(/\n$/, "");
        if (s[end] === "\n") end++;
      }
      text += before + MARK_A + parts.length + MARK_B;
      parts.push(tex.trim() ? renderTex(katex, tex, display, m[0]) : esc(m[0]));
      last = end;
    }
    text += s.slice(last);
    return esc(text)
      .replace(BOLD, (_, inner) => "<b>" + inner + "</b>")
      .replace(new RegExp(MARK_A + "(\\d+)" + MARK_B, "g"), (_, i) => parts[Number(i)]);
  }

  return { formatRichText };
});
