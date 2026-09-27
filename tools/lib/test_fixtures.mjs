/*
 * 隔离测试的数据目录准备（issue #42）。
 *
 * 题库只用入库的 demo/qbank.json（BC.* 种子）。仓库根目录的 qbank.json 是本机个人题库，
 * 这里既不探测也不读，更不会拿它兜底：demo 夹具缺了就直接报错，让测试在起服务器之前失败。
 *
 *   prepareIsolatedDataDir(dir, { marker })  先拷 demo 题库，再建 data/、落 .migrated-from-app（跳过从 app 目录
 *                                             接管旧数据）、写空 config.json
 *   seedDemoQbank(dir)                        只拷题库
 *
 * 目标 dir 必须是刚 mkdtemp 出来的空目录：里面已经有 qbank.json 说明调用方用错了目录，
 * 报错（YY_FIXTURE_EXISTS）且原文件不动，不覆盖。
 * opts.root 只给 tools/test_isolation_fixtures.mjs 用假根目录做受控测试，平时一律省略。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const demoQbankPath = (root = REPO_ROOT) => path.join(root, "demo", "qbank.json");

function fixtureError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* 只看 demo 夹具本身；缺了不找别的 */
function requireDemoQbank(root) {
  const from = demoQbankPath(root);
  let st = null;
  try { st = fs.statSync(from); } catch (_) {}
  if (!st || !st.isFile()) {
    throw fixtureError("YY_FIXTURE_MISSING",
      `test fixture missing: ${from} (tracked demo question bank). Isolated tests only seed from this file and never fall back to the personal root qbank.json.`);
  }
  return from;
}

export function seedDemoQbank(dataDir, opts = {}) {
  const from = requireDemoQbank(opts.root);
  const to = path.join(dataDir, "qbank.json");
  try {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code === "EEXIST") throw fixtureError("YY_FIXTURE_EXISTS", `refusing to overwrite existing ${to}: seed a fresh temp data dir`);
    throw e;
  }
  return { from, to };
}

/* 题库先拷：夹具缺失或目录里已有题库时直接报错，别的文件一个都不写 */
export function prepareIsolatedDataDir(dataDir, opts = {}) {
  const seeded = seedDemoQbank(dataDir, opts);
  fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, ".migrated-from-app"), (opts.marker || "isolated") + "\n");
  fs.writeFileSync(path.join(dataDir, "config.json"), "{}\n");
  return seeded;
}
