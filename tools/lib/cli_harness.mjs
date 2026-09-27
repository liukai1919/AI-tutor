/*
 * 命令行脚本的隔离子进程测试夹具（#45）。
 *
 *   const d = makeDataDir("cli-v2", { config })   // 临时 DATA_ROOT：demo 题库 + config（默认空）+ 迁移标记（test_fixtures.mjs）
 *   const r = runCli(d, "pregen.mjs", ["--review", "v2", ...], script)   // 真实脚本，子进程 + 预载假引擎（cli_stub_preload.mjs）
 *     → { status, out }（stdout+stderr）
 *   calls(d) / ledger(d) / bank(d, key) / norm(text, d)
 *
 * 子进程一律 spawnSync：父进程不留挂起的句柄，退出码靠 process.exitCode（Windows 上强退会有句柄崩溃）。
 * 子进程继承父进程的 NODE_OPTIONS（比如复核时的个人文件拒绝守卫）；假引擎预载器用 --import 另加。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareIsolatedDataDir } from "./test_fixtures.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRELOAD = pathToFileURL(path.join(ROOT, "tools", "lib", "cli_stub_preload.mjs")).href;

export function makeDataDir(marker, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yy-" + marker + "-"));
  prepareIsolatedDataDir(dir, { marker });
  if (opts.config) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(opts.config, null, 1));
  return dir;
}
export const removeDir = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} };

let seq = 0;
export function runCli(dataDir, scriptName, args, stubScript, opts = {}) {
  /* NODE_OPTIONS 原样继承：独立复核时父进程带的「只拒绝、不重定向」个人文件守卫（--require …）也要管到真实脚本子进程 */
  const env = Object.assign({}, process.env, { YY_DATA_DIR: dataDir }, opts.env || {});
  delete env.YY_DEMO;
  const nodeArgs = [];
  if (stubScript !== null) {
    const f = path.join(dataDir, "stub-script-" + (++seq) + ".json");
    fs.writeFileSync(f, JSON.stringify(stubScript || {}));
    env.YY_STUB_SCRIPT = f;
    nodeArgs.push("--import", PRELOAD);
  }
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(ROOT, "tools", scriptName), ...args], {
    cwd: ROOT, env, encoding: "utf8", timeout: opts.timeout || 180000, windowsHide: true
  });
  return { status: r.status, signal: r.signal, out: (r.stdout || "") + (r.stderr || "") + (r.error ? "\n[spawn] " + r.error.message : "") };
}

const jsonl = f => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
export const calls = d => jsonl(path.join(d, "stub-calls.jsonl"));
export const ledger = d => jsonl(path.join(d, "usage.jsonl"));
export const qbankFile = d => JSON.parse(fs.readFileSync(path.join(d, "qbank.json"), "utf8"));
export const bank = (d, key) => ((qbankFile(d)[key] || {}).questions || []);
export const resetCalls = d => { try { fs.unlinkSync(path.join(d, "stub-calls.jsonl")); } catch (_) {} };

/* 输出里会随机器 / 时间变的部分换成占位符，剩下的逐字比对 */
export function norm(text, ...dirs) {
  let t = String(text).replace(/\r\n/g, "\n");
  for (const d of dirs.filter(Boolean)) {
    for (const v of [d, d.replace(/\\/g, "/"), d.replace(/\\/g, "\\\\")]) t = t.split(v).join("<TMP>");
  }
  return t
    .replace(/\bq[a-z0-9]{10,}\b/g, "<QID>")
    .replace(/\b\d{2}:\d{2}\b/g, "<MM:SS>")
    .replace(/\b\d+s\b/g, "<N>s")
    .replace(/\b\d+min\b/g, "<N>min")
    .replace(/总大小 [\d.]+ MB/g, "总大小 <N> MB")
    .split("\n").filter(l => !/ExperimentalWarning|--trace-warnings/.test(l)).join("\n");
}
