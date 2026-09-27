#!/usr/bin/env node
/*
 * 英文题库批次硬校验（lib/ai/qbank/validate.js，#43）：合法题图 / 标签 / qid 原样保留；坏图、缺图、不支持的图型、
 * 泄露答案、qid 冲突整道拒掉，绝不出现在 accepted 里（不删图留题）；纯文字老题照常通过。
 *
 *   node tools/test_qbank_validate.mjs
 *
 * 纯模块测试：合成题目 + 已跟踪的图形契约原文 + 渲染端同一个 public/visual-check.js。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeChecker, ROOT } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const QB = require("../lib/ai/qbank/index.js");
const { checkVisual } = require("../public/visual-check.js");
const { check, summary } = makeChecker();

const CONTRACT_REL = "data/curriculum/visual-contract.json";
const contractRaw = fs.readFileSync(path.join(ROOT, CONTRACT_REL), "utf8");
const lineSkill = {
  id: "YY.T.LINE", strand: "line-graphs", en: "Read values and trends from a line graph", zh: "读折线图",
  skill: { type: "concept", rep: ["statLine"], primary: "BC.MATH.G6.DAT.01", standardEn: "Data: line graphs",
    prereq: [], misc: [{ id: "graph.scale_misread", en: "Misreads the scale", pattern: "counts spaces as 1 each" }, { id: "graph.steep_means_more", en: "Steeper means more", pattern: "picks the steepest part" }] }
};
const mkBrief = over => QB.buildTeachingBrief(Object.assign({
  item: lineSkill, context: { kind: "skill", grade: 6, topic: { id: "line-graphs", en: "Line graphs" } },
  skillType: { en: "concept", teachEn: "focus on what it means" },
  visualContract: { path: CONTRACT_REL, raw: contractRaw },
  lesson: { path: "data/lessons/en/YY.T.LINE.json", missing: true }
}, over || {}));
const brief = mkBrief();
const tags = new Set(lineSkill.skill.misc.map(m => m.id));
const V = (raw, requested, extra) => QB.validateEnglishQbankBatch(raw, requested, Object.assign({ brief, checkVisual, allowedTags: tags }, extra || {}));

const goodVisual = () => ({ type: "statLine", nums: [12, 18, 20, 26], labels: ["Week 1", "Week 2", "Week 3", "Week 4"], caption: "Height of a bean plant (mm)", step: 2 });
const textQ = (stem, level = 1) => ({ level, question: stem, options: ["14 mm", "16 mm", "18 mm", "20 mm"], answerIndex: 2, explain: "Go up from Week 2 to the line, then across to the scale.", tags: ["graph.scale_misread", "other", "ok", "graph.steep_means_more"] });
const withV = (stem, v, over) => Object.assign(textQ(stem), { visual: v }, over || {});

console.log("legal content survives");
{
  const vis = withV("How tall was the plant in Week 2?", goodVisual(), { qid: "qkeep_1" });
  const raw = { questions: [vis, textQ("A plant was 14 mm on Monday and 18 mm on Friday. How much did it grow?", 2), textQ("Which week had the tallest plant if heights were 12, 18, 20 and 26 mm?", 3)] };
  const before = JSON.stringify(raw);
  const r = V(raw, 3);
  const a = r.accepted[0];
  check("valid statLine visual is kept field for field (type/nums/labels/caption/step)", JSON.stringify(a.visual) === JSON.stringify(goodVisual()), a.visual);
  check("valid explicit qid is kept", a.qid === "qkeep_1", a.qid);
  check("registered tags are kept in option order (correct option forced to ok)", a.tags.join() === "graph.scale_misread,other,ok,graph.steep_means_more", a.tags);
  check("text-only questions pass and carry no visual key", r.accepted.length === 3 && !("visual" in r.accepted[1]) && !("visual" in r.accepted[2]), r.rejected);
  check("accepted objects carry only publishable fields (no findings/internal markers)",
    r.accepted.every(q => Object.keys(q).every(k => ["level", "question", "options", "answerIndex", "explain", "tags", "visual", "qid"].includes(k))), r.accepted.map(q => Object.keys(q)));
  check("the raw model output is not mutated", JSON.stringify(raw) === before);
  check("report carries the brief id and an honest coverage list", r.briefId === brief.briefId && r.coverage.notChecked.some(s => /agrees with the stem/.test(s)) && r.coverage.checked.length >= 8);
}

console.log("bad pictures are rejected, never stripped");
const cases = [
  ["contract rule broken (value not on a half step of step=4)", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { nums: [12, 13, 20, 26], step: 4 })), "visual_contract"],
  ["contract rule broken (only 1 point on a line graph)", withV("How tall was the plant in Week 1?", Object.assign(goodVisual(), { nums: [12], labels: ["Week 1"] })), "visual_contract"],
  ["type not in the contract", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { type: "radarChart" })), "visual_unknown_type"],
  ["contract type that is not a question-picture type", withV("Where is 3/4?", { type: "numberLine", nums: [0, 1, 0.75], caption: "0 to 1" }), "visual_not_question_type"],
  ["'none' is not a question picture", withV("How tall was the plant in Week 2?", { type: "none", nums: [], caption: "x" }), "visual_not_question_type"],
  ["question type the skill cannot use (pieChart for a line-graph skill)", withV("What share chose soccer?", { type: "pieChart", nums: [40, 60], labels: ["soccer", "hockey"], caption: "Favourite sport" }), "visual_not_allowed"],
  ["caption missing", withV("How tall was the plant in Week 2?", (({ caption, ...v }) => v)(goodVisual())), "visual_caption"],
  ["caption blank", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { caption: "  " })), "visual_caption"],
  ["unknown extra visual field", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { colour: "red" })), "visual_extra_field"],
  ["nums with a numeric string", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { nums: [12, "18", 20, 26] })), "visual_nums"],
  ["labels not strings", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { labels: [1, 2, 3, 4] })), "visual_labels"],
  ["step not positive", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { step: 0 })), "visual_step"],
  ["visual is not an object", withV("How tall was the plant in Week 2?", "statLine 12 18 20 26"), "visual_shape"],
  ["stem still recites the plotted data", withV("The plotted points are: (1, 12), (2, 18). How tall in Week 2?", goodVisual()), "visual_recited"],
  ["caption announces the answer", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { caption: "Plant height — the answer is 18 mm" })), "visual_answer_annotation"],
  ["a label announces the answer", withV("How tall was the plant in Week 2?", Object.assign(goodVisual(), { labels: ["Week 1", "Answer: Week 2", "Week 3", "Week 4"] })), "visual_answer_annotation"],
  ["answerIndex is a JSON array (Number([]) would be 0)", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { answerIndex: [] }), "answer_index"],
  ["level is a JSON array (Number([1]) would be 1)", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { level: [1] }), "level"],
  ["answerIndex is a boolean", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { answerIndex: true }), "answer_index"],
  ["answerIndex is null", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { answerIndex: null }), "answer_index"],
  ["stem is an object", Object.assign(textQ("x"), { question: { text: "How much did it grow?" } }), "question_missing"],
  ["an option is an object", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { options: [{ text: "6 mm" }, "4 mm", "8 mm", "2 mm"] }), "options"],
  ["an option is a number (English schema says string)", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { options: [6, "4 mm", "8 mm", "2 mm"] }), "options"],
  ["explanation is an array", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { explain: ["Subtract", "12 from 18"] }), "explain_missing"],
  ["internal type name in the explanation", withV("How tall was the plant in Week 2?", goodVisual(), { explain: "Read the statLine at Week 2." }), "internal_type_name"],
  ["stem points at a graph but carries no visual", textQ("Look at the line graph. How tall was the plant in Week 2?"), "visual_missing"],
  ["stem says 'the graph below' but carries no visual", textQ("The graph below shows plant heights. How tall in Week 2?"), "visual_missing"],
  ["stem says 'shown above' but carries no visual", textQ("Using the heights shown above, how tall was it in Week 2?"), "visual_missing"],
  ["fractional answerIndex is not silently rounded", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { answerIndex: 1.6 }), "answer_index"],
  ["fractional level is not silently rounded", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { level: 2.4 }), "level"],
  ["empty explanation", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { explain: " " }), "explain_missing"],
  ["only 3 options", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { options: ["a", "b", "c"] }), "options"],
  ["qid with illegal characters", Object.assign(textQ("A plant grew from 12 mm to 18 mm. How much?"), { qid: "q bad/1" }), "qid_invalid"]
];
{
  const good = [1, 2, 3].map(lv => textQ(`Plant ${lv}: it was 12 mm and then 18 mm. How much did it grow?`, lv));
  const raw = { questions: [...good, ...cases.map(c => c[1])] };
  const r = V(raw, 3);
  cases.forEach(([label, q, code], i) => {
    const rej = r.rejected.find(x => x.index === good.length + i);
    check(label + " -> rejected with " + code, !!rej && rej.findings.some(f => f.code === code), rej ? rej.findings : "accepted");
  });
  check("none of the rejected questions appears in accepted (no 'strip the picture and keep the question')",
    r.accepted.length === good.length && r.accepted.every(q => !("visual" in q)) && r.rejected.length === cases.length, r.accepted.map(q => q.question));
  check("no accepted text is a stringified object/array", r.accepted.every(q => ![q.question, q.explain, ...q.options].some(t => /\[object Object\]/.test(t))));
  check("every finding explains itself (code, field, message)", r.rejected.every(x => x.findings.every(f => f.code && typeof f.field === "string" && f.message)));
}

console.log("what the lexical checks do NOT claim");
{
  const r = V({ questions: [
    textQ("Mia made a graph of her plant: 12 mm in Week 1 and 18 mm in Week 2. How much did it grow?", 1),
    textQ("A line graph would show 12, 18, 20 and 26 mm. Which week grew most?", 2),
    withV("Which change was the biggest?", Object.assign(goodVisual(), { caption: "Growth from Week 1 to 2, Week 2 to 3 and Week 3 to 4" }), { options: ["Week 1 to 2", "Week 2 to 3", "Week 3 to 4", "No change"], answerIndex: 0, tags: ["ok", "graph.scale_misread", "graph.steep_means_more", "other"] })
  ] }, 3);
  check("text that merely mentions a graph (no 'the graph', 'below', 'shown') is not flagged", r.accepted.length === 3, r.rejected);
  check("a caption that happens to contain the correct option is not called a leak",
    r.accepted[2] && r.accepted[2].visual.caption === "Growth from Week 1 to 2, Week 2 to 3 and Week 3 to 4", r.rejected);
  const numQ = (caption, options, answerIndex) => withV("How many books did the second class read?", Object.assign(goodVisual(), { type: "statLine", caption }), { options, answerIndex, tags: ["ok", "other", "other", "other"].map((t, i) => i === answerIndex ? "ok" : "other") });
  const n = V({ questions: [
    numQ("Grade 2 books read each week", ["2", "3", "4", "5"], 0),
    numQ("Times for the 2.5 km race", ["2.5", "3.5", "4.5", "5.5"], 0),
    numQ("Week 2 height: 18 mm", ["14 mm", "16 mm", "18 mm", "20 mm"], 2)
  ] }, 3);
  check("neutral numeric captions (Grade 2 / the 2.5 km race / a data value equal to the answer) are accepted — only an explicit answer phrase is provable",
    n.accepted.length === 3, n.rejected);
}

console.log("tags, answer index, qid identity");
{
  const q = Object.assign(textQ("Plant: 12 mm then 18 mm. Growth?"), { answerIndex: "2", tags: ["bogus.id", "ok", "graph.scale_misread", "other"], difficulty: "easy" });
  const r = V({ questions: [q, textQ("Plant 2: 10 then 16 mm. Growth?", 2), textQ("Plant 3: 8 then 12 mm. Growth?", 3)] }, 3);
  check("integer-valued string answerIndex is accepted as a number", r.accepted[0].answerIndex === 2);
  check("unknown tag / ok on a distractor are remapped to other with warnings, question still accepted",
    r.accepted[0].tags.join() === "other,other,ok,other" && r.warnings.filter(w => w.index === 0 && /tag_/.test(w.code)).length === 3, r.warnings);
  check("ignored extra field is reported as a warning, not published", !("difficulty" in r.accepted[0]) && r.warnings.some(w => w.code === "ignored_fields"));
  const dup = V({ questions: [
    Object.assign(textQ("Plant A: 12 then 18 mm. Growth?"), { qid: "qsame" }), Object.assign(textQ("Plant B: 10 then 16 mm. Growth?", 2), { qid: "qsame" }),
    Object.assign(textQ("Plant C: 8 then 12 mm. Growth?", 3), { qid: "qexisting" }), textQ("Plant D: 6 then 9 mm. Growth?", 2), textQ("Plant E: 5 then 9 mm. Growth?", 3)
  ] }, 3, { existingQids: ["qexisting"] });
  check("a qid repeated in the batch: first kept, second rejected", dup.accepted[0].qid === "qsame" && dup.rejected.some(x => x.index === 1 && x.findings[0].code === "qid_duplicate"), dup.rejected);
  check("a qid already in the bank is rejected (it would overwrite that question on merge)", dup.rejected.some(x => x.index === 2 && x.findings[0].code === "qid_conflict") && !dup.accepted.some(q => q.qid === "qexisting"));
  const generic = (stem, lv, tg) => Object.assign(textQ(stem, lv), { tags: tg });
  const empty = QB.validateEnglishQbankBatch({ questions: [
    generic("P1: 1 then 3. Growth?", 1, ["other", "other", "ok", "other"]),
    generic("P2: 2 then 5. Growth?", 2, ["other", "graph.scale_misread", "ok", "other"]),
    generic("P3: 3 then 8. Growth?", 3, ["other", "other", "ok", "other"])
  ] }, 3, { brief, checkVisual, allowedTags: new Set() });
  check("skill with an EMPTY misconception registry: legal ok/other tags survive",
    empty.accepted.length === 3 && empty.accepted[0].tags.join() === "other,other,ok,other" && empty.accepted[2].tags.join() === "other,other,ok,other", empty.accepted.map(q => q.tags));
  check("  ... and an id that is not registered is remapped to other with a warning", empty.accepted[1].tags.join() === "other,other,ok,other" && empty.warnings.some(w => w.index === 1 && w.code === "tag_remapped_other"));
  const noTags = QB.validateEnglishQbankBatch({ questions: [textQ("P1: 1 then 3. Growth?"), textQ("P2: 2 then 5. Growth?", 2), textQ("P3: 3 then 8. Growth?", 3)] }, 3, { brief, checkVisual, allowedTags: null });
  check("non-skill item (no tag field at all): tags dropped with a warning, questions kept", noTags.accepted.length === 3 && noTags.accepted.every(q => !("tags" in q)) && noTags.warnings.some(w => w.code === "tags_dropped"));
}

console.log("too few / contract unavailable / wrong inputs");
{
  let err = null;
  try { V({ questions: [textQ("Look at the graph. Growth?"), withV("Growth?", Object.assign(goodVisual(), { type: "pie" })), textQ("P: 1 then 3. Growth?")] }, 12); } catch (e) { err = e; }
  check("fewer valid questions than the legacy threshold -> throws, with the hard-check codes and the report attached",
    !!err && /有效题目太少/.test(err.message) && /visual_missing×1/.test(err.message) && /visual_not_allowed×1/.test(err.message) && err.report && err.report.accepted.length === 1, err && err.message);
  const nb = mkBrief({ visualContract: { path: CONTRACT_REL, missing: true } });
  const r = QB.validateEnglishQbankBatch({ questions: [withV("How tall in Week 2?", goodVisual()), textQ("P1: 1 then 3. Growth?"), textQ("P2: 2 then 5. Growth?", 2), textQ("P3: 3 then 8. Growth?", 3)] }, 3, { brief: nb, checkVisual, allowedTags: tags });
  check("contract unavailable: a picture cannot be verified -> rejected; text-only still accepted",
    r.rejected.length === 1 && r.rejected[0].findings[0].code === "visual_contract_unavailable" && r.accepted.length === 3, r.rejected);
  /* 契约规格残缺：渲染端的 checkVisual 对没有 check 的规格放行，出题链不能继承这个放行 */
  const synth = spec => JSON.stringify({ schema: "yy-visual-contract/3", version: "3", types: { statLine: spec }, capabilities: { questionVisual: { types: ["statLine"] } } });
  const mb = mkBrief({ visualContract: { path: "synthetic.json", raw: synth({ nums: "values" }) } });
  const m = QB.validateEnglishQbankBatch({ questions: [withV("How tall in Week 2?", goodVisual()), textQ("P1: 1 then 3. Growth?"), textQ("P2: 2 then 5. Growth?", 2), textQ("P3: 3 then 8. Growth?", 3)] }, 3, { brief: mb, checkVisual, allowedTags: tags });
  check("a question type whose contract spec has no check rules is unusable: picture rejected (visual_contract_malformed), text questions kept",
    mb.visual.allowed.length === 0 && mb.visual.unusable[0].type === "statLine" && m.rejected.length === 1 && m.rejected[0].findings[0].code === "visual_contract_malformed" && m.accepted.length === 3, { unusable: mb.visual.unusable, rej: m.rejected });
  check("  ... the renderer's own checker would have let it through (why the gate exists)", checkVisual({ types: { statLine: { nums: "values" } } }, "statLine", [0, 9999], [], {}).ok === true);
  const mr = mkBrief({ visualContract: { path: "synthetic.json", raw: synth({ nums: "values", check: [{ max: 3 }] }) } });
  check("a check rule without a rule name is malformed too", mr.visual.allowed.length === 0 && /check rule 0 has no rule name/.test(mr.visual.unusable[0].reason), mr.visual.unusable);
  const me = mkBrief({ visualContract: { path: "synthetic.json", raw: synth({ nums: "values", check: [] }) } });
  check("an explicit empty check list is the contract's own 'no constraints' and stays usable", me.visual.allowed.join() === "statLine");
  const copy = JSON.parse(JSON.stringify(brief));
  check("a plain (unfrozen / edited) brief copy is refused", (() => { try { QB.validateEnglishQbankBatch({ questions: [] }, 3, { brief: copy, checkVisual }); return false; } catch (e) { return e instanceof TypeError; } })());
  check("checkVisual must be injected", (() => { try { QB.validateEnglishQbankBatch({ questions: [] }, 3, { brief }); return false; } catch (e) { return e instanceof TypeError; } })());
}

console.log("schema and format hint");
{
  const base = { type: "object", additionalProperties: false, properties: { questions: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { level: { type: "number" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } }, answerIndex: { type: "number" }, explain: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
    required: ["level", "question", "options", "answerIndex", "explain"] } } }, required: ["questions"] };
  const before = JSON.stringify(base);
  const s = QB.englishQbankSchema(base, brief);
  const v = s.properties.questions.items.properties.visual;
  check("English schema adds an optional visual whose type enum is exactly the brief's allowed types",
    v && v.properties.type.enum.join() === "statLine" && v.required.join() === "type,nums,caption" && v.additionalProperties === false
    && !s.properties.questions.items.required.includes("visual"), v);
  check("the base (shared zh) schema object is not mutated", JSON.stringify(base) === before);
  const noPic = mkBrief({ item: Object.assign({}, lineSkill, { skill: Object.assign({}, lineSkill.skill, { rep: ["context"] }) }) });
  check("no allowed picture type -> no visual property in the schema, hint unchanged",
    !("visual" in QB.englishQbankSchema(base, noPic).properties.questions.items.properties) && QB.englishQbankHint("BASE", noPic) === "BASE");
  const h = QB.englishQbankHint("BASE", brief);
  check("hint explains the optional visual with an allowed type and says text-only questions omit it", h.startsWith("BASE") && /"visual":\{"type":"statLine"/.test(h) && /text-only question has no "visual" key/.test(h), h);
  const contract = JSON.parse(contractRaw);
  const qtypes = contract.capabilities.questionVisual.types;
  check("every question type has a hint example, and each example passes the tracked contract",
    qtypes.every(t => QB.HINT_EXAMPLES[t] && checkVisual(contract, t, QB.HINT_EXAMPLES[t].nums, QB.HINT_EXAMPLES[t].labels, { step: QB.HINT_EXAMPLES[t].step }).ok),
    qtypes.map(t => [t, QB.HINT_EXAMPLES[t] && checkVisual(contract, t, QB.HINT_EXAMPLES[t].nums, QB.HINT_EXAMPLES[t].labels, { step: QB.HINT_EXAMPLES[t].step })]));
  const fracSkill = Object.assign({}, lineSkill, { skill: Object.assign({}, lineSkill.skill, { rep: ["fractionBar", "pie"] }) });
  const hf = QB.englishQbankHint("BASE", mkBrief({ item: fracSkill }));
  const ex = JSON.parse(hf.match(/"visual":(\{.*?\})(?= —)/)[1]);
  check("fraction skill hint: the example visual is a fractionBar the contract accepts; no step talk for types that do not use it",
    ex.type === "fractionBar" && checkVisual(contract, ex.type, ex.nums, ex.labels, {}).ok && !/step/.test(hf), hf);
  check("stat skill hint: step is described as any positive number (fractions allowed), not 'more than 1'", /positive number "step"/.test(h) && /0\.5/.test(h) && !/more than 1/.test(h), h);
}

process.exit(summary() ? 0 : 1);
