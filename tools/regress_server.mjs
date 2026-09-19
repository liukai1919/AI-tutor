#!/usr/bin/env node
/*
 * 服务端健壮性回归（issue #15 / #16 / #17）。
 *
 *   node tools/regress_server.mjs
 *
 * 全程隔离：临时目录当 YY_DATA_DIR、随机端口、YY_DEMO=1（不探测也不启用任何 AI 引擎，
 * 只吃随包的课程/卷子/题库，零成本），跑完删掉。不碰仓库里的真实账号和孩子数据。
 *
 *   #15  畸形 absolute-form URL 只让那一个请求 400，进程不退
 *   #17  单元测验答案只认合法整数下标；null/false/""/小数/越界/缺失都算没作答，全空卷不入成绩
 *   #16  写盘失败：记分类请求回 500 + saveFailed 并回滚内存（重试不重复记分、重启不丢）；
 *        生成类请求内容照给 + saveFailed 提示，后台重试落盘
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "yy-regress-"));
let PORT = 0, child = null, log = "", passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok    " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }).on("error", rej);
});

async function start() {
  log = "";
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, YY_DATA_DIR: DATA, PORT: String(PORT), YY_DEMO: "1", YY_SAVE_RETRY_MS: "300" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.exited = false;
  child.on("exit", code => { child.exited = true; child.code = code; });
  child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/auth/profiles`)).ok) return; } catch (_) {}
    if (child.exited) break;
    await sleep(100);
  }
  throw new Error("server did not start:\n" + log);
}
async function stop() {
  if (!child || child.exited) return;
  const done = new Promise(r => child.on("exit", r));
  child.kill();
  await done;
}

let token = "";
async function call(method, p, body, tok) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method, headers: { "content-type": "application/json", "x-session": tok === undefined ? token : tok },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
/* 原样发一行请求（http.request/fetch 会先把畸形地址拦在客户端） */
function rawRequest(line) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, "127.0.0.1", () => s.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let buf = "";
    s.on("data", d => buf += d); s.on("end", () => resolve(buf)); s.on("error", reject);
    s.setTimeout(3000, () => { s.destroy(); resolve(buf); });
  });
}
const kidFile = (kidId, f) => path.join(DATA, "data", "kids", kidId, f);
const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
/* 让某个文件稳定写不进去：在它的 .tmp 位置放一个目录（writeFileSync 报 EISDIR） */
const block = (kidId, f) => fs.mkdirSync(kidFile(kidId, f + ".tmp"), { recursive: true });
const unblock = (kidId, f) => fs.rmSync(kidFile(kidId, f + ".tmp"), { recursive: true, force: true });

async function main() {
  // 同 api/index.js：数据目录是全新的，落标记跳过「从 app 目录接管旧数据」，别把仓库里的真数据拷进来
  fs.mkdirSync(path.join(DATA, "data"), { recursive: true });
  fs.writeFileSync(path.join(DATA, ".migrated-from-app"), "regress\n");
  fs.writeFileSync(path.join(DATA, "config.json"), "{}\n");
  if (fs.existsSync(path.join(ROOT, "qbank.json"))) fs.cpSync(path.join(ROOT, "qbank.json"), path.join(DATA, "qbank.json"));
  PORT = await freePort();
  await start();

  console.log("#15 malformed request URL");
  const raw = await rawRequest("GET http://[ HTTP/1.1");
  check("malformed absolute-form URL -> 400", /^HTTP\/1\.1 400/.test(raw), raw.slice(0, 80));
  await sleep(200);
  check("process still alive", !child.exited, log.slice(-300));
  check("origin-form request still works", (await call("GET", "/api/auth/profiles", undefined, "")).status === 200);
  const abs = await rawRequest(`GET http://127.0.0.1:${PORT}/api/auth/profiles HTTP/1.1`);
  check("legal absolute-form request still works", /^HTTP\/1\.1 200/.test(abs), abs.slice(0, 80));

  // 造号：家长 + 两个孩子，用第二个孩子的身份做题
  const reg = await call("POST", "/api/auth/register", { username: "regress", password: "regress123", name: "T" }, "");
  if (reg.status !== 200) throw new Error("register failed: " + JSON.stringify(reg));
  const parentTok = reg.body.token;
  await call("POST", "/api/kids", { name: "A", pin: "1111" }, parentTok);
  await call("POST", "/api/kids", { name: "B", pin: "2222" }, parentTok);
  const kids = (await call("GET", "/api/auth/profiles", undefined, "")).body.kids;
  const kidB = kids.find(k => k.name === "B").id;
  token = (await call("POST", "/api/auth/login", { kidId: kidB, pin: "2222" }, "")).body.token;

  console.log("#17 unit-test answers are validated, not coerced");
  const ut = await call("POST", "/api/unit-test", { grade: 4, strand: "number", lang: "en" });
  if (ut.status !== 200 || !ut.body.packed) throw new Error("expected the bundled unit test: " + JSON.stringify(ut.body).slice(0, 200));
  const set = ut.body.set, n = set.questions.length;
  const attempt = answers => call("POST", "/api/unit-test/attempt", { id: set.id, answers, ms: 1000 });
  const attemptsOnDisk = () => (readJson(kidFile(kidB, "unit-tests.json")).find(r => r.id === set.id).attempts || []).length;
  const progressOnDisk = () => { try { return readJson(kidFile(kidB, "progress.json")); } catch (_) { return {}; } };
  const tally = p => Object.values(p).reduce((s, e) => s + (e.right || 0) + (e.wrong || 0), 0);

  let r = await attempt(Array(n).fill(null));
  check("all-null paper -> answered 0, skipped", r.status === 200 && r.body.answered === 0 && r.body.skipped === true, r.body);
  r = await attempt([false, "", 1.5, 7, "2", {}, [1], -1, true, -0.4].slice(0, n));
  check("false / \"\" / 1.5 / 7 / \"2\" / {} / [1] / -1 / true -> all unanswered", r.body.answered === 0 && r.body.skipped === true, r.body);
  r = await attempt([]);
  check("missing answers -> unanswered", r.body.answered === 0 && r.body.skipped === true, r.body);
  check("none of those left an attempt or any progress", attemptsOnDisk() === 0 && tally(progressOnDisk()) === 0);

  console.log("#16 a failed save is reported and rolled back");
  // (a) 逐题自报：/api/progress
  const cid = set.questions.find(q => q.curriculumId).curriculumId;
  const post = () => call("POST", "/api/progress", { curriculumId: cid, event: "practiced-right" });
  r = await post();
  check("baseline save ok (right=1 on disk)", r.status === 200 && progressOnDisk()[cid].right === 1, r.body);
  block(kidB, "progress.json");
  r = await post();
  check("blocked write -> 500 + saveFailed", r.status === 500 && r.body.saveFailed === true && !r.body.ok, r);
  let mem = (await call("GET", "/api/progress?grade=4")).body.items[cid];
  check("memory rolled back to what is on disk (right=1)", mem && mem.right === 1 && progressOnDisk()[cid].right === 1, mem);
  unblock(kidB, "progress.json");
  r = await post();
  check("retry after recovery counts exactly once (right=2)", r.status === 200 && r.body.entry.right === 2 && progressOnDisk()[cid].right === 2, r.body);

  // (b) 交卷：逐题进度 + 成绩单两个文件一笔记
  const before = tally(progressOnDisk());
  const valid = set.questions.map((q, i) => i < 2 ? q.answerIndex : -1);   // 答两题，都对
  block(kidB, "unit-tests.json");
  r = await attempt(valid);
  check("attempt with unit-tests.json blocked -> 500 + saveFailed", r.status === 500 && r.body.saveFailed === true, r);
  mem = (await call("GET", "/api/progress?grade=4")).body.items;
  check("no half-recorded paper: progress untouched on disk and in memory, no attempt",
    tally(progressOnDisk()) === before && tally(mem) === before && attemptsOnDisk() === 0,
    { disk: tally(progressOnDisk()), mem: tally(mem), before });
  unblock(kidB, "unit-tests.json");
  r = await attempt(valid);
  check("resubmit after recovery -> scored once (2 right, 1 attempt)",
    r.status === 200 && r.body.right === 2 && r.body.answered === 2 && attemptsOnDisk() === 1 && tally(progressOnDisk()) === before + 2, r.body);
  r = await attempt(set.questions.map(() => 0));
  check("legal 0..3 answers still accepted", r.status === 200 && r.body.answered === n && attemptsOnDisk() === 2, r.body);

  // (c) 闯关结算：存不下把场次票还回去
  const qs = await call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" });
  if (qs.status === 200 && qs.body.session) {
    const results = qs.body.questions.slice(0, 3).map(q => ({ qid: q.qid, picked: 0 }));
    const finish = () => call("POST", "/api/quiz/finish", { curriculumId: cid, session: qs.body.session, results });
    const t0 = tally(progressOnDisk());
    block(kidB, "progress.json");
    r = await finish();
    check("quiz finish blocked -> 500 + saveFailed", r.status === 500 && r.body.saveFailed === true, r);
    unblock(kidB, "progress.json");
    r = await finish();
    check("same ticket can be resubmitted, scored once", r.status === 200 && r.body.ok && tally(progressOnDisk()) === t0 + results.length, r.body);
    r = await finish();
    check("a settled ticket is still one-shot", r.status === 400 && r.body.staleSession === true, r.body);
  } else console.log("  skip  quiz ticket (no bundled bank for " + cid + ")");

  // (d) 生成类：内容照给 + 提示，后台重试落盘
  block(kidB, "history.json");
  r = await call("POST", "/api/lesson", { mode: "teach", curriculumId: cid, lang: "en", grade: "4" });
  if (r.status === 200 && r.body.packed) {
    check("lesson still delivered, flagged saveFailed + warning", r.body.saveFailed === true && !!r.body.warning && !!r.body.lesson, Object.keys(r.body));
    check("not on disk yet", !fs.existsSync(kidFile(kidB, "history.json")));
    unblock(kidB, "history.json");
    await sleep(1200);
    const onDisk = fs.existsSync(kidFile(kidB, "history.json")) ? readJson(kidFile(kidB, "history.json")) : [];
    check("background retry wrote it once the disk recovered", onDisk.some(h => h.id === r.body.lessonId), onDisk.length);
  } else { unblock(kidB, "history.json"); console.log("  skip  keep-mode lesson (no bundled lesson for " + cid + "): " + r.status); }

  // (e) 重启：磁盘上的就是全部
  const diskBefore = JSON.stringify(progressOnDisk());
  await stop(); await start();
  mem = (await call("GET", "/api/progress?grade=4")).body.items;
  check("after restart the server agrees with the disk", mem[cid].right === JSON.parse(diskBefore)[cid].right && attemptsOnDisk() === 2, mem[cid]);
  check("server never crashed along the way", !child.exited);
}

main().catch(e => { failed++; console.error("ERROR " + (e.stack || e)); if (log) console.error("--- server log tail ---\n" + log.slice(-1500)); })
  .finally(async () => {
    await stop();
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
