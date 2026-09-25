/*
 * 闯关 Action（#24）：start / answer / finish。逻辑从 /api/quiz/* 三条路由原样搬来（规则本体在 lib/domain/quiz.js）。
 * deps：Q, L, normLang, findCurriculumItem, pickProvider, qbankPlayable, ensureQuizBank, ledgerAdd, shuffleArr,
 *       quizOpen(Map), quizOpenCreate, quizOpenGet, quizOpenTake, quizNextPublic, qbank, qbankKey, qbankSave,
 *       kidTxn, progressRecord, missRecord, progressStatus, progressLevel, remediationFor
 * ctx.userId：场次票绑的是登录用户（家长代做时是家长自己），审计 §3 已记，本片不改。
 */
"use strict";
const { ActionError, needKid, UNKNOWN_ITEM } = require("./errors.js");

module.exports = function createQuizActions(deps) {
  const { Q, L, normLang, findCurriculumItem, pickProvider, qbankPlayable, ensureQuizBank, ledgerAdd, shuffleArr,
    quizOpen, quizOpenCreate, quizOpenGet, quizOpenTake, quizNextPublic, qbank, qbankKey, qbankSave,
    kidTxn, progressRecord, missRecord, progressStatus, progressLevel, remediationFor } = deps;
  const STALE = { error: "这场闯关的场次票无效或已经结算过 / Quiz session is invalid or already settled", staleSession: true };

  return {
    /* 开一场：题库够就直接开（没引擎也行），不够且有引擎就补题；发场次票和第一题（没有答案） */
    async start(ctx, input) {
      const lang = normLang(input && input.lang);
      const found = findCurriculumItem(String((input && input.curriculumId) || ""));
      if (!found) throw new ActionError(400, UNKNOWN_ITEM);
      const id = pickProvider(ctx.role === "parent" ? input.provider : null, "quiz");   // 学生不能指定引擎
      const ready = qbankPlayable(found.item.id, lang);   // 随包发的题库：没引擎也能闯
      if (!id && !ready) throw new ActionError(503, {
        error: L(lang,
          "这一节的闯关题不在随附的题库里，现出题需要一个 AI 引擎。" + "怎么装看 README（Ollama 免费离线 / claude / gemini / grok / codex 或 API）。",
          "This topic's quiz questions aren't in the bundled question bank, so writing them needs an AI engine." + " See the README to set one up (Ollama is free and offline / claude / gemini / grok / codex or an API)."),
        needsEngine: true });
      let bank;
      if (id) bank = await ensureQuizBank(found.item, found.data, lang, id);
      else { ledgerAdd({ task: "quiz", provider: "bank", lang, ms: 0, ok: true }); bank = ready; }   // 没引擎、纯吃随包题库
      const sid = quizOpenCreate(ctx.userId, found.item.id, lang, Q.pickSession(bank, shuffleArr));   // 答题和结算都凭这张票
      const open = quizOpen.get(sid);
      const question = quizNextPublic(open, bank);
      return { session: sid, rules: Q.RULES, level: open.state.level, n: open.state.n, question };
    },

    /* 答一题：服务端按题库判分、升降级、给下一题；答案和讲解这时才下发。一道题只能答一次 */
    answer(ctx, input) {
      const open = quizOpenGet(input && input.session, ctx.userId, null);
      if (!open) throw new ActionError(400, STALE);
      const st = open.state;
      if (!st.cur || st.answered) throw new ActionError(400, { error: "这场已经答完了，去结算吧 / This quiz is over, settle it", finished: true });
      const bank = qbank[qbankKey(open.cid, open.lang)];
      const q = bank ? bank.questions.find(x => x.qid === st.cur) : null;
      if (!q) throw new ActionError(400, { error: "这场的题不在题库里了 / The quiz bank changed underneath this session", staleSession: true });
      const r = Q.applyAnswer(st, q, input.picked);
      if (!r) throw new ActionError(400, { error: "答案不合法 / Invalid answer index" });
      const next = r.finished ? null : quizNextPublic(open, bank);
      return {
        correct: r.correct, answerIndex: q.answerIndex, explain: q.explain || "",
        level: st.level, n: st.n, topRight: st.topRight, finished: r.finished || !next, next
      };
    },

    /* 结算：按票里记的作答记统计、做过的题打 usedAt；通关判定以题库里的难度为准。一场只结一次 */
    finish(ctx, input) {
      const kidId = needKid(ctx);
      const cid = String((input && input.curriculumId) || "");
      const found = findCurriculumItem(cid);
      if (!found) throw new ActionError(400, UNKNOWN_ITEM);
      const open = quizOpenTake(input.session, ctx.userId, found.item.id);
      if (!open) throw new ActionError(400, STALE);
      const bank = qbank[qbankKey(cid, open.lang)];
      const now = Date.now();
      const counted = new Set();
      let topRight = 0, right = 0, total = 0, passed = false;
      try { kidTxn(() => {
        for (const r of open.state.results) {
          const q = bank ? bank.questions.find(x => x.qid === r.qid) : null;
          if (!q || counted.has(r.qid)) continue;   // 题库被清了 / 重复的 qid 不记
          counted.add(r.qid);
          q.usedAt = now;
          const ok = r.picked === q.answerIndex;   // 对错还是按题库现在的答案判，不信票里记的 ok
          total++; if (ok) right++;
          progressRecord(kidId, cid, ok ? "quiz-right" : "quiz-wrong");
          if (q.level === Q.TOP_LEVEL && ok) topRight++;
          /* 答错且这道题挂了误区标签：记一笔，攒够 2 次就建议回补（技能图谱 §6）。老题库没有 tags，什么都不做 */
          if (!ok) { const tag = Q.missTag(q, r.picked); if (tag) missRecord(kidId, cid, tag); }
        }
        passed = topRight >= Q.PASS_NEED;
        if (passed) progressRecord(kidId, cid, "quiz-pass");
      }); } catch (e) {
        // 整场没记上（内存已退回）：票是 quizOpenTake 取走即作废的，还回去，孩子原样重交不会被当成「已结算」（#16）
        if (e.saveFailed) quizOpen.set(String(input.session), open);
        throw e;
      }
      if (bank) qbankSave();
      return {
        ok: true, passed, right, total, status: progressStatus(kidId, cid), level: progressLevel(kidId, cid),
        ...(remediationFor(kidId, cid) ? { remediate: remediationFor(kidId, cid) } : {})
      };
    }
  };
};
