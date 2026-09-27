/* 「问老师」回答的排版（#59）—— 浏览器和 node 共用同一份实现（同 visual-check.js 的做法）。
 *
 *   formatRichText(s, { katex })  → 安全的 HTML 字符串
 *
 * 模型回答是纯文本，但常夹着 LaTeX 公式和 Markdown 粗体：
 *   - \( … \) / $ … $ 行内公式，\[ … \] / $$ … $$ 独立公式 → KaTeX（不开 trust，\href 之类不会变成链接；
 *     maxSize / maxExpand 收紧，\rule{9999em} 或宏展开炸弹撑不破页面）；KaTeX 没加载或公式有错 → 原样转义显示；
 *   - **粗体** → <b>，可以包着公式；单独的 * 不处理；
 *   - 其余一律转义，换行原样保留（气泡是 pre-wrap）。
 * $ … $ 要和钱数分开（isInlineMath）：行内不跨行；\$ 是字面的 $；结尾 $ 后面紧跟数字的不算；
 * 贴空白的只有两边都贴、里面又有 \命令 / ^ / _ / { 才算（「$ \frac{1}{2} $」），只贴一边的（「$3 and $4」）不算；
 * 数字开头又夹着中文或全角标点的（「每本书$4，设总价为$y$元」，\text{} 里的中文单位不算）、或以标点结尾的（「$5,$x$」）
 * 是钱数，跳过这个 $ 接着往后找。
 * 题库的 mathText（public/index.html）是另一套，别混用：那边题目文字不认粗体。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YYRichText = api;
})(typeof self !== "undefined" ? self : this, function () {
  const esc = x => String(x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /* 顺序即优先级：先认 \[ \] 和 $$，再认行内；$$ 必须排在 $ 前面。行内 $ 的取舍在 isInlineMath */
  const MATH = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\((.+?)\\\)|\$([^$\n]+?)\$/g;
  const BOLD = /\*\*(?=\S)([^\n]*?\S)\*\*/g;
  const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
  const MARK_A = "", MARK_B = "";   // 私用区字符当占位符，输入里原有的先删掉
  const MARKS = new RegExp(MARK_A + "(\\d+)" + MARK_B, "g");

  function isInlineMath(s, m) {
    const tex = m[4], after = s[m.index + m[0].length];
    if (m.index > 0 && s[m.index - 1] === "\\") return false;       // \$5：字面的 $
    if (/\\$/.test(tex)) return false;                                // …\$：结尾那个 $ 是字面的
    if (after && /\d/.test(after)) return false;                      // $5+$3：结尾 $ 后面是数字
    if (!tex.trim()) return false;
    const lead = /^\s/.test(tex), trail = /\s$/.test(tex);
    if (lead || trail) {   // $3 and $4 只贴一边；「$ \frac{1}{2} $」两边都贴而且有命令才算
      if (!(lead && trail && /\\[a-zA-Z]|[\^_{]/.test(tex))) return false;
    }
    if (/^\d/.test(tex)) {
      if (CJK.test(tex.replace(/\\(?:text|mathrm|mbox)\{[^{}]*\}/g, ""))) return false;   // 每本书$4，设总价为$；$12\text{平方厘米}$ 照样是公式
      if (/[,.!?;:]$/.test(tex)) return false;                        // $5,$x$：钱数后面紧跟标点
    }
    return true;
  }

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
      if (m[4] != null && !isInlineMath(s, m)) { MATH.lastIndex = m.index + 1; continue; }   // 这个 $ 当文字，从下一个字符接着找
      const display = m[1] != null || m[2] != null;
      const tex = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      let before = s.slice(last, m.index);
      let end = m.index + m[0].length;
      if (display) {   // 独立公式本身是块，紧挨着的一个换行吃掉，免得多空一行
        before = before.replace(/\r?\n$/, "");
        if (s[end] === "\r" && s[end + 1] === "\n") end += 2; else if (s[end] === "\n") end++;
      }
      text += before + MARK_A + parts.length + MARK_B;
      parts.push(tex.trim() ? renderTex(katex, tex, display, m[0]) : esc(m[0]));
      last = end;
    }
    text += s.slice(last);
    return esc(text)
      .replace(BOLD, (_, inner) => "<b>" + inner + "</b>")
      .replace(MARKS, (_, i) => parts[Number(i)]);
  }

  return { formatRichText };
});
