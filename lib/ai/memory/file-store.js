/*
 * Learning Events 的文件适配器（#34，#19 Phase 5）：每个所有者一个 JSON 文档，原子替换，同进程排队。
 *
 *   const store = createFileStore({ rootDir, maxBytes, fs });
 *   await store.read(owner)                  → 文档 | null            owner = [userId, kidId]
 *   await store.update(owner, transform)     → { doc, written }       transform(当前文档 | null) 同步返回新文档或 null
 *
 * - rootDir 必填、绝对路径、必须已存在；没有默认目录（不指向现有孩子数据目录或用户目录），也不自动创建。
 * - 文件名 = sha256(JSON.stringify([userId, kidId])) + ".json"，从不把 id 拼进路径；文档里的 owner 不符即坏档。
 * - 读：lstat（不是普通文件 → STORE_CORRUPT；> maxBytes → STORE_TOO_LARGE）→ 严格 UTF-8 → JSON → 信封校验（版本不是 1 → STORE_VERSION）。
 * - 写：transform 的结果先按事件规则完整校验（不合法 → INVALID_TRANSFORM），再序列化规范副本；> maxBytes → CAPACITY；
 *   同目录临时文件 open("wx") → write → fsync → close → rename 覆盖目标。任何一步失败只删这个临时文件，目标保持原样。
 * - 队列：模块级 Map，键 = realpath(rootDir)（win32 转小写）+ 文件名，同进程所有适配器实例共享；read 与 update 都排队，
 *   update 在队列内重读文件。**不支持跨进程并发写**（没有文件锁，后写覆盖）；崩溃留下的 *.tmp 不读也不自动清理；不对目录 fsync。
 * - fs 可注入（默认 fs.promises），只用 realpath / stat / lstat / readFile / open / rename / unlink，供测试做故障注入。
 */
"use strict";

const crypto = require("crypto");
const path = require("path");
const { MemoryError, readRecord, readMethods } = require("./errors.js");
const ev = require("./events.js");

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_MAX_BYTES = 64 * 1024 * 1024;
const FS_METHODS = ["realpath", "stat", "lstat", "readFile", "open", "rename", "unlink"];

/* 同进程所有适配器共享：同一个实际目录里的同一个文件只有一条队列 */
const QUEUES = new Map();
function enqueue(key, task) {
  const prev = QUEUES.get(key) || Promise.resolve();
  const run = prev.then(task);
  const tail = run.then(() => {}, () => {});
  QUEUES.set(key, tail);
  tail.then(() => { if (QUEUES.get(key) === tail) QUEUES.delete(key); });
  return run;
}

const io = (e, what) => (e instanceof MemoryError ? e : new MemoryError("STORE_IO", what, e));
/* fs 抛出的错误对象也是外部值：读 code 本身出错就当不是 ENOENT */
const isEnoent = e => { try { return !!e && e.code === "ENOENT"; } catch (_) { return false; } };

function createFileStore(opts) {
  const o = readRecord(opts, ["rootDir", "maxBytes", "fs"], "INVALID_OPTIONS", "createFileStore options");
  if (typeof o.rootDir !== "string" || !o.rootDir || o.rootDir.includes("\u0000") || !path.isAbsolute(o.rootDir))
    throw new MemoryError("INVALID_OPTIONS", "rootDir must be an absolute path to an existing directory");
  const maxBytes = "maxBytes" in o ? o.maxBytes : DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES) throw new MemoryError("INVALID_OPTIONS", `maxBytes must be an integer in 1–${MAX_MAX_BYTES}`);
  /* fs 方法只按数据属性读一次（getter 不执行、Proxy 异常收成 INVALID_OPTIONS），调用时绑回原对象 */
  const fsObj = "fs" in o ? o.fs : require("fs").promises;
  const m = readMethods(fsObj, FS_METHODS, "INVALID_OPTIONS", "fs");
  const fs = {};
  for (const name of FS_METHODS) fs[name] = (...args) => m[name].apply(fsObj, args);
  const rootDir = o.rootDir;

  /* 第一次用时解析实际目录；失败不缓存，下次再试 */
  let rootP = null;
  function realRoot() {
    if (!rootP) {
      rootP = (async () => {
        const real = await fs.realpath(rootDir);
        if (typeof real !== "string" || !path.isAbsolute(real)) throw new MemoryError("STORE_IO", "rootDir could not be resolved");
        if (!(await fs.stat(real)).isDirectory()) throw new MemoryError("STORE_IO", "rootDir is not a directory");
        return real;
      })();
      rootP.catch(() => { rootP = null; });
    }
    return rootP;
  }

  async function inQueue(owner, task) {
    const file = crypto.createHash("sha256").update(JSON.stringify(owner)).digest("hex") + ".json";
    let real;
    try { real = await realRoot(); } catch (e) { throw io(e, "event store rootDir is not usable"); }
    const key = (process.platform === "win32" ? real.toLowerCase() : real) + "\u0000" + file;
    return enqueue(key, () => task(path.join(real, file)));
  }

  /* 读出字节：不存在 → null；fs 的任何意外（含回包畸形：isFile 抛错、readFile 不给 Buffer）都是 STORE_IO */
  async function readBytes(target) {
    try {
      let st;
      try { st = await fs.lstat(target); } catch (e) { if (isEnoent(e)) return null; throw e; }
      if (!st.isFile()) throw new MemoryError("STORE_CORRUPT", "event document is not a regular file");
      if (!(st.size <= maxBytes)) throw new MemoryError("STORE_TOO_LARGE", "event document exceeds maxBytes");
      const buf = await fs.readFile(target);
      if (!Buffer.isBuffer(buf)) throw new MemoryError("STORE_IO", "fs.readFile did not return bytes");
      if (buf.length > maxBytes) throw new MemoryError("STORE_TOO_LARGE", "event document exceeds maxBytes");
      return buf;
    } catch (e) { throw io(e, "event store read failed"); }
  }

  /* 读出的历史必须整份按事件规则重放通过（不只是信封），坏历史对直接调用 store 的人也读不出、盖不掉。
   * 返回 { state, doc }：doc 是新建的规范文档（事件冻结，数组可改），不是解析出的原对象 */
  async function readDoc(target, owner) {
    const buf = await readBytes(target);
    if (buf === null) return { state: ev.load(null, owner), doc: null };
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf)); } catch (_) {
      throw new MemoryError("STORE_CORRUPT", "event document is not valid UTF-8 JSON");
    }
    /* 文件存在就必须是完整文档：内容为 JSON null 不能当「没有历史」 */
    if (parsed === null) throw new MemoryError("STORE_CORRUPT", "event document is null");
    const state = ev.load(parsed, owner);
    return { state, doc: ev.makeDocument(owner, state.events.slice()) };
  }

  async function writeAtomic(target, bytes) {
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let created = false;
    try {
      const fh = await fs.open(tmp, "wx");
      created = true;
      try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
      await fs.rename(tmp, target);
    } catch (e) {
      if (created) { try { await fs.unlink(tmp); } catch (_) { /* 留下的临时文件不会被读到 */ } }
      throw io(e, "event store write failed");
    }
  }

  /* owner 与服务同一规则：恰好两个自有数据字符串、1–128 字符、无控制字符；不合法在任何 fs 调用之前拒绝 */
  const readOwner = owner => ev.readOwner(owner, "INVALID_INPUT");

  async function read(owner) {
    const own = readOwner(owner);
    return inQueue(own, async target => (await readDoc(target, own)).doc);
  }

  /* transform 的返回值是外部值：探测 then 时 getter 抛错 / 撤销的 Proxy 都收成 INVALID_TRANSFORM */
  function probeThen(next) {
    if (next === null || (typeof next !== "object" && typeof next !== "function")) return false;
    let then;
    try { then = next.then; } catch (_) { throw new MemoryError("INVALID_TRANSFORM", "transform result could not be read"); }
    if (typeof then !== "function") return false;
    try { then.call(next, undefined, () => {}); } catch (_) { /* 只为不留未处理拒绝 */ }
    return true;
  }

  async function update(owner, transform) {
    const own = readOwner(owner);
    if (typeof transform !== "function") throw new MemoryError("INVALID_INPUT", "transform must be a function");
    return inQueue(own, async target => {
      const { state: curState, doc: cur } = await readDoc(target, own);   // 坏历史在这里就失败，transform 不会被调用
      const next = transform(cur);                       // 抛错原样 reject，不写
      if (probeThen(next)) throw new MemoryError("INVALID_TRANSFORM", "transform must be synchronous");
      if (next === null) return { doc: cur === null ? null : ev.makeDocument(own, curState.events.slice()), written: false };
      let st;
      try { st = ev.load(next === undefined ? {} : next, own); } catch (_) {
        throw new MemoryError("INVALID_TRANSFORM", "transform must return a valid event document or null");
      }
      /* 序列化的是校验过的规范副本，不是调用方的对象 */
      const doc = ev.makeDocument(own, st.events);
      const bytes = Buffer.from(JSON.stringify(doc), "utf8");
      if (bytes.length > maxBytes) throw new MemoryError("CAPACITY", "event document would exceed maxBytes");
      await writeAtomic(target, bytes);
      return { doc, written: true };
    });
  }

  return Object.freeze({ read, update });
}

module.exports = { createFileStore, DEFAULT_MAX_BYTES };
