/*
 * 家长报告 Action（#25）：view（实时，确定性计算）/ generateFull（💰 LLM 写叙事）/ listFull / getFull / removeFull。
 * 逻辑从 /api/report* 原样搬来。家长专属由路由 allow 把关。
 * deps：kd, kidSave, kidTxn, saveWarn, reportsAdd, reportSummary, curriculum, curriculumGrades, curriculumKey, strandGroups,
 *       standardEvidence, itemTerms, userById, publicUser, normLang, pickProvider, L, buildReportDigest, reportPrompt,
 *       REPORT_SCHEMA, REPORT_HINT, validateFullReport, generateOnce, log
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

module.exports = function createReportActions(deps) {
  const { kd, kidSave, kidTxn, saveWarn, reportsAdd, reportSummary, curriculum, curriculumGrades, curriculumKey, strandGroups,
    standardEvidence, itemTerms, userById, publicUser, normLang, pickProvider, L, buildReportDigest, reportPrompt,
    REPORT_SCHEMA, REPORT_HINT, validateFullReport, generateOnce } = deps;
  const log = deps.log || console.log;
  const NOT_FOUND = { error: "报告不存在 / Not found" };
  const NO_DATA_MSG = "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet";
  const find = (kidId, id) => { const list = kd(kidId).reports; const i = list.findIndex(r => r.id === String(id || "")); return { list, i }; };

  return {
    /* 实时报告：按主线汇总 + BC 四级话术级别，全部确定性计算 */
    view(ctx, input) {
      const kidId = needKid(ctx);
      const grades = curriculumGrades();
      const g = curriculumKey((input && input.grade) || 0);
      const d = curriculum.get(g);
      if (!d) throw new ActionError(404, { error: NO_DATA_MSG, grades });
      const strands = strandGroups(d, it => {
        /* 级别 / 计数 / 技能汇总全从 standardEvidence 拿，和 AI 完整报告同一套口径（设计文档 §6）：
         * 有技能挂靠的标准，级别由技能汇总决定，家长星标仍是最高优先级；老口径那条记录在 skills.legacy 里，前端分开显示。
         * 没有技能挂靠（高中、书籍）时 skills 是 null，报告和以前一模一样。 */
        const ev = standardEvidence(kidId, it.id);
        const status = ev.level === "emerging" ? "new" : ev.level === "developing" ? "seen" : "solid";
        return {
          id: it.id, en: it.en, zh: it.zh,
          status, level: ev.level,
          manualSolid: ev.manualSolid,   // 家长手动标记的「扎实」，前端星标可切换
          taught: ev.taught, right: ev.right, wrong: ev.wrong, lastAt: ev.lastAt,
          ...(ev.skills ? { skills: ev.skills } : {})
        };
      }).map(sg => Object.assign(sg, {
        total: sg.items.length,
        seen: sg.items.filter(i => i.status !== "new").length,
        solid: sg.items.filter(i => i.status === "solid").length
      }));
      const totals = strands.reduce((a2, sg) => ({ total: a2.total + sg.total, seen: a2.seen + sg.seen, solid: a2.solid + sg.solid }),
        { total: 0, seen: 0, solid: 0 });
      // 术语对照：这个年级大纲里出现过的中英术语，随报告打印（家长看成绩单/和老师面谈用）
      const termSeen = new Set(); const terms = [];
      for (const it of (d.items || [])) for (const tm of itemTerms(it)) {
        const k = tm.en.toLowerCase();
        if (!termSeen.has(k)) { termSeen.add(k); terms.push({ en: tm.en, zh: tm.zh }); }
      }
      const kidUser = userById(kidId);
      return { grade: g, grades, source: d.source, strands, totals, terms, kid: kidUser ? publicUser(kidUser) : null };
    },
    /* 完整报告：服务端先确定性算出事实摘要 digest，LLM 只基于 digest 写叙事；报告 = 叙事 + digest 附录 */
    async generateFull(ctx, body) {
      const kidId = needKid(ctx);
      const lang = normLang(body.lang);
      const g = curriculumKey(body.grade || 0);
      const digest = buildReportDigest(kidId, g);
      if (!digest) throw new ActionError(404, { error: NO_DATA_MSG });
      const id = pickProvider(body.provider, "report");
      if (!id) throw new ActionError(503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      const kidUser = userById(kidId);
      const sys = reportPrompt(kidUser ? kidUser.name : "", lang);
      const q = L(lang, "学习数据如下：\n", "The learning data:\n") + JSON.stringify(digest);
      const opts = { schema: REPORT_SCHEMA, hint: REPORT_HINT[lang] };
      const t0 = Date.now();
      log(`[report] engine=${id} kid=${kidId} grade=${g} lang=${lang}`);
      const content = await generateOnce("report", id, "report", sys, q, null, null, lang, opts, validateFullReport);
      log(`[report] ok in ${Math.round((Date.now() - t0) / 1000)}s`);
      const rec = { time: Date.now(), grade: String(g), lang, provider: id, kidName: kidUser ? kidUser.name : "", digest, content };
      const unsaved = kidTxn(() => reportsAdd(kidId, rec), { keep: true });   // 报告是花钱写出来的：存不下也先给家长看
      return Object.assign({ report: rec, ms: Date.now() - t0 }, saveWarn(unsaved));
    },
    listFull(ctx) { const kidId = needKid(ctx); return { items: kd(kidId).reports.map(reportSummary) }; },
    getFull(ctx, input) {
      const kidId = needKid(ctx);
      const { list, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      return { record: list[i] };
    },
    removeFull(ctx, input) {
      const kidId = needKid(ctx);
      const { list, i } = find(kidId, input && input.id);
      if (i < 0) throw new ActionError(404, NOT_FOUND);
      list.splice(i, 1);
      kidSave(kidId, "reports");
      return { ok: true };
    }
  };
};
