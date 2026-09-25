/*
 * FSA 模拟卷 Action（#25）：generate / list / get / remove / attempt / clear。逻辑从 /api/fsa* 原样搬来。
 * FSA 总是现场出卷（没有预生成包）；分数仍由客户端上报（审计 §3 已记，本片不改）。
 * deps：kd, kidSave, kidTxn, saveWarn, fsaSetsAdd, fsaSetSummary, curriculum, STRANDS, normLang, pickProvider, L,
 *       fsaPrompt, FSA_SET_SCHEMA, FSA_HINT, validateFsaSet, generateOnce, log
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

module.exports = function createFsaActions(deps) {
  const { kd, kidSave, kidTxn, saveWarn, fsaSetsAdd, fsaSetSummary, curriculum, STRANDS, normLang, pickProvider, L,
    fsaPrompt, FSA_SET_SCHEMA, FSA_HINT, validateFsaSet, generateOnce } = deps;
  const log = deps.log || console.log;
  const NOT_FOUND = { error: "卷子不存在 / Not found" };
  const NO_DATA = { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" };
  const find = (kidId, id) => { const sets = kd(kidId).fsaSets; const i = sets.findIndex(r => r.id === String(id || "")); return { sets, i }; };

  return {
    /* 按大纲出多步骤情境选择题（G4/G7 是 FSA 年级，其他年级也可当普通练习卷）。出一次卷不便宜：立刻持久化 */
    async generate(ctx, body) {
      const kidId = needKid(ctx);
      const lang = normLang(body.lang);
      const g = Number(body.grade || 0);
      const d = curriculum.get(g);
      if (!d) throw new ActionError(404, NO_DATA);
      const strand = STRANDS.some(s => s[0] === body.strand) ? body.strand : "";
      const count = Math.max(4, Math.min(10, Number(body.count) || 6));
      const id = pickProvider(ctx.role === "parent" ? body.provider : null, "fsa");   // 学生不能指定引擎，走 config 默认
      if (!id) throw new ActionError(503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      const sys = fsaPrompt(d, strand, lang, count);
      const q = L(lang, "请出这一卷 FSA 模拟练习。", "Please create this FSA-style practice set.");
      const opts = { schema: FSA_SET_SCHEMA, hint: FSA_HINT[lang] };
      const t0 = Date.now();
      log(`[fsa] engine=${id} grade=${g} strand=${strand || "all"} lang=${lang} n=${count}`);
      const set = await generateOnce("fsa", id, "fsa", sys, q, null, null, lang, opts, x => validateFsaSet(x, d, count));
      log(`[fsa] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${set.questions.length} questions`);
      const rec = { time: Date.now(), grade: g, strand, lang, provider: id, title: set.title, questions: set.questions, attempts: [] };
      const unsaved = kidTxn(() => fsaSetsAdd(kidId, rec), { keep: true });
      return Object.assign({ set: rec, provider: id, ms: Date.now() - t0 }, saveWarn(unsaved));
    },
    list(ctx, input) {
      const kidId = needKid(ctx);
      const g = Number((input && input.grade) || 0);
      return { items: kd(kidId).fsaSets.filter(r => !g || r.grade === g).map(fsaSetSummary) };
    },
    get(ctx, input) {
      const kidId = needKid(ctx);
      const { sets, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      return { record: sets[i] };
    },
    /* 删卷是家长动作；权限由路由 allow 把关 */
    remove(ctx, input) {
      const kidId = needKid(ctx);
      const { sets, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      sets.splice(i, 1);
      kidSave(kidId, "fsaSets");
      return { ok: true };
    },
    /* total 以卷内题数为准，right 夹在 [0, total]——不全信客户端 */
    attempt(ctx, body) {
      const kidId = needKid(ctx);
      const rec = kd(kidId).fsaSets.find(r => r.id === String(body.id || ""));
      if (!rec) throw new ActionError(404, NOT_FOUND);
      const total = (rec.questions || []).length;
      const at = {
        time: Date.now(),
        right: Math.min(total, Math.max(0, Math.round(Number(body.right) || 0))),
        total,
        ms: Math.max(0, Math.round(Number(body.ms) || 0))
      };
      rec.attempts = [at, ...(rec.attempts || [])].slice(0, 10);
      kidSave(kidId, "fsaSets");
      return { ok: true };
    },
    clear(ctx) {
      const kidId = needKid(ctx);
      kd(kidId).fsaSets = [];
      kidSave(kidId, "fsaSets");
      log(`[fsa] practice sets cleared (kid=${kidId})`);
      return { ok: true };
    }
  };
};
