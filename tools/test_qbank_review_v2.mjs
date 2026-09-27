#!/usr/bin/env node
/*
 * 英文题库逐题审稿 v2（lib/ai/qbank/review.js + coordinator.js，#44）：协议严格解析、送审输入、v1 适配器、哈希失效，
 * 以及协调器在假引擎 / 假题库 / 内存存储上的编排（重放、有限修复、身份、超时 / 挂起 / 迟到、取消、dry、复用、
 * 已有题的审查与原地修复、存储失败）。
 *
 *   node tools/test_qbank_review_v2.mjs
 *
 * 纯模块测试：合成题目与合成审稿结论（tools/fixtures/qbank-review-v2-replay.json）、已跟踪的图形契约、
 * 渲染端同一个 public/visual-check.js。不调模型、不联网、不读写任何真实数据。
 * 这里证明的是编排对不对，不证明任何真实审稿引擎能发现这些错误。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeChecker, ROOT } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const QB = require("../lib/ai/qbank/index.js");
const { checkVisual } = require("../public/visual-check.js");
const { check, summary } = makeChecker();

const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/fixtures/qbank-review-v2-replay.json"), "utf8"));
const CONTRACT_REL = "data/curriculum/visual-contract.json";
const contractRaw = fs.readFileSync(path.join(ROOT, CONTRACT_REL), "utf8");
const LESSON_REL = "data/lessons/en/YY.T.FRAC.EQ.json";
const mkBrief = (lesson, over) => QB.buildTeachingBrief(Object.assign({
  item: FX.skill, context: { kind: "skill", grade: 4, topic: { id: "fractions", en: "Fractions" } },
  skillType: { en: "concept", teachEn: "focus on what it means" },
  visualContract: { path: CONTRACT_REL, raw: contractRaw }, lesson
}, over || {}));
const briefL = mkBrief({ path: LESSON_REL, raw: JSON.stringify(FX.lesson) });
const briefNoL = mkBrief({ path: LESSON_REL, missing: true });
const TAGS = new Set(FX.skill.skill.misc.map(m => m.id));
const clone = v => JSON.parse(JSON.stringify(v));
const CASE = Object.fromEntries(FX.cases.map(c => [c.name, c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const JUDGE_ENGINE = { provider: "stubjudge", model: "judge-model-1" };
const REPAIR_ENGINE = { provider: "stubgen", model: "gen-model-1" };
const CONTENT = ["qid", "level", "question", "options", "answerIndex", "explain", "tags", "visual"];
const contentOf = q => JSON.stringify(Object.fromEntries(CONTENT.filter(f => q[f] !== undefined).map(f => [f, q[f]])));

/* 按脚本给一道题造一条合格的 v2 结论：逐项解题与 answerIndex 一致；失败的检查按脚本，其余按题目事实取允许的值；
 * revise 的每个失败检查配一条带 suggestedFix 的发现，needs-human 配一条说明原因的发现 */
function verdictFor(item, brief, s) {
  const checks = {};
  for (const id of QB.CHECK_IDS) {
    const allowed = QB.allowedResults(id, item, brief);
    const result = (s.fail || []).includes(id) ? "fail" : (s.notVerified || []).includes(id) ? "not_verified" : allowed.includes("pass") ? "pass" : allowed[0];
    checks[id] = { result, evidence: `synthetic ${result} for ${id}` };
  }
  const why = (s.problems || [])[0] || "synthetic problem";
  const findings = s.status === "pass" ? [] : s.status === "revise"
    ? (s.fail || []).map(k => ({ category: k, field: k === "visual_semantics" ? "visual.nums" : "", evidence: why, reason: why, suggestedFix: "fix: " + why }))
    : [{ category: (s.notVerified || [])[0] || "skill_level", field: "", evidence: why, reason: why, suggestedFix: "" }];
  const options = [0, 1, 2, 3].map(i => ({ correct: i === item.answerIndex, reason: `solved option ${i}` }));
  return { id: item.id, status: s.status, options, checks, findings };
}

/* ---------- 假依赖 ---------- */
/* 假题库：新题暂存时故意把正确项挪一位（选项和 tags 一起转），证明哈希按暂存后的对象算；
 * 已有 qid 按「原地换内容、保 usedAt」暂存；发布支持 new / replace */
function makeBank(initial) {
  const live = clone(initial || []);
  let n = 0, publishCalls = 0;
  const fp = () => QB.bankFingerprint(live);
  const rotate = q => {
    const c = clone(q);
    c.options = q.options.map((_, i) => q.options[(i + 3) % 4]);
    if (Array.isArray(q.tags)) c.tags = q.tags.map((_, i) => q.tags[(i + 3) % 4]);
    c.answerIndex = (q.answerIndex + 1) % 4;
    return c;
  };
  return {
    live,
    get publishCalls() { return publishCalls; },
    base: () => ({ fingerprint: fp(), qids: live.map(q => q.qid), hashes: Object.fromEntries(live.map(q => [q.qid, QB.contentHash(q)])), questions: clone(live) }),
    stage(items, o) {
      if (o.baseFingerprint !== fp()) throw Object.assign(new Error("bank changed"), { code: "BANK_CHANGED" });
      return { candidates: items.map(q => {
        const cur = q.qid && live.find(x => x.qid === q.qid);
        if (cur) { const c = clone(cur); for (const f of ["question", "options", "answerIndex", "explain", "tags", "visual"]) { if (q[f] === undefined) delete c[f]; else c[f] = clone(q[f]); } return c; }
        return Object.assign({ qid: q.qid || "qs" + (++n), usedAt: 0 }, rotate(q), q.qid ? { qid: q.qid } : {});
      }), dropped: [] };
    },
    publish(cands, o) {
      publishCalls++;
      if (o.baseFingerprint !== fp()) throw Object.assign(new Error("bank changed"), { code: "BANK_CHANGED" });
      cands.forEach((c, i) => {
        if ((o.modes || [])[i] === "replace") { const k = live.findIndex(x => x.qid === c.qid); live[k] = Object.assign(clone(c), { usedAt: live[k].usedAt }); }
        else live.push(Object.assign(clone(c), { usedAt: 0 }));
      });
      return { published: cands.map(c => c.qid) };
    }
  };
}
function makeStore(fail) {
  const m = { records: new Map(), drafts: new Map(), reports: new Map(), dry: { records: new Map(), drafts: new Map(), reports: new Map() }, writes: 0 };
  const box = o => (o && o.dry ? m.dry : m);
  const w = (kind, key) => (v, o) => { if (fail && fail(kind, v, o)) throw new Error("injected " + kind + " failure"); m.writes++; box(o)[kind].set(v[key], clone(v)); };
  return {
    m,
    writeRecord: w("records", "reviewKey"), writeDraft: w("drafts", "draftId"), writeReport: w("reports", "runId"),
    readRecord: (k, o) => clone(box(o).records.get(k) || null),
    readDraft: (k, o) => clone(box(o).drafts.get(k) || null),
    readReport: (k, o) => clone(box(o).reports.get(k) || null),
    listDrafts: (o) => [...box(o).drafts.values()].map(clone)
  };
}
/* 假审稿：按题干认出是哪条用例，按次序回放脚本；可整体替换成任意响应 */
function makeJudge(brief, over) {
  const calls = [], seen = new Map(), counter = new Map();
  const fn = async req => {
    calls.push(clone({ items: req.items, sys: req.sys }));
    if (over) { const r = await over(req, calls.length); if (r !== undefined) return r; }
    return {
      items: req.items.map(it => {
        let name = seen.get(it.id);
        if (!name) { const c = FX.cases.find(c => c.question.question === it.question); name = c ? c.name : "good_l1"; seen.set(it.id, name); }
        const i = counter.get(it.id) || 0; counter.set(it.id, i + 1);
        const sc = CASE[name].script;
        return verdictFor(it, brief, sc[i] || sc[sc.length - 1]);
      })
    };
  };
  return { fn, calls, nameOf: id => seen.get(id) };
}
function makeRepair(judge, over) {
  const calls = [], counter = new Map();
  const fn = async req => {
    calls.push(clone({ draftId: req.draftId, item: req.item, verdict: req.verdict, sys: req.sys }));
    if (over) { const r = await over(req, calls.length); if (r !== undefined) return r; }
    const name = judge.nameOf(req.draftId);
    const i = counter.get(req.draftId) || 0; counter.set(req.draftId, i + 1);
    const list = CASE[name].repairs || [];
    return clone(list[Math.min(i, list.length - 1)]);
  };
  return { fn, calls };
}
let idn = 0;
function deps(o) {
  const brief = o.brief || briefL;
  const bank = o.bank || makeBank();
  const store = o.store || makeStore();
  const judge = o.judge || makeJudge(brief);
  const repair = o.repair || makeRepair(judge);
  return {
    bank, store, judge, repair,
    d: {
      base: bank.base, stage: (i, x) => bank.stage(i, x), publish: (c, x) => bank.publish(c, x),
      judge: judge.fn, repair: repair.fn, store,
      checkVisual, allowedTags: TAGS,
      engine: { judge: o.judgeEngine || JUDGE_ENGINE, repair: REPAIR_ENGINE },
      now: () => "2026-09-26T00:00:00.000Z",
      newId: o.newId || (p => p + "-" + (++idn))
    }
  };
}
const rawOf = (...names) => ({ questions: names.map(n => clone(CASE[n].question)) });
const byName = (res, j) => Object.fromEntries(res.items.map(it => [j.nameOf(it.draftId) || it.draftId, it]));

/* ====================================================================== */
console.log("review input keeps the full question, strips household state, ids unique");
{
  const q = Object.assign(clone(CASE.good_l2_visual.question), { qid: "qv1", usedAt: 1758000000000, kid: { id: "k1" }, seenBy: ["k1"], _internal: 1 });
  const [it] = QB.reviewInput([{ draftId: "dr-1", question: q }]);
  check("id = draftId; qid / tags / visual / level / options / answerIndex / explain kept exactly",
    it.id === "dr-1" && it.qid === "qv1" && JSON.stringify(it.visual) === JSON.stringify(q.visual) && JSON.stringify(it.tags) === JSON.stringify(q.tags)
    && it.level === 2 && it.answerIndex === 1 && it.options.length === 4 && it.explain === q.explain, it);
  check("usedAt and household / internal fields are not sent", !("usedAt" in it) && !("kid" in it) && !("seenBy" in it) && !("_internal" in it), Object.keys(it));
  const req = QB.buildReviewRequest(briefL, [it]);
  check("request prompt carries no usedAt / kid state", !/usedAt|seenBy|"kid"/.test(req.sys));
  let threw = false; try { QB.reviewInput([{ draftId: "../x", question: q }]); } catch (_) { threw = true; }
  check("a candidate without a safe draftId is refused", threw);
  let dup = false; try { QB.reviewInput([{ draftId: "same", question: CASE.good_l1.question }, { draftId: "same", question: CASE.wrong_answer.question }]); } catch (_) { dup = true; }
  check("two questions with one draftId are refused (one verdict cannot certify two questions)", dup);
}

console.log("review request = the same brief + the full rubric");
{
  const items = QB.reviewInput([{ draftId: "dr-a", question: CASE.good_l1.question }, { draftId: "dr-b", question: CASE.good_l2_visual.question }]);
  const req = QB.buildReviewRequest(briefL, items);
  check("prompt embeds renderJudgeBrief(brief) verbatim and the brief id", req.sys.includes(QB.renderJudgeBrief(briefL)) && req.sys.includes(briefL.briefId));
  check("every rubric check is named in the prompt; the schema requires all checks, per-option solving and findings",
    QB.CHECK_IDS.every(id => req.sys.includes(id) && req.hint.includes(id)) && req.schema.properties.items.items.properties.checks.required.join() === QB.CHECK_IDS.join()
    && req.schema.properties.items.items.required.join() === "id,status,options,checks,findings");
  check("rubric: answer by solving each option, explanation, distractors, tag meaning, self-contained, visual whole/units/scale, skill/level, L2/L3 increment, lesson",
    ["answer_unique", "explain_consistent", "distractors", "tag_meaning", "self_contained", "visual_semantics", "skill_level", "level_increment", "lesson_alignment"].join() === QB.CHECK_IDS.join()
    && /Solve every option separately/.test(req.sys) && /whole, the units and the scale/.test(req.sys) && /bigger numbers/.test(req.sys) && /never needs a picture/.test(req.sys));
  check("findings are asked for as category / field / evidence / reason / suggestedFix", /category = the check id/.test(req.sys) && /suggestedFix/.test(req.hint));
  check("uncertainty goes to needs-human with not_verified instead of a guessed pass", /mark that check not_verified and set status needs-human/.test(req.sys));
  check("items are sent with their ids and full visual", req.sys.includes('"id":"dr-b"') && req.sys.includes('"nums":[2,1,4,2]'));
  check("the prompt says a model verdict is not a human approval", /not a human approval/.test(req.sys));
  const reqNo = QB.buildReviewRequest(briefNoL, items);
  check("missing lesson: prompt says lesson_alignment must be not_verified", /lesson_alignment must be not_verified/.test(reqNo.sys) && !/lesson_alignment must be not_verified/.test(req.sys));
  check("rubric has a version and a content hash", /^qbank-review-v2\//.test(QB.RUBRIC.version) && /^[0-9a-f]{64}$/.test(QB.RUBRIC.hash));
}

console.log("strict v2 parsing: identity errors void the whole response");
const IT = QB.reviewInput([{ draftId: "dr-1", question: CASE.good_l1.question }, { draftId: "dr-2", question: CASE.good_l2_visual.question }]);
const okResp = () => ({ items: IT.map(it => verdictFor(it, briefL, { status: "pass" })) });
{
  const p = QB.parseReviewV2(okResp(), IT, briefL);
  check("a complete, consistent response parses ok", p.ok && p.verdicts.get("dr-1").status === "pass" && p.verdicts.get("dr-2").status === "pass", p.errors);
  const cases = [
    ["not an object (array)", [], "not_object"],
    ["null", null, "not_object"],
    ["v1 shape {pass:true} is not a v2 response", { pass: true, problems: [], bad: [] }, "no_items"],
    ["unknown id", (() => { const r = okResp(); r.items[1].id = "dr-9"; return r; })(), "id_unknown"],
    ["duplicate id", (() => { const r = okResp(); r.items[1] = clone(r.items[0]); return r; })(), "id_duplicate"],
    ["missing id", (() => { const r = okResp(); r.items.pop(); return r; })(), "id_missing"],
    ["index instead of id", (() => { const r = okResp(); r.items[0].id = 0; return r; })(), "id_unknown"],
    ["item not an object", (() => { const r = okResp(); r.items.push("pass"); return r; })(), "item_not_object"]
  ];
  for (const [name, raw, code] of cases) {
    const r = QB.parseReviewV2(raw, IT, briefL);
    check(`${name} -> ${code}, response void (no verdicts)`, !r.ok && r.errors.some(e => e.code === code) && r.verdicts.size === 0, r.errors);
  }
  const dupIn = [IT[0], Object.assign(clone(IT[1]), { id: "dr-1" })];
  const r = QB.parseReviewV2({ items: [verdictFor(dupIn[0], briefL, { status: "pass" })] }, dupIn, briefL);
  check("a review set with a repeated id is refused outright (never folded into one verdict)", !r.ok && r.errors[0].code === "input_id_duplicate" && r.verdicts.size === 0, r.errors);
}

console.log("strict v2 parsing: per-item content errors void only that item");
{
  const mut = (f, idx = 0) => { const r = okResp(); f(r.items[idx], r); return QB.parseReviewV2(r, IT, briefL); };
  const cases = [
    ["unknown status", it => { it.status = "approved"; }, "status_invalid"],
    ["checks missing", it => { delete it.checks; }, "checks_missing"],
    ["unknown check", it => { it.checks.style = { result: "pass", evidence: "x" }; }, "check_unknown"],
    ["a check missing", it => { delete it.checks.answer_unique; }, "check_missing"],
    ["result outside the domain", it => { it.checks.answer_unique.result = "ok"; }, "check_result_invalid"],
    ["empty evidence", it => { it.checks.skill_level.evidence = "  "; }, "evidence_missing"],
    ["pass with a failing check", it => { it.checks.answer_unique.result = "fail"; }, "status_incompatible"],
    ["pass with non-empty findings (e.g. 'two correct options')", it => { it.findings = [{ category: "answer_unique", field: "options[1]", evidence: "There are two correct options", reason: "not unique", suggestedFix: "change option 1" }]; }, "status_incompatible"],
    ["answer_unique pass but the per-option solving marks two options correct", it => { it.options[1].correct = true; }, "status_incompatible"],
    ["answer_unique pass but the solving marks a different option than answerIndex", it => { it.options[0].correct = false; it.options[3].correct = true; }, "status_incompatible"],
    ["per-option solving missing", it => { delete it.options; }, "options_missing"],
    ["per-option solving without reasons", it => { it.options[2].reason = ""; }, "options_invalid"],
    ["findings missing", it => { delete it.findings; }, "findings_missing"],
    ["finding with an unknown category", it => { it.status = "revise"; it.checks.answer_unique.result = "fail"; it.findings = [{ category: "style", field: "", evidence: "e", reason: "r", suggestedFix: "f" }]; }, "findings_invalid"],
    ["finding without a reason", it => { it.status = "revise"; it.checks.answer_unique.result = "fail"; it.findings = [{ category: "answer_unique", field: "", evidence: "e", suggestedFix: "f" }]; }, "findings_invalid"],
    ["revise without a failing check", it => { it.status = "revise"; it.findings = [{ category: "answer_unique", field: "", evidence: "e", reason: "r", suggestedFix: "f" }]; }, "status_incompatible"],
    ["revise whose failing check has no finding with a fix", it => { it.status = "revise"; it.checks.distractors.result = "fail"; it.checks.answer_unique.result = "fail"; it.findings = [{ category: "answer_unique", field: "", evidence: "e", reason: "r", suggestedFix: "f" }]; }, "findings_missing"],
    ["needs-human without a finding", it => { it.status = "needs-human"; it.findings = []; }, "findings_missing"],
    ["level_increment must be n/a on Level 1", it => { it.checks.level_increment.result = "pass"; }, "check_result_not_allowed"],
    ["tags present: tag_meaning cannot be n/a", it => { it.checks.tag_meaning.result = "n/a"; }, "check_result_not_allowed"],
    ["no picture does not waive self_contained (n/a refused)", it => { it.checks.self_contained.result = "n/a"; }, "check_result_not_allowed"],
    ["distractor quality is never n/a", it => { it.checks.distractors.result = "n/a"; }, "check_result_not_allowed"],
    ["no visual: visual_semantics must be n/a, a claimed pass is refused", it => { it.checks.visual_semantics.result = "pass"; }, "check_result_not_allowed"],
    ["lesson present: lesson_alignment cannot be not_verified", it => { it.checks.lesson_alignment.result = "not_verified"; }, "check_result_not_allowed"],
    ["not_verified on the answer with status pass", it => { it.checks.answer_unique.result = "not_verified"; }, "check_result_not_allowed"],
    ["not_verified on the answer with status revise", it => { it.status = "revise"; it.checks.answer_unique.result = "not_verified"; it.checks.distractors.result = "fail"; it.findings = [{ category: "distractors", field: "", evidence: "e", reason: "r", suggestedFix: "f" }]; }, "check_result_not_allowed"]
  ];
  for (const [name, f, code] of cases) {
    const r = mut(f);
    check(`${name} -> ${code}; only that item void, the other still parsed`,
      !r.ok && r.errors.some(e => e.code === code && e.id === "dr-1") && r.verdicts.get("dr-1").invalid && r.verdicts.get("dr-2").status === "pass", r.errors);
  }
  const vis = okResp(); vis.items[1].checks.visual_semantics.result = "n/a";
  const rv = QB.parseReviewV2(vis, IT, briefL);
  check("question carries a visual: visual_semantics cannot be n/a", !rv.ok && rv.errors.some(e => e.code === "check_result_not_allowed" && e.id === "dr-2"), rv.errors);
  const nh = okResp(); nh.items[0] = verdictFor(IT[0], briefL, { status: "needs-human", notVerified: ["answer_unique", "self_contained"], problems: ["Cannot tell whether 2/4 or the bar is meant."] });
  const rn = QB.parseReviewV2(nh, IT, briefL);
  check("honest uncertainty: needs-human with not_verified math / picture checks is a valid verdict (not malformed)",
    rn.ok && rn.verdicts.get("dr-1").status === "needs-human" && rn.verdicts.get("dr-1").checks.answer_unique.result === "not_verified" && rn.verdicts.get("dr-1").findings.length === 1, rn.errors);
  const ITno = QB.reviewInput([{ draftId: "dr-1", question: CASE.good_l1.question }]);
  const claim = { items: [verdictFor(ITno[0], briefNoL, { status: "pass" })] };
  claim.items[0].checks.lesson_alignment.result = "pass";
  const rl = QB.parseReviewV2(claim, ITno, briefNoL);
  check("missing lesson: a claimed lesson_alignment pass is refused (not_verified only)", !rl.ok && rl.errors.some(e => e.code === "check_result_not_allowed"), rl.errors);
  const nv = QB.parseReviewV2({ items: [verdictFor(ITno[0], briefNoL, { status: "pass" })] }, ITno, briefNoL);
  check("missing lesson: pass with lesson_alignment not_verified is a valid verdict", nv.ok && nv.verdicts.get("dr-1").checks.lesson_alignment.result === "not_verified", nv.errors);
  const good = verdictFor(IT[0], briefL, { status: "pass" });
  const rec = Object.assign({ status: "pass" }, good);
  check("stored pass re-validation: a complete pass is accepted", QB.storedPassIsValid(rec, IT[0], briefL));
  check("stored pass re-validation: a pass carrying findings is not reusable", !QB.storedPassIsValid(Object.assign(clone(rec), { findings: [{ category: "answer_unique", field: "", evidence: "two correct options", reason: "r", suggestedFix: "f" }] }), IT[0], briefL));
  check("stored pass re-validation: a pass without the per-option solving is not reusable", !QB.storedPassIsValid(Object.assign(clone(rec), { options: undefined }), IT[0], briefL));
}

console.log("v1 compatibility adapter is explicit and never turns a bad v2 response into a pass");
{
  const r = okResp(); r.items[1] = verdictFor(IT[1], briefL, { status: "revise", fail: ["visual_semantics"], problems: ["bar has 4 parts, stem says 3"] });
  const v1 = QB.toV1Verdict(QB.parseReviewV2(r, IT, briefL), IT);
  check("mixed verdicts -> {pass:false, bad:[index of non-pass], problems from the findings}", v1.pass === false && v1.bad.join() === "1" && /visual_semantics visual\.nums: bar has 4 parts/.test(v1.problems[0]), v1);
  check("all pass -> {pass:true, bad:[]}", JSON.stringify(QB.toV1Verdict(QB.parseReviewV2(okResp(), IT, briefL), IT)) === JSON.stringify({ pass: true, problems: [], bad: [] }));
  const nh = okResp(); nh.items[0] = verdictFor(IT[0], briefL, { status: "needs-human", problems: ["unsure"] });
  check("needs-human is not a v1 pass", QB.toV1Verdict(QB.parseReviewV2(nh, IT, briefL), IT).pass === false);
  const withProblems = okResp(); withProblems.items[0].findings = [{ category: "answer_unique", field: "", evidence: "There are two correct options", reason: "r", suggestedFix: "f" }];
  const invalids = [{ pass: true, problems: [] }, { items: [] }, (() => { const x = okResp(); x.items[0].status = "pass!"; return x; })(), (() => { const x = okResp(); x.items[1].id = "dr-1"; return x; })(), withProblems];
  let allThrew = true;
  for (const raw of invalids) { try { QB.toV1Verdict(QB.parseReviewV2(raw, IT, briefL), IT); allThrew = false; } catch (e) { if (!/v2 review response invalid/.test(e.message)) allThrew = false; } }
  check("every invalid v2 response throws in the v1 adapter (v1 {pass:true}, empty, bad status, duplicate id, pass with findings)", allThrew);
}

console.log("hashes: exact published object, reviewKey invalidation");
{
  const q = Object.assign(clone(CASE.good_l1.question), { qid: "qh1", usedAt: 0 });
  const h = QB.contentHash(q);
  check("usedAt does not change the content hash", QB.contentHash(Object.assign(clone(q), { usedAt: 123 })) === h && QB.contentHash((() => { const c = clone(q); delete c.usedAt; return c; })()) === h);
  const swapped = clone(q); [swapped.options[0], swapped.options[1]] = [swapped.options[1], swapped.options[0]]; [swapped.tags[0], swapped.tags[1]] = [swapped.tags[1], swapped.tags[0]]; swapped.answerIndex = 1;
  check("option / tag order changes the content hash (hash describes the shuffled object)", QB.contentHash(swapped) !== h);
  check("qid, visual, any extra field change the content hash",
    QB.contentHash(Object.assign(clone(q), { qid: "qh2" })) !== h && QB.contentHash(Object.assign(clone(q), { visual: CASE.good_l2_visual.question.visual })) !== h && QB.contentHash(Object.assign(clone(q), { note: 1 })) !== h);
  const k0 = QB.reviewKey(briefL, q, JUDGE_ENGINE).reviewKey;
  check("same inputs -> same reviewKey (deterministic)", QB.reviewKey(mkBrief({ path: LESSON_REL, raw: JSON.stringify(FX.lesson) }), clone(q), clone(JUDGE_ENGINE)).reviewKey === k0 && /^rk1-[0-9a-f]{64}$/.test(k0));
  const lesson2 = clone(FX.lesson); lesson2.lesson.steps[1].say += " Always check the wholes.";
  const rules2 = Object.assign(clone(QB.DEFAULT_RULES), { l3SpotMistakeMax: 1 });
  const variants = [
    ["content", QB.reviewKey(briefL, Object.assign(clone(q), { explain: q.explain + " " }), JUDGE_ENGINE)],
    ["lesson text", QB.reviewKey(mkBrief({ path: LESSON_REL, raw: JSON.stringify(lesson2) }), q, JUDGE_ENGINE)],
    ["lesson missing vs present", QB.reviewKey(briefNoL, q, JUDGE_ENGINE)],
    ["rules", QB.reviewKey(mkBrief({ path: LESSON_REL, raw: JSON.stringify(FX.lesson) }, { rules: rules2 }), q, JUDGE_ENGINE)],
    ["brief (misconception text)", QB.reviewKey(mkBrief({ path: LESSON_REL, raw: JSON.stringify(FX.lesson) }, { item: Object.assign(clone(FX.skill), { skill: Object.assign(clone(FX.skill.skill), { misc: [FX.skill.skill.misc[0]] }) }) }), q, JUDGE_ENGINE)],
    ["judge provider", QB.reviewKey(briefL, q, { provider: "other", model: "judge-model-1" })],
    ["judge model", QB.reviewKey(briefL, q, { provider: "stubjudge", model: "judge-model-2" })]
  ];
  for (const [what, r] of variants) check(`changing the ${what} changes the reviewKey`, r.reviewKey !== k0);
  const parts = QB.reviewKey(briefL, q, JUDGE_ENGINE).parts;
  check("key parts name content, brief, lesson sha, rules version+hash, rubric version+hash and engine",
    parts.contentHash === h && parts.briefHash === briefL.briefHash && parts.lesson.sha256 === briefL.lesson.sha256 && parts.rules.version === briefL.rules.version
    && parts.rubric.hash === QB.RUBRIC.hash && parts.engine.provider === "stubjudge" && parts.engine.model === "judge-model-1");
}

/* ====================================================================== */
console.log("coordinator: full replay — only bad items repaired, identity and level kept, published object = hashed object");
{
  const all = FX.cases.map(c => c.name);
  const x = deps({});
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf(...all), deps: x.d, opts: { bankKey: "YY.T.FRAC.EQ|en", maxRepairRounds: 2, timeoutMs: 2000 } });
  const N = byName(res, x.judge);
  check("run status published; every case accounted for", res.status === "published" && res.items.length === all.length, { status: res.status, items: res.items.map(i => i.state) });
  const want = { good_l1: "passed", good_l2_visual: "passed", wrong_answer: "passed", two_correct: "passed", tag_meaning: "passed", visual_whole_units: "passed", needs_picture: "passed", skill_mismatch: "passed", no_increment: "exhausted", needs_human: "needs_human" };
  check("final states match the replay (bad answer / non-unique / tag meaning / visual whole / needs a picture / skill mismatch repaired; no increment exhausted; needs-human held)",
    Object.entries(want).every(([n, s]) => N[n] && N[n].state === s), Object.fromEntries(Object.entries(N).map(([n, i]) => [n, i.state])));
  const repairedNames = x.repair.calls.map(c => x.judge.nameOf(c.draftId));
  check("repair was called only for revise items (never for good or needs-human items)",
    repairedNames.every(n => !["good_l1", "good_l2_visual", "needs_human"].includes(n)) && repairedNames.filter(n => n === "no_increment").length === 2 && x.repair.calls.length === 8, repairedNames);
  check("the repair request carries the failing checks and the reviewer's findings (evidence / reason / suggested fix)",
    x.repair.calls.every(c => c.verdict && Object.values(c.verdict.checks).some(k => k.result === "fail") && c.verdict.findings.length && c.verdict.findings.every(f => f.suggestedFix)) && x.repair.calls.every(c => /Review findings:\n- \[/.test(c.sys)));
  const pubQids = new Set(res.published);
  const liveBy = Object.fromEntries(x.bank.live.map(q => [q.qid, q]));
  check("published = exactly the passed items; exhausted and needs-human are not in the bank",
    res.published.length === 8 && ["no_increment", "needs_human"].every(n => !pubQids.has(N[n].qid) && !liveBy[N[n].qid]) && x.bank.live.length === 8);
  check("every published question hashes to its report contentHash (exact object after the stage shuffle)",
    res.items.filter(i => i.published).every(i => liveBy[i.qid] && QB.contentHash(liveBy[i.qid]) === i.contentHash && i.publication === "added"));
  const preStage = QB.checkEnglishQuestions(rawOf("good_l1"), { brief: briefL, checkVisual, allowedTags: TAGS }).accepted[0];
  check("…and not the pre-stage ordering (the fake stage moved the answer)", QB.contentHash(Object.assign({ qid: N.good_l1.qid, usedAt: 0 }, preStage)) !== N.good_l1.contentHash && liveBy[N.good_l1.qid].answerIndex === 1);
  const srcLevel = Object.fromEntries(FX.cases.map(c => [c.name, c.question.level]));
  check("repaired items keep draftId, qid and level", Object.entries(N).every(([n, it]) => it.level === srcLevel[n] && (!liveBy[it.qid] || (liveBy[it.qid].level === srcLevel[n]))) && N.wrong_answer.repairs === 1 && N.no_increment.repairs === 2);
  const firstReview = x.judge.calls[0].items;
  check("draftIds are assigned before the first review and stay the same through repairs",
    firstReview.length === all.length && x.repair.calls.every(c => firstReview.some(i => i.id === c.draftId)) && res.items.every(i => firstReview.some(r => r.id === i.draftId)));
  for (const n of ["good_l1", "good_l2_visual"]) {
    const reviewed = firstReview.find(i => i.id === N[n].draftId);
    check(`good item ${n}: the published object is exactly the reviewed object (all content fields incl. qid/tags/visual/explain)`,
      contentOf(liveBy[N[n].qid]) === contentOf(reviewed) && liveBy[N[n].qid].usedAt === 0 && !x.repair.calls.some(c => c.draftId === N[n].draftId), { live: liveBy[N[n].qid], reviewed });
  }
  check("the visual-whole repair fixed the picture; the needs-a-picture repair added one", JSON.stringify(liveBy[N.visual_whole_units.qid].visual.nums) === "[3,2]" && liveBy[N.needs_picture.qid].visual.type === "fractionBar");
  check("re-reviews only send the repaired items", x.judge.calls.slice(1).every(c => c.items.every(i => repairedNames.includes(x.judge.nameOf(i.id)))));
  const rep = res.report;
  check("report binds brief, lesson, rules, rubric and engines; says model review, no human approval",
    rep.briefHash === briefL.briefHash && rep.lesson.sha256 === briefL.lesson.sha256 && rep.lesson.humanReview === "unknown" && rep.rules.hash === briefL.rules.hash
    && rep.rubric.hash === QB.RUBRIC.hash && rep.engine.judge.model === "judge-model-1" && rep.humanApproval === "none" && rep.publication.status === "published", rep.publication);
  check("report says lesson alignment was model-reviewed per item (every item got a valid verdict)", rep.lesson.alignment === "model-reviewed-per-item" && rep.coverage.lessonAlignment.pass === all.length, rep.coverage);
  const drafts = x.store.listDrafts();
  check("needs-human and exhausted stay as drafts with their exact content and the reviewer's findings", drafts.filter(d => ["needs_human", "exhausted"].includes(d.state)).length === 2
    && drafts.every(d => d.question && QB.contentHash(d.question) === d.contentHash) && drafts.filter(d => d.state === "needs_human").every(d => d.verdict.findings.length === 1 && d.verdict.findings[0].reason));
  check("nothing on disk or in records claims human approval", !JSON.stringify([...x.store.m.records.values(), ...x.store.m.drafts.values(), rep]).match(/"approved"|human-approved|"humanApproval":"(?!none)/));
}

console.log("coordinator: hard failures are never overridden by a model pass");
{
  const x = deps({});
  /* 修复输出：第一次改了难度，第二次带了不允许的图型 —— 都过不了身份检查 / 硬校验，不送审 */
  const bad1 = Object.assign(clone(CASE.wrong_answer.repairs[0]), { level: 2 });
  const bad2 = Object.assign(clone(CASE.wrong_answer.repairs[0]), { visual: { type: "statBar", nums: [3, 5, 2], labels: ["a", "b", "c"], caption: "x" } });
  const rep = makeRepair(x.judge, (req, n) => n === 1 ? bad1 : bad2);
  x.d.repair = rep.fn;
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("wrong_answer", "good_l1"), deps: x.d, opts: { maxRepairRounds: 2, timeoutMs: 2000 } });
  const N = byName(res, x.judge);
  check("repair that changes the level and repair with a disallowed picture are refused; item exhausted, not published",
    N.wrong_answer.state === "exhausted" && !res.published.includes(N.wrong_answer.qid) && res.published.includes(N.good_l1.qid), res.items);
  check("the refused repairs never reached the reviewer", x.judge.calls.length === 1);
  check("refusals are recorded with their codes", JSON.stringify(N.wrong_answer.attempts).includes("repair_changed_level") && JSON.stringify(N.wrong_answer.attempts).includes("visual_not_allowed"), N.wrong_answer.attempts);

  const y = deps({});
  y.d.repair = makeRepair(y.judge, () => Object.assign(clone(CASE.wrong_answer.repairs[0]), { qid: "someone-else" })).fn;
  const r2 = await QB.runReviewV2({ brief: briefL, raw: rawOf("wrong_answer"), deps: y.d, opts: { maxRepairRounds: 1, timeoutMs: 2000 } });
  check("repair that changes the qid is refused", r2.items[0].state === "exhausted" && JSON.stringify(r2.items[0].attempts).includes("repair_changed_qid") && !r2.published.length);

  /* 原始批次里硬校验不过的题：不进审稿；审稿人对它说 pass 也没用（未知 id → 整个响应作废） */
  const z = deps({});
  const hardBad = Object.assign(clone(CASE.good_l1.question), { question: "Look at the picture below. Which fraction is shaded?" });
  const j3 = makeJudge(briefL, req => ({ items: [...req.items.map(it => verdictFor(it, briefL, { status: "pass" })), verdictFor({ id: "dr-hard", level: 1, answerIndex: 0 }, briefL, { status: "pass" })] }));
  z.d.judge = j3.fn;
  const r3 = await QB.runReviewV2({ brief: briefL, raw: { questions: [hardBad, clone(CASE.good_l1.question)] }, deps: z.d, opts: { timeoutMs: 2000 } });
  check("raw hard-rejected question is reported and never sent to review", r3.hardRejected.length === 1 && r3.hardRejected[0].findings.some(f => f.code === "visual_missing") && j3.calls[0].items.length === 1);
  check("a pass for an id that was not under review voids the response: nothing published", r3.items[0].state === "error" && !r3.published.length && z.bank.live.length === 0, r3.items);
  const held = z.store.listDrafts().filter(dr => dr.state === "hard_rejected");
  check("the hard-rejected question is kept as a non-publishable draft: full content, stable draftId, hard findings, no verdict",
    held.length === 1 && held[0].question.question === hardBad.question && JSON.stringify(held[0].question.options) === JSON.stringify(hardBad.options) && held[0].hardFindings.some(f => f.code === "visual_missing")
    && held[0].verdict === null && held[0].published === false && r3.held.length === 1 && r3.held[0].draftId === held[0].draftId, held);
  const zj = deps({ store: z.store, bank: z.bank });
  const again = await QB.runReviewV2({ brief: briefL, resume: held, deps: zj.d, opts: { timeoutMs: 2000 } });
  check("…and resume never picks the held draft up for review or publication", again.items.length === 0 && /held draft/.test(JSON.stringify(again.stagingDropped)) && zj.judge.calls.length === 0 && z.bank.live.length === 0);
}

console.log("coordinator: a repaired version never inherits the previous version's verdict");
for (const [what, j2] of [["re-review throws", async () => { throw new Error("rereview unavailable"); }], ["re-review times out", () => new Promise(() => {})], ["re-review malformed", async () => ({ items: [] })]]) {
  const x = deps({});
  let n = 0;
  const first = x.judge.fn;
  x.d.judge = req => (++n === 1 ? first(req) : j2(req));
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("wrong_answer"), deps: x.d, opts: { maxRepairRounds: 1, timeoutMs: 60 } });
  const it = res.items[0];
  check(`${what}: repaired item ends without a verdict for its new content (checks/findings empty, coverage 0), not published`,
    ["error", "timeout"].includes(it.state) && it.checks === null && it.findings.length === 0 && it.repairs === 1 && res.report.coverage.itemsWithValidVerdict === 0 && !res.published.length
    && x.store.listDrafts()[0].verdict === null && x.store.listDrafts()[0].contentHash === it.contentHash, it);
  check(`${what}: the old version's verdict survives only as history (attempts / review record of the old hash)`,
    it.attempts.some(a => a.kind === "review" && a.outcome === "revise") && [...x.store.m.records.values()].every(r => r.reviewKey !== it.reviewKey));
}

console.log("coordinator: the staged (exact published) object is hard-checked again");
{
  const x = deps({});
  const st = x.d.stage;
  /* 一个出错的暂存：给第一道题塞了不允许的图型 / 改了字段 → 暂存后的硬校验拦下，不送审、不发布 */
  x.d.stage = (items, o) => { const r = st(items, o); r.candidates[0].visual = { type: "statBar", nums: [3, 5, 2], labels: ["a", "b", "c"], caption: "x" }; r.candidates[1].note = "internal"; return r; };
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1", "good_l2_visual", "wrong_answer"), deps: x.d, opts: { timeoutMs: 2000, maxRepairRounds: 0 } });
  check("staged candidate with a disallowed picture -> hard_failed; with an extra field -> hard_failed (not_normalized); neither reviewed nor published",
    res.items[0].state === "hard_failed" && JSON.stringify(res.items[0].attempts).includes("visual_not_allowed") && res.items[1].state === "hard_failed" && JSON.stringify(res.items[1].attempts).includes("not_normalized")
    && x.judge.calls[0].items.length === 1 && !res.published.includes(res.items[0].qid) && !res.published.includes(res.items[1].qid), res.items.map(i => i.state));
}

console.log("coordinator: identities are unique — collisions are rejected, never folded");
{
  const x = deps({ newId: p => p + "-same" });
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1", "good_l2_visual"), deps: x.d, opts: { timeoutMs: 2000 } });
  check("id generator collision: both colliding candidates rejected, judge never called, nothing written or published",
    res.items.length === 0 && res.identityRejected.length === 2 && x.judge.calls.length === 0 && x.bank.live.length === 0 && x.store.m.drafts.size === 0 && res.status === "nothing_published", res.identityRejected);
  const q = (qid, stem) => Object.assign(clone(CASE.good_l1.question), { qid, question: stem, usedAt: 0 });
  const bank = makeBank();
  const fp = bank.base().fingerprint;
  const y = deps({ bank });
  const r2 = await QB.runReviewV2({ brief: briefL, resume: [
    { draftId: "same", baseFingerprint: fp, question: q("q-first", "Which fraction is equal to 1/2? (first)") },
    { draftId: "same", baseFingerprint: fp, question: q("q-second", "Which fraction is equal to 1/2? (second)") },
    { draftId: "other1", baseFingerprint: fp, question: q("q-dup", "Which fraction is equal to 1/2? (third)") },
    { draftId: "other2", baseFingerprint: fp, question: q("q-dup", "Which fraction is equal to 1/2? (fourth)") }
  ], deps: y.d, opts: { timeoutMs: 2000 } });
  check("resume: two drafts sharing a draftId, or two sharing a qid, are all rejected before the model / store / publish",
    r2.items.length === 0 && r2.identityRejected.length === 4 && y.judge.calls.length === 0 && bank.live.length === 0 && y.store.m.drafts.size === 0, r2.identityRejected);
}

console.log("coordinator: malformed / partial responses leave drafts, publish nothing");
{
  const bads = [
    ["v1-shaped {pass:true}", () => ({ pass: true, problems: [], bad: [] })],
    ["empty object", () => ({})],
    ["missing one verdict", req => ({ items: req.items.slice(1).map(it => verdictFor(it, briefL, { status: "pass" })) })],
    ["duplicate verdict", req => ({ items: [...req.items, req.items[0]].map(it => verdictFor(it, briefL, { status: "pass" })) })],
    ["string", () => "pass"]
  ];
  for (const [name, f] of bads) {
    const x = deps({});
    x.d.judge = makeJudge(briefL, f).fn;
    const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1", "good_l2_visual"), deps: x.d, opts: { timeoutMs: 2000 } });
    check(`${name}: every item error, zero published, drafts kept, report claims no lesson review`, res.items.every(i => i.state === "error") && !res.published.length && x.bank.publishCalls === 0
      && x.store.listDrafts().length === 2 && res.status === "nothing_published" && res.report.lesson.alignment === "not-reviewed", { s: res.status, st: res.items.map(i => i.state) });
  }
  const x = deps({});
  x.d.judge = makeJudge(briefL, req => ({ items: req.items.map((it, i) => { const v = verdictFor(it, briefL, { status: "pass" }); if (i === 0) delete v.checks.self_contained; return v; }) })).fn;
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1", "good_l2_visual"), deps: x.d, opts: { timeoutMs: 2000 } });
  check("one item with a missing check: only it is an error; the valid one is published; lesson coverage says 'some items'",
    res.items[0].state === "error" && res.items[1].state === "passed" && res.published.length === 1 && res.report.lesson.alignment === "model-reviewed-for-some-items", res.items.map(i => i.state));
  const z = deps({});
  z.d.judge = async req => ({ items: req.items.map(it => verdictFor(it, briefL, { status: "pass" })).map(v => Object.assign(v, { findings: [{ category: "answer_unique", field: "", evidence: "There are two correct options", reason: "not unique", suggestedFix: "fix" }] })) });
  const rz = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: z.d, opts: { timeoutMs: 2000 } });
  check("a 'pass' that reports a problem in its findings is not published", rz.items[0].state === "error" && !rz.published.length && z.bank.live.length === 0);
  const h = deps({});
  h.d.judge = async req => ({ items: req.items.map(it => verdictFor(it, briefL, { status: "needs-human", notVerified: ["answer_unique"], problems: ["cannot confirm"] })) });
  const rh = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: h.d, opts: { timeoutMs: 2000 } });
  check("honest needs-human with not_verified math is kept as a needs_human draft (not an error, not published)", rh.items[0].state === "needs_human" && !rh.published.length && h.store.listDrafts()[0].state === "needs_human");
}

console.log("coordinator: thrown / timed out / hanging / late / cancelled calls");
{
  const x = deps({});
  x.d.judge = async () => { throw new Error("engine exploded"); };
  const r1 = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: x.d, opts: { timeoutMs: 2000 } });
  check("thrown judge -> error, nothing published, no lesson review claimed", r1.items[0].state === "error" && /engine exploded/.test(JSON.stringify(r1.items[0].attempts)) && !r1.published.length && r1.report.lesson.alignment === "not-reviewed");

  const y = deps({});
  let sawSignal = null;
  y.d.judge = req => { sawSignal = req.signal; return new Promise(() => {}); };
  const t0 = Date.now();
  const r2 = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: y.d, opts: { timeoutMs: 40 } });
  check("hanging judge -> timeout within the bound, nothing published", r2.items[0].state === "timeout" && Date.now() - t0 < 1500 && !r2.published.length && y.bank.live.length === 0, { ms: Date.now() - t0, s: r2.items[0].state });
  check("the judge got an AbortSignal and it was aborted on timeout", sawSignal && sawSignal.aborted === true);

  const z = deps({});
  let lateDone = false;
  z.d.judge = async req => { await sleep(120); lateDone = true; return { items: req.items.map(it => verdictFor(it, briefL, { status: "pass" })) }; };
  const r3 = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: z.d, opts: { timeoutMs: 30 } });
  const writesAfterRun = z.store.m.writes, reportAfterRun = JSON.stringify(z.store.readReport(r3.runId));
  await sleep(200);
  check("late pass after the timeout: run already finished as timeout", r3.items[0].state === "timeout" && lateDone);
  check("…and the late completion published nothing and wrote nothing", z.bank.live.length === 0 && z.bank.publishCalls === 0 && z.store.m.writes === writesAfterRun && JSON.stringify(z.store.readReport(r3.runId)) === reportAfterRun);

  const w = deps({});
  w.d.repair = () => new Promise(() => {});
  const r4 = await QB.runReviewV2({ brief: briefL, raw: rawOf("wrong_answer", "good_l1"), deps: w.d, opts: { timeoutMs: 40, maxRepairRounds: 2 } });
  const N4 = byName(r4, w.judge);
  check("hanging repair -> that item timeout (draft), good item still published", N4.wrong_answer.state === "timeout" && N4.good_l1.state === "passed" && r4.published.length === 1, r4.items.map(i => i.state));

  const v = deps({});
  const ac = new AbortController();
  v.d.judge = req => { setTimeout(() => ac.abort(), 10); return new Promise(res => setTimeout(() => res({ items: req.items.map(it => verdictFor(it, briefL, { status: "pass" })) }), 60)); };
  const r5 = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: v.d, opts: { timeoutMs: 2000, signal: ac.signal } });
  await sleep(100);
  check("external cancel during review -> cancelled, never published even though the judge later said pass",
    r5.status === "cancelled" && r5.items[0].state === "cancelled" && v.bank.live.length === 0 && v.bank.publishCalls === 0, { s: r5.status, st: r5.items[0].state });
  const pre = new AbortController(); pre.abort();
  const u = deps({});
  const r6 = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: u.d, opts: { signal: pre.signal } });
  check("already-cancelled signal: the judge is never called", r6.status === "cancelled" && u.judge.calls.length === 0 && u.bank.live.length === 0);
}

console.log("coordinator: missing lesson is not_verified, never approved; no claim without a review");
{
  const x = deps({ brief: briefNoL });
  const res = await QB.runReviewV2({ brief: briefNoL, raw: rawOf("good_l1", "good_l2_visual"), deps: x.d, opts: { timeoutMs: 2000 } });
  check("items can pass with lesson_alignment not_verified; report says lesson missing / alignment not_verified / human review unknown",
    res.items.every(i => i.state === "passed" && i.checks.lesson_alignment.result === "not_verified") && res.report.lesson.status === "missing"
    && res.report.lesson.alignment === "not_verified" && res.report.lesson.humanReview === "unknown" && res.report.humanApproval === "none" && res.report.coverage.lessonAlignment.not_verified === 2, res.report.lesson);
  const y = deps({ brief: briefNoL });
  y.d.judge = makeJudge(briefNoL, req => ({ items: req.items.map(it => { const v = verdictFor(it, briefNoL, { status: "pass" }); v.checks.lesson_alignment = { result: "pass", evidence: "matches the lesson" }; return v; }) })).fn;
  const r2 = await QB.runReviewV2({ brief: briefNoL, raw: rawOf("good_l1"), deps: y.d, opts: { timeoutMs: 2000 } });
  check("a reviewer claiming the missing lesson matches -> item error, not published", r2.items[0].state === "error" && !r2.published.length);
  const z = deps({});
  const hardOnly = Object.assign(clone(CASE.good_l1.question), { question: "Look at the picture below. Which fraction is shaded?" });
  const r3 = await QB.runReviewV2({ brief: briefL, raw: { questions: [hardOnly] }, deps: z.d, opts: { timeoutMs: 2000 } });
  check("lesson present but nothing reviewed (all hard-rejected): report does not claim a lesson check", z.judge.calls.length === 0 && r3.report.lesson.alignment === "not-reviewed" && r3.report.coverage.itemsWithValidVerdict === 0, r3.report.lesson);
}

console.log("coordinator: dry runs are separate and never satisfy a real review");
{
  const store = makeStore(), bank = makeBank();
  const x = deps({ store, bank });
  const dry = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: x.d, opts: { dry: true, timeoutMs: 2000 } });
  check("dry run: status dry_run, nothing published, records only in the dry area", dry.status === "dry_run" && bank.live.length === 0 && bank.publishCalls === 0
    && store.m.records.size === 0 && store.m.drafts.size === 0 && store.m.reports.size === 0 && store.m.dry.records.size === 1 && store.m.dry.reports.get(dry.runId).dry === true);
  const drafts = store.listDrafts({ dry: true });
  const y = deps({ store, bank });
  const real = await QB.runReviewV2({ brief: briefL, resume: drafts, deps: y.d, opts: { timeoutMs: 2000 } });
  check("the same content later in a real run is reviewed again (dry pass not reused)", y.judge.calls.length === 1 && real.items[0].cached === false && real.items[0].state === "passed" && real.published.length === 1);
}

console.log("coordinator: exact non-dry pass reuse; brief / lesson / rules / engine / content changes invalidate");
{
  const store = makeStore();
  const x = deps({ store, bank: makeBank() });
  x.d.publish = () => { throw new Error("disk full"); };
  const r1 = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1", "good_l2_visual"), deps: x.d, opts: { timeoutMs: 2000 } });
  check("publication failure: status publish_failed, items passed but not published", r1.status === "publish_failed" && r1.items.every(i => i.state === "passed" && !i.published) && /disk full/.test(r1.publishError));
  check("…the review records exist and claim nothing about publication; drafts and report say not published",
    [...store.m.records.values()].every(r => r.status === "pass" && !("published" in r)) && store.listDrafts().every(d => d.published === false)
    && store.readReport(r1.runId).publication.status === "failed");
  const drafts = store.listDrafts();
  const y = deps({ store, bank: x.bank });
  const r2 = await QB.runReviewV2({ brief: briefL, resume: drafts, deps: y.d, opts: { timeoutMs: 2000 } });
  check("retry from the stored drafts reuses the exact passes (no judge call) and publishes the same objects",
    y.judge.calls.length === 0 && r2.items.every(i => i.cached && i.state === "passed" && i.published) && r2.published.length === 2
    && r2.items.every(i => i.contentHash === r1.items.find(o => o.draftId === i.draftId).contentHash), r2.items);
  const z = deps({ store, bank: x.bank });
  const r2b = await QB.runReviewV2({ brief: briefL, resume: store.listDrafts(), deps: z.d, opts: { timeoutMs: 2000 } });
  check("running the retry again is idempotent: exact pass reused, content already in the bank, nothing written or duplicated",
    x.bank.live.length === 2 && r2b.status === "unchanged" && r2b.items.every(i => i.state === "passed" && i.cached && i.publication === "unchanged") && !r2b.published.length && z.judge.calls.length === 0, r2b.items.map(i => [i.state, i.publication]));

  const lesson2 = clone(FX.lesson); lesson2.lesson.title = "Equal parts";
  const briefL2 = mkBrief({ path: LESSON_REL, raw: JSON.stringify(lesson2) });
  const rules2 = Object.assign(clone(QB.DEFAULT_RULES), { version: "qbank-en-rules/1-test" });
  const briefR2 = mkBrief({ path: LESSON_REL, raw: JSON.stringify(FX.lesson) }, { rules: rules2 });
  const variants = [
    ["lesson text changed", { brief: briefL2 }],
    ["rules changed", { brief: briefR2 }],
    ["judge model changed", { brief: briefL, judgeEngine: { provider: "stubjudge", model: "judge-model-2" } }],
    ["judge provider changed", { brief: briefL, judgeEngine: { provider: "stubjudge2", model: "judge-model-1" } }]
  ];
  for (const [what, o] of variants) {
    const s2 = makeStore(); for (const [k, v] of store.m.records) s2.m.records.set(k, clone(v));
    const zz = deps(Object.assign({ store: s2, bank: makeBank() }, o));
    const r = await QB.runReviewV2({ brief: o.brief, raw: rawOf("good_l1"), deps: zz.d, opts: { timeoutMs: 2000 } });
    check(`${what}: the old pass is not reused (judge called again)`, zz.judge.calls.length === 1 && r.items[0].cached === false);
  }
  /* 同样的 key，记录被手改过 → 不认 */
  const tamper = [
    ["a check inside the pass record changed to fail", rec => { rec.checks.answer_unique.result = "fail"; }],
    ["a problem added to the pass record's findings", rec => { rec.findings = [{ category: "answer_unique", field: "", evidence: "two correct options", reason: "r", suggestedFix: "f" }]; }],
    ["stored question content edited", rec => { rec.question.explain = "edited"; }],
    ["record marked dry", rec => { rec.dry = true; }],
    ["engine in the key parts rewritten", rec => { rec.parts.engine = { provider: "x", model: null }; }],
    ["lesson sha in the key parts rewritten", rec => { rec.parts.lesson.sha256 = "0".repeat(64); }],
    ["a check removed", rec => { delete rec.checks.self_contained; }],
    ["per-option solving removed", rec => { delete rec.options; }]
  ];
  const freshBank = makeBank();
  const base = deps({ store: makeStore(), bank: freshBank });
  await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: Object.assign({}, base.d, { publish: () => { throw new Error("no"); } }), opts: { timeoutMs: 2000 } });
  for (const [what, f] of tamper) {
    const s3 = makeStore();
    for (const [k, v] of base.store.m.records) { const c = clone(v); f(c); s3.m.records.set(k, c); }
    const zz = deps({ store: s3, bank: makeBank() });
    zz.d.base = freshBank.base; zz.d.stage = (i, o) => freshBank.stage(i, o); zz.d.publish = () => ({ published: [] });
    const r = await QB.runReviewV2({ brief: briefL, resume: base.store.listDrafts(), deps: zz.d, opts: { timeoutMs: 2000 } });
    check(`tampered record (${what}) is not reused`, zz.judge.calls.length === 1 && r.items[0].cached === false, r.items[0]);
  }
}

console.log("coordinator: questions already in the bank need current-version evidence (audit / resume)");
{
  const existing = Object.assign(clone(CASE.good_l1.question), { qid: "qexist", usedAt: 1700 });
  const neighbour = Object.assign(clone(CASE.good_l2_visual.question), { qid: "qnb", usedAt: 55 });
  /* 1. 题库里已有、没有任何审稿记录 → 必须审 */
  const b1 = makeBank([existing, neighbour]);
  const x1 = deps({ bank: b1 });
  const r1 = await QB.runReviewV2({ brief: briefL, audit: ["qexist"], deps: x1.d, opts: { timeoutMs: 2000 } });
  check("existing question with no record: reviewed (judge called), passes, nothing rewritten", x1.judge.calls.length === 1 && r1.items[0].state === "passed" && !r1.items[0].cached
    && r1.items[0].publication === "unchanged" && r1.status === "unchanged" && b1.publishCalls === 0 && JSON.stringify(b1.live[0]) === JSON.stringify(existing), r1.items[0]);
  const fp = b1.base().fingerprint;
  const asDraft = { draftId: "dr-exist", itemId: FX.skill.id, baseFingerprint: fp, mode: "new", question: clone(existing) };
  const x1b = deps({ bank: b1 });
  const r1b = await QB.runReviewV2({ brief: briefL, resume: [asDraft], deps: x1b.d, opts: { timeoutMs: 2000 } });
  check("a resume draft whose content is already in the bank, with no record: still reviewed (no silent skip)", x1b.judge.calls.length === 1 && r1b.items[0].state === "passed" && r1b.items[0].publication === "unchanged");
  /* 2. 有这个精确版本的有效 pass → 复用，不调模型 */
  const x2 = deps({ bank: b1, store: x1.store });
  const r2 = await QB.runReviewV2({ brief: briefL, audit: ["qexist"], deps: x2.d, opts: { timeoutMs: 2000 } });
  check("existing question with an exact valid pass: reused, no judge call", x2.judge.calls.length === 0 && r2.items[0].cached && r2.items[0].publication === "unchanged");
  /* 3. brief / 课文 / 规则 / 引擎变了 → 旧 pass 不算数 */
  const lesson2 = clone(FX.lesson); lesson2.lesson.steps[0].say += " Look at the wholes.";
  for (const [what, o] of [["lesson changed", { brief: mkBrief({ path: LESSON_REL, raw: JSON.stringify(lesson2) }) }], ["rules changed", { brief: mkBrief({ path: LESSON_REL, raw: JSON.stringify(FX.lesson) }, { rules: Object.assign(clone(QB.DEFAULT_RULES), { version: "qbank-en-rules/x" }) }) }], ["engine changed", { brief: briefL, judgeEngine: { provider: "stubjudge", model: "judge-model-9" } }]]) {
    const xx = deps(Object.assign({ bank: b1, store: x1.store }, o));
    const rr = await QB.runReviewV2({ brief: o.brief, audit: ["qexist"], deps: xx.d, opts: { timeoutMs: 2000 } });
    check(`existing question, ${what}: the old pass is not reused (reviewed again)`, xx.judge.calls.length === 1 && !rr.items[0].cached);
  }
  /* 4. 已有的坏题：只修它，原地替换，保 qid / level / usedAt，邻居一个字节不动 */
  const badExisting = Object.assign(clone(CASE.wrong_answer.question), { qid: "qbad", usedAt: 4242 });
  const b4 = makeBank([badExisting, neighbour]);
  const nbBefore = JSON.stringify(b4.live[1]);
  const x4 = deps({ bank: b4 });
  const r4 = await QB.runReviewV2({ brief: briefL, audit: ["qbad"], deps: x4.d, opts: { timeoutMs: 2000 } });
  const fixed = b4.live[0];
  check("existing bad question: revise -> repair -> re-review -> replaced in place", r4.status === "published" && r4.items[0].state === "passed" && r4.items[0].repairs === 1 && r4.items[0].publication === "replaced" && r4.published.join() === "qbad", r4.items[0]);
  check("…same qid, same level, usedAt preserved, published object = reviewed hash", fixed.qid === "qbad" && fixed.level === 1 && fixed.usedAt === 4242 && fixed.options[fixed.answerIndex] === "4/6" && QB.contentHash(fixed) === r4.items[0].contentHash);
  check("…the neighbouring question is untouched and nothing was appended", JSON.stringify(b4.live[1]) === nbBefore && b4.live.length === 2);
  /* 5. 替换草稿要替换的那个版本在题库里已经变了 → 不收 */
  const d4 = x4.store.listDrafts()[0];
  const stale = Object.assign(clone(d4), { draftId: "dr-stale", question: Object.assign(clone(d4.question), { explain: "another fix" }) });
  const x5 = deps({ bank: b4 });
  const r5 = await QB.runReviewV2({ brief: briefL, resume: [stale], deps: x5.d, opts: { timeoutMs: 2000 } });
  check("a replacement draft whose target version changed in the bank is dropped, not applied", r5.items.length === 0 && /changed/.test(JSON.stringify(r5.stagingDropped)) && x5.judge.calls.length === 0 && b4.live[0].explain === fixed.explain, r5.stagingDropped);
  check("audit of a qid that is not in the bank is reported, nothing reviewed", (await QB.runReviewV2({ brief: briefL, audit: ["nope"], deps: deps({ bank: b4 }).d })).stagingDropped.length === 1);
  /* 6. 「没改动」也要按此刻的题库确认：审稿期间这道题被改了 → 不能说审过的是现在这份 */
  const b6 = makeBank([Object.assign(clone(existing))]);
  const x6 = deps({ bank: b6 });
  const j6 = x6.judge.fn;
  x6.d.judge = async req => { const r = await j6(req); b6.live[0].question = "Concurrent edit that nobody reviewed?"; return r; };
  const r6 = await QB.runReviewV2({ brief: briefL, audit: ["qexist"], deps: x6.d, opts: { timeoutMs: 2000 } });
  check("audit race: the question changed during review -> stale, not certified unchanged, status publish_failed",
    r6.items[0].state === "stale" && !r6.unchanged.length && r6.stale.join() === "qexist" && r6.status === "publish_failed" && !r6.items[0].published
    && b6.live[0].question === "Concurrent edit that nobody reviewed?" && x6.store.listDrafts()[0].state === "stale", { st: r6.items[0].state, s: r6.status });
}

console.log("coordinator: sidecars never carry household state; unknown judge models are never reused");
{
  const q = Object.assign(clone(CASE.good_l1.question), { qid: "qpriv", usedAt: 987654321, seenBy: ["kid-1"] });
  const b = makeBank([q]);
  const x = deps({ bank: b });
  const res = await QB.runReviewV2({ brief: briefL, audit: ["qpriv"], deps: x.d, opts: { timeoutMs: 2000 } });
  const side = JSON.stringify([...x.store.m.records.values(), ...x.store.m.drafts.values(), [...x.store.m.reports.values()]]);
  check("audited question carrying an extra household field is not a clean bank object: hard_failed (not_normalized), never reviewed",
    res.items[0].state === "hard_failed" && JSON.stringify(res.items[0].attempts).includes("not_normalized") && x.judge.calls.length === 0);
  check("…and no sidecar (record / draft / report) contains usedAt, its value, or the household field", !/usedAt|987654321|seenBy|kid-1/.test(side), side.slice(0, 300));
  const clean = Object.assign(clone(CASE.good_l1.question), { qid: "qpriv2", usedAt: 987654321 });
  const b2 = makeBank([clean]);
  const y = deps({ bank: b2 });
  const r2 = await QB.runReviewV2({ brief: briefL, audit: ["qpriv2"], deps: y.d, opts: { timeoutMs: 2000 } });
  const side2 = JSON.stringify([...y.store.m.records.values(), ...y.store.m.drafts.values(), [...y.store.m.reports.values()]]);
  check("clean audited question: reviewed and unchanged; records and drafts exclude usedAt while the live bank keeps it",
    r2.items[0].state === "passed" && r2.items[0].publication === "unchanged" && !/usedAt|987654321/.test(side2) && b2.live[0].usedAt === 987654321 && y.judge.calls[0].items.every(i => !("usedAt" in i)));

  const store = makeStore(), bank = makeBank();
  const unknownEngine = { provider: "clidefault" };
  const u1 = deps({ store, bank, judgeEngine: unknownEngine });
  u1.d.publish = () => { throw new Error("no"); };
  const ra = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: u1.d, opts: { timeoutMs: 2000 } });
  const u2 = deps({ store, bank, judgeEngine: unknownEngine });
  const rb = await QB.runReviewV2({ brief: briefL, resume: store.listDrafts(), deps: u2.d, opts: { timeoutMs: 2000 } });
  check("judge with unknown model: identity exact:false, the pass is recorded but a retry reviews again (no same-model proof)",
    ra.report.engine.judge.exact === false && ra.report.engine.judge.model === null && /none/.test(ra.report.engine.reuse) && store.m.records.size === 1
    && u2.judge.calls.length === 1 && rb.items[0].cached === false && rb.status === "published", { e: ra.report.engine, calls: u2.judge.calls.length });
  check("engine identity: settings (e.g. effort) are part of the key; exact needs a model",
    QB.reviewKey(briefL, clean, { provider: "claude", model: "m", settings: { effort: "high" } }).reviewKey !== QB.reviewKey(briefL, clean, { provider: "claude", model: "m", settings: { effort: "low" } }).reviewKey
    && QB.engineIdentity({ provider: "x" }).exact === false && QB.engineIdentity({ provider: "x", model: "m" }).exact === true && QB.engineIdentity({ provider: "x", model: "m", exact: false }).exact === false);
}

console.log("coordinator: resume only takes this item's drafts");
{
  const store = makeStore(), bank = makeBank();
  const x = deps({ store, bank });
  x.d.publish = () => { throw new Error("no"); };
  await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: x.d, opts: { bankKey: "YY.T.FRAC.EQ|en", timeoutMs: 2000 } });
  const [dr] = store.listDrafts();
  const foreign = [Object.assign(clone(dr), { draftId: "dr-foreign1", itemId: "YY.OTHER" }), Object.assign(clone(dr), { draftId: "dr-foreign2", bankKey: "YY.OTHER|en" }), { draftId: "../bad", question: dr.question }];
  const y = deps({ store, bank });
  const r = await QB.runReviewV2({ brief: briefL, resume: foreign, deps: y.d, opts: { bankKey: "YY.T.FRAC.EQ|en", timeoutMs: 2000 } });
  check("drafts of another item / bank and malformed drafts are dropped, never reviewed or published",
    r.items.length === 0 && r.stagingDropped.length === 3 && y.judge.calls.length === 0 && bank.live.length === 0, r.stagingDropped);
}

console.log("coordinator: storage failure blocks publication");
{
  for (const kind of ["records", "drafts", "reports"]) {
    const store = makeStore(k => k === kind);
    const x = deps({ store });
    const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: x.d, opts: { timeoutMs: 2000 } });
    check(`${kind} write fails -> storage_failed, publish never called, bank untouched`,
      res.status === "storage_failed" && x.bank.publishCalls === 0 && x.bank.live.length === 0 && !res.published.length && res.items.every(i => !i.published) && /injected/.test(res.storageError), { s: res.status, e: res.storageError });
  }
  /* 发布成功后收尾写失败：返回里如实说明，存储里的报告停在 pending（不是 published） */
  let publishedOnce = false;
  const store = makeStore(kind => publishedOnce && kind === "reports");
  const x = deps({ store });
  const pub = x.d.publish; x.d.publish = (c, o) => { const r = pub(c, o); publishedOnce = true; return r; };
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("good_l1"), deps: x.d, opts: { timeoutMs: 2000 } });
  check("finalize write failure after a durable publish: status published, finalize error surfaced, stored report still says pending",
    res.status === "published" && res.finalizeErrors.length >= 1 && store.readReport(res.runId).publication.status === "pending" && x.bank.live.length === 1, { s: res.status, f: res.finalizeErrors });
}

console.log("coordinator: bounds are explicit and clamped");
{
  const x = deps({});
  const res = await QB.runReviewV2({ brief: briefL, raw: rawOf("no_increment"), deps: x.d, opts: { maxRepairRounds: 99, timeoutMs: 2000 } });
  check("maxRepairRounds is clamped to 3 (never more repair calls)", res.report.limits.maxRepairRounds === 3 && x.repair.calls.length <= 3 && res.items[0].state === "exhausted", { l: res.report.limits, n: x.repair.calls.length });
  const y = deps({});
  const r0 = await QB.runReviewV2({ brief: briefL, raw: rawOf("wrong_answer"), deps: y.d, opts: { maxRepairRounds: 0, timeoutMs: 2000 } });
  check("maxRepairRounds 0: a revise verdict is exhausted immediately, no repair call", r0.items[0].state === "exhausted" && y.repair.calls.length === 0);
  check("defaults: 2 repair rounds, finite timeout", QB.REVIEW_V2_DEFAULTS.maxRepairRounds === 2 && QB.REVIEW_V2_DEFAULTS.timeoutMs > 0 && QB.REVIEW_V2_DEFAULTS.maxRepairRoundsCap === 3);
  let threw = 0;
  for (const bad of [{ brief: {} }, { deps: Object.assign({}, x.d, { judge: null }) }, { deps: Object.assign({}, x.d, { store: null }) }, { audit: ["q"] }]) {
    try { await QB.runReviewV2(Object.assign({ brief: briefL, raw: rawOf("good_l1"), deps: x.d }, bad)); } catch (_) { threw++; }
  }
  check("missing brief / judge / store, or two inputs at once, is a programming error (throws), not a silent pass", threw === 4);
}

process.exitCode = summary() ? 0 : 1;
