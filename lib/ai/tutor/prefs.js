/*
 * 「问老师」的家庭设置与对话记录（#55，#19 Phase 9b）：纯函数，不碰磁盘。存储在 server.js：
 *   data/families.json                    { [familyId]: { tutor: { enabled, kidMode } } }
 *   data/kids/<kid>/tutor-chats.json       最近 TUTOR_CHATS_MAX 条，新的在前
 *
 * 家庭设置默认关：家长在 ⚙️ 打开之前，孩子端看不到入口、接口回 403 tutorOff。
 * kidMode：hint（默认）= 孩子问的一律按提示出（TutorAgent 的 mode:"hint" 对任何教学策略都强制提示）；answer = 孩子可以自己选。
 * 家长自己问不受 kidMode 限制。
 */
"use strict";

const TUTOR_CHATS_MAX = 200;
const KID_MODES = ["hint", "answer"];
const DEFAULT_PREFS = Object.freeze({ enabled: false, kidMode: "hint" });

/* 读盘 / 读内存时用：不认识的值一律回默认（关、只给提示），宁紧勿松 */
function readTutorPrefs(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  return { enabled: t.enabled === true, kidMode: KID_MODES.includes(t.kidMode) ? t.kidMode : DEFAULT_PREFS.kidMode };
}

/* 家长提交的修改：只认 enabled（布尔）/ kidMode（hint|answer），至少一个；别的字段或类型不对 → null（路由回 400） */
function patchTutorPrefs(cur, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.length || keys.some(k => k !== "enabled" && k !== "kidMode")) return null;
  if ("enabled" in body && typeof body.enabled !== "boolean") return null;
  if ("kidMode" in body && !KID_MODES.includes(body.kidMode)) return null;
  return Object.assign(readTutorPrefs(cur), body);
}

/* 一条对话记录：问题和回答全文（家长要看），外加去向；by = 谁问的（student / parent） */
function chatRecord({ id, time, role, question, reply, mode }) {
  const rec = { id, time, by: role === "parent" ? "parent" : "student", lang: reply.lang, mode, kind: reply.kind, question: String(question), text: String(reply.text || "") };
  if (reply.strategy) rec.strategy = reply.strategy;
  if (reply.code) rec.code = reply.code;
  return rec;
}

module.exports = { readTutorPrefs, patchTutorPrefs, chatRecord, TUTOR_CHATS_MAX, KID_MODES, DEFAULT_TUTOR_PREFS: DEFAULT_PREFS };
