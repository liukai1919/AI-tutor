/*
 * 讲课 Action（#25）：create。逻辑从 POST /api/lesson 原样搬来。
 *   mode="teach"：讲一个大纲知识点，先查随包课程包（秒开、免费、断网也行），fresh=true 或没命中才调引擎；
 *   其余（solve）：孩子自己打字 / 拍照提问，总是调引擎。
 * deps：kd, kidTxn, saveWarn, historyAdd, progressRecord, progressStatus, userById, normLang, findCurriculumItem, L,
 *       lessonPackGet, ttsAvailable, ttsStates, ledgerAdd, pickProvider, PROVIDER_META, systemPromptTeach, systemPrompt,
 *       validateLesson, generateOnce, log
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

module.exports = function createLessonActions(deps) {
  const { kidTxn, saveWarn, historyAdd, progressRecord, progressStatus, userById, normLang, findCurriculumItem, L,
    lessonPackGet, ttsAvailable, ttsStates, ledgerAdd, pickProvider, PROVIDER_META, systemPromptTeach, systemPrompt,
    validateLesson, generateOnce } = deps;
  const log = deps.log || console.log;

  return {
    async create(ctx, body) {
      const kidId = needKid(ctx);
      const kidUser = userById(kidId);
      const kidName = kidUser ? kidUser.name : "";   // 讲课称呼来自账号，不再信请求体
      let question = String(body.question || "").slice(0, 4000);
      const imageB64 = body.imageB64 || null;
      const mediaType = body.mediaType || "image/jpeg";
      const lang = normLang(body.lang);
      const mode = body.mode === "teach" ? "teach" : "solve";
      let teachCtx = null;
      if (mode === "teach") {
        teachCtx = findCurriculumItem(String(body.curriculumId || ""));
        if (!teachCtx) throw new ActionError(400, { error: L(lang, "找不到这个知识点，刷新一下再试。", "Can't find that curriculum topic — refresh and try again.") });
        // teach 模式 question 可为空；补一个课题名，历史记录和日志里好认
        if (!question) question = lang === "en" ? teachCtx.item.en : `${teachCtx.item.zh}（${teachCtx.item.en}）`;
      } else if (!question && !imageB64) throw new ActionError(400, { error: L(lang, "题目是空的", "The question is empty.") });

      // 预生成课程包：teach 模式先查包，命中就不用引擎。fresh=true 是「换个讲法再讲一遍」，那条路照旧走引擎。
      if (teachCtx && !body.fresh) {
        const packed = lessonPackGet(teachCtx.item.id, lang);
        if (packed) {
          const rec = { time: Date.now(), question, hasImage: false, lang, grade: String(body.grade || ""),
            provider: "pack", lesson: packed, mode: "teach", curriculumId: teachCtx.item.id };
          const unsaved = kidTxn(() => {
            historyAdd(kidId, rec);
            progressRecord(kidId, teachCtx.item.id, "taught", rec.id);
          }, { keep: true });   // 课照上，没存上就明说
          if (ttsAvailable() && packed.isMath !== false) {
            try { ttsStates(packed.steps.map(s => ({ text: s.say, lang })), lang); } catch (_) {}
          }
          log(`[lesson] pack hit ${teachCtx.item.id} lang=${lang} kid=${kidId}`);
          ledgerAdd({ task: "teach", provider: "pack", lang, ms: 0, ok: true });
          return Object.assign({
            lesson: packed, provider: "pack", ms: 0, tts: ttsAvailable(), packed: true,
            curriculumId: teachCtx.item.id, status: progressStatus(kidId, teachCtx.item.id), lessonId: rec.id
          }, saveWarn(unsaved));
        }
      }

      const id = pickProvider(ctx.role === "parent" ? body.provider : null, teachCtx ? "teach" : "ask");   // 学生不能指定引擎
      if (!id) throw new ActionError(503, {
        error: L(lang,
          (teachCtx ? "这一节课不在随附的课程包里，现场讲需要一个 AI 引擎。"
                    : "自己出题（打字或拍照）需要一个 AI 引擎——「跟大纲学」里的课不用，可以直接上。") + "怎么装看 README（Ollama 免费离线 / claude / gemini / grok / codex 或 API）。",
          (teachCtx ? "This lesson isn't in the bundled course pack, so teaching it live needs an AI engine."
                    : "Asking your own question (typed or photographed) needs an AI engine — the lessons under Follow the curriculum don't, so you can start there.") + " See the README to set one up (Ollama is free and offline / claude / gemini / grok / codex or an API)."),
        needsEngine: true });
      if (imageB64 && !PROVIDER_META[id].supportsImage) {
        throw new ActionError(400, { error: L(lang,
          PROVIDER_META[id].label + " 暂不支持看图，请把题目打字输入，或在设置里换一个支持看图的引擎。",
          (PROVIDER_META[id].labelEn || id) + " can't read images yet. Type the question, or pick an engine that supports images in Settings.") });
      }

      const sys = teachCtx
        ? systemPromptTeach(teachCtx.item, teachCtx.data, kidName, lang)
        : systemPrompt(body.grade, kidName, lang, Number(body.gradeCode) || 0);
      const t0 = Date.now();
      log(`[lesson] engine=${id} mode=${mode} kid=${kidId} lang=${lang} q="${question.slice(0, 40)}" image=${!!imageB64}`);
      const lesson = await generateOnce("lesson", id, teachCtx ? "teach" : "ask", sys, question, imageB64, mediaType, lang, null, validateLesson);
      log(`[lesson] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${lesson.steps.length} steps`);
      const rec = { time: Date.now(), question, hasImage: !!imageB64, lang, grade: String(body.grade || ""), provider: id, lesson };
      if (teachCtx) { rec.mode = "teach"; rec.curriculumId = teachCtx.item.id; }
      const unsaved = kidTxn(() => {
        historyAdd(kidId, rec);
        // 生成即视为「讲过」：进度立刻从 new 变 seen，并把这节课挂到知识点上
        if (teachCtx) progressRecord(kidId, teachCtx.item.id, "taught", rec.id);
      }, { keep: true });   // 讲解是花时间/花钱生成的：存不下也照样讲，响应里明说没存上
      // 讲解生成好就立刻预合成语音（不等前端），孩子点开第一步时大概率已就绪
      if (ttsAvailable() && lesson.isMath !== false) {
        try { ttsStates(lesson.steps.map(s => ({ text: s.say, lang })), lang); } catch (_) {}
      }
      const resp = Object.assign({ lesson, provider: id, ms: Date.now() - t0, tts: ttsAvailable() }, saveWarn(unsaved));
      // lessonId 带回给前端：清单/FSA 错题下次点开直接重播这节课，不再重新生成
      if (teachCtx) { resp.curriculumId = teachCtx.item.id; resp.status = progressStatus(kidId, teachCtx.item.id); resp.lessonId = rec.id; }
      return resp;
    }
  };
};
