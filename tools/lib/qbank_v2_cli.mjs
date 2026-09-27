/*
 * pregen / audit_qbank / export_apple 的 `--review v2` 接线（#45，#8 子任务 C）。
 * 只做命令行这一层：参数、选条目、选引擎、按条目串起 #44 的 qbankReviewV2（续跑 → 审已有题 → 出新题），以及 v2 导出资格。
 * 审稿规则、复用、存储、发布全部在 lib/ai/qbank（runReviewV2 / evidence）和 server.js 的 v2 接缝里，这里不另写一套；
 * 「现在算不算审过」只有一个口径：lib/ai/qbank/evidence.js 的 currentEvidence（pregen / audit 判断要不要审、导出判断能不能带）。
 *
 * 语法检查（parseCli）在 require server.js 之前跑：参数写错不加载题库、不探测引擎、不调模型、不动输出目录。
 */
import fs from "node:fs";
import path from "node:path";

/* ---------------- 参数 ---------------- */
/* spec：{ 名字: "value" | "flag" | "optional" }（optional = 可带值也可不带，比如 --judge） */
export const SPECS = {
  pregen: { review: "value", skill: "value", langs: "value", only: "value", provider: "value", judge: "optional", concurrency: "value", dry: "flag", "review-timeout": "value" },
  audit: { review: "value", skill: "value", judge: "optional", concurrency: "value", dry: "flag", "review-timeout": "value" },
  export: { review: "value", skill: "value", judge: "optional", out: "value", "no-voice": "flag", dry: "flag" }
};
/* 老命令行里有、但和 v2「显式选条目」冲突的开关：给了就报错，不悄悄忽略 */
const V2_CONFLICTS = {
  pregen: { grades: "按年级选", books: "书籍课程", "no-skills": "技能开关", skills: "技能开关", core: "核心技能子集", pilot: "试点技能子集", limit: "只做前 N 个", force: "已生成的也重做", "unit-count": "单元卷题数" },
  audit: { prefix: "按前缀选题库", limit: "只审前 N 份", provider: "出题引擎（audit 不出题；修复用审稿引擎）" },
  export: {}
};
const NEW_OPTIONS = ["review", "skill", "review-timeout"];   // #45 新加的开关：老解析器不认识，写错了必须当场报错
const CONCURRENCY_MAX = { pregen: 8, audit: 6 };

function tokenize(argv) {
  const flags = [], strays = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith("--")) { strays.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith("--")) { flags.push({ name, value: String(next) }); i++; }
    else flags.push({ name, value: null });
  }
  return { flags, strays };
}
const ID_RE = /^[A-Za-z0-9._-]+$/;
const ENGINE_RE = /^[A-Za-z0-9_-]+$/;
function parseSkillList(raw, errors) {
  if (!raw) { errors.push("--skill 需要一个值"); return []; }
  const ids = raw.split(",").map(s => s.trim());
  if (ids.some(s => !s)) errors.push("--skill 里有空的条目 id（多了逗号？）");
  for (const s of ids.filter(Boolean)) if (!ID_RE.test(s)) errors.push(`--skill：「${s}」不是条目 id 的样子`);
  const dup = ids.filter((s, i) => s && ids.indexOf(s) !== i);
  if (dup.length) errors.push("--skill 里重复了：" + [...new Set(dup)].join(", "));
  return ids.filter(Boolean);
}

/* script: "pregen" | "audit" | "export"。返回 { review: null|"v1"|"v2", v2: {...} | null, errors: [] } */
export function parseCli(argv, script) {
  const { flags, strays } = tokenize(argv);
  const errors = [];
  const byName = new Map();
  for (const f of flags) { if (!byName.has(f.name)) byName.set(f.name, []); byName.get(f.name).push(f); }
  const one = n => (byName.get(n) || [])[0];
  /* --review=v2 / --skill=… 这种写法老解析器完全不认：不拦的话会带着默认值跑全部。新开关只收空格分隔的写法 */
  for (const f of flags) {
    const eq = f.name.indexOf("=");
    if (eq > 0 && NEW_OPTIONS.includes(f.name.slice(0, eq))) errors.push(`--${f.name}：请写成「--${f.name.slice(0, eq)} ${f.name.slice(eq + 1)}」（空格分隔；等号写法不认）`);
  }
  for (const n of NEW_OPTIONS) if ((byName.get(n) || []).length > 1) errors.push(`--${n} 只能给一次`);
  const rv = one("review");
  let review = null;
  if (rv) {
    const allowed = script === "export" ? ["v2"] : ["v1", "v2"];
    if (!rv.value) errors.push(`--review 要跟模式：${allowed.join(" / ")}（例：--review v2）`);
    else if (!allowed.includes(rv.value)) errors.push(`--review ${rv.value}：不认识的审稿模式（可选：${allowed.join(" / ")}）`);
    else review = rv.value;
  }
  /* 老的 --skills 是开关（默认就做技能），裸用照旧。后面跟了条目 id 的话，老解析会把 id 扔掉、照样跑全部——当场拦下 */
  const sk = one("skills");
  if (sk && sk.value) errors.push(`--skills 是老的开关、不接条目 id（「${sk.value}」会被忽略、结果跑全部）。选条目请用 --skill <id>[,<id>…]，并加 --review v2`);
  if (errors.length) return { review: null, v2: null, errors };
  if (review !== "v2") {
    if (byName.has("review-timeout")) errors.push("--review-timeout 只和 --review v2 一起用");
    if (!byName.has("skill")) return { review, v1: null, v2: null, errors };
    /* pregen 的老流程也能只做点名条目：--review v1 --skill …（试点对照组要和 v2 同一批技能、同样的量）。不写 --review 仍然不认 --skill */
    if (review !== "v1" || script !== "pregen") { errors.push("--skill 只和 --review v2 一起用（pregen 的老流程要点名条目：--review v1 --skill …）"); return { review: null, v1: null, v2: null, errors }; }
    for (const n of ["grades", "books", "no-skills", "skills", "core", "pilot", "limit"]) if (byName.has(n)) errors.push(`--${n}（${V2_CONFLICTS.pregen[n]}）不能和 --skill 一起用：--skill 只做点名的条目`);
    /* 点名条目时 --only / --langs 写错不能悄悄变成「0 个任务、退出 0」（老解析器会把不认识的值当成什么都不做） */
    const only = one("only"), langs = one("langs");
    if (only && !["all", "lessons", "quiz"].includes(only.value)) errors.push(`--only ${only.value || ""}：点名条目时只能是 all / lessons / quiz（--skill 不做单元卷）`);
    if (langs) {
      const ls = String(langs.value || "").split(",").map(x => x.trim());
      if (!langs.value || ls.some(x => x !== "zh" && x !== "en")) errors.push(`--langs ${langs.value || ""}：只能是 zh / en（逗号分隔）`);
    }
    const skills = parseSkillList(one("skill").value, errors);
    return errors.length ? { review: null, v1: null, v2: null, errors } : { review, v1: { skills }, v2: null, errors };
  }

  /* ---- v2：白名单 ---- */
  const spec = SPECS[script];
  for (const [n, list] of byName) {
    if (list.length > 1 && !NEW_OPTIONS.includes(n)) errors.push(`--${n} 只能给一次`);
    if (V2_CONFLICTS[script][n] !== undefined) { errors.push(`--${n}（${V2_CONFLICTS[script][n]}）不能和 --review v2 一起用：v2 只做 --skill 点名的条目`); continue; }
    const kind = spec[n];
    if (!kind) { errors.push(`--review v2 不认识 --${n}`); continue; }
    if (kind === "flag" && list[0].value !== null) errors.push(`--${n} 不带值（多出来的「${list[0].value}」）`);
    if (kind === "value" && !list[0].value) errors.push(`--${n} 需要一个值`);
    if (kind === "optional" && list[0].value === "") errors.push(`--${n} 的值是空的`);
  }
  for (const s of strays) errors.push(`多出来的参数「${s}」`);
  const val = n => { const f = one(n); return f ? f.value : null; };
  const v2 = { skills: [], dry: byName.has("dry") };
  if (!byName.has("skill")) errors.push("--review v2 必须用 --skill <条目id>[,<条目id>…] 点名要做的条目（不会默认跑整套大纲）");
  else if (val("skill")) v2.skills = parseSkillList(val("skill"), errors);
  if (script === "pregen") {
    const langs = val("langs");
    if (byName.has("langs") && langs !== null && langs.split(",").map(s => s.trim()).join(",") !== "en")
      errors.push(`--langs ${langs}：v2 只做英文（--langs en 或不写）；中文题库仍走老路径（不带 --review v2）`);
    const only = val("only");
    if (byName.has("only") && only !== null && only !== "quiz") errors.push(`--only ${only}：v2 只审闯关题库（--only quiz 或不写）；课和单元卷仍走老路径`);
    const pv = val("provider");
    if (pv && !ENGINE_RE.test(pv)) errors.push(`--provider：「${pv}」不是引擎名`);
    v2.provider = pv;
  }
  const j = one("judge");
  if (j && j.value && !ENGINE_RE.test(j.value)) errors.push(`--judge：「${j.value}」不是引擎名`);
  v2.judge = j ? j.value : null;
  if (script === "pregen" || script === "audit") {
    const c = val("concurrency");
    v2.concurrency = 2;
    if (c !== null) {
      if (!/^\d+$/.test(c) || Number(c) < 1 || Number(c) > CONCURRENCY_MAX[script]) errors.push(`--concurrency ${c}：要 1-${CONCURRENCY_MAX[script]} 的整数`);
      else v2.concurrency = Number(c);
    }
    const t = val("review-timeout");
    v2.timeoutMs = undefined;
    if (t !== null) {
      if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 600) errors.push(`--review-timeout ${t}：每次审稿 / 修复调用的秒数，1-600`);
      else v2.timeoutMs = Number(t) * 1000;
    }
  }
  if (script === "export") { v2.out = val("out"); v2.noVoice = byName.has("no-voice"); }
  return { review: errors.length ? null : review, v2: errors.length ? null : v2, errors };
}

/* 正常情况下事件循环空了进程自己退（输出不截断）；超时后还挂着的引擎调用（适配器不认 signal）不能把命令行拖住：几秒后强退 */
export function exitWhenDone(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

export function failArgs(errors, usage) {
  for (const e of errors) console.error("错误：" + e);
  if (usage) console.error(usage);
}

/* ---------------- 选条目 ---------------- */
/* 条目 id 必须原样存在。技能在别的年级主题里当复习题会再出现一次（reviewFrom>0），v2 只认它自己年级的那份视图
 * （brief 的年级 / 主题跟着视图走）；非技能条目只有一份。找不到 / 对不上唯一一份都报错。 */
export function resolveSelection(S, ids) {
  const selected = [], errors = [];
  for (const id of ids) {
    const all = [];
    for (const d of S.curriculum.values()) for (const it of (d.items || [])) if (it.id === id) all.push({ item: it, data: d });
    const home = all.filter(m => !(m.item.skill && m.item.skill.reviewFrom));
    if (!all.length) errors.push(`--skill ${id}：大纲 / 技能图谱里没有这个条目 id（要原样写，区分大小写）`);
    else if (home.length !== 1) errors.push(`--skill ${id}：找到 ${home.length} 份非复习视图，没法确定用哪一份`);
    else selected.push({ id, item: home[0].item, data: home[0].data, key: S.qbankKey(id, "en") });
  }
  return { selected, errors };
}

/* ---------------- 选引擎 ---------------- */
/* 显式的要求必须兑现：命令行点名 > config.providerByTask[task] > config.provider；最先出现的那个不可用就报错，
 * 不像老的 pickProvider 那样悄悄往后落。什么都没指定才按自动顺序挑。 */
function explicitWant(S, requested, task, label) {
  const cfg = S.cfg || {};
  const wants = [
    [requested && requested !== "auto" ? requested : null, "命令行 " + label],
    [(cfg.providerByTask && cfg.providerByTask[task]) || null, `config.providerByTask["${task}"]`],
    [cfg.provider && cfg.provider !== "auto" ? cfg.provider : null, "config.provider"]
  ];
  return wants.find(w => w[0]) || null;
}
const knownEngines = S => Object.keys(S.PROVIDER_META || {}).join(" / ");
export function strictEngine(S, requested, task, label) {
  const first = explicitWant(S, requested, task, label);
  if (first) {
    if (S.detected[first[0]] && S.detected[first[0]].available) return { id: first[0], via: first[1] };
    const known = (S.PROVIDER_META || {})[first[0]] || (S.ADAPTERS || {})[first[0]];
    return { error: `${first[1]} 指定了 ${first[0]}：${known ? "这台机器上没检测到它" : "不是已知引擎（可选：" + knownEngines(S) + "）"}。v2 不会悄悄换别的引擎。` };
  }
  const id = S.pickProvider(null, task);
  return id ? { id, via: "自动挑选" } : { error: "没有可用的引擎（" + label + "）。" };
}
/* 注入的引擎（测试替身等）在探测结果里声明模型；内置 7 个引擎的身份由 server 按实际配置算，这个声明对它们无效 */
const declaredModel = (S, id) => (S.detected && S.detected[id] && S.detected[id].model) || undefined;
const engineText = e => e.provider + (e.model ? " / " + e.model : " / 模型未知") + (e.settings && e.settings.effort ? " (effort " + e.settings.effort + ")" : "");
const judgeIdentity = (S, sel, id) => S.qbankReviewDepsV2(sel.item, sel.data, { judgeProvider: id, judgeModel: declaredModel(S, id) }).engine.judge;

/* ---------------- 每个条目：续跑 → 审已有题 → 出新题 ---------------- */
/* 能自动接着做的 draft：审过 pass 但没发出去的、审稿出错 / 超时 / 取消的、审稿期间题库被改了的。
 * needs_human / exhausted / hard_failed / hard_rejected / staging_dropped 等人工处理，不自动重送（不重复花钱，也不会被发布）。
 * superseded = 续跑时协调器因为题库里的目标版本已经变了（或 qid 撞了）而拒收的 draft：内容留着给人看，不再自动续跑。 */
export const RESUMABLE = new Set(["passed", "error", "timeout", "cancelled", "stale", "pending"]);
const HUMAN_STATES = new Set(["needs_human", "exhausted", "hard_failed", "hard_rejected", "staging_dropped"]);
const errText = e => String((e && e.message) || e).slice(0, 300);

function tallyRun(label, r, store) {
  const t = { label, runId: r.runId, status: r.status, states: {}, added: 0, replaced: 0, unchanged: 0, reused: 0,
    held: (r.held || []).length, identityRejected: (r.identityRejected || []).length, stagingDropped: (r.stagingDropped || []).length,
    report: path.join(store.dir, r.dry ? "dry" : "", "reports", r.runId + ".json") };
  for (const it of r.items || []) {
    t.states[it.state] = (t.states[it.state] || 0) + 1;
    if (it.cached) t.reused++;
    if (it.publication === "added") t.added++;
    if (it.publication === "replaced") t.replaced++;
    if (it.publication === "unchanged") t.unchanged++;
  }
  return t;
}

export async function runItemV2(S, QB, sel, ctx) {
  const { item, data, id, key } = sel;
  const res = { id, key, runs: [], faults: [], retry: 0, human: 0, generated: false, certified: { 1: 0, 2: 0, 3: 0 }, levels: { 1: 0, 2: 0, 3: 0 },
    uncertified: 0, heldExisting: 0, noQid: 0, heldDrafts: 0, superseded: 0, complete: false, plan: null };
  const brief = S.qbankBriefFor(item, data);
  res.briefId = brief.briefId; res.lesson = brief.lesson.status;
  const store = S.qbankReviewStore();
  const eng = { judgeProvider: ctx.judge, repairProvider: ctx.judge, judgeModel: declaredModel(S, ctx.judge), repairModel: declaredModel(S, ctx.judge), judgeTask: ctx.judgeTask };
  const judgeId = S.qbankReviewDepsV2(item, data, eng).engine.judge;
  const reviewedThisRun = new Set();   // 本次拿到有效模型结论的版本（审稿模型不确定时，只认这些）
  const run = async (label, input) => {
    let r;
    try { r = await S.qbankReviewV2(item, data, Object.assign({ brief }, eng, input, { opts: { dry: ctx.dry, timeoutMs: ctx.timeoutMs } })); }
    catch (e) { res.faults.push(label + " 出错：" + errText(e)); return null; }
    const t = tallyRun(label, r, store);
    res.runs.push(t);
    if (r.status === "storage_failed") res.faults.push(label + "：审稿记录 / draft / 报告写盘失败，什么都没发布 — " + r.storageError);
    if (r.status === "publish_failed") res.faults.push(label + "：发布失败，题库没改 — " + (r.publishError || "unknown"));
    for (const e of r.finalizeErrors || []) res.faults.push(label + "：发布后收尾写入失败（题库已改，旁路记录没跟上） — " + e);
    for (const it of r.items || []) {
      if (!ctx.dry && it.checks && it.reviewKey) reviewedThisRun.add(it.reviewKey);
      if (["error", "timeout", "cancelled", "stale"].includes(it.state)) res.retry++;
      if (HUMAN_STATES.has(it.state)) res.human++;
    }
    res.human += t.held;
    return r;
  };
  /* 题库里每道题此刻的证据：唯一口径 QB.currentEvidence（当前审稿引擎身份的精确记录 + 任何引擎更新的不过）。
   * 记录读不动 = 故障（可能正好漏掉一条更新的「不过」），照常往下做但退出码是 1。 */
  const classify = () => {
    const base = S.qbankBaseV2(key);
    if (!base.questions.length) return [];
    let listed = { records: [], errors: [] };
    try { listed = store.listRecords({ dry: false }); } catch (e) { listed = { records: [], errors: [{ file: "records/", message: errText(e) }] }; }
    for (const e of listed.errors) { const msg = "审稿记录读不动：" + e.file + " — " + e.message; if (!res.faults.includes(msg)) res.faults.push(msg); }
    const byKey = new Map(listed.records.map(r => [r.reviewKey, r]));
    return base.questions.map(q => {
      if (!q.qid) return { q, cls: "no_qid" };
      const ev = QB.currentEvidence({ brief, question: q, judge: judgeId, records: listed.records, byKey, reviewedThisRun });
      return { q, cls: ev.state === "certified" ? "certified" : ev.state === "held" ? "held" : "unverified", ev };
    });
  };
  const count = list => {
    res.certified = { 1: 0, 2: 0, 3: 0 }; res.levels = { 1: 0, 2: 0, 3: 0 };
    res.uncertified = 0; res.heldExisting = 0; res.noQid = 0;
    for (const x of list) {
      res.levels[x.q.level] = (res.levels[x.q.level] || 0) + 1;
      if (x.cls === "certified") res.certified[x.q.level] = (res.certified[x.q.level] || 0) + 1;
      else if (x.cls === "held") res.heldExisting++;
      else if (x.cls === "no_qid") res.noQid++;
      else res.uncertified++;
    }
  };
  const needsOf = () => {
    const needs = {};
    for (const lv of [1, 2, 3]) if ((res.certified[lv] || 0) < S.QUIZ_SESSION_PER_LEVEL && (res.levels[lv] || 0) < S.QUIZ_LEVEL_CAP) needs[lv] = S.QUIZ_PER_LEVEL_NEW;
    return needs;
  };

  /* 1. 续跑（正式运行才做；dry 不碰正式 draft） */
  let drafts = [];
  try { drafts = store.listDrafts({ dry: false, bankKey: key }).filter(d => d && d.itemId === id && d.dry === false); }
  catch (e) { res.faults.push("读 draft 失败：" + errText(e)); }
  const resumable = drafts.filter(d => d.published !== true && d.state !== "published" && RESUMABLE.has(d.state));
  res.heldDrafts = drafts.filter(d => d.published !== true && HUMAN_STATES.has(d.state)).length;
  res.superseded = drafts.filter(d => d.state === "superseded").length;

  if (ctx.plan) {
    const now = classify();
    count(now);
    res.plan = { resume: resumable.length, audit: now.filter(x => x.cls === "unverified").length, needsNow: ctx.generate ? needsOf() : null };
    return res;
  }
  /* 续跑真正接手的 qid（协调器拿去审 / 发布了的）这一轮不再审一遍；被协调器拒收的 draft（它要替换的版本变了、qid 撞了……）
   * 不遮挡题库里的现行版本——下面照常按证据审现行版本，旧 draft 标成 superseded 不再自动续跑（内容留着给人看）。 */
  const handled = new Set();
  if (!ctx.dry && resumable.length) {
    const r = await run("续跑", { resume: resumable });
    if (r) {
      for (const it of r.items || []) handled.add(it.qid);
      const refused = new Map();
      for (const x of r.stagingDropped || []) if (x && x.draftId) refused.set(x.draftId, x.reason);
      for (const x of r.identityRejected || []) if (x && x.draftId) refused.set(x.draftId, x.reason);
      for (const d of resumable.filter(d => refused.has(d.draftId))) {
        try {
          store.writeDraft(Object.assign({}, d, { state: "superseded", supersededAt: new Date().toISOString(), supersededReason: refused.get(d.draftId), supersededFrom: d.state }), { dry: false });
          res.superseded++;
        } catch (e) { res.faults.push("标记过时 draft 失败：" + d.draftId + " — " + errText(e)); }
      }
    }
  }
  const toAudit = classify().filter(x => x.cls === "unverified" && !handled.has(x.q.qid)).map(x => x.q.qid);
  if (toAudit.length) await run("审已有题", { audit: toAudit });

  /* 2. 出新题：通过数不足的级别补一批（一次运行一批；出题引擎失败重试一次） */
  if (ctx.generate && !ctx.dry) {
    count(classify());
    const needs = needsOf();
    if (Object.keys(needs).length) {
      let raw = null, err = null;
      for (let i = 0; i < 2 && !raw; i++) {
        try { raw = await S.qbankGenerateV2(item, data, ctx.gen, { brief, needs, task: "pregen:quiz" }); }
        catch (e) { err = e; }
      }
      if (raw) { res.generated = true; await run("出新题", { raw }); }
      else { res.retry++; res.genError = errText(err); }
    }
  }
  count(classify());
  res.complete = ctx.generate
    ? [1, 2, 3].every(lv => (res.certified[lv] || 0) >= S.QUIZ_SESSION_PER_LEVEL)
    : (res.levels[1] + res.levels[2] + res.levels[3]) > 0 && res.uncertified === 0 && res.heldExisting === 0 && res.noQid === 0;
  return res;
}

async function pool(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; await worker(items[i], i); }
  }));
}

function printItem(r, dry) {
  const lv = [1, 2, 3].map(l => `L${l} ${r.certified[l] || 0}/${r.levels[l] || 0}`).join("  ");
  console.log(`[v2] ${r.id}   brief ${r.briefId}   课文 ${r.lesson}`);
  if (r.plan) {
    console.log(`     计划：续跑 draft ${r.plan.resume} 条   审已有题 ${r.plan.audit} 道` + (r.plan.needsNow ? `   现在就缺：${Object.keys(r.plan.needsNow).map(l => "L" + l).join("、") || "无"}（审完已有题后可能更少）` : ""));
  }
  for (const t of r.runs) {
    const s = Object.entries(t.states).map(([k, v]) => k + " " + v).join("  ") || "无题";
    console.log(`     ${t.label}：${t.status}   ${s}   新增 ${t.added}  替换 ${t.replaced}  未改仍有效 ${t.unchanged}  复用记录 ${t.reused}`
      + (t.held ? `  硬校验 / 暂存扣下 ${t.held}` : "") + (t.identityRejected ? `  身份冲突 ${t.identityRejected}` : "") + (t.stagingDropped ? `  暂存丢弃 ${t.stagingDropped}` : ""));
    console.log(`       报告 ${t.report}`);
  }
  if (r.genError) console.log("     出题失败（重试一次仍失败）：" + r.genError);
  console.log(`     题库 ${r.key}：当前审过（L 通过 / 总数）${lv}` + (r.uncertified ? `   没有当前证据 ${r.uncertified}` : "") + (r.heldExisting ? `   当前版本审稿不过、等人工 ${r.heldExisting}` : "")
    + (r.noQid ? `   没有 qid ${r.noQid}` : "") + (r.heldDrafts ? `   等人工的 draft ${r.heldDrafts}` : "") + (r.superseded ? `   过时 draft ${r.superseded}` : "")
    + (dry || r.plan ? "" : r.complete ? "   ✓ 齐了" : "   ✗ 没齐"));
  for (const f of r.faults) console.log("     故障：" + f);
}

/* 汇总 + 退出码：1 = 有故障（写盘 / 发布 / 收尾 / 读旁路失败，或意外异常），2 = 没故障但没做完（题库不齐 / 已有题没有当前通过证据，或有调用要重试），0 = 全齐。
 * 被扣下等人工的候选题只报数：题库齐了就不算没做完（它们本来就不会发布）。
 * dry 只免掉「没发布 / 不齐」：dry 里的超时、出错、畸形结论照样是 2，读写故障照样是 1。plan（pregen --dry）只看故障。 */
function finish(results, mode) {
  const tot = { faults: 0, retry: 0, human: 0, complete: 0, added: 0, replaced: 0, unchanged: 0 };
  for (const r of results) {
    tot.faults += r.faults.length; tot.retry += r.retry; tot.human += r.human; if (r.complete) tot.complete++;
    for (const t of r.runs) { tot.added += t.added; tot.replaced += t.replaced; tot.unchanged += t.unchanged; }
  }
  console.log("");
  if (mode === "plan") {
    console.log("[dry] 只列计划：没调模型、没写任何文件。" + (tot.faults ? "   但有故障 " + tot.faults + " 条（计划可能不全）" : ""));
    const code = tot.faults ? 1 : 0;
    if (code) console.log("结果：有故障（退出码 1）——旁路读不动，上面的计划不可信。");
    return code;
  }
  const dry = mode === "dry";
  console.log(`v2 合计：条目 ${results.length}（齐 ${tot.complete}）   新增 ${tot.added}  替换 ${tot.replaced}  未改仍有效 ${tot.unchanged}   要重试 ${tot.retry}   要人工 ${tot.human}   故障 ${tot.faults}` + (dry ? "   [dry：没有发布，dry 记录不算正式通过]" : ""));
  const code = tot.faults ? 1 : tot.retry ? 2 : dry ? 0 : tot.complete < results.length ? 2 : 0;
  console.log(code === 0 ? (dry ? "结果：dry 跑完（什么都没发布）。" : "结果：完成。")
    : code === 1 ? "结果：有故障（退出码 1）——先看上面的「故障」行，旁路记录或题库可能没写成。"
    : "结果：没做完（退出码 2）——有题要重试或等人工，再跑一次会接着做；等人工的在 qbank-review/drafts/。");
  return code;
}

function header(S, sel, eng, o) {
  console.log("审稿 v2（英文，逐题）   条目 " + sel.map(s => s.id).join("、") + "   并发 " + o.concurrency + (o.dry ? "   [dry]" : ""));
  if (eng.gen) console.log("出题:     " + eng.gen.id + "（" + eng.gen.via + "）");
  console.log("审稿:     " + eng.judge.id + "（" + eng.judge.via + "）   身份 " + engineText(eng.judgeIdentity) + "   修复也用它");
  if (!eng.judgeIdentity.exact) console.log("          注意：审稿模型不确定（比如 claude 没在 config 里钉 model），结论照样落盘但永远不复用，每次运行都会重审已有题，v2 导出也不认。");
  if (eng.gen && eng.gen.id === eng.judge.id) console.log("          （审稿和出题是同一个引擎：自审也能拦低级错，换个更强的引擎审更稳）");
  console.log("旁路记录: " + S.qbankReviewStore().dir);
  console.log("");
}

async function pickEngines(S, P, needGen) {
  const judge = strictEngine(S, P.judge, "judge:quiz", "--judge");
  const gen = needGen ? strictEngine(S, P.provider, "pregen:quiz", "--provider") : null;
  const errors = [judge.error, gen && gen.error].filter(Boolean);
  if (errors.length) return { errors };
  return { judge, gen };
}

async function runAll(S, QB, P, selected, ctx) {
  const results = [];
  await pool(selected, P.concurrency || 1, async sel => {
    let r;
    try { r = await runItemV2(S, QB, sel, ctx); }
    catch (e) { r = { id: sel.id, key: sel.key, runs: [], faults: ["意外异常：" + errText(e)], retry: 0, human: 0, certified: {}, levels: {}, complete: false }; }
    results.push(r);
    printItem(r, ctx.dry);
  });
  return results;
}

/* ---------------- pregen --review v2 ---------------- */
export async function runPregenV2(S, QB, P) {
  const { selected, errors } = resolveSelection(S, P.skills);
  if (errors.length) { failArgs(errors); return 1; }
  await S.detectProviders();
  const eng = await pickEngines(S, P, true);
  if (eng.errors) { failArgs(eng.errors); return 1; }
  eng.judgeIdentity = judgeIdentity(S, selected[0], eng.judge.id);
  header(S, selected, eng, P);
  const results = await runAll(S, QB, P, selected, { judge: eng.judge.id, gen: eng.gen.id, dry: false, plan: P.dry, generate: true, timeoutMs: P.timeoutMs, judgeTask: "judge:quiz" });
  return finish(results, P.dry ? "plan" : "run");
}

/* ---------------- audit_qbank --review v2 ---------------- */
export async function runAuditV2(S, QB, P) {
  const { selected, errors } = resolveSelection(S, P.skills);
  for (const s of selected) if (!S.qbank[s.key] || !(S.qbank[s.key].questions || []).length) errors.push(`--skill ${s.id}：没有英文题库（${s.key}），没有可审的题——要出题用 pregen --review v2`);
  if (errors.length) { failArgs(errors); return 1; }
  await S.detectProviders();
  const eng = await pickEngines(S, P, false);
  if (eng.errors) { failArgs(eng.errors); return 1; }
  eng.judgeIdentity = judgeIdentity(S, selected[0], eng.judge.id);
  header(S, selected, eng, P);
  /* 账本任务名沿用老 audit 的 audit:quiz（和生成时的 judge:quiz 分开记）；选路仍按 judge:quiz */
  const results = await runAll(S, QB, P, selected, { judge: eng.judge.id, dry: P.dry, generate: false, timeoutMs: P.timeoutMs, judgeTask: "audit:quiz" });
  return finish(results, P.dry ? "dry" : "run");
}

/* ---------------- export_apple --review v2 ---------------- */
/* 导出不调模型、不探测引擎：证明资格的审稿引擎必须写明（--judge <引擎> 或 config.providerByTask["judge:quiz"] / config.provider），
 * 身份按 server 的离线解析（claude / anthropic / openai 看 config；ollama 要探测才知道模型 → 不确定）。
 * 身份不确定（exact:false）的引擎不能证明任何题，点名的题库一律整份不导出。 */
export function exportJudge(S, sel, requested) {
  const first = explicitWant(S, requested, "judge:quiz", "--judge");
  if (!first) return { error: "export --review v2 要知道由哪个审稿引擎的结论来证明：--judge <引擎>，或 config.providerByTask[\"judge:quiz\"] / config.provider" };
  if (typeof (S.ADAPTERS || {})[first[0]] !== "function") return { error: `${first[1]} 指定了 ${first[0]}：不是已知引擎（可选：${knownEngines(S)}）` };
  return { id: first[0], via: first[1], identity: judgeIdentity(S, sel, first[0]) };
}
/* 选中条目的英文题库只导出「当前审稿引擎对此刻这个版本（内容 + brief / 课文 / 规则 / rubric）有有效非 dry pass、
 * 且没有任何引擎对同一版本更新的不过」的题（QB.currentEvidence，和 pregen / audit 同一口径），
 * 用审稿白名单字段（qid / level / question / options / answerIndex / explain / tags / visual），不带 usedAt 和任何旁路字段。
 * 老题库里审不过 / 没审过的题不删，只是不进这份 v2 产物。 */
export function exportV2Bank(S, QB, sel, records, judge) {
  const brief = S.qbankBriefFor(sel.item, sel.data);
  const qs = ((S.qbank[sel.key] || {}).questions) || [];
  const byKey = new Map(records.map(r => [r.reviewKey, r]));
  const id = QB.engineIdentity(judge);
  const out = [], excluded = { noEvidence: 0, revise: 0, "needs-human": 0, noQid: 0, unknownJudge: 0 };
  for (const q of qs) {
    if (!q || !q.qid) { excluded.noQid++; continue; }
    if (!id.exact) { excluded.unknownJudge++; continue; }
    const ev = QB.currentEvidence({ brief, question: q, judge: id, records, byKey });
    if (ev.state === "certified") out.push(QB.questionContent(q));
    else if (ev.state === "held") excluded[ev.status] = (excluded[ev.status] || 0) + 1;
    else excluded.noEvidence++;
  }
  const levels = { 1: 0, 2: 0, 3: 0 };
  for (const q of out) levels[q.level]++;
  return { questions: out, excluded, levels, total: qs.length, playable: [1, 2, 3].every(l => levels[l] > 0), judge: id, briefId: brief.briefId, lesson: brief.lesson.status };
}

/* 输出目录保护（导出会先整个删掉 --out）：不能是源码根 / 数据根或它们的上级，不能落在课程源数据或用户数据里 */
export function unsafeOutput(out, S) {
  const canon = p => { let cur = path.resolve(p); const tail = []; for (;;) { try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch (_) { const up = path.dirname(cur); if (up === cur) return path.resolve(p); tail.push(path.basename(cur)); cur = up; } } };
  const norm = p => canon(p).toLowerCase().replace(/[\\/]+$/, "");
  const o = norm(out);
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep.toLowerCase()) || child.startsWith(parent + "/");
  for (const [label, p] of [["源码根目录", S.ROOT], ["数据根目录", S.DATA_ROOT]]) if (inside(norm(p), o)) return `--out ${out} 是${label}或它的上级，导出前会被整个删掉`;
  const guarded = [path.join(S.ROOT, "data"), path.join(S.DATA_ROOT, "data"), path.join(S.DATA_ROOT, "qbank-review"), S.TTS_CACHE, S.LESSON_PACK_DIR, S.UNIT_PACK_DIR, S.VOICE_PACK_DIR].filter(Boolean);
  for (const p of guarded) if (inside(o, norm(p))) return `--out ${out} 在 ${p} 里面（课程源数据 / 用户数据），导出前会被整个删掉`;
  return null;
}
