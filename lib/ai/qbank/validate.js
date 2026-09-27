/*
 * 英文题库批次的硬校验（#43，#8 子任务 A）。纯函数：契约规则实现（public/visual-check.js 的 checkVisual）由调用方注入。
 *
 *   validateEnglishQbankBatch(raw, requested, { brief, checkVisual, allowedTags?, existingQids? })
 *     → { accepted, rejected, warnings, coverage, briefId }
 *
 * accepted 里只有干净的题对象（level/question/options/answerIndex/explain，外加合法的 tags / visual / qid），
 * 没有任何内部标记；任何一条硬规则不过的题进 rejected，不会出现在 accepted 里——也不会「删掉坏图、题留下」。
 * 有效题不够（和旧校验同一个门槛）直接抛错，错误上挂着 report。
 *
 * 这里只做能确定判断的事（见 COVERAGE）：图和题干、解析在语义上是否一致，数学对不对，和课文对不对得上，
 * 留给审稿（#44 的逐题审稿）。「题干提到图却没带图」是按短语匹配的，抓不全所有说法。
 */
"use strict";

const { isTeachingBrief } = require("./brief.js");

const VISUAL_FIELDS = ["type", "nums", "labels", "caption", "step"];
const QID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/* 和 tools/curriculum/visual_check.mjs --qbank 同一条：数据搬进图里之后题干不该再念图 */
const RECITES_PICTURE = /table of values (is|was):|The plotted points are:/i;
/* 题干指着一张图（「look at the graph」「the chart below」）——只认这些短语，别的说法抓不到 */
const PICTURE_WORDS = "graph|chart|pictograph|diagram|picture|figure|image";
const REFERS_TO_PICTURE = new RegExp(
  "\\b(?:look at|use|using|study|read|according to|based on|shown in|in|on|from) the (?:[a-z]+[- ]){0,2}(?:" + PICTURE_WORDS + ")s?\\b"
  + "|\\b(?:" + PICTURE_WORDS + ")s? (?:below|above|shown)\\b"
  + "|\\bshown (?:below|above)\\b", "i");

/* 图注 / 标签里明写「答案是…」：这是能确定的泄露（或写错的答案）。只认这种明确的答案声明——
 * 「Grade 2 books」「Times for the 2.5 km race」里恰好出现选项里的数，不能证明泄露，留给审稿。 */
const ANSWER_ANNOTATION = /\b(?:the\s+)?(?:correct\s+|right\s+)?(?:answer|solution)s?\s*(?:is|are|=|:)/i;

const COVERAGE = Object.freeze({
  checked: Object.freeze([
    "shape: stem/explain are non-empty strings, exactly 4 non-empty string options, answerIndex 0-3 and level 1-3 as integers (JSON numbers or digit-only strings; no silent rounding, arrays/objects/booleans/null rejected)",
    "visual shape: only type/nums/labels/caption/step; nums finite numbers; labels strings; caption non-empty; step > 0",
    "visual type: known to the contract, its contract spec well-formed, a question-picture type, and allowed for this item by the brief",
    "visual contract rules via public/visual-check.js (the renderer's own checker); a missing/unreadable/malformed contract fails closed",
    "stem still reads the picture back in prose (same two phrases as visual_check --qbank)",
    "stem refers to a picture but the question carries none (fixed English phrases only)",
    "internal camelCase picture type names in child-visible text",
    "caption or labels explicitly announce an answer (\"the answer is ...\", \"solution:\")",
    "qid format, duplicates in the batch, collision with an existing bank qid",
    "misconception tags: 4 aligned tags kept for skill items (ok / other / registered ids — also when the registry is empty); unknown ids / ok on a distractor remapped to other (warning, never blocks a question — same as the legacy validator)"
  ]),
  notChecked: Object.freeze([
    "whether the picture agrees with the stem and explanation (numbers, wholes, units, scale)",
    "an answer printed or implied without an explicit answer phrase: a caption/label that happens to contain the answer, printed pieChart slice values, or an answer computed from the picture",
    "picture references phrased differently from the fixed phrases",
    "math correctness and exactly one correct option",
    "alignment with the lesson (and the lesson itself is not known to be human-reviewed)",
    "whether each distractor really shows the misconception its tag names"
  ]),
  deferredTo: "model review (#44 per-item findings); a model pass can never override a hard-check failure"
});

const unlitNewline = s => String(s == null ? "" : s).replace(/\\n/g, "\n");
/* 英文 schema 里这几个是 number：只认 JSON 数字，外加纯数字字符串（老校验一直收 "2"，不带 schema 约束的适配器会这么写）。
 * 数组 / 对象 / 布尔 / null / 小数一律不认——Number([]) 是 0、Number([1]) 是 1，不能让它们混进来。 */
const intIn = (v, lo, hi) => {
  let n = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) n = Number(v);
  return n !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
/* 英文 schema 里是 string 的字段只认字符串；对象 / 数组不再被 String() 成「[object Object]」混过去 */
const textOf = v => typeof v === "string" ? unlitNewline(v).trim() : null;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function checkVisualField(v, brief, checkVisual, find) {
  if (typeof v !== "object" || Array.isArray(v)) { find("visual_shape", "visual", "visual must be an object"); return null; }
  const extra = Object.keys(v).filter(k => !VISUAL_FIELDS.includes(k));
  if (extra.length) find("visual_extra_field", "visual", "unknown visual field(s): " + extra.join(", "));
  const bv = brief.visual;
  const type = typeof v.type === "string" ? v.type : "";
  if (bv.contract.status !== "present") find("visual_contract_unavailable", "visual.type", `picture contract is ${bv.contract.status}; a visual cannot be verified`);
  else if (!type) find("visual_type", "visual.type", "visual.type missing");
  else if (!bv.contractTypes.includes(type)) find("visual_unknown_type", "visual.type", `"${type}" is not in the picture contract`);
  else if (bv.unusable.some(u => u.type === type)) find("visual_contract_malformed", "visual.type", `the contract spec for "${type}" is malformed (${bv.unusable.find(u => u.type === type).reason}); it cannot be checked`);
  else if (!bv.questionTypes.includes(type)) find("visual_not_question_type", "visual.type", `"${type}" is not a question-picture type (contract questionVisual: ${bv.questionTypes.join(", ")})`);
  else if (!bv.allowed.includes(type)) find("visual_not_allowed", "visual.type", `"${type}" is not allowed for this item (allowed: ${bv.allowed.join(", ") || "none"}; ${bv.allowedSource})`);
  const numsOk = Array.isArray(v.nums) && v.nums.every(n => typeof n === "number" && Number.isFinite(n));
  if (!numsOk) find("visual_nums", "visual.nums", "nums must be an array of numbers");
  const labelsOk = v.labels === undefined || (Array.isArray(v.labels) && v.labels.every(l => typeof l === "string"));
  if (!labelsOk) find("visual_labels", "visual.labels", "labels must be an array of strings");
  const caption = typeof v.caption === "string" ? unlitNewline(v.caption).trim() : "";
  if (!caption) find("visual_caption", "visual.caption", "caption is required");
  const stepOk = v.step === undefined || (typeof v.step === "number" && Number.isFinite(v.step) && v.step > 0);
  if (!stepOk) find("visual_step", "visual.step", "step must be a positive number when given");
  if (type && bv.allowed.includes(type) && numsOk && labelsOk && stepOk) {
    const r = checkVisual({ types: bv.types }, type, v.nums, v.labels, { step: v.step });
    if (!r || !r.ok) find("visual_contract", "visual", "contract: " + ((r && r.why) || "rejected"));
  }
  const out = { type, nums: numsOk ? v.nums.slice() : v.nums };
  if (v.labels !== undefined) out.labels = labelsOk ? v.labels.slice() : v.labels;
  out.caption = caption;
  if (v.step !== undefined) out.step = v.step;
  return out;
}

/* 逐题硬校验，不设数量门槛、不抛「太少」：#44 的 v2 审稿用它复查单道修复题和暂存后的最终对象（同一套规则，不另写一份）。
 * validateEnglishQbankBatch = 这个 + 老门槛。 */
function checkEnglishQuestions(raw, ctx) {
  const { brief, checkVisual, allowedTags = null, existingQids = null } = ctx || {};
  if (!isTeachingBrief(brief)) throw new TypeError("validateEnglishQbankBatch needs the frozen TeachingBrief used for generation");
  if (typeof checkVisual !== "function") throw new TypeError("validateEnglishQbankBatch needs checkVisual (public/visual-check.js)");
  if (!raw || typeof raw !== "object") throw new Error("出题格式不对");
  const taken = new Set(existingQids || []);
  const internalNames = brief.visual.contractTypes.filter(t => /[A-Z]/.test(t));
  const internalRe = internalNames.length ? new RegExp("\\b(" + internalNames.map(escapeRe).join("|") + ")\\b") : null;
  const seenQids = new Set();
  const accepted = [], rejected = [], warnings = [];
  (Array.isArray(raw.questions) ? raw.questions : []).forEach((q, index) => {
    const findings = [];
    const find = (code, field, message) => findings.push({ code, field, message });
    if (!q || typeof q !== "object" || Array.isArray(q)) { rejected.push({ index, findings: [{ code: "not_a_question", field: "", message: "not an object" }] }); return; }
    const question = textOf(q.question) || "";
    if (!question) find("question_missing", "question", typeof q.question === "string" || q.question == null ? "empty stem" : "stem must be a string");
    const options = Array.isArray(q.options) ? q.options.map(o => textOf(o) || "") : [];
    if (options.length !== 4 || options.some(o => !o)) find("options", "options", "needs exactly 4 non-empty string options");
    const ai = intIn(q.answerIndex, 0, 3);
    if (ai === null) find("answer_index", "answerIndex", "answerIndex must be an integer 0-3, got " + JSON.stringify(q.answerIndex));
    const level = intIn(q.level, 1, 3);
    if (level === null) find("level", "level", "level must be an integer 1-3, got " + JSON.stringify(q.level));
    const explain = textOf(q.explain) || "";
    if (!explain) find("explain_missing", "explain", typeof q.explain === "string" || q.explain == null ? "empty explanation" : "explanation must be a string");

    const out = { level, question, options, answerIndex: ai, explain };
    if (allowedTags && Array.isArray(q.tags) && q.tags.length === 4 && ai !== null) {
      out.tags = q.tags.map((t, i) => {
        const v = String(t || "").trim();
        if (i === ai) { if (v !== "ok") warnings.push({ index, code: "tag_correct_forced_ok", message: `tag ${JSON.stringify(v)} on the correct option -> ok` }); return "ok"; }
        if (v && v !== "ok" && (allowedTags.has(v) || v === "other")) return v;
        warnings.push({ index, code: "tag_remapped_other", message: `tag ${JSON.stringify(v)} on option ${i} -> other` });
        return "other";
      });
    } else if (q.tags !== undefined) warnings.push({ index, code: "tags_dropped", message: allowedTags ? "tags need 4 entries" : "not a skill item (tags are a skill-bank field)" });

    let visual = null;
    if (q.visual !== undefined && q.visual !== null) visual = checkVisualField(q.visual, brief, checkVisual, find);
    if (visual) {
      if (RECITES_PICTURE.test(question)) find("visual_recited", "question", "the stem still reads the picture data back in prose");
      const spots = [["visual.caption", visual.caption || ""], ...(Array.isArray(visual.labels) ? visual.labels.map((l, i) => ["visual.labels[" + i + "]", l]) : [])];
      const hit = spots.find(([, t]) => typeof t === "string" && ANSWER_ANNOTATION.test(t));
      if (hit) find("visual_answer_annotation", hit[0], "the picture text announces an answer: " + JSON.stringify(hit[1].slice(0, 80)));
    } else if (REFERS_TO_PICTURE.test(question)) {
      find("visual_missing", "visual", "the stem refers to a picture but the question carries no visual");
    }
    if (internalRe) {
      const texts = [["question", question], ["explain", explain], ...options.map((o, i) => ["options[" + i + "]", o])];
      if (visual && visual.caption) texts.push(["visual.caption", visual.caption]);
      for (const [field, t] of texts) {
        const m = internalRe.exec(t);
        if (m) { find("internal_type_name", field, `internal picture type name "${m[1]}" in child-visible text`); break; }
      }
    }
    if (q.qid !== undefined && q.qid !== null) {
      if (typeof q.qid !== "string" || !QID_RE.test(q.qid)) find("qid_invalid", "qid", "qid must match " + QID_RE);
      else if (taken.has(q.qid)) find("qid_conflict", "qid", "qid already used by a question in this bank");
      else if (seenQids.has(q.qid)) find("qid_duplicate", "qid", "qid repeated in this batch");
      else { seenQids.add(q.qid); out.qid = q.qid; }
    }
    const ignored = Object.keys(q).filter(k => !["level", "question", "options", "answerIndex", "explain", "tags", "visual", "qid"].includes(k));
    if (ignored.length) warnings.push({ index, code: "ignored_fields", message: "ignored: " + ignored.join(", ") });

    if (findings.length) { rejected.push({ index, qid: typeof q.qid === "string" ? q.qid : undefined, stem: question.slice(0, 120), findings }); return; }
    if (visual) out.visual = visual;
    accepted.push(out);
  });
  return { accepted, rejected, warnings, coverage: COVERAGE, briefId: brief.briefId };
}

function validateEnglishQbankBatch(raw, requested, ctx) {
  const report = checkEnglishQuestions(raw, ctx);
  const { accepted, rejected } = report;
  if (accepted.length < Math.max(3, Math.ceil(requested * 0.5))) {
    const codes = {};
    for (const r of rejected) for (const f of r.findings) codes[f.code] = (codes[f.code] || 0) + 1;
    const detail = Object.entries(codes).map(([c, n]) => c + "×" + n).join(", ");
    const e = new Error("有效题目太少" + (detail ? "（硬校验拒绝：" + detail + "）" : ""));
    e.report = report;
    throw e;
  }
  return report;
}

/* 英文出题的 JSON schema：在旧 schema 上加可选 visual（只有 brief 允许题图时才加），type 枚举 = brief.visual.allowed */
function englishQbankSchema(baseSchema, brief) {
  if (!isTeachingBrief(brief)) throw new TypeError("englishQbankSchema needs a TeachingBrief");
  const s = JSON.parse(JSON.stringify(baseSchema));
  if (brief.visual.allowed.length) {
    s.properties.questions.items.properties.visual = {
      type: "object", additionalProperties: false,
      properties: {
        type: { type: "string", enum: brief.visual.allowed.slice() },
        nums: { type: "array", items: { type: "number" } },
        labels: { type: "array", items: { type: "string" } },
        caption: { type: "string" },
        step: { type: "number" }
      }, required: ["type", "nums", "caption"]
    };
  }
  return s;
}
/* 格式说明：允许题图时补一句 visual 怎么写；不允许就原样（提示词正文里已经说了不许带图） */
/* 格式说明里的示例 visual：每种题图类型一个按当前契约合法的例子（tools/test_qbank_validate.mjs 用 checkVisual 逐个核对），
 * 免得示例本身就会被硬校验拒掉。例子只示范格式，数值不代表任何题。 */
const HINT_EXAMPLES = {
  fractionBar: { type: "fractionBar", nums: [4, 3], caption: "..." },
  pie: { type: "pie", nums: [8, 3], caption: "..." },
  statBar: { type: "statBar", nums: [6, 9, 4], labels: ["...", "...", "..."], caption: "..." },
  statLine: { type: "statLine", nums: [12, 18, 20], labels: ["...", "...", "..."], caption: "..." },
  pieChart: { type: "pieChart", nums: [45, 30, 25], labels: ["...", "...", "..."], caption: "..." },
  pictograph: { type: "pictograph", nums: [10, 15, 5], labels: ["...", "...", "..."], caption: "...", step: 5 }
};
function englishQbankHint(baseHint, brief) {
  if (!isTeachingBrief(brief)) throw new TypeError("englishQbankHint needs a TeachingBrief");
  if (!brief.visual.allowed.length) return baseHint;
  const t = brief.visual.allowed[0];
  const ex = HINT_EXAMPLES[t] ? JSON.stringify(HINT_EXAMPLES[t]) : `{"type":"${t}","nums":[...],"caption":"..."}`;
  const stepTypes = brief.visual.allowed.filter(x => (brief.visual.types[x].check || []).some(r => r.t === "stepFits" || r.t === "pictoSymbols"));
  return baseHint + `\nA question that needs a picture adds "visual":${ex} — type is one of ${brief.visual.allowed.join(", ")}, nums/labels follow that type's convention in the brief`
    + (stepTypes.length ? `; for ${stepTypes.join(", ")} an optional positive number "step" says how much one grid space or symbol stands for (it may be a fraction such as 0.5)` : "")
    + `. A text-only question has no "visual" key.`;
}

module.exports = { validateEnglishQbankBatch, checkEnglishQuestions,englishQbankSchema, englishQbankHint, COVERAGE, REFERS_TO_PICTURE, RECITES_PICTURE, ANSWER_ANNOTATION, HINT_EXAMPLES };
