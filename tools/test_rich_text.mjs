#!/usr/bin/env node
/*
 * public/rich-text.js 的单元测试（#59）。不起服务器、不读盘、不联网。
 *
 *   node tools/test_rich_text.mjs
 *
 * KaTeX 用桩：真 KaTeX 只在浏览器里从 CDN 加载，这里只钉「哪些片段交给 KaTeX、用什么参数、出错怎么降级」
 * 和转义规则。真实排版效果在隔离实例的浏览器里看（见 #59 交付记录）。
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const { formatRichText } = require("../public/rich-text.js");
const { check, summary } = makeChecker();

const calls = [];
const katex = {
  renderToString(tex, o) {
    calls.push({ tex, o });
    if (tex.includes("BAD")) throw new Error("ParseError");
    return `<K${o.displayMode ? " d" : ""}>${tex.replace(/[&<>"]/g, c => "&#" + c.charCodeAt(0) + ";")}</K>`;
  },
};
const f = s => formatRichText(s, { katex });

console.log("escaping");
check("plain text escaped", f(`<script>alert("x")</script> & 'y'`) === "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;", f(`<script>alert("x")</script> & 'y'`));
check("null / undefined -> empty", formatRichText(null) === "" && formatRichText(undefined) === "");
check("numbers stringified", formatRichText(42) === "42");
check("newlines kept as-is", f("第一步\n第二步\n\n完") === "第一步\n第二步\n\n完");
check("placeholder chars in input are stripped, cannot forge a formula", f("a\uE0000\uE001b") === "a0b" && f("\uE0000\uE001$x$") === "0<K>x</K>", f("\uE0000\uE001$x$"));

console.log("math");
calls.length = 0;
check("\\( \\) inline", f("所以 \\(\\frac{1}{2}\\) 最大") === "所以 <K>\\frac{1}{2}</K> 最大");
check("$ $ inline", f("面积是 $3\\times4=12$ 平方厘米") === "面积是 <K>3\\times4=12</K> 平方厘米");
check("katex options: inline, throwOnError, no trust, strict ignore, size/expand caps",
  calls.length === 2 && calls.every(c => c.o.displayMode === false && c.o.throwOnError === true && c.o.trust === false && c.o.strict === "ignore" && c.o.maxSize === 10 && c.o.maxExpand === 200), calls);
calls.length = 0;
const disp = f("算式：\n\\[x^2+1\\]\n所以");
check("\\[ \\] display eats one newline each side", disp === "算式：<K d>x^2+1</K>所以", disp);
check("$$ $$ display, may span lines", f("$$a\n+b$$") === "<K d>a\n+b</K>");
check("display calls use displayMode", calls.length === 2 && calls.every(c => c.o.displayMode === true), calls);
check("only one newline eaten", f("a\n\n$$x$$\n\nb") === "a\n<K d>x</K>\nb", f("a\n\n$$x$$\n\nb"));
check("several formulas in a row", f("$a$ 和 $b$，还有 \\(c\\)") === "<K>a</K> 和 <K>b</K>，还有 <K>c</K>");
check("tex is passed raw, katex output not re-escaped", f("$a<b$") === "<K>a&#60;b</K>");

console.log("money is not math");
check("$3 and $4", f("Pens cost $3 and pencils $4.") === "Pens cost $3 and pencils $4.");
check("$5+$3=$8", f("$5+$3=$8") === "$5+$3=$8");
check("$ followed by space", f("I have $ 5 and $ 6") === "I have $ 5 and $ 6");
check("$12.50 each, $25 total", f("$12.50 each, so $25 total") === "$12.50 each, so $25 total");
check("inline $ never spans lines", f("$3 for one\nand 4$ more") === "$3 for one\nand 4$ more");
check("inline \\( never spans lines", f("\\(a\nb\\)") === "\\(a\nb\\)");
check("money next to real formula", f("It costs $5, so $x=5$.") === "It costs $5, so <K>x=5</K>.", f("It costs $5, so $x=5$."));
/* 复核（#59）复现的几条：中文不带空格的钱数、\$ 转义、钱数后面同一行有 $$ */
const zhMoney = f("每本书$4，设总价为$y$元");
check("zh money without spaces is skipped, the real formula after it still renders", zhMoney === "每本书$4，设总价为<K>y</K>元", zhMoney);
check("zh money pair stays text", f("一支铅笔$3，两支$6。") === "一支铅笔$3，两支$6。");
check("zh digits + formula without CJK still math", f("面积是$3\\times4=12$平方厘米") === "面积是<K>3\\times4=12</K>平方厘米");
check("math may contain Chinese when it does not start with a digit", f("$面积=3\\times4$") === "<K>面积=3\\times4</K>");
const dd = f("$5 and $$x$$");
check("money then $$display$$ on the same line", dd === "$5 and <K d>x</K>", dd);
check("\\$ is a literal dollar, never an opener", f("costs \\$5 and \\$x\\$") === "costs \\$5 and \\$x\\$");
check("closing $ escaped by a backslash is not a closer", f("The answer is $\\$5$.") === "The answer is $\\$5$.");
check("US$5 and $x$", f("US$5 and $x$") === "US$5 and <K>x</K>");
check("$5/$10 and $5-$10 stay text", f("$5/$10, $5-$10") === "$5/$10, $5-$10");
check("$12$ (a bare number) is still math", f("答案是 $12$。") === "答案是 <K>12</K>。");
check("padded formula with a command renders", f("$ \\frac{1}{2} $ 和 $ x^2 $") === "<K> \\frac{1}{2} </K> 和 <K> x^2 </K>");
check("padded plain text between dollars stays text", f("$ x = 5 $") === "$ x = 5 $");
/* 二次复核（#59）：\text{} 里的中文单位、只贴一边空白的钱数吞掉后面的公式、钱数紧跟标点 */
check("CJK units inside \\text{} still math", f("$12\\text{平方厘米}$ 和 $3\\text{个}+2\\text{个}=5\\text{个}$") === "<K>12\\text{平方厘米}</K> 和 <K>3\\text{个}+2\\text{个}=5\\text{个}</K>");
const swallow = f("It costs $5. Half is \\(\\frac{5}{2}\\) and $y$");
check("one-side-padded money does not swallow later formulas", swallow === "It costs $5. Half is <K>\\frac{5}{2}</K> and <K>y</K>", swallow);
check("… also with _ in between", f("costs $5 for item_1 and $x$") === "costs $5 for item_1 and <K>x</K>");
check("money followed by punctuation then a formula", f("$5,$x$ and $5.$y$") === "$5,<K>x</K> and $5.<K>y</K>", f("$5,$x$ and $5.$y$"));
check("CRLF around display math: both chars eaten", f("a\r\n$$x$$\r\nb") === "a<K d>x</K>b");

console.log("fallback");
check("katex error -> raw text escaped", f("看 $\\BAD<x$ 这里") === "看 $\\BAD&lt;x$ 这里");
check("no katex -> raw text", formatRichText("$x^2$ & \\(y\\)") === "$x^2$ &amp; \\(y\\)");
check("katex without renderToString -> raw", formatRichText("$x$", { katex: {} }) === "$x$");
check("katex returning empty -> raw", formatRichText("$x$", { katex: { renderToString: () => "" } }) === "$x$");
check("blank $$ $$ left alone", f("$$  $$") === "$$  $$");
check("unclosed markers left alone", f("\\(x+1 and $$y") === "\\(x+1 and $$y");

console.log("bold");
check("**bold**", f("答案是 **12**。") === "答案是 <b>12</b>。");
check("bold may wrap a formula", f("**先算 $3\\times4$**") === "<b>先算 <K>3\\times4</K></b>");
check("bold content escaped", f("**<i>x</i>**") === "<b>&lt;i&gt;x&lt;/i&gt;</b>");
check("single * untouched", f("3 * 4 = 12, a*b") === "3 * 4 = 12, a*b");
check("** with inner spaces at edges not bold", f("** x **") === "** x **");
check("bold does not span lines", f("**a\nb**") === "**a\nb**");
check("unclosed ** untouched", f("**a") === "**a");
check("** inside a formula stays math", f("$a**b$") === "<K>a**b</K>");

process.exit(summary() ? 0 : 1);
