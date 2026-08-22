#!/usr/bin/env node
/*
 * 构建期：把整个应用 + 预生成的课程包 / 题库 / 语音包 + 一个 Node 运行时，
 * 打成用户双击就能装的东西。
 *
 *   Windows  build/YuanyuanMath-<ver>-win-x64-setup.exe   （有 Inno Setup 就出安装包）
 *            build/YuanyuanMath-<ver>-win-x64.zip         （免安装版，解压双击）
 *   macOS    build/YuanyuanMath-<ver>-mac.tar.gz          （里面是 圆圆数学.app）
 *
 * 装完的机器上不需要 Node、不需要 npm、不需要联网、不需要任何 AI 引擎：
 * 「跟大纲学」和「闯关」直接能用。想解锁拍照出题再照 README 装引擎。
 *
 * 用法：
 *   node tools/pack.mjs                       # win + mac 都打
 *   node tools/pack.mjs --platforms win       # 只打一个（win | mac）
 *   node tools/pack.mjs --version 1.0.0       # 版本号（默认 0.1.0）
 *   node tools/pack.mjs --node v22.14.0       # 指定内置的 Node（默认取最新 LTS）
 *   node tools/pack.mjs --books               # 把书籍课程也装进去（版权自负）
 *   node tools/pack.mjs --skip-installer      # 不调 Inno Setup，只出 zip
 *
 * Node 运行时从 nodejs.org 官方下载并核对 SHASUMS256，缓存在 build/.cache/。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const CACHE = path.join(BUILD, ".cache");

const argv = process.argv.slice(2);
const flag = n => argv.includes("--" + n);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const VERSION = String(opt("version", "0.1.0"));
const PLATFORMS = String(opt("platforms", "win,mac")).split(",").map(s => s.trim()).filter(Boolean);
const WITH_BOOKS = flag("books");
const SKIP_INSTALLER = flag("skip-installer");
const APP_ZH = "圆圆数学";
const APP_EN = "YuanyuanMath";

/* ---------------- 小工具 ---------------- */
const rmrf = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
const mkdirp = p => fs.mkdirSync(p, { recursive: true });
const mb = n => (n / 1048576).toFixed(1) + " MB";
function copyInto(src, dstDir, opts) {
  opts = opts || {};
  const dst = path.join(dstDir, opts.as || path.basename(src));
  if (!fs.existsSync(src)) { if (!opts.optional) console.log("  ! 缺少 " + path.relative(ROOT, src)); return false; }
  fs.cpSync(src, dst, { recursive: true, filter: opts.filter });
  return true;
}
function dirSize(p) {
  let n = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else n += fs.statSync(f).size;
    }
  };
  try { walk(p); } catch (_) {}
  return n;
}

/* ---------------- 下 Node 运行时（官方源 + 校验 SHA256） ---------------- */
/* 默认钉在 Node 22 LTS：24 的 macOS 版要 13.5 以上，22 的只要 11，
 * 给家长发的东西还是别把老 Mac 挡在外面。--node v24.x 可以强行换。 */
const NODE_MAJOR = 22;
async function nodeVersion() {
  const pinned = opt("node", "");
  if (pinned) return pinned.startsWith("v") ? pinned : "v" + pinned;
  const idx = await (await fetch("https://nodejs.org/dist/index.json")).json();
  const want = idx.find(r => r.lts && r.version.startsWith("v" + NODE_MAJOR + "."));
  return (want || idx.find(r => r.lts) || { version: "v22.14.0" }).version;
}
async function download(url, dst) {
  if (fs.existsSync(dst)) return dst;
  process.stdout.write("  下载 " + path.basename(url) + " … ");
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  mkdirp(path.dirname(dst));
  fs.writeFileSync(dst + ".part", Buffer.from(await r.arrayBuffer()));
  fs.renameSync(dst + ".part", dst);
  console.log(mb(fs.statSync(dst).size));
  return dst;
}
async function fetchNode(ver, file) {
  const dst = path.join(CACHE, ver, file);
  await download("https://nodejs.org/dist/" + ver + "/" + file, dst);
  const sums = path.join(CACHE, ver, "SHASUMS256.txt");
  await download("https://nodejs.org/dist/" + ver + "/SHASUMS256.txt", sums);
  const want = fs.readFileSync(sums, "utf8").split("\n").map(l => l.trim().split(/\s+/))
    .find(p => p[1] === file);
  if (!want) throw new Error("SHASUMS256.txt 里没有 " + file);
  const got = crypto.createHash("sha256").update(fs.readFileSync(dst)).digest("hex");
  if (got !== want[0]) { rmrf(dst); throw new Error(file + " 校验不过，已删除，重跑一次"); }
  return dst;
}

/* zip 只解一个成员（Node 内置 zlib 够用：本地文件头 + deflate/stored） */
function unzipMember(zipPath, endsWith) {
  const buf = fs.readFileSync(zipPath);
  // 从中央目录尾开始找，稳过扫描本地头
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("不是合法的 zip：" + zipPath);
  let n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const local = buf.readUInt32LE(off + 42), method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
    off += 46 + nameLen + extraLen + cmtLen;
    if (!name.endsWith(endsWith)) continue;
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + size);
    return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
  }
  throw new Error("zip 里没找到 " + endsWith);
}
/* tar.gz 只解一个成员（ustar，够读官方 node 包） */
function untarMember(tgzPath, endsWith) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(buf.toString("ascii", off + 124, off + 136).replace(/\0.*$/, "").trim() || "0", 8);
    const body = off + 512;
    if (name.endsWith(endsWith)) return Buffer.from(buf.subarray(body, body + size));
    off = body + Math.ceil(size / 512) * 512;
  }
  throw new Error("tar 里没找到 " + endsWith);
}

/* ---------------- 自己写 tar.gz：Windows 上没有 +x 位，得手工指定 ---------------- */
function tarGz(entries, outFile) {
  const blocks = [];
  for (const e of entries) {
    const data = e.data || Buffer.alloc(0);
    const h = Buffer.alloc(512);
    const put = (s, off, len) => h.write(String(s).slice(0, len - 1), off, len - 1, "utf8");
    let name = e.name, prefix = "";
    if (Buffer.byteLength(name) > 100) {
      // ustar 的长路径：在某个 '/' 上拆开，后半段 <=100 字节、前半段 <=155 字节。
      // data/voice/<40位哈希>.m4a 这种加上 .app 前缀正好会超，所以这段是真会走到的。
      let at = -1;
      for (let i = 0; i < name.length; i++) {
        if (name[i] !== "/") continue;
        if (Buffer.byteLength(name.slice(i + 1)) <= 100 && Buffer.byteLength(name.slice(0, i)) <= 155) { at = i; break; }
      }
      if (at < 0) throw new Error("路径太长，ustar 放不下：" + name);
      prefix = name.slice(0, at); name = name.slice(at + 1);
    }
    put(name, 0, 100);
    put((e.mode || 0o644).toString(8).padStart(7, "0"), 100, 8);
    put("0000000", 108, 8); put("0000000", 116, 8);
    put((e.dir ? 0 : data.length).toString(8).padStart(11, "0"), 124, 12);
    put(Math.floor((e.mtime || 1735689600000) / 1000).toString(8).padStart(11, "0"), 136, 12);
    h.write("        ", 148, 8, "utf8");           // 校验和先填空格
    h.write(e.dir ? "5" : "0", 156, 1, "utf8");
    h.write("ustar\x0000", 257, 8, "binary");
    put("root", 265, 32); put("root", 297, 32);
    if (prefix) put(prefix, 345, 155);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
    blocks.push(h);
    if (!e.dir && data.length) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));                 // 结尾两个空块
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat(blocks), { level: 9 }));
  return fs.statSync(outFile).size;
}
function walkFiles(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const abs = path.join(dir, e.name);
    const rel = (base ? base + "/" : "") + e.name;
    if (e.isDirectory()) { out.push({ name: rel + "/", dir: true, mode: 0o755 }); out.push(...walkFiles(abs, rel)); }
    else out.push({ name: rel, data: fs.readFileSync(abs), mode: 0o644 });
  }
  return out;
}

/* ---------------- 组装应用本体（两个平台共用） ---------------- */
function stageApp(dst) {
  mkdirp(dst);
  copyInto(path.join(ROOT, "server.js"), dst);
  copyInto(path.join(ROOT, "public"), dst);
  copyInto(path.join(ROOT, "README.md"), dst);
  copyInto(path.join(ROOT, "README.zh.md"), dst, { optional: true });
  copyInto(path.join(ROOT, "LICENSE"), dst, { optional: true });
  copyInto(path.join(ROOT, "config.example.json"), dst);

  // 随包种子放 seed/，server 首启把它落到用户数据目录（DATA_ROOT）：
  //   config.json  语音包的哈希按 config.example.json 算，默认配置对不上语音包一条都命中不了，
  //                所以种子一定要发；用户改过的 config 升级时不会被它覆盖。
  //   qbank.json   预生成起始题库；server 启动时只并新题（题干去重），用户攒的题不丢。
  // 顶层不再发这两个文件——1.0.0 装过的机器上顶层是用户的真数据，升级清单里不能有同名文件。
  const seedDir = path.join(dst, "seed");
  mkdirp(seedDir);
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(path.join(seedDir, "config.json"), JSON.stringify(example, null, 2) + "\n", "utf8");
  // 种子题库要按 --books 过滤：本机 qbank.json 里混着书籍小节的题（AOPS.* 等），
  // 那是照着版权教材的章节结构出的，和书籍课程一样不能进公开包（1.1.x 漏发过 2 组）。
  try {
    const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "qbank.json"), "utf8"));
    const keep = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(bank)) {
      if (WITH_BOOKS || /^BC\./.test(k)) keep[k] = v; else dropped++;
    }
    fs.writeFileSync(path.join(seedDir, "qbank.json"), JSON.stringify(keep), "utf8");
    if (dropped) console.log("  种子题库去掉 " + dropped + " 组书籍题库（版权材料不进公开包）");
  } catch (_) { /* 没有 qbank.json 也能打包，装完第一次出题自己长 */ }
  // 打包标记：server 看到它才把用户数据切到系统用户目录（源码模式照旧写仓库）
  fs.writeFileSync(path.join(dst, ".packaged"), APP_EN + " " + VERSION + "\n", "utf8");

  // 课程数据：BC 大纲一定带；书籍课程默认不带（AoPS 的版权材料）
  const cur = path.join(dst, "data", "curriculum");
  mkdirp(cur);
  copyInto(path.join(ROOT, "data", "curriculum", "bc"), cur);
  if (WITH_BOOKS) {
    copyInto(path.join(ROOT, "data", "curriculum", "books"), cur, {
      filter: src => !src.split(/[\\/]/).includes("text")   // 原书正文一律不进包
    });
  }
  // 预生成的课程包、单元测试卷、语音包
  copyInto(path.join(ROOT, "data", "lessons"), path.join(dst, "data"), { optional: true });
  copyInto(path.join(ROOT, "data", "unit-tests"), path.join(dst, "data"), { optional: true });
  copyInto(path.join(ROOT, "data", "voice"), path.join(dst, "data"), { optional: true });

  // 想自己上 CosyVoice 的人用得到
  const tools = path.join(dst, "tools");
  mkdirp(tools);
  copyInto(path.join(ROOT, "tools", "tts_server.py"), tools, { optional: true });
  copyInto(path.join(ROOT, "tools", "tts_batch.py"), tools, { optional: true });

  const n = (sub, l) => { try { return fs.readdirSync(path.join(dst, "data", sub, l)).length; } catch (_) { return 0; } };
  const v = () => { try { return fs.readdirSync(path.join(dst, "data", "voice")).length; } catch (_) { return 0; } };
  return {
    zh: n("lessons", "zh"), en: n("lessons", "en"),
    units: n("unit-tests", "zh") + n("unit-tests", "en"),
    voice: v(), bytes: dirSize(dst)
  };
}

/* ---------------- Windows ---------------- */
/* 启动器正文放在 tools/launchers/ 里，是可以直接编辑、直接运行的真文件，
 * 不再是一坨转义到眼花的字符串数组。__APPNAME__ 打包时替换成应用名。 */
const LAUNCHER_DIR = path.join(ROOT, "tools", "launchers");
function launcher(name, crlf) {
  const t = fs.readFileSync(path.join(LAUNCHER_DIR, name), "utf8").replace(/__APPNAME__/g, APP_ZH);
  // 统一成 LF，再按目标平台决定要不要 CRLF（.bat 用 CRLF，shell 脚本必须 LF）
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const lf = t.split(CR + LF).join(LF);
  return crlf ? lf.split(LF).join(CR + LF) : lf;
}

async function buildWin(ver) {
  const out = path.join(BUILD, APP_EN + "-" + VERSION + "-win-x64");
  rmrf(out); mkdirp(out);
  const file = "node-" + ver + "-win-x64.zip";
  const zip = await fetchNode(ver, file);
  mkdirp(path.join(out, "runtime"));
  fs.writeFileSync(path.join(out, "runtime", "node.exe"), unzipMember(zip, "/node.exe"));
  const stats = stageApp(path.join(out, "app"));
  fs.writeFileSync(path.join(out, APP_ZH + ".bat"), launcher("win.bat", true), "utf8");
  console.log("  应用 " + mb(stats.bytes) + "（课 zh " + stats.zh + " / en " + stats.en
    + "，单元卷 " + stats.units + "，语音 " + stats.voice + " 条）");
  console.log("  Windows 目录版好了：" + path.relative(ROOT, out) + "  共 " + mb(dirSize(out)));

  // 免安装 zip：Windows 10 1803+ 自带 bsdtar，-a 按后缀自动选 zip 格式
  const zipOut = out + ".zip";
  rmrf(zipOut);
  // 在 build/ 里跑、只给相对路径：bsdtar 会把 "D:\..." 里的冒号当成 host:path 去连远程
  // 必须是 Windows 自带的 bsdtar：PATH 里先撞上 git-bash 的 GNU tar 的话，
  // 它既不认 -a 打 zip 也不认 --options。所以直接走绝对路径。
  // 另外不给 --options 的话 bsdtar 存 zip 是不压缩的，80MB 的 node.exe 会原样躺在里面。
  const bsdtar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  let r = spawnSync(fs.existsSync(bsdtar) ? bsdtar : "tar",
    ["-a", "-c", "-f", path.basename(zipOut), "--options", "zip:compression=deflate", path.basename(out)],
    { cwd: path.dirname(out), encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(zipOut)) {
    rmrf(zipOut);   // 半截的产物别留着
    r = spawnSync("powershell", ["-NoProfile", "-Command",
      "Compress-Archive -Path '" + out + "' -DestinationPath '" + zipOut + "' -CompressionLevel Optimal -Force"],
      { encoding: "utf8" });
  }
  if (fs.existsSync(zipOut)) {
    console.log("  免安装 zip：" + path.relative(ROOT, zipOut) + "  " + mb(fs.statSync(zipOut).size));
  } else {
    console.log("  打 zip 失败，目录版还在，自己压一下就行：" + String(r.stderr || "").slice(0, 200));
  }
  return { out, stats };
}

function innoScript(srcDir) {
  return [
    "; 由 tools/pack.mjs 生成，直接改这里没用，改脚本",
    "#define AppName \"" + APP_ZH + "\"",
    "#define AppVer \"" + VERSION + "\"",
    "[Setup]",
    "AppName={#AppName}",
    "AppVersion={#AppVer}",
    "AppPublisher=" + APP_ZH,
    "DefaultDirName={localappdata}\\Programs\\" + APP_EN,
    "DefaultGroupName={#AppName}",
    "DisableProgramGroupPage=yes",
    "PrivilegesRequired=lowest",          // 装到用户目录，不弹 UAC
    "OutputDir=" + BUILD,
    "OutputBaseFilename=" + APP_EN + "-" + VERSION + "-win-x64-setup",
    "Compression=lzma2/max",
    "SolidCompression=yes",
    "WizardStyle=modern",
    "ArchitecturesAllowed=x64compatible",
    "ArchitecturesInstallIn64BitMode=x64compatible",
    "",
    "[Languages]",
    "Name: \"cn\"; MessagesFile: \"compiler:Default.isl\"",
    "",
    "[Files]",
    "Source: \"" + srcDir + "\\*\"; DestDir: \"{app}\"; Flags: recursesubdirs createallsubdirs ignoreversion",
    "",
    "[Icons]",
    "Name: \"{group}\\{#AppName}\"; Filename: \"{app}\\" + APP_ZH + ".bat\"",
    "Name: \"{userdesktop}\\{#AppName}\"; Filename: \"{app}\\" + APP_ZH + ".bat\"",
    "",
    "[Run]",
    "Filename: \"{app}\\" + APP_ZH + ".bat\"; Description: \"现在就打开 {#AppName}\"; Flags: postinstall shellexec skipifsilent",
    "",
    "; 孩子的学习数据（账号、进度、题库、config）在 %APPDATA%\\YuanyuanMath，由 server 首次",
    "; 启动时迁过去；Inno 的清单里从来没有它们，升级/卸载都碰不到。",
    "; 从 1.0.0 原地升级的机器：老数据还留在 {app}\\app 里，新版启动会自动接管（只拷不删）。",
    ""
  ].join("\r\n");
}

function findIscc() {
  const cands = [
    // winget 默认装到用户目录，不是 Program Files
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Inno Setup 6", "ISCC.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Inno Setup 6", "ISCC.exe"),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  const r = spawnSync("where", ["iscc"], { encoding: "utf8" });
  const line = String(r.stdout || "").split(/\r?\n/)[0].trim();
  return line && fs.existsSync(line) ? line : null;
}

/* ---------------- macOS ---------------- */

function macPlist() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\"><dict>",
    "  <key>CFBundleName</key><string>" + APP_ZH + "</string>",
    "  <key>CFBundleDisplayName</key><string>" + APP_ZH + "</string>",
    "  <key>CFBundleIdentifier</key><string>com.yuanyuan.math</string>",
    "  <key>CFBundleVersion</key><string>" + VERSION + "</string>",
    "  <key>CFBundleShortVersionString</key><string>" + VERSION + "</string>",
    "  <key>CFBundleExecutable</key><string>launch</string>",
    "  <key>CFBundlePackageType</key><string>APPL</string>",
    "  <key>LSMinimumSystemVersion</key><string>11.0</string>",
    // 让系统优先按原生 arm64 起这个 app；不写的话脚本主程序的 .app 会被扔给 Rosetta
    "  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>",
    "</dict></plist>",
    ""
  ].join("\n");
}

async function buildMac(ver) {
  const stage = path.join(BUILD, ".mac-stage");
  rmrf(stage);
  const appDir = APP_ZH + ".app";
  const res = path.join(stage, appDir, "Contents", "Resources");
  const macos = path.join(stage, appDir, "Contents", "MacOS");
  mkdirp(res); mkdirp(macos);

  for (const [arch, name] of [["arm64", "node-arm64"], ["x64", "node-x64"]]) {
    const file = "node-" + ver + "-darwin-" + arch + ".tar.gz";
    const tgz = await fetchNode(ver, file);
    fs.writeFileSync(path.join(res, name), untarMember(tgz, "/bin/node"));
  }
  const stats = stageApp(path.join(res, "app"));
  fs.writeFileSync(path.join(macos, "launch"), launcher("mac-launch.sh", false), "utf8");
  fs.writeFileSync(path.join(stage, appDir, "Contents", "Info.plist"), macPlist(), "utf8");
  fs.writeFileSync(path.join(stage, "打开我 READ ME FIRST.txt"), [
    APP_ZH + " " + VERSION + " · macOS",
    "",
    "第 1 步：把 " + appDir + " 拖进「应用程序」文件夹。",
    "  （必须先拖。留在「下载」里直接打开，系统会把它搬进一个只读的临时位置运行，",
    "    学习数据会存不进去。）",
    "",
    "第 2 步：第一次打开会被 macOS 拦（说「无法验证开发者」）——这个包没有花钱买",
    "苹果的开发者签名。打开「终端」，粘贴这一行按回车，去掉下载隔离标记：",
    "  xattr -dr com.apple.quarantine \"/Applications/" + appDir + "\"",
    "  （不想用终端也行：双击让它被拦一次，再到 系统设置 → 隐私与安全性 →",
    "    拉到最下面点「仍要打开」。老教程说的「右键 →「打开」」macOS 15 起已被苹果移除。）",
    "只需要做这一次，以后双击就行。",
    "",
    "打开后浏览器会自动跳到 http://localhost:8434 。",
    "同一个 Wi-Fi 下的 iPad / 手机也能用，地址看终端里打印的「局域网访问」。",
    "",
    "账号和学习数据存在 ~/Library/Application Support/YuanyuanMath 里，",
    "以后升级、重装、换新 .app 都不会丢。",
    ""
  ].join("\n"), "utf8");

  // 手工写 tar：Windows 文件系统没有 +x 位，可执行权限只能在这里指定
  const entries = walkFiles(stage, "").map(e => {
    const isExec = e.name.endsWith("/Contents/MacOS/launch")
      || /\/Resources\/node-(arm64|x64)$/.test(e.name);
    return isExec ? Object.assign(e, { mode: 0o755 }) : e;
  });
  const out = path.join(BUILD, APP_EN + "-" + VERSION + "-mac.tar.gz");
  const size = tarGz(entries, out);
  console.log("  应用 " + mb(stats.bytes) + "（课 zh " + stats.zh + " / en " + stats.en
    + "，单元卷 " + stats.units + "，语音 " + stats.voice + " 条）");
  console.log("  macOS 包好了：" + path.relative(ROOT, out) + "  " + mb(size));
  rmrf(stage);
  return { out, size };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  mkdirp(BUILD);
  const ver = await nodeVersion();
  console.log(APP_ZH + " " + VERSION + "   内置 Node " + ver + "   平台 " + PLATFORMS.join("+")
    + (WITH_BOOKS ? "   （含书籍课程）" : ""));
  console.log("");

  if (PLATFORMS.includes("win")) {
    console.log("--- Windows ---");
    const { out } = await buildWin(ver);
    if (!SKIP_INSTALLER) {
      const iscc = findIscc();
      if (!iscc) {
        console.log("  没找到 Inno Setup（ISCC.exe），跳过 setup.exe。");
        console.log("  装它：winget install JRSoftware.InnoSetup   然后重跑本脚本。");
      } else {
        const iss = path.join(BUILD, "installer.iss");
        fs.writeFileSync(iss, innoScript(out), "utf8");
        const r = spawnSync(iscc, [iss], { encoding: "utf8" });
        const exe = path.join(BUILD, APP_EN + "-" + VERSION + "-win-x64-setup.exe");
        if (r.status === 0 && fs.existsSync(exe)) {
          console.log("  安装包好了：" + path.relative(ROOT, exe) + "  " + mb(fs.statSync(exe).size));
        } else {
          console.log("  Inno Setup 失败：");
          console.log(String(r.stdout || "").split("\n").slice(-12).join("\n"));
          console.log(String(r.stderr || "").slice(-500));
        }
      }
    }
    console.log("");
  }

  if (PLATFORMS.includes("mac")) {
    console.log("--- macOS ---");
    await buildMac(ver);
    console.log("");
  }

  console.log("产物都在 " + path.relative(ROOT, BUILD) + "/");
}

main().catch(e => { console.error(e); process.exit(1); });
