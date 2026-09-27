/*
 * v2 审稿的旁路存储（#44）：<DATA_ROOT>/qbank-review/ 下的 JSON 文件，和题库、孩子数据、导出包都分开。
 *
 *   createReviewStore({ root, fs }) → { dir, writeRecord, readRecord, listRecords, writeDraft, readDraft, listDrafts, writeReport, readReport }
 *     records/<reviewKey>.json   每个被审过的内容版本的结论（含完整组成部分，复用时逐项比对）
 *     drafts/<draftId>.json      每道候选题的当前状态（needs_human / exhausted / error / passed / published …）
 *     reports/<runId>.json       每次运行的报告
 *     dry/…                      dry-run 的同样三类，和正式的互不相干（正式运行不读这里）
 *
 * root 必须是调用方显式给的绝对路径（server 传 DATA_ROOT）；fs 注入（测试用它造写 / 改名故障）。
 * 写入 = tmp + rename；任何失败都抛出、清掉 tmp、不动旧文件——调用方据此拦住发布。读不存在 → null；读到坏 JSON → 抛错。
 */
"use strict";

const path = require("path");

const DIR_NAME = "qbank-review";
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const KINDS = { records: "reviewKey", drafts: "draftId", reports: "runId" };

function createReviewStore(opts) {
  const { root, fs } = opts || {};
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new TypeError("createReviewStore needs an explicit absolute DATA_ROOT");
  if (!fs || typeof fs.writeFileSync !== "function" || typeof fs.renameSync !== "function") throw new TypeError("createReviewStore needs an fs");
  const dir = path.join(root, DIR_NAME);
  let seq = 0;
  const fileOf = (kind, id, o) => {
    if (typeof id !== "string" || !ID_RE.test(id) || id === "." || id === "..") throw new TypeError(`unsafe ${KINDS[kind]}: ${JSON.stringify(id)}`);
    return path.join(dir, o && o.dry ? "dry" : "", kind, id + ".json");
  };
  function write(kind, obj, o) {
    if (!obj || typeof obj !== "object") throw new TypeError(kind + " entry must be an object");
    const file = fileOf(kind, obj[KINDS[kind]], o);
    const tmp = file + ".tmp-" + process.pid + "-" + (++seq);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* tmp 可能根本没写出来 */ }
      const err = new Error(`qbank review store: could not write ${kind}/${path.basename(file)}: ${e.message}`);
      err.code = e.code || "REVIEW_STORE_WRITE";
      throw err;
    }
  }
  function read(kind, id, o) {
    const file = fileOf(kind, id, o);
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
    return JSON.parse(raw);
  }
  function listDrafts(o) {
    const d = path.join(dir, o && o.dry ? "dry" : "", "drafts");
    let names = [];
    try { names = fs.readdirSync(d).filter(n => n.endsWith(".json")).sort(); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const out = [];
    for (const n of names) {
      const x = read("drafts", n.slice(0, -5), o);
      if (x && (!o || !o.bankKey || x.bankKey === o.bankKey)) out.push(x);
    }
    return out;
  }
  /* 全部审稿记录（#45：pregen / audit / v2 导出判断「这道题此刻这个版本」有没有更新的不过，要看所有审稿引擎的记录）。
   * 读不动的文件不跳过、不猜，放进 errors 交给调用方决定（导出据此拒绝、命令行记故障，不在证据不全时宣称资格）。 */
  function listRecords(o) {
    const d = path.join(dir, o && o.dry ? "dry" : "", "records");
    let names = [];
    try { names = fs.readdirSync(d).filter(n => n.endsWith(".json")).sort(); }
    catch (e) { if (e.code === "ENOENT") return { records: [], errors: [] }; throw e; }
    const records = [], errors = [];
    for (const n of names) {
      try {
        const x = read("records", n.slice(0, -5), o);
        if (!x || typeof x !== "object" || x.reviewKey !== n.slice(0, -5)) errors.push({ file: n, message: "record file name does not match its reviewKey" });
        else records.push(x);
      } catch (e) { errors.push({ file: n, message: String(e && e.message).slice(0, 200) }); }
    }
    return { records, errors };
  }
  return {
    dir, listRecords,
    writeRecord: (r, o) => write("records", r, o), readRecord: (k, o) => read("records", k, o),
    writeDraft: (r, o) => write("drafts", r, o), readDraft: (k, o) => read("drafts", k, o), listDrafts,
    writeReport: (r, o) => write("reports", r, o), readReport: (k, o) => read("reports", k, o)
  };
}

module.exports = { createReviewStore, REVIEW_STORE_DIR: DIR_NAME };
