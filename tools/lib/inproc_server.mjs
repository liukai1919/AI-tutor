/*
 * 进程内加载 server.js 的隔离夹具（#43）：临时 DATA_ROOT（demo 题库 + 空 config + 迁移标记，见 test_fixtures.mjs），
 * 课程/技能图谱/课文/图形契约照常从仓库里已跟踪的文件读。不 listen、不探测引擎、不碰真实 config/qbank/孩子数据。
 *
 *   const srv = loadIsolatedServer("qbank-seam");   // { S, DATA, cleanup }
 *   const eng = installStubEngine(srv.S);            // eng.id 是注入进 ADAPTERS 的假引擎名；eng.calls 记下每次调用
 *   eng.queue(json或函数)                            // 依次返回；用完再调用就抛错
 *
 * 一个进程只能加载一次（require 缓存 + 进程级环境变量），所以每个用到它的测试文件自己一个进程。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { prepareIsolatedDataDir } from "./test_fixtures.mjs";

export function loadIsolatedServer(marker) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "yy-" + marker + "-"));
  prepareIsolatedDataDir(DATA, { marker });
  /* 不设 YY_DEMO：技能图谱只在非 demo 下加载，出题提示词要用到它 */
  delete process.env.YY_DEMO;
  process.env.YY_DATA_DIR = DATA;
  const require = createRequire(import.meta.url);
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  let S;
  try { S = require("../../server.js"); } finally { console.log = log; console.warn = warn; }
  if (path.resolve(S.DATA_ROOT) !== path.resolve(DATA)) throw new Error("server.js did not pick up the isolated DATA_ROOT");
  return { S, DATA, cleanup: () => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {} } };
}

export function installStubEngine(S, id = "stub") {
  const calls = [], replies = [];
  S.ADAPTERS[id] = async (sys, question, imageB64, mediaType, lang, opts) => {
    calls.push({ sys, question, lang, schema: opts && opts.schema, hint: opts && opts.hint });
    if (!replies.length) throw new Error("stub engine: no reply queued");
    const r = replies.shift();
    return typeof r === "function" ? r(sys, opts) : JSON.parse(JSON.stringify(r));
  };
  return { id, calls, queue: (...rs) => { replies.push(...rs); }, pending: () => replies.length, reset: () => { calls.length = 0; replies.length = 0; } };
}

/* 跑一段会往 console 里吵的代码，吵的内容收进数组（断言可以看，终端不刷屏） */
export async function quiet(fn) {
  const lines = [], log = console.log, warn = console.warn;
  console.log = (...a) => lines.push(a.join(" ")); console.warn = console.log;
  try { return { value: await fn(), lines }; }
  catch (e) { e.lines = lines; throw e; }
  finally { console.log = log; console.warn = warn; }
}
