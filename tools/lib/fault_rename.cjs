/*
 * 测试用故障注入（只给 tools/regress_storage.mjs 用，通过 NODE_OPTIONS=--require 预载进 server.js 进程）。
 * 数据目录里存在 fail-rename-<文件名> 标记文件时，往那个文件的 rename 抛 EPERM；其余 rename 照常。
 * 思路来自 Codex 复审（20260925-82d9cc0）的 fail-rename.cjs。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const rename = fs.renameSync;
fs.renameSync = function (src, dst) {
  const base = path.basename(String(dst));
  const marker = path.join(process.env.YY_DATA_DIR || "", "fail-rename-" + base);
  if (process.env.YY_DATA_DIR && fs.existsSync(marker)) {
    const e = new Error("test-only simulated rename EPERM on " + base); e.code = "EPERM"; throw e;
  }
  return rename.apply(this, arguments);
};
