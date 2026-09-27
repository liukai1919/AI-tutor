#!/usr/bin/env node
/*
 * server.js 英文出题接缝（#43）：真实的 ensureQuizBank / qbankPrompt / judgeQuizPrompt / qbankBriefFor，
 * 假引擎回放合成输出。证明：
 *   - 英文正常路径真的走了硬校验，而且在送审、入库、落盘之前；坏图 / 缺图 / 不允许的图型 / qid 冲突一道都进不了题库；
 *   - 出题提示词、schema、格式说明、审稿回调拿到的是同一个冻结 TeachingBrief（显式注入时是同一个对象引用）；
 *   - 合法 visual / tags / qid 一路保留到内存题库和 qbank.json；只收一个参数的老审稿回调照常工作。
 *
 *   node tools/test_qbank_server_seam.mjs
 *
 * 隔离：临时 DATA_ROOT（demo 题库 + 空 config），课程 / 课文 / 契约读仓库里已跟踪的文件；不调任何真实模型、不联网。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeChecker, ROOT } from "./lib/isolated_server.mjs";
import { loadIsolatedServer, installStubEngine, quiet } from "./lib/inproc_server.mjs";
const { check, summary } = makeChecker();

const srv = loadIsolatedServer("qbank-seam");
const S = srv.S;
const eng = installStubEngine(S, "stubseam");
const sha = s => crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("hex");
const find = id => { const f = S.findCurriculumItem(id); if (!f) throw new Error("tracked curriculum item missing: " + id); return f; };
const FRAC = "YY.MATH.FRAC.EQUIV.VISUAL";
const { item, data } = find(FRAC);
const key = S.qbankKey(FRAC, "en");
const diskBank = () => { try { return (JSON.parse(fs.readFileSync(path.join(srv.DATA, "qbank.json"), "utf8"))[key] || { questions: [] }).questions; } catch (_) { return []; } };
const ledger = () => { try { return fs.readFileSync(path.join(srv.DATA, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };

console.log("qbankBriefFor reads tracked files and records them honestly");
const brief = S.qbankBriefFor(item, data);
{
  const lessonRel = "data/lessons/en/" + FRAC + ".json";
  const lessonRaw = fs.readFileSync(path.join(ROOT, lessonRel), "utf8");
  const contractRaw = fs.readFileSync(path.join(ROOT, "data/curriculum/visual-contract.json"), "utf8");
  check("lesson: tracked file, repo-relative path, sha256 of its text, human review unknown",
    brief.lesson.status === "present" && brief.lesson.path === lessonRel && brief.lesson.sha256 === sha(lessonRaw) && brief.lesson.humanReview === "unknown", brief.lesson.path);
  check("contract: repo-relative path and sha256 of the tracked contract", brief.visual.contract.path === "data/curriculum/visual-contract.json" && brief.visual.contract.sha256 === sha(contractRaw));
  check("allowed pictures for this skill = its representations that are question types", brief.visual.allowed.join() === "fractionBar,pie", brief.visual.allowed);
  check("misconceptions are the registered ones on item.skill", brief.misconceptions.map(m => m.id).join() === item.skill.misc.map(m => m.id).join());
  const graph = ["g4", "g5", "g6", "g7", "g8", "g9"].flatMap(g => JSON.parse(fs.readFileSync(path.join(ROOT, "data/curriculum/skills", g + ".json"), "utf8")).skills);
  const expectDeps = graph.filter(s => (s.prereq || []).includes(FRAC)).map(s => s.id).sort();
  check("out-of-scope list = exactly the skills whose prereq lists this skill (graph fact)", brief.outOfScope.skills.map(s => s.id).join() === expectDeps.join() && expectDeps.length > 0, { got: brief.outOfScope.skills.map(s => s.id), expectDeps });
  check("rebuilding from the same files gives the same hash", S.qbankBriefFor(item, data).briefHash === brief.briefHash);
  const book = find("AOPS.PA.C01.S01");
  const bb = S.qbankBriefFor(book.item, book.data);
  check("an item without an English lesson file is recorded as missing, not verified",
    bb.lesson.status === "missing" && bb.lesson.path === "data/lessons/en/AOPS.PA.C01.S01.json" && bb.coverage.lessonAlignment === "not-verifiable" && !fs.existsSync(path.join(ROOT, bb.lesson.path)), bb.lesson);
  check("zh gets no brief: qbankPrompt zh ignores a brief argument", S.qbankPrompt(item, data, "zh", { 1: 4 }, [], brief) === S.qbankPrompt(item, data, "zh", { 1: 4 }, []));
}

/* 合成的一批「模型输出」：好题 + 各种坏题 */
const T = (level, stem, over) => Object.assign({ level, question: stem, options: ["2/4", "2/3", "1/3", "3/4"], answerIndex: 0,
  explain: "Multiply the top and bottom by the same number.", tags: ["ok", "frac.different_whole", "frac.count_shaded_only", "other"] }, over || {});
const GOOD_VIS = { type: "fractionBar", nums: [2, 1, 4, 2], caption: "Two bars of the same length" };
const good = () => [
  T(1, "A bar is cut into 2 equal parts and 1 is shaded. Which fraction is equal?", { qid: "qvis1", visual: JSON.parse(JSON.stringify(GOOD_VIS)), options: ["1/3", "2/4", "2/3", "3/4"], answerIndex: 1, tags: ["frac.count_shaded_only", "ok", "frac.different_whole", "other"] }),
  T(1, "Which fraction equals 1/2? A bar has 4 equal parts."),
  T(1, "3/6 is equal to which fraction with denominator 4?"),
  T(2, "Sam ate 2/8 of a pizza. Which fraction of the same pizza is equal?", { options: ["1/4", "1/3", "2/6", "3/8"] }),
  T(2, "Which fraction equals 4/6?", { options: ["2/3", "3/4", "4/5", "1/6"] }),
  T(3, "Ana ate 1/2 of a small pizza and Ben ate 2/4 of a large one. Did they eat the same amount?", { options: ["No: the wholes differ", "Yes: 2/4 = 1/2", "Yes: both ate 2 parts", "No: 4 is bigger than 2"] }),
  T(3, "Lee shaded 3 of 6 parts. Mia shaded 2 of 4 parts of an equal bar. Who shaded more?", { options: ["Same amount", "Lee", "Mia", "Cannot tell"] })
];
const BAD = [
  ["invalid contract (denominator 0)", T(1, "A bar has 0 equal parts shaded?", { visual: { type: "fractionBar", nums: [0, 1], caption: "bad bar" } }), "visual_contract"],
  ["picture type not allowed for this skill", T(2, "Which month had the most rain?", { visual: { type: "statBar", nums: [3, 5, 2], labels: ["May", "Jun", "Jul"], caption: "Rain" } }), "visual_not_allowed"],
  ["refers to a picture it does not carry", T(1, "Look at the picture below. Which fraction is shaded?"), "visual_missing"],
  ["pie without caption", T(2, "What fraction of the circle is shaded?", { visual: { type: "pie", nums: [4, 1] } }), "visual_caption"],
  ["qid colliding with an existing bank question", T(3, "Which fraction is equal to 6/8?", { qid: "qexisting" }), "qid_conflict"]
];
const allBadStems = BAD.map(b => b[1].question);
const existing = { qid: "qexisting", level: 1, question: "Existing reviewed question?", options: ["a", "b", "c", "d"], answerIndex: 0, explain: "kept", usedAt: 5 };

async function run(label, { raws, judge, extra, bank }) {
  S.qbank[key] = { questions: (bank || []).map(q => JSON.parse(JSON.stringify(q))) };
  S.qbankSave();
  eng.reset(); eng.queue(...raws);
  try { fs.rmSync(path.join(srv.DATA, "usage.jsonl")); } catch (_) {}
  let error = null, out;
  try { out = await quiet(() => S.ensureQuizBank(item, data, "en", eng.id, "test:quiz", judge, extra)); }
  catch (e) { error = e; out = { lines: e.lines || [] }; }
  return { error, lines: out.lines, bank: S.qbank[key].questions, disk: diskBank(), calls: eng.calls.slice() };
}

console.log("English path: hard checks run before review, merge and save");
{
  const seen = [];
  const r = await run("mixed", { raws: [{ questions: [...good(), ...BAD.map(b => b[1])] }], judge: function (batch, ctx) { seen.push({ argc: arguments.length, batch: JSON.parse(JSON.stringify(batch)), ctx }); return { pass: true, problems: [], bad: [] }; }, bank: [existing] });
  const call = r.calls[0] || {};
  check("ensureQuizBank succeeded with one engine call", !r.error && r.calls.length === 1, r.error && r.error.message);
  const ctx = seen[0] && seen[0].ctx;
  check("judge got (batch, ctx) with a frozen TeachingBrief for this item", seen.length === 1 && seen[0].argc === 2 && ctx && Object.isFrozen(ctx.brief) && ctx.brief.item.id === FRAC && ctx.briefId === ctx.brief.briefId, seen[0] && seen[0].argc);
  check("the generator prompt printed the same briefId the judge received", call.sys.includes(ctx.brief.briefId) && ctx.brief.briefHash === brief.briefHash, ctx.brief.briefId);
  check("generator prompt: no 'there is no picture' instruction; picture rules and allowed types present",
    !/there is no picture/i.test(call.sys) && /Question pictures \(optional "visual"/.test(call.sys) && /allowed here: fractionBar, pie/.test(call.sys), call.sys.split("\n").filter(l => /picture/i.test(l)).slice(0, 4));
  check("schema sent to the engine allows visual with enum = allowed types", JSON.stringify(call.schema.properties.questions.items.properties.visual.properties.type.enum) === '["fractionBar","pie"]');
  check("format hint sent to the engine explains the optional visual", /"visual":\{"type":"fractionBar"/.test(call.hint) && /"tags":\["ok"/.test(call.hint), call.hint);
  const jb = seen[0].batch;
  check("the judge never saw a hard-rejected question", jb.length === good().length && !jb.some(q => allBadStems.includes(q.question)), jb.map(q => q.question));
  const jv = jb.find(q => q.qid === "qvis1");
  check("the judge saw the full legal question: qid, tags and visual intact", jv && JSON.stringify(jv.visual) === JSON.stringify(GOOD_VIS) && jv.tags.join() === "frac.count_shaded_only,ok,frac.different_whole,other", jv);
  check("ctx lists what the hard checks rejected and what they cannot check", ctx.hardChecks.rejected.length === BAD.length && ctx.hardChecks.coverage.notChecked.length > 0);
  BAD.forEach(([label, q, code]) => {
    const rej = ctx.hardChecks.rejected.find(x => x.stem === q.question);
    check("  rejected before review: " + label + " (" + code + ")", !!rej && rej.findings.some(f => f.code === code), rej);
  });
  const mem = r.bank, disk = r.disk;
  check("no rejected question reached the in-memory bank or qbank.json",
    !mem.some(q => allBadStems.includes(q.question)) && !disk.some(q => allBadStems.includes(q.question)) && disk.length === mem.length && mem.length === 1 + good().length, { mem: mem.length, disk: disk.length });
  const ex = mem.find(q => q.qid === "qexisting");
  check("the existing question with the colliding qid was not overwritten", ex && ex.question === existing.question && ex.usedAt === 5, ex);
  const sv = disk.find(q => q.qid === "qvis1");
  check("the legal picture question is stored with its qid and visual unchanged", sv && JSON.stringify(sv.visual) === JSON.stringify(GOOD_VIS), sv);
  check("merge may move options but keeps each tag with its option (correct option still tagged ok)",
    sv && sv.tags[sv.answerIndex] === "ok" && sv.options[sv.answerIndex] === "2/4"
    && sv.options.every((o, i) => ({ "1/3": "frac.count_shaded_only", "2/4": "ok", "2/3": "frac.different_whole", "3/4": "other" })[o] === sv.tags[i]), sv);
  check("the rejection is logged with the brief id", r.lines.some(l => /hard checks rejected 5\/12/.test(l) && l.includes(brief.briefId)), r.lines.filter(l => /hard/.test(l)));
  check("pregen-style reviewer prompt built from ctx.brief carries the same briefId and the full questions",
    (() => { const p = S.judgeQuizPrompt(item, data, jb, "en", ctx.brief); return p.includes(ctx.brief.briefId) && p.includes('"qid":"qvis1"') && p.includes('"visual":{"type":"fractionBar"') && p.includes("Registered misconceptions"); })());
}

console.log("an injected brief is the very object used for prompt and review");
{
  const pre = S.qbankBriefFor(item, data);
  let got = null;
  const r = await run("inject", { raws: [{ questions: good() }], judge: (b, c) => { got = c; return { pass: true, problems: [], bad: [] }; }, extra: { brief: pre } });
  check("judge ctx.brief === the injected brief object", !r.error && got && got.brief === pre, r.error && r.error.message);
  check("generator prompt printed that brief's id", r.calls[0].sys.includes(pre.briefId));
  const otherBrief = S.qbankBriefFor(find("YY.MATH.DATA.LINE.READ").item, find("YY.MATH.DATA.LINE.READ").data);
  const r2 = await run("wrong", { raws: [{ questions: good() }], extra: { brief: otherBrief } });
  check("a brief for another item is refused before any engine call", !!r2.error && /does not belong/.test(r2.error.message) && r2.calls.length === 0 && r2.bank.length === 0, r2.error && r2.error.message);
  const tampered = JSON.parse(JSON.stringify(pre));
  const r3 = await run("plain", { raws: [{ questions: good() }], extra: { brief: tampered } });
  check("a plain (unfrozen) copy is refused before any engine call", !!r3.error && r3.calls.length === 0);
}

console.log("briefs are bound to the exact item view and must be genuine");
{
  /* 同一个技能 id 在高年级视图里当复习题（review）：年级 / 主题不同，本年级视图的 brief 不能拿去用 */
  let review = null, native = null;
  for (const d of S.curriculum.values()) {
    if (!d || d.type !== "skills-preview") continue;
    for (const it of d.items || []) if (it.skill && it.skill.reviewFrom > 0 && !review) review = { item: it, data: d };
  }
  for (const d of S.curriculum.values()) {
    if (!d || d.type !== "skills-preview" || !review) continue;
    const it = (d.items || []).find(x => x.id === review.item.id && !(x.skill.reviewFrom > 0));
    if (it) native = { item: it, data: d };
  }
  check("fixture: found a skill borrowed as review into another grade view", !!review && !!native && review.data.grade !== native.data.grade, review && review.item.id);
  const nb = S.qbankBriefFor(native.item, native.data);
  const rk = S.qbankKey(review.item.id, "en");
  const qsOf = () => JSON.stringify(((S.qbank[rk] || {}).questions) || []);   // ensureQuizBank 总会先建一个空容器（老行为），比的是里面的题
  const before = qsOf();
  eng.reset();
  let err = null;
  try { await quiet(() => S.ensureQuizBank(review.item, review.data, "en", eng.id, "test:quiz", null, { brief: nb })); } catch (e) { err = e; }
  check("the same skill id's brief from its native grade is refused for the review view (grade/topic differ), before any engine call",
    !!err && /grade|topic/.test(err.message) && eng.calls.length === 0 && qsOf() === before, err && err.message);
  check("qbankPrompt refuses the other view's brief too", (() => { try { S.qbankPrompt(review.item, review.data, "en", { 1: 4 }, [], nb); return false; } catch (e) { return /does not belong/.test(e.message); } })());
  const forged = JSON.parse(JSON.stringify(brief)); forged.misconceptions[0].pattern = "edited after hashing"; Object.freeze(forged);
  const r = await run("forged", { raws: [{ questions: good() }], extra: { brief: forged } });
  check("a shallow-frozen edited brief that kept the old briefId is refused before any engine call", !!r.error && /not a genuine TeachingBrief/.test(r.error.message) && r.calls.length === 0 && r.bank.length === 0, r.error && r.error.message);
  check("judgeQuizPrompt refuses the forged brief", (() => { try { S.judgeQuizPrompt(item, data, [], "en", forged); return false; } catch (e) { return /not a genuine/.test(e.message); } })());
}

console.log("the judge sees a frozen copy; what gets stored is what passed the hard checks");
{
  /* 非严格模式的回调：改冻结对象静默无效 */
  const sloppy = new Function("batch", "ctx", "batch[0].visual = { type: 'statBar', nums: [1], caption: 'x' }; batch[0].question = 'EDITED BY JUDGE'; ctx.brief = null; return { pass: true, problems: [], bad: [] };");
  const r = await run("sloppy", { raws: [{ questions: good() }], judge: sloppy });
  const sv = r.disk.find(q => q.qid === "qvis1");
  check("a (sloppy-mode) judge that edits its batch cannot change what is stored",
    !r.error && sv && JSON.stringify(sv.visual) === JSON.stringify(GOOD_VIS) && !r.disk.some(q => q.question === "EDITED BY JUDGE" || (q.visual && q.visual.type === "statBar")), r.error && r.error.message);
  let seenFrozen = null;
  const strict = (batch) => { seenFrozen = Object.isFrozen(batch) && Object.isFrozen(batch[0]) && (!batch[0].visual || Object.isFrozen(batch[0].visual)); batch[0].visual = { type: "statBar" }; return { pass: true, problems: [], bad: [] }; };
  const r2 = await run("strict", { raws: [{ questions: good() }, { questions: good() }], judge: strict });
  check("a strict-mode judge that tries to edit throws; nothing is published", seenFrozen === true && !!r2.error && r2.bank.length === 0 && r2.disk.length === 0, { seenFrozen, err: r2.error && r2.error.message });
}

console.log("skill with an empty misconception registry keeps legal ok/other tags");
{
  const bare = Object.assign({}, item, { skill: Object.assign({}, item.skill, { misc: [] }) });
  const qs = good().map(q => Object.assign({}, q, { tags: q.tags.map((t, i) => i === q.answerIndex ? "ok" : "other") }));
  qs[1].tags[1] = "frac.different_whole";   // 登记表是空的：这个 id 不认，规范成 other
  const k = S.qbankKey(bare.id, "en");
  S.qbank[k] = { questions: [] };
  eng.reset(); eng.queue({ questions: qs });
  let err = null;
  try { await quiet(() => S.ensureQuizBank(bare, data, "en", eng.id, "test:quiz", null)); } catch (e) { err = e; }
  const stored = diskBank();
  check("all generated questions stored with 4 tags, correct option 'ok', the rest 'other'",
    !err && stored.length === qs.length && stored.every(q => Array.isArray(q.tags) && q.tags.length === 4 && q.tags[q.answerIndex] === "ok" && q.tags.filter(t => t === "other").length === 3), err ? err.message : stored.map(q => q.tags));
  check("the hint for an empty registry does not ask for misconception tags", !/"tags"/.test(eng.calls[0].hint), eng.calls[0].hint);
}

console.log("nothing publishable -> nothing published");
{
  const allBad = { questions: BAD.slice(0, 4).map(b => b[1]).concat(BAD.slice(0, 4).map(b => Object.assign({}, b[1], { question: b[1].question + " (2)" }))) };
  let judged = 0;
  const r = await run("allbad", { raws: [allBad, allBad], judge: () => { judged++; return { pass: true, problems: [], bad: [] }; } });
  check("every question failing hard checks -> ensureQuizBank fails after its retry", !!r.error && r.calls.length === 2, r.error && r.error.message);
  check("the judge was never asked and nothing was stored (memory or disk)", judged === 0 && r.bank.length === 0 && r.disk.length === 0, { judged, mem: r.bank.length, disk: r.disk.length });
  const rows = ledger().filter(x => x.task === "test:quiz");
  check("the usage ledger records the hard-check failure reason", rows.length === 2 && rows.every(x => x.ok === false && /有效题目太少（硬校验拒绝：/.test(x.err)), rows);
}

console.log("legacy one-argument judge and no judge");
{
  const argcs = [];
  const r = await run("legacy", { raws: [{ questions: good() }], judge: function (batch) { argcs.push(arguments.length); return { pass: false, problems: ["first is off-topic"], bad: [0] }; } });
  check("a one-argument judge still works on the English path (bad index dropped)", !r.error && r.bank.length === good().length - 1 && !r.bank.some(q => q.qid === "qvis1"), r.error && r.error.message);
  const r2 = await run("nojudge", { raws: [{ questions: [...good(), BAD[0][1]] }] });
  check("without a judge the hard checks still gate publication", !r2.error && r2.bank.length === good().length && !r2.disk.some(q => q.question === BAD[0][1].question));
  const r3 = await run("rejectall", { raws: [{ questions: good() }, { questions: good() }], judge: () => ({ pass: false, problems: ["all wrong"], bad: [] }) });
  check("a judge that rejects the batch still blocks publication", !!r3.error && r3.bank.length === 0 && r3.disk.length === 0);
}

console.log("exported validateQbankBatch keeps its legacy default");
{
  const raw = { questions: good().slice(0, 3) };
  const legacy = S.validateQbankBatch(JSON.parse(JSON.stringify(raw)), 3, new Set(item.skill.misc.map(m => m.id)));
  check("no ctx -> legacy behaviour (visual and qid dropped, same as zh)", legacy.length === 3 && !("visual" in legacy[0]) && !("qid" in legacy[0]));
  const strict = S.validateQbankBatch(JSON.parse(JSON.stringify(raw)), 3, new Set(item.skill.misc.map(m => m.id)), { brief });
  check("explicit ctx -> English hard-check path (legal visual and qid kept)", strict.length === 3 && JSON.stringify(strict[0].visual) === JSON.stringify(GOOD_VIS) && strict[0].qid === "qvis1");
  const legacyJudge = S.judgeQuizPrompt(item, data, raw.questions, "en");
  check("judgeQuizPrompt without a brief is the legacy English prompt (no brief text)", !/Teaching brief/.test(legacyJudge) && /Multiple-choice questions under review \(JSON; answerIndex marks the correct option\):/.test(legacyJudge));
  const bl = S.judgeQuizPrompt(item, data, raw.questions, "en", brief);
  check("judgeQuizPrompt with the brief tells the reviewer what automatic checks cannot judge", /cannot judge meaning/.test(bl) && bl.includes(brief.briefId));
  check("judgeQuizPrompt refuses a brief for a different item", (() => { try { S.judgeQuizPrompt(find("YY.MATH.DATA.LINE.READ").item, find("YY.MATH.DATA.LINE.READ").data, [], "en", brief); return false; } catch (e) { return /does not belong/.test(e.message); } })());
}

srv.cleanup();
process.exit(summary() ? 0 : 1);
