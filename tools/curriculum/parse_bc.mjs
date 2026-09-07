#!/usr/bin/env node
/*
 * BC 大纲解析器（一次性构建工具，零依赖 Node >=18）
 *
 * 从 BC 官网课程页抓取某年级数学大纲（Big Ideas + Content 及 elaborations），
 * 生成 data/curriculum/bc/grade-N.json。英文原文 verbatim 保留，不做任何改写。
 *
 * 计划里最初设想用 python-docx 解官方 DOCX；改为解析官方网页（同一份 June 2016 内容，
 * 也是计划 §1.4 指定的核对源），理由：跟项目一样零依赖、不用装 conda/WSL 环境。
 *
 * 用法：
 *   node tools/curriculum/parse_bc.mjs --grade 4              # 抓官网
 *   node tools/curriculum/parse_bc.mjs --grade 4 --html x.html # 用已存的页面（离线/调试）
 *   node tools/curriculum/parse_bc.mjs --grade 5 --list        # 只列条目原文（补新年级主线规则前先看这个）
 *
 * 重新生成安全：已发布的 ID 不变（strand 内按官方页面顺序编号）；
 * 已有输出文件里的中文层（zh / terms / teachHints）按 ID + 英文原文匹配自动保留，
 * 英文原文有变化（大纲修订）时会大声警告并清空对应 zh，等人工重新校对。
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ---------------- 10-12 年级分科课程 ----------------
 * 官网从 10 年级起不再有「core」，而是并列多门课（FMP10 / Workplace 10；Pre-calc 11 / Foundations 11 …）。
 * 这里只收「主干」：FMP10 → Pre-calculus 11 → Pre-calculus 12（理工升学路径）。
 * 高中大纲没有五大主线，Content 是一张平的清单，所以每门课自定义「单元」（strandDefs，格式同书籍）
 * 把条目分组——UI 分组、单元测试、家长报告都按它来。每条 Content 必须在 unitRules 里有显式归属，
 * Big Idea 也按 bigIdeaUnit 挂到单元上（挂不上的留空，讲课时没有 Big Idea 也能讲）。 */
const COURSES = {
  fmp10: {
    grade: 10, code: "FMP10", slug: "foundations-of-mathematics-and-pre-calculus", version: "June 2018",
    title: { en: "Foundations of Mathematics and Pre-calculus 10", zh: "数学基础与预备微积分 10" },
    short: { en: "FMP 10", zh: "FMP 10" },
    label: "Foundations of Mathematics and Pre-calculus 10 · BC Ministry of Education · June 2018",
    units: [
      ["algebra", "ALG", "幂与多项式", "Powers & Polynomials"],
      ["relations", "REL", "函数与线性关系", "Functions & Linear Relations"],
      ["trigonometry", "TRI", "三角比", "Trigonometry"],
      ["financial", "FIN", "理财", "Financial Literacy"]
    ],
    unitRules: [
      ["operations on powers", "algebra"],
      ["prime factorization", "algebra"],
      ["multiplication of polynomial", "algebra"],
      ["polynomial factoring", "algebra"],
      ["functions and relations", "relations"],
      ["linear functions", "relations"],
      ["arithmetic sequences", "relations"],
      ["systems of linear equations", "relations"],
      ["primary trigonometric ratios", "trigonometry"],
      ["financial literacy", "financial"]
    ],
    bigIdeaUnit: [
      [/^algebra allows us to generalize/i, "algebra"],
      [/extend to powers and polynomials/i, "algebra"],
      [/constant rate of change/i, "relations"],
      [/^trigonometry involves/i, "trigonometry"],
      [/representing and analyzing situations/i, "financial"]
    ]
  },
  pc11: {
    grade: 11, code: "PC11", slug: "pre-calculus", version: "June 2018",
    title: { en: "Pre-calculus 11", zh: "预备微积分 11" },
    short: { en: "Pre-calc 11", zh: "Pre-calc 11" },
    label: "Pre-calculus 11 · BC Ministry of Education · June 2018",
    units: [
      ["number-radicals", "NUM", "实数、幂与根式", "Real Numbers, Powers & Radicals"],
      ["algebra", "ALG", "多项式与有理式", "Polynomials & Rational Expressions"],
      ["quadratics", "QUA", "二次函数与不等式", "Quadratics & Inequalities"],
      ["trigonometry", "TRI", "三角", "Trigonometry"],
      ["financial", "FIN", "理财", "Financial Literacy"]
    ],
    unitRules: [
      ["real number system", "number-radicals"],
      ["powers with rational exponents", "number-radicals"],
      ["radical operations", "number-radicals"],
      ["polynomial factoring", "algebra"],
      ["rational expressions", "algebra"],
      ["quadratic functions", "quadratics"],
      ["linear and quadratic inequalities", "quadratics"],
      ["trigonometry", "trigonometry"],
      ["financial literacy", "financial"]
    ],
    bigIdeaUnit: [
      [/^algebra allows us to generalize/i, "algebra"],
      [/powers, radicals, and polynomials/i, "number-radicals"],
      [/^quadratic relationships/i, "quadratics"],
      [/^trigonometry involves/i, "trigonometry"]
    ]
  },
  pc12: {
    grade: 12, code: "PC12", slug: "pre-calculus", version: "June 2018",
    title: { en: "Pre-calculus 12", zh: "预备微积分 12" },
    short: { en: "Pre-calc 12", zh: "Pre-calc 12" },
    label: "Pre-calculus 12 · BC Ministry of Education · June 2018",
    units: [
      ["functions", "FUN", "函数变换", "Transformations of Functions"],
      ["exponential-log", "EXP", "指数与对数", "Exponential & Logarithmic Functions"],
      ["sequences", "SEQ", "等比数列与级数", "Geometric Sequences & Series"],
      ["polynomial-rational", "POL", "多项式与有理函数", "Polynomial & Rational Functions"],
      ["trigonometry", "TRI", "三角函数", "Trigonometric Functions"]
    ],
    unitRules: [
      ["transformations of functions", "functions"],
      ["exponential functions", "exponential-log"],
      ["logarithms", "exponential-log"],
      ["geometric sequences", "sequences"],
      ["polynomial functions", "polynomial-rational"],
      ["rational functions", "polynomial-rational"],
      ["trigonometry", "trigonometry"]
    ],
    bigIdeaUnit: [
      [/^using inverses/i, "exponential-log"],
      [/families of functions/i, "polynomial-rational"],
      [/^transformations of shapes/i, "functions"]
    ]
  }
};

/* ---------------- 参数 ---------------- */
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const courseId = argVal("--course");
const COURSE = courseId ? COURSES[courseId] : null;
const grade = COURSE ? COURSE.grade : Number(argVal("--grade"));
const htmlFile = argVal("--html");
const outDir = argVal("--out") || path.join(ROOT, "data", "curriculum", "bc");
if (courseId && !COURSE) {
  console.error("不认识的课程 id：" + courseId + "（可选：" + Object.keys(COURSES).join(" / ") + "）");
  process.exit(1);
}
if (!COURSE && (!Number.isInteger(grade) || grade < 1 || grade > 9)) {
  console.error("用法：node tools/curriculum/parse_bc.mjs --grade 4 [--html saved.html] [--out dir]");
  console.error("      node tools/curriculum/parse_bc.mjs --course fmp10|pc11|pc12 [--html saved.html]   # 10-12 年级分科课程");
  process.exit(1);
}
const SOURCE_URL = COURSE
  ? `https://curriculum.gov.bc.ca/curriculum/mathematics/${grade}/${COURSE.slug}`
  : `https://curriculum.gov.bc.ca/curriculum/mathematics/${grade}/core`;
const SOURCE_VERSION = COURSE ? COURSE.version : "June 2016"; // K-9 2016 定稿至今无修订计划（见 docs/bc-curriculum-plan.md §1.1）

/* ---------------- 主线归类 ----------------
 * BC 官方不给条目编号也不在页面上标主线；按 K→9 continuous view 的五大主线归类。
 * 规则 = 条目原文前缀（归一化后 startsWith），新年级的条目必须先在这里补规则，
 * 匹配不上会硬报错——这是有意的：ID 一旦发布不再变更，归类必须是显式决定。 */
const STRAND_CODE = {
  "number": "NUM",
  "computational-fluency": "FLU",
  "patterning": "PAT",
  "geometry-measurement": "GEO",
  "data-probability": "DAT"
};
const STRAND_PREFIX_RULES = [
  // —— Grade 4 ——（financial literacy 按计划归入 number）
  ["number concepts", "number"],
  ["decimals to hundredths", "number"],
  ["ordering and comparing fractions", "number"],
  ["financial literacy", "number"],
  ["addition and subtraction of decimals", "computational-fluency"],
  ["addition and subtraction facts", "computational-fluency"],
  ["addition and subtraction to 10 000", "computational-fluency"],
  ["multiplication and division facts", "computational-fluency"],
  ["multiplication and division of two- or three-digit", "computational-fluency"],
  ["increasing and decreasing patterns", "patterning"],
  ["algebraic relationships", "patterning"],
  ["one-step equations", "patterning"],
  ["how to tell time", "geometry-measurement"],
  ["regular and irregular polygons", "geometry-measurement"],
  ["perimeter of regular and irregular", "geometry-measurement"],
  ["line symmetry", "geometry-measurement"],
  ["one-to-one correspondence", "data-probability"],
  ["probability experiments", "data-probability"],
  // —— Grade 5 ——
  ["decimals to thousandths", "number"],
  ["equivalent fractions", "number"],
  ["whole-number, fraction, and decimal benchmarks", "number"],
  ["addition and subtraction of whole numbers", "computational-fluency"],
  ["multiplication and division to three digits", "computational-fluency"],
  ["rules for increasing and decreasing patterns", "patterning"],
  ["area measurement", "geometry-measurement"],
  ["relationships between area and perimeter", "geometry-measurement"],
  ["duration", "geometry-measurement"],
  ["classification of prisms", "geometry-measurement"],
  ["single transformations", "geometry-measurement"],
  // —— Grade 6 ——
  ["small to large numbers", "number"],
  ["factors and multiples", "number"],
  ["improper fractions", "number"],
  ["introduction to ratios", "number"],
  ["whole-number percents", "number"],
  ["order of operations", "computational-fluency"],
  ["multiplication and division of decimals", "computational-fluency"],
  ["perimeter of complex shapes", "geometry-measurement"],
  ["area of triangles", "geometry-measurement"],
  ["angle measurement", "geometry-measurement"],
  ["volume and capacity", "geometry-measurement"],
  ["triangles", "geometry-measurement"],
  ["combinations of transformations", "geometry-measurement"],
  ["line graphs", "data-probability"],
  ["single-outcome probability", "data-probability"],
  // —— Grade 7 ——（operations with integers/decimals 归运算主线，对应其 Big Idea）
  ["operations with integers", "computational-fluency"],
  ["operations with decimals", "computational-fluency"],
  ["relationships between decimals", "number"],
  ["discrete linear relations", "patterning"],
  ["two-step equations", "patterning"],
  ["circumference and area", "geometry-measurement"],
  ["volume of rectangular prisms", "geometry-measurement"],
  ["cartesian coordinates", "geometry-measurement"],
  ["circle graphs", "data-probability"],
  ["experimental probability", "data-probability"],
  // —— Grade 8 ——（官方 K-9 continuous view（July 2019）把 expressions / two-step equations 放在
  // computational fluency、financial literacy 放在 data；本项目沿用 G4-G7 已发布的归法：
  // 代数类条目归 patterning（和 G7 two-step equations 一致）、financial literacy 归 number）
  ["perfect squares and cubes", "number"],
  ["square and cube roots", "number"],
  ["percents less than 1", "number"],
  ["numerical proportional reasoning", "number"],
  ["operations with fractions", "computational-fluency"],
  ["expressions", "patterning"],
  ["surface area and volume", "geometry-measurement"],
  ["pythagorean theorem", "geometry-measurement"],
  ["construction, views, and nets", "geometry-measurement"],
  ["central tendency", "data-probability"],
  ["theoretical probability", "data-probability"],
  // —— Grade 9 ——（同上：多项式、多步方程这些代数条目归 patterning）
  ["operations with rational numbers", "computational-fluency"],
  ["exponents and exponent laws", "number"],
  ["operations with polynomials", "patterning"],
  ["two-variable linear relations", "patterning"],
  ["multi-step one-variable linear equations", "patterning"],
  ["spatial proportional reasoning", "geometry-measurement"],
  ["statistics in society", "data-probability"]
];
/* Big Idea 的主线：官网每条大意的 elaboration 第一条就是主线名（"Number: …"），直接认它 */
const BIG_IDEA_STRAND = [
  [/^number\b/i, "number"],
  [/^computational fluency\b/i, "computational-fluency"],
  [/^patterning\b/i, "patterning"],
  [/^geometry and measurement\b/i, "geometry-measurement"],
  [/^data and probability\b/i, "data-probability"]
];

/* ---------------- HTML 小工具（机器生成的规整 HTML，不需要完整 DOM） ---------------- */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”").replace(/&ldquo;/g, "“");
}
function clean(html) {
  return decodeEntities(String(html)
    .replace(/<sup[^>]*>\s*([\s\S]*?)\s*<\/sup>/gi, "^$1")   // 上标转 ^（2² → 2^2、cm³ → cm^3）
    .replace(/<[^>]+>/g, " "))
    .replace(/[\s ]+/g, " ")
    // 弹窗 <a>/<div> 拆开原文留下的空格残留（如 "fluency )"、"patterns ,"），并非改写原文
    .replace(/\s+([,;.!?)\]])/g, "$1").replace(/([([])\s+/g, "$1")
    .trim();
}
/* 归一化：只用于匹配（主线规则 / 中文层对齐），输出仍是原文 */
function norm(s) {
  return clean(s).toLowerCase().replace(/[—–]/g, "-").replace(/\s+/g, " ");
}

/* 找到从 from 开始的第一个 <ul>…</ul>（按嵌套深度配对） */
function matchUl(s, from) {
  const open = s.indexOf("<ul", from);
  if (open < 0) return null;
  const re = /<\/?ul\b[^>]*>/gi;
  re.lastIndex = open;
  let depth = 0, m;
  while ((m = re.exec(s))) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return { start: open, end: re.lastIndex, inner: s.slice(s.indexOf(">", open) + 1, m.index) };
  }
  return null;
}
/* 把 <ul> 内层拆成顶层 <li> 块（块内可含嵌套 ul） */
function topLis(ulInner) {
  const out = [];
  const re = /<\/?(ul|li)\b[^>]*>/gi;
  let depth = 0, liStart = -1, m;
  while ((m = re.exec(ulInner))) {
    const tag = m[1].toLowerCase(), closing = m[0][1] === "/";
    if (tag === "ul") depth += closing ? -1 : 1;
    else if (depth === 0) {
      if (!closing && liStart < 0) liStart = re.lastIndex;
      else if (closing && liStart >= 0) { out.push(ulInner.slice(liStart, m.index)); liStart = -1; }
    }
  }
  return out;
}
/* li 块 -> {text, children[]}：own text = 去掉嵌套 ul 后的文本 */
function parseLi(liHtml) {
  const children = [];
  let rest = liHtml, ul;
  while ((ul = matchUl(rest, 0))) {
    for (const kid of topLis(ul.inner)) children.push(parseLi(kid));
    rest = rest.slice(0, ul.start) + " " + rest.slice(ul.end);
  }
  return { text: clean(rest), children };
}
/* elaboration <ul> -> 扁平条目：有子项的写成 "父项: 子1; 子2"（喂提示词好用） */
function flattenNode(n) {
  if (/sample questions to support inquiry/i.test(n.text)) return null;
  if (!n.children.length) return n.text;
  const kids = n.children.map(flattenNode).filter(Boolean);
  return (n.text.replace(/[:：]\s*$/, "") + (n.text ? ": " : "") + kids.join("; ")).trim();
}
function parseElabUl(ulHtml) {
  const ul = matchUl(ulHtml, 0);
  if (!ul) return [];
  return topLis(ul.inner).map(li => flattenNode(parseLi(li))).filter(Boolean);
}

/* ---------------- 页面切片 ---------------- */
function sliceSection(html, title) {
  const h2 = new RegExp(`<h2 lang="en"[^>]*>\\s*${title}\\s*</h2>`, "i").exec(html);
  if (!h2) throw new Error(`页面里找不到 ${title} 段落——官网改版了？`);
  const from = h2.index + h2[0].length;
  const next = /<h2 lang="en"/g;
  next.lastIndex = from;
  const m = next.exec(html);
  // 跳过紧跟着的法语 <h2 lang="fr">，向后找下一个英文 h2 作为边界
  let end = html.length;
  if (m) end = m.index;
  return html.slice(from, end);
}
/* 一个 grouping 里的行：每行是一条大意/内容，正文在 field-content span 里 */
function sectionRows(sectionHtml) {
  const rows = [];
  const parts = sectionHtml.split(/<div class="views-row/).slice(1);
  for (const p of parts) {
    // 行里有个空的 competency-stem field-content，取最后一个（正文那个）
    const spans = [...p.matchAll(/<span class="field-content">/g)];
    if (!spans.length) continue;
    const start = spans[spans.length - 1].index + spans[spans.length - 1][0].length;
    const end = p.indexOf("</span>", start);
    if (end < 0) continue;
    rows.push(p.slice(start, end));
  }
  return rows;
}
const ELAB_RE = /<div class="alert alert-dismissible alert-info elaboration[^"]*">([\s\S]*?)<\/div>/g;
/* 行 -> {text（去掉弹窗后的原文）, elabs[]（弹窗内容）} */
function parseRow(rowHtml) {
  const elabs = [];
  const text = clean(rowHtml.replace(ELAB_RE, (_, inner) => { elabs.push(inner); return " "; }));
  return { text, elabs };
}

/* ---------------- 主流程 ---------------- */
async function loadHtml() {
  if (htmlFile) return fs.readFileSync(htmlFile, "utf8");
  console.log("抓取 " + SOURCE_URL + " …");
  const r = await fetch(SOURCE_URL, { headers: { "user-agent": "Mozilla/5.0 (curriculum data build; yuanyuan-math)" } });
  if (!r.ok) throw new Error("抓取失败 HTTP " + r.status);
  return await r.text();
}

/* 主线（K-9）/ 单元（10-12 分科课）归类：规则都是条目原文前缀，匹配不上硬报错 */
const UNIT_DEFS = COURSE ? COURSE.units : null;                       // [slug, code, zh, en]
const STRAND_ORDER = COURSE ? UNIT_DEFS.map(u => u[0]) : Object.keys(STRAND_CODE);
const strandCode = s => COURSE ? UNIT_DEFS.find(u => u[0] === s)[1] : STRAND_CODE[s];
function strandOf(itemText) {
  const n = norm(itemText);
  const rules = COURSE ? COURSE.unitRules : STRAND_PREFIX_RULES;
  for (const [prefix, strand] of rules) if (n.startsWith(norm(prefix))) return strand;
  throw new Error(COURSE
    ? `条目没有单元归类规则（在 COURSES.${courseId}.unitRules 补）：
  "${itemText}"`
    : `条目没有主线归类规则（新年级要先在 STRAND_PREFIX_RULES 补规则）：
  "${itemText}"`);
}

function bigIdeaStrand(text, elabFlat) {
  if (COURSE) {
    for (const [re, unit] of COURSE.bigIdeaUnit) if (re.test(text)) return unit;
    return "";                                   // 高中的大意不一定对应某个单元，允许空
  }
  const first = (elabFlat[0] || "");
  for (const [re, strand] of BIG_IDEA_STRAND) if (re.test(first)) return strand;
  return null;
}

const html = await loadHtml();
const bigRows = sectionRows(sliceSection(html, "Big Ideas")).map(parseRow);
const contentRows = sectionRows(sliceSection(html, "Content")).map(parseRow);
if (!bigRows.length || !contentRows.length) throw new Error("解析出 0 条——官网结构变了？");

if (args.includes("--list")) {
  console.log(`Grade ${grade} Big Ideas（${bigRows.length} 条）：`);
  for (const r of bigRows) console.log("  · " + r.text);
  console.log(`Grade ${grade} Content（${contentRows.length} 条，含 elaborations 数）：`);
  for (const r of contentRows) console.log(`  · [${r.elabs.length}] ` + r.text);
  process.exit(0);
}

/* 旧文件：保留人工中文层 */
const outFile = path.join(outDir, COURSE ? `course-${courseId}.json` : `grade-${grade}.json`);
let prev = null;
try { prev = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch (_) {}
const prevItems = new Map((prev && prev.items || []).map(it => [it.id, it]));
const prevBig = new Map((prev && prev.bigIdeas || []).map(b => [b.strand + "|" + b.en, b]));
const warnings = [];

const bigIdeas = bigRows.map((r, i) => {
  const flat = r.elabs.length ? parseElabUl(r.elabs[0]) : [];
  let strand = bigIdeaStrand(r.text, flat);
  if (strand === null) {
    // 按官网行序回退——依赖 STRAND_CODE 的键序，不一定对，必须人工核对
    strand = Object.keys(STRAND_CODE)[i] || "number";
    warnings.push(`Big Idea 第 ${i + 1} 行没匹配到主线关键词，按行序回退为 ${strand}，请核对：\n  ${r.text}`);
  }
  if (COURSE && !strand) warnings.push(`Big Idea 第 ${i + 1} 行没挂到任何单元（bigIdeaUnit 没规则），讲课时这条大意用不上：\n  ${r.text}`);
  // 原文一字不差才沿用旧 zh（高中一个单元可能挂多条大意，所以按 单元+原文 对）；变了就清空待重校
  const old = prevBig.get(strand + "|" + r.text);
  const zh = old ? (old.zh || "") : "";
  if (!old && prev) {
    const same = (prev.bigIdeas || []).find(b => b.strand === strand && !bigRows.some(x => x.text === b.en));
    if (same) warnings.push(`Big Idea (${strand}) 英文原文变了，zh 已清空待重校：\n  旧: ${same.en}\n  新: ${r.text}`);
  }
  return { strand, en: r.text, zh };
});

const counters = {};
const items = contentRows.map(r => {
  const strand = strandOf(r.text);
  const nn = counters[strand] = (counters[strand] || 0) + 1;
  const id = `BC.MATH.${COURSE ? COURSE.code : "G" + grade}.${strandCode(strand)}.${String(nn).padStart(2, "0")}`;
  const elaborations = r.elabs.flatMap(e => parseElabUl(e)).map(en => ({ en, zh: "" }));
  const item = { id, strand, en: r.text, zh: "", elaborations, terms: [], teachHints: "" };
  const old = prevItems.get(id);
  if (old) {
    if (norm(old.en) === norm(item.en)) {
      item.zh = old.zh || "";
      item.terms = old.terms || [];
      item.teachHints = old.teachHints || "";
      const oldElab = new Map((old.elaborations || []).map(e => [norm(e.en), e.zh]));
      for (const e of item.elaborations) e.zh = oldElab.get(norm(e.en)) || "";
    } else {
      warnings.push(`${id} 英文原文变了，中文层已清空待重校：\n  旧: ${old.en}\n  新: ${item.en}`);
    }
  }
  return item;
});

const out = COURSE ? {
  jurisdiction: "BC",
  type: "course",                  // server 按这个字段认分科课程（和书籍的 type:"book" 并列）
  courseId,
  grade,
  title: COURSE.title,
  short: COURSE.short,
  source: {
    kind: "bc-course",
    url: SOURCE_URL,
    version: SOURCE_VERSION,
    label: COURSE.label,
    fetchedAt: new Date().toISOString().slice(0, 10)
  },
  strandDefs: UNIT_DEFS.map(([slug, , zh, en]) => [slug, zh, en]),
  bigIdeas,
  items
} : {
  jurisdiction: "BC",
  grade,
  source: {
    url: SOURCE_URL,
    version: SOURCE_VERSION,
    fetchedAt: new Date().toISOString().slice(0, 10)
  },
  bigIdeas,
  items
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");

/* ---------------- 验收报告（对应计划 §1.4） ---------------- */
console.log(`\n✔ 写入 ${path.relative(ROOT, outFile)}`);
console.log(`  Big Ideas: ${bigIdeas.length} 条（主线：${bigIdeas.map(b => b.strand).join(", ")}）`);
const [lo, hi] = COURSE ? [6, 12] : [8, 20];
console.log(`  Content:   ${items.length} 条（预期 ${lo}-${hi}）`);
for (const strand of STRAND_ORDER) {
  const n = items.filter(it => it.strand === strand).length;
  console.log(`    ${strandCode(strand)}  ${strand}: ${n} 条${n ? "" : "  ⚠ 空主线！"}`);
}
console.log("  spot check（前 3 条原文）：");
for (const it of items.slice(0, 3)) console.log(`    ${it.id}  ${it.en}`);
const missingZh = items.filter(it => !it.zh).length;
if (missingZh) console.log(`  ⚠ ${missingZh} 条缺中文层（zh 为空），等 AI 辅助翻译 + 人工校对后补进文件。`);
for (const w of warnings) console.log("  ⚠ " + w);
if (items.length < lo || items.length > hi) {
  console.log(`  ⚠ 条目数超出 ${lo}-${hi} 预期范围（K-9 每年级 8-19 条，10-12 分科课 7-10 条），检查解析是否正确！`);
  process.exitCode = 2;
}
