/*
 * 隔离起一个真实的 server.js 子进程，给测试脚本用（tools/smoke_flows.mjs、tools/golden_cases.mjs）。
 *
 * 全程零成本、不碰仓库里的真实账号和孩子数据：
 *   - 临时目录当 YY_DATA_DIR（跑完删掉），预写 .migrated-from-app 跳过「从 app 目录接管旧数据」；
 *   - YY_DEMO=1：不探测、不启用任何 AI 引擎，只吃随包的课程包 / 卷包 / 题库；
 *   - 随机空闲端口；
 *   - 题库优先拷仓库根目录的 qbank.json（本机有），没有就拷 demo/qbank.json（入库的 BC.* 种子）；
 *   - REGISTRATION_CODE=iso，让测试能注册第二个家庭（服务器默认只放第一位家长自助注册）。
 *
 * 和 tools/regress_server.mjs 里的那套是同一思路，抽出来是为了让新脚本别再复制一遍。
 * regress_server.mjs 本身没动。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }).on("error", rej);
});

export async function launch(opts = {}) {
  const prefix = opts.prefix || "yy-iso-";
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(DATA, "data"), { recursive: true });
  fs.writeFileSync(path.join(DATA, ".migrated-from-app"), prefix + "\n");
  fs.writeFileSync(path.join(DATA, "config.json"), "{}\n");
  let qbankFrom = null;
  for (const cand of [path.join(ROOT, "qbank.json"), path.join(ROOT, "demo", "qbank.json")]) {
    if (fs.existsSync(cand)) { fs.cpSync(cand, path.join(DATA, "qbank.json")); qbankFrom = cand; break; }
  }
  const PORT = await freePort();
  const base = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, YY_DATA_DIR: DATA, PORT: String(PORT), YY_DEMO: "1", YY_SAVE_RETRY_MS: "300", REGISTRATION_CODE: "iso", ...(opts.env || {}) };

  let child = null, log = "";
  async function start() {
    log = "";
    child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.exited = false;
    child.on("exit", code => { child.exited = true; child.code = code; });
    child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${base}/api/auth/profiles`)).ok) return; } catch (_) {}
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
  async function restart() { await stop(); await start(); }
  function cleanup() { fs.rmSync(DATA, { recursive: true, force: true }); }

  /* 统一的 JSON 调用。tok 省略时用 srv.token（当前默认身份）。 */
  const srv = {
    DATA, PORT, base, qbankFrom, token: "",
    get child() { return child; }, get log() { return log; },
    start, stop, restart, cleanup,
    async call(method, p, body, tok) {
      const r = await fetch(base + p, {
        method, headers: { "content-type": "application/json", "x-session": tok === undefined ? srv.token : tok },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    kidFile: (kidId, f) => path.join(DATA, "data", "kids", kidId, f),
    readJson: f => JSON.parse(fs.readFileSync(f, "utf8")),
    /* 造号：一个家长 + 若干孩子，返回 { parentTok, kids:{name:id}, kidTok:{name:token} } */
    async family(username, kidNames) {
      const reg = await srv.call("POST", "/api/auth/register", { username, password: username + "123", name: "P-" + username, registrationCode: "iso" }, "");
      if (reg.status !== 200) throw new Error("register failed: " + JSON.stringify(reg));
      const parentTok = reg.body.token;
      const kids = {}, kidTok = {};
      for (let i = 0; i < kidNames.length; i++) {
        const pin = String(1111 * (i + 1));
        const k = await srv.call("POST", "/api/kids", { name: kidNames[i], pin }, parentTok);
        if (k.status !== 200) throw new Error("create kid failed: " + JSON.stringify(k));
        const list = (await srv.call("GET", "/api/auth/profiles", undefined, "")).body.kids;
        kids[kidNames[i]] = list.find(x => x.name === kidNames[i]).id;
        kidTok[kidNames[i]] = (await srv.call("POST", "/api/auth/login", { kidId: kids[kidNames[i]], pin }, "")).body.token;
      }
      return { parentTok, kids, kidTok };
    }
  };
  await start();
  return srv;
}

/* 小型断言计数器，两个脚本共用 */
export function makeChecker() {
  let passed = 0, failed = 0;
  return {
    check(name, cond, extra) {
      if (cond) { passed++; console.log("  ok    " + name); }
      else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : "")); }
    },
    get passed() { return passed; }, get failed() { return failed; },
    summary() { console.log(`\n${passed} passed, ${failed} failed`); return failed === 0; }
  };
}
