#!/usr/bin/env node
/*
 * golden_cases.mjs 自己的反向回归（issue #20，Codex 复审 20260925-9c0a8d8）。
 *
 *   node tools/test_golden_gate.mjs
 *
 * 钉住两件事：接口坏了 / 判题错配时黄金用例必须 FAIL、退出码非零，不许当 skip 放过；
 * --update 只要有失败就不许写快照。另外钉住「明确缺 fixture（POST /api/quiz/session 503 needsEngine）→ skip、保留旧快照」和成功更新；
 * 别的接口（如 /api/lesson）回 503 needsEngine 照样是 FAIL；成功路径上意外的 4xx（讲课 400、记练习 403）也是 FAIL；
 * --only 只认 CASES 自有的用例名（toString 之类要 exit 2）。
 *
 * 做法：真的把 golden_cases.mjs 当子进程跑（它自己起隔离服务器，YY_DATA_DIR 临时目录 + YY_DEMO=1，不调任何模型），
 * 故障由 tools/lib/fault_fetch.cjs 预载进 golden 进程、在 fetch 层注入；快照一律用 --expected 指到临时副本。
 * 仓库里的 tools/golden/expected.json 只读，跑前跑后比对字节不变。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, makeChecker } from "./lib/isolated_server.mjs";

const { check, summary } = makeChecker();
const GOLDEN = path.join(ROOT, "tools", "golden_cases.mjs");
const PRELOAD = path.join(ROOT, "tools", "lib", "fault_fetch.cjs");
const REPO_SNAP = path.join(ROOT, "tools", "golden", "expected.json");
const CASE = "quiz-pass-minimal";
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const repoShaBefore = sha(REPO_SNAP);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yy-golden-gate-"));
const original = fs.readFileSync(REPO_SNAP, "utf8");

/* 每个场景一份新的临时快照副本；fault 为 null 时不注入 */
function run(label, fault, extraArgs = [], snapText = original, only = CASE) {
  const snap = path.join(TMP, label + ".json");
  fs.writeFileSync(snap, snapText);
  const env = { ...process.env };
  delete env.YY_FAULT_FETCH;
  if (fault) env.YY_FAULT_FETCH = JSON.stringify(fault);
  const r = spawnSync(process.execPath, ["--require", PRELOAD, GOLDEN, "--only", only, "--expected", snap, ...extraArgs],
    { cwd: ROOT, env, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  return { code: r.status, out, snap, snapAfter: fs.readFileSync(snap, "utf8"), injected: out.includes("[fault_fetch]") };
}
const tail = r => ({ code: r.code, out: r.out.slice(-500) });

const SESSION_500 = { path: "/api/quiz/session", status: 500 };
const ANSWER_500 = { path: "/api/quiz/answer", status: 500 };
const ANSWER_FLIP = { path: "/api/quiz/answer", flip: "correct" };
const SESSION_NO_BANK = { path: "/api/quiz/session", status: 503, body: { needsEngine: true, error: "injected: no bank" } };
/* 同样的 503 needsEngine 落在讲课接口上：不是缺题库，必须 FAIL（Codex 第二轮复审：mastery-table 忽略 teach 返回值，--update 会写坏快照） */
const LESSON_503 = { path: "/api/lesson", status: 503, body: { needsEngine: true, error: "injected: lesson engine down" } };
const REGISTER_TRIP = { path: "/api/auth/register", status: 500 };
/* 4xx 同理：mastery-table 以前不看讲课 / 记练习的返回码，接口拒了照样录出一份「成功」快照 */
const LESSON_400 = { path: "/api/lesson", status: 400, body: { error: "injected: bad lesson request" } };
const PROGRESS_POST_403 = { path: "/api/progress", method: "POST", status: 403, body: { error: "injected: forbidden" } };

try {
  console.log("A  arguments");
  let r = spawnSync(process.execPath, [GOLDEN, "--only", "no-such-case"], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
  check("unknown --only exits 2 instead of a green 0-passed run", r.status === 2 && /unknown case/.test(r.stderr), { code: r.status, err: r.stderr });
  /* 继承来的属性名（toString / constructor）也得当未知用例；register 上挂个绊线，服务起来了就会留下 [fault_fetch] */
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const env = { ...process.env, YY_FAULT_FETCH: JSON.stringify(REGISTER_TRIP) };
    r = spawnSync(process.execPath, ["--require", PRELOAD, GOLDEN, "--only", name], { cwd: ROOT, env, encoding: "utf8", timeout: 60000 });
    check(`inherited name --only ${name}: exit 2, unknown case, server never started`,
      r.status === 2 && /unknown case/.test(r.stderr) && !/\[fault_fetch\]|passed|golden aborted/.test((r.stdout || "") + (r.stderr || "")),
      { code: r.status, out: ((r.stdout || "") + (r.stderr || "")).slice(-300) });
  }

  console.log("B  baseline (no fault) against a temp copy of the snapshot");
  r = run("baseline", null);
  check("baseline: exit 0, 1 passed", r.code === 0 && /1 passed, 0 failed, 0 skipped/.test(r.out), tail(r));

  console.log("C  interface failures must FAIL, never skip");
  for (const [label, fault] of [["session-500", SESSION_500], ["answer-500", ANSWER_500], ["answer-correct-flipped", ANSWER_FLIP]]) {
    r = run(label, fault);
    check(`${label}: fault actually injected`, r.injected, tail(r));
    check(`${label}: FAIL line, 0 passed 1 failed 0 skipped, exit 1`,
      r.code === 1 && r.out.includes("FAIL  " + CASE) && /0 passed, 1 failed, 0 skipped/.test(r.out) && !r.out.includes("skip  " + CASE), tail(r));
  }

  console.log("D  --update with a failure must not touch the snapshot");
  for (const [label, fault] of [["update-session-500", SESSION_500], ["update-answer-500", ANSWER_500], ["update-answer-flipped", ANSWER_FLIP]]) {
    r = run(label, fault, ["--update"]);
    check(`${label}: refuses, exit 1`, r.code === 1 && r.out.includes("refusing to update") && !r.out.includes("recorded "), tail(r));
    check(`${label}: snapshot byte-identical`, r.snapAfter === original, { changed: r.snapAfter !== original });
  }

  console.log("E  explicit missing fixture (503 needsEngine) is a skip, old snapshot kept");
  r = run("no-bank", SESSION_NO_BANK);
  check("no-bank: skip line, 0 passed 0 failed 1 skipped, exit 0", r.code === 0 && r.out.includes("skip  " + CASE) && /0 passed, 0 failed, 1 skipped/.test(r.out), tail(r));
  r = run("update-no-bank", SESSION_NO_BANK, ["--update"]);
  check("update-no-bank: exit 0, says skipped + kept", r.code === 0 && /1 skipped for missing fixture, old snapshot kept/.test(r.out), tail(r));
  check("update-no-bank: snapshot content unchanged", JSON.stringify(JSON.parse(r.snapAfter)) === JSON.stringify(JSON.parse(original)), {});

  console.log("F  a clean --update rewrites only the selected case");
  const orig = JSON.parse(original);
  const stale = { ...orig, [CASE]: { stale: true } };
  r = run("update-ok", null, ["--update"], JSON.stringify(stale, null, 2) + "\n");
  const after = (() => { try { return JSON.parse(r.snapAfter); } catch (_) { return null; } })();
  check("update-ok: exit 0, recorded 1 case", r.code === 0 && /recorded 1 case\(s\), 12 in snapshot/.test(r.out), tail(r));
  check("update-ok: selected case re-recorded equal to the committed snapshot", after && JSON.stringify(after[CASE]) === JSON.stringify(orig[CASE]), after && after[CASE]);
  check("update-ok: other cases and key order untouched",
    after && JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(orig))
      && Object.keys(orig).filter(k => k !== CASE).every(k => JSON.stringify(after[k]) === JSON.stringify(orig[k])), after && Object.keys(after));
  r = run("update-ok-recheck", null, [], r.snapAfter);
  check("update-ok: freshly written snapshot passes a compare run", r.code === 0 && /1 passed, 0 failed/.test(r.out), tail(r));
  check("no temp files left beside the snapshot", fs.readdirSync(TMP).every(f => !f.includes(".tmp-")), fs.readdirSync(TMP));

  console.log("G  503 needsEngine outside POST /api/quiz/session is a FAIL, not a skip (mastery-table, /api/lesson)");
  r = run("lesson-503", LESSON_503, [], original, "mastery-table");
  check("lesson-503: fault actually injected", r.injected, tail(r));
  check("lesson-503: FAIL line (not DIFF / skip), 0 passed 1 failed 0 skipped, exit 1",
    r.code === 1 && r.out.includes("FAIL  mastery-table") && /\/api\/lesson -> 503/.test(r.out)
      && /0 passed, 1 failed, 0 skipped/.test(r.out) && !r.out.includes("skip  mastery-table"), tail(r));
  r = run("update-lesson-503", LESSON_503, ["--update"], original, "mastery-table");
  check("update-lesson-503: fault actually injected", r.injected, tail(r));
  check("update-lesson-503: refuses, exit 1", r.code === 1 && r.out.includes("FAIL  mastery-table") && r.out.includes("refusing to update") && !r.out.includes("recorded "), tail(r));
  check("update-lesson-503: snapshot byte-identical", r.snapAfter === original, { changed: r.snapAfter !== original });

  console.log("H  unexpected 4xx on a success path is a FAIL too (mastery-table: /api/lesson 400, POST /api/progress 403)");
  for (const [label, fault, sig] of [["lesson-400", LESSON_400, /POST \/api\/lesson -> 400/], ["progress-post-403", PROGRESS_POST_403, /POST \/api\/progress -> 403/]]) {
    r = run(label, fault, [], original, "mastery-table");
    check(`${label}: fault actually injected`, r.injected, tail(r));
    check(`${label}: FAIL line naming the call (not DIFF / skip), 0 passed 1 failed 0 skipped, exit 1`,
      r.code === 1 && r.out.includes("FAIL  mastery-table") && sig.test(r.out)
        && /0 passed, 1 failed, 0 skipped/.test(r.out) && !r.out.includes("DIFF  mastery-table") && !r.out.includes("skip  mastery-table"), tail(r));
    r = run("update-" + label, fault, ["--update"], original, "mastery-table");
    check(`update-${label}: fault actually injected`, r.injected, tail(r));
    check(`update-${label}: FAIL + refuses, exit 1`, r.code === 1 && r.out.includes("FAIL  mastery-table") && sig.test(r.out) && r.out.includes("refusing to update") && !r.out.includes("recorded "), tail(r));
    check(`update-${label}: snapshot byte-identical`, r.snapAfter === original, { changed: r.snapAfter !== original });
  }
} finally {
  check("repo tools/golden/expected.json unchanged", sha(REPO_SNAP) === repoShaBefore);
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(summary() ? 0 : 1);
