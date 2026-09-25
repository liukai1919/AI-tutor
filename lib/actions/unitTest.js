/*
 * 单元测试 Action（#25）：generate / list / get / remove / attempt / clear。逻辑从 /api/unit-test* 原样搬来。
 * 一个单元（BC 主线 / 教材章节 / 技能主题）一张卷；随包卷命中就不碰引擎；判分和记进度在 attempt 里（服务端）。
 * deps：kd, kidSave, kidTxn, saveWarn, unitTestsAdd, unitTestSummary, curriculum, curriculumKey, learnView, viewKey, STRANDS,
 *       normLang, pickProvider, L, unitPackGet, ledgerAdd, unitTestPrompt, UNIT_TEST_SCHEMA, UNIT_TEST_HINT, validateUnitTest,
 *       progressRecord, generateOnce, log
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

module.exports = function createUnitTestActions(deps) {
  const { kd, kidSave, kidTxn, saveWarn, unitTestsAdd, unitTestSummary, curriculum, curriculumKey, learnView, viewKey, STRANDS,
    normLang, pickProvider, L, unitPackGet, ledgerAdd, unitTestPrompt, UNIT_TEST_SCHEMA, UNIT_TEST_HINT, validateUnitTest,
    progressRecord, generateOnce } = deps;
  const log = deps.log || console.log;
  const NOT_FOUND = { error: "卷子不存在 / Not found" };
  const find = (kidId, id) => { const list = kd(kidId).unitTests; const i = list.findIndex(r => r.id === String(id || "")); return { list, i }; };

  return {
    async generate(ctx, body) {
      const kidId = needKid(ctx);
      const lang = normLang(body.lang);
      const g0 = curriculumKey(body.grade || 0);
      /* 数字年级 → 技能视图（主题当单元）；单元 id 不在技能视图里就退回大纲视图（老存档里的主线名还能用） */
      let d = learnView(g0);
      const strand = String(body.strand || "");
      if (d && d.type === "skills-preview" && !(d.strandDefs || []).some(s => s[0] === strand)) d = curriculum.get(g0);
      if (!d) throw new ActionError(404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" });
      const g = viewKey(g0, d);
      const def = (d.strandDefs || STRANDS).find(s => s[0] === strand);
      const unitItems = (d.items || []).filter(it => it.strand === strand);
      if (!def || !unitItems.length) throw new ActionError(400, { error: "未知的单元 / Unknown unit" });
      const count = Math.max(6, Math.min(12, Number(body.count) || 8));

      // 随包发的卷子：命中就直接发一份给这个孩子，不碰引擎。fresh=true 是「再出一张新的」，那条路照旧要引擎。
      if (!body.fresh) {
        const packed = unitPackGet(g, strand, lang);
        if (packed) {
          const rec = {
            time: Date.now(), grade: String(g), strand, lang, provider: "pack",
            title: packed.title || (lang === "en" ? def[2] : def[1]),
            unitName: { zh: def[1], en: def[2] },
            questions: packed.questions, attempts: []
          };
          const unsaved = kidTxn(() => unitTestsAdd(kidId, rec), { keep: true });
          log(`[unit] pack hit grade=${g} unit=${strand} lang=${lang} kid=${kidId}`);
          ledgerAdd({ task: "unit", provider: "pack", lang, ms: 0, ok: true });
          return Object.assign({ set: rec, provider: "pack", ms: 0, packed: true }, saveWarn(unsaved));
        }
      }

      const id = pickProvider(ctx.role === "parent" ? body.provider : null, "unit");   // 学生不能指定引擎，走 config 默认
      if (!id) throw new ActionError(503, {
        error: L(lang,
          "这个单元的卷子不在随附的题库里，现出卷需要一个 AI 引擎。怎么装看 README（Ollama 免费离线 / claude / gemini / grok / codex 或 API）。",
          "This unit's test isn't in the bundled set, so writing one needs an AI engine. See the README to set one up (Ollama is free and offline / claude / gemini / grok / codex or an API)."),
        needsEngine: true });
      const sys = unitTestPrompt(d, strand, lang, count);
      const q = L(lang, "请出这张单元测验。", "Please write this unit test.");
      const opts = { schema: UNIT_TEST_SCHEMA, hint: UNIT_TEST_HINT[lang] };
      const t0 = Date.now();
      log(`[unit] engine=${id} grade=${g} unit=${strand} lang=${lang} n=${count}`);
      const set = await generateOnce("unit", id, "unit", sys, q, null, null, lang, opts, x => validateUnitTest(x, d, strand, count));
      log(`[unit] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${set.questions.length} questions`);
      const rec = {
        time: Date.now(), grade: String(g), strand, lang, provider: id,
        // 标题兜底用单元名：AI 偶尔给个空串，存档列表里就成了无名卷
        title: set.title || (lang === "en" ? def[2] : def[1]),
        unitName: { zh: def[1], en: def[2] },
        questions: set.questions, attempts: []
      };
      const unsaved = kidTxn(() => unitTestsAdd(kidId, rec), { keep: true });
      return Object.assign({ set: rec, provider: id, ms: Date.now() - t0 }, saveWarn(unsaved));
    },
    list(ctx, input) {
      const kidId = needKid(ctx);
      const g = String((input && input.grade) || "");
      const strand = String((input && input.strand) || "");
      /* 年级 5 的卷子可能存在两个 key 下：老的主线卷 grade="5"，技能视图的主题卷 grade="skills-g5"。
       * 清单两种都列，前端按 strand（主题 id / 主线名）再分到各自的面板 */
      const keys = new Set([g]);
      if (/^\d+$/.test(g)) keys.add("skills-g" + g);
      return {
        items: kd(kidId).unitTests
          .filter(r => (!g || keys.has(String(r.grade))) && (!strand || r.strand === strand))
          .map(unitTestSummary)
      };
    },
    get(ctx, input) {
      const kidId = needKid(ctx);
      const { list, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      return { record: list[i] };
    },
    remove(ctx, input) {
      const kidId = needKid(ctx);
      const { list, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      list.splice(i, 1);
      kidSave(kidId, "unitTests");
      return { ok: true };
    },
    /* 交卷：只收「第几题选了第几个」，对错由服务端按存档里的答案算，顺带把每题记进对应知识点的进度 */
    attempt(ctx, body) {
      const kidId = needKid(ctx);
      const rec = kd(kidId).unitTests.find(r => r.id === String(body.id || ""));
      if (!rec) throw new ActionError(404, NOT_FOUND);
      const qs = rec.questions || [];
      /* 只认「整数且落在这道题的选项范围内」，别的一律当没作答（-1，中途退出也能交）。
       * 不能走 Number()/Math.round 的宽松转换：Number(null)===0、Number(false)===0、Number("")===0，
       * 一张全 null 的卷子会被判成「全选 A」写进成绩和知识点对错（#17）。同闯关结算的口径。 */
      const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
      const answers = qs.map((q, i) => {
        const v = rawAnswers[i];
        return Number.isInteger(v) && v >= 0 && v < ((q.options || []).length || 4) ? v : -1;
      });
      const answered = answers.filter(v => v >= 0).length;
      // 一题没答就别记成绩：否则存档列表里「上次 0/8」看着像考砸了，其实是点进来又退出去
      if (!answered) return { ok: true, right: 0, total: qs.length, answered: 0, skipped: true };
      let right = 0;
      // 逐题进度 + 成绩单并成一笔：存不下就整笔退回、回 500，孩子重交一次不会重复记分（#16）
      kidTxn(() => {
        qs.forEach((q, i) => {
          if (answers[i] < 0) return;
          const ok = answers[i] === q.answerIndex;
          if (ok) right++;
          // 选择题判定是确定性的（不是 AI 判题），直接记进度；没挂上知识点的题只计分不记进度
          if (q.curriculumId) progressRecord(kidId, q.curriculumId, ok ? "practiced-right" : "practiced-wrong");
        });
        const at = {
          time: Date.now(), right, total: qs.length, answered,
          done: answered === qs.length,   // 中途退出的那次别当成绩单报，列表里标「没做完」
          ms: Math.max(0, Math.round(Number(body.ms) || 0)),
          answers
        };
        rec.attempts = [at, ...(rec.attempts || [])].slice(0, 10);
        kidSave(kidId, "unitTests");
      });
      return { ok: true, right, total: qs.length, answered };
    },
    clear(ctx) {
      const kidId = needKid(ctx);
      kd(kidId).unitTests = [];
      kidSave(kidId, "unitTests");
      log(`[unit] tests cleared (kid=${kidId})`);
      return { ok: true };
    }
  };
};
