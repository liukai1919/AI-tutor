/*
 * 闯关规则（领域层，纯函数，零依赖）。issue #23，#19 Phase 1 第二刀。
 *
 * SAT 式升降难度：从 L1 起步，对升一级、错降一级；最高难度累计答对 PASS_NEED 题通关；
 * MAX_QUESTIONS 题内没通关 = 本次不通关。出题标准见 docs/qbank-standard.md。
 *
 * 2026-09-25 前这套规则在 public/index.html 里由前端执行，服务端只在结算时按 qid+picked 复核。
 * 现在状态和判定都在服务端（场次票），前端只拿到当前题和答完后的讲解。
 *
 * 这里不碰题库对象本身（usedAt 由结算时打）、不碰磁盘、不知道 kidId。
 *   bank      { questions:[{qid, level, question, options, answerIndex, explain, tags?, visual?, usedAt?}] }
 *   state     { byLevel:{1:[qid],2:[qid],3:[qid]}, level, n, cur, answered, results:[{qid,level,picked,ok}], topRight }
 */
"use strict";

const PER_LEVEL_NEW = 4;      // 每级一次生成 4 道
const LEVEL_CAP = 12;         // 每级封顶（单知识点单语言最多 36 道），到顶按最久没做过复用
const SESSION_PER_LEVEL = 4;  // 一次闯关每级最多带出 4 道
const MAX_QUESTIONS = 8;      // 8 题内没通关 = 本次不通关
const PASS_NEED = 2;          // 最高难度累计答对 2 题 = 通关
const TOP_LEVEL = 3;
const LEVELS = [1, 2, 3];
const RULES = Object.freeze({ maxQuestions: MAX_QUESTIONS, passNeed: PASS_NEED, topLevel: TOP_LEVEL });

/* 一场的题包：每级没做过的优先（打乱），不够拿做过的按最久没做过补，每级最多 SESSION_PER_LEVEL 道。
 * shuffle 由调用方传（测试可传恒等函数）。
 * 作答按 qid 认题（重放判定靠它），所以一场里同一个 qid 只出现一次，没有 qid 的题不进场 */
function pickSession(bank, shuffle) {
  const byLevel = { 1: [], 2: [], 3: [] };
  const taken = new Set();
  for (const lv of LEVELS) {
    const qs = bank.questions.filter(q => q.level === lv && q.qid);
    const fresh = shuffle(qs.filter(q => !q.usedAt));
    const used = qs.filter(q => q.usedAt).sort((a, b) => a.usedAt - b.usedAt);
    for (const q of fresh.concat(used)) {
      if (byLevel[lv].length >= SESSION_PER_LEVEL) break;
      if (taken.has(q.qid)) continue;
      taken.add(q.qid);
      byLevel[lv].push(q.qid);
    }
  }
  return byLevel;
}

function newState(byLevel) {
  return { byLevel, level: 1, n: 0, cur: null, answered: false, results: [], topRight: 0 };
}

/* 当前难度没题就借相邻难度的顶上（先低后高），实在无题返回 null（提前结算） */
function borrowOrder(level) {
  return level === 1 ? [1, 2, 3] : level === 2 ? [2, 1, 3] : [3, 2, 1];
}
function isFinished(state) {
  return state.topRight >= PASS_NEED || state.n >= MAX_QUESTIONS;
}
/* 取下一题：更新 state.level / n / cur / answered，返回 qid；没题或已结束返回 null */
function nextQuestion(state) {
  if (isFinished(state)) return null;
  for (const lv of borrowOrder(state.level)) {
    if (state.byLevel[lv].length) {
      state.level = lv;
      state.cur = state.byLevel[lv].shift();
      state.n++;
      state.answered = false;
      return state.cur;
    }
  }
  return null;
}
/* 服务端判分只认「选了第几个」：下标不是合法整数就当没答 */
function judge(q, picked) {
  const ok = Number.isInteger(picked) && picked >= 0 && picked < (q.options || []).length;
  return { valid: ok, correct: ok && picked === q.answerIndex };
}
/* 记一次作答：对升一级、错降一级；最高难度答对累计 topRight。q 必须是 state.cur 对应的题。
 * 返回 { correct, finished }，非法下标或重复作答返回 null（调用方回 400） */
function applyAnswer(state, q, picked) {
  if (!state.cur || state.answered || q.qid !== state.cur) return null;
  const j = judge(q, picked);
  if (!j.valid) return null;
  state.answered = true;
  state.results.push({ qid: q.qid, level: q.level, picked, ok: j.correct });
  if (j.correct) {
    if (q.level === TOP_LEVEL) state.topRight++;
    state.level = Math.min(TOP_LEVEL, state.level + 1);
  } else state.level = Math.max(1, state.level - 1);
  return { correct: j.correct, finished: isFinished(state) };
}
/* 发给客户端的题：没有答案、讲解和误区标签（ok 的位置就是答案） */
function publicQuestion(q) {
  const out = { qid: q.qid, level: q.level, question: q.question, options: q.options };
  if (q.visual) out.visual = q.visual;
  return out;
}
/* 答错时那个选项挂的误区标签（老题库没有 tags 就是空串） */
function missTag(q, picked) {
  if (!Array.isArray(q.tags) || picked > 3) return "";
  const tag = q.tags[picked];
  return tag && tag !== "ok" && tag !== "other" ? tag : "";
}
function tally(state) {
  const total = state.results.length, right = state.results.filter(r => r.ok).length;
  return { right, wrong: total - right, total, passed: state.topRight >= PASS_NEED };
}

module.exports = {
  PER_LEVEL_NEW, LEVEL_CAP, SESSION_PER_LEVEL, MAX_QUESTIONS, PASS_NEED, TOP_LEVEL, LEVELS, RULES,
  pickSession, newState, borrowOrder, isFinished, nextQuestion, judge, applyAnswer, publicQuestion, missTag, tally,
};
