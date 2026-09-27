/*
 * 已存审稿记录能不能当「这道题此刻这个版本」的证据（#45）。纯函数，零 I/O。
 *
 * 协调器复用 pass（#44 的 tryReuse）、pregen / audit 的续跑判断、v2 导出的资格判断都走这一份检查，不各写一套：
 *   matchRecord(rec, brief, question, engine)
 *     → { ok: true, status, record } | { ok: false, reason }
 *     记录必须是非 dry 的审稿记录，组成部分（内容哈希 / brief / 课文 / 规则 / rubric / 审稿引擎）按**此刻的** brief 和题目逐项重算后
 *     原样相同，reviewKey 由这些部分算得出来，记录里存的题目内容哈希也对得上；结论（pass / revise / needs-human 都一样）要用同一个
 *     严格解析器重新验一遍——残缺、自相矛盾的记录不是有效意见。
 *     engine 给了就要求记录是这个审稿引擎的；给 null = 用记录自己写的引擎身份（只用来找「更新的不过」，见 currentEvidence）。
 *     记录的审稿模型不确定（exact:false）→ 不是证据（ok:false、unknownModel:true）：pass 不复用，非 pass 也不当定论。
 *   latestVerdict(records, brief, question)
 *     → { status: "pass" | "revise" | "needs-human" | null, record, at, considered }
 *     这道题此刻这个版本（任何审稿引擎）最新的一条有效结论；同一时刻 pass 和非 pass 并存按非 pass 算。
 *   currentEvidence({ brief, question, judge, records, byKey, reviewedThisRun })
 *     → { state: "certified" | "held" | "unverified", status, reason, reviewKey }
 *     「现在算不算审过」的唯一口径（pregen / audit 判断要不要审、v2 导出判断能不能带）：
 *       - 以**当前配置的审稿引擎身份** judge 为准：要有它对这个精确版本的有效非 dry 记录（byKey 按 reviewKey 查）；
 *       - judge 的模型不确定（exact:false）：历史记录一概不算（pass 不能复用、非 pass 也不能当定论），只认本次运行刚审的（reviewedThisRun）；
 *       - 它的记录是 pass，但任何（模型确定的）审稿引擎对同一版本有**比这条 pass 新**的有效不过（revise / needs-human，同时刻按不过算）→ held；
 *         比它早的不过不否决（已经被这次 pass 取代）；
 *       - 它的记录是 revise / needs-human → held（等人工或改内容）；没有有效记录 → unverified（要审）。
 * 「有效」只说明记录自洽、对得上当前版本——结论本身是模型意见，不是人工审核。
 */
"use strict";

const { canonicalJson: canon } = require("./brief.js");
const R = require("./review.js");

const RECORD_KIND = "yy-qbank-review-record";

function matchRecord(rec, brief, question, engine) {
  if (!rec || typeof rec !== "object") return { ok: false, reason: "no record" };
  if (rec.kind !== RECORD_KIND) return { ok: false, reason: "not a review record" };
  if (rec.dry !== false) return { ok: false, reason: "dry-run record" };
  if (!R.STATUSES.includes(rec.status)) return { ok: false, reason: "unknown status" };
  if (!rec.parts || typeof rec.parts !== "object") return { ok: false, reason: "record has no key parts" };
  let want;
  try { want = R.reviewKey(brief, question, engine || rec.parts.engine); }
  catch (e) { return { ok: false, reason: "cannot compute the current key: " + String(e && e.message) }; }
  if (rec.reviewKey !== want.reviewKey || canon(rec.parts) !== canon(want.parts) || R.reviewKeyOf(rec.parts) !== rec.reviewKey)
    return { ok: false, reason: "record is for another version (content / brief / lesson / rules / rubric / engine)" };
  if (!rec.question || typeof rec.question !== "object" || R.contentHash(rec.question) !== want.parts.contentHash)
    return { ok: false, reason: "stored question does not match the key" };
  /* 三种结论都用同一个严格解析器重验（pass 另有 storedPassIsValid，是同一回事）：残缺 / 自相矛盾的 revise / needs-human
   * 不是有效的模型意见，不能拿来挡住重审或导出；它只是一份坏记录（当作没有证据）。 */
  const item = R.reviewInput([{ draftId: R.DRAFT_ID_RE.test(String(rec.draftId || "")) ? rec.draftId : "evidence", question }])[0];
  const p = R.parseReviewV2({ items: [{ id: item.id, status: rec.status, options: rec.options, checks: rec.checks, findings: rec.findings }] }, [item], brief);
  if (!p.ok || p.verdicts.get(item.id).status !== rec.status) return { ok: false, reason: "stored " + rec.status + " does not re-validate" };
  if (rec.status === "pass" && !R.storedPassIsValid(rec, item, brief)) return { ok: false, reason: "stored pass does not re-validate" };
  /* 模型不确定的审稿引擎（exact:false）写下的结论：记录本身是好的，但证明不了「同一个引擎审过」——pass 不能复用，非 pass 也不能当定论。
   * 只有 currentEvidence 在「本次运行刚审的」这一种情况下用它（unknownModel 标出来） */
  if (!R.engineIdentity(rec.parts.engine).exact) return { ok: false, reason: "judge model unknown: never reusable evidence", status: rec.status, record: rec, unknownModel: true };
  return { ok: true, status: rec.status, record: rec };
}

function latestVerdict(records, brief, question) {
  let best = null, considered = 0;
  for (const rec of records || []) {
    const m = matchRecord(rec, brief, question, null);
    if (!m.ok) continue;
    considered++;
    const at = String(rec.at || "");
    if (!best || at > best.at || (at === best.at && best.status === "pass" && rec.status !== "pass")) best = { status: rec.status, record: rec, at };
  }
  return best ? Object.assign(best, { considered }) : { status: null, record: null, at: null, considered };
}

function currentEvidence(o) {
  const { brief, question, judge, records = [], byKey = null, reviewedThisRun = null } = o || {};
  const id = R.engineIdentity(judge);
  const k = R.reviewKey(brief, question, id).reviewKey;
  const rec = byKey ? byKey.get(k) || null : records.find(r => r && r.reviewKey === k) || null;
  let m = matchRecord(rec, brief, question, id);
  if (m.unknownModel) {
    if (!(reviewedThisRun && reviewedThisRun.has(k))) return { state: "unverified", status: null, reason: "judge model unknown: earlier records are never reused", reviewKey: k };
    m = { ok: true, status: m.status, record: m.record };   // 本次运行刚审的：结论当场有效，但不落成以后的证据
  }
  if (!m.ok) return { state: "unverified", status: null, reason: rec ? m.reason : "no record for the current judge", reviewKey: k };
  if (m.status !== "pass") return { state: "held", status: m.status, reason: "current judge: " + m.status, reviewKey: k };
  /* 否决只看「比当前这条 pass 新（或同一时刻）」的有效不过；更早的不过已经被这次 pass 取代了 */
  const passAt = String(m.record.at || "");
  for (const r of records || []) {
    if (!r || r === m.record || r.status === "pass") continue;
    const v = matchRecord(r, brief, question, null);
    if (v.ok && String(r.at || "") >= passAt) return { state: "held", status: v.status, reason: "a later " + v.status + " for this version (" + r.parts.engine.provider + ")", reviewKey: k };
  }
  return { state: "certified", status: "pass", reason: null, reviewKey: k };
}

module.exports = { matchRecord, latestVerdict, currentEvidence, RECORD_KIND };
