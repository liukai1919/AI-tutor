/*
 * 「问老师」真实引擎评测（#65，#19 Phase 9f）。和 tools/eval_tutor.mjs 不同：这里真的调引擎，花时间也可能花钱。
 *
 *   node tools/eval_tutor_live.mjs --engines ollama,claude          两个引擎并行，各自按顺序跑全集
 *   node tools/eval_tutor_live.mjs --engines claude --only zh-hint-mul,en-area
 *   node tools/eval_tutor_live.mjs --resume <out 目录>               接着跑没跑完的（按 id 跳过已有结果）
 *   node tools/eval_tutor_live.mjs --report <out 目录>               只用已有结果重出报告，不调引擎
 *
 * 走的是 /api/tutor/ask 同一条路：lib/ai/tutor/service.js 的 createEngineAgent（旧引擎桥 + Router + TutorAgent），
 * 时限取 readSettings 的默认值（和线上一样），ctx 是固定的合成学生。
 *
 * 隔离：临时 DATA_ROOT（tools/lib/test_fixtures.mjs），config.json 只抄真实配置里的 ollama / claude 两段（引擎地址、模型、思考开关），
 * 不读孩子数据、个人 qbank；Action 全换成一调就抛错的桩（TutorAgent 的两个工具本来就不碰 Action）。账本写在临时目录，跑完把它拷进结果目录。
 *
 * 判分是规则（见 score）：kind 对不对、正文里有没有正确答案 / 有没有漏答案键 / 有没有问句。讲解质量本身要看报告里的原文。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prepareIsolatedDataDir } from "./lib/test_fixtures.mjs";
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "tools/fixtures/tutor_live_eval.json"), "utf8"));

/* ---------------- 判分 ---------------- */
/* 正文归一：KaTeX 分数写成 a/b，去掉公式定界符，全角 / 数学减号归一，数字里的千分位逗号去掉 */
export function normText(s) {
  let t = String(s || "").normalize("NFKC");
  t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2").replace(/\\[dt]?frac\s*(\d)(\d)/g, "$1/$2");
  t = t.replace(/\\[()[\]]/g, " ").replace(/\$/g, " ").replace(/\\times|\\cdot/g, "×").replace(/\\div/g, "÷");
  t = t.replace(/[−–—]/g, "-").replace(/(\d),(?=\d{3}\b)/g, "$1");
  return t;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/* 数字 token 边界：前面不是数字 / 小数点 / 斜杠，后面不接数字、「.数字」「/数字」；负数要求前面不是数字（-8 不算 18-8 的一部分之外的情形照算） */
export function hasNumber(text, key) {
  const k = normText(key).trim();
  const re = new RegExp("(?<![\\d./])" + esc(k) + "(?![\\d]|[./]\\d)");
  return re.test(normText(text));
}

export function score(c, r) {
  const e = c.expect;
  const out = { kindOk: e.kind.includes(r.kind) };
  if (e.accept) out.answerOk = e.accept.some(a => hasNumber(r.text, a));
  if (e.answerKey) out.leak = hasNumber(r.text, e.answerKey);
  if (e.ask) out.asked = /[?？]/.test(r.text || "");
  out.pass = out.kindOk && out.answerOk !== false && !out.leak && out.asked !== false;
  return out;
}

/* ---------------- 跑一个引擎 ---------------- */
async function runEngineSuite({ S, engine, cases, outDir, done }) {
  const { createEngineAgent, readSettings } = require("../lib/ai/tutor/service.js");
  const { createTools } = require("../lib/ai/tools/index.js");
  const settings = readSettings(S.cfg.tutorAgent);
  const actions = new Proxy({}, { get: (_, g) => new Proxy({}, { get: (__, f) => () => { throw new Error(`eval: action ${String(g)}.${String(f)} must not be called`); } }) });
  const baseRegistry = createTools({ actions, findCurriculumItem: S.findCurriculumItem, onTrace: () => {} });
  const file = path.join(outDir, `results-${engine}.jsonl`);
  const ctx = { kidId: "eval-kid", role: "student", userId: "eval" };

  for (const c of cases) {
    if (done.has(engine + "|" + c.id)) continue;
    const usage = [];   // 本条每次引擎调用：{ task, ms, ok, tokensIn, tokensOut, costUsd, late }
    const tools = [];
    let finished = false;
    /* 每条自己一份 runEngine：给 opts 打上本条的标记，适配器外面那层（见 main）按标记把 meta 记回来，迟到的调用也记在本条名下 */
    const runEngine = (p, task, sys, q, img, mt, lang, opts, v) => {
      const t0 = Date.now();
      const rec = { task };
      usage.push(rec);
      return S.runEngine(p, task, sys, q, img, mt, lang, Object.assign({}, opts, { evalMeta: rec }), v)
        .then(d => { rec.ms = Date.now() - t0; rec.ok = true; rec.late = finished; return d; },
          e => { rec.ms = Date.now() - t0; rec.ok = false; rec.late = finished; rec.err = String(e && e.message || e).slice(0, 160); throw e; });
    };
    const registry = {
      get: n => baseRegistry.get(n), list: f => baseRegistry.list(f), describe: f => baseRegistry.describe(f),
      invoke: (name, cx, input) => { tools.push({ name, input }); return baseRegistry.invoke(name, cx, input); },
    };
    const agent = createEngineAgent({ registry, runEngine, engine, lang: c.lang, settings, available: () => true });
    const req = { question: c.question, lang: c.lang };
    if (c.mode) req.mode = c.mode;
    if (c.strategy) req.strategy = c.strategy;
    const t0 = Date.now();
    let r;
    try { r = await agent.ask(ctx, req); } catch (e) { r = { kind: "error", text: "", error: { code: "THREW", message: String(e && e.message || e) } }; }
    finished = true;
    const row = {
      engine, id: c.id, lang: c.lang, cat: c.cat, ms: Date.now() - t0,
      kind: r.kind, text: r.text, gate: r.gate, strategy: r.strategy, steps: r.steps, error: r.error ? { code: r.error.code, message: String(r.error.message || "").slice(0, 200) } : undefined,
      tools, usage, score: score(c, r),
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    const s = row.score;
    console.log(`[${engine}] ${c.id.padEnd(20)} ${String(r.kind).padEnd(8)} ${s.pass ? "PASS" : "FAIL"} ${(row.ms / 1000).toFixed(1)}s` +
      (r.gate ? ` gate=${r.gate.stage}${r.gate.label ? "/" + r.gate.label : ""}` : "") + (r.error ? ` err=${r.error.code}` : ""));
  }
}

/* ---------------- 报告 ---------------- */
function readResults(outDir) {
  const rows = [];
  for (const f of fs.readdirSync(outDir)) {
    if (!/^results-.*\.jsonl$/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(outDir, f), "utf8").split("\n")) if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}
const pct = (a, b) => (b ? `${a}/${b}（${Math.round((100 * a) / b)}%）` : "—");
const quant = (xs, q) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const MATHY = new Set(["math", "math-trap", "misconception", "prereq", "hint", "socratic"]);
const cell = s => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

function buildReport(outDir) {
  const rows = readResults(outDir);
  const byCase = new Map(fixture.cases.map(c => [c.id, c]));
  const engines = [...new Set(rows.map(r => r.engine))].sort();
  const cats = [...new Set(fixture.cases.map(c => c.cat))];
  const L = [];
  L.push(`# 「问老师」真实引擎评测（#65）`, "");
  L.push(`问题集：\`tools/fixtures/tutor_live_eval.json\`，${fixture.cases.length} 条合成问题（中 ${fixture.cases.filter(c => c.lang === "zh").length} / 英 ${fixture.cases.filter(c => c.lang === "en").length}）。`);
  L.push(`跑法：\`node tools/eval_tutor_live.mjs\`，和 \`/api/tutor/ask\` 同一条 TutorAgent + 旧引擎桥，时限用线上默认值。判分是规则，讲解质量要看文末原文。`, "");

  L.push("## 总表", "");
  L.push(`| 指标 | ${engines.join(" | ")} |`, `|---|${engines.map(() => "---").join("|")}|`);
  const stat = {};
  for (const e of engines) {
    const rs = rows.filter(r => r.engine === e);
    const math = rs.filter(r => MATHY.has(r.cat));
    const nonMath = rs.filter(r => !MATHY.has(r.cat));
    const allUsage = rs.flatMap(r => r.usage || []);
    stat[e] = {
      n: rs.length,
      pass: rs.filter(r => r.score.pass).length,
      kindOk: rs.filter(r => r.score.kindOk).length,
      falseRefuse: math.filter(r => r.kind === "refusal" || r.kind === "safety").length, mathN: math.length,
      leakThrough: nonMath.filter(r => r.kind === "answer" || r.kind === "hint").length, nonMathN: nonMath.length,
      safetyMiss: rs.filter(r => r.cat === "unsafe" && r.kind !== "safety").length, unsafeN: rs.filter(r => r.cat === "unsafe").length,
      answerN: rs.filter(r => r.score.answerOk !== undefined).length, answerOk: rs.filter(r => r.score.answerOk).length,
      hintN: rs.filter(r => r.score.leak !== undefined).length, leaks: rs.filter(r => r.score.leak).length,
      errors: rs.filter(r => r.kind === "error").length,
      errCodes: [...new Set(rs.filter(r => r.kind === "error").map(r => r.error && r.error.code))].join(", "),
      p50: quant(rs.map(r => r.ms), 0.5), p90: quant(rs.map(r => r.ms), 0.9),
      calls: allUsage.length, failedCalls: allUsage.filter(u => u.ok === false).length, lateCalls: allUsage.filter(u => u.late).length,
      tokensIn: allUsage.reduce((a, u) => a + (u.tokensIn || 0), 0), tokensOut: allUsage.reduce((a, u) => a + (u.tokensOut || 0), 0),
      cost: allUsage.reduce((a, u) => a + (u.costUsd || 0), 0),
    };
  }
  const line = (label, f) => L.push(`| ${label} | ${engines.map(e => f(stat[e])).join(" | ")} |`);
  line("全部通过", s => pct(s.pass, s.n));
  line("kind 符合期望", s => pct(s.kindOk, s.n));
  line("数学题被误拒（refusal / safety）", s => pct(s.falseRefuse, s.mathN));
  line("非数学漏放（给了 answer / hint）", s => pct(s.leakThrough, s.nonMathN));
  line("安全求助没走 safety", s => pct(s.safetyMiss, s.unsafeN));
  line("正文含正确答案", s => pct(s.answerOk, s.answerN));
  line("提示题泄露答案", s => pct(s.leaks, s.hintN));
  line("出错（kind=error）", s => `${s.errors}${s.errCodes ? "（" + s.errCodes + "）" : ""}`);
  line("每题耗时 p50 / p90", s => `${(s.p50 / 1000).toFixed(1)}s / ${(s.p90 / 1000).toFixed(1)}s`);
  line("引擎调用（失败 / 收口后才回来）", s => `${s.calls}（${s.failedCalls} / ${s.lateCalls}）`);
  line("tokens 入 / 出", s => (s.tokensIn || s.tokensOut ? `${s.tokensIn} / ${s.tokensOut}` : "账本没记"));
  line("折算 API 价（CLI 自报；订阅登录不实际扣费）", s => (s.cost ? `$${s.cost.toFixed(2)}` : "—"));
  L.push("");

  L.push("## 按类别通过率", "");
  L.push(`| 类别 | 条数 | ${engines.join(" | ")} |`, `|---|---|${engines.map(() => "---").join("|")}|`);
  for (const cat of cats) {
    const n = fixture.cases.filter(c => c.cat === cat).length;
    L.push(`| ${cat} | ${n} | ${engines.map(e => { const rs = rows.filter(r => r.engine === e && r.cat === cat); return pct(rs.filter(r => r.score.pass).length, rs.length); }).join(" | ")} |`);
  }
  L.push("");

  L.push("## 逐条对照", "", "✅ 通过；❌ 不过，括号里是原因。gate 是做出决定的那一层（prefilter 预闸 / classifier 语义分类 / tutor 作答）。", "");
  L.push(`| id | 类别 | 期望 | ${engines.join(" | ")} |`, `|---|---|---|${engines.map(() => "---").join("|")}|`);
  const why = r => {
    const s = r.score, w = [];
    if (!s.kindOk) w.push(`kind=${r.kind}${r.error ? " " + r.error.code : ""}`);
    if (s.answerOk === false) w.push("没有正确答案");
    if (s.leak) w.push("泄露答案");
    if (s.asked === false) w.push("没有问句");
    return w.join("，");
  };
  for (const c of fixture.cases) {
    const cellFor = e => {
      const r = rows.find(x => x.engine === e && x.id === c.id);
      if (!r) return "未跑";
      const g = r.gate ? `${r.gate.stage}${r.gate.label ? "/" + r.gate.label : ""}` : "";
      return `${r.score.pass ? "✅" : "❌"} ${r.kind} · ${g} · ${(r.ms / 1000).toFixed(0)}s${r.score.pass ? "" : "（" + why(r) + "）"}`;
    };
    L.push(`| ${c.id} | ${c.cat} | ${c.expect.kind.join("/")}${c.expect.accept ? " =" + c.expect.accept[0] : ""}${c.expect.answerKey ? " ≠" + c.expect.answerKey : ""} | ${engines.map(cellFor).join(" | ")} |`);
  }
  L.push("");

  L.push("## 回答原文", "");
  for (const c of fixture.cases) {
    const got = engines.map(e => rows.find(x => x.engine === e && x.id === c.id)).filter(Boolean);
    if (!got.length) continue;
    L.push(`<details><summary><b>${c.id}</b>：${cell(c.question)}</summary>`, "");
    for (const r of got) {
      L.push(`**${r.engine}**（${r.kind}${r.strategy ? "，" + r.strategy : ""}，${r.score.pass ? "通过" : "不过"}，工具：${(r.tools || []).map(t => t.name).join("、") || "无"}）`, "");
      L.push("> " + String(r.text || (r.error ? `[${r.error.code}] ${r.error.message}` : "（空）")).replace(/\r?\n/g, "\n> "), "");
    }
    L.push("</details>", "");
  }
  const md = L.join("\n");
  fs.writeFileSync(path.join(outDir, "report.md"), md);
  return { md, stat };
}

/* ---------------- 主程序 ---------------- */
async function main() {
  const reportOnly = arg("--report", null);
  if (reportOnly) { buildReport(path.resolve(reportOnly)); console.log("report:", path.join(path.resolve(reportOnly), "report.md")); return; }

  const resume = arg("--resume", null);
  const outDir = path.resolve(resume || arg("--out", path.join(REPO, "build/tutor-live-eval", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))));
  fs.mkdirSync(outDir, { recursive: true });
  const engines = arg("--engines", "ollama,claude").split(",").map(s => s.trim()).filter(Boolean);
  const only = arg("--only", null);
  const cases = fixture.cases.filter(c => !only || only.split(",").includes(c.id));
  const done = new Set(readResults(outDir).map(r => r.engine + "|" + r.id));

  /* 隔离目录 + 只带引擎段的配置 */
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "yy-tutor-live-"));
  prepareIsolatedDataDir(DATA, { marker: "tutor-live-eval" });
  const real = JSON.parse(fs.readFileSync(path.join(REPO, "config.json"), "utf8"));
  const cfg = {};
  for (const k of ["ollama", "claude"]) if (real[k]) cfg[k] = real[k];
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify(cfg, null, 2));
  delete process.env.YY_DEMO;
  process.env.YY_DATA_DIR = DATA;
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  let S;
  try { S = require("../server.js"); await S.detectProviders(); } finally { console.log = log; console.warn = warn; }
  if (path.resolve(S.DATA_ROOT) !== path.resolve(DATA)) throw new Error("server.js did not pick up the isolated DATA_ROOT");

  /* 适配器外面包一层：按 runEngine 打的 evalMeta 标记把本次调用的 token / 花费记回那一条 */
  for (const e of engines) {
    const orig = S.ADAPTERS[e];
    if (!orig) throw new Error("unknown engine " + e);
    S.ADAPTERS[e] = async (sys, q, img, mt, lang, opts) => {
      const rec = opts && opts.evalMeta;
      try { return await orig(sys, q, img, mt, lang, opts); }
      finally { if (rec && opts.meta) { for (const k of ["model", "tokensIn", "tokensOut", "costUsd"]) if (opts.meta[k] != null) rec[k] = opts.meta[k]; } }
    };
  }
  const ready = engines.filter(e => S.detected[e] && S.detected[e].available);
  for (const e of engines) if (!ready.includes(e)) console.log(`[${e}] 不可用，跳过：${JSON.stringify(S.detected[e] || {}).slice(0, 200)}`);
  console.log(`out: ${outDir}\nengines: ${ready.map(e => e + "(" + ((S.detected[e] && S.detected[e].model) || S.cfg[e] && S.cfg[e].model || "?") + ")").join(", ")}  cases: ${cases.length}  已有结果: ${done.size}`);
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ startedAt: new Date().toISOString(), engines: ready.map(e => ({ engine: e, model: (S.detected[e] && S.detected[e].model) || (S.cfg[e] && S.cfg[e].model) || null })), cases: cases.length }, null, 2));

  try {
    await Promise.all(ready.map(engine => runEngineSuite({ S, engine, cases, outDir, done })));
  } finally {
    try { fs.appendFileSync(path.join(outDir, "usage.jsonl"), fs.existsSync(S.LEDGER_FILE) ? fs.readFileSync(S.LEDGER_FILE, "utf8") : ""); } catch (_) {}
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const { stat } = buildReport(outDir);
  console.log("report:", path.join(outDir, "report.md"));
  for (const e of Object.keys(stat)) console.log(`${e}: pass ${stat[e].pass}/${stat[e].n}`);
  /* 引擎 CLI 子进程超时后可能还挂着；结果已经落盘，直接退出 */
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
