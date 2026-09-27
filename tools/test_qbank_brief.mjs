#!/usr/bin/env node
/*
 * TeachingBrief（lib/ai/qbank/brief.js，#43）：确定性、失效、缺课文、不编造、冻结、生成/审稿同一版本。
 *
 *   node tools/test_qbank_brief.mjs
 *
 * 纯模块测试：合成条目 + 仓库里已跟踪的图形契约原文（data/curriculum/visual-contract.json，只读）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { makeChecker, ROOT } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const QB = require("../lib/ai/qbank/index.js");
const { check, summary } = makeChecker();

const CONTRACT_REL = "data/curriculum/visual-contract.json";
const contractRaw = fs.readFileSync(path.join(ROOT, CONTRACT_REL), "utf8");
const contract = JSON.parse(contractRaw);
const sha = s => crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("hex");

const lessonObj = {
  v: 1, curriculumId: "YY.T.FRAC", lang: "en", title: "Equivalent fractions", provider: "claude", at: "2026-08-23",
  lesson: { title: "Equivalent fractions", isMath: true, steps: [
    { say: "Cut one whole into 2 equal parts and shade 1.", math: "\\frac{1}{2}", headline: "Same whole, different cuts", visual: { type: "fractionBar", nums: [2, 1, 4, 2], caption: "1/2 and 2/4" } },
    { say: "Multiply top and bottom by the same number.", math: "\\frac{1}{2}=\\frac{2}{4}", visual: { type: "none" } }
  ] }
};
const lessonRaw = JSON.stringify(lessonObj, null, 1);
const skillItem = () => ({
  id: "YY.T.FRAC", strand: "equivalent-fractions", en: "Recognize equivalent fractions with bars and circles", zh: "等值分数",
  terms: [{ en: "equivalent fraction", zh: "等值分数" }],
  skill: {
    type: "represent", rep: ["fractionBar", "pie", "areaGrid"], core: true, primary: "BC.MATH.G5.NUM.03", supporting: [],
    standardEn: "Fractions: equivalent fractions", standardZh: "等值分数",
    prereq: [{ id: "YY.T.SAME_WHOLE", zh: "同一个整体", en: "Compare fractions of the same whole", grade: 5 }],
    misc: [
      { id: "frac.different_whole", zh: "整体不同", en: "Compares fractions of different wholes", pattern: "1/2 of a small pizza = 1/2 of a big one", remedy: "YY.T.SAME_WHOLE" },
      { id: "frac.count_shaded_only", zh: "只数涂色", en: "Counts shaded parts only", pattern: "says 2/4 > 1/2 because 2 > 1", remedy: null }
    ],
    diag: null, reviewFrom: 0
  }
});
const baseInput = over => Object.assign({
  item: skillItem(),
  context: { kind: "skill", grade: 5, topic: { id: "equivalent-fractions", en: "Equivalent fractions" } },
  skillType: { en: "representation", teachEn: "focus on moving between models, number lines and symbols" },
  dependents: [{ id: "YY.T.Z_LATER", en: "Compare fractions with unlike denominators", grade: 6 }, { id: "YY.T.A_LATER", en: "Add fractions", grade: 6 }],
  visualContract: { path: CONTRACT_REL, raw: contractRaw },
  lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: lessonRaw }
}, over || {});

/* 把对象的键顺序整个倒过来（值不变）：规范化哈希不该受键顺序影响 */
const reverseKeys = v => Array.isArray(v) ? v.map(reverseKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reverseKeys(v[k])])) : v;

console.log("determinism");
const b1 = QB.buildTeachingBrief(baseInput());
const b2 = QB.buildTeachingBrief(baseInput());
check("same inputs -> same briefHash and identical JSON", b1.briefHash === b2.briefHash && JSON.stringify(b1) === JSON.stringify(b2), [b1.briefHash, b2.briefHash]);
check("briefId is derived from briefHash", /^tb1-[0-9a-f]{16}$/.test(b1.briefId) && b1.briefHash.startsWith(b1.briefId.slice(4)), b1.briefId);
const b3 = QB.buildTeachingBrief(baseInput({ item: reverseKeys(skillItem()), context: reverseKeys(baseInput().context) }));
check("key order of the injected objects does not change the hash", b3.briefHash === b1.briefHash, b3.briefHash);
const b4 = QB.buildTeachingBrief(baseInput({ dependents: baseInput().dependents.slice().reverse() }));
check("dependents are canonicalised (input order does not matter)", b4.briefHash === b1.briefHash && b1.outOfScope.skills.map(s => s.id).join() === "YY.T.A_LATER,YY.T.Z_LATER", b1.outOfScope.skills);
const bCrlf = QB.buildTeachingBrief(baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: lessonRaw.replace(/\n/g, "\r\n") } }));
check("CRLF checkout of the same lesson -> same lesson hash and briefHash", bCrlf.briefHash === b1.briefHash && b1.lesson.sha256 === sha(lessonRaw), [bCrlf.lesson.sha256, b1.lesson.sha256]);
check("contract hash is the sha256 of the tracked contract text", b1.visual.contract.sha256 === sha(contractRaw) && b1.visual.contract.version === String(contract.version), b1.visual.contract);
check("verifyBriefHash accepts an untouched brief", QB.verifyBriefHash(b1));

console.log("change invalidation");
const changed = (label, input) => {
  const b = QB.buildTeachingBrief(input);
  check(label + " -> briefHash changes", b.briefHash !== b1.briefHash, b.briefHash);
  return b;
};
const lesson2 = JSON.parse(lessonRaw); lesson2.lesson.steps[1].say = lesson2.lesson.steps[1].say.replace("same number", "same  number");
const bl = changed("one character of the lesson file", baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: JSON.stringify(lesson2, null, 1) } }));
check("  ... and the recorded lesson hash follows the file", bl.lesson.sha256 !== b1.lesson.sha256);
const lessonPad = lessonRaw + "\n";
changed("whitespace-only edit of the lesson file (bytes are hashed, not the parsed JSON)", baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: lessonPad } }));
const c2 = JSON.parse(contractRaw); c2.types.fractionBar.check[2].max = 19;
const bc = changed("a fractionBar range in the visual contract", baseInput({ visualContract: { path: CONTRACT_REL, raw: JSON.stringify(c2, null, 1) } }));
check("  ... and the brief carries the changed spec the validator will use", bc.visual.types.fractionBar.check[2].max === 19 && b1.visual.types.fractionBar.check[2].max === 20);
const r2 = JSON.parse(JSON.stringify(QB.DEFAULT_RULES)); r2.levels[2] = r2.levels[2] + " ";
const br = changed("the level-2 rule text", baseInput({ rules: r2 }));
check("  ... and rules.hash changes with it", br.rules.hash !== b1.rules.hash);
const it2 = skillItem(); it2.skill.misc[1].pattern = "says 2/4 > 1/2";
changed("a registered misconception pattern", baseInput({ item: it2 }));
changed("the skill-graph dependents", baseInput({ dependents: [{ id: "YY.T.A_LATER", en: "Add fractions", grade: 6 }] }));
const it3 = skillItem(); it3.skill.prereq = [];
changed("the allowed prerequisites", baseInput({ item: it3 }));

console.log("lesson status is honest");
check("present lesson: steps, title and generator provenance recorded; human review unknown",
  b1.lesson.status === "present" && b1.lesson.steps.length === 2 && b1.lesson.title === "Equivalent fractions"
  && b1.lesson.provenance.provider === "claude" && b1.lesson.provenance.at === "2026-08-23" && b1.lesson.humanReview === "unknown"
  && b1.coverage.lessonAlignment === "checkable-against-lesson-text" && b1.coverage.lessonHumanReview === "unknown", b1.lesson);
check("present lesson: a step's 'none' visual is not recorded as a picture", !("visual" in b1.lesson.steps[1]) && b1.lesson.steps[0].visual.type === "fractionBar");
const bm = QB.buildTeachingBrief(baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", missing: true } }));
check("missing lesson: status missing, no hash, alignment not verifiable",
  bm.lesson.status === "missing" && bm.lesson.sha256 === null && bm.lesson.steps.length === 0 && bm.coverage.lessonAlignment === "not-verifiable" && bm.lesson.path === "data/lessons/en/YY.T.FRAC.json", bm.lesson);
check("missing lesson changes the brief", bm.briefHash !== b1.briefHash);
const jm = QB.renderJudgeBrief(bm), gm = QB.renderGeneratorBrief(bm);
check("missing lesson: the judge is told alignment CANNOT be verified, the generator not to assume a lesson",
  /Lesson: missing \(data\/lessons\/en\/YY\.T\.FRAC\.json\)/.test(jm) && /CANNOT be verified/.test(jm) && /never claim the questions match the lesson/.test(jm)
  && /Do not assume any particular lesson wording/.test(gm) && !/CANNOT/.test(gm), jm.split("\n").filter(l => /Lesson/.test(l)));
const bu = QB.buildTeachingBrief(baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: "{ not json" } }));
check("unreadable lesson (bad JSON): status unreadable with reason, hash of the bytes kept, not verifiable",
  bu.lesson.status === "unreadable" && /invalid JSON/.test(bu.lesson.reason) && bu.lesson.sha256 === sha("{ not json") && bu.coverage.lessonAlignment === "not-verifiable", bu.lesson);
const other = JSON.parse(lessonRaw); other.curriculumId = "YY.T.OTHER";
const bx = QB.buildTeachingBrief(baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: JSON.stringify(other) } }));
check("a lesson file for a different curriculumId is not used as this item's lesson", bx.lesson.status === "unreadable" && /does not match/.test(bx.lesson.reason) && bx.lesson.steps.length === 0, bx.lesson);
const jp = QB.renderJudgeBrief(b1);
check("present lesson: the judge sees every step's words and 'human review status unknown'",
  jp.includes(lessonObj.lesson.steps[1].say) && /human review status unknown/.test(jp) && jp.includes(b1.lesson.sha256.slice(0, 12)), jp);
{
  /* 课文配图要整份留下：审稿核对整体 / 单位 / 刻度要看 nums、labels、step，不只是 type 和 caption */
  const lv = JSON.parse(lessonRaw);
  lv.lesson.steps[0].visual = { type: "statBar", nums: [17, 5, 9], labels: ["LESSON_ALPHA", "LESSON_BETA", "LESSON_GAMMA"], caption: "Books read", step: 0.5 };
  const bv = QB.buildTeachingBrief(baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: JSON.stringify(lv) } }));
  check("lesson picture kept whole in the brief (type/nums/labels/caption/step)", JSON.stringify(bv.lesson.steps[0].visual) === JSON.stringify(lv.lesson.steps[0].visual), bv.lesson.steps[0].visual);
  const jv = QB.renderJudgeBrief(bv), gv = QB.renderGeneratorBrief(bv);
  check("the judge rendering carries the lesson picture's numbers, labels and step", ["LESSON_ALPHA", "LESSON_GAMMA", "[17,5,9]", '"step":0.5'].every(s => jv.includes(s)), jv.split("\n").filter(l => /LESSON_/.test(l)));
  check("the generator rendering stays compact (type and caption only)", !gv.includes("LESSON_ALPHA") && gv.includes("picture: statBar — Books read"));
}
for (const [label, mutate, why] of [
  ["a null step", l => { l.lesson.steps = [null]; }, /step 0 has no readable text/],
  ["a step with empty words", l => { l.lesson.steps[1].say = "   "; }, /step 1 has no readable text/],
  ["a step whose words are not a string", l => { l.lesson.steps[0].say = ["Cut", "one"]; }, /step 0 has no readable text/],
  ["no steps at all", l => { l.lesson.steps = []; }, /no steps/],
  ["a lesson file declaring another language", l => { l.lang = "zh"; }, /not en/]
]) {
  const l = JSON.parse(lessonRaw); mutate(l);
  const b = QB.buildTeachingBrief(baseInput({ lesson: { path: "data/lessons/en/YY.T.FRAC.json", raw: JSON.stringify(l) } }));
  check("unusable lesson (" + label + ") -> unreadable, no steps, alignment not verifiable",
    b.lesson.status === "unreadable" && why.test(b.lesson.reason) && b.lesson.steps.length === 0 && b.coverage.lessonAlignment === "not-verifiable" && /CANNOT be verified/.test(QB.renderJudgeBrief(b)), b.lesson);
}

console.log("no invented facts");
const it4 = skillItem(); it4.skill.standardEn = ""; it4.skill.primary = "BC.MATH.G5.NUM.03";
const bs = QB.buildTeachingBrief(baseInput({ item: it4 }));
check("empty standard text is recorded as missing, not filled in", bs.skill.standard.status === "missing" && bs.skill.standard.text === null && bs.coverage.standardText === "missing"
  && /Standard text: not available in the source data \(BC\.MATH\.G5\.NUM\.03\)/.test(QB.renderGeneratorBrief(bs)), bs.skill.standard);
check("goal, prerequisites and misconceptions are exactly the injected ones",
  b1.goal.text === skillItem().en && b1.prerequisites.map(p => p.id).join() === "YY.T.SAME_WHOLE"
  && b1.misconceptions.map(m => m.id + "|" + m.pattern).join() === "frac.different_whole|1/2 of a small pizza = 1/2 of a big one,frac.count_shaded_only|says 2/4 > 1/2 because 2 > 1"
  && b1.draftObjectives.length === 0, b1.goal);
check("curriculum-graph boundary carries its source and says it is not learner knowledge",
  /skills that list this skill as a prerequisite/.test(b1.outOfScope.source) && /says nothing about what any learner has or has not learned/.test(b1.outOfScope.note)
  && QB.renderGeneratorBrief(b1).includes("says nothing about what any learner has or has not learned"), b1.outOfScope);
const bd = QB.buildTeachingBrief(baseInput({ draftObjectives: ["Notice that 2/4 and 1/2 cover the same length"] }));
check("supplementary objectives are recorded and rendered only as drafts",
  bd.draftObjectives[0].status === "draft" && /not an official standard and not human-reviewed/.test(bd.draftObjectives[0].note)
  && /Draft teaching notes \(maintainer drafts, not official standards, not human-reviewed\)/.test(QB.renderGeneratorBrief(bd)) && bd.briefHash !== b1.briefHash);
const plain = { id: "BC.T.G4.NUM.01", strand: "number", en: "Number concepts to 10 000", zh: "一万以内的数", elaborations: [{ en: "place value", zh: "位值" }], terms: [] };
const bp = QB.buildTeachingBrief({ item: plain, context: { kind: "standard", grade: 4, topic: { id: "number", en: "Number" } }, visualContract: { path: CONTRACT_REL, raw: contractRaw }, lesson: { path: "data/lessons/en/BC.T.G4.NUM.01.json", missing: true } });
check("curriculum item without a skill: no misconceptions / prerequisites / boundary invented, elaborations kept",
  bp.item.kind === "standard" && bp.skill === null && bp.misconceptions.length === 0 && bp.prerequisites.length === 0 && bp.outOfScope.skills.length === 0
  && bp.elaborations.join() === "place value" && /curriculum: item text/.test(bp.goal.source), bp);

console.log("question pictures from the contract");
check("skill: allowed = rep ∩ contract question types, in rep order", b1.visual.allowed.join() === "fractionBar,pie" && Object.keys(b1.visual.types).join() === "fractionBar,pie"
  && b1.visual.questionTypes.join() === contract.capabilities.questionVisual.types.join(), b1.visual.allowed);
const it5 = skillItem(); it5.skill.rep = ["context", "barModel"];
const bn = QB.buildTeachingBrief(baseInput({ item: it5 }));
const gn = QB.renderGeneratorBrief(bn);
check("skill whose representations cannot be question pictures: allowed empty, generator told not to carry a visual",
  bn.visual.allowed.length === 0 && /no question may carry a "visual"/.test(gn) && !/Question pictures \(optional/.test(gn), gn.split("\n").filter(l => /picture/i.test(l)));
check("non-skill item: every contract question type is allowed", bp.visual.allowed.join() === contract.capabilities.questionVisual.types.join());
const bnc = QB.buildTeachingBrief(baseInput({ visualContract: { path: CONTRACT_REL, missing: true } }));
check("contract missing: recorded as missing, nothing allowed, generator told no visuals",
  bnc.visual.contract.status === "missing" && bnc.visual.allowed.length === 0 && /picture contract is missing/.test(QB.renderGeneratorBrief(bnc)), bnc.visual.contract);
const bbad = QB.buildTeachingBrief(baseInput({ visualContract: { path: CONTRACT_REL, raw: "{" } }));
check("contract unreadable: recorded as unreadable, nothing allowed", bbad.visual.contract.status === "unreadable" && bbad.visual.allowed.length === 0);
{
  const synth = (types, qt) => JSON.stringify({ schema: "yy-visual-contract/3", version: "3", types, capabilities: { questionVisual: { types: qt, fallback: "FALLBACK_TEXT" } } });
  const good = { nums: "[d, n]", check: [{ t: "lenIn", values: [2] }] };
  const bm1 = QB.buildTeachingBrief(baseInput({ visualContract: { path: "synthetic.json", raw: synth({ fractionBar: {}, pie: good }, ["fractionBar", "pie"]) } }));
  check("malformed contract spec (no check rules): that type is recorded unusable and not allowed; the well-formed one stays",
    bm1.visual.allowed.join() === "pie" && bm1.visual.unusable.map(u => u.type + ":" + u.reason).join() === "fractionBar:spec has no check rules" && bm1.visual.contract.status === "present", bm1.visual);
  check("  ... and both renderings say so", /Unusable in this contract \(malformed spec\): fractionBar/.test(QB.renderGeneratorBrief(bm1)) && /Unusable in this contract/.test(QB.renderJudgeBrief(bm1)));
  const bm2 = QB.buildTeachingBrief(baseInput({ visualContract: { path: "synthetic.json", raw: synth({ fractionBar: { check: "lenIn" }, pie: { check: [null] } }, ["fractionBar", "pie", "notAType"]) } }));
  check("non-array check / null rule / listed type missing from the table -> nothing allowed", bm2.visual.allowed.length === 0 && bm2.visual.unusable.length === 2 && !bm2.visual.questionTypes.includes("notAType"), bm2.visual);
  /* 规则参数形状不对（checkVisual 对 NaN 比较一律放行）、规则名 checkVisual 不认识：都算规格残缺 */
  for (const [label, rule, why] of [
    ["range with non-numeric bounds", { t: "range", idx: 0, min: "not-a-number", max: "not-a-number" }, /"range"\.min/],
    ["range with a string index", { t: "range", idx: "0", min: 1, max: 20 }, /"range"\.idx/],
    ["lenIn without values", { t: "lenIn" }, /"lenIn"\.values/],
    ["wholes with a missing max", { t: "wholes", numIdx: 1, denIdx: 0 }, /"wholes"\.max/],
    ["a rule kind the checker does not implement", { t: "maxLabelLength", max: 3 }, /not a rule the checker implements/],
    ["ifLen that is not an integer", { t: "range", idx: 2, min: 1, max: 20, ifLen: "4" }, /ifLen/]
  ]) {
    const b = QB.buildTeachingBrief(baseInput({ visualContract: { path: "synthetic.json", raw: synth({ fractionBar: { nums: "[d, n]", check: [{ t: "lenIn", values: [2] }, rule] }, pie: good }, ["fractionBar", "pie"]) } }));
    check("malformed rule arguments (" + label + ") -> fractionBar unusable, pie still allowed",
      b.visual.allowed.join() === "pie" && b.visual.unusable.length === 1 && why.test(b.visual.unusable[0].reason), b.visual.unusable);
  }
  const every = JSON.parse(contractRaw); every.capabilities.questionVisual.types = Object.keys(every.types);
  const ball = QB.buildTeachingBrief({ item: plain, context: { kind: "standard", grade: 4 }, visualContract: { path: CONTRACT_REL, raw: JSON.stringify(every) } });
  check("no false alarm: every spec in the tracked contract passes the shape check", ball.visual.unusable.length === 0 && ball.visual.allowed.length === Object.keys(contract.types).length, ball.visual.unusable);
  const itp = skillItem(); itp.skill.rep = ["pictograph"];
  const bpic = QB.buildTeachingBrief(baseInput({ item: itp }));
  const gp = QB.renderGeneratorBrief(bpic), jpic = QB.renderJudgeBrief(bpic);
  check("contract rendering limits (Apple does not draw pictograph yet + fallback text) reach BOTH generator and judge, verbatim from the contract",
    [gp, jpic].every(s => s.includes("the Apple app does not draw pictograph yet") && s.includes(contract.types.pictograph.appleNote) && s.includes(contract.capabilities.questionVisual.fallback)), gp.split("\n").filter(l => /Apple|cannot draw/.test(l)));
  check("no Apple limit line for types the Apple app draws", !/Apple app does not draw/.test(QB.renderGeneratorBrief(b1)));
}
const g1 = QB.renderGeneratorBrief(b1);
check("generator rendering: contract nums conventions for allowed types, the §7 rules, no 'there is no picture' line",
  g1.includes(contract.types.fractionBar.nums) && g1.includes(contract.types.pie.nums) && g1.includes("caption is required")
  && g1.includes("The picture must not print the answer") && !/there is no picture/i.test(g1), g1);

console.log("frozen and shared");
let threw = false;
try { (() => { "use strict"; b1.visual.allowed.push("statBar"); })(); } catch (_) { threw = true; }
let threw2 = false;
try { (() => { "use strict"; b1.lesson.status = "present-and-reviewed"; })(); } catch (_) { threw2 = true; }
check("the brief is deep-frozen (nested arrays and objects cannot be edited)", threw && threw2 && b1.visual.allowed.join() === "fractionBar,pie" && QB.isTeachingBrief(b1));
const tampered = JSON.parse(JSON.stringify(b1)); tampered.misconceptions[0].pattern = "edited";
check("an edited copy is detected (hash no longer matches) and is not accepted by the renderers",
  !QB.verifyBriefHash(tampered) && !QB.isTeachingBrief(tampered) && (() => { try { QB.renderJudgeBrief(tampered); return false; } catch (_) { return true; } })());
const throwsBoth = b => [QB.renderGeneratorBrief, QB.renderJudgeBrief].every(fn => { try { fn(b); return false; } catch (e) { return e instanceof TypeError; } });
const forged = JSON.parse(JSON.stringify(b1)); forged.goal.text = "changed after hashing"; Object.freeze(forged);
check("a shallow-frozen edited copy keeping the old briefHash/briefId is refused", !QB.isTeachingBrief(forged) && throwsBoth(forged) && forged.briefId === b1.briefId);
const unchangedShallow = Object.freeze(JSON.parse(JSON.stringify(b1)));
check("even an unedited copy is refused unless the whole tree is frozen (nested data would stay mutable)", QB.verifyBriefHash(unchangedShallow) && !QB.isTeachingBrief(unchangedShallow) && throwsBoth(unchangedShallow));
check("briefMismatch binds item / grade / kind / topic / lang",
  QB.briefMismatch(b1, { lang: "en", itemId: "YY.T.FRAC", grade: 5, kind: "skill", topicId: "equivalent-fractions" }) === null
  && /not YY\.T\.OTHER/.test(QB.briefMismatch(b1, { itemId: "YY.T.OTHER" }))
  && /grade 5, not 6/.test(QB.briefMismatch(b1, { itemId: "YY.T.FRAC", grade: 6 }))
  && /not standard/.test(QB.briefMismatch(b1, { kind: "standard" }))
  && /topic equivalent-fractions, not review-topic/.test(QB.briefMismatch(b1, { topicId: "review-topic" }))
  && /not zh/.test(QB.briefMismatch(b1, { lang: "zh" }))
  && /not a genuine TeachingBrief/.test(QB.briefMismatch(forged, {})));
const j1 = QB.renderJudgeBrief(b1);
check("generator and judge renderings print the same briefId and rules version", g1.includes(b1.briefId) && j1.includes(b1.briefId) && g1.includes(b1.rules.version) && j1.includes(b1.rules.version));
check("both renderings carry the same goal, misconception ids and allowed picture types",
  [b1.goal.text, "frac.different_whole", "frac.count_shaded_only", "allowed here: fractionBar, pie"].every(s => g1.includes(s) && j1.includes(s)));
check("zh is refused (zh generation stays on the frozen legacy path)", (() => { try { QB.buildTeachingBrief(baseInput({ lang: "zh" })); return false; } catch (e) { return e instanceof TypeError; } })());

process.exit(summary() ? 0 : 1);
