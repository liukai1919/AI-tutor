/*
 * 英文题库逐题审稿 v2 的协议层（#44，#8 子任务 B）。纯函数：不读文件、不调模型、不看配置。
 *
 *   V2_CHECKS / RUBRIC        逐题必答的检查项（审稿提示词、解析、报告共用这一份；rubric.hash 随文本变）
 *   reviewInput(candidates)   送审的题：只留 qid / level / question / options / answerIndex / explain / tags / visual，
 *                             id = draftId（必须唯一）；usedAt 和任何家庭 / 孩子状态都剥掉
 *   buildReviewRequest(brief, items) / buildRepairRequest(brief, item, verdict)   → { sys, msg, schema, hint }
 *   parseReviewV2(raw, items, brief)   严格解析；绝不退回 v1 的 pass/problems/bad
 *   storedPassIsValid(rec, item, brief) 已存的 pass 用同一个解析器重新验一遍（防手改 / 旧格式）
 *   toV1Verdict(parsed, items)         显式的 v1 兼容适配器：v2 响应不合格就抛错，不会变成 v1 的 pass
 *   contentHash(q) / reviewKey(brief, q, engine) / bankFingerprint(questions)
 *
 * 每道题的结论 = 逐个选项的解题（options）+ 每项检查的结论和证据（checks）+ 可执行的发现（findings：
 * category / field / evidence / reason / suggestedFix）+ 状态（pass / revise / needs-human）。
 * 审稿结论只是「这台引擎在这份 brief / 规则下怎么说」：不是人工审核，也证明不了题目在教学上真的对。
 */
"use strict";

const crypto = require("crypto");
const { isTeachingBrief, renderJudgeBrief, renderGeneratorBrief, canonicalJson } = require("./brief.js");

const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}

const STATUSES = Object.freeze(["pass", "revise", "needs-human"]);
const RESULTS = Object.freeze(["pass", "fail", "n/a", "not_verified"]);

/* 每项检查什么时候允许 n/a 由 allowedResults 决定（只看题目和 brief 的事实，不看模型怎么说）。
 * 通用的检查（答案、解析、干扰项质量、题目自足、技能/难度）永远要给 pass / fail：没有图、没有 tags 不能证明它们不适用。
 * not_verified：课文缺失时的 lesson_alignment 只能是它；其余检查只有在状态是 needs-human 时才能写（模型确认不了就交人工，不许硬写 pass）。 */
const V2_CHECKS = deepFreeze([
  { id: "answer_unique", text: "Solve every option separately (see \"options\"): the option marked by answerIndex is truly correct, every other option is truly wrong, and every number and step is right." },
  { id: "explain_consistent", text: "The explanation reaches the same answer as answerIndex by a correct method, names the common trap, and never refers to an option by position." },
  { id: "distractors", text: "Every distractor is a plausible real mistake (not obviously wrong), and the correct option is not given away by length or wording." },
  { id: "tag_meaning", text: "Each distractor's tag names the misconception that distractor really shows (a registered id being valid is not enough; \"other\" only when none fits). n/a only when the question has no tags." },
  { id: "self_contained", text: "The question is answerable from its own text plus its own visual: it never needs a picture, table or data it does not carry, and never refers to one it does not have." },
  { id: "visual_semantics", text: "The visual's quantities, the whole, the units and the scale/step agree with the stem and the explanation, and it does not print or give away the answer. n/a only when the question has no visual." },
  { id: "skill_level", text: "It tests the brief's goal — not a prerequisite or an out-of-scope later skill as the point — and fits the definition of its own level." },
  { id: "level_increment", text: "Level 2 and Level 3: a meaningful increase over Level 1 (choosing a method, a real context step, a second reasoning step or a registered misconception), not the Level-1 question with new names or bigger numbers. Must be n/a for Level 1." },
  { id: "lesson_alignment", text: "It uses the lesson's terms and methods. When the brief says the lesson is missing or unreadable this MUST be not_verified — never pass." }
]);
const CHECK_IDS = Object.freeze(V2_CHECKS.map(c => c.id));
const STATUS_RULES = deepFreeze({
  pass: "every check is pass (or its allowed n/a; lesson_alignment not_verified only when the lesson is missing), exactly one option is correct and it is the one marked by answerIndex, and findings is an empty array",
  revise: "at least one check is fail and rewriting THIS question can fix it; every failing check has at least one finding with evidence, reason and suggestedFix",
  "needs-human": "you cannot confirm the math, the picture or the teaching point (use not_verified for what you could not check), or the problem is not fixable by rewriting the question; findings says why"
});
const FINDING_RULE = "Each finding: category = the check id it belongs to, field = the question field it concerns (for example \"options[2]\", \"tags[1]\", \"visual.nums\", \"explain\"; empty string if none), evidence = what you saw, reason = why it is a problem, suggestedFix = a concrete fix (may be empty only for needs-human).";
const RUBRIC = deepFreeze((() => {
  const r = { version: "qbank-review-v2/2", checks: V2_CHECKS, statuses: STATUS_RULES, findings: FINDING_RULE, options: "one entry per option in order: correct (boolean) and the reason from solving that option" };
  return Object.assign({}, r, { hash: sha256(canonicalJson(r)) });
})());

const TEXT_MAX = 500, FINDINGS_MAX = 12;
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* 某道题某项检查在状态不是 needs-human 时允许哪些结论 */
function allowedResults(checkId, q, brief) {
  switch (checkId) {
    case "tag_meaning": return Array.isArray(q.tags) ? ["pass", "fail"] : ["n/a"];
    case "visual_semantics": return q.visual ? ["pass", "fail"] : ["n/a"];
    case "level_increment": return q.level === 1 ? ["n/a"] : ["pass", "fail"];
    case "lesson_alignment": return brief.lesson.status === "present" ? ["pass", "fail"] : ["not_verified"];
    default: return ["pass", "fail"];
  }
}
/* 加上状态：needs-human 可以在本该 pass/fail 的检查上写 not_verified */
function resultAllowed(checkId, q, brief, status, result) {
  const base = allowedResults(checkId, q, brief);
  if (base.includes(result)) return true;
  return result === "not_verified" && status === "needs-human" && base.includes("pass");
}

/* ---------- 哈希 ---------- */
/* 发布对象的内容哈希：整道题（含 qid、选项顺序、tags、visual、任何字段），只去掉 usedAt（家庭做题状态） */
function contentHash(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) throw new TypeError("contentHash needs a question object");
  const c = Object.assign({}, q);
  delete c.usedAt;
  return sha256(canonicalJson(c));
}
/* 审稿引擎身份：provider + 模型 + 影响输出的设置（如 effort）。exact = 知道确切模型；不知道（CLI 用它自己的默认模型）就是 false，
 * 这种结论照样记录，但协调器不拿它当「同一个引擎审过」来复用。 */
function engineIdentity(e) {
  if (!e || typeof e.provider !== "string" || !e.provider.trim()) throw new TypeError("engine identity needs a provider");
  const model = typeof e.model === "string" && e.model.trim() ? e.model.trim() : null;
  const out = { provider: e.provider.trim(), model, exact: !!model && e.exact !== false };
  if (e.settings && typeof e.settings === "object") {
    const s = Object.fromEntries(Object.entries(e.settings).filter(([, v]) => typeof v === "string" && v).sort());
    if (Object.keys(s).length) out.settings = s;
  }
  return out;
}
/* reviewKey 的组成部分全部写进记录；复用时逐项比对，不只比 key */
function reviewKeyParts(brief, question, judgeEngine) {
  if (!isTeachingBrief(brief)) throw new TypeError("reviewKey needs a TeachingBrief");
  return {
    contentHash: contentHash(question),
    briefHash: brief.briefHash,
    lesson: { status: brief.lesson.status, sha256: brief.lesson.sha256 },
    rules: { version: brief.rules.version, hash: brief.rules.hash },
    rubric: { version: RUBRIC.version, hash: RUBRIC.hash },
    engine: engineIdentity(judgeEngine)
  };
}
const reviewKeyOf = parts => "rk1-" + sha256(canonicalJson(Object.assign({ kind: "yy-qbank-review-key" }, parts)));
function reviewKey(brief, question, judgeEngine) {
  const parts = reviewKeyParts(brief, question, judgeEngine);
  return { reviewKey: reviewKeyOf(parts), parts };
}
/* 题库当前内容的指纹（不含 usedAt，孩子做题不改它）：暂存时记下，发布时对不上说明题库在这期间变了 */
const bankFingerprint = questions => sha256(canonicalJson((questions || []).map(contentHash)));

/* ---------- 送审输入 ---------- */
const REVIEW_FIELDS = ["qid", "level", "question", "options", "answerIndex", "explain", "tags", "visual"];
/* 题目内容的白名单拷贝（送审、审稿记录、draft 都用它）：usedAt 等家庭 / 孩子状态和任何别的字段一律不带 */
function questionContent(q) {
  const o = {};
  if (q && typeof q === "object" && !Array.isArray(q)) for (const f of REVIEW_FIELDS) if (q[f] !== undefined) o[f] = JSON.parse(JSON.stringify(q[f]));
  return o;
}
/* candidates: [{ draftId, question }]。白名单拷贝：usedAt、孩子 / 家庭状态、内部标记一律不进提示词。
 * 一个 id 只能对应一道题：重复的 draftId 直接拒（一份结论不能认证两道题）。 */
function reviewInput(candidates) {
  const seen = new Set();
  return candidates.map(c => {
    if (!c || !DRAFT_ID_RE.test(String(c.draftId || ""))) throw new TypeError("review candidate needs a draftId");
    if (seen.has(c.draftId)) throw new TypeError("duplicate draftId in the review set: " + c.draftId);
    seen.add(c.draftId);
    return Object.assign({ id: c.draftId }, questionContent(c.question));
  });
}

/* ---------- 提示词 ---------- */
const S = (type, extra) => Object.assign({ type }, extra || {});
const REVIEW_SCHEMA = deepFreeze({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: S("string"),
          status: S("string", { enum: STATUSES.slice() }),
          options: S("array", { items: S("object", { properties: { correct: S("boolean"), reason: S("string") }, required: ["correct", "reason"] }) }),
          checks: S("object", {
            properties: Object.fromEntries(CHECK_IDS.map(id => [id, S("object", { properties: { result: S("string", { enum: RESULTS.slice() }), evidence: S("string") }, required: ["result", "evidence"] })])),
            required: CHECK_IDS.slice()
          }),
          findings: S("array", { items: S("object", {
            properties: { category: S("string", { enum: CHECK_IDS.slice() }), field: S("string"), evidence: S("string"), reason: S("string"), suggestedFix: S("string") },
            required: ["category", "field", "evidence", "reason", "suggestedFix"] }) })
        },
        required: ["id", "status", "options", "checks", "findings"]
      }
    }
  },
  required: ["items"]
});
const REVIEW_HINT = `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes), and escape every backslash as \\\\:
{"items":[{"id":"<copy the question's id exactly>","status":"pass|revise|needs-human","options":[{"correct":true|false,"reason":"what you got when you solved this option"}, ... one per option, in order],"checks":{${CHECK_IDS.map(id => `"${id}":{"result":"pass|fail|n/a|not_verified","evidence":"one short sentence: what you checked"}`).join(",")}},"findings":[{"category":"<check id>","field":"visual.nums","evidence":"...","reason":"...","suggestedFix":"..."}]}]}
One entry per question, every question exactly once, every check present with non-empty evidence, findings an empty array only when status is pass.`;

function reviewRequestLines(brief) {
  const senior = Number(brief.item.grade) >= 8;
  const L = [];
  L.push(`You are a strict ${senior ? "secondary-math" : "elementary-math"} reviewer. The multiple-choice questions below were generated for a ${senior ? "student" : "child"} from the teaching brief ${brief.briefId}. Review EVERY question on its own against the SAME brief.`);
  L.push("");
  L.push(renderJudgeBrief(brief));
  L.push("");
  L.push("For each question: first solve every option separately and record in \"options\" whether it is correct and why. Then answer every check with pass, fail, n/a or not_verified, with one sentence of evidence each:");
  for (const c of V2_CHECKS) L.push(`- ${c.id}: ${c.text}`);
  L.push("n/a is only allowed where a check says so. A missing picture or missing tags never make the general checks (answer, explanation, distractors, self-contained, skill/level) not applicable.");
  L.push("");
  L.push("Status of each question:");
  for (const s of STATUSES) L.push(`- ${s}: ${STATUS_RULES[s]}.`);
  L.push(FINDING_RULE);
  L.push("If you cannot confirm the math or the picture, do not guess pass or fail: mark that check not_verified and set status needs-human.");
  L.push("Automatic checks already enforced the picture contract, captions, field shapes and a few fixed phrases; they cannot judge meaning, math or alignment — that is your job.");
  if (brief.lesson.status !== "present") L.push(`The lesson is ${brief.lesson.status}: lesson_alignment must be not_verified for every question; never claim the questions match the lesson.`);
  L.push("Your verdict is a model review, not a human approval.");
  return L;
}
function buildReviewRequest(brief, items) {
  if (!isTeachingBrief(brief)) throw new TypeError("buildReviewRequest needs a TeachingBrief");
  const sys = [...reviewRequestLines(brief), "",
    "Questions under review (JSON; id identifies each question — copy it exactly; answerIndex marks the correct option; qid is the bank id; tags label each option in order; visual, when present, is the picture shown with the question, drawn by the conventions above):",
    JSON.stringify(items)].join("\n");
  return { sys, msg: "Review these questions.", schema: REVIEW_SCHEMA, hint: REVIEW_HINT };
}

/* 修复：只改这一道、同级、同技能；输出一道题的对象。qid 不许改（不写也行，由协调器补回原来的） */
function repairSchema(brief) {
  const props = {
    level: S("number"), question: S("string"), options: S("array", { items: S("string") }),
    answerIndex: S("number"), explain: S("string"), tags: S("array", { items: S("string") })
  };
  if (brief.visual.allowed.length) {
    props.visual = { type: "object", additionalProperties: false,
      properties: { type: S("string", { enum: brief.visual.allowed.slice() }), nums: S("array", { items: S("number") }), labels: S("array", { items: S("string") }), caption: S("string"), step: S("number") },
      required: ["type", "nums", "caption"] };
  }
  return { type: "object", properties: props, required: ["level", "question", "options", "answerIndex", "explain"] };
}
function buildRepairRequest(brief, item, verdict) {
  if (!isTeachingBrief(brief)) throw new TypeError("buildRepairRequest needs a TeachingBrief");
  const failing = Object.entries((verdict && verdict.checks) || {}).filter(([, c]) => c.result === "fail").map(([id, c]) => `- ${id}: ${c.evidence}`);
  const findings = ((verdict && verdict.findings) || []).map(f => `- [${f.category}${f.field ? " " + f.field : ""}] ${f.evidence} — ${f.reason}${f.suggestedFix ? " Fix: " + f.suggestedFix : ""}`);
  const sys = [
    "You are fixing ONE multiple-choice question in a question bank. Keep it on the same skill and at the SAME level; change only what the review says is wrong.",
    "",
    renderGeneratorBrief(brief),
    "",
    "Failing checks:",
    ...(failing.length ? failing : ["- (none given)"]),
    "Review findings:",
    ...(findings.length ? findings : ["- (none given)"]),
    "",
    `Keep "level": ${item.level}. Do not add or change "qid". Exactly 4 options, exactly 1 correct; tags (when the question has them) stay aligned with the options, "ok" on the correct one.`,
    "Question to fix (JSON):",
    JSON.stringify(Object.fromEntries(REVIEW_FIELDS.filter(f => f !== "qid" && item[f] !== undefined).map(f => [f, item[f]])))
  ].join("\n");
  return { sys, msg: "Rewrite this one question.", schema: repairSchema(brief), hint: "\n\n[Output format] Output ONE JSON object — the fixed question with level, question, options, answerIndex, explain (and tags / visual when used). No other text." };
}

/* ---------- 严格解析 ---------- */
const err = (code, message, id) => (id === undefined ? { code, message } : { code, id, message });
const nonEmpty = v => typeof v === "string" && v.trim().length > 0;
const text = v => v.trim().slice(0, TEXT_MAX);

function parseOptions(e, q, bad) {
  if (!Array.isArray(e.options) || e.options.length !== 4) { bad.push(err("options_missing", "options must be 4 entries, one per option", e.id)); return null; }
  const out = [];
  for (const [i, o] of e.options.entries()) {
    if (!o || typeof o !== "object" || typeof o.correct !== "boolean" || !nonEmpty(o.reason)) { bad.push(err("options_invalid", `options[${i}] needs correct (boolean) and a reason`, e.id)); return null; }
    out.push({ correct: o.correct, reason: text(o.reason) });
  }
  return out;
}
function parseFindings(e, bad) {
  if (!Array.isArray(e.findings)) { bad.push(err("findings_missing", "findings must be an array (empty only for pass)", e.id)); return null; }
  if (e.findings.length > FINDINGS_MAX) { bad.push(err("findings_invalid", `more than ${FINDINGS_MAX} findings`, e.id)); return null; }
  const out = [];
  for (const [i, f] of e.findings.entries()) {
    if (!f || typeof f !== "object" || Array.isArray(f)) { bad.push(err("findings_invalid", `findings[${i}] is not an object`, e.id)); return null; }
    if (!CHECK_IDS.includes(f.category)) { bad.push(err("findings_invalid", `findings[${i}].category ${JSON.stringify(f.category)} is not a check id`, e.id)); return null; }
    if (typeof f.field !== "string" || !nonEmpty(f.evidence) || !nonEmpty(f.reason) || typeof f.suggestedFix !== "string") {
      bad.push(err("findings_invalid", `findings[${i}] needs field, evidence, reason and suggestedFix`, e.id)); return null;
    }
    out.push({ category: f.category, field: f.field.trim().slice(0, 80), evidence: text(f.evidence), reason: text(f.reason), suggestedFix: f.suggestedFix.trim().slice(0, TEXT_MAX) });
  }
  return out;
}

/* items: 送审的那组 reviewInput（带唯一 id）。
 * 返回 { ok, errors, verdicts: Map(id → { status, options, checks, findings } | { invalid: [errors] }) }。
 * 输入里 id 重复 / 响应不是对象 / 没有 items / 未知 id / 重复 id / 缺 id → 整个响应作废，verdicts 为空；
 * 单题内容错（状态、逐项解题、检查项、证据、发现、状态与结论不相容）→ 只这一题作废。任何错误 ok 都是 false。 */
function parseReviewV2(raw, items, brief) {
  if (!isTeachingBrief(brief)) throw new TypeError("parseReviewV2 needs the TeachingBrief used for the review");
  const errors = [], verdicts = new Map();
  const byId = new Map();
  for (const q of items) {
    if (byId.has(q.id)) return { ok: false, errors: [err("input_id_duplicate", `the review set has id ${q.id} more than once`)], verdicts };
    byId.set(q.id, q);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [err("not_object", "response is not a JSON object")], verdicts };
  if (!Array.isArray(raw.items)) return { ok: false, errors: [err("no_items", "response has no items array")], verdicts };
  const seen = new Set();
  for (const [i, e] of raw.items.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) { errors.push(err("item_not_object", `items[${i}] is not an object`)); continue; }
    const id = typeof e.id === "string" ? e.id : null;
    if (!id || !byId.has(id)) { errors.push(err("id_unknown", `items[${i}].id ${JSON.stringify(e.id)} is not a question under review`)); continue; }
    if (seen.has(id)) { errors.push(err("id_duplicate", `id ${id} answered more than once`, id)); continue; }
    seen.add(id);
  }
  for (const id of byId.keys()) if (!seen.has(id)) errors.push(err("id_missing", `no verdict for ${id}`, id));
  if (errors.length) return { ok: false, errors, verdicts };

  for (const e of raw.items) {
    const q = byId.get(e.id), bad = [];
    const statusOk = STATUSES.includes(e.status);
    if (!statusOk) bad.push(err("status_invalid", `status ${JSON.stringify(e.status)} is not one of ${STATUSES.join("/")}`, e.id));
    const options = parseOptions(e, q, bad);
    const checks = {};
    if (!e.checks || typeof e.checks !== "object" || Array.isArray(e.checks)) bad.push(err("checks_missing", "checks object missing", e.id));
    else {
      for (const k of Object.keys(e.checks)) if (!CHECK_IDS.includes(k)) bad.push(err("check_unknown", `unknown check ${JSON.stringify(k)}`, e.id));
      for (const k of CHECK_IDS) {
        const c = e.checks[k];
        if (!c || typeof c !== "object" || Array.isArray(c)) { bad.push(err("check_missing", `check ${k} missing`, e.id)); continue; }
        if (!RESULTS.includes(c.result)) { bad.push(err("check_result_invalid", `${k}.result ${JSON.stringify(c.result)} is not one of ${RESULTS.join("/")}`, e.id)); continue; }
        if (statusOk && !resultAllowed(k, q, brief, e.status, c.result)) {
          bad.push(err("check_result_not_allowed", `${k}.result ${c.result} is not allowed here (allowed: ${allowedResults(k, q, brief).join("/")}${allowedResults(k, q, brief).includes("pass") ? "; not_verified only with needs-human" : ""})`, e.id)); continue;
        }
        if (!nonEmpty(c.evidence)) { bad.push(err("evidence_missing", `${k} has no evidence`, e.id)); continue; }
        checks[k] = { result: c.result, evidence: text(c.evidence) };
      }
    }
    const findings = parseFindings(e, bad);
    if (!bad.length) {
      const fails = CHECK_IDS.filter(k => checks[k].result === "fail");
      const marked = options.map((o, i) => (o.correct ? i : -1)).filter(i => i >= 0);
      const solvedMatches = marked.length === 1 && marked[0] === q.answerIndex;
      if (checks.answer_unique.result === "pass" && !solvedMatches)
        bad.push(err("status_incompatible", `answer_unique pass but the per-option solving found ${marked.length} correct option(s) (${marked.join(",") || "none"}), answerIndex ${q.answerIndex}`, e.id));
      if (e.status === "pass" && fails.length) bad.push(err("status_incompatible", `status pass but ${fails.join(", ")} failed`, e.id));
      if (e.status === "pass" && findings.length) bad.push(err("status_incompatible", "status pass but findings is not empty", e.id));
      if (e.status === "revise" && !fails.length) bad.push(err("status_incompatible", "status revise but no check failed", e.id));
      if (e.status === "revise") {
        const uncovered = fails.filter(k => !findings.some(f => f.category === k && nonEmpty(f.suggestedFix)));
        if (uncovered.length) bad.push(err("findings_missing", `failing check(s) ${uncovered.join(", ")} have no finding with a suggestedFix`, e.id));
      }
      if (e.status === "needs-human" && !findings.length) bad.push(err("findings_missing", "needs-human needs at least one finding saying why", e.id));
    }
    if (bad.length) { errors.push(...bad); verdicts.set(e.id, { invalid: bad }); }
    else verdicts.set(e.id, { status: e.status, options, checks, findings });
  }
  return { ok: errors.length === 0, errors, verdicts };
}

/* 已存的 pass 记录能不能直接当结论用：用同一个解析器把存下的结论对着这道题重新验一遍，必须是完整、自洽的 pass
 * （防手改、防旧版本的记录格式）。组成部分的逐项比对在协调器。 */
function storedPassIsValid(rec, item, brief) {
  if (!rec || rec.status !== "pass") return false;
  const p = parseReviewV2({ items: [{ id: item.id, status: rec.status, options: rec.options, checks: rec.checks, findings: rec.findings }] }, [item], brief);
  return p.ok && p.verdicts.get(item.id).status === "pass";
}

/* ---------- v1 兼容适配器（显式） ----------
 * 把一次合格的 v2 响应折成旧的 { pass, problems, bad }（bad = 非 pass 题在 items 里的下标）。
 * 响应不合格（任何解析错误）→ 抛错：v2 的格式问题绝不折成 v1 的「通过」。 */
function toV1Verdict(parsed, items) {
  if (!parsed || !parsed.ok) {
    const first = parsed && parsed.errors && parsed.errors[0];
    const e = new Error("v2 review response invalid" + (first ? ": " + first.code + " — " + first.message : ""));
    e.errors = parsed ? parsed.errors : [];
    throw e;
  }
  const bad = [], problems = [];
  items.forEach((q, i) => {
    const v = parsed.verdicts.get(q.id);
    if (v.status !== "pass") {
      bad.push(i);
      for (const f of v.findings) problems.push(`[${q.id}] ${f.category}${f.field ? " " + f.field : ""}: ${f.reason}`);
    }
  });
  return { pass: bad.length === 0, problems: problems.slice(0, 10), bad };
}

module.exports = {
  V2_CHECKS, CHECK_IDS, STATUSES, RESULTS, RUBRIC, REVIEW_SCHEMA, REVIEW_HINT, DRAFT_ID_RE,
  allowedResults, resultAllowed, contentHash, engineIdentity, reviewKey, reviewKeyParts, reviewKeyOf, bankFingerprint,
  REVIEW_FIELDS, questionContent, reviewInput, buildReviewRequest, buildRepairRequest, repairSchema, parseReviewV2, storedPassIsValid, toV1Verdict
};
