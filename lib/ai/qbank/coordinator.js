/*
 * 英文题库逐题审稿 v2 的协调器（#44，#8 子任务 B）。纯编排：所有副作用都从 deps 注入，不读配置、不碰全局题库。
 *
 *   runReviewV2({ brief, raw | resume | audit, deps, opts })
 *     raw    = 新生成的一批（{ questions: [...] }）→ 新题（mode "new"，发布 = 追加）
 *     resume = 磁盘上的 draft 记录（store.listDrafts）→ 续跑
 *     audit  = 题库里已有题的 qid 列表 → 审已有题（mode "replace"：没改动就不写，修过就原地替换、保 qid 和 usedAt）
 *   → { runId, status, items, published, unchanged, hardRejected, stagingDropped, identityRejected, report, storageError, publishError, finalizeErrors }
 *
 * deps（全部显式）：
 *   base()                              → { fingerprint, qids, hashes: {qid: contentHash}, questions }  当前正式题库（指纹不含 usedAt）
 *   stage(items, { baseFingerprint, extra })  → { candidates, dropped }  把题规范成「真要发布的对象」：新题重排选项 / 标签、发 qid；
 *                                          qid 已在题库的按原地更新规则（保 usedAt）。只调一次，之后哈希、审稿、发布都是这同一个对象。
 *   publish(candidates, { baseFingerprint, modes })  → { published: [qid] }  先持久化成功再改内存；失败必须抛错
 *   judge(req) / repair(req)            → 原始模型输出（服务端注入 runEngine；req 带 signal，超时 / 取消时 abort）
 *   store                               → writeRecord / readRecord / writeDraft / writeReport（失败必须抛错）
 *   checkVisual, allowedTags            → 硬校验（validate.js 的 checkEnglishQuestions，渲染端同一个 checkVisual）
 *   engine: { judge: {provider, model}, repair: {provider, model} }
 *   now(), newId(prefix), timers: { setTimeout, clearTimeout }（测试可换）
 *
 * 顺序：硬校验 → 暂存一次 → draftId（整组 draftId / qid 必须唯一，撞了的全拒）→ 暂存对象再硬校验 → 哈希 / reviewKey
 *       → 复用「这个精确版本」的有效非 dry pass，否则送审（题库里已有同内容也一样要有当前版本的证据）
 *       → 只修 revise 的题（保 draftId / qid / level，有上限；改完暂存 + 硬校验 + 复审）
 *       → 先落审稿记录 / draft / 报告（publication: pending）→ 再发布 → 收尾（尽力而为，失败如实返回）。
 * 硬校验不过的题永远不送审、不发布，模型说什么都没用。needs-human / 出错 / 超时 / 耗尽 / 取消 都留 draft。
 * 超时后迟到的结果不采用：每次调用的结果只在计时器之前被接收一次。
 * 并发：发布时核对题库指纹，暂存之后同一题库被别人改过就拒绝（publish_failed，续跑会按新题库重新暂存）；
 *       整份 qbank.json 的写入由 server 同步完成，读的是当时的内存题库，不会用旧快照盖掉别的题库。
 */
"use strict";

const crypto = require("crypto");
const { isTeachingBrief, canonicalJson: canon } = require("./brief.js");
const { checkEnglishQuestions } = require("./validate.js");
const R = require("./review.js");
const E = require("./evidence.js");

const REVIEW_V2_DEFAULTS = Object.freeze({ maxRepairRounds: 2, maxRepairRoundsCap: 3, timeoutMs: 180000, timeoutMsCap: 600000 });
const REPORT_KIND = "yy-qbank-review-report", RECORD_KIND = "yy-qbank-review-record", DRAFT_KIND = "yy-qbank-draft";
const clone = v => JSON.parse(JSON.stringify(v));
const clampInt = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const errText = e => String((e && e.message) || e).slice(0, 300);
const withoutUsedAt = q => { const c = Object.assign({}, q); delete c.usedAt; return c; };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* 一次受限的外部调用：计时器 / 外部取消先到就结束，fn 的结果之后再到也不会被接收 */
function boundedCall(fn, ms, outer, timers) {
  const ac = new AbortController();
  return new Promise(resolve => {
    let done = false, timer = null;
    const onAbort = () => { ac.abort(); finish({ kind: "cancelled" }); };
    const finish = r => {
      if (done) return;
      done = true;
      if (timer !== null) timers.clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
      resolve(r);
    };
    if (outer && outer.aborted) { ac.abort(); finish({ kind: "cancelled" }); return; }
    timer = timers.setTimeout(() => { ac.abort(); finish({ kind: "timeout" }); }, ms);
    if (outer) outer.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => fn(ac.signal)).then(value => finish({ kind: "ok", value }), error => finish({ kind: "error", error }));
  });
}

function assertDeps(brief, deps, input) {
  if (!isTeachingBrief(brief)) throw new TypeError("runReviewV2 needs the frozen TeachingBrief used for generation");
  const d = deps || {};
  for (const f of ["base", "stage", "publish", "judge", "repair", "checkVisual"]) if (typeof d[f] !== "function") throw new TypeError("runReviewV2 needs deps." + f);
  const s = d.store;
  if (!s || ["writeRecord", "readRecord", "writeDraft", "writeReport"].some(f => typeof s[f] !== "function")) throw new TypeError("runReviewV2 needs deps.store (writeRecord/readRecord/writeDraft/writeReport)");
  if (!d.engine || !d.engine.judge) throw new TypeError("runReviewV2 needs deps.engine.judge");
  R.engineIdentity(d.engine.judge);
  const kinds = ["raw", "resume", "audit"].filter(k => input[k] != null);
  if (kinds.length !== 1) throw new TypeError("runReviewV2 takes exactly one of raw / resume / audit");
}

async function runReviewV2(input) {
  input = input || {};
  const { brief, raw = null, resume = null, audit = null, deps, opts = {} } = input;
  assertDeps(brief, deps, { raw, resume, audit });
  const d = deps;
  const timers = d.timers || { setTimeout, clearTimeout };
  const now = d.now || (() => new Date().toISOString());
  const newId = d.newId || (p => p + "-" + crypto.randomBytes(8).toString("hex"));
  const dry = opts.dry === true;
  const maxRounds = clampInt(opts.maxRepairRounds, 0, REVIEW_V2_DEFAULTS.maxRepairRoundsCap, REVIEW_V2_DEFAULTS.maxRepairRounds);
  const timeoutMs = clampInt(opts.timeoutMs, 1, REVIEW_V2_DEFAULTS.timeoutMsCap, REVIEW_V2_DEFAULTS.timeoutMs);
  const signal = opts.signal || null;
  const runId = opts.runId || newId("run");
  const judgeEngine = R.engineIdentity(d.engine.judge);
  const repairEngine = d.engine.repair ? R.engineIdentity(d.engine.repair) : null;
  const so = { dry };
  const cancelled = () => !!(signal && signal.aborted);

  const report = {
    kind: REPORT_KIND, v: 1, runId, dry, startedAt: now(), finishedAt: null,
    source: raw ? "generated" : resume ? "resume" : "audit",
    bankKey: opts.bankKey || null, itemId: brief.item.id, lang: "en",
    briefId: brief.briefId, briefHash: brief.briefHash,
    /* alignment 在最后按真正拿到的逐题结论算；课文缺失从头到尾都是 not_verified */
    lesson: { status: brief.lesson.status, path: brief.lesson.path, sha256: brief.lesson.sha256, humanReview: "unknown",
      alignment: brief.lesson.status === "present" ? "not-reviewed" : "not_verified" },
    rules: { version: brief.rules.version, hash: brief.rules.hash },
    rubric: { version: R.RUBRIC.version, hash: R.RUBRIC.hash },
    engine: { judge: judgeEngine, repair: repairEngine,
      reuse: judgeEngine.exact ? "exact non-dry passes of this engine identity" : "none: the judge model is not known exactly, so no verdict of this run is reused later" },
    limits: { maxRepairRounds: maxRounds, timeoutMs },
    humanApproval: "none",
    note: "model review only: not a human approval and not proof of educational correctness",
    hardRejected: [], stagingDropped: [], identityRejected: [], items: [],
    publication: { status: "pending" }
  };
  const hardCtx = qids => ({ brief, checkVisual: d.checkVisual, allowedTags: d.allowedTags || null, existingQids: qids });

  /* ---------- 1. 基线、候选、暂存一次 ---------- */
  const base = await d.base();
  const baseHashes = base.hashes || {};
  const items = [];   // { draftId, qid, level, mode, target, cand, contentHash, reviewKey, parts, state, verdict, cached, repairs, attempts, published, publication }
  const newItem = (draftId, cand, mode, target) => ({ draftId, qid: cand.qid, level: cand.level, mode, target: target || null, cand, state: "pending", verdict: null, cached: false, repairs: 0, attempts: [], published: false, publication: null });
  const drop = (draftId, reason) => report.stagingDropped.push({ draftId, reason });

  /* 没进审稿的题（硬校验不过 / 暂存时去重封顶丢掉的）也落成不可发布的 draft：内容（白名单字段）+ 原因，
   * 供人工处理或下一轮重新生成参考；报告里只有摘要。它们没有 qid，不会被 resume 自动拿去发布。 */
  const held = [];   // { draftId, state, question, findings }
  const holdOf = R.questionContent;
  if (raw) {
    const hc = checkEnglishQuestions(raw, hardCtx(base.qids || []));
    report.hardRejected = clone(hc.rejected);
    report.hardWarnings = clone(hc.warnings);
    const rawQs = raw && Array.isArray(raw.questions) ? raw.questions : [];
    for (const r of hc.rejected) held.push({ draftId: newId("dr"), state: "hard_rejected", question: holdOf(rawQs[r.index]), findings: clone(r.findings) });
    if (hc.accepted.length) {
      const st = await d.stage(hc.accepted.map(clone), { baseFingerprint: base.fingerprint, extra: [] });
      report.stagingDropped = clone(st.dropped || []);
      for (const x of st.dropped || []) held.push({ draftId: newId("dr"), state: "staging_dropped", question: holdOf(hc.accepted[x.index]), findings: [{ code: "staging_dropped", field: "", message: x.reason }] });
      for (const cand of st.candidates) items.push(newItem(newId("dr"), cand, "new"));
    }
  } else if (audit) {
    /* 已有题：候选就是题库里那个对象本身（不重新暂存）；要有当前版本的审稿证据才算过 */
    const byQid = new Map((base.questions || []).filter(q => q && q.qid).map(q => [q.qid, q]));
    for (const qid of audit) {
      const q = byQid.get(qid);
      if (!q) { drop(null, `qid ${JSON.stringify(qid)} is not in the bank`); continue; }
      items.push(newItem(newId("dr"), clone(q), "replace", baseHashes[qid]));
    }
  } else {
    const restage = [];
    for (const dr of resume) {
      if (dr && (dr.state === "hard_rejected" || dr.state === "staging_dropped")) { drop(dr.draftId, "held draft: needs a fixed question before it can be reviewed"); continue; }
      if (!dr || !R.DRAFT_ID_RE.test(String(dr.draftId || "")) || !dr.question || typeof dr.question.qid !== "string") { drop(dr && dr.draftId, "not a usable draft record"); continue; }
      /* 别的条目 / 别的题库的 draft 不混进来（brief 不同，审过的结论也对不上） */
      if ((dr.itemId != null && dr.itemId !== brief.item.id) || (dr.bankKey != null && opts.bankKey != null && dr.bankKey !== opts.bankKey)) { drop(dr.draftId, "draft belongs to another item or bank"); continue; }
      const qid = dr.question.qid, h = R.contentHash(dr.question), mode = dr.mode === "replace" ? "replace" : "new";
      if (has(baseHashes, qid)) {
        if (baseHashes[qid] === h) {
          /* 题库里已经是这份内容（发布成功但收尾没写上，或审已有题）：不重复写，但仍要当前版本的证据 */
          items.push(newItem(dr.draftId, clone(dr.question), "replace", baseHashes[qid]));
        } else if (mode === "replace" && dr.target === baseHashes[qid]) {
          /* 已有题的修复版，题库里还是它要替换的那个版本 → 按当前题库重新暂存（保 usedAt） */
          restage.push({ dr, mode, target: dr.target });
        } else drop(dr.draftId, mode === "replace" ? "the bank question this draft replaces has changed" : "the bank already has a different question with this qid");
        continue;
      }
      if (mode === "replace") { drop(dr.draftId, "the bank question this draft replaces is gone"); continue; }
      if (dr.baseFingerprint === base.fingerprint) items.push(newItem(dr.draftId, clone(dr.question), "new"));
      else restage.push({ dr, mode: "new", target: null });
    }
    if (restage.length) {
      /* 题库在这期间变了：带着原 qid 重新暂存（结果可能换了选项位置 → 新内容哈希 → 重新审） */
      const others = items.map(i => i.cand).filter(c => !has(baseHashes, c.qid));
      const st = await d.stage(restage.map(x => withoutUsedAt(x.dr.question)), { baseFingerprint: base.fingerprint, extra: others });
      const dropped = new Map((st.dropped || []).map(x => [x.index, x.reason]));
      let k = 0;
      restage.forEach((x, i) => {
        if (dropped.has(i)) { drop(x.dr.draftId, dropped.get(i)); return; }
        const cand = st.candidates[k++];
        if (!cand || cand.qid !== x.dr.question.qid || cand.level !== x.dr.question.level) drop(x.dr.draftId, "restaging changed the draft's qid or level");
        else items.push(newItem(x.dr.draftId, cand, x.mode, x.target));
      });
    }
  }

  /* 身份：整组 draftId、qid 必须各自唯一。撞了的一个都不收（不猜哪份是对的），不送审、不写 draft、不发布 */
  {
    const count = (list, f) => list.reduce((m, it) => m.set(f(it), (m.get(f(it)) || 0) + 1), new Map());
    const byDraft = count(items.concat(held), it => it.draftId), byQid = count(items, it => it.qid);
    const bad = items.filter(it => !R.DRAFT_ID_RE.test(String(it.draftId)) || typeof it.qid !== "string" || byDraft.get(it.draftId) > 1 || byQid.get(it.qid) > 1);
    for (const it of bad) report.identityRejected.push({ draftId: it.draftId, qid: it.qid, reason: "draftId or qid not unique in this run (or missing)" });
    for (const it of bad) items.splice(items.indexOf(it), 1);
    const badHeld = held.filter(h => !R.DRAFT_ID_RE.test(String(h.draftId)) || byDraft.get(h.draftId) > 1);
    for (const h of badHeld) { report.identityRejected.push({ draftId: h.draftId, qid: null, reason: "draftId not unique in this run; held draft not written" }); held.splice(held.indexOf(h), 1); }
  }

  /* 暂存后的最终对象再过一遍硬校验：规范化必须不改题（校验输出 = 候选对象去掉 usedAt），不然就不是「审的就是发的」 */
  const hardCheckCandidate = cand => {
    const qids = (base.qids || []).filter(q => q !== cand.qid);
    const r = checkEnglishQuestions({ questions: [withoutUsedAt(cand)] }, hardCtx(qids));
    if (r.rejected.length) return r.rejected[0].findings;
    if (canon(r.accepted[0]) !== canon(withoutUsedAt(cand))) return [{ code: "not_normalized", field: "", message: "hard check would change the staged object" }];
    return null;
  };
  const setVersion = it => {
    const k = R.reviewKey(brief, it.cand, judgeEngine);
    it.contentHash = k.parts.contentHash; it.reviewKey = k.reviewKey; it.parts = k.parts;
  };
  for (const it of items) {
    const f = hardCheckCandidate(it.cand);
    setVersion(it);
    if (f) { it.state = "hard_failed"; it.attempts.push({ at: now(), kind: "hard_check", findings: f }); }
  }

  /* ---------- 2. 复用 / 审稿 ---------- */
  const records = [];   // 本次拿到有效模型结论的每个版本
  const inputOf = it => R.reviewInput([{ draftId: it.draftId, question: it.cand }])[0];
  const tryReuse = it => {
    /* dry 从不复用；不知道确切模型的引擎（CLI 默认模型）证明不了「同一个引擎审过」，也不复用 */
    if (dry || !judgeEngine.exact) return false;
    let rec = null;
    try { rec = d.store.readRecord(it.reviewKey, { dry: false }); } catch (_) { return false; }
    /* 逐项比对组成部分 + 重新验 pass：和 pregen / audit / 导出用的是同一份检查（evidence.js） */
    const m = E.matchRecord(rec, brief, it.cand, judgeEngine);
    if (!m.ok || m.status !== "pass" || rec.reviewKey !== it.reviewKey) return false;
    it.state = "passed"; it.cached = true;
    it.verdict = { status: "pass", options: clone(rec.options), checks: clone(rec.checks), findings: [] };
    it.attempts.push({ at: now(), kind: "review", reused: rec.reviewKey, runId: rec.runId || null });
    return true;
  };
  const review = async list => {
    if (!list.length) return;
    const input = R.reviewInput(list.map(it => ({ draftId: it.draftId, question: it.cand })));
    const req = R.buildReviewRequest(brief, input);
    const r = await boundedCall(sig => d.judge(Object.assign({}, req, { items: clone(input), signal: sig })), timeoutMs, signal, timers);
    const at = now();
    if (r.kind !== "ok") {
      const state = r.kind === "timeout" ? "timeout" : r.kind === "cancelled" ? "cancelled" : "error";
      for (const it of list) { it.state = state; it.attempts.push({ at, kind: "review", outcome: state, message: r.kind === "error" ? errText(r.error) : undefined }); }
      return;
    }
    const p = R.parseReviewV2(r.value, input, brief);
    if (!p.verdicts.size) {
      for (const it of list) { it.state = "error"; it.attempts.push({ at, kind: "review", outcome: "invalid_response", errors: p.errors.slice(0, 10) }); }
      return;
    }
    for (const it of list) {
      const v = p.verdicts.get(it.draftId);
      if (v.invalid) { it.state = "error"; it.attempts.push({ at, kind: "review", outcome: "invalid_verdict", errors: v.invalid }); continue; }
      it.verdict = v;
      it.state = v.status === "pass" ? "passed" : v.status === "revise" ? "revise" : "needs_human";
      it.attempts.push({ at, kind: "review", outcome: v.status, reviewKey: it.reviewKey, findings: clone(v.findings) });
      records.push({ kind: RECORD_KIND, v: 1, reviewKey: it.reviewKey, parts: clone(it.parts), dry, runId, at, draftId: it.draftId, qid: it.qid,
        question: R.questionContent(it.cand), status: v.status, options: clone(v.options), checks: clone(v.checks), findings: clone(v.findings), humanReview: "none" });
    }
  };

  const pending = items.filter(it => it.state === "pending");
  if (cancelled()) for (const it of pending) it.state = "cancelled";
  else await review(pending.filter(it => !tryReuse(it)));

  /* ---------- 3. 有限修复：只修 revise 的题 ---------- */
  for (let round = 1; round <= maxRounds; round++) {
    const revise = items.filter(it => it.state === "revise");
    if (!revise.length || cancelled()) break;
    const reReview = [];
    for (const it of revise) {
      if (cancelled()) { it.state = "cancelled"; continue; }
      it.repairs++;
      const input = inputOf(it);
      const req = R.buildRepairRequest(brief, input, it.verdict);
      const r = await boundedCall(sig => d.repair(Object.assign({}, req, { draftId: it.draftId, item: clone(input), verdict: clone(it.verdict), signal: sig })), timeoutMs, signal, timers);
      const at = now();
      if (r.kind !== "ok") {
        it.state = r.kind === "timeout" ? "timeout" : r.kind === "cancelled" ? "cancelled" : "error";
        it.attempts.push({ at, kind: "repair", round, outcome: it.state, message: r.kind === "error" ? errText(r.error) : undefined });
        continue;
      }
      const out = r.value;
      const refuse = (code, message, findings) => it.attempts.push({ at, kind: "repair", round, outcome: "refused", code, message, findings });
      if (!out || typeof out !== "object" || Array.isArray(out)) { refuse("repair_not_object", "repair output is not a question object"); continue; }
      if (out.qid !== undefined && out.qid !== it.qid) { refuse("repair_changed_qid", `repair changed qid to ${JSON.stringify(out.qid)}`); continue; }
      const hc = checkEnglishQuestions({ questions: [Object.assign({}, out, { qid: it.qid })] }, hardCtx((base.qids || []).filter(q => q !== it.qid)));
      if (hc.rejected.length || !hc.accepted.length) { refuse("repair_hard_failed", "repair failed the hard checks", hc.rejected.length ? hc.rejected[0].findings : []); continue; }
      const fixed = hc.accepted[0];
      if (fixed.level !== it.level) { refuse("repair_changed_level", `repair changed level ${it.level} -> ${fixed.level}`); continue; }
      /* 新题：和同批别的新题一起去重 / 封顶；已有题：按题库原地更新规则暂存（保 usedAt） */
      const others = items.filter(o => o !== it && o.mode === "new").map(o => o.cand);
      let st;
      try { st = await d.stage([fixed], { baseFingerprint: base.fingerprint, extra: it.mode === "new" ? others : [] }); }
      catch (e) { refuse("repair_stage_failed", errText(e)); continue; }
      if (!st.candidates || st.candidates.length !== 1) { refuse("repair_dropped", ((st.dropped || [])[0] || {}).reason || "dropped while staging"); continue; }
      const cand = st.candidates[0];
      if (cand.qid !== it.qid || cand.level !== it.level) { refuse("repair_identity_lost", "staging changed qid or level"); continue; }
      const f = hardCheckCandidate(cand);
      if (f) { refuse("repair_hard_failed", "staged repair failed the hard checks", f); continue; }
      /* 新版本：旧版本的结论不跟过来（留在 attempts / 审稿记录里），只有新版本自己拿到有效复审才有 verdict */
      it.cand = cand; setVersion(it); it.state = "pending"; it.verdict = null; it.cached = false;
      it.attempts.push({ at, kind: "repair", round, outcome: "repaired", contentHash: it.contentHash });
      reReview.push(it);
    }
    if (cancelled()) { for (const it of reReview) it.state = "cancelled"; break; }
    await review(reReview);
  }
  /* 取消了：还没结论 / 还在修的一律 cancelled；已 pass 的保持 passed（结论有效），但下面不会发布 */
  for (const it of items) if (it.state === "revise" || it.state === "pending") it.state = cancelled() ? "cancelled" : it.state === "revise" ? "exhausted" : it.state;

  /* 课文对齐的覆盖：只按真正拿到的有效逐题结论算，不因为课文文件存在就说检查过 */
  const lessonTally = { pass: 0, fail: 0, not_verified: 0 };
  for (const it of items) if (it.verdict && it.verdict.checks.lesson_alignment) lessonTally[it.verdict.checks.lesson_alignment.result]++;
  report.coverage = { itemsWithValidVerdict: items.filter(it => it.verdict).length, lessonAlignment: lessonTally };
  if (brief.lesson.status === "present" && lessonTally.pass + lessonTally.fail > 0)
    report.lesson.alignment = lessonTally.pass + lessonTally.fail === items.length ? "model-reviewed-per-item" : "model-reviewed-for-some-items";

  /* ---------- 4. 先落盘（记录 / draft / 报告），失败就不发布 ---------- */
  const itemView = it => ({
    draftId: it.draftId, qid: it.qid, level: it.level, mode: it.mode, state: it.state, contentHash: it.contentHash, reviewKey: it.reviewKey,
    cached: it.cached, repairs: it.repairs, published: it.published, publication: it.publication,
    options: it.verdict ? clone(it.verdict.options) : null, checks: it.verdict ? clone(it.verdict.checks) : null,
    findings: it.verdict ? clone(it.verdict.findings) : [], attempts: clone(it.attempts)
  });
  const draftOf = it => ({
    kind: DRAFT_KIND, v: 1, draftId: it.draftId, qid: it.qid, bankKey: report.bankKey, itemId: brief.item.id, runId, dry,
    briefHash: brief.briefHash, baseFingerprint: base.fingerprint, mode: it.mode, target: it.target, state: it.state,
    published: it.published, publication: it.publication, contentHash: it.contentHash, reviewKey: it.reviewKey,
    verdict: it.verdict ? clone(it.verdict) : null, question: R.questionContent(it.cand), updatedAt: now()
  });
  const heldDraft = h => ({
    kind: DRAFT_KIND, v: 1, draftId: h.draftId, qid: typeof h.question.qid === "string" ? h.question.qid : null, bankKey: report.bankKey, itemId: brief.item.id, runId, dry,
    briefHash: brief.briefHash, baseFingerprint: base.fingerprint, mode: "new", target: null, state: h.state, published: false, publication: null,
    contentHash: null, reviewKey: null, verdict: null, hardFindings: clone(h.findings), question: clone(h.question), updatedAt: now()
  });
  report.held = held.map(h => ({ draftId: h.draftId, state: h.state, codes: [...new Set(h.findings.map(f => f.code))] }));
  const result = { runId, dry, status: null, items: [], published: [], unchanged: [], stale: [], held: report.held, hardRejected: report.hardRejected, stagingDropped: report.stagingDropped,
    identityRejected: report.identityRejected, report, storageError: null, publishError: null, finalizeErrors: [] };
  const passed = items.filter(it => it.state === "passed");
  report.publication = { status: dry ? "dry-run" : cancelled() ? "cancelled" : passed.length ? "pending" : "nothing-to-publish" };
  report.items = items.map(itemView);
  try {
    for (const rec of records) d.store.writeRecord(rec, so);
    for (const it of items) d.store.writeDraft(draftOf(it), so);
    for (const h of held) d.store.writeDraft(heldDraft(h), so);
    report.finishedAt = now();
    d.store.writeReport(clone(report), so);
  } catch (e) {
    result.storageError = errText(e);
    result.status = "storage_failed";
    report.publication = { status: "blocked", reason: "review storage failed: " + result.storageError };
    result.items = items.map(itemView);
    return result;
  }

  /* ---------- 5. 发布（只在落盘成功、非 dry、未取消时） ---------- */
  const finish = status => { result.status = status; result.items = items.map(itemView); return result; };
  if (dry) return finish("dry_run");
  if (cancelled()) return finish("cancelled");
  if (!passed.length) return finish("nothing_published");
  /* 发布前最后一次硬校验（发布的就是这些对象本身）；题库里已经是这份内容的不用写 */
  const ready = passed.filter(it => !hardCheckCandidate(it.cand));
  let unchanged = ready.filter(it => it.mode === "replace" && baseHashes[it.qid] === it.contentHash);
  const toWrite = ready.filter(it => !unchanged.includes(it));
  if (unchanged.length) {
    /* 「没改动、不用写」也要按此刻的题库核对：审稿期间这道题被别人改了，审过的就不是现在题库里的那份 */
    const cur = await d.base();
    const curHashes = (cur && cur.hashes) || {};
    const stale = unchanged.filter(it => curHashes[it.qid] !== it.contentHash);
    for (const it of stale) { it.state = "stale"; it.attempts.push({ at: now(), kind: "publish", outcome: "stale", message: "the bank question changed during the review; the reviewed version is no longer current" }); }
    unchanged = unchanged.filter(it => !stale.includes(it));
    result.stale = stale.map(it => it.qid);
  }
  for (const it of unchanged) { it.published = true; it.publication = "unchanged"; }
  result.unchanged = unchanged.map(it => it.qid);
  if (toWrite.length) {
    let pub;
    try { pub = await d.publish(toWrite.map(it => clone(it.cand)), { baseFingerprint: base.fingerprint, modes: toWrite.map(it => it.mode) }); }
    catch (e) {
      for (const it of unchanged) { it.published = false; it.publication = null; }
      result.unchanged = [];
      result.publishError = errText(e);
      report.publication = { status: "failed", reason: result.publishError, at: now() };
      report.items = items.map(itemView);
      try { d.store.writeReport(clone(report), so); } catch (e2) { result.finalizeErrors.push("report: " + errText(e2)); }
      return finish("publish_failed");
    }
    const done = new Set((pub && pub.published) || []);
    for (const it of toWrite) if (done.has(it.qid)) { it.published = true; it.publication = it.mode === "new" ? "added" : "replaced"; }
  }
  result.published = toWrite.filter(it => it.published).map(it => it.qid);

  /* ---------- 6. 收尾：尽力更新 draft / 报告；写不进去只影响记录，不会把没发布的说成发布了 ---------- */
  if (result.stale.length) result.publishError = "bank changed during the review for " + result.stale.join(", ");
  report.publication = { status: result.published.length ? "published" : result.unchanged.length ? "unchanged" : result.stale.length ? "failed" : "nothing-to-publish",
    qids: result.published.slice(), unchanged: result.unchanged.slice(), stale: result.stale.slice(), at: now() };
  report.items = items.map(itemView);
  for (const it of items.filter(i => i.published)) {
    try { d.store.writeDraft(Object.assign(draftOf(it), { state: "published" }), so); } catch (e) { result.finalizeErrors.push("draft " + it.draftId + ": " + errText(e)); }
  }
  try { d.store.writeReport(clone(report), so); } catch (e) { result.finalizeErrors.push("report: " + errText(e)); }
  for (const it of items.filter(i => i.state === "stale")) {
    try { d.store.writeDraft(draftOf(it), so); } catch (e) { result.finalizeErrors.push("draft " + it.draftId + ": " + errText(e)); }
  }
  return finish(result.published.length ? "published" : result.unchanged.length ? "unchanged" : result.stale.length ? "publish_failed" : "nothing_published");
}

module.exports = { runReviewV2, REVIEW_V2_DEFAULTS, boundedCall };
