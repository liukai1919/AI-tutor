#!/usr/bin/env node
/*
 * server.js 的 v2 审稿接缝（#44）：真实 qbankMerge 暂存一次、真实 runEngine 路由（假适配器）、真实 qbank.json 持久化、
 * 真实 DATA_ROOT 旁路存储。证明：
 *   - 暂存只做一次：选项 / tags 按 qbankSpread 重排、qid 发一次；暂存不动正式题库（内存 / 磁盘）；
 *   - 报告里的内容哈希 = 发布到 qbank.json 里那道题（去掉 usedAt）的哈希；老题（含 usedAt）一个字节不动；
 *   - qbank.json 写 / 改名失败：磁盘旧内容和内存题库都不变、不留 tmp；报告写失败：根本不发布；
 *   - 重试 / 重启（新进程）从 draft 续跑，复用有效 pass（不再调审稿）后发布；题库中途变了 → 不发布；
 *   - 老路径（qbankSave / ensureQuizBank / v1 审稿）没被改动。
 *
 *   node tools/test_qbank_review_server_seam.mjs
 *
 * 隔离：临时 DATA_ROOT（demo 题库 + 空 config），课程 / 课文 / 契约读仓库里已跟踪的文件；假引擎，不联网。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeChecker, ROOT } from "./lib/isolated_server.mjs";
import { loadIsolatedServer, installStubEngine, quiet } from "./lib/inproc_server.mjs";
const require = createRequire(import.meta.url);
const QB = require("../lib/ai/qbank/index.js");
const { check, summary } = makeChecker();

const srv = loadIsolatedServer("qbank-review-seam");
const S = srv.S;
const judge = installStubEngine(S, "stubjudge");
const gen = installStubEngine(S, "stubgen");
const clone = v => JSON.parse(JSON.stringify(v));
const find = id => { const f = S.findCurriculumItem(id); if (!f) throw new Error("tracked curriculum item missing: " + id); return f; };
const FRAC = "YY.MATH.FRAC.EQUIV.VISUAL";
const { item, data } = find(FRAC);
const key = S.qbankKey(FRAC, "en");
const QFILE = path.join(srv.DATA, "qbank.json");
const diskRaw = () => fs.readFileSync(QFILE, "utf8");
const diskBank = () => (JSON.parse(diskRaw())[key] || { questions: [] }).questions;
const ledger = () => { try { return fs.readFileSync(path.join(srv.DATA, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
const brief = S.qbankBriefFor(item, data);
const MISC = item.skill.misc.map(m => m.id);

/* 假审稿：从提示词末尾读出送审的题（JSON 数组），按 verdict(it) 给结论 */
const itemsOf = sys => JSON.parse(sys.slice(sys.lastIndexOf("\n[") + 1));
const verdict = (it, b, status, fail, problems) => {
  const checks = {};
  for (const id of QB.CHECK_IDS) { const a = QB.allowedResults(id, it, b); checks[id] = { result: (fail || []).includes(id) ? "fail" : a.includes("pass") ? "pass" : a[0], evidence: "synthetic " + id }; }
  const why = (problems || [])[0] || "synthetic";
  const findings = status === "pass" ? [] : status === "revise"
    ? (fail || []).map(k => ({ category: k, field: "", evidence: why, reason: why, suggestedFix: "fix: " + why }))
    : [{ category: "skill_level", field: "", evidence: why, reason: why, suggestedFix: "" }];
  return { id: it.id, status, options: [0, 1, 2, 3].map(i => ({ correct: i === it.answerIndex, reason: "synthetic solve" })), checks, findings };
};
const passAll = b => sys => ({ items: itemsOf(sys).map(it => verdict(it, b, "pass")) });

const T = (level, stem, over) => Object.assign({ level, question: stem, options: ["2/4", "2/3", "1/3", "3/4"], answerIndex: 0,
  explain: "Multiply the top and bottom by the same number.", tags: ["ok", MISC[0], MISC[1] || "other", "other"] }, over || {});
const batch = () => ({ questions: [
  T(1, "Which fraction is equal to 1/2? Think of a bar with 4 equal parts.", { options: ["1/3", "2/4", "2/3", "3/4"], answerIndex: 1, tags: [MISC[0], "ok", "other", "other"] }),
  T(2, "Sam ate 2/8 of a pizza. Which fraction of the same pizza is the same amount?", { options: ["1/4", "1/3", "2/6", "3/8"] }),
  T(3, "Ana ate 1/2 of a small pizza and Ben ate 2/4 of a large one. Did they eat the same amount?", { options: ["No: the wholes differ", "Yes: 2/4 = 1/2", "Yes: both ate 2 parts", "No: 4 is more than 2"],
    visual: { type: "fractionBar", nums: [2, 1, 4, 2], caption: "Two bars of the same length" } })
] });
const OLD = { qid: "qold1", level: 1, question: "Existing reviewed question?", options: ["a", "b", "c", "d"], answerIndex: 0, explain: "kept", usedAt: 77, tags: ["ok", "other", "other", "other"] };
function resetBank() {
  S.qbank[key] = { questions: [clone(OLD)] };
  S.qbankSave();
  judge.reset(); gen.reset();
  fs.rmSync(path.join(srv.DATA, "qbank-review"), { recursive: true, force: true });
}
const faulty = pred => {
  const w = Object.create(fs);
  w.writeFileSync = (p, ...a) => { if (pred("write", String(p))) throw Object.assign(new Error("EIO: injected write failure"), { code: "EIO" }); return fs.writeFileSync(p, ...a); };
  w.renameSync = (a, b) => { if (pred("rename", String(b))) throw Object.assign(new Error("EPERM: injected rename failure"), { code: "EPERM" }); return fs.renameSync(a, b); };
  return w;
};
/* 注入的替身引擎由调用方声明模型身份（真实 CLI 引擎按 config 解析，见下面的 identity 测试） */
const run = (o) => S.qbankReviewV2(item, data, Object.assign({ judgeProvider: "stubjudge", repairProvider: "stubgen", judgeModel: "stub-judge-1", repairModel: "stub-gen-1" }, o));

console.log("staging uses the real qbankMerge once and does not touch the bank");
{
  resetBank();
  const before = diskRaw(), liveBefore = JSON.stringify(S.qbank[key]);
  const base = S.qbankBaseV2(key);
  const accepted = QB.checkEnglishQuestions(batch(), { brief, checkVisual: require("../public/visual-check.js").checkVisual, allowedTags: new Set(MISC), existingQids: base.qids }).accepted;
  const st = S.qbankStageV2(key, accepted, { baseFingerprint: base.fingerprint });
  check("all three staged, none dropped", st.candidates.length === 3 && st.dropped.length === 0, st.dropped);
  check("every candidate got a qid and usedAt 0 once", st.candidates.every(c => /^q[a-z0-9]+$/.test(c.qid) && c.usedAt === 0) && new Set(st.candidates.map(c => c.qid)).size === 3);
  const moved = st.candidates.filter((c, i) => c.answerIndex !== accepted[i].answerIndex);
  check("qbankSpread reordered options and tags together (correct option still tagged ok)",
    moved.length >= 1 && st.candidates.every((c, i) => c.options[c.answerIndex] === accepted[i].options[accepted[i].answerIndex] && c.tags[c.answerIndex] === "ok"), st.candidates.map(c => c.answerIndex));
  check("staging did not mutate the live bank, the disk, or the input objects", diskRaw() === before && JSON.stringify(S.qbank[key]) === liveBefore && accepted.every(q => !("qid" in q)));
  let changed = null;
  try { S.qbankStageV2(key, accepted, { baseFingerprint: "0".repeat(64) }); } catch (e) { changed = e; }
  check("staging against a stale base fingerprint is refused", changed && changed.code === "BANK_CHANGED");
  const dup = S.qbankStageV2(key, [accepted[0], clone(accepted[0])], { baseFingerprint: base.fingerprint });
  check("same-stem duplicate is dropped by the real merge rules", dup.candidates.length === 1 && dup.dropped.length === 1 && dup.dropped[0].index === 1);
  const withQid = S.qbankStageV2(key, [Object.assign(clone(accepted[1]), { qid: "qkeepme" })], { baseFingerprint: base.fingerprint, extra: st.candidates.filter((_, i) => i !== 1) });
  check("restaging keeps an explicit qid (repairs keep identity)", withQid.candidates.length === 1 && withQid.candidates[0].qid === "qkeepme");
}

console.log("end to end: judge via runEngine, exact published object hash, old questions untouched");
let first;
{
  resetBank();
  judge.queue(passAll(brief));
  const { value: res } = await quiet(() => run({ raw: batch(), opts: { timeoutMs: 5000 } }));
  first = res;
  check("run published all three", res.status === "published" && res.published.length === 3, { s: res.status, items: res.items.map(i => i.state + ":" + JSON.stringify(i.attempts).slice(0, 200)) });
  const disk = diskBank(), live = S.qbank[key].questions;
  const byQid = Object.fromEntries(disk.map(q => [q.qid, q]));
  check("each published disk question hashes (without usedAt) to its report contentHash", res.items.every(i => byQid[i.qid] && QB.contentHash(byQid[i.qid]) === i.contentHash));
  check("the old question is byte-identical, usedAt kept", JSON.stringify(disk[0]) === JSON.stringify(OLD) && JSON.stringify(live[0]) === JSON.stringify(OLD));
  check("live bank equals disk bank", JSON.stringify(live) === JSON.stringify(disk) && live.length === 4);
  const L = ledger().filter(l => l.provider === "stubjudge");
  check("the judge went through runEngine (ledgered as judge:quiz), with the v2 schema", L.length === 1 && L[0].task === "judge:quiz" && judge.calls[0].schema === QB.REVIEW_SCHEMA);
  check("the judge prompt carries the brief, full qid/tags/visual and no usedAt", judge.calls[0].sys.includes(brief.briefId) && itemsOf(judge.calls[0].sys).every(i => i.qid && i.tags) && itemsOf(judge.calls[0].sys)[2].visual.type === "fractionBar" && !/usedAt/.test(judge.calls[0].sys));
  const store = S.qbankReviewStore();
  check("records live under the explicit DATA_ROOT sidecar, report says published", store.dir === path.join(srv.DATA, "qbank-review") && store.readReport(res.runId).publication.status === "published"
    && res.items.every(i => store.readRecord(i.reviewKey).status === "pass"));
  check("the sidecar is not inside qbank.json or any kid folder", !/qbank-review|reviewKey|draftId/.test(diskRaw()) && !fs.existsSync(path.join(srv.DATA, "data", "kids", "qbank-review")));
}

console.log("bank write / rename failure: disk and live stay as they were");
for (const op of ["write", "rename"]) {
  resetBank();
  const before = diskRaw(), liveBefore = JSON.stringify(S.qbank[key]);
  judge.queue(passAll(brief));
  /* 只打 DATA_ROOT 根下的 qbank.json（及其 tmp）；旁路存储照常写 */
  const fsOps = faulty((o, p) => o === op && path.resolve(path.dirname(p)) === path.resolve(srv.DATA) && path.basename(p).startsWith("qbank.json"));
  const { value: res } = await quiet(() => run({ raw: batch(), fsOps, opts: { timeoutMs: 5000 } }));
  check(`${op} failure -> publish_failed, nothing published`, res.status === "publish_failed" && !res.published.length && /injected/.test(res.publishError), res.status);
  check(`${op} failure -> qbank.json byte-identical, live bank unchanged, no tmp left`,
    diskRaw() === before && JSON.stringify(S.qbank[key]) === liveBefore && !fs.readdirSync(srv.DATA).some(n => /qbank\.json\..*tmp/.test(n)), fs.readdirSync(srv.DATA));
  const store = S.qbankReviewStore();
  check(`${op} failure -> review passes recorded without claiming publication; drafts not published; report failed`,
    res.items.every(i => { const r = store.readRecord(i.reviewKey); return r.status === "pass" && !("published" in r); }) && store.listDrafts({ bankKey: key }).every(d => !d.published && d.state === "passed")
    && store.readReport(res.runId).publication.status === "failed");
  /* 重试：正常文件系统，从磁盘 draft 续跑，不再调审稿（队列是空的，调了就会报错） */
  const { value: again } = await quiet(() => run({ resume: store.listDrafts({ bankKey: key }), opts: { timeoutMs: 5000 } }));
  check(`${op} retry: exact passes reused (no judge call), same objects published`, judge.calls.length === 1 && again.status === "published" && again.items.every(i => i.cached)
    && again.items.every(i => { const d = diskBank().find(q => q.qid === i.qid); return d && QB.contentHash(d) === i.contentHash && res.items.some(r => r.contentHash === i.contentHash); }), { s: again.status, calls: judge.calls.length });
  check(`${op} retry: old question still untouched; retried new questions start at usedAt 0`, JSON.stringify(diskBank()[0]) === JSON.stringify(OLD) && S.qbank[key].questions.length === 4
    && diskBank().slice(1).every(q => q.usedAt === 0));
  check(`${op}: no sidecar file contains usedAt`, !fs.readdirSync(path.join(srv.DATA, "qbank-review"), { recursive: true }).filter(n => /\.json$/.test(n))
    .some(n => /"usedAt"/.test(fs.readFileSync(path.join(srv.DATA, "qbank-review", n), "utf8"))));
}

console.log("engine identity for v2 records follows what the adapter really runs");
{
  const save = JSON.parse(JSON.stringify({ claude: S.cfg.claude, openai: S.cfg.openai, anthropic: S.cfg.anthropic }));
  const idOf = (prov, extra) => S.qbankReviewDepsV2(item, data, Object.assign({ judgeProvider: prov }, extra)).engine.judge;
  const keyOf = prov => QB.reviewKey(brief, OLD, idOf(prov)).reviewKey;
  S.cfg.claude = Object.assign({}, S.cfg.claude, { model: "cfg-model-a", effort: "high" });
  const ca = idOf("claude"), ka = keyOf("claude");
  S.cfg.claude.model = "cfg-model-b";
  const kb = keyOf("claude");
  S.cfg.claude.effort = "low";
  const kc = keyOf("claude");
  delete S.cfg.claude.model;
  const cd = idOf("claude");
  check("claude CLI: configured model and effort are the identity; changing either changes the reviewKey",
    ca.model === "cfg-model-a" && ca.exact === true && ca.settings.effort === "high" && ka !== kb && kb !== kc, { ca });
  check("claude CLI without a configured model: CLI default is unknown -> model null, exact false (never reused)", cd.model === null && cd.exact === false);
  S.cfg.openai = Object.assign({}, S.cfg.openai, { model: "gpt-x" });
  S.cfg.anthropic = Object.assign({}, S.cfg.anthropic, { model: "" });
  check("openai uses its configured model; anthropic without one uses the adapter's built-in default", idOf("openai").model === "gpt-x" && idOf("openai").exact && idOf("anthropic").model === "claude-opus-5" && idOf("anthropic").exact);
  check("engines that take no model flag (gemini / codex) are unknown; an injected engine can declare its model",
    ["gemini", "codex"].every(p => !S.ADAPTERS[p] || (idOf(p).model === null && idOf(p).exact === false)) && idOf("stubjudge").exact === false && idOf("stubjudge", { judgeModel: "m1" }).exact === true);
  S.cfg.claude.model = "cfg-model-a";
  const da = QB.reviewKey(brief, OLD, idOf("claude", { judgeModel: "declared-constant" })).reviewKey;
  S.cfg.claude.model = "cfg-model-b";
  const db = QB.reviewKey(brief, OLD, idOf("claude", { judgeModel: "declared-constant" })).reviewKey;
  check("a declared model cannot mask a built-in engine's real configuration (claude model change still changes the key)",
    da !== db && idOf("claude", { judgeModel: "declared-constant" }).model === "cfg-model-b");
  Object.assign(S.cfg, save);
  /* 未声明模型的替身引擎：通过的结论落盘，但重试时不复用 */
  resetBank();
  judge.queue(passAll(brief), passAll(brief));
  const bad = faulty((o, p) => o === "rename" && path.resolve(path.dirname(p)) === path.resolve(srv.DATA) && path.basename(p).startsWith("qbank.json"));
  await quiet(() => S.qbankReviewV2(item, data, { judgeProvider: "stubjudge", fsOps: bad, raw: batch(), opts: { timeoutMs: 5000 } }));
  const { value: again } = await quiet(() => S.qbankReviewV2(item, data, { judgeProvider: "stubjudge", resume: S.qbankReviewStore().listDrafts({ bankKey: key }), opts: { timeoutMs: 5000 } }));
  check("undeclared injected judge (unknown model): retry reviews again instead of reusing", judge.calls.length === 2 && again.status === "published" && again.items.every(i => !i.cached), { calls: judge.calls.length, s: again.status });
}

console.log("report write failure blocks publication entirely");
{
  resetBank();
  const before = diskRaw();
  judge.queue(passAll(brief));
  const fsOps = faulty((o, p) => o === "rename" && /[\\/]qbank-review[\\/]reports[\\/]/.test(p));
  const { value: res } = await quiet(() => run({ raw: batch(), fsOps, opts: { timeoutMs: 5000 } }));
  check("report rename failure -> storage_failed, qbank.json unchanged, live unchanged", res.status === "storage_failed" && diskRaw() === before && S.qbank[key].questions.length === 1, res.status);
}

console.log("bank changed during review: never merged twice, nothing published");
{
  resetBank();
  judge.queue(sys => { S.qbank[key].questions.push({ qid: "qrace", level: 2, question: "Added meanwhile?", options: ["a", "b", "c", "d"], answerIndex: 1, explain: "x", usedAt: 0 }); return passAll(brief)(sys); });
  const { value: res } = await quiet(() => run({ raw: batch(), opts: { timeoutMs: 5000 } }));
  check("publish refused (bank changed since staging); live bank only has the concurrent edit", res.status === "publish_failed" && /changed/.test(res.publishError)
    && S.qbank[key].questions.length === 2 && S.qbank[key].questions[1].qid === "qrace", { s: res.status, e: res.publishError });
  S.qbankSave();
  judge.queue(passAll(brief));
  const { value: again } = await quiet(() => run({ resume: S.qbankReviewStore().listDrafts({ bankKey: key }), opts: { timeoutMs: 5000 } }));
  const oldHash = Object.fromEntries(res.items.map(i => [i.qid, i.contentHash]));
  check("resume against the changed bank restages with the same qids; published objects hash to the report", again.status === "published"
    && again.items.every(i => oldHash[i.qid] !== undefined && diskBank().some(q => q.qid === i.qid && QB.contentHash(q) === i.contentHash)) && diskBank().length === 5, { s: again.status, st: again.items.map(i => i.state) });
  check("…a restaged object whose content changed was reviewed again; an unchanged one reused its exact pass",
    again.items.every(i => i.cached === (i.contentHash === oldHash[i.qid])) && (judge.calls.length === 2) === again.items.some(i => !i.cached), again.items.map(i => [i.cached, i.contentHash === oldHash[i.qid]]));
  judge.reset();
}

console.log("revise -> repair via runEngine keeps identity; needs-human stays a draft");
{
  resetBank();
  const b = batch();
  const fixedL2 = clone(b.questions[1]); fixedL2.explain = "2/8 = 1/4: divide the top and the bottom by 2.";
  judge.queue(
    sys => ({ items: itemsOf(sys).map((it, i) => i === 1 ? verdict(it, brief, "revise", ["explain_consistent"], ["Explain the division."]) : i === 2 ? verdict(it, brief, "needs-human", [], ["Teacher should decide."]) : verdict(it, brief, "pass")) }),
    passAll(brief));
  gen.queue(fixedL2);
  const { value: res } = await quiet(() => run({ raw: b, opts: { timeoutMs: 5000 } }));
  const st = Object.fromEntries(res.items.map(i => [i.level, i]));
  check("L1 passed, L2 repaired once and passed, L3 needs-human", st[1].state === "passed" && st[2].state === "passed" && st[2].repairs === 1 && st[3].state === "needs_human", res.items.map(i => i.state));
  check("repair went through runEngine on the generation engine", ledger().some(l => l.provider === "stubgen" && l.task === "quiz:repair") && gen.calls.length === 1 && /Keep "level": 2/.test(gen.calls[0].sys));
  const repaired = diskBank().find(q => q.qid === st[2].qid);
  check("repaired question kept its qid and level and is published with the fixed explanation", repaired && repaired.level === 2 && /divide the top/.test(repaired.explain) && QB.contentHash(repaired) === st[2].contentHash);
  check("needs-human is not in the bank; its draft is on disk with the exact content", !diskBank().some(q => q.qid === st[3].qid)
    && S.qbankReviewStore().readDraft(st[3].draftId).state === "needs_human" && QB.contentHash(S.qbankReviewStore().readDraft(st[3].draftId).question) === st[3].contentHash);
}

console.log("audit of an existing question: reviewed against the current brief, repaired in place, usedAt kept");
{
  resetBank();
  const fixedOld = { level: 1, question: "Which fraction is equal to 1/2?", options: ["2/4", "1/3", "2/3", "3/4"], answerIndex: 0, explain: "Double the top and the bottom: 1/2 = 2/4.", tags: ["ok", "other", "other", "other"] };
  /* 复审进行中孩子又做了这道题（usedAt 77 → 555）：替换时要用此刻的 usedAt，不是暂存时拷下来的 77 */
  judge.queue(sys => ({ items: itemsOf(sys).map(it => verdict(it, brief, "revise", ["skill_level", "explain_consistent"], ["Letters a-d do not test equivalent fractions."])) }),
    sys => { S.qbank[key].questions[0].usedAt = 555; return passAll(brief)(sys); });
  gen.queue(fixedOld);
  const { value: res } = await quiet(() => run({ audit: ["qold1"], opts: { timeoutMs: 5000 } }));
  const d0 = diskBank()[0];
  check("existing qold1 had no v2 record: it was reviewed, repaired once, re-reviewed and replaced in place",
    judge.calls.length === 2 && res.status === "published" && res.items[0].publication === "replaced" && res.items[0].repairs === 1 && diskBank().length === 1, { s: res.status, it: res.items[0] });
  check("…same qid, same level, the CURRENT usedAt (555, set during review) kept on disk and live; the published object hashes to the report",
    d0.qid === "qold1" && d0.level === 1 && d0.usedAt === 555 && d0.question === fixedOld.question && QB.contentHash(d0) === res.items[0].contentHash
    && JSON.stringify(S.qbank[key].questions[0]) === JSON.stringify(d0), d0);
  judge.reset();
  const { value: again } = await quiet(() => run({ audit: ["qold1"], opts: { timeoutMs: 5000 } }));
  check("auditing the repaired question again reuses its exact pass and writes nothing", again.status === "unchanged" && again.items[0].cached && judge.calls.length === 0);
}

console.log("interleaving: another bank's write and a child's usedAt during review are not lost");
{
  resetBank();
  const OTHER = "YY.TEST.OTHER|en";
  const otherQ = { qid: "qother1", level: 1, question: "Other bank question?", options: ["a", "b", "c", "d"], answerIndex: 0, explain: "x", usedAt: 0 };
  judge.queue(sys => {
    /* 审稿进行中：别的题库先完成一次 v2 发布；孩子做了一道本题库的老题 */
    S.qbankPublishV2(OTHER, [otherQ], { baseFingerprint: S.qbankBaseV2(OTHER).fingerprint });
    S.qbank[key].questions[0].usedAt = 999;
    return passAll(brief)(sys);
  });
  const { value: res } = await quiet(() => run({ raw: batch(), opts: { timeoutMs: 5000 } }));
  const disk = JSON.parse(diskRaw());
  check("our publish succeeded (usedAt is not part of the bank fingerprint)", res.status === "published" && res.published.length === 3, res.status);
  check("the other bank's completed write is still on disk (no stale whole-file snapshot)", disk[OTHER] && disk[OTHER].questions.some(q => q.qid === "qother1"));
  check("the child's usedAt update made during review is on disk and live", disk[key].questions[0].usedAt === 999 && S.qbank[key].questions[0].usedAt === 999);
  delete S.qbank[OTHER];
}

console.log("missing lesson (book item): lesson alignment cannot pass");
{
  const bk = find("AOPS.PA.C01.S01");
  const bkey = S.qbankKey("AOPS.PA.C01.S01", "en");
  const bb = S.qbankBriefFor(bk.item, bk.data);
  S.qbank[bkey] = { questions: [] };
  judge.reset();
  judge.queue(sys => ({ items: itemsOf(sys).map(it => { const v = verdict(it, bb, "pass"); v.checks.lesson_alignment = { result: "pass", evidence: "matches" }; return v; }) }));
  const q = { level: 1, question: "What is 3 + 4?", options: ["7", "6", "8", "12"], answerIndex: 0, explain: "Count on 4 from 3." };
  const { value: res } = await quiet(() => S.qbankReviewV2(bk.item, bk.data, { judgeProvider: "stubjudge", raw: { questions: [q] }, opts: { timeoutMs: 5000 } }));
  check("reviewer claiming the missing lesson matches -> error, nothing published; report lesson not_verified",
    res.items[0].state === "error" && !res.published.length && S.qbank[bkey].questions.length === 0 && res.report.lesson.status === "missing" && res.report.lesson.alignment === "not_verified", res.items[0]);
}

console.log("restart: a fresh server process sees the published bank and the sidecar records");
{
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(path.join(ROOT, "tools", "x.mjs"))});
    console.log = () => {}; console.warn = () => {};
    const S = require("../server.js");
    const QB = require("../lib/ai/qbank/index.js");
    const key = ${JSON.stringify(key)};
    const qs = (S.qbank[key] || { questions: [] }).questions;
    const st = S.qbankReviewStore();
    process.stdout.write(JSON.stringify({ root: S.DATA_ROOT, n: qs.length, hashes: qs.map(q => QB.contentHash(q)), drafts: st.listDrafts({ bankKey: key }).map(d => d.state) }));`;
  const env = Object.assign({}, process.env, { YY_DATA_DIR: srv.DATA, NODE_OPTIONS: "" });
  delete env.YY_DEMO;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, env, encoding: "utf8", timeout: 60000, windowsHide: true });
  let out = null; try { out = JSON.parse(r.stdout); } catch (_) {}
  const live = S.qbank[key].questions;
  const mine = S.qbankReviewStore().listDrafts({ bankKey: key }).map(d => d.state);
  check("new process: same DATA_ROOT, same bank content hashes as this process, the same drafts readable",
    out && path.resolve(out.root) === path.resolve(srv.DATA) && out.n === live.length && JSON.stringify(out.hashes) === JSON.stringify(live.map(q => QB.contentHash(q)))
    && mine.length > 0 && JSON.stringify(out.drafts) === JSON.stringify(mine), { out, mine, err: (r.stderr || "").slice(0, 300) });
}

console.log("legacy paths untouched");
{
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("legacy qbankSave still swallows errors exactly as before (v2 does not reuse it)", /function qbankSave\(\) \{\r?\n  try \{\r?\n    const tmp = QBANK_FILE \+ "\.tmp";/.test(src) && /catch \(e\) \{ console\.log\("\[quiz\] could not save qbank\.json: " \+ e\.message\); \}/.test(src));
  check("v2 seams are exported; v1 judge helpers still exported", ["qbankStageV2", "qbankPublishV2", "qbankReviewStore", "qbankReviewDepsV2", "qbankReviewV2", "qbankBaseV2"].every(n => typeof S[n] === "function") && typeof S.validateJudge === "function" && typeof S.judgeQuizPrompt === "function");
  let threw = false; try { S.qbankReviewDepsV2(item, data, { judgeProvider: "no-such-engine" }); } catch (_) { threw = true; }
  check("an unknown judge engine is refused before any call", threw);
}

srv.cleanup();
process.exitCode = summary() ? 0 : 1;
