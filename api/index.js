/*
 * Vercel 在线 demo 的入口。本地运行、打包安装完全不经过这个文件：
 * pack.mjs 的白名单里没有 api/，它永远不会进安装包。
 *
 * serverless 没有持久磁盘，唯一可写的是 /tmp——所以把用户数据根（YY_DATA_DIR）
 * 指到 /tmp，冷启动时把 demo/ 里的种子铺进去：
 *   demo/users.json  预置的演示家长 + 孩子（否则注册开放，第一个路人就把 demo 占了；
 *                    种子里有家长后注册自动关闭，正是 server 的既有行为）
 *   demo/qbank.json  从本地题库过滤出 BC.* 键的闯关题（AoPS 书籍键不进公开部署）
 * 实例回收 /tmp 即清空，访客数据一点不留——demo 要的就是这个。
 *
 * YY_DEMO=1 让 server.js 跳过书籍课程目录。没有 AI 引擎也没有 CosyVoice：
 * 讲课/闯关全走仓库里的预生成包（data/lessons、data/unit-tests、题库种子），
 * 语音由前端自动退回浏览器 speechSynthesis，现场出题会收到「需要引擎」的提示。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.YY_DEMO = "1";
if (!process.env.YY_DATA_DIR) process.env.YY_DATA_DIR = path.join(os.tmpdir(), "yuanyuan-demo");

const DATA = process.env.YY_DATA_DIR;
const SEED = path.join(__dirname, "..", "demo");
fs.mkdirSync(path.join(DATA, "data"), { recursive: true });

/* 这块可写目录是全新的，没有旧数据要迁——直接落标记，把 server 的首启迁移
 * 整段跳过。不跳的话，本地模拟运行时它会把仓库根目录的真实用户数据拷进来
 * （线上 /var/task 里没有那些文件，但两边行为必须一致才好验证）。 */
try { fs.writeFileSync(path.join(DATA, ".migrated-from-app"), "demo\n", { flag: "wx" }); } catch (_) {}

/* demo 永远用默认配置（无引擎、无 TTS、注册随家长种子自动关闭）。
 * 先放一个空 config.json 占住位，server 里「老包兜底」那条 ROOT/config.json
 * 复制路径就不会碰它——本地模拟时仓库根目录就有一份真 config。 */
try { fs.writeFileSync(path.join(DATA, "config.json"), "{}\n", { flag: "wx" }); } catch (_) {}
for (const [src, dst] of [
  ["users.json", path.join("data", "users.json")],
  ["qbank.json", "qbank.json"],
]) {
  const s = path.join(SEED, src), d = path.join(DATA, dst);
  try { if (fs.existsSync(s) && !fs.existsSync(d)) fs.cpSync(s, d); }
  catch (e) { console.log("[demo] could not seed " + src + ": " + e.message); }
}

/* server.js 里 require.main 守卫保证这里只建 server、不监听端口 */
const { server } = require("../server.js");

module.exports = (req, res) => server.emit("request", req, res);
