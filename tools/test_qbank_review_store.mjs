#!/usr/bin/env node
/*
 * v2 审稿旁路存储（lib/ai/qbank/store.js，#44）：显式 DATA_ROOT 下的 qbank-review/，原子写（tmp + rename），
 * 注入真实的文件系统写 / 改名故障：失败必须抛出、旧文件不动、不留 tmp；dry 与正式分开；重启（新实例）能读回；
 * 和协调器连起来：报告写失败不发布；发布失败后「重启」从 draft 续跑，复用有效 pass 再发布。
 *
 *   node tools/test_qbank_review_store.mjs
 *
 * 只用系统临时目录；不读写任何真实数据、不调模型。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { makeChecker, ROOT } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const QB = require("../lib/ai/qbank/index.js");
const { checkVisual } = require("../public/visual-check.js");
const { check, summary } = makeChecker();

const tmpRoots = [];
const mkRoot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "yy-qbrev-")); tmpRoots.push(d); return d; };
/* 真实 fs 的包装：按谓词让 writeFileSync / renameSync 抛错（EIO / EPERM），其余原样调用 */
function faultyFs(pred) {
  const w = Object.create(fs);
  w.writeFileSync = (p, ...a) => { if (pred("write", String(p))) throw Object.assign(new Error("EIO: injected write failure " + path.basename(String(p))), { code: "EIO" }); return fs.writeFileSync(p, ...a); };
  w.renameSync = (a, b) => { if (pred("rename", String(b))) throw Object.assign(new Error("EPERM: injected rename failure " + path.basename(String(b))), { code: "EPERM" }); return fs.renameSync(a, b); };
  return w;
}
const listAll = dir => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(dir, p).replace(/\\/g, "/")); } }; if (fs.existsSync(dir)) walk(dir); return out.sort(); };

console.log("layout, round trip, dry separation, restart");
{
  const root = mkRoot();
  const s = QB.createReviewStore({ root, fs });
  check("sidecar lives at <DATA_ROOT>/qbank-review", s.dir === path.join(root, "qbank-review"));
  s.writeRecord({ reviewKey: "rk1-aa", status: "pass", dry: false });
  s.writeDraft({ draftId: "dr-1", bankKey: "A|en", state: "needs_human" });
  s.writeDraft({ draftId: "dr-2", bankKey: "B|en", state: "passed" });
  s.writeReport({ runId: "run-1", dry: false });
  s.writeRecord({ reviewKey: "rk1-bb", status: "pass", dry: true }, { dry: true });
  s.writeReport({ runId: "run-2", dry: true }, { dry: true });
  check("files land in records/ drafts/ reports/ and dry/…",
    JSON.stringify(listAll(s.dir)) === JSON.stringify(["drafts/dr-1.json", "drafts/dr-2.json", "dry/records/rk1-bb.json", "dry/reports/run-2.json", "records/rk1-aa.json", "reports/run-1.json"]), listAll(s.dir));
  const s2 = QB.createReviewStore({ root, fs });
  check("a fresh store instance (restart) reads everything back", s2.readRecord("rk1-aa").status === "pass" && s2.readDraft("dr-1").state === "needs_human" && s2.readReport("run-1").runId === "run-1");
  check("dry and real are separate namespaces", s2.readRecord("rk1-bb") === null && s2.readRecord("rk1-bb", { dry: true }).dry === true && s2.readRecord("rk1-aa", { dry: true }) === null);
  check("listDrafts filters by bankKey", s2.listDrafts({ bankKey: "A|en" }).map(d => d.draftId).join() === "dr-1" && s2.listDrafts().length === 2 && s2.listDrafts({ dry: true }).length === 0);
  let refused = 0;
  for (const id of ["../x", "a/b", "", "x".repeat(200), "a b"]) { try { s.writeDraft({ draftId: id }); } catch (_) { refused++; } }
  check("unsafe ids are refused (no path escape)", refused === 5 && !fs.existsSync(path.join(root, "x.json")));
  let rel = false; try { QB.createReviewStore({ root: "relative/dir", fs }); } catch (_) { rel = true; }
  let none = false; try { QB.createReviewStore({ fs }); } catch (_) { none = true; }
  check("root must be an explicit absolute DATA_ROOT", rel && none);
  fs.writeFileSync(path.join(s.dir, "records", "rk1-cc.json"), "{not json");
  let corrupt = false; try { s.readRecord("rk1-cc"); } catch (_) { corrupt = true; }
  check("a corrupt record is an error on read, not an empty pass", corrupt);
}

console.log("injected write / rename failures: throw, keep the old file, leave no tmp");
{
  for (const op of ["write", "rename"]) {
    const root = mkRoot();
    QB.createReviewStore({ root, fs }).writeReport({ runId: "run-1", v: "old" });
    const s = QB.createReviewStore({ root, fs: faultyFs((o, p) => o === op && /run-1/.test(p)) });
    let err = null; try { s.writeReport({ runId: "run-1", v: "new" }); } catch (e) { err = e; }
    check(`${op} failure propagates as an error`, err && new RegExp("injected " + op).test(err.message), err && err.message);
    check(`${op} failure keeps the previous report byte-for-byte and leaves no tmp`, JSON.parse(fs.readFileSync(path.join(root, "qbank-review/reports/run-1.json"), "utf8")).v === "old"
      && listAll(path.join(root, "qbank-review")).join() === "reports/run-1.json", listAll(path.join(root, "qbank-review")));
  }
}

/* ---------- 协调器 + 真实存储：落盘故障与重启续跑 ---------- */
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/fixtures/qbank-review-v2-replay.json"), "utf8"));
const contractRaw = fs.readFileSync(path.join(ROOT, "data/curriculum/visual-contract.json"), "utf8");
const brief = QB.buildTeachingBrief({
  item: FX.skill, context: { kind: "skill", grade: 4, topic: { id: "fractions", en: "Fractions" } }, skillType: { en: "concept", teachEn: "meaning" },
  visualContract: { path: "data/curriculum/visual-contract.json", raw: contractRaw }, lesson: { path: "data/lessons/en/YY.T.FRAC.EQ.json", raw: JSON.stringify(FX.lesson) }
});
const clone = v => JSON.parse(JSON.stringify(v));
const good = FX.cases.filter(c => c.name.startsWith("good")).map(c => clone(c.question));
function fakeBank() {
  const live = []; let n = 0, publishCalls = 0;
  const fp = () => QB.bankFingerprint(live);
  return {
    live, get publishCalls() { return publishCalls; },
    base: () => ({ fingerprint: fp(), qids: live.map(q => q.qid), hashes: Object.fromEntries(live.map(q => [q.qid, QB.contentHash(q)])) }),
    stage: (items, o) => { if (o.baseFingerprint !== fp()) throw new Error("bank changed"); return { candidates: items.map(q => Object.assign({ qid: q.qid || "qst" + (++n), usedAt: 0 }, clone(q))), dropped: [] }; },
    publish: (c, o) => { publishCalls++; if (o.baseFingerprint !== fp()) throw new Error("bank changed"); live.push(...clone(c)); return { published: c.map(x => x.qid) }; }
  };
}
function passJudge() {
  const calls = [];
  return { calls, fn: async req => { calls.push(req.items.map(i => i.id)); return { items: req.items.map(it => {
    const checks = {};
    for (const id of QB.CHECK_IDS) { const a = QB.allowedResults(id, it, brief); checks[id] = { result: a.includes("pass") ? "pass" : a[0], evidence: "synthetic" }; }
    return { id: it.id, status: "pass", options: [0, 1, 2, 3].map(i => ({ correct: i === it.answerIndex, reason: "synthetic solve" })), checks, findings: [] };
  }) }; } };
}
console.log("coordinator + real store: a hard-rejected question survives a restart as a held draft");
{
  const root = mkRoot(), bank = fakeBank(), j = passJudge();
  const bad = Object.assign(clone(good[0]), { question: "Look at the picture below. Which fraction is shaded?" });
  const res = await QB.runReviewV2({ brief, raw: { questions: [bad, clone(good[1])] }, deps: depsFor(bank, QB.createReviewStore({ root, fs }), j), opts: { timeoutMs: 2000 } });
  const fresh = QB.createReviewStore({ root, fs });
  const held = fresh.listDrafts().filter(d => d.state === "hard_rejected");
  check("after restart the held draft is on disk with its full content and hard findings, never published",
    res.held.length === 1 && held.length === 1 && held[0].question.question === bad.question && held[0].hardFindings.some(f => f.code === "visual_missing") && held[0].published === false
    && !bank.live.some(q => q.question === bad.question) && j.calls[0].length === 1, held);
}
function depsFor(bank, store, judge) {
  return {
    base: bank.base, stage: bank.stage, publish: bank.publish, judge: judge.fn, repair: async () => { throw new Error("no repair expected"); },
    store, checkVisual, allowedTags: new Set(FX.skill.skill.misc.map(m => m.id)), engine: { judge: { provider: "stubjudge", model: "m1" } }
  };
}

console.log("coordinator + real store: report write/rename failure blocks publication");
{
  for (const op of ["write", "rename"]) {
    const root = mkRoot(), bank = fakeBank(), j = passJudge();
    const store = QB.createReviewStore({ root, fs: faultyFs((o, p) => o === op && /[\\/]reports[\\/]/.test(p)) });
    const res = await QB.runReviewV2({ brief, raw: { questions: clone(good) }, deps: depsFor(bank, store, j), opts: { timeoutMs: 2000 } });
    check(`report ${op} failure -> storage_failed, publish never called, bank empty`, res.status === "storage_failed" && bank.publishCalls === 0 && bank.live.length === 0 && /injected/.test(res.storageError), res.status);
    check(`…no report file claims anything; drafts on disk say not published`, !fs.existsSync(path.join(root, "qbank-review/reports")) || listAll(path.join(root, "qbank-review/reports")).length === 0
      ? QB.createReviewStore({ root, fs }).listDrafts().every(d => d.published === false) : false);
  }
  const root = mkRoot(), bank = fakeBank(), j = passJudge();
  const store = QB.createReviewStore({ root, fs: faultyFs((o, p) => o === "rename" && /[\\/]records[\\/]/.test(p)) });
  const res = await QB.runReviewV2({ brief, raw: { questions: clone(good) }, deps: depsFor(bank, store, j), opts: { timeoutMs: 2000 } });
  check("record rename failure -> storage_failed, nothing published", res.status === "storage_failed" && bank.live.length === 0 && bank.publishCalls === 0);
}

console.log("coordinator + real store: publish failure, restart, retry reuses the pass");
{
  const root = mkRoot(), bank = fakeBank(), j1 = passJudge();
  const s1 = QB.createReviewStore({ root, fs });
  const d1 = depsFor(bank, s1, j1);
  d1.publish = () => { throw Object.assign(new Error("ENOSPC: bank write failed"), { code: "ENOSPC" }); };
  const r1 = await QB.runReviewV2({ brief, raw: { questions: clone(good) }, deps: d1, opts: { timeoutMs: 2000 } });
  check("bank write failure -> publish_failed, bank empty, report on disk says failed", r1.status === "publish_failed" && bank.live.length === 0
    && QB.createReviewStore({ root, fs }).readReport(r1.runId).publication.status === "failed");
  /* 重启：新的存储实例，只凭磁盘上的 draft 续跑 */
  const s2 = QB.createReviewStore({ root, fs });
  const j2 = passJudge();
  const r2 = await QB.runReviewV2({ brief, resume: s2.listDrafts(), deps: depsFor(bank, s2, j2), opts: { timeoutMs: 2000 } });
  check("after restart: exact passes reused (0 judge calls), same objects published", j2.calls.length === 0 && r2.status === "published" && bank.live.length === 2
    && bank.live.every(q => r1.items.some(i => i.qid === q.qid && i.contentHash === QB.contentHash(q))), { calls: j2.calls.length, s: r2.status });
  check("drafts on disk now say published; the old failed report is untouched",
    QB.createReviewStore({ root, fs }).listDrafts().every(d => d.state === "published" && d.published === true) && s2.readReport(r1.runId).publication.status === "failed" && s2.readReport(r2.runId).publication.status === "published");
}
{
  /* 损坏的记录：当作没审过，重新审（不崩、不当 pass） */
  const root = mkRoot(), bank = fakeBank();
  const d1 = depsFor(bank, QB.createReviewStore({ root, fs }), passJudge());
  d1.publish = () => { throw new Error("bank write failed"); };
  await QB.runReviewV2({ brief, raw: { questions: clone(good) }, deps: d1, opts: { timeoutMs: 2000 } });
  for (const f of fs.readdirSync(path.join(root, "qbank-review/records"))) fs.writeFileSync(path.join(root, "qbank-review/records", f), "{broken");
  const s = QB.createReviewStore({ root, fs }), j = passJudge();
  const r = await QB.runReviewV2({ brief, resume: s.listDrafts(), deps: depsFor(bank, s, j), opts: { timeoutMs: 2000 } });
  check("corrupt stored records are never reused: the same drafts are reviewed again, then published", j.calls.length === 1 && j.calls[0].length === 2 && r.items.every(i => !i.cached) && r.status === "published");
}

for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
process.exitCode = summary() ? 0 : 1;
