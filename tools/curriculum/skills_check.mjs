#!/usr/bin/env node
/* 技能图谱草稿（data/curriculum/skills/）的校验器 + 目录树生成器。
 *
 *   node tools/curriculum/skills_check.mjs          # 校验 + 统计；有错误时退出码 1
 *   node tools/curriculum/skills_check.mjs --md     # 额外打印 Markdown 目录树（贴进 docs 用）
 *   node tools/curriculum/skills_check.mjs --dot    # 打印先修关系的 Graphviz dot（可选）
 *
 * 校验什么（设计见 docs/skill-graph-plan.md）：
 *   - 技能 id 文法 YY.MATH.<FAMILY>.<...>，全局唯一；topic 在本文件内唯一
 *   - 每条技能的 primary 标准必须存在于 data/curriculum/bc/grade-N.json，且属于它所在 topic 的 standards
 *   - prereq / topic.review / diag.branch 目标都必须是存在的技能；先修图无环；不允许先修指向更高年级
 *   - misc[] 与 diag.branch 的 key 必须在 misconceptions.json 登记；登记表的 remedy 必须是存在的技能
 *   - 覆盖率：G4–G7 每条 BC 标准至少有 1 条 primary 技能
 * 零依赖，只用 node 内置模块。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_DIR = path.join(ROOT, "data", "curriculum", "skills");
const BC_DIR = path.join(ROOT, "data", "curriculum", "bc");
const args = new Set(process.argv.slice(2));

const TYPES = new Set(["concept", "represent", "procedure", "reason", "apply", "fluency"]);
const ID_RE = /^YY\.MATH\.[A-Z0-9]+(\.[A-Z0-9_]+){1,3}$/;

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* ---- 读 BC 标准 ---- */
const standards = new Map();            // id -> { grade, strand, en, zh }
const hintTokens = new Set();
for (const f of fs.readdirSync(BC_DIR)) {
  const m = /^grade-(\d+)\.json$/.exec(f);
  if (!m) continue;
  const d = JSON.parse(fs.readFileSync(path.join(BC_DIR, f), "utf8"));
  for (const it of d.items || []) {
    standards.set(it.id, { grade: d.grade, strand: it.strand, en: it.en, zh: it.zh });
    for (const t of String(it.teachHints || "").match(/[A-Za-z]+/g) || []) hintTokens.add(t);
  }
}

/* ---- 读技能文件 ---- */
const files = fs.readdirSync(SKILLS_DIR).filter(f => /^g\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const grades = [];                      // [{ grade, file, topics, skills }]
const skills = new Map();               // id -> skill (+ grade, file)
const topics = new Map();               // "g5/equivalent-fractions" -> topic
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
  const g = Number(/^g(\d+)\.json$/.exec(f)[1]);
  if (d.schema !== "yy-skills/1") err(`${f}: schema 应为 yy-skills/1`);
  if (d.grade !== g) err(`${f}: grade 字段 (${d.grade}) 与文件名不符`);
  const seenTopics = new Set();
  for (const t of d.topics || []) {
    if (seenTopics.has(t.id)) err(`${f}: topic 重复 ${t.id}`);
    seenTopics.add(t.id);
    topics.set(`g${g}/${t.id}`, { ...t, grade: g });
    for (const s of t.standards || []) if (!standards.has(s)) err(`${f}: topic ${t.id} 引用不存在的标准 ${s}`);
    if (!(t.standards || []).length) warn(`${f}: topic ${t.id} 没有挂任何标准`);
  }
  for (const s of d.skills || []) {
    if (!ID_RE.test(s.id)) err(`${f}: 技能 id 不合文法 ${s.id}`);
    if (skills.has(s.id)) err(`${f}: 技能 id 重复 ${s.id}（另见 ${skills.get(s.id).file}）`);
    skills.set(s.id, { ...s, grade: g, file: f });
    if (!seenTopics.has(s.topic)) err(`${f}: ${s.id} 的 topic ${s.topic} 不存在`);
    if (!TYPES.has(s.type)) err(`${f}: ${s.id} 的 type 非法 ${s.type}`);
    if (!s.en || !s.zh) err(`${f}: ${s.id} 缺 en/zh 标题`);
    if (!standards.has(s.primary)) err(`${f}: ${s.id} 的 primary 标准不存在 ${s.primary}`);
    for (const x of s.supporting || []) if (!standards.has(x)) err(`${f}: ${s.id} 的 supporting 标准不存在 ${x}`);
    for (const h of String(s.hints || "").match(/[A-Za-z]+/g) || []) if (!hintTokens.has(h)) warn(`${f}: ${s.id} 的配图提示 ${h} 不在现有 teachHints 词表里`);
  }
  grades.push({ grade: g, file: f, topics: d.topics || [], skills: d.skills || [] });
}

/* ---- 误区登记表 ---- */
const miscFile = path.join(SKILLS_DIR, "misconceptions.json");
const misc = new Map();
if (fs.existsSync(miscFile)) {
  const d = JSON.parse(fs.readFileSync(miscFile, "utf8"));
  for (const m of d.items || []) {
    if (misc.has(m.id)) err(`misconceptions.json: id 重复 ${m.id}`);
    misc.set(m.id, m);
  }
} else warn("没有 misconceptions.json");

/* ---- 交叉引用 ---- */
for (const [key, t] of topics) {
  for (const r of t.review || []) {
    if (!skills.has(r)) err(`${key}: review 引用不存在的技能 ${r}`);
    else if (skills.get(r).grade >= t.grade) warn(`${key}: review 技能 ${r} 不是更低年级的`);
  }
}
for (const s of skills.values()) {
  const topic = topics.get(`g${s.grade}/${s.topic}`);
  if (topic && !(topic.standards || []).includes(s.primary)) warn(`${s.file}: ${s.id} 的 primary ${s.primary} 不在 topic ${s.topic} 的 standards 里`);
  for (const p of s.prereq || []) {
    if (p === s.id) err(`${s.file}: ${s.id} 先修指向自己`);
    else if (!skills.has(p)) err(`${s.file}: ${s.id} 的先修不存在 ${p}`);
    else if (skills.get(p).grade > s.grade) err(`${s.file}: ${s.id} 的先修 ${p} 在更高年级（G${skills.get(p).grade}）`);
  }
  for (const m of s.misc || []) if (!misc.has(m)) err(`${s.file}: ${s.id} 的误区 ${m} 未登记`);
  if (s.diag) {
    for (const [k, target] of Object.entries(s.diag.branch || {})) {
      if (!misc.has(k)) err(`${s.file}: ${s.id} diag.branch 的误区 ${k} 未登记`);
      if (!skills.has(target)) err(`${s.file}: ${s.id} diag.branch 目标技能不存在 ${target}`);
    }
    for (const e of s.diag.entry || []) if (![1, 2, 3].includes(e.level)) err(`${s.file}: ${s.id} diag.entry level 非法`);
    /* rep[0] 就是 L1 出题用的表示（设计文档 §3.3）。诊断**如果**有 L1 入口题，必须用同一种表示，
     * 否则出题提示词和诊断入口会各说各的。注意不少技能没有 L1 入口（apply/reason 类从 L2/L3
     * 情境起步，23 个试点里有 13 个）——那是设计使然，这里不强求补 L1。 */
    const e1 = (s.diag.entry || []).find(e => e.level === 1);
    if (e1 && e1.rep !== (s.rep || [])[0]) err(`${s.file}: ${s.id} rep[0]=${(s.rep || [])[0]} 与 diag 的 L1 表示 ${e1.rep} 不一致`);
  }
  if (!(s.rep || []).length) err(`${s.file}: ${s.id} 没有 rep（L1 出题不知道该用哪种表示）`);
  for (const r of s.rep || []) {
    if (!/^[a-zA-Z]+$/.test(r)) err(`${s.file}: ${s.id} rep 值不合法 ${r}`);
  }
}
for (const m of misc.values()) if (m.remedy && !skills.has(m.remedy)) err(`misconceptions.json: ${m.id} 的 remedy 技能不存在 ${m.remedy}`);
const usedMisc = new Set();
for (const s of skills.values()) { for (const m of s.misc || []) usedMisc.add(m); for (const k of Object.keys((s.diag || {}).branch || {})) usedMisc.add(k); }
for (const id of misc.keys()) if (!usedMisc.has(id)) warn(`misconceptions.json: ${id} 没有任何技能引用`);

/* ---- 先修图无环（DFS） ---- */
{
  const state = new Map();   // 0 visiting, 1 done
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 1) return;
    if (state.get(id) === 0) { err(`先修成环：${[...stack.slice(stack.indexOf(id)), id].join(" → ")}`); return; }
    state.set(id, 0); stack.push(id);
    for (const p of (skills.get(id) || {}).prereq || []) if (skills.has(p)) visit(p);
    stack.pop(); state.set(id, 1);
  };
  for (const id of skills.keys()) visit(id);
}

/* ---- 覆盖率 ---- */
const primaryCount = new Map();
const anyCount = new Map();
for (const s of skills.values()) {
  primaryCount.set(s.primary, (primaryCount.get(s.primary) || 0) + 1);
  anyCount.set(s.primary, (anyCount.get(s.primary) || 0) + 1);
  for (const x of s.supporting || []) anyCount.set(x, (anyCount.get(x) || 0) + 1);
}
const coveredGrades = new Set(grades.map(g => g.grade));
const uncovered = [...standards.entries()].filter(([id, st]) => coveredGrades.has(st.grade) && !primaryCount.get(id)).map(([id]) => id);
for (const id of uncovered) err(`标准 ${id} 没有任何 primary 技能`);

/* ---- 输出 ---- */
const pad = (s, n) => String(s).padEnd(n);
console.log(`标准文件：${standards.size} 条（G${[...new Set([...standards.values()].map(s => s.grade))].sort((a, b) => a - b).join("/G")}）`);
console.log(`技能文件：${files.join(", ")}；误区登记 ${misc.size} 条`);
console.log("");
console.log(pad("年级", 6) + pad("标准", 6) + pad("主题", 6) + pad("技能", 6) + pad("核心", 6) + pad("每标准", 8) + "类型分布");
let totalSkills = 0, totalStd = 0;
for (const g of grades) {
  const stdN = [...standards.values()].filter(s => s.grade === g.grade).length;
  const core = g.skills.filter(s => s.core !== false).length;
  const byType = {};
  for (const s of g.skills) byType[s.type] = (byType[s.type] || 0) + 1;
  totalSkills += g.skills.length; totalStd += stdN;
  console.log(pad("G" + g.grade, 6) + pad(stdN, 6) + pad(g.topics.length, 6) + pad(g.skills.length, 6) + pad(core, 6) + pad((g.skills.length / stdN).toFixed(1), 8)
    + Object.entries(byType).map(([k, v]) => `${k} ${v}`).join("、"));
}
console.log(pad("合计", 6) + pad(totalStd, 6) + pad(grades.reduce((n, g) => n + g.topics.length, 0), 6) + pad(totalSkills, 6) + pad([...skills.values()].filter(s => s.core !== false).length, 6) + pad((totalSkills / totalStd).toFixed(1), 8));
const edges = [...skills.values()].reduce((n, s) => n + (s.prereq || []).length, 0);
const cross = [...skills.values()].reduce((n, s) => n + (s.prereq || []).filter(p => skills.has(p) && skills.get(p).grade < s.grade).length, 0);
console.log(`先修边：${edges} 条（跨年级 ${cross} 条，平均每技能 ${(edges / totalSkills).toFixed(1)} 条）；带 diag 的试点技能：${[...skills.values()].filter(s => s.diag).length}`);
{
  const counts = [...primaryCount.values()];
  const byStd = [...standards.keys()].filter(id => coveredGrades.has(standards.get(id).grade)).map(id => [id, primaryCount.get(id) || 0]);
  const min = byStd.reduce((a, b) => a[1] <= b[1] ? a : b);
  const max = byStd.reduce((a, b) => a[1] >= b[1] ? a : b);
  console.log(`每条标准的 primary 技能数：最少 ${min[1]}（${min[0]}），最多 ${max[1]}（${max[0]}），均值 ${(counts.reduce((a, b) => a + b, 0) / byStd.length).toFixed(1)}`);
}
console.log("");
if (warnings.length) { console.log(`警告 ${warnings.length} 条：`); for (const w of warnings) console.log("  - " + w); console.log(""); }
if (errors.length) { console.log(`错误 ${errors.length} 条：`); for (const e of errors) console.log("  ✗ " + e); }
else console.log("校验通过 ✓");

/* ---- Markdown 目录树 ---- */
if (args.has("--md")) {
  const TYPE_ZH = { concept: "概念", represent: "表示", procedure: "步骤", reason: "推理", apply: "应用", fluency: "熟练" };
  const out = [];
  for (const g of grades) {
    out.push(`### G${g.grade}（${g.topics.length} 个主题 · ${g.skills.length} 个技能）`, "");
    for (const t of g.topics) {
      const stds = (t.standards || []).map(id => `\`${id.replace("BC.MATH.", "")}\``).join(" ");
      out.push(`**${t.zh} · ${t.en}**　${stds}${t.pilot ? "　🧪 试点" : ""}`, "");
      const list = g.skills.filter(s => s.topic === t.id);
      for (const s of list) {
        const flags = [TYPE_ZH[s.type] || s.type, s.core === false ? "拓展" : null, s.diag ? "诊断" : null].filter(Boolean).join("·");
        out.push(`- \`${s.id.replace("YY.MATH.", "")}\` ${s.zh} / ${s.en} 〔${flags}〕`);
      }
      for (const r of t.review || []) {
        const s = skills.get(r);
        if (s) out.push(`- ↻ \`${r.replace("YY.MATH.", "")}\` ${s.zh} / ${s.en} 〔复习 · 来自 G${s.grade}〕`);
      }
      out.push("");
    }
  }
  console.log("\n" + out.join("\n"));
}

/* ---- Graphviz ---- */
if (args.has("--dot")) {
  const lines = ["digraph skills {", "  rankdir=LR; node [shape=box, fontsize=9];"];
  for (const s of skills.values()) for (const p of s.prereq || []) lines.push(`  "${p.replace("YY.MATH.", "")}" -> "${s.id.replace("YY.MATH.", "")}";`);
  lines.push("}");
  console.log("\n" + lines.join("\n"));
}

process.exit(errors.length ? 1 : 0);
