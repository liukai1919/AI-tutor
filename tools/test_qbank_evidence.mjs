#!/usr/bin/env node
/*
 * 「已存审稿记录能不能当当前版本的证据」（#45，lib/ai/qbank/evidence.js）+ store.listRecords + v2 导出资格（exportV2Bank）。
 * 协调器复用 pass、pregen / audit 续跑、v2 导出用的是同一份检查；这里逐条拆：dry、种类、组成部分（内容 / brief / 规则 / rubric / 引擎）、
 * key 自洽、存的题目、pass 复验；最新结论（任何审稿引擎）；读不动的记录如实报出；导出字段白名单。
 *
 *   node tools/test_qbank_evidence.mjs
 *
 * 隔离：进程内 server（临时 DATA_ROOT，demo 题库），不调模型。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
import { loadIsolatedServer } from "./lib/inproc_server.mjs";
import { exportV2Bank, parseCli, resolveSelection, strictEngine, unsafeOutput } from "./lib/qbank_v2_cli.mjs";
const require = createRequire(import.meta.url);
const QB = require("../lib/ai/qbank/index.js");
const { check, summary } = makeChecker();

const srv = loadIsolatedServer("qbank-evidence");
const S = srv.S;
const clone = v => JSON.parse(JSON.stringify(v));
const B = "BC.MATH.G4.NUM.01", KB = B + "|en";
const f = S.findCurriculumItem(B);
const brief = S.qbankBriefFor(f.item, f.data);
const Q = clone(S.qbank[KB].questions[0]);
const J1 = { provider: "stubjudge", model: "j1", exact: true }, J2 = { provider: "stubjudge2", model: "j2", exact: true };

/* 合法记录：和协调器写的同一形状（结论由允许值拼出，pass 能被 storedPassIsValid 复验） */
function record(q, o) {
  o = o || {};
  const k = QB.reviewKey(o.brief || brief, q, o.engine || J1);
  const item = QB.reviewInput([{ draftId: "dr-x", question: q }])[0];
  const checks = {};
  for (const id of QB.CHECK_IDS) { const a = QB.allowedResults(id, item, o.brief || brief); checks[id] = { result: a.includes("pass") ? "pass" : a[0], evidence: "e " + id }; }
  const status = o.status || "pass";
  const findings = status === "pass" ? [] : [{ category: "skill_level", field: "", evidence: "x", reason: "y", suggestedFix: status === "revise" ? "z" : "" }];
  if (status === "revise") checks.skill_level = { result: "fail", evidence: "e" };
  return { kind: "yy-qbank-review-record", v: 1, reviewKey: k.reviewKey, parts: k.parts, dry: o.dry === undefined ? false : o.dry, runId: "run-x", at: o.at || "2026-09-27T00:00:00.000Z",
    draftId: "dr-x", qid: q.qid, question: QB.questionContent(q), status, options: [0, 1, 2, 3].map(i => ({ correct: i === q.answerIndex, reason: "r" })), checks, findings, humanReview: "none" };
}

console.log("matchRecord: only a self-consistent, non-dry record for this exact version counts");
{
  const why = (rec, q, e) => QB.matchRecord(rec, brief, q || Q, e === undefined ? J1 : e).reason || "";
  const good = record(Q);
  check("a valid pass for this content / brief / engine is evidence", QB.matchRecord(good, brief, Q, J1).ok && QB.matchRecord(good, brief, Q, J1).status === "pass");
  check("engine null = accept the record's own judge (export)", QB.matchRecord(record(Q, { engine: J2 }), brief, Q, null).ok);
  check("…but a named judge must match", !QB.matchRecord(record(Q, { engine: J2 }), brief, Q, J1).ok);
  check("dry records are never evidence", /dry/.test(why(record(Q, { dry: true }))));
  check("no record / wrong kind / unknown status → not evidence", !QB.matchRecord(null, brief, Q, J1).ok && !QB.matchRecord(Object.assign(clone(good), { kind: "x" }), brief, Q, J1).ok
    && !QB.matchRecord(Object.assign(clone(good), { status: "maybe" }), brief, Q, J1).ok);
  const edited = Object.assign(clone(Q), { explain: Q.explain + " edited" });
  check("content changed → the old record is for another version", /another version/.test(why(record(Q), edited)));
  check("usedAt is family state: a different usedAt is still the same version", QB.matchRecord(record(Q), brief, Object.assign(clone(Q), { usedAt: 999 }), J1).ok);
  const otherRules = QB.buildTeachingBrief({ item: Object.assign({}, f.item, { skill: undefined }), context: { kind: "standard", grade: 4, topic: { id: f.item.strand, en: "x" } },
    rules: Object.assign(clone(QB.DEFAULT_RULES), { version: "qbank-en-rules/old" }), lesson: null, visualContract: null });
  check("a record made under another brief (other rules / lesson) is not evidence for the current one", /another version/.test(why(record(Q, { brief: otherRules }))));
  const oldRubric = clone(good); oldRubric.parts.rubric = { version: "qbank-review-v2/1", hash: "0".repeat(64) }; oldRubric.reviewKey = QB.reviewKeyOf(oldRubric.parts);
  check("a record from an older rubric (self-consistent key) is not evidence", /another version/.test(why(oldRubric)));
  const badKey = clone(good); badKey.reviewKey = "rk1-" + "0".repeat(64);
  check("a reviewKey that does not follow from its parts is refused", /another version/.test(why(badKey)));
  const badQ = clone(good); badQ.question.explain = "someone else's question";
  check("a stored question that does not match the key is refused", /does not match the key/.test(why(badQ)));
  const tampered = clone(good); tampered.checks.answer_unique.result = "fail";
  check("a hand-edited pass that no longer re-validates is refused", /re-validate/.test(why(tampered)));
  const withFinding = clone(good); withFinding.findings = [{ category: "distractors", field: "", evidence: "x", reason: "y", suggestedFix: "z" }];
  check("a pass that reports a problem is refused", /re-validate/.test(why(withFinding)));
  const brokenNH = Object.assign(clone(good), { status: "needs-human", at: "2026-09-28T00:00:00.000Z" });   // needs-human 没有任何发现 = 协议不合格
  check("a malformed needs-human (no finding) is not a valid verdict and cannot veto a pass", /does not re-validate/.test(why(brokenNH)) && QB.latestVerdict([good, brokenNH], brief, Q).status === "pass"
    && QB.currentEvidence({ brief, question: Q, judge: J1, records: [good, brokenNH] }).state === "certified");
  const brokenRev = Object.assign(clone(good), { status: "revise", options: undefined });
  check("a revise record without per-option solving is refused too", /does not re-validate/.test(why(brokenRev)));
  const nh = record(Q, { status: "needs-human" });
  check("a needs-human record for this version is a (non-pass) verdict", QB.matchRecord(nh, brief, Q, J1).ok && QB.matchRecord(nh, brief, Q, J1).status === "needs-human");
}

console.log("latestVerdict: the most recent valid verdict for this exact version, from any judge");
{
  const p1 = record(Q, { at: "2026-09-27T01:00:00.000Z" });
  const h2 = record(Q, { engine: J2, status: "needs-human", at: "2026-09-27T02:00:00.000Z" });
  const p3 = record(Q, { engine: J2, at: "2026-09-27T03:00:00.000Z" });
  check("later needs-human beats an older pass", QB.latestVerdict([p1, h2], brief, Q).status === "needs-human");
  check("a later pass (after a fix / re-review) beats an older needs-human", QB.latestVerdict([p1, h2, p3].reverse(), brief, Q).status === "pass");
  const tie = record(Q, { engine: J2, status: "revise", at: p1.at });
  check("same timestamp: the non-pass wins", QB.latestVerdict([p1, tie], brief, Q).status === "revise" && QB.latestVerdict([tie, p1], brief, Q).status === "revise");
  const dryLater = record(Q, { engine: J2, status: "needs-human", dry: true, at: "2026-09-28T00:00:00.000Z" });
  check("dry records and records for other content are ignored", QB.latestVerdict([p1, dryLater, record(S.qbank[KB].questions[1], { status: "needs-human", at: "2026-09-29T00:00:00.000Z" })], brief, Q).status === "pass");
  check("nothing valid → null (no evidence)", QB.latestVerdict([dryLater], brief, Q).status === null);
}

console.log("store.listRecords reports unreadable files instead of skipping them silently");
{
  const store = S.qbankReviewStore();
  check("no records folder → empty, no errors", JSON.stringify(store.listRecords({ dry: false })) === JSON.stringify({ records: [], errors: [] }));
  const r = record(Q);
  store.writeRecord(r, { dry: false });
  store.writeRecord(record(Q, { dry: true }), { dry: true });
  fs.writeFileSync(path.join(store.dir, "records", "rk1-broken.json"), "{ nope");
  fs.writeFileSync(path.join(store.dir, "records", "rk1-renamed.json"), JSON.stringify(r));
  const L = store.listRecords({ dry: false });
  check("valid record listed; broken JSON and a file whose name is not its reviewKey are reported", L.records.length === 1 && L.records[0].reviewKey === r.reviewKey
    && L.errors.map(e => e.file).sort().join(",") === "rk1-broken.json,rk1-renamed.json", L.errors);
  check("dry records are listed separately", store.listRecords({ dry: true }).records.length === 1 && store.listRecords({ dry: true }).errors.length === 0);
  fs.rmSync(store.dir, { recursive: true, force: true });
}

console.log("exportV2Bank: eligibility per question, review whitelist only");
{
  const sel = resolveSelection(S, [B]).selected[0];
  const qs = S.qbank[KB].questions;
  const recs = [record(qs[0]), record(qs[1], { status: "needs-human" }), record(qs[2], { at: "2026-09-27T01:00:00.000Z" }), record(qs[2], { engine: J2, status: "revise", at: "2026-09-27T05:00:00.000Z" })];
  for (let i = 3; i < 12; i++) recs.push(record(qs[i]));
  qs[4].usedAt = 55;
  qs[5].reviewNote = "internal";   // 白名单外的字段：内容哈希算进去了，记录里的题（白名单）对不上 → 没有证据，也就绝不会被导出
  const r = exportV2Bank(S, QB, sel, recs, J1);
  check("pass → exported; needs-human / later revise (other judge) → excluded; extra-field question → no evidence", r.questions.length === 9 && r.excluded["needs-human"] === 1 && r.excluded.revise === 1 && r.excluded.noEvidence === 1, r.excluded);
  check("exported objects carry only review-whitelist fields: no usedAt, no extra fields", r.questions.every(q => Object.keys(q).every(k => QB.REVIEW_FIELDS.includes(k))) && !r.questions.some(q => q.qid === qs[5].qid));
  check("judge and brief reported for the manifest, playable per level", r.playable && r.judge.provider === "stubjudge" && r.judge.exact && r.briefId === brief.briefId);
  const viaJ2 = exportV2Bank(S, QB, sel, recs, J2);
  check("a judge with no records for these versions certifies nothing", viaJ2.questions.length === 0 && viaJ2.excluded.revise === 1 && viaJ2.excluded.noEvidence === 11);
  const none = exportV2Bank(S, QB, sel, [], J1);
  check("no evidence at all → nothing exported and not playable (withheld)", none.questions.length === 0 && !none.playable && none.excluded.noEvidence === 12);
  const unk = exportV2Bank(S, QB, sel, recs, { provider: "claude", model: null, exact: false });
  check("an unknown judge model certifies nothing", unk.questions.length === 0 && unk.excluded.unknownJudge === 12);
  delete qs[5].reviewNote; delete qs[4].usedAt;
}

console.log("argument helpers (pure) and selection");
{
  check("legacy argv untouched: no --review → review null, no errors", (() => { const p = parseCli(["--grades", "5", "--only", "quiz", "--judge"], "pregen"); return p.review === null && !p.errors.length && p.v2 === null; })());
  check("--review v1 is the legacy path", parseCli(["--review", "v1", "--grades", "5"], "pregen").review === "v1");
  const p = parseCli(["--review", "v2", "--skill", "A.B,C.D", "--judge", "--review-timeout", "30"], "audit");
  check("v2 parse: ids, bare --judge (route), timeout seconds → ms", !p.errors.length && p.v2.skills.join("|") === "A.B|C.D" && p.v2.judge === null && p.v2.timeoutMs === 30000);
  const eq = parseCli(["--review=v2", "--skill=A"], "pregen");
  check("equals syntax for the new options is refused (not silently a legacy run)", eq.review === null && eq.errors.length === 2);
  check("duplicate --review is refused whatever the first value", parseCli(["--review", "v1", "--review", "v2"], "audit").errors.some(e => /--review 只能给一次/.test(e)));
  check("an empty --skill value is refused", parseCli(["--review", "v2", "--skill", ""], "pregen").errors.some(e => /--skill 需要一个值/.test(e)));
  check("repeated flags refused", parseCli(["--review", "v2", "--skill", "A", "--skill", "B"], "pregen").errors.some(e => /只能给一次/.test(e)));
  const home = resolveSelection(S, ["YY.MATH.FRAC.EQUIV.VISUAL"]);
  check("a skill resolves to its own grade view, not a review copy", home.selected.length === 1 && home.selected[0].data.skillsId === "skills-g5" && !home.selected[0].item.skill.reviewFrom);
  const reviewCopies = [...S.curriculum.values()].flatMap(d => (d.items || []).filter(it => it.skill && it.skill.reviewFrom).map(it => ({ it, d })));
  if (reviewCopies.length) {
    const rc = reviewCopies[0];
    const sel = resolveSelection(S, [rc.it.id]);
    check("an id that also appears as a review copy elsewhere still resolves to its home view", sel.selected.length === 1 && !sel.selected[0].item.skill.reviewFrom && sel.selected[0].data !== rc.d);
  }
  S.detected.stubA = { available: true };
  check("strictEngine: explicit and available → that engine", strictEngine(S, "stubA", "judge:quiz", "--judge").id === "stubA");
  check("strictEngine: nothing requested and no automatic engine → error", !!strictEngine(S, null, "judge:quiz", "--judge").error);
  S.detected.ollama = { available: true };   // 从这里起自动顺序里有一个可用引擎：显式要求落空时也不许落到它
  check("strictEngine: explicit but unavailable → error, even though another engine is available", !!strictEngine(S, "claude", "judge:quiz", "--judge").error && !strictEngine(S, "claude", "judge:quiz", "--judge").id);
  S.cfg.providerByTask = { "judge:quiz": "ghost" };
  check("strictEngine: configured route unavailable → error (no auto fall-through)", /providerByTask/.test(strictEngine(S, null, "judge:quiz", "--judge").error || "") && !strictEngine(S, null, "judge:quiz", "--judge").id);
  S.cfg.providerByTask = {};
  const prevProvider = S.cfg.provider;
  S.cfg.provider = "gemini";
  check("strictEngine: config.provider unavailable → error too", /config\.provider/.test(strictEngine(S, null, "judge:quiz", "--judge").error || ""));
  S.cfg.provider = prevProvider;
  check("strictEngine: nothing requested → automatic pick in the legacy order", strictEngine(S, null, "judge:quiz", "--judge").id === "ollama" && strictEngine(S, null, "judge:quiz", "--judge").via === "自动挑选");
  delete S.detected.ollama; delete S.detected.stubA;
}

console.log("the coordinator never reuses a non-pass record as if it were a pass");
{
  const { installStubEngine, quiet } = await import("./lib/inproc_server.mjs");
  const judge = installStubEngine(S, "stubjudge");
  S.detected.stubjudge = { available: true, model: "j1" };
  const sel = resolveSelection(S, [B]).selected[0];
  const q = clone(S.qbank[KB].questions[7]);
  const store = S.qbankReviewStore();
  store.writeRecord(record(q, { status: "needs-human" }), { dry: false });
  const itemsOf = sys => JSON.parse(sys.slice(sys.lastIndexOf("\n[") + 1));
  judge.queue(sys => ({ items: itemsOf(sys).map(it => ({ id: it.id, status: "needs-human", options: [0, 1, 2, 3].map(i => ({ correct: i === it.answerIndex, reason: "r" })),
    checks: Object.fromEntries(QB.CHECK_IDS.map(c => [c, { result: QB.allowedResults(c, it, brief).includes("pass") ? "pass" : QB.allowedResults(c, it, brief)[0], evidence: "e" }])),
    findings: [{ category: "skill_level", field: "", evidence: "x", reason: "still unsure", suggestedFix: "" }] })) }));
  const { value: res } = await quiet(() => S.qbankReviewV2(sel.item, sel.data, { audit: [q.qid], judgeProvider: "stubjudge", judgeModel: "j1", opts: { timeoutMs: 5000 } }));
  const it = res.items[0];
  check("an exact current needs-human record is not reused: the judge is asked again and nothing is certified", judge.calls.length === 1 && it && !it.cached && it.state === "needs_human" && res.unchanged.length === 0, { calls: judge.calls.length, it });
  fs.rmSync(store.dir, { recursive: true, force: true });
}

console.log("unknown judge model: never evidence (pass or not), except what this very run just reviewed");
{
  const U = { provider: "claude", model: null, exact: false };
  const pu = record(Q, { engine: U }), hu = record(Q, { engine: U, status: "needs-human", at: "2026-09-30T00:00:00.000Z" });
  const m = QB.matchRecord(pu, brief, Q, U);
  check("a valid pass from an unknown model is not evidence (flagged unknownModel)", !m.ok && m.unknownModel && m.status === "pass");
  check("…nor its needs-human", !QB.matchRecord(hu, brief, Q, U).ok && QB.matchRecord(hu, brief, Q, U).unknownModel);
  check("currentEvidence with an unknown judge: earlier records → unverified (review again)", QB.currentEvidence({ brief, question: Q, judge: U, records: [pu] }).state === "unverified"
    && QB.currentEvidence({ brief, question: Q, judge: U, records: [hu] }).state === "unverified");
  check("…but what this run just reviewed counts for this run only", QB.currentEvidence({ brief, question: Q, judge: U, records: [pu], reviewedThisRun: new Set([pu.reviewKey]) }).state === "certified"
    && QB.currentEvidence({ brief, question: Q, judge: U, records: [hu], reviewedThisRun: new Set([hu.reviewKey]) }).state === "held");
  const p1 = record(Q);
  check("an unknown model's later needs-human does not count as a verdict against an exact pass", QB.latestVerdict([p1, hu], brief, Q).status === "pass"
    && QB.currentEvidence({ brief, question: Q, judge: J1, records: [p1, hu] }).state === "certified");
  const h2 = record(Q, { engine: J2, status: "needs-human", at: "2026-09-30T00:00:00.000Z" });
  check("an exact judge's later needs-human holds an exact pass (held, not certified)", QB.currentEvidence({ brief, question: Q, judge: J1, records: [p1, h2] }).state === "held");
  const old = record(Q, { engine: J2, status: "needs-human", at: "2026-09-26T00:00:00.000Z" });
  const newer = record(Q, { at: "2026-09-27T00:00:00.000Z" });
  check("an OLDER needs-human does not veto a newer pass from the current judge (the pass superseded it)", QB.currentEvidence({ brief, question: Q, judge: J1, records: [old, newer] }).state === "certified");
  const puNew = record(Q, { engine: U, at: "2026-09-27T01:00:00.000Z" });
  check("…also when the newer pass is this run's unknown-model review", QB.currentEvidence({ brief, question: Q, judge: U, records: [old, puNew], reviewedThisRun: new Set([puNew.reviewKey]) }).state === "certified");
  check("a needs-human at the very same time as the pass vetoes it (ties are not passes)", QB.currentEvidence({ brief, question: Q, judge: J1, records: [newer, record(Q, { engine: J2, status: "needs-human", at: newer.at })] }).state === "held");
  check("current judge's own needs-human → held; no record → unverified", QB.currentEvidence({ brief, question: Q, judge: J1, records: [record(Q, { status: "needs-human" })] }).state === "held"
    && QB.currentEvidence({ brief, question: Q, judge: J1, records: [] }).state === "unverified");
}

console.log("unsafeOutput: export never deletes a source / data root, a parent of one, or content / user data (fake temp roots only)");
{
  const os = await import("node:os");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "yy-unsafe-out-"));
  const R0 = path.join(base, "repo"), D0 = path.join(base, "userdata");
  for (const p of [path.join(R0, "data", "lessons"), path.join(R0, "build"), path.join(D0, "data")]) fs.mkdirSync(p, { recursive: true });
  const fake = { ROOT: R0, DATA_ROOT: D0, LESSON_PACK_DIR: path.join(R0, "data", "lessons"), UNIT_PACK_DIR: path.join(R0, "data", "unit-tests"), VOICE_PACK_DIR: path.join(R0, "data", "voice"), TTS_CACHE: path.join(D0, "tts-cache") };
  const bad = [R0, D0, base, path.dirname(base), path.join(R0, "data"), path.join(R0, "data", "lessons", "en"), path.join(D0, "data", "kids"), path.join(D0, "qbank-review"), path.join(D0, "tts-cache"), R0 + path.sep, R0.toUpperCase()];
  check("roots, their parents, data/, lesson packs, user data, sidecar and cache are all refused", bad.every(p => unsafeOutput(p, fake)), bad.filter(p => !unsafeOutput(p, fake)));
  check("the default build/apple-export and an unrelated temp folder are allowed", !unsafeOutput(path.join(R0, "build", "apple-export"), fake) && !unsafeOutput(path.join(base, "elsewhere", "out"), fake));
  const same = { ROOT: R0, DATA_ROOT: R0, LESSON_PACK_DIR: fake.LESSON_PACK_DIR, TTS_CACHE: path.join(R0, "tts-cache") };
  check("source mode (DATA_ROOT = ROOT): build/ output still allowed, data/ still refused", !unsafeOutput(path.join(R0, "build", "x"), same) && !!unsafeOutput(path.join(R0, "data", "kids"), same));
  fs.rmSync(base, { recursive: true, force: true });
}

srv.cleanup();
process.exitCode = summary() ? 0 : 1;
