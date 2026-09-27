#!/usr/bin/env node
/*
 * 隔离测试的题库夹具（issue #42）。零成本：只用临时目录，起一个 YY_DEMO=1 的隔离服务器，不调任何模型。
 *
 *   node tools/test_isolation_fixtures.mjs
 *
 *   A  假根目录里同时有「个人」qbank.json 和 demo/qbank.json（内容不同的哨兵）：只拷 demo；
 *      node:fs 全部函数被拦截，碰到假根目录的 qbank.json 就记下并抛错 —— 读、探测都算
 *   B  demo 夹具缺失：明确报 YY_FIXTURE_MISSING，不兜底个人题库，数据目录里什么都没写
 *   C  数据目录里已有 qbank.json：报 YY_FIXTURE_EXISTS，原文件不动（不覆盖）
 *   D  launch()：真实仓库的 demo/qbank.json 原样拷进隔离目录，本进程没碰仓库根的 qbank.json；cleanup 删干净
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, makeChecker, ROOT } from "./lib/isolated_server.mjs";
import { demoQbankPath, prepareIsolatedDataDir, seedDemoQbank } from "./lib/test_fixtures.mjs";

const { check, summary } = makeChecker();
const temps = [];
const tmp = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "yy-fixture-" + tag + "-")); temps.push(d); return d; };

/* 拦截 node:fs：参数里出现禁止路径（按 Windows 不分大小写比较）就记下来并抛错，绝不放行；其余照常执行。
 * 另记所有碰到的路径，用来证明拦截确实生效（正向对照）。 */
const norm = p => { try { return path.resolve(p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : p).toLowerCase(); } catch (_) { return null; } };
function intercept(forbidden, fn) {
  const deny = new Set(forbidden.map(norm)), hits = [], touched = new Set(), saved = [];
  const wrap = (obj, name) => {
    const orig = obj[name];
    saved.push([obj, name, orig]);
    obj[name] = function (...args) {
      for (const a of args) {
        if (typeof a !== "string" && !Buffer.isBuffer(a) && !(a instanceof URL)) continue;
        const n = norm(a);
        if (!n) continue;
        touched.add(n);
        if (deny.has(n)) { hits.push(name + " " + n); throw Object.assign(new Error("forbidden fs access: " + n), { code: "EFORBIDDEN" }); }
      }
      return orig.apply(this, args);
    };
  };
  for (const name of Object.keys(fs)) if (typeof fs[name] === "function" && /^[a-z]/.test(name)) wrap(fs, name);
  for (const name of Object.keys(fs.promises)) if (typeof fs.promises[name] === "function") wrap(fs.promises, name);
  const done = () => { for (const [obj, name, orig] of saved.reverse()) obj[name] = orig; };
  return (async () => { try { return { value: await fn(), hits, touched }; } catch (error) { return { error, hits, touched }; } finally { done(); } })();
}

function fakeRoot({ demo = true } = {}) {
  const root = tmp("root");
  fs.writeFileSync(path.join(root, "qbank.json"), JSON.stringify({ "PERSONAL.SENTINEL|en": { questions: [] } }));
  if (demo) {
    fs.mkdirSync(path.join(root, "demo"));
    fs.writeFileSync(path.join(root, "demo", "qbank.json"), JSON.stringify({ "DEMO.SENTINEL|en": { questions: [] } }));
  }
  return { root, personal: path.join(root, "qbank.json") };
}
const ls = d => fs.readdirSync(d).sort();

let ok = true;
try {
  console.log("A  personal + demo both present: only demo is copied, personal never touched");
  {
    const { root, personal } = fakeRoot();
    const personalBytes = fs.readFileSync(personal, "utf8");
    const data = tmp("data");
    const r = await intercept([personal], () => prepareIsolatedDataDir(data, { marker: "fixture-a", root }));
    check("A: prepare succeeds", !r.error, r.error && r.error.message);
    const copied = fs.readFileSync(path.join(data, "qbank.json"), "utf8");
    check("A: copied bank is the demo sentinel", copied.includes("DEMO.SENTINEL") && !copied.includes("PERSONAL"), copied);
    check("A: returns from = <root>/demo/qbank.json, to = <data>/qbank.json",
      r.value && r.value.from === demoQbankPath(root) && r.value.to === path.join(data, "qbank.json"), r.value);
    check("A: personal qbank.json never read or probed", r.hits.length === 0, r.hits);
    check("A: interceptor was live (it saw the demo fixture and the target)",
      r.touched.has(norm(demoQbankPath(root))) && r.touched.has(norm(path.join(data, "qbank.json"))), [...r.touched]);
    check("A: marker, empty config and data/ written", ls(data).join() === [".migrated-from-app", "config.json", "data", "qbank.json"].join()
      && fs.readFileSync(path.join(data, ".migrated-from-app"), "utf8") === "fixture-a\n"
      && fs.readFileSync(path.join(data, "config.json"), "utf8") === "{}\n" && fs.statSync(path.join(data, "data")).isDirectory(), ls(data));
    check("A: personal file unchanged", fs.readFileSync(personal, "utf8") === personalBytes);
  }

  console.log("B  demo fixture missing: clear error, no fallback, nothing written");
  {
    const { root, personal } = fakeRoot({ demo: false });
    for (const [label, run] of [["prepareIsolatedDataDir", d => prepareIsolatedDataDir(d, { root })], ["seedDemoQbank", d => seedDemoQbank(d, { root })]]) {
      const data = tmp("data");
      const r = await intercept([personal], () => run(data));
      check(`B: ${label} throws YY_FIXTURE_MISSING naming the demo path`,
        r.error && r.error.code === "YY_FIXTURE_MISSING" && r.error.message.includes(demoQbankPath(root)), r.error && r.error.message);
      check(`B: ${label} did not fall back to the personal bank`, r.hits.length === 0 && !fs.existsSync(path.join(data, "qbank.json")), r.hits);
      check(`B: ${label} left the data dir empty`, ls(data).length === 0, ls(data));
    }
  }

  console.log("C  data dir already has a qbank.json: refuse, keep it");
  {
    const { root, personal } = fakeRoot();
    for (const [label, run] of [["prepareIsolatedDataDir", d => prepareIsolatedDataDir(d, { root })], ["seedDemoQbank", d => seedDemoQbank(d, { root })]]) {
      const data = tmp("data");
      fs.writeFileSync(path.join(data, "qbank.json"), "EXISTING");
      const r = await intercept([personal], () => run(data));
      check(`C: ${label} throws YY_FIXTURE_EXISTS`, r.error && r.error.code === "YY_FIXTURE_EXISTS", r.error && r.error.message);
      check(`C: ${label} kept the existing file and wrote nothing else`,
        fs.readFileSync(path.join(data, "qbank.json"), "utf8") === "EXISTING" && ls(data).join() === "qbank.json" && r.hits.length === 0, [ls(data), r.hits]);
    }
  }

  console.log("D  launch(): real repo demo fixture, personal root bank not touched by this process");
  {
    const personal = path.join(ROOT, "qbank.json");
    const r = await intercept([personal], () => launch({ prefix: "yy-fixture-launch-" }));
    const srv = r.value;
    try {
      check("D: launch succeeds", !r.error && srv, r.error && r.error.message);
      check("D: this process never read or probed <repo>/qbank.json", r.hits.length === 0, r.hits);
      if (srv) {
        check("D: qbankFrom is the tracked demo fixture", srv.qbankFrom === demoQbankPath(), srv.qbankFrom);
        check("D: isolated bank is byte-identical to demo/qbank.json",
          fs.readFileSync(path.join(srv.DATA, "qbank.json")).equals(fs.readFileSync(demoQbankPath())));
        check("D: server is up in YY_DEMO mode", (await srv.call("GET", "/api/auth/profiles", undefined, "")).status === 200);
      }
    } finally {
      if (srv) {
        await srv.stop(); srv.cleanup();
        check("D: cleanup removed the isolated data dir", !fs.existsSync(srv.DATA), srv.DATA);
      }
    }
  }
} catch (e) {
  ok = false;
  console.log("  FAIL  crashed: " + (e.stack || e));
} finally {
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
}

process.exitCode = summary() && ok ? 0 : 1;
