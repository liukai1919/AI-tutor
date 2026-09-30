/*
 * TeachingBrief（#43，#8 子任务 A）：英文出题器和审稿器共用的一份确定性「教学要求」。
 *
 * 纯函数：不读文件、不读全局配置、不碰孩子数据、不调模型。所有事实由调用方注入——
 *   server.js 的 qbankBriefFor() 读已跟踪的课程图谱 / 课文 / 图形契约，把原文、相对路径交进来。
 * 规矩：
 *   - 只记录输入里真有的东西，不替模型编标准、编学习目标、编「孩子学过什么」；缺什么就写缺。
 *   - 课文文件存在 ≠ 人工审过：humanReview 一律 "unknown"，只记生成来源（provider / at）。
 *   - outOfScope 来自技能图谱的先修边（谁把本技能列为先修），是课程结构事实，不是对某个孩子的判断；
 *     文件里的先后顺序不作为「还没学」的证据。
 *   - briefHash = sha256(规范化 JSON)，课文原文 / 契约原文 / 规则文本 / 技能数据任一变化都会变。
 *     生成器和审稿器各自渲染同一个冻结对象（renderGeneratorBrief / renderJudgeBrief），都印同一个 briefId。
 */
"use strict";

const crypto = require("crypto");

const BRIEF_KIND = "yy-teaching-brief";
const BRIEF_VERSION = 1;

/* 规则文本：出题器和审稿器都从这里读。改一个字 rules.hash 就变，briefHash 跟着变。
 * 难度三级的措辞和 docs/qbank-standard.md §2 / 旧 en 提示词一致；题图规则对应 §7。 */
const DEFAULT_RULES = {
  version: "qbank-en-rules/1",
  levels: {
    1: "Level 1 (warm-up): one step, direct use of the concept just taught; short stem, no or minimal context. Checks \"did you get it\".",
    2: "Level 2 (level-up): standard textbook difficulty, 1-2 steps, a small real-life context or choosing the right method. Checks \"can you use it\".",
    3: "Level 3 (challenge): FSA-style — a real-life scenario needing at least two reasoning steps, or a question built around the most common misconception in this topic. Checks \"is it solid\"."
  },
  l3SpotMistakeMax: 2,
  textOnly: "Every question must be answerable from its own text plus its own \"visual\" (if it carries one). Never refer to a picture, graph, chart or diagram that the question does not carry.",
  visual: [
    "A question picture is optional. Use one only when reading the picture is part of the skill; concept questions (which graph to choose, what an angle measures) get none.",
    "\"visual\" has exactly the fields type, nums, labels (optional), caption, step (optional) — the same shape as a lesson picture; nums and labels follow the convention of that type.",
    "caption is required: a short title of what the picture shows.",
    "Move the data into the picture: once nums carry the data, delete the sentence in the stem that recites it (no \"the table of values is:\" / \"the plotted points are:\").",
    "The picture must not print the answer. In quiz mode stat graphs show no value labels and fraction pictures show no n/d; do not put the answer in the caption either.",
    "Give step when the question depends on how much one grid space (stat graphs) or one symbol (pictograph) stands for.",
    "Never write internal picture type names (such as statBar or pieChart) in the stem, options or explanation.",
    "Do not change the answer or the difficulty to fit a picture. Extra context data may be added to make a sensible picture; keep it away from the numbers in the options.",
    "A double bar graph needs at least 3 categories."
  ]
};

/* 低年级（G1–G3）规则（#74）：6–9 岁的孩子还在学认字，「FSA 风格两步推理」那套难度话术不适用。
 * 只在条目年级是 1–3 的技能 / 大纲条目上生效；G4 以上仍是 DEFAULT_RULES 原样，brief 哈希不变。
 * 题图规则和 textOnly 与 DEFAULT_RULES 同一份文本。 */
const PRIMARY_RULES = {
  version: "qbank-en-rules/1-primary",
  levels: {
    1: "Level 1 (warm-up): one step, direct use of the idea just taught; one short sentence with no story, or a one-line story. Checks \"did you get it\".",
    2: "Level 2 (level-up): one step inside a small everyday story, or choosing the right way to do it. Checks \"can you use it\".",
    3: "Level 3 (challenge): a little more thinking — a two-step story with small numbers, a missing number to find, or a question built around the most common mistake in this skill. Checks \"is it solid\"."
  },
  l3SpotMistakeMax: 1,
  young: [
    "The child is 6 to 9 years old and is still learning to read (or has the question read aloud). Write short, plain sentences with everyday words: at most two sentences before the question in Grade 1, at most three in Grades 2 and 3.",
    "Keep every number inside the range this grade works in — Grade 1: to 20, Grade 2: to 100, Grade 3: to 1000 — unless the skill itself names bigger numbers (such as counting dimes by 10s).",
    "Nothing from later grades: no multiplication or division before Grade 3, no fractions before Grade 3, no decimals, no negative numbers, no percent. Money is whole dollars or whole cents (never $1.25).",
    "Keep options short: a number, a word, or a few words. In a \"spot the mistake\" question each option is one short sentence.",
    "explain: one or two short sentences that a young child can follow when they are read aloud."
  ],
  textOnly: DEFAULT_RULES.textOnly,
  visual: DEFAULT_RULES.visual
};
const isPrimaryGrade = g => Number.isInteger(g) && g >= 1 && g <= 3;

/* ---------- 规范化与哈希 ---------- */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const canonicalJson = v => JSON.stringify(canonical(v));
const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");
/* 课文 / 契约按原文算哈希；只把 CRLF 统一成 LF，免得同一份文件在 Windows 检出后哈希不同 */
const textHash = raw => sha256(String(raw).replace(/\r\n/g, "\n"));
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const str = v => (v == null ? "" : String(v)).trim();
/* 深拷贝再整棵冻结：交给外部回调（审稿）看的快照，回调改不动我们要入库的那份 */
const frozenCopy = v => deepFreeze(JSON.parse(JSON.stringify(v)));

/* ---------- 各部分 ---------- */
/* 契约里一种图型的规格能不能拿来当硬校验：渲染端 checkVisual 遇到没有 check 的规格会放行（拿不到规则就别乱拦），
 * 出题链不能继承这个放行——规格残缺的图型当作不可用，带这种图的题一律拒。
 * 显式 check:[]（或 unchecked:true）是契约自己声明「不设限制」，照契约来。 */
/* 每种规则的参数形状（只看形状，不重写规则怎么判——判定仍全在 public/visual-check.js）。
 * checkVisual 对 NaN 的比较一律「不越界」：min:"abc" 这种参数会让规则形同虚设，所以形状不对就当规格残缺。
 * 表里没有的规则名同样算残缺（checkVisual 遇到也会拒，这里提前说清楚是契约的问题）。 */
const INT = "int", NUM = "num", NUM_OR_NULL = "numOrNull", INTS = "ints", INTS_OR_ALL = "intsOrAll", BOOL = "bool";
const RULE_SHAPES = {
  lenIn: { req: { values: INTS } },
  int: { req: { idx: INTS_OR_ALL } },
  range: { req: { idx: INT }, opt: { min: NUM_OR_NULL, max: NUM_OR_NULL } },
  rangeAll: { req: { from: INT }, opt: { min: NUM_OR_NULL, max: NUM_OR_NULL } },
  positive: { req: { from: INT } },
  le: { req: { idx: INT, ofIdx: INT } },
  lt: { req: { idx: INT, ofIdx: INT } },
  inSpan: { req: { idx: INTS } },
  wholes: { req: { numIdx: INT, denIdx: INT, max: NUM } },
  count: { req: { max: NUM }, opt: { min: NUM } },
  sum: { req: { max: NUM } },
  snapFrac: { req: { denIdx: INT, minIdx: INT, ptIdx: INTS } },
  statSeries: { req: { max: NUM }, opt: { min: NUM, allowNeg: BOOL } },
  stepFits: { req: { maxSpaces: NUM } },
  pictoSymbols: { req: { max: NUM } }
};
const isInt = v => Number.isInteger(v) && v >= 0;
const shapeOk = (kind, v) => {
  switch (kind) {
    case INT: return isInt(v);
    case NUM: return typeof v === "number" && Number.isFinite(v);
    case NUM_OR_NULL: return v === null || (typeof v === "number" && Number.isFinite(v));
    case INTS: return Array.isArray(v) && v.length > 0 && v.every(isInt);
    case INTS_OR_ALL: return v === "all" || (Array.isArray(v) && v.length > 0 && v.every(isInt));
    case BOOL: return typeof v === "boolean";
    default: return false;
  }
};
function ruleProblem(r) {
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.t !== "string" || !r.t) return "has no rule name";
  const shape = RULE_SHAPES[r.t];
  if (!shape) return `"${r.t}" is not a rule the checker implements`;
  for (const [k, kind] of Object.entries(shape.req)) if (!shapeOk(kind, r[k])) return `"${r.t}".${k} = ${JSON.stringify(r[k])} is not a valid ${kind}`;
  for (const [k, kind] of Object.entries(shape.opt || {})) if (r[k] !== undefined && !shapeOk(kind, r[k])) return `"${r.t}".${k} = ${JSON.stringify(r[k])} is not a valid ${kind}`;
  if (r.ifLen !== undefined && !isInt(r.ifLen)) return `"${r.t}".ifLen = ${JSON.stringify(r.ifLen)} is not a valid int`;
  return null;
}
function specProblem(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "spec is not an object";
  if (spec.unchecked === true) return null;
  if (!Array.isArray(spec.check)) return "spec has no check rules";
  for (let i = 0; i < spec.check.length; i++) {
    const why = ruleProblem(spec.check[i]);
    if (why) return "check rule " + i + " " + why;
  }
  return null;
}

function buildVisual(visualContract, skillRep, isSkill) {
  const none = status => ({ contract: status, contractTypes: [], questionTypes: [], unusable: [], allowed: [], allowedSource: "", types: {}, quizMode: "", step: "", fallback: "" });
  if (!visualContract) return none({ status: "missing", path: null, sha256: null, version: null, schema: null });
  const path = str(visualContract.path) || null;
  if (visualContract.missing) return none({ status: "missing", path, sha256: null, version: null, schema: null, reason: "no contract file at this path" });
  if (visualContract.error || visualContract.raw == null) return none({ status: "unreadable", path, sha256: null, version: null, schema: null, reason: str(visualContract.error) || "no content" });
  let c;
  try { c = JSON.parse(String(visualContract.raw).replace(/^﻿/, "")); }
  catch (e) { return none({ status: "unreadable", path, sha256: textHash(visualContract.raw), version: null, schema: null, reason: "invalid JSON: " + e.message }); }
  const types = c && c.types && typeof c.types === "object" ? c.types : null;
  const qv = c && c.capabilities && c.capabilities.questionVisual;
  const contract = { status: types ? "present" : "unreadable", path, sha256: textHash(visualContract.raw), version: str(c && c.version) || null, schema: str(c && c.schema) || null };
  if (!types) return Object.assign(none(Object.assign(contract, { reason: "no types table" })));
  const contractTypes = Object.keys(types);
  const listed = (qv && Array.isArray(qv.types) ? qv.types : []).filter(t => typeof t === "string" && Object.prototype.hasOwnProperty.call(types, t));
  const unusable = listed.map(t => ({ type: t, reason: specProblem(types[t]) })).filter(u => u.reason);
  const questionTypes = listed.filter(t => !unusable.some(u => u.type === t));
  const allowed = isSkill
    ? (skillRep || []).filter((t, i, a) => questionTypes.includes(t) && a.indexOf(t) === i)
    : questionTypes.slice();
  const specs = {};
  for (const t of allowed) specs[t] = JSON.parse(JSON.stringify(types[t]));
  return {
    contract, contractTypes, questionTypes, unusable, allowed,
    allowedSource: isSkill
      ? "skill representations (skill graph rep) ∩ contract capabilities.questionVisual.types"
      : "contract capabilities.questionVisual.types (curriculum item without a skill representation list)",
    types: specs,
    quizMode: str(qv && qv.how),
    step: str(qv && qv.step),
    fallback: str(qv && qv.fallback)
  };
}

function buildLesson(lesson, itemId) {
  if (!lesson) return { status: "missing", path: null, sha256: null, title: "", steps: [], provenance: null, humanReview: "unknown", reason: "no lesson path supplied" };
  const path = str(lesson.path) || null;
  const base = { path, sha256: null, title: "", steps: [], provenance: null, humanReview: "unknown" };
  if (lesson.missing) return Object.assign(base, { status: "missing", reason: "no lesson file at this path" });
  if (lesson.error || lesson.raw == null) return Object.assign(base, { status: "unreadable", reason: str(lesson.error) || "no content" });
  base.sha256 = textHash(lesson.raw);
  let j;
  try { j = JSON.parse(String(lesson.raw).replace(/^﻿/, "")); }
  catch (e) { return Object.assign(base, { status: "unreadable", reason: "invalid JSON: " + e.message }); }
  const L = j && typeof j === "object" && j.lesson ? j.lesson : j;
  if (!L || typeof L !== "object" || !Array.isArray(L.steps) || !L.steps.length) return Object.assign(base, { status: "unreadable", reason: "no steps" });
  if (j.curriculumId != null && itemId && j.curriculumId !== itemId)
    return Object.assign(base, { status: "unreadable", reason: "curriculumId " + j.curriculumId + " does not match " + itemId });
  /* 文件自己声明了语言就必须是 en：拿中文课文去核对英文题等于没核对 */
  if (j.lang != null && j.lang !== "en") return Object.assign(base, { status: "unreadable", reason: "lesson language is " + JSON.stringify(j.lang) + ", not en" });
  /* 每一步都得有能读的台词；[null]、空字符串、非字符串都算没有课文可核对 */
  const badStep = L.steps.findIndex(s => !s || typeof s !== "object" || typeof s.say !== "string" || !s.say.trim());
  if (badStep >= 0) return Object.assign(base, { status: "unreadable", reason: "step " + badStep + " has no readable text" });
  base.status = "present";
  base.title = str(L.title);
  base.steps = L.steps.map(s => {
    const o = { say: s.say.trim() };
    if (typeof s.math === "string" && s.math.trim()) o.math = s.math.trim();
    if (typeof s.headline === "string" && s.headline.trim()) o.headline = s.headline.trim();
    const v = s.visual;
    /* 课文配图整份留下（type / nums / labels / caption / step）：审稿要拿它核对整体、单位、刻度 */
    if (v && typeof v === "object" && typeof v.type === "string" && v.type && v.type !== "none") {
      const pv = { type: v.type };
      if (Array.isArray(v.nums)) pv.nums = JSON.parse(JSON.stringify(v.nums));
      if (Array.isArray(v.labels)) pv.labels = JSON.parse(JSON.stringify(v.labels));
      if (v.caption != null) pv.caption = str(v.caption);
      if (v.step != null) pv.step = v.step;
      o.visual = pv;
    }
    return o;
  });
  /* 只记文件里自带的生成来源；人工审过没有，文件本身证明不了 */
  base.provenance = { provider: str(j && j.provider) || null, model: str(j && j.model) || null, at: str(j && j.at) || null };
  return base;
}

/**
 * @param {object} input
 *   item          课程条目（server.js 的形状；技能条目带 item.skill，misc/prereq 已按登记表展开）
 *   context       { kind: "skill"|"standard"|"course"|"book", grade, topic: { id, en } }
 *   skillType     { en, teachEn } | null（SKILL_TYPE 表里这一项）
 *   dependents    [{ id, en, grade }]：技能图谱里把本技能列为先修的技能（调用方从图谱算好）
 *   terms         [{ en }]：关键术语（默认 item.terms；server 传它现有的 itemTerms 结果）
 *   visualContract { path, raw } | { path, missing: true } | { path, error } | null
 *   lesson        { path, raw } | { path, missing: true } | { path, error } | null
 *   draftObjectives  [string]：补充目标，只作草稿记录（默认没有）
 *   rules         覆盖默认规则（测试用）；不传 = 按年级选：G1–G3 的技能 / 大纲条目用 PRIMARY_RULES，其余 DEFAULT_RULES
 */
function buildTeachingBrief(input) {
  const { item, context = {}, skillType = null, dependents = [], terms = null, visualContract = null, lesson = null, draftObjectives = [], rules = null, lang = "en" } = input || {};
  if (lang !== "en") throw new TypeError("TeachingBrief is English-only (zh generation is frozen)");
  if (!item || !str(item.id)) throw new TypeError("buildTeachingBrief needs item.id");
  const sk = item.skill && typeof item.skill === "object" ? item.skill : null;
  const kind = sk ? "skill" : (["standard", "course", "book"].includes(context.kind) ? context.kind : "standard");
  const rulesObj = JSON.parse(JSON.stringify(rules || ((kind === "skill" || kind === "standard") && isPrimaryGrade(context.grade) ? PRIMARY_RULES : DEFAULT_RULES)));
  const brief = {
    kind: BRIEF_KIND, v: BRIEF_VERSION, lang: "en",
    item: { id: str(item.id), kind, title: str(item.en), grade: context.grade == null ? null : context.grade, topic: { id: str(context.topic && context.topic.id) || str(item.strand) || null, en: str(context.topic && context.topic.en) || null } },
    goal: { text: str(item.en), source: sk ? "skill graph: skill title (item.en)" : "curriculum: item text (item.en)" },
    elaborations: sk ? [] : (item.elaborations || []).map(e => str(e && e.en)).filter(Boolean),
    terms: (terms || item.terms || []).map(t => str(t && t.en)).filter(Boolean),
    skill: sk ? {
      type: str(sk.type) || null,
      typeLabel: skillType ? str(skillType.en) : null,
      focus: skillType ? str(skillType.teachEn) : null,
      rep: (sk.rep || []).map(str).filter(Boolean),
      core: sk.core !== false,
      reviewFrom: Number(sk.reviewFrom) || 0,
      standard: {
        primary: str(sk.primary) || null,
        supporting: (sk.supporting || []).map(str).filter(Boolean),
        text: str(sk.standardEn) || null,
        status: str(sk.standardEn) ? "present" : "missing",
        use: "context only — do not test the rest of the standard"
      }
    } : null,
    prerequisites: sk ? (sk.prereq || []).map(p => ({ id: str(p.id), en: str(p.en), grade: p.grade == null ? null : p.grade })) : [],
    outOfScope: {
      source: "skill graph: skills that list this skill as a prerequisite",
      note: "curriculum structure only; says nothing about what any learner has or has not learned",
      skills: sk ? dependents.map(d => ({ id: str(d.id), en: str(d.en), grade: d.grade == null ? null : d.grade })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : []
    },
    misconceptions: sk ? (sk.misc || []).map(m => ({ id: str(m.id), en: str(m.en), pattern: str(m.pattern), remedy: str(m.remedy) || null })) : [],
    draftObjectives: (draftObjectives || []).map(t => ({ text: str(t), status: "draft", note: "maintainer draft; not an official standard and not human-reviewed" })).filter(o => o.text),
    rules: Object.assign(rulesObj, { hash: sha256(canonicalJson(rulesObj)) }),
    visual: buildVisual(visualContract, sk ? sk.rep : null, !!sk),
    lesson: buildLesson(lesson, str(item.id))
  };
  brief.coverage = {
    lessonAlignment: brief.lesson.status === "present" ? "checkable-against-lesson-text" : "not-verifiable",
    lessonHumanReview: "unknown",
    standardText: sk ? brief.skill.standard.status : "n/a"
  };
  const briefHash = sha256(canonicalJson(brief));
  brief.briefHash = briefHash;
  brief.briefId = "tb1-" + briefHash.slice(0, 16);
  return deepFreeze(brief);
}

/* 冻结对象可能被人拷一份再改：重算一遍，对不上就不认 */
function verifyBriefHash(b) {
  if (!b || b.kind !== BRIEF_KIND || typeof b.briefHash !== "string") return false;
  const copy = JSON.parse(JSON.stringify(b));
  delete copy.briefHash; delete copy.briefId;
  return sha256(canonicalJson(copy)) === b.briefHash && b.briefId === "tb1-" + b.briefHash.slice(0, 16);
}
const isDeepFrozen = o => !o || typeof o !== "object" || (Object.isFrozen(o) && Object.keys(o).every(k => isDeepFrozen(o[k])));
/* 认的只有 buildTeachingBrief 的产物：整棵冻结、哈希和内容对得上。浅冻结的改过的拷贝、旧哈希配新内容都不认，
 * 这样同一个 briefId 就一定是同一份内容。 */
const isTeachingBrief = b => !!b && typeof b === "object" && b.kind === BRIEF_KIND && isDeepFrozen(b) && verifyBriefHash(b);
/* brief 是不是这道题的：条目 id、年级、条目种类、主题都要对上（同一个技能 id 在别的年级视图里当复习题时，主题/年级不同）。
 * 对得上返回 null，对不上返回原因。 */
function briefMismatch(b, expected) {
  if (!isTeachingBrief(b)) return "not a genuine TeachingBrief (must be the frozen, hash-consistent result of buildTeachingBrief)";
  const e = expected || {};
  if (e.lang != null && b.lang !== e.lang) return `brief is for lang ${b.lang}, not ${e.lang}`;
  if (e.itemId != null && b.item.id !== e.itemId) return `brief is for ${b.item.id}, not ${e.itemId}`;
  if (e.grade !== undefined && b.item.grade !== e.grade) return `brief is for grade ${b.item.grade}, not ${e.grade}`;
  if (e.kind != null && b.item.kind !== e.kind) return `brief is for a ${b.item.kind} item, not ${e.kind}`;
  if (e.topicId !== undefined && b.item.topic.id !== e.topicId) return `brief is for topic ${b.item.topic.id}, not ${e.topicId}`;
  return null;
}

/* ---------- 渲染 ---------- */
function headerLines(b) {
  const L = [];
  L.push(`Teaching brief ${b.briefId} (rules ${b.rules.version}). The reviewer checks every question against this same brief.`);
  L.push(`- Goal (${b.goal.source}): ${b.goal.text}`);
  if (b.skill) {
    L.push("- This is ONE small skill, not a whole standard — keep every question inside it.");
    if (b.skill.type) L.push(`- Skill type: ${b.skill.typeLabel || b.skill.type}${b.skill.focus ? " — " + b.skill.focus : ""}.`);
    if (b.skill.rep.length) L.push(`- Representations (skill graph, in order): ${b.skill.rep.join(", ")}. Level 1 is framed around the "${b.skill.rep[0]}" model.`);
    L.push(b.skill.standard.status === "present"
      ? `- The standard this skill belongs to (${b.skill.standard.primary || "id missing"}; ${b.skill.standard.use}): ${b.skill.standard.text}`
      : `- Standard text: not available in the source data (${b.skill.standard.primary || "no id"}) — stay on the goal above.`);
  }
  if (b.elaborations.length) { L.push("- What it covers (curriculum):"); for (const e of b.elaborations) L.push("  · " + e); }
  if (b.terms.length) L.push("- Key terms: " + b.terms.join(", "));
  if (b.prerequisites.length) L.push("- Allowed prerequisites (skill graph) — may be used as tools, must not be the point tested: " + b.prerequisites.map(p => `${p.en} [${p.id}]`).join("; "));
  if (b.outOfScope.skills.length) L.push(`- Out of scope — later skills that build on this one (${b.outOfScope.source}; ${b.outOfScope.note}); do not make them the point tested: ` + b.outOfScope.skills.map(p => `${p.en} [${p.id}]`).join("; "));
  if (b.draftObjectives.length) { L.push("- Draft teaching notes (maintainer drafts, not official standards, not human-reviewed):"); for (const o of b.draftObjectives) L.push("  · " + o.text); }
  return L;
}
function miscLines(b) {
  if (!b.misconceptions.length) return [];
  const L = ["- Build distractors on THESE registered misconceptions, and tag each option with the id:"];
  for (const m of b.misconceptions) L.push(`  · ${m.id} — ${m.en} (looks like: ${m.pattern})`);
  L.push(`- Also output "tags": an array of 4 strings, one per option in the same order — "ok" for the correct option, and the misconception id for each distractor. Use "other" only if a distractor genuinely matches none of the ids above.`);
  return L;
}
function levelLines(b) {
  const L = ["Difficulty levels:", "- " + b.rules.levels[1], "- " + b.rules.levels[2], "- " + b.rules.levels[3],
    `- At most ${b.rules.l3SpotMistakeMax} Level-3 questions per batch may be "spot the mistake" questions.`];
  /* 低年级规则：出题器和审稿器都印，审稿按同一份查「适龄」 */
  if (Array.isArray(b.rules.young) && b.rules.young.length) {
    L.push("", `Young learners (Grade ${b.item.grade}) — every question must follow these:`);
    for (const r of b.rules.young) L.push("- " + r);
  }
  return L;
}
function visualLines(b, forJudge) {
  const v = b.visual, L = [];
  if (v.contract.status !== "present") {
    L.push(`Question pictures: the picture contract is ${v.contract.status}${v.contract.reason ? " (" + v.contract.reason + ")" : ""}, so no question may carry a "visual". ${b.rules.textOnly}`);
    return L;
  }
  const unusable = v.unusable.length ? ` Unusable in this contract (malformed spec): ${v.unusable.map(u => u.type + " — " + u.reason).join("; ")}.` : "";
  if (!v.allowed.length) {
    L.push(`Question pictures: none of this ${b.skill ? "skill's representations" : "item's"} can be drawn as a question picture (contract v${v.contract.version} question types: ${v.questionTypes.join(", ") || "none"}), so no question may carry a "visual".${unusable} ${b.rules.textOnly}`);
    return L;
  }
  if (unusable) L.push("Question pictures:" + unusable);
  L.push(`Question pictures (optional "visual", contract v${v.contract.version}; allowed here: ${v.allowed.join(", ")} — ${v.allowedSource}):`);
  for (const r of b.rules.visual) L.push("- " + r);
  L.push("- " + b.rules.textOnly);
  L.push("- nums convention per allowed type (contract text):");
  for (const t of v.allowed) L.push(`  · ${t}: ${v.types[t].nums || ""}`);
  /* 渲染能力的限制照契约原文说出来（不替契约定新规矩）：Apple 端还没画的类型、画不了时的降级 */
  for (const t of v.allowed.filter(t => v.types[t].apple === false))
    L.push(`- Rendering limit (contract): the Apple app does not draw ${t} yet${v.types[t].appleNote ? " — " + v.types[t].appleNote : ""}.`);
  if (v.fallback && v.allowed.some(t => v.types[t].apple === false)) L.push("- Clients that cannot draw a question picture (contract text): " + v.fallback);
  const usesStep = v.allowed.some(t => (v.types[t].check || []).some(r => r.t === "stepFits" || r.t === "pictoSymbols"));
  if (v.step && usesStep) L.push("- step (contract text): " + v.step);
  if (forJudge && v.quizMode) L.push("- How question pictures are drawn in quiz mode (contract text): " + v.quizMode);
  return L;
}
function lessonLines(b, forJudge) {
  const l = b.lesson;
  if (l.status !== "present") {
    return [`Lesson: ${l.status}${l.path ? " (" + l.path + ")" : ""}${l.reason ? " — " + l.reason : ""}. ` +
      (forJudge ? "Alignment with the lesson CANNOT be verified: say so; never claim the questions match the lesson." : "Do not assume any particular lesson wording or method.")];
  }
  const p = l.provenance || {};
  const L = [`Lesson the child just watched: ${l.path} (sha256 ${l.sha256.slice(0, 12)}; generated by ${p.provider || "unknown"}${p.at ? " " + p.at : ""}; human review status unknown) — "${l.title}". Use the same terms and methods:`];
  l.steps.forEach((s, i) => {
    const bits = [];
    if (forJudge) bits.push(s.say);
    else if (s.headline) bits.push(s.headline);
    if (s.math) bits.push("math: " + s.math);
    /* 审稿看课文配图的全部数据（整体、单位、刻度要核对）；出题器只要知道用过哪种图 */
    if (s.visual) bits.push(forJudge
      ? "picture: " + JSON.stringify(s.visual)
      : `picture: ${s.visual.type}${s.visual.caption ? " — " + s.visual.caption : ""}`);
    if (!bits.length) bits.push(s.say.length > 160 ? s.say.slice(0, 157) + "..." : s.say);
    L.push(`  ${i + 1}. ${bits.join(" | ")}`);
  });
  return L;
}

function renderGeneratorBrief(b) {
  if (!isTeachingBrief(b)) throw new TypeError("renderGeneratorBrief needs a frozen TeachingBrief");
  return [...headerLines(b), ...miscLines(b), "", ...levelLines(b), "", ...visualLines(b, false), "", ...lessonLines(b, false)].join("\n");
}
function renderJudgeBrief(b) {
  if (!isTeachingBrief(b)) throw new TypeError("renderJudgeBrief needs a frozen TeachingBrief");
  const misc = b.misconceptions.length
    ? ["- Registered misconceptions (distractor tags must name the misconception the distractor really shows):", ...b.misconceptions.map(m => `  · ${m.id} — ${m.en} (looks like: ${m.pattern})`)]
    : [];
  return [...headerLines(b), ...misc, "", ...levelLines(b), "", ...visualLines(b, true), "", ...lessonLines(b, true)].join("\n");
}

module.exports = {
  BRIEF_KIND, BRIEF_VERSION, DEFAULT_RULES, PRIMARY_RULES,
  buildTeachingBrief, isTeachingBrief, verifyBriefHash, briefMismatch, renderGeneratorBrief, renderJudgeBrief,
  canonicalJson, textHash, frozenCopy
};
