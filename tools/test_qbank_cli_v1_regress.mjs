#!/usr/bin/env node
/*
 * 老命令行行为的逐字回归（#45）：pregen / audit_qbank / export_apple 不带 --review v2 时，输出和落盘结果
 * 和改动之前（基线 30752f2，在接入 v2 之前录制）一致。
 *
 *   node tools/test_qbank_cli_v1_regress.mjs            # 比对 tools/fixtures/qbank-cli-v1-baseline.json
 *   node tools/test_qbank_cli_v1_regress.mjs --record   # 只在改脚本之前录一次
 *
 * 隔离：每个用例一个临时 DATA_ROOT（demo 题库 + 空 config），假引擎经 tools/lib/cli_stub_preload.mjs 注入，
 * 不探测、不联网；导出写临时 --out，不拷语音。随机 qid、耗时、临时路径换成占位符后逐字比对。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { makeChecker } from "./lib/isolated_server.mjs";
import { makeDataDir, removeDir, runCli, norm, qbankFile, calls, ROOT } from "./lib/cli_harness.mjs";

const { check, summary } = makeChecker();
const FIXTURE = path.join(ROOT, "tools", "fixtures", "qbank-cli-v1-baseline.json");
const RECORD = process.argv.includes("--record");

const ENG = { stubgen: { model: "stub-gen-1" }, stubjudge: { model: "stub-judge-1" } };
const zhQ = (lv, i) => ({ level: lv, question: `第 ${lv} 级第 ${i} 题：3${i} 加上 ${lv}${i} 等于多少？`, options: [String(30 + i + lv * 10 + i), "1", "2", "3"], answerIndex: 0,
  explain: `把十位和个位分开加：结果是 ${30 + i + lv * 10 + i}。`, tags: ["ok", "other", "other", "other"] });
const enQ = (lv, i) => ({ level: lv, question: `Level ${lv} item ${i}: what is 3${i} plus ${lv}${i}?`, options: [String(30 + i + lv * 10 + i), "1", "2", "3"], answerIndex: 0,
  explain: `Add the tens and the ones separately to get ${30 + i + lv * 10 + i}.`, tags: ["ok", "other", "other", "other"] });
const batch = f => ({ questions: [1, 2, 3].flatMap(lv => [1, 2, 3, 4].map(i => f(lv, i))) });
const SCRIPT = { engines: ENG, genAny: { zh: batch(zhQ), en: batch(enQ) }, judgeV1: { pass: true, problems: [] } };

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
/* 题库对比：去掉随机 qid 和 usedAt 之外逐字段保留，按题目顺序 */
const shape = qs => (qs || []).map(q => { const c = Object.assign({}, q); delete c.qid; return c; });
function bankDiff(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = JSON.stringify(before[k] || null), b = JSON.stringify(after[k] || null);
    if (a !== b) out[k] = { before: (before[k] || { questions: [] }).questions.length, after: shape((after[k] || {}).questions) };
  }
  return out;
}
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

const cases = {};
function pregenCase(name, args, script) {
  const d = makeDataDir("cli-v1");
  try {
    const before = qbankFile(d);
    const r = runCli(d, "pregen.mjs", args, script);
    cases[name] = { status: r.status, out: norm(r.out, d), bank: bankDiff(before, qbankFile(d)), calls: calls(d).map(c => c.kind) };
  } finally { removeDir(d); }
}
function auditCase(name, args, script) {
  const d = makeDataDir("cli-v1");
  try {
    const before = qbankFile(d);
    const r = runCli(d, "audit_qbank.mjs", args, script);
    let report = [];
    try { report = fs.readFileSync(path.join(d, "audit-report.jsonl"), "utf8").split("\n").filter(Boolean).map(l => { const o = JSON.parse(l); delete o.at; return o; }); } catch (_) {}
    cases[name] = { status: r.status, out: norm(r.out, d), bank: bankDiff(before, qbankFile(d)), report, calls: calls(d).map(c => c.kind) };
  } finally { removeDir(d); }
}
function exportCase(name, args) {
  const d = makeDataDir("cli-v1");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "yy-cli-v1-out-"));
  try {
    const r = runCli(d, "export_apple.mjs", ["--no-voice", "--out", out, ...args], { engines: {} });
    const files = fs.existsSync(out) ? walk(out) : [];
    const qbank = Object.fromEntries(files.filter(f => f.startsWith("qbank/")).map(f => [f, sha(fs.readFileSync(path.join(out, f), "utf8"))]));
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")); delete manifest.exportedAt; } catch (_) {}
    cases[name] = { status: r.status, out: norm(r.out, d, out), fileCount: files.length, topDirs: [...new Set(files.map(f => f.split("/")[0]))], qbank, manifest };
  } finally { removeDir(d); removeDir(out); }
}

pregenCase("pregen dry G4 (all kinds, both langs)", ["--dry", "--grades", "4", "--provider", "stubgen", "--judge", "stubjudge"], SCRIPT);
pregenCase("pregen zh quiz, one job, v1 judge", ["--grades", "4", "--only", "quiz", "--limit", "1", "--langs", "zh", "--provider", "stubgen", "--judge", "stubjudge"], SCRIPT);
pregenCase("pregen en quiz, one job, v1 judge", ["--grades", "4", "--only", "quiz", "--limit", "1", "--langs", "en", "--provider", "stubgen", "--judge", "stubjudge"], SCRIPT);
pregenCase("pregen unknown judge engine", ["--grades", "4", "--only", "quiz", "--limit", "1", "--provider", "stubgen", "--judge", "cluade"], SCRIPT);
auditCase("audit dry", ["--prefix", "BC.MATH.G4.NUM.01", "--judge", "stubjudge", "--dry"], Object.assign({}, SCRIPT, { judgeV1: { pass: false, problems: ["scripted"], bad: [0] } }));
auditCase("audit removes flagged question", ["--prefix", "BC.MATH.G4.NUM.01", "--judge", "stubjudge"], Object.assign({}, SCRIPT, { judgeV1: { pass: false, problems: ["scripted"], bad: [0] } }));
exportCase("export default (no voice)", []);

if (RECORD) {
  fs.writeFileSync(FIXTURE, JSON.stringify({ recordedAt: "before #45 script changes (base 30752f2)", cases }, null, 1) + "\n");
  console.log("recorded " + Object.keys(cases).length + " cases -> " + path.relative(ROOT, FIXTURE));
  for (const [k, v] of Object.entries(cases)) console.log("  " + k + "  exit " + v.status);
} else {
  const base = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).cases;
  /* #45 唯一有意的改动：manifest 里 tags 那条说明分清了「离线内容包保留 tags」和「孩子作答接口不下发 tags」（字段本身一个没动） */
  const exp = base["export default (no voice)"].manifest;
  check("the recorded tags note is the old ambiguous one (this intentional change is applied explicitly)", /绝不能下发给客户端/.test(exp.notes[0]));
  exp.notes[0] = "qbank 每题的 tags 与 options 位置对齐：正确项 'ok'，干扰项是 misconceptions.json 里的误区 id（或 'other'）。这是离线内容 / 维护包，tags（和 qid、visual）按原样保留，供判分后的误区诊断和回补；孩子作答时的界面 / 接口绝不能在作答前展示或下发 tags——'ok' 的位置就是答案。Node 端的答题 HTTP（/api/quiz/session）本来就不下发 answerIndex / explain / tags，由服务端判分。";
  console.log("legacy CLI output and side effects match the pre-change recording");
  for (const [k, v] of Object.entries(base)) {
    const now = cases[k];
    check(k + ": same exit code", now && now.status === v.status, now && now.status);
    for (const f of Object.keys(v).filter(f => f !== "status")) {
      const same = JSON.stringify(now && now[f]) === JSON.stringify(v[f]);
      check(k + ": same " + f, same, same ? undefined : { was: JSON.stringify(v[f]).slice(0, 600), now: JSON.stringify(now && now[f]).slice(0, 600) });
    }
  }
  process.exitCode = summary() ? 0 : 1;
}
