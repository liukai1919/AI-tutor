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
 * 跨平台（Windows 录制、纯 Git 的 Linux 复跑）只折叠两处：<TMP> 路径分隔符、语音条数的 steps/missing 拆分，见 canonOut / canonCounts。
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
/* 跨平台比对（#50）：基线在 Windows 上录制，纯 Git 的 Linux checkout 复跑时只有两处和机器有关，录制值和本次结果做同一套处理：
 *   1. <TMP> 开头的临时路径里的分隔符：\ 和 / 视为同一个（只动 <TMP> 后面紧跟的路径段，别处的反斜线原样比对）；
 *   2. 语音条数：export_apple 即使 --no-voice 也按仓库里 data/voice 的预烘语音包算 voice.steps / voice.missing（包不入库，
 *      纯 Git checkout 里没有），两者之和 = 课程里有旁白的步数，只取决于入库的课程包。比对时把一种语言的两项合成
 *      voice.sayable.<lang> = steps + missing；拆分本身另由 voiceSplit 对照本机实际的语音包逐步核对（见 exportCase）。 */
const slashTmp = s => s.replace(/<TMP>(?:[\\/][^\s\\/]+)+/g, m => m.replace(/\\/g, "/"));
const VOICE_LINE = /^  voice\.(steps|missing)\.(zh|en) +(\d+)$/;
const VOICE_KEY = /^voice\.(steps|missing)\.(zh|en)$/;
function canonOut(s) {
  const lines = slashTmp(String(s)).split("\n"), sum = {}, keep = [];
  let at = -1;
  for (const l of lines) {
    const m = VOICE_LINE.exec(l);
    if (!m) { keep.push(l); continue; }
    if (at < 0) at = keep.length;
    sum[m[2]] = (sum[m[2]] || 0) + Number(m[3]);
  }
  if (at >= 0) keep.splice(at, 0, ...Object.keys(sum).sort().map(lang => "  " + ("voice.sayable." + lang).padEnd(34) + String(sum[lang]).padStart(7)));
  return keep.join("\n");
}
function canonCounts(counts) {
  if (!counts) return counts;
  const out = {}, sum = {};
  for (const [k, v] of Object.entries(counts)) {
    const m = VOICE_KEY.exec(k);
    if (m) sum[m[2]] = (sum[m[2]] || 0) + v; else out[k] = v;
  }
  for (const lang of Object.keys(sum).sort()) out["voice.sayable." + lang] = sum[lang];
  return out;
}
function canon(field, v) {
  if (field === "out" && typeof v === "string") return canonOut(v);
  if (field === "manifest" && v && v.counts) return Object.assign({}, v, { counts: canonCounts(v.counts) });
  return v;
}

/* 本机语音包（仓库 data/voice，可选、不入库）：只认 .m4a，和 export_apple 一致 */
function localVoicePack() {
  try { return new Set(fs.readdirSync(path.join(ROOT, "data", "voice")).filter(f => f.endsWith(".m4a")).map(f => f.replace(/\.m4a$/, ""))); }
  catch (_) { return new Set(); }
}
/* 导出的 voice/index.json 逐步对照本机语音包：有旁白且包里有 → 文件名；有旁白但包里没有 → null；没旁白 → null。
 * 哈希按 index.json 里自带的 params 和 note 写明的公式独立重算，数出来的 steps / missing 必须等于 manifest 的计数 */
function voiceSplit(out, counts) {
  const idx = JSON.parse(fs.readFileSync(path.join(out, "voice", "index.json"), "utf8"));
  const p = idx.params || {}, pack = localVoicePack(), problems = [], got = {};
  for (const lang of ["zh", "en"]) {
    const seen = new Set();
    let steps = 0, missing = 0;
    for (const kind of ["standards", "skills"]) {
      const dir = path.join(out, "lessons", kind, lang);
      let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch (_) {}
      for (const f of files) {
        const id = f.replace(/\.json$/, ""); seen.add(id);
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), lesson = d.lesson || d;
        const entries = (idx.index[lang] || {})[id], stepList = lesson.steps || [];
        if (!Array.isArray(entries) || entries.length !== stepList.length) { problems.push(lang + " " + id + ": index length"); continue; }
        stepList.forEach((st, i) => {
          const text = String(st.say || "").trim().slice(0, 2000);
          if (!text) { if (entries[i] !== null) problems.push(lang + " " + id + "#" + i + ": empty say not null"); return; }
          const h = crypto.createHash("sha1").update(JSON.stringify([p.mode, p.refAudio, p.refText, (p.instruct || {})[lang] || "", p.speed, lang, text])).digest("hex");
          if (pack.has(h)) { steps++; if (entries[i] !== h + ".m4a") problems.push(lang + " " + id + "#" + i + ": expected " + h); }
          else { missing++; if (entries[i] !== null) problems.push(lang + " " + id + "#" + i + ": not in pack but " + entries[i]); }
        });
      }
    }
    for (const id of Object.keys(idx.index[lang] || {})) if (!seen.has(id)) problems.push(lang + " " + id + ": indexed but not exported");
    if (steps !== (counts["voice.steps." + lang] || 0) || missing !== (counts["voice.missing." + lang] || 0))
      problems.push(lang + ": counted steps/missing " + steps + "/" + missing + " vs manifest " + (counts["voice.steps." + lang] || 0) + "/" + (counts["voice.missing." + lang] || 0));
    got[lang] = { steps, missing };
  }
  return { pack: pack.size, got, problems: problems.slice(0, 10), problemCount: problems.length };
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
    let split = null;
    if (!RECORD) try { split = voiceSplit(out, (manifest && manifest.counts) || {}); } catch (e) { split = { problemCount: 1, problems: [String(e.message || e)] }; }
    cases[name] = { status: r.status, out: norm(r.out, d, out), fileCount: files.length, topDirs: [...new Set(files.map(f => f.split("/")[0]))], qbank, manifest };
    if (split) Object.defineProperty(cases[name], "voiceSplit", { value: split, enumerable: false });
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
  console.log("cross-platform canonicalization only folds what it documents (#50)");
  const eqOut = (a, b) => canonOut(a) === canonOut(b);
  const vl = (k, n) => "  " + k.padEnd(34) + String(n).padStart(7);
  const block = (zs, zm, es, em, files = 1469) => ["输出：<TMP>", vl("files", files), vl("voice.missing.en", em), vl("voice.missing.zh", zm), vl("voice.steps.en", es), vl("voice.steps.zh", zs), "  总大小 <N> MB", ""].join("\n");
  const blockNoSteps = (zm, em) => ["输出：<TMP>", vl("files", 1469), vl("voice.missing.en", em), vl("voice.missing.zh", zm), "  总大小 <N> MB", ""].join("\n");
  check("slash-only difference after <TMP> is equal", eqOut("报告：<TMP>\\audit-report.jsonl\n", "报告：<TMP>/audit-report.jsonl\n"));
  check("nested <TMP> path, slash-only difference is equal", eqOut("<TMP>\\a\\b.json x", "<TMP>/a/b.json x"));
  check("different file name after <TMP> still differs", !eqOut("报告：<TMP>\\audit-report.jsonl\n", "报告：<TMP>/audit-report2.jsonl\n"));
  check("different directory after <TMP> still differs", !eqOut("<TMP>\\a\\b.json", "<TMP>/c/b.json"));
  check("different text around the path still differs", !eqOut("报告：<TMP>\\x.jsonl", "报表：<TMP>/x.jsonl"));
  check("backslash outside a <TMP> path is left alone", canonOut("C:\\x a\\b") === "C:\\x a\\b" && !eqOut("a\\b", "a/b"));
  check("voice split with the same per-language total is equal (pack present vs absent)", eqOut(block(2258, 728, 2278, 722), blockNoSteps(2986, 3000)));
  check("voice total change (zh missing +1) still differs", !eqOut(block(2258, 728, 2278, 722), block(2258, 729, 2278, 722)));
  check("moving counts between languages still differs", !eqOut(block(2258, 728, 2278, 722), block(2257, 728, 2279, 722)));
  check("non-voice count change still differs", !eqOut(block(2258, 728, 2278, 722), block(2258, 728, 2278, 722, 1470)));
  check("voice.files line is kept verbatim, not folded", canonOut(block(1, 1, 1, 1) + vl("voice.files", 2)).endsWith(vl("voice.files", 2)));
  const cA = { files: 5, "voice.steps.zh": 2258, "qbank.questions": 9, "voice.missing.zh": 728, "voice.steps.en": 2278, "voice.missing.en": 722 };
  const cB = { files: 5, "voice.missing.zh": 2986, "qbank.questions": 9, "voice.missing.en": 3000 };
  const eqC = (a, b) => JSON.stringify(canonCounts(a)) === JSON.stringify(canonCounts(b));
  check("manifest counts: same totals, different split -> equal", eqC(cA, cB) && canonCounts(cA)["voice.sayable.zh"] === 2986 && canonCounts(cA)["voice.sayable.en"] === 3000);
  check("manifest counts: total change still differs", !eqC(cA, Object.assign({}, cB, { "voice.missing.en": 2999 })));
  check("manifest counts: other count change still differs", !eqC(cA, Object.assign({}, cB, { "qbank.questions": 10 })));
  check("manifest counts: other keys keep their order", !eqC({ a: 1, b: 2 }, { b: 2, a: 1 }));
  const recC = canonCounts(exp.counts);
  check("recorded manifest folds to zh 2258+728 and en 2278+722", recC["voice.sayable.zh"] === 2986 && recC["voice.sayable.en"] === 3000
    && !Object.keys(recC).some(k => VOICE_KEY.test(k)), recC);

  console.log("legacy CLI output and side effects match the pre-change recording");
  for (const [k, v] of Object.entries(base)) {
    const now = cases[k];
    check(k + ": same exit code", now && now.status === v.status, now && now.status);
    for (const f of Object.keys(v).filter(f => f !== "status")) {
      const was = canon(f, v[f]), got = canon(f, now && now[f]);
      const same = JSON.stringify(got) === JSON.stringify(was);
      check(k + ": same " + f, same, same ? undefined : { was: JSON.stringify(was).slice(0, 600), now: JSON.stringify(got).slice(0, 600) });
    }
  }
  const vs = cases["export default (no voice)"].voiceSplit;
  console.log("  local voice pack: " + (vs ? vs.pack : "?") + " .m4a (optional, untracked); split " + JSON.stringify(vs && vs.got));
  check("export: voice.steps / voice.missing match this checkout's voice pack step by step", vs && vs.problemCount === 0, vs);
  process.exitCode = summary() ? 0 : 1;
}
