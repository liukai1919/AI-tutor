#!/usr/bin/env node
/*
 * 存储提交语义回归（#16 返工，按 Codex 复审 20260925-82d9cc0 的两处 P1）。
 *
 *   node tools/regress_storage.mjs
 *
 * 隔离零成本（tools/lib/isolated_server.mjs），另外用 NODE_OPTIONS 预载 tools/lib/fault_rename.cjs，
 * 让指定文件的 rename 抛 EPERM——这是 regress_server.mjs 里「.tmp 位置放目录」那招够不到的阶段。
 *
 *   A  rename 半途失败：progress.json 已换上、unit-tests.json 换不上 → 两个都退回，500 saveFailed；
 *      解除后原样重交 → 只记一次（progress +2、attempt 1）
 *   B  keep 模式欠着的内容不能被后来的回滚丢掉：生成卷子写不上（200 + saveFailed，内容照给）→
 *      交卷又写不上（500）→ 卷子还在内存里；磁盘恢复后后台重试把卷子和（重交后的）成绩都落盘
 *   C  keep 之后一次成功的普通写入把欠账一起结清（不再有 unsaved / pending）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, makeChecker, sleep } from "./lib/isolated_server.mjs";

const { check, summary } = makeChecker();
const preload = fileURLToPath(new URL("./lib/fault_rename.cjs", import.meta.url)).replace(/\\/g, "/");
const srv = await launch({ prefix: "yy-storage-", env: { NODE_OPTIONS: `--require "${preload}"`, YY_SAVE_RETRY_MS: "200" } });
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } };
const tally = p => Object.values(p || {}).reduce((n, e) => n + (e.right || 0) + (e.wrong || 0), 0);
const failRename = (file, on) => { const m = path.join(srv.DATA, "fail-rename-" + file); if (on) fs.writeFileSync(m, "1"); else fs.rmSync(m, { force: true }); };
let exitCode = 1;
try {
  const fam = await srv.family("storage", ["A", "B", "C"]);
  const pf = k => srv.kidFile(fam.kids[k], "progress.json"), uf = k => srv.kidFile(fam.kids[k], "unit-tests.json");

  console.log("A  rename fails half-way through a two-file commit");
  srv.token = fam.kidTok.A;
  let made = await srv.call("POST", "/api/unit-test", { grade: 4, strand: "number", lang: "en" });
  check("bundled paper served and archived", made.status === 200 && made.body.packed === true && read(uf("A")).length === 1, made.body && made.body.packed);
  const set = made.body.set;
  const body = { id: set.id, answers: set.questions.map((q, i) => i < 2 ? q.answerIndex : -1), ms: 1000 };
  failRename("unit-tests.json", true);
  let r = await srv.call("POST", "/api/unit-test/attempt", body);
  check("attempt -> 500 saveFailed", r.status === 500 && r.body.saveFailed === true, r);
  check("progress.json restored on disk (0 answers), no attempt on disk", tally(read(pf("A"))) === 0 && (read(uf("A"))[0].attempts || []).length === 0, { prog: read(pf("A")), ut: read(uf("A")) });
  let mem = (await srv.call("GET", "/api/progress?grade=4")).body.items;
  check("progress rolled back in memory too", tally(mem) === 0, mem);
  check("log says the partial save was rolled back", /partial save rolled back: 1 of 1/.test(srv.log), srv.log.slice(-400));
  failRename("unit-tests.json", false);
  r = await srv.call("POST", "/api/unit-test/attempt", body);
  check("retry -> 200, scored exactly once (progress 2, attempts 1)", r.status === 200 && r.body.right === 2 && tally(read(pf("A"))) === 2 && read(uf("A"))[0].attempts.length === 1, { r: r.body, prog: tally(read(pf("A"))), attempts: read(uf("A"))[0].attempts.length });
  check("no .tmp / .undo left behind", !fs.readdirSync(path.dirname(pf("A"))).some(f => /\.(tmp|undo)$/.test(f)), fs.readdirSync(path.dirname(pf("A"))));

  console.log("B  a later rollback must not drop content promised for retry (keep mode)");
  srv.token = fam.kidTok.B;
  fs.mkdirSync(uf("B") + ".tmp", { recursive: true });   // unit-tests.json 稳定写不进去（EISDIR）
  made = await srv.call("POST", "/api/unit-test", { grade: 4, strand: "number", lang: "en" });
  check("paper generated: 200 + saveFailed warning, content delivered", made.status === 200 && made.body.saveFailed === true && made.body.set && made.body.set.questions.length === 8, made.body && made.body.warning);
  const setB = made.body.set;
  const bodyB = { id: setB.id, answers: setB.questions.map(q => q.answerIndex), ms: 1000 };
  r = await srv.call("POST", "/api/unit-test/attempt", bodyB);
  check("attempt while disk still broken -> 500 saveFailed", r.status === 500 && r.body.saveFailed === true, r);
  let list = (await srv.call("GET", "/api/unit-test/sets?grade=4")).body.items;
  check("paper still in memory after the failed attempt (not wiped by the rollback)", list.length === 1 && list[0].id === setB.id, list);
  check("progress not double-counted in memory (attempt fully undone)", tally((await srv.call("GET", "/api/progress?grade=4")).body.items) === 0);
  fs.rmdirSync(uf("B") + ".tmp");
  await sleep(700);
  check("background retry wrote the paper to disk once the disk recovered", read(uf("B")) && read(uf("B")).length === 1 && read(uf("B"))[0].id === setB.id, read(uf("B")));
  r = await srv.call("POST", "/api/unit-test/attempt", bodyB);
  check("resubmitted attempt -> 200, 8/8, on disk once", r.status === 200 && r.body.right === 8 && read(uf("B"))[0].attempts.length === 1 && tally(read(pf("B"))) === 8, { r: r.body, attempts: read(uf("B")) && read(uf("B"))[0].attempts.length });

  console.log("C  a successful ordinary write settles the earlier debt");
  srv.token = fam.kidTok.C;
  fs.mkdirSync(uf("C") + ".tmp", { recursive: true });
  made = await srv.call("POST", "/api/unit-test", { grade: 4, strand: "number", lang: "en" });
  check("paper generated with saveFailed", made.status === 200 && made.body.saveFailed === true);
  fs.rmdirSync(uf("C") + ".tmp");
  r = await srv.call("POST", "/api/unit-test/attempt", { id: made.body.set.id, answers: made.body.set.questions.map(q => q.answerIndex), ms: 1000 });
  check("attempt right after recovery -> 200 and the paper + attempt are on disk", r.status === 200 && read(uf("C")) && read(uf("C")).length === 1 && read(uf("C"))[0].attempts.length === 1, read(uf("C")));
  await sleep(500);
  check("no retry log for kid C after the debt was settled by the ordinary write", !new RegExp("retry ok: " + fam.kids.C).test(srv.log));

  console.log("D  restart: disk and memory agree");
  await srv.restart();
  list = (await srv.call("GET", "/api/unit-test/sets?grade=4", undefined, fam.kidTok.B)).body.items;
  check("kid B's paper and attempt survive a restart", list.length === 1 && list[0].last && list[0].last.right === 8, list);
  check("server never crashed", !srv.child.exited);
  exitCode = summary() ? 0 : 1;
} catch (e) {
  console.error("\nstorage regress aborted:", e && e.stack || e);
  console.error(srv.log.slice(-1500));
} finally {
  await srv.stop();
  srv.cleanup();
}
process.exit(exitCode);
