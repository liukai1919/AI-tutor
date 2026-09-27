#!/usr/bin/env node
/*
 * `--review v2` 命令行接线的隔离端到端测试（#45）：真实的 tools/pregen.mjs / audit_qbank.mjs / export_apple.mjs 子进程，
 * 临时 DATA_ROOT（demo 题库 + config），假引擎经 tools/lib/cli_stub_preload.mjs 注入（内置适配器全部拆掉，不探测、不联网）。
 *
 * 覆盖：参数 / 选条目 / 引擎的显式校验；生成 → 硬校验 → 审稿 → 有限修复 → 发布 → 导出；needs-human / 超时 / 畸形结论 / 硬校验不过
 * 都不发布；续跑按当前版本证据（dry 不算、内容 / 课文 / 规则 / 审稿引擎一变就重审）；已有题审不过留在题库、v2 导出不带；
 * 旁路 / 题库写盘失败和崩溃重启可见且不丢身份；并发两个条目不丢写入；v2 导出字段与默认导出的边界。
 *
 * 审稿结论是脚本写死的（题干里的标记决定结论），只证明编排，不证明任何真实审稿引擎的判断力或题目的教学质量。
 *
 *   node tools/test_qbank_cli_v2.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { makeChecker } from "./lib/isolated_server.mjs";
import { makeDataDir, removeDir, runCli, calls, ledger, qbankFile, bank, resetCalls, ROOT } from "./lib/cli_harness.mjs";

const { check, summary } = makeChecker();
const A = "YY.MATH.FRAC.EQUIV.VISUAL", C = "YY.MATH.DATA.LINE.READ", B = "BC.MATH.G4.NUM.01";
const KA = A + "|en", KC = C + "|en", KB = B + "|en";
const clone = v => JSON.parse(JSON.stringify(v));
const V2 = (...a) => ["--review", "v2", ...a];
const kinds = d => calls(d).map(c => c.kind);
const judgeCalls = d => calls(d).filter(c => c.kind === "judge");
const judgedQids = d => judgeCalls(d).flatMap(c => c.qids);
const raw = d => fs.readFileSync(path.join(d, "qbank.json"), "utf8");
const reviewDir = d => path.join(d, "qbank-review");
const readDir = p => { try { return fs.readdirSync(p).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(p, f), "utf8"))); } catch (_) { return []; } };
const drafts = (d, dry) => readDir(path.join(reviewDir(d), dry ? "dry" : "", "drafts"));
const records = (d, dry) => readDir(path.join(reviewDir(d), dry ? "dry" : "", "records"));
const reports = (d, dry) => readDir(path.join(reviewDir(d), dry ? "dry" : "", "reports"));
const byLevel = qs => [1, 2, 3].map(l => qs.filter(q => q.level === l).length);
const editBank = (d, f) => { const all = qbankFile(d); f(all); fs.writeFileSync(path.join(d, "qbank.json"), JSON.stringify(all)); };
const tmpOut = () => fs.mkdtempSync(path.join(os.tmpdir(), "yy-cli-v2-out-"));
const cleanups = [];
const data = (marker, config) => { const d = makeDataDir(marker, { config }); cleanups.push(d); return d; };

/* ---------------- 合成题（只为编排；内容写得像样，但对错由脚本化的审稿结论决定） ---------------- */
const MA = ["frac.different_whole", "frac.count_shaded_only"], MC = ["graph.scale_misread", "graph.steep_means_more"];
const qa = (level, question, options, extra) => Object.assign({ level, question, options, answerIndex: 0,
  explain: "Multiply the top and the bottom by the same number; the amount stays the same.", tags: ["ok", MA[0], MA[1], "other"] }, extra || {});
const BAR = { type: "fractionBar", nums: [2, 1, 4, 2], caption: "Two bars of the same length" };
const A1 = { questions: [
  qa(1, "Which fraction is equal to 1/2?", ["2/4", "1/3", "2/3", "3/4"]),
  qa(1, "Both bars are the same length. Which fraction names the same amount as 1/2?", ["2/4", "1/4", "3/4", "4/2"], { visual: BAR }),
  qa(1, "Which fraction is equal to 1/3?", ["2/6", "1/6", "3/6", "2/3"]),
  qa(1, "REVISE-ME Which fraction is equal to 3/4?", ["6/8", "3/8", "4/6", "2/4"]),
  qa(2, "Mia ate 2/8 of a pizza. Which amount of the same pizza is equal to that?", ["1/4", "1/3", "2/6", "3/8"]),
  qa(2, "Which pair shows two equal fractions?", ["3/6 and 1/2", "2/3 and 3/4", "1/4 and 2/4", "3/5 and 5/3"]),
  qa(2, "HUMAN-CHECK Which fraction equals 4/10?", ["2/5", "1/4", "4/5", "3/10"]),
  qa(2, "Look at the graph below. Which fraction is shaded?", ["1/2", "1/3", "1/4", "1/5"]),
  qa(3, "Ana ate 1/2 of a small pizza and Ben ate 2/4 of a large pizza. Did they eat the same amount?", ["No: the wholes are different sizes", "Yes: 2/4 = 1/2", "Yes: both ate 2 parts", "No: 4 is more than 2"]),
  qa(3, "Sam says 2/3 = 4/6 because he doubled the top and the bottom. Is Sam right?", ["Yes: both parts were multiplied by 2", "No: 4/6 is bigger", "No: you must add 2", "Yes: 6 is bigger than 3"]),
  qa(3, "BROKEN-VERDICT Which fraction equals 5/10?", ["1/2", "1/5", "5/5", "2/10"]),
  qa(3, "Which fraction is the same as 3/6?", ["1/2", "1/3", "3/3", "6/3"], { visual: { type: "pieChart", nums: [1, 1], caption: "Two parts" } })
] };
const A2 = { questions: [
  qa(2, "Which fraction equals 1/5?", ["2/10", "1/10", "5/1", "2/5"]),
  qa(2, "Which fraction equals 2/5?", ["4/10", "2/10", "5/2", "4/5"]),
  qa(2, "Which fraction equals 3/5?", ["6/10", "3/10", "5/3", "6/5"]),
  qa(2, "Which fraction equals 1/4?", ["2/8", "1/8", "4/1", "2/4"]),
  qa(3, "Lee cut a cake into 6 equal parts and ate 3. Kim cut the same cake into 2 parts and ate 1. Who ate more?", ["They ate the same amount", "Lee", "Kim", "It cannot be told"]),
  qa(3, "Raj says 3/4 = 3/8 because the tops are the same. What is his mistake?", ["The parts are different sizes", "Nothing, he is right", "He should add the bottoms", "3/8 is bigger"]),
  qa(3, "Which fraction is NOT equal to 2/3?", ["3/4", "4/6", "6/9", "8/12"]),
  qa(3, "Two equal ribbons: one is cut into thirds, one into sixths. How many sixths make one third?", ["2", "1", "3", "6"])
] };
const cleanA = () => ({ questions: A1.questions.map((q, i) => Object.assign(clone(q), { question: q.question.replace(/^(REVISE-ME|HUMAN-CHECK|BROKEN-VERDICT) /, "").replace("Look at the graph below. Which fraction is shaded?", "Which fraction is equal to 5/10?") }))
  .map(q => { if (q.visual && q.visual.type === "pieChart") delete q.visual; return q; }) });
const qc = (level, question, options) => ({ level, question, options, answerIndex: 0, explain: "Find how much the value changes over each step and compare.", tags: ["ok", MC[0], MC[1], "other"] });
const CB = (mark = "") => ({ questions: [1, 2, 3].flatMap(lv => [1, 2, 3, 4].map(i => qc(lv, `${lv === 1 && i === 1 ? mark : ""}A plant was ${i * lv} cm tall on Monday and grew ${lv} cm each day. How tall was it after ${i} days?`,
  [String(i * lv + lv * i) + " cm", String(i * lv) + " cm", String(lv * i + 50) + " cm", String(i + lv + 100) + " cm"]))) });

const ENG = { stubgen: { model: "stub-gen-1" }, stubjudge: { model: "stub-judge-1" } };
const RULES = [{ match: "REVISE-ME", verdict: "revise:answer_unique" }, { match: "HUMAN-CHECK", verdict: "human" }, { match: "BROKEN-VERDICT", verdict: "malformed" }, { match: "HANG-NOW", verdict: "hang" }];
const FIXED_A4 = "Which fraction names the same amount as 3/4 of one whole?";
const REPAIR = [{ match: "REVISE-ME", set: { question: FIXED_A4, explain: "Multiply the top and the bottom by 2: 3/4 = 6/8." } }];
const script = over => Object.assign({ engines: ENG, gen: { [A]: [A1, A2], [C]: [CB()] }, judge: RULES, repair: REPAIR }, over || {});
const GEN = ["--provider", "stubgen", "--judge", "stubjudge"];
const JUD = ["--judge", "stubjudge"];

/* ================= 1. 参数与选条目：出错都在调模型之前 ================= */
console.log("argument / selection errors stop before any model call or write");
{
  const d = data("cli-v2-args");
  const before = raw(d);
  const cases = [
    ["pregen.mjs", ["--review", "v2", ...GEN], /必须用 --skill/, "v2 without --skill"],
    ["pregen.mjs", ["--review", "v3", "--skill", A], /--review v3：不认识/, "unknown review mode"],
    ["pregen.mjs", ["--review"], /--review 要跟模式/, "bare --review"],
    ["pregen.mjs", ["--skill", A, ...GEN], /--skill 只和 --review v2 一起用/, "--skill without v2"],
    ["pregen.mjs", ["--skills", A, "--only", "quiz"], /--skills 是老的开关/, "legacy --skills with a value would silently run everything"],
    ["pregen.mjs", V2("--skill", A, "--grades", "5"), /--grades（按年级选）不能和 --review v2/, "--grades"],
    ["pregen.mjs", V2("--skill", A, "--limit", "1"), /--limit/, "--limit"],
    ["pregen.mjs", V2("--skill", A, "--force"), /--force/, "--force"],
    ["pregen.mjs", V2("--skill", A, "--langs", "zh,en"), /v2 只做英文/, "--langs zh,en"],
    ["pregen.mjs", V2("--skill", A, "--langs", "zh"), /v2 只做英文/, "--langs zh"],
    ["pregen.mjs", V2("--skill", A, "--only", "lessons"), /v2 只审闯关题库/, "--only lessons"],
    ["pregen.mjs", V2("--skill", A + "," + A), /重复了/, "duplicate id"],
    ["pregen.mjs", V2("--skill", A + ",,"), /空的条目 id/, "empty id"],
    ["pregen.mjs", V2("--skill", A, "--frobnicate"), /不认识 --frobnicate/, "unknown flag"],
    ["pregen.mjs", V2("--skill", A, "--dry", "yes"), /--dry 不带值/, "flag with a value"],
    ["pregen.mjs", V2("--skill", A, "--concurrency", "99"), /--concurrency 99/, "concurrency range"],
    ["pregen.mjs", V2("--skill", A, "--review-timeout", "0"), /--review-timeout 0/, "timeout range"],
    ["pregen.mjs", V2("--skill", "YY.MATH.NOPE.NOT_A_SKILL", ...GEN), /没有这个条目 id/, "unknown id"],
    ["pregen.mjs", V2("--skill", A.toLowerCase(), ...GEN), /没有这个条目 id/, "ids are exact (case)"],
    ["audit_qbank.mjs", V2("--skill", B, "--prefix", "BC."), /--prefix/, "audit --prefix"],
    ["audit_qbank.mjs", V2("--skill", B, "--provider", "stubgen"), /--provider/, "audit --provider"],
    ["audit_qbank.mjs", V2("--skill", A, ...JUD), /没有英文题库/, "audit of an item without an English bank"],
    ["audit_qbank.mjs", ["--review", "v3"], /不认识的审稿模式/, "audit unknown mode"],
    ["export_apple.mjs", ["--review", "v1", "--skill", A], /--review v1：不认识/, "export only knows v2"],
    ["export_apple.mjs", ["--skill", A], /--skill 只和 --review v2/, "export --skill without v2"],
    ["export_apple.mjs", V2("--skill", "AOPS.PREALG.1"), /AoPS|没有这个条目/, "export refuses AoPS / unknown"],
    ["pregen.mjs", ["--review=v2", "--skill=" + A, ...GEN], /等号写法不认/, "--review=v2 / --skill=… (the legacy parser would ignore them and run everything)"],
    ["pregen.mjs", ["--review", "v1", "--review", "v2", "--skill", A, ...GEN], /--review 只能给一次/, "duplicate --review"],
    ["pregen.mjs", ["--review", "v2", "--skill", "", ...GEN], /--skill 需要一个值/, "empty --skill value"],
    ["audit_qbank.mjs", ["--review", "v2", "--skill", B, "--skill", A, ...JUD], /--skill 只能给一次/, "duplicate --skill"],
    ["export_apple.mjs", V2("--skill", A), /要知道由哪个审稿引擎/, "export v2 without a judge policy"],
    ["pregen.mjs", ["--review", "v1", "--skill", "YY.MATH.NOPE.NOT_A_SKILL", ...GEN], /没有这个条目 id/, "v1 --skill with an unknown id"],
    ["pregen.mjs", ["--review", "v1", "--skill", A, "--grades", "5", ...GEN], /不能和 --skill 一起用/, "v1 --skill with --grades"],
    ["audit_qbank.mjs", ["--review", "v1", "--skill", B, ...JUD], /--skill 只和 --review v2/, "audit has no v1 --skill"],
    ["pregen.mjs", ["--review", "v1", "--skill", A, "--only", "unit", ...GEN], /--only unit：点名条目时只能是/, "v1 --skill with --only unit (would be zero jobs, exit 0)"],
    ["pregen.mjs", ["--review", "v1", "--skill", A, "--only", "bogus", ...GEN], /--only bogus/, "v1 --skill with an unknown --only"],
    ["pregen.mjs", ["--review", "v1", "--skill", A, "--langs", "fr", ...GEN], /--langs fr：只能是 zh \/ en/, "v1 --skill with an unsupported language"]
  ];
  for (const [scriptName, args, re, name] of cases) {
    resetCalls(d);
    const r = runCli(d, scriptName, args, script());
    const k = kinds(d);
    check(`${name}: exit 1 with a clear message, no engine detection or model call`, r.status === 1 && re.test(r.out) && !k.includes("detect") && !k.some(x => x !== "detect"), { status: r.status, out: r.out.slice(-300), k });
  }
  check("nothing was written by any refused command", raw(d) === before && !fs.existsSync(reviewDir(d)) && !fs.existsSync(path.join(d, "usage.jsonl")));
  resetCalls(d);
  const r = runCli(d, "pregen.mjs", ["--skills", "--dry", "--grades", "4", "--only", "quiz", "--provider", "stubgen"], script());
  check("the legacy bare --skills switch still works (old dry listing, no model call)", r.status === 0 && /题库:\s+\d+ 组要生成/.test(r.out) && kinds(d).every(k => k === "detect"), r.out.slice(-300));
}

/* ================= 1a. 老流程只做点名条目（试点对照组） ================= */
console.log("pregen --review v1 --skill: the legacy pipeline on exactly the named items (pilot baseline arm)");
{
  const d = data("cli-v1-skill");
  const before = qbankFile(d);
  let r = runCli(d, "pregen.mjs", ["--review", "v1", "--skill", A + "," + B, "--dry", "--provider", "stubgen"], script());
  const lines = r.out.split(/\r?\n/).filter(l => /^  (课|题|卷)  /.test(l));
  check("dry listing covers only the named items, no unit tests", r.status === 0 && lines.length > 0 && lines.every(l => l.includes(A) || l.includes(B)) && !lines.some(l => /^  卷/.test(l)) && /只做点名条目/.test(r.out), lines);
  r = runCli(d, "pregen.mjs", ["--review", "v1", "--skill", A, "--only", "quiz", "--langs", "en", "--provider", "stubgen", "--judge", "stubjudge"], script({ gen: { [A]: [cleanA()] } }));
  const after = qbankFile(d);
  check("legacy run: one generation for that item, legacy v1 judge, 12 questions, nothing else touched, no v2 sidecar",
    r.status === 0 && calls(d).filter(c => c.kind === "gen").every(c => c.itemId === A) && calls(d).filter(c => c.kind === "judge-v1").length === 1 && after[KA].questions.length === 12
    && Object.keys(after).length === Object.keys(before).length + 1 && Object.keys(before).every(k => JSON.stringify(before[k]) === JSON.stringify(after[k])) && !fs.existsSync(reviewDir(d)), r.out.slice(-400));
}

/* ================= 1b. 测试预载器自己的安全闸 ================= */
console.log("the test preload refuses an uninitialised data dir before loading server.js");
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "yy-cli-v2-empty-"));
  cleanups.push(empty);
  let r = runCli(empty, "pregen.mjs", V2("--skill", A, ...GEN), script());
  check("empty temp dir → exit 97, nothing created in it (no migration from the repo root)", r.status === 97 && /not an initialized isolated data dir/.test(r.out) && fs.readdirSync(empty).filter(x => !/^stub-script/.test(x)).length === 0, { s: r.status, files: fs.readdirSync(empty) });
  fs.writeFileSync(path.join(empty, "qbank.json"), "{}");
  r = runCli(empty, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  check("half-initialised dir (qbank.json only) → still refused", r.status === 97 && fs.readdirSync(empty).filter(x => !/^stub-script/.test(x)).join(",") === "qbank.json");
}

/* ================= 2. 引擎：显式要求必须兑现 ================= */
console.log("explicit engine requests are honoured or refused, never silently replaced");
{
  const d = data("cli-v2-engines");
  const before0 = raw(d);
  let r = runCli(d, "audit_qbank.mjs", V2("--skill", B, "--judge", "ghost"), script());
  check("--judge <unknown engine> → exit 1 before any review", r.status === 1 && /ghost/.test(r.out) && /不是已知引擎/.test(r.out) && !judgeCalls(d).length, r.out.slice(-300));
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, "--judge", "stubjudge"), script({ engines: { stubjudge: { model: "x", available: false } } }));
  check("--judge <known but unavailable> → exit 1 (no fall-through to another engine)", r.status === 1 && /没检测到/.test(r.out) && !judgeCalls(d).length, r.out.slice(-300));
  r = runCli(d, "pregen.mjs", V2("--skill", A, "--provider", "stubgen2", "--judge", "stubjudge"), script());
  check("--provider <unavailable> → exit 1, nothing generated", r.status === 1 && /stubgen2/.test(r.out) && !kinds(d).includes("gen"), r.out.slice(-300));
  check("no review sidecar was created by the refused runs", !fs.existsSync(reviewDir(d)) && raw(d) === before0);

  const d2 = data("cli-v2-route", { providerByTask: { "judge:quiz": "ghostjudge" } });
  r = runCli(d2, "audit_qbank.mjs", V2("--skill", B), script());
  check("config.providerByTask[\"judge:quiz\"] naming an unavailable engine → exit 1, not silently auto-picked", r.status === 1 && /providerByTask\["judge:quiz"\]/.test(r.out) && !judgeCalls(d2).length, r.out.slice(-300));
  const d3 = data("cli-v2-route2", { providerByTask: { "judge:quiz": "stubjudge" } });
  r = runCli(d3, "audit_qbank.mjs", V2("--skill", B), script());
  check("a configured judge route is used when available (bare / no --judge)", r.status === 0 && /审稿:\s+stubjudge（config\.providerByTask\["judge:quiz"\]）/.test(r.out) && judgeCalls(d3).every(c => c.engine === "stubjudge") && judgeCalls(d3).length === 1, r.out.slice(0, 600));
  check("audit's review went through runEngine, ledgered as audit:quiz like the legacy audit (routed by judge:quiz)", ledger(d3).some(l => l.task === "audit:quiz" && l.provider === "stubjudge" && l.ok) && !ledger(d3).some(l => l.task === "judge:quiz"));

  /* 内置引擎名（claude）：身份按 config 解析；钉了 model → 复用，没钉 → 每次重审 */
  const d4 = data("cli-v2-claude", { claude: { model: "claude-test-model", effort: "high" } });
  const sc = script({ engines: { claude: {} } });
  r = runCli(d4, "audit_qbank.mjs", V2("--skill", B, "--judge", "claude"), sc);
  check("builtin engine name: identity from config (model + effort) is shown, run completes", r.status === 0 && /claude \/ claude-test-model \(effort high\)/.test(r.out) && judgeCalls(d4).length === 1, r.out.slice(0, 600));
  resetCalls(d4);
  r = runCli(d4, "audit_qbank.mjs", V2("--skill", B, "--judge", "claude"), sc);
  check("…and a second run reuses the exact records: no review call", r.status === 0 && judgeCalls(d4).length === 0, kinds(d4));
  const o4 = tmpOut(); cleanups.push(o4);
  r = runCli(d4, "export_apple.mjs", V2("--skill", B, "--judge", "claude", "--no-voice", "--out", o4), sc);
  check("export with the same configured claude identity: all 12 current questions exported (positive control)", r.status === 0 && JSON.parse(fs.readFileSync(path.join(o4, "qbank", "legacy-by-standard", "en", B + ".json"), "utf8")).questions.length === 12, r.out.slice(-400));
  fs.writeFileSync(path.join(d4, "config.json"), JSON.stringify({ claude: { model: "claude-test-model", effort: "low" } }));
  r = runCli(d4, "export_apple.mjs", V2("--skill", B, "--judge", "claude", "--no-voice", "--out", o4), sc);
  check("…after the configured effort changes, the old passes certify nothing: withheld, exit 2", r.status === 2 && !fs.existsSync(path.join(o4, "qbank", "legacy-by-standard", "en", B + ".json")), r.out.slice(-400));
  fs.writeFileSync(path.join(d4, "config.json"), JSON.stringify({ claude: { model: "claude-other-model", effort: "high" } }));
  r = runCli(d4, "export_apple.mjs", V2("--skill", B, "--judge", "claude", "--no-voice", "--out", o4), sc);
  check("…and after the configured model changes: withheld as well", r.status === 2 && JSON.parse(fs.readFileSync(path.join(o4, "manifest.json"), "utf8")).qbankReview.banks[KB].excluded.noEvidence === 12);
  fs.writeFileSync(path.join(d4, "config.json"), JSON.stringify({ claude: { model: "", effort: "" } }));
  r = runCli(d4, "export_apple.mjs", V2("--skill", B, "--judge", "claude", "--no-voice", "--out", o4), sc);
  const m4 = JSON.parse(fs.readFileSync(path.join(o4, "manifest.json"), "utf8")).qbankReview;
  check("…and an unpinned claude (model unknown) certifies nothing, reported as such", r.status === 2 && m4.banks[KB].excluded.unknownJudge === 12 && /unknown/.test(m4.banks[KB].withheld) && m4.judge.exact === false);
  /* DEFAULT_CONFIG 钉了 claude-opus-5；用户把 model 清空 = 用 CLI 自己的默认模型（不知道是哪个） */
  const d5 = data("cli-v2-claude-default", { claude: { model: "", effort: "" } });
  const q0 = bank(d5, KB)[0];
  r = runCli(d5, "audit_qbank.mjs", V2("--skill", B, "--judge", "claude"), Object.assign({}, sc, { judge: [{ qid: q0.qid, verdict: "human" }] }));
  check("unknown-model run: its own needs-human holds the question in this run (exit 2)", r.status === 2 && /等人工 1/.test(r.out), r.out.slice(-400));
  resetCalls(d5);
  r = runCli(d5, "audit_qbank.mjs", V2("--skill", B, "--judge", "claude"), sc);
  check("claude without a pinned model: warned, earlier passes AND the earlier needs-human are not reused — all 12 reviewed again", r.status === 0 && /审稿模型不确定/.test(r.out) && judgeCalls(d5).length === 1 && judgedQids(d5).length === 12 && judgedQids(d5).includes(q0.qid), r.out.slice(0, 800));
}

/* ================= 3. pregen：生成 → 硬校验 → 审稿 → 修复 → 发布，多次运行接着做 ================= */
console.log("pregen --review v2: generate, hard-check, review, repair, publish; resume across runs");
let dA;
{
  dA = data("cli-v2-pregen");
  const before = raw(dA);
  let r = runCli(dA, "pregen.mjs", V2("--skill", A, "--dry", ...GEN), script());
  check("--dry: plan only (exit 0), no model call, no write at all", r.status === 0 && /计划/.test(r.out) && kinds(dA).every(k => k === "detect") && raw(dA) === before && !fs.existsSync(reviewDir(dA)) && !fs.existsSync(path.join(dA, "usage.jsonl")), { k: kinds(dA), out: r.out.slice(-400) });

  resetCalls(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), script());
  const qs = bank(dA, KA);
  const stems = qs.map(q => q.question);
  check("run 1: exit 2 (bank not complete, one malformed verdict to retry), not a success", r.status === 2 && /退出码 2/.test(r.out) && /✗ 没齐/.test(r.out), r.out.slice(-600));
  check("run 1: one generation, one repair, a review and a re-review", kinds(dA).filter(k => k === "gen").length === 1 && kinds(dA).filter(k => k === "repair").length === 1 && judgeCalls(dA).length === 2, kinds(dA));
  check("run 1: the judge / repair prompts carried qids and never usedAt", judgeCalls(dA)[0].qids.every(Boolean) && calls(dA).every(c => !c.sawUsedAt));
  const FIELDS = ["qid", "level", "question", "options", "answerIndex", "explain", "tags", "visual"];
  const seen = judgeCalls(dA).flatMap(c => c.items);
  const lastSeen = qid => seen.filter(x => x.qid === qid).pop();
  check("every published question is field-for-field what the judge last reviewed (options order, tags, visual included), and the judge input has no other fields",
    qs.every(q => { const j = lastSeen(q.qid); return j && FIELDS.every(k => JSON.stringify(j[k]) === JSON.stringify(q[k])); }) && seen.every(x => Object.keys(x).every(k => k === "id" || FIELDS.includes(k))));
  const briefs = new Set(calls(dA).filter(c => ["gen", "judge", "repair"].includes(c.kind)).map(c => c.briefId));
  check("generator, judge and repair all worked from the same TeachingBrief as the report", briefs.size === 1 && [...briefs][0] && r.out.includes("brief " + [...briefs][0]) && reports(dA).every(x => x.briefId === [...briefs][0]), [...briefs]);
  check("run 1: only passed questions were published (L1 4 / L2 2 / L3 2)", JSON.stringify(byLevel(qs)) === "[4,2,2]", byLevel(qs));
  check("needs-human, malformed verdict, missing picture and disallowed picture are not in the bank",
    !stems.some(s => /HUMAN-CHECK|BROKEN-VERDICT|graph below/.test(s)) && !qs.some(q => q.visual && q.visual.type === "pieChart"), stems);
  const fixed = qs.find(q => q.question === FIXED_A4);
  const revDraft = drafts(dA).find(x => x.question && x.question.question === FIXED_A4);
  check("the revise question was repaired, re-reviewed and published under its original draft / qid", fixed && revDraft && revDraft.qid === fixed.qid && /Multiply the top and the bottom by 2/.test(fixed.explain) && revDraft.state === "published" && !stems.some(s => /REVISE-ME/.test(s)));
  const withPic = qs.find(q => q.visual);
  check("the valid picture question kept its visual and aligned tags (ok on the correct option)", withPic && withPic.visual.type === "fractionBar" && withPic.tags[withPic.answerIndex] === "ok" && qs.every(q => q.tags && q.tags.length === 4 && q.tags[q.answerIndex] === "ok"));
  const ds = drafts(dA);
  const st = s => ds.filter(x => x.state === s).length;
  check("drafts: needs_human 1, error 1, hard_rejected 2 kept for humans, with findings", st("needs_human") === 1 && st("error") === 1 && st("hard_rejected") === 2
    && ds.filter(x => x.state === "hard_rejected").map(x => x.hardFindings.map(f => f.code).join("+")).sort().join(",") === "visual_missing,visual_not_allowed", ds.map(x => x.state));
  check("reports were written and every printed report path exists", reports(dA).length >= 1 && [...r.out.matchAll(/报告 (\S+\.json)/g)].every(m => fs.existsSync(m[1])) && /报告 /.test(r.out));
  check("the ledger shows pregen:quiz, judge:quiz and quiz:repair through runEngine", ["pregen:quiz", "judge:quiz", "quiz:repair"].every(t => ledger(dA).some(l => l.task === t && l.ok)));
  check("no sidecar or draft data leaked into qbank.json", !/draftId|reviewKey|runId|briefHash/.test(raw(dA)));
  const errDraft = ds.find(x => x.state === "error");

  resetCalls(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), script());
  const qs2 = bank(dA, KA);
  check("run 2: exit 2 (the malformed verdict repeats), bank now L1 4 / L2 6 / L3 6", r.status === 2 && JSON.stringify(byLevel(qs2)) === "[4,6,6]", { s: r.status, l: byLevel(qs2) });
  const jc = judgeCalls(dA);
  check("run 2: the error draft was resumed with the same draftId and qid; certified questions were not re-reviewed",
    jc.some(c => c.ids.includes(errDraft.draftId) && c.qids.includes(errDraft.qid)) && !judgedQids(dA).some(q => qs.some(x => x.qid === q)), jc.map(c => c.ids.length));
  const g2 = calls(dA).filter(c => c.kind === "gen");
  check("run 2: needs-human draft was not re-sent; generation asked only for L2 + L3", !jc.some(c => c.stems.some(s => /HUMAN-CHECK/.test(s))) && g2.length === 1 && g2[0].ask === "Write 8 original multiple-choice questions: 4 at Level 2, 4 at Level 3.", g2.map(c => c.ask));

  resetCalls(dA);
  const noBroken = RULES.filter(x => x.match !== "BROKEN-VERDICT");
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), script({ judge: noBroken }));
  const qs3 = bank(dA, KA);
  const again = qs3.find(q => q.qid === errDraft.qid);
  check("run 3: the retried draft passes and is published once under its original qid → exit 0, complete",
    r.status === 0 && /✓ 齐了/.test(r.out) && again && /BROKEN-VERDICT/.test(again.question) && qs3.filter(q => q.qid === errDraft.qid).length === 1 && qs3.length === 17, { s: r.status, n: qs3.length, out: r.out.slice(-400) });
  check("run 3: no generation (the bank is complete), exactly one review call for the retried draft", !kinds(dA).includes("gen") && judgeCalls(dA).length === 1 && judgeCalls(dA)[0].ids.length === 1);
  const usedAtKept = qs3.every(q => q.usedAt === 0);
  check("new questions carry usedAt 0 in the bank (family state stays out of the sidecar)", usedAtKept && !drafts(dA).some(x => "usedAt" in (x.question || {})));

  resetCalls(dA);
  const before4 = raw(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), script({ judge: noBroken }));
  check("run 4: nothing to do — no generation, no review (exact current evidence reused), exit 0", r.status === 0 && !kinds(dA).includes("gen") && judgeCalls(dA).length === 0 && raw(dA) === before4, kinds(dA));
}

/* ================= 4. 版本失效：内容 / 课文 / 规则 / 审稿引擎一变就重审 ================= */
console.log("current-version evidence: content, lesson, rules and judge changes all force a review");
{
  const sc = script({ judge: RULES.filter(x => x.match !== "BROKEN-VERDICT") });
  const qs = bank(dA, KA);
  const victim = qs.find(q => q.level === 2);
  editBank(dA, all => { all[KA].questions.find(q => q.qid === victim.qid).explain = "Edited by a maintainer: multiply top and bottom by the same number."; });
  resetCalls(dA);
  let r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), sc);
  check("edited question content → exactly that question is reviewed again (published unchanged), exit 0", r.status === 0 && JSON.stringify(judgedQids(dA)) === JSON.stringify([victim.qid]) && /未改仍有效 1/.test(r.out), { q: judgedQids(dA), out: r.out.slice(-500) });

  const lessonRel = "data/lessons/en/" + A + ".json";
  const lesson = JSON.parse(fs.readFileSync(path.join(ROOT, lessonRel), "utf8"));
  const L2 = clone(lesson);
  (L2.lesson || L2).steps[0].say = (L2.lesson || L2).steps[0].say + " (revised wording)";
  resetCalls(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), Object.assign({}, sc, { overlay: { [lessonRel]: JSON.stringify(L2) } }));
  check("changed lesson text → new brief → all 17 questions reviewed again", r.status === 0 && new Set(judgedQids(dA)).size === 17, { n: judgedQids(dA).length, out: r.out.slice(-300) });
  resetCalls(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), sc);
  check("back to the tracked lesson → its earlier records are current again: no review", r.status === 0 && judgeCalls(dA).length === 0);
  resetCalls(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, ...GEN), Object.assign({}, sc, { rulesVersion: "qbank-en-rules/test-2" }));
  check("changed generation / review rules → all reviewed again", r.status === 0 && new Set(judgedQids(dA)).size === 17);
  resetCalls(dA);
  r = runCli(dA, "pregen.mjs", V2("--skill", A, "--provider", "stubgen", "--judge", "stubjudge2"), Object.assign({}, sc, { engines: Object.assign({}, ENG, { stubjudge2: { model: "stub-judge-2" } }) }));
  check("another judge engine → all reviewed again by it", r.status === 0 && new Set(judgedQids(dA)).size === 17 && judgeCalls(dA).every(c => c.engine === "stubjudge2"));
}

/* ================= 5. 导出：v2 选中的题库只带有当前通过证据的题；字段、边界 ================= */
console.log("export --review v2: eligible questions only, legal fields kept, no household or sidecar data");
{
  const outV2 = tmpOut(), outDef = tmpOut();
  cleanups.push(outV2, outDef);
  let r = runCli(dA, "export_apple.mjs", V2("--skill", A, ...JUD, "--no-voice", "--out", outV2), script());
  const f = path.join(outV2, "qbank", "by-skill", "en", A + ".json");
  const ex = JSON.parse(fs.readFileSync(f, "utf8"));
  const live = bank(dA, KA);
  const allowed = ["qid", "level", "question", "options", "answerIndex", "explain", "tags", "visual"];
  check("v2 export: exit 0, all 17 current questions exported", r.status === 0 && ex.questions.length === 17, { s: r.status, n: ex.questions.length, out: r.out.slice(-400) });
  check("exported objects = bank objects minus usedAt (qid / tags / visual round-trip exactly)", ex.questions.every(q => {
    const b = live.find(x => x.qid === q.qid); if (!b) return false;
    const c = Object.assign({}, b); delete c.usedAt;
    return JSON.stringify(Object.keys(q).sort()) === JSON.stringify(Object.keys(c).sort()) && allowed.every(k => JSON.stringify(q[k]) === JSON.stringify(c[k]));
  }) && ex.questions.some(q => q.visual && q.visual.type === "fractionBar"));
  check("no usedAt / draft / review metadata in the exported bank", ex.questions.every(q => Object.keys(q).every(k => allowed.includes(k))) && !/usedAt|draftId|reviewKey|runId|briefHash|hardFindings/.test(fs.readFileSync(f, "utf8")));
  const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
  const files = walk(outV2);
  check("no sidecar file (qbank-review / reports / drafts / records / usage) in the package", !files.some(p => /qbank-review|[\\/](drafts|records|reports)[\\/]|usage\.jsonl|audit-report/.test(p)));
  const man = JSON.parse(fs.readFileSync(path.join(outV2, "manifest.json"), "utf8"));
  check("manifest: qbankReview counts only (no draft / review ids), humanApproval none", man.qbankReview && man.qbankReview.banks[KA].exported === 17 && man.qbankReview.humanApproval === "none"
    && !/draftId|reviewKey|runId|rk1-|dr-/.test(JSON.stringify(man.qbankReview)), man.qbankReview);
  check("manifest note distinguishes the offline package (keeps tags) from the child quiz HTTP (never sends them)", man.notes.some(n => /离线内容/.test(n) && /\/api\/quiz\/session/.test(n)));
  r = runCli(dA, "export_apple.mjs", ["--no-voice", "--out", outDef], script());
  const def = JSON.parse(fs.readFileSync(path.join(outDef, "qbank", "by-skill", "en", A + ".json"), "utf8"));
  check("default export of the same bank: same questions (it only strips usedAt)", r.status === 0 && JSON.stringify(def.questions.map(q => q.qid).sort()) === JSON.stringify(ex.questions.map(q => q.qid).sort()));
  const other = "BC.MATH.G4.NUM.02.json";
  const e2 = tmpOut(); cleanups.push(e2);
  r = runCli(dA, "export_apple.mjs", V2("--skill", A, "--judge", "stubjudge2", "--no-voice", "--out", e2), script({ engines: Object.assign({}, ENG, { stubjudge2: { model: "stub-judge-2" } }) }));
  check("the other judge that also passed every current version certifies the same 17", r.status === 0 && JSON.parse(fs.readFileSync(path.join(e2, "qbank", "by-skill", "en", A + ".json"), "utf8")).questions.length === 17);
  r = runCli(dA, "export_apple.mjs", V2("--skill", A, "--judge", "stubjudge3", "--no-voice", "--out", e2), script({ engines: Object.assign({}, ENG, { stubjudge3: { model: "stub-judge-3" } }) }));
  check("a judge that never reviewed these versions certifies nothing: withheld, exit 2", r.status === 2 && JSON.parse(fs.readFileSync(path.join(e2, "manifest.json"), "utf8")).qbankReview.banks[KA].excluded.noEvidence === 17);
  const keep = raw(dA);
  const staleQ = live[3];
  editBank(dA, all => { all[KA].questions.find(q => q.qid === staleQ.qid).explain = "Edited after review, never reviewed again."; });
  r = runCli(dA, "export_apple.mjs", V2("--skill", A, ...JUD, "--no-voice", "--out", e2), script());
  const staleEx = JSON.parse(fs.readFileSync(path.join(e2, "qbank", "by-skill", "en", A + ".json"), "utf8")).questions;
  check("a question edited after its review is left out (stale control); the other 16 still export", r.status === 0 && staleEx.length === 16 && !staleEx.some(q => q.qid === staleQ.qid));
  fs.writeFileSync(path.join(dA, "qbank.json"), keep);
  r = runCli(dA, "export_apple.mjs", V2("--skill", A, ...JUD, "--no-voice", "--out", e2), script());
  check("restoring the reviewed text makes it current again (its evidence was never lost)", r.status === 0 && JSON.parse(fs.readFileSync(path.join(e2, "qbank", "by-skill", "en", A + ".json"), "utf8")).questions.length === 17);
  check("unselected banks are exported exactly as the default export does", fs.readFileSync(path.join(outV2, "qbank", "legacy-by-standard", "en", other), "utf8") === fs.readFileSync(path.join(outDef, "qbank", "legacy-by-standard", "en", other), "utf8")
    && fs.readFileSync(path.join(outV2, "qbank", "legacy-by-standard", "zh", other), "utf8") === fs.readFileSync(path.join(outDef, "qbank", "legacy-by-standard", "zh", other), "utf8"));
}

/* ================= 6. 已有题：审不过的留在题库，v2 导出不带；修好的原地替换保 qid / usedAt ================= */
console.log("audit --review v2 on an existing bank: failing questions stay in the bank but out of the v2 export");
{
  const d = data("cli-v2-audit");
  const orig = bank(d, KB);
  const [q1, q2] = orig;
  editBank(d, all => { all[KB].questions[1].usedAt = 4242; });
  const sc = script({ judge: [{ qid: q1.qid, verdict: "human" }, { qid: q2.qid, verdict: "revise:explain_consistent", unless: "fixed explanation" }],
    repair: [{ match: q2.question.slice(0, 20), set: { explain: "Count by 25 each time: 3 275, 3 300, 3 325, 3 350. (fixed explanation)" } }] });
  const beforeQ1 = JSON.stringify(orig[0]);
  let r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), sc);
  const now = bank(d, KB);
  check("audit: exit 2 (one existing question has no passing evidence), bank still 12", r.status === 2 && now.length === 12 && /等人工 1/.test(r.out), { s: r.status, out: r.out.slice(-500) });
  check("the needs-human existing question is still in the bank, byte-identical (not removed, not claimed removed)", JSON.stringify(now.find(q => q.qid === q1.qid)) === beforeQ1);
  const n2 = now.find(q => q.qid === q2.qid);
  check("the revised existing question was replaced in place: same qid, same position, child's usedAt kept, fixed explanation", now[1].qid === q2.qid && n2.usedAt === 4242 && /fixed explanation/.test(n2.explain));
  check("the other 10 questions are unchanged", now.slice(2).every((q, i) => JSON.stringify(q) === JSON.stringify(orig[i + 2])));
  check("the legacy audit-report.jsonl is neither read nor written by v2", !fs.existsSync(path.join(d, "audit-report.jsonl")));
  const outDef = tmpOut(), outV2 = tmpOut();
  cleanups.push(outDef, outV2);
  runCli(d, "export_apple.mjs", ["--no-voice", "--out", outDef], script());
  r = runCli(d, "export_apple.mjs", V2("--skill", B, ...JUD, "--no-voice", "--out", outV2), script());
  const defB = JSON.parse(fs.readFileSync(path.join(outDef, "qbank", "legacy-by-standard", "en", B + ".json"), "utf8")).questions;
  const v2B = JSON.parse(fs.readFileSync(path.join(outV2, "qbank", "legacy-by-standard", "en", B + ".json"), "utf8")).questions;
  check("default export keeps the failing existing question (legacy behaviour)", defB.length === 12 && defB.some(q => q.qid === q1.qid));
  check("v2 export excludes it, includes the repaired one, exit 0", r.status === 0 && v2B.length === 11 && !v2B.some(q => q.qid === q1.qid) && v2B.some(q => q.qid === q2.qid && /fixed explanation/.test(q.explain)) && !v2B.some(q => "usedAt" in q));
  const man = JSON.parse(fs.readFileSync(path.join(outV2, "manifest.json"), "utf8"));
  check("manifest counts the exclusion", man.qbankReview.banks[KB].excluded["needs-human"] === 1 && man.qbankReview.banks[KB].exported === 11);
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), sc);
  check("rerun: no review call (11 exact passes reused, the needs-human verdict for this exact version is kept) and still exit 2", r.status === 2 && judgeCalls(d).length === 0);
  editBank(d, all => { all[KB].questions[0].explain = "A human rewrote this explanation after review."; });
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  check("after a human edit only that question is reviewed; it passes → exit 0", r.status === 0 && JSON.stringify(judgedQids(d)) === JSON.stringify([q1.qid]));

  /* 同一版本后来被另一个审稿引擎判 needs-human → 导出按最新结论不带它 */
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, "--judge", "stubjudge2"), script({ engines: Object.assign({}, ENG, { stubjudge2: { model: "stub-judge-2" } }), judge: [{ qid: orig[5].qid, verdict: "human" }] }));
  const out3 = tmpOut(); cleanups.push(out3);
  runCli(d, "export_apple.mjs", V2("--skill", B, ...JUD, "--no-voice", "--out", out3), script());
  const v2B3 = JSON.parse(fs.readFileSync(path.join(out3, "qbank", "legacy-by-standard", "en", B + ".json"), "utf8")).questions;
  check("a later needs-human from another judge on the same version wins over an older pass", r.status === 2 && v2B3.length === 11 && !v2B3.some(q => q.qid === orig[5].qid));
}

/* ================= 7. dry 和正式运行分开 ================= */
console.log("dry runs never count as formal passes");
{
  const d = data("cli-v2-dry");
  const before = raw(d);
  let r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD, "--dry"), script());
  check("audit --dry reviews (exit 0) but leaves qbank.json byte-identical and writes only dry records", r.status === 0 && judgeCalls(d).length === 1 && raw(d) === before && records(d, true).length === 12 && records(d, false).length === 0 && reports(d, false).length === 0);
  const out = tmpOut(); cleanups.push(out);
  r = runCli(d, "export_apple.mjs", V2("--skill", B, ...JUD, "--no-voice", "--out", out), script());
  check("dry passes are not export evidence: bank withheld, exit 2", r.status === 2 && !fs.existsSync(path.join(out, "qbank", "legacy-by-standard", "en", B + ".json")) && JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).qbankReview.banks[KB].withheld);
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  check("the formal run after a dry run reviews everything again and completes (exit 0)", r.status === 0 && new Set(judgedQids(d)).size === 12 && records(d, false).length === 12);
  const dd = data("cli-v2-dry-exit");
  r = runCli(dd, "audit_qbank.mjs", V2("--skill", B, ...JUD, "--dry", "--review-timeout", "1"), script({ judge: [{ qid: bank(dd, KB)[2].qid, verdict: "hang" }] }), { timeout: 60000 });
  check("audit --dry whose review times out → exit 2 (dry only waives publication, not failures)", r.status === 2 && /timeout 12/.test(r.out) && !/结果：dry 跑完/.test(r.out), r.out.slice(-400));
  fs.mkdirSync(path.join(reviewDir(dd), "drafts"), { recursive: true });
  fs.writeFileSync(path.join(reviewDir(dd), "drafts", "dr-broken.json"), "{ not json");
  resetCalls(dd);
  r = runCli(dd, "pregen.mjs", V2("--skill", B, ...GEN, "--dry"), script());
  check("pregen --dry that cannot read the drafts → exit 1 with the fault shown, still no model call", r.status === 1 && /读 draft 失败/.test(r.out) && kinds(dd).every(k => k === "detect"), r.out.slice(-400));
}

/* ================= 8. 故障可见、重启不丢身份 ================= */
console.log("storage and bank faults are visible; crashes and restarts keep identities");
{
  const d = data("cli-v2-fault-report");
  const before = raw(d);
  const q2 = bank(d, KB)[1];
  let r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script({ faults: { reportsWrite: true }, judge: [{ qid: q2.qid, verdict: "revise:explain_consistent" }], repair: [{ match: q2.question.slice(0, 20), set: { explain: "fixed explanation" } }] }));
  check("report write failure → exit 1, fault line, nothing published (qbank.json byte-identical)", r.status === 1 && /故障：/.test(r.out) && /退出码 1/.test(r.out) && raw(d) === before, r.out.slice(-500));

  const d2 = data("cli-v2-fault-bank");
  const b2 = raw(d2);
  r = runCli(d2, "pregen.mjs", V2("--skill", A, ...GEN), script({ gen: { [A]: [cleanA()] }, faults: { qbankWrite: true } }));
  check("qbank.json write failure → exit 1 (publish failed), bank unchanged", r.status === 1 && /发布失败/.test(r.out) && raw(d2) === b2, r.out.slice(-500));
  const passedDrafts = drafts(d2).filter(x => x.state === "passed");
  resetCalls(d2);
  r = runCli(d2, "pregen.mjs", V2("--skill", A, ...GEN), script({ gen: { [A]: [cleanA()] } }));
  const qs = bank(d2, KA);
  check("restart: passed drafts resume, reuse their records (no review, no new generation) and publish under the same qids",
    r.status === 0 && judgeCalls(d2).length === 0 && !kinds(d2).includes("gen") && qs.length === 12 && passedDrafts.length === 12 && passedDrafts.every(x => qs.some(q => q.qid === x.qid)), { s: r.status, k: kinds(d2), n: qs.length, out: r.out.slice(-400) });

  const d3 = data("cli-v2-crash");
  r = runCli(d3, "pregen.mjs", V2("--skill", A, ...GEN), script({ gen: { [A]: [cleanA()] }, faults: { crashAfterQbankWrite: 1 } }));
  const after = bank(d3, KA);
  check("crash right after the bank write (before bookkeeping): process died, bank has the 12 questions, drafts not yet marked published",
    r.status === 9 && after.length === 12 && drafts(d3).every(x => x.published === false), { s: r.status, n: after.length });
  resetCalls(d3);
  r = runCli(d3, "pregen.mjs", V2("--skill", A, ...GEN), script({ gen: { [A]: [cleanA()] } }));
  const final = bank(d3, KA);
  check("restart after the crash: no duplicate questions, same qids, no review or generation, drafts now published, exit 0",
    r.status === 0 && final.length === 12 && JSON.stringify(final.map(q => q.qid)) === JSON.stringify(after.map(q => q.qid)) && judgeCalls(d3).length === 0 && !kinds(d3).includes("gen")
    && drafts(d3).every(x => x.state === "published"), { s: r.status, n: final.length, k: kinds(d3) });
}

/* ================= 8b. 过时 draft 不遮挡现行版本 ================= */
console.log("an obsolete resumable draft never hides the live version from review");
{
  const d = data("cli-v2-stale-draft");
  const q3 = bank(d, KB)[2];
  let r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD, "--review-timeout", "1"), script({ judge: [{ qid: q3.qid, verdict: "hang" }] }), { timeout: 60000 });
  const timedOut = drafts(d).find(x => x.qid === q3.qid);
  check("setup: the whole audit timed out, one resumable (timeout) draft per question", r.status === 2 && drafts(d).filter(x => x.state === "timeout").length === 12 && timedOut, r.out.slice(-300));
  editBank(d, all => { all[KB].questions[2].explain = "A maintainer fixed this explanation while the review was pending."; });
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  const again = judgeCalls(d).flatMap(c => c.items).filter(x => x.qid === q3.qid);
  check("restart: the 11 unchanged drafts resume; the stale one is refused and the live version is reviewed instead → exit 0",
    r.status === 0 && again.length === 1 && /maintainer fixed/.test(again[0].explain) && /过时 draft 1/.test(r.out), { s: r.status, out: r.out.slice(-600) });
  const sup = drafts(d).find(x => x.draftId === timedOut.draftId);
  check("the refused draft is kept for humans, marked superseded with the reason (not deleted, not resumable)", sup && sup.state === "superseded" && sup.supersededFrom === "timeout" && /changed/.test(sup.supersededReason) && /pending/.test(sup.question.explain) === false);
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  check("next run: nothing resumed, nothing reviewed, exit 0", r.status === 0 && judgeCalls(d).length === 0 && !/续跑：/.test(r.out));
}

/* ================= 9. 超时 / 并发 ================= */
console.log("timeouts publish nothing and resume later; two items in parallel lose no write");
{
  const d = data("cli-v2-timeout");
  const t0 = Date.now();
  let r = runCli(d, "pregen.mjs", V2("--skill", C, ...GEN, "--review-timeout", "1"), script({ gen: { [C]: [CB("HANG-NOW ")] } }), { timeout: 60000 });
  check("a hanging review times out: exit 2, nothing published, process did not hang", r.status === 2 && !r.signal && Date.now() - t0 < 55000 && bank(d, KC).length === 0 && drafts(d).filter(x => x.state === "timeout").length === 12, { s: r.status, sig: r.signal, out: r.out.slice(-400) });
  const tq = drafts(d).map(x => x.qid).sort();
  resetCalls(d);
  r = runCli(d, "pregen.mjs", V2("--skill", C, ...GEN, "--review-timeout", "1"), script({ gen: { [C]: [CB("HANG-NOW ")] }, judge: [] }));
  check("rerun resumes the timed-out drafts (same qids), passes and completes without generating again", r.status === 0 && JSON.stringify(bank(d, KC).map(q => q.qid).sort()) === JSON.stringify(tq) && !kinds(d).includes("gen"), { s: r.status, out: r.out.slice(-400) });

  const dg = data("cli-v2-badgen");
  r = runCli(dg, "pregen.mjs", V2("--skill", C, ...GEN), script({ gen: { [C]: [{ nope: true }, { questions: "not a list" }] } }));
  const gl = ledger(dg).filter(l => l.task === "pregen:quiz");
  check("generator output that is not a question batch: retried once, both attempts ledgered as failures, nothing reviewed or published, exit 2",
    r.status === 2 && /出题失败/.test(r.out) && gl.length === 2 && gl.every(l => !l.ok) && judgeCalls(dg).length === 0 && bank(dg, KC).length === 0, { s: r.status, gl, out: r.out.slice(-300) });

  const d2 = data("cli-v2-parallel");
  r = runCli(d2, "pregen.mjs", V2("--skill", A + "," + C, ...GEN, "--concurrency", "2"), script({ gen: { [A]: [cleanA()], [C]: [CB()] } }));
  const all = qbankFile(d2);
  check("two items in parallel: both banks complete on disk, demo banks untouched, exit 0", r.status === 0 && (all[KA].questions || []).length === 12 && (all[KC].questions || []).length === 12 && Object.keys(all).length === 236, { s: r.status, keys: Object.keys(all).length });
}

/* ================= 10. 导出：不齐的题库整份不出；记录读不动就不导 ================= */
console.log("export refuses to claim eligibility it cannot establish");
{
  const d = data("cli-v2-export-edge");
  const out = tmpOut(); cleanups.push(out);
  let r = runCli(d, "export_apple.mjs", V2("--skill", C, ...JUD, "--no-voice", "--out", out), script());
  const man = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  check("selected item without any English bank → withheld, listed in the manifest, exit 2", r.status === 2 && man.qbankReview.banks[KC].withheld === "no English bank" && !fs.existsSync(path.join(out, "qbank", "by-skill", "en", C + ".json")));
  runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  const rec = fs.readdirSync(path.join(reviewDir(d), "records"))[0];
  fs.writeFileSync(path.join(reviewDir(d), "records", rec), "{ not json");
  const out2 = tmpOut(); cleanups.push(out2);
  fs.writeFileSync(path.join(out2, "sentinel.txt"), "keep");
  r = runCli(d, "export_apple.mjs", V2("--skill", B, ...JUD, "--no-voice", "--out", out2), script());
  check("an unreadable review record → exit 1 before the output folder is touched", r.status === 1 && /审稿记录读不动/.test(r.out) && fs.existsSync(path.join(out2, "sentinel.txt")) && !fs.existsSync(path.join(out2, "manifest.json")));
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  check("audit with an unreadable record: fault shown, exit 1; the affected question is reviewed again (its record rewritten)", r.status === 1 && /审稿记录读不动/.test(r.out) && judgedQids(d).length === 1, { s: r.status, q: judgedQids(d) });
  resetCalls(d);
  r = runCli(d, "audit_qbank.mjs", V2("--skill", B, ...JUD), script());
  check("…and the next run is clean (exit 0, nothing to review)", r.status === 0 && judgeCalls(d).length === 0);
  /* 输出目录保护：只拿临时数据目录试（源码根 / 仓库里的目录只在 test_qbank_evidence 里用假根目录测，绝不拿真目录冒险） */
  r = runCli(d, "export_apple.mjs", ["--no-voice", "--out", d], script());
  check("legacy export --out <data root> → refused before deleting anything", r.status === 1 && /数据根目录/.test(r.out) && fs.existsSync(path.join(d, "qbank.json")) && fs.existsSync(path.join(d, "qbank-review")));
  fs.writeFileSync(path.join(d, "data", "keep.txt"), "user data");
  r = runCli(d, "export_apple.mjs", V2("--skill", B, ...JUD, "--no-voice", "--out", path.join(d, "data")), script());
  check("--out inside the data root's user data → refused, files kept", r.status === 1 && /用户数据/.test(r.out) && fs.existsSync(path.join(d, "data", "keep.txt")));
}

for (const d of cleanups) removeDir(d);
process.exitCode = summary() ? 0 : 1;
