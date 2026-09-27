/*
 * TutorAgent（#28，#19 Phase 3）：只答数学学术问题的单智能体。零依赖，跑在 lib/ai/harness 上。
 *
 *   const agent = createTutorAgent({ registry, model, classifierModel, maxSteps, stepTimeoutMs, totalTimeoutMs, onTrace, onTraceError });
 *   const r = await agent.ask(ctx, { question, lang: "zh"|"en", mode: "answer"|"hint", strategy?, signal });
 *   r = { ok, kind: answer|hint|refusal|safety|error, text, gate:{ stage, label, rule? }, steps, calls, checks?, error?, strategy? }
 *
 * strategy（#31，可选）：TUTOR_STRATEGIES 里的一个 Skill id，由可信调用方选，和 mode 一起在公开入口同步快照；
 * 不传时请求 / 提示词 / 结果与 Phase 3 逐字相同。give-hint、socratic-teaching 和 mode=hint 都强制提示输出（结构校验照旧拦答案）。
 *
 * ctx（{ kidId, role, userId }）只由可信调用方（将来的路由：allow + resolveKid）注入；问题文本里的任何内容都改不了它。
 * 工具只有两个只读的：calculator.evaluate、curriculum.findTopic，都经 registry.invoke。写入 / 花钱工具一个不给。
 *
 * 学术范围门控分三层，每一层都可能漏判或误判，合起来也**不是**绝对保证：
 *   1. 确定性预闸 classifyScope（本文件的中英正则）：抓明显的安全求助 / 提示注入 / 非学术请求（含「数学题 + 越界请求」的混合），
 *      命中就给固定模板，不调模型、不调工具。正则针对的是「请求」而不是名词，数学应用题里出现游戏 / 电影不会被拒。
 *   2. 语义分类器接缝 classifierModel：一个只输出 { label, reason } 的模型（同一个 Harness，零工具），标签由 schema 校验；
 *      分类失败 / 超时一律按失败收口（fail closed），不会退回「直接回答」。每个回答前都跑这一步：没配专门的分类模型时，
 *      用主模型单独做一次分类调用（分类提示词、零工具），所以不存在「命中数学关键词就信任自由输出」的路径。
 *      预闸的数学信号只用于统计 / trace，不决定放行。
 *   3. 结构化输出校验：TutorAgent 的 final 必须是 { kind, text, scope, checks? }；非 math 的 scope 只能 refusal；hint 模式不许给答案；
 *      回答正文再过一遍预闸规则并禁止链接；checks 里的每个算式由确定性 calculator 复算，不符就退回模型重写。
 *   拒答 / 安全提示的正文一律换成固定的中英模板，不把模型自由文本给孩子。
 *
 * 两段的 system 提示词来自 lib/ai/skills 的内置目录（math-tutor、math-scope-classifier，#30；教学策略 #31）；Skill 只是文本，
 * 工具名单、门控、结果校验都还在本文件，换 Skill 不会多给任何能力。
 */
"use strict";
const { createHarness } = require("../harness/index.js");
const { check } = require("../tools/schema.js");
const calculator = require("../tools/calculator.js");
const { getSkill, selectTutorSkills, TURN_FORMAT, TUTOR_STRATEGIES } = require("../skills/index.js");

const TUTOR_TOOLS = ["calculator.evaluate", "curriculum.findTopic"];
const SCOPE_LABELS = ["math", "other_academic", "non_academic", "mixed", "injection", "unsafe"];
const MAX_QUESTION = 2000;

/* ---------------- 固定文案（拒答 / 安全 / 出错） ---------------- */
const TEXTS = {
  zh: {
    non_academic: "这个问题不是数学学习的内容，我只能帮你学数学。有数学题想问吗？比如分数、方程或者图形。",
    mixed: "这里只能回答数学问题。请把数学题单独发给我，我们一步一步来。",
    injection: "我只能按数学老师的规则帮你学数学，这些规则不能改。有数学题想问吗？",
    other_academic: "这个问题属于别的学科，这里只辅导数学。有数学题的话随时问我！",
    safety: "听起来你现在可能不太好。请马上告诉爸爸妈妈、老师或者身边信任的大人。如果有危险，请立刻打 911；想找人聊聊可以打或发短信到 9-8-8。",
    error: "我现在暂时回答不了，请稍后再试，或者问问爸爸妈妈。",
  },
  en: {
    non_academic: "That isn't a math learning question, so I can't help with it here. I can only help with math. Want to ask about fractions, equations or shapes?",
    mixed: "I can only help with math here. Please send just the math question on its own and we'll work through it step by step.",
    injection: "I can only help with math under my tutor rules, and those rules can't be changed. Do you have a math question?",
    other_academic: "That's a question for another subject. Here I can only help with math, so ask me any math question!",
    safety: "It sounds like you might not be okay. Please tell a parent, teacher or another adult you trust right now. If you are in danger, call 911. To talk to someone, you can call or text 9-8-8.",
    error: "I can't answer right now. Please try again later, or ask a parent.",
  },
};

/* ---------------- 第 1 层：确定性预闸 ----------------
 * en 规则在 norm（NFKC、小写、去零宽字符、空白合一）上匹配；zh 规则在 compact（再去掉所有空白，防「忽 略 指 令」）上匹配。 */
const R = (id, re) => ({ id, re });
const UNSAFE = {
  en: [R("self-harm", /\b(kill|hurt|harm|cut) (myself|me)\b|\bsuicid|\bwant(s|ed)? to die\b|\bself[- ]?harm|\bend my life\b/)],
  zh: [R("self-harm", /自杀|想死|不想活|伤害自己|割腕|轻生|活着没意思/)],
};
const INJECTION = {
  en: [
    R("ignore-rules", /\b(ignore|disregard|forget|override|bypass)\b.{0,20}\b(previous|prior|above|earlier|all|your|these|those|system)\b.{0,20}\b(instructions?|rules?|prompts?|directions?|guidelines?)\b/),
    R("system-prompt", /\b(system|developer|hidden) (prompt|message|instructions?)\b/),
    R("jailbreak", /\bjailbreak|\bdan mode\b|\bdeveloper mode\b|\bdo anything now\b/),
    R("new-role", /\bfrom now on,? you\b|\byou are now (a|an|my|in)\b/),
    R("reveal-rules", /\b(reveal|show|print|repeat|tell me|what are)\b.{0,15}\b(your (system |hidden |secret )?(prompt|instructions|rules)|(system|hidden|secret) (prompt|instructions|rules))\b/),
  ],
  zh: [
    R("ignore-rules", /(忽略|无视|忘掉|忘记|不要管|别管|跳过)掉?.{0,8}(指令|规则|提示词|提示|设定|限制)/),
    R("system-prompt", /系统提示|开发者模式|越狱/),
    R("new-role", /你现在是|从现在开始你|假装你是/),
    R("reveal-rules", /(告诉|显示|输出|打印|说出).{0,6}(提示词|系统指令|隐藏规则)/),
  ],
};
const NON_ACADEMIC = {
  en: [
    R("joke-story", /\btell me (a |an |another |some )?(joke|story|secret)s?\b/),
    R("play-chat", /\b(let'?s|let us|can we|wanna|want to|do you want to)\b.{0,12}\b(play|chat|hang out)\b|\bchat with me\b|\bi'?m bored\b/),
    R("creative-writing", /\b(write|compose|make up) (me )?(a |an )?(poem|story|song|essay|letter|rap)\b/),
    R("assistant-personal", /\b(what|who|which) (is|are) (your|ur) favou?rite\b|\b(your|ur) favou?rite (movie|song|game|show|singer|food|colou?r|youtuber|team)\b/),
    R("romance", /\b(boyfriend|girlfriend|dating)\b/),
    R("cheat-harm", /\bhow (can|do|to) (i |we )?(cheat|hack|steal)\b|\bcheat on (my |the |a )?(test|exam|quiz|homework)\b/),
    R("dangerous", /\b(bomb|weapons?|guns?|drugs|vape|vaping|alcohol|beer)\b/),
    R("game-cheats", /\b(game|minecraft|fortnite|roblox)\b.{0,10}\b(cheats?|codes?|hacks?|walkthrough)\b/),
  ],
  zh: [
    R("joke-story", /(讲|说)个?(笑话|故事)|给我讲.{0,3}(笑话|故事)/),
    R("play-chat", /陪我(聊|玩)|聊聊天|聊天吧|我们(一起)?玩(游戏)?吧|玩游戏吧|打游戏/),
    R("creative-writing", /写(一|几)?(首|篇|个|封)?(诗|歌词|作文|故事|情书)/),
    R("assistant-personal", /你(最)?喜欢(什么|哪个|谁|吃)/),
    R("romance", /男朋友|女朋友|谈恋爱|表白/),
    R("cheat-harm", /(怎么|如何)(作弊|偷|黑进|骗)|考试作弊/),
    R("dangerous", /炸弹|武器|枪支|毒品|抽烟|喝酒/),
    R("game-cheats", /游戏(攻略|秘籍|作弊码|外挂)/),
  ],
};
const LINK = R("link", /https?:\/\/|\bwww\.|\.(com|net|org|io|cn)\b/);
const MATH = {
  en: /\d\s*[-+*/×÷^%=<>]\s*\d|\b(add|adding|plus|minus|subtract|times|multiply|multiplied|divide|divided|fractions?|decimals?|percent|equations?|solve|area|perimeter|angles?|triangles?|squares?|rectangles?|circles?|graph|slope|integers?|factors?|primes?|ratios?|algebra|geometry|probability|sum|product|quotient|remainder|root|exponents?|power|volume|mean|median|average|how many|how much|calculate|compute|math|numbers?|digits?|place value|round|estimate|measure|equals?)\b/,
  zh: /\d.{0,3}[加减乘除]|[加减乘除]以?.{0,3}\d|分数|小数|百分|方程|面积|周长|角|三角形|因数|倍数|质数|比例|几何|概率|多少|平方|立方|体积|平均|计算|算式|数学|等于|几分之|约分|通分|整数|负数|长方形|正方形|圆/,
};

/* 零宽空格 / 零宽连接符 / 方向标记 / 词连接符 / BOM / 软连字符：用码点拼，源码里不放不可见字符 */
const INVISIBLE = new RegExp("[" + [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0xad].map(c => String.fromCharCode(c)).join("") + "]", "g");
function normalize(s) {
  const norm = String(s).normalize("NFKC").toLowerCase().replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return { norm, compact: norm.replace(/\s+/g, "") };
}
function firstHit(rules, n) {
  for (const r of rules.en) if (r.re.test(n.norm)) return r.id;
  for (const r of rules.zh) if (r.re.test(n.compact)) return r.id;
  return null;
}
/* → { label: unsafe|injection|non_academic|math|uncertain, rule?, mixed } —— 只是第一道筛子，不是学术判定本身 */
function classifyScope(question) {
  const n = normalize(question);
  const hasMath = MATH.en.test(n.norm) || MATH.zh.test(n.compact);
  let rule;
  if ((rule = firstHit(UNSAFE, n))) return { label: "unsafe", rule, mixed: hasMath };
  if ((rule = firstHit(INJECTION, n))) return { label: "injection", rule, mixed: hasMath };
  if ((rule = firstHit(NON_ACADEMIC, n))) return { label: "non_academic", rule, mixed: hasMath };
  return { label: hasMath ? "math" : "uncertain", mixed: false };
}
/* 回答正文的确定性复查：同一套规则 + 禁止链接。返回命中的规则 id 或 null */
function screenText(text) {
  const n = normalize(text);
  if (LINK.re.test(n.norm)) return LINK.id;
  return firstHit(UNSAFE, n) || firstHit(INJECTION, n) || firstHit(NON_ACADEMIC, n);
}

/* ---------------- 提示词：来自内置 Skill 目录（#30），原文与 Phase 3 逐字相同，导出名保持 ---------------- */
const TUTOR_SYSTEM = getSkill("math-tutor").instructions;
const CLASSIFIER_SYSTEM = getSkill("math-scope-classifier").instructions;

const FINAL_SCHEMA = {
  type: "object", required: ["kind", "text", "scope"], additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["answer", "hint", "refusal"] },
    text: { type: "string", minLength: 1, maxLength: 4000 },
    scope: { type: "string", enum: SCOPE_LABELS },
    checks: { type: "array", maxItems: 10, items: { type: "object", required: ["expression", "value"], additionalProperties: false, properties: { expression: { type: "string", minLength: 1, maxLength: 200 }, value: { type: "number" } } } },
  },
};
const LABEL_SCHEMA = { type: "object", required: ["label"], additionalProperties: false, properties: { label: { type: "string", enum: SCOPE_LABELS }, reason: { type: "string", maxLength: 300 } } };

function validateLabel(o) {
  const v = check(LABEL_SCHEMA, o);
  if (!v.ok) throw new Error("classification must be {label, reason}: " + v.errors.slice(0, 5).join("; "));
  return { label: o.label, reason: o.reason || "" };
}
function makeValidateFinal(mode) {
  return function validateFinal(o) {
    const v = check(FINAL_SCHEMA, o);
    if (!v.ok) throw new Error("final output does not match the schema: " + v.errors.slice(0, 5).join("; "));
    if (o.kind !== "refusal") {
      if (o.scope !== "math") throw new Error(`only math questions may be answered; scope "${o.scope}" needs kind "refusal"`);
      if (mode === "hint" && o.kind === "answer") throw new Error('hint mode: give a hint (kind "hint"), not the answer');
      const hit = screenText(o.text);
      if (hit) throw new Error(`answer text contains off-scope content (${hit}); keep to the math, no links`);
      for (const c of o.checks || []) {
        let val;
        try { val = calculator.evaluate(c.expression); } catch (e) { throw new Error(`check "${c.expression}" cannot be evaluated: ${e.message}`); }
        if (Math.abs(val - c.value) > 1e-9 * Math.max(1, Math.abs(val))) throw new Error(`check failed: ${c.expression} = ${val}, not ${c.value}; fix the answer`);
      }
    }
    return { kind: o.kind, text: o.text, scope: o.scope, ...(o.checks ? { checks: o.checks } : {}) };
  };
}

const REFUSAL_TEMPLATE = { non_academic: "non_academic", mixed: "mixed", injection: "injection", other_academic: "other_academic", math: "non_academic" };

function createTutorAgent(opts) {
  opts = opts || {};
  if (!opts.model || typeof opts.model.next !== "function") throw new TypeError("tutor: model with next(req) is required");
  if (opts.classifierModel && typeof opts.classifierModel.next !== "function") throw new TypeError("tutor: classifierModel must have next(req)");
  const now = opts.now || Date.now;
  const totalTimeoutMs = opts.totalTimeoutMs == null ? 90000 : opts.totalTimeoutMs;
  const onTrace = opts.onTrace || (() => {});
  const onTraceError = opts.onTraceError;
  const common = { registry: opts.registry, stepTimeoutMs: opts.stepTimeoutMs, totalTimeoutMs, onTrace, onTraceError, now: opts.now };
  /* 两个 Harness 都在构造时校验：tutor 只拿两个只读工具（缺了就 TypeError），分类器零工具 */
  const tutor = createHarness(Object.assign({}, common, { tools: TUTOR_TOOLS, allowRisks: ["read"], maxSteps: opts.maxSteps == null ? 6 : opts.maxSteps, maxInvalid: 2, modelRetries: 1 }));
  /* 每个回答前都必须过语义分类：没给专门的分类模型就用主模型单独问一次（分类提示词、零工具），不存在「只凭数学关键词直接回答」的路径 */
  const classifier = createHarness(Object.assign({}, common, { tools: [], maxSteps: 2, maxInvalid: 1, modelRetries: 1 }));
  const classifierModel = opts.classifierModel || opts.model;
  /* 默认两段组合构造时取一次（冻结），不传 strategy 的 ask 都用这一份；显式 strategy 每次 ask 各自选（也是冻结的共享对象），
   * agent 上不存任何「当前策略」，并发请求之间没有可变状态可串 */
  const skills = selectTutorSkills();

  function emit(t) {
    const swallow = e => { try { const p = onTraceError && onTraceError(e, t); if (p && typeof p.then === "function") p.then(null, () => {}); } catch (_) { } };
    try { const p = onTrace(t); if (p && typeof p.then === "function") p.then(null, swallow); } catch (e) { swallow(e); }
  }

  async function ask(ctx, req) {
    req = req || {};
    const lang = req.lang === "en" ? "en" : "zh";
    const T = TEXTS[lang];
    let steps = 0, calls = [], sel = null;
    const done = (kind, text, gate, extra) => {
      const r = Object.assign({ ok: kind !== "error", kind, text, gate, steps, calls }, extra || {}, sel ? { strategy: sel.strategy } : {});
      emit(Object.assign({ kind: "tutor", outcome: kind, stage: gate.stage, label: gate.label, code: r.error && r.error.code, at: now() }, sel ? { strategy: sel.strategy } : {}));
      return r;
    };
    const fail = (stage, code, message) => done("error", T.error, { stage }, { error: { code, message } });
    const refuse = (stage, label, template, rule) => label === "unsafe" || template === "safety"
      ? done("safety", T.safety, Object.assign({ stage, label: "unsafe" }, rule ? { rule } : {}))
      : done("refusal", T[template], Object.assign({ stage, label }, rule ? { rule } : {}));

    /* 0：可信调用方给的上下文和输入 */
    const validCtx = ctx && typeof ctx === "object" && ["student", "parent"].includes(ctx.role) && (ctx.kidId == null || (typeof ctx.kidId === "string" && ctx.kidId.length > 0));
    if (!validCtx) return fail("input", "INVALID_CTX", "ctx must be { role: student|parent, kidId, userId } from the caller");
    /* 整个 ask 只取一次快照：分类、tutor 两段都用它，调用方中途改自己的对象不影响 */
    const sctx = Object.freeze({ kidId: ctx.kidId == null ? null : ctx.kidId, role: ctx.role, userId: ctx.userId == null ? null : String(ctx.userId) });
    const q = req.question;
    if (typeof q !== "string" || !q.trim() || q.length > MAX_QUESTION) return fail("input", "INVALID_INPUT", `question must be a non-empty string up to ${MAX_QUESTION} characters`);
    if (req.mode != null && req.mode !== "answer" && req.mode !== "hint") return fail("input", "INVALID_INPUT", "mode must be answer or hint");
    const mode = req.mode || "answer";
    /* 显式策略：未知 / null / 非字符串在调用任何模型前失败。选中的组合决定 tutor 段 system 和实际输出模式（hint 优先） */
    if (req.strategy !== undefined) {
      if (typeof req.strategy !== "string" || !TUTOR_STRATEGIES.includes(req.strategy)) return fail("input", "INVALID_INPUT", "strategy must be one of: " + TUTOR_STRATEGIES.join(", "));
      try { sel = selectTutorSkills({ strategy: req.strategy, mode }); } catch (_) { return fail("input", "INVALID_INPUT", "strategy could not be selected"); }
    }
    const outMode = sel ? sel.mode : mode;
    /* 不传 strategy：input 仍是 {question, lang, mode}，system 仍是构造时的默认组合，与 Phase 3 逐字相同 */
    const tutorSystem = sel ? sel.tutor.system : skills.tutor.system;
    const tutorInput = sel ? JSON.stringify({ question: q, lang, mode: outMode, strategy: sel.strategy }) : JSON.stringify({ question: q, lang, mode });
    const deadlineAt = now() + totalTimeoutMs;

    /* 1：确定性预闸 */
    const g = classifyScope(q);
    if (g.label === "unsafe") return refuse("pregate", "unsafe", "safety", g.rule);
    if (g.label === "injection") return refuse("pregate", "injection", "injection", g.rule);
    if (g.label === "non_academic") return refuse("pregate", "non_academic", g.mixed ? "mixed" : "non_academic", g.rule);

    /* 2：语义分类（每次都跑；失败即收口，不退回「直接回答」） */
    const c = await classifier.run({ ctx: sctx, model: classifierModel, system: skills.classifier.system, input: JSON.stringify({ question: q }), validateFinal: validateLabel, signal: req.signal, deadlineAt });
    steps += c.steps;
    if (!c.ok) return fail("classifier", c.error.code, c.error.message);
    const label = c.output.label;
    if (label === "unsafe") return refuse("classifier", "unsafe", "safety");
    if (label !== "math") return refuse("classifier", label, REFUSAL_TEMPLATE[label] || "non_academic");

    /* 3：Harness 循环 + 结构化结果校验 */
    const r = await tutor.run({ ctx: sctx, model: opts.model, system: tutorSystem, input: tutorInput, validateFinal: makeValidateFinal(outMode), signal: req.signal, deadlineAt });
    steps += r.steps; calls = r.calls;
    if (!r.ok) return fail("model", r.error.code, r.error.message);
    const o = r.output;
    if (o.kind === "refusal") return refuse("model", o.scope, o.scope === "unsafe" ? "safety" : (REFUSAL_TEMPLATE[o.scope] || "non_academic"));
    return done(o.kind, o.text, { stage: "model", label: "math" }, o.checks ? { checks: o.checks } : undefined);
  }

  /* 公开入口：同步取 ctx 和请求字段（含 strategy、mode）的快照，每个字段只读一次（调用方拿到 promise 后同一个 tick 里改对象、
   * getter 每次换值都不影响这次 ask），之后才进异步流程；永远 resolve，任何意外异常也只变成 kind:"error" 的固定文案 */
  function safeAsk(ctx, req) {
    let snapCtx, snapReq, lang = "zh";
    try {
      snapCtx = ctx && typeof ctx === "object" ? { kidId: ctx.kidId, role: ctx.role, userId: ctx.userId } : ctx;
      /* strategy 只认自有属性：Object.prototype 被污染时，不传 strategy 的请求仍走默认路径 */
      snapReq = req && typeof req === "object" ? { question: req.question, lang: req.lang, mode: req.mode, strategy: Object.prototype.hasOwnProperty.call(req, "strategy") ? req.strategy : undefined, signal: req.signal } : {};
      lang = snapReq.lang === "en" ? "en" : "zh";
    } catch (e) {
      return Promise.resolve(internalError(lang, e));
    }
    return Promise.resolve().then(() => ask(snapCtx, snapReq)).catch(e => internalError(lang, e));
  }
  function internalError(lang, e) {
    return {
      ok: false, kind: "error", text: TEXTS[lang].error, gate: { stage: "internal" },
      steps: 0, calls: [], error: { code: "INTERNAL", message: String((e && e.message) || e).slice(0, 300) },
    };
  }

  return { ask: safeAsk, tools: TUTOR_TOOLS.slice(), skills: { tutor: skills.tutor.ids.slice(), classifier: skills.classifier.ids.slice() } };
}

module.exports = { createTutorAgent, classifyScope, screenText, TUTOR_TOOLS, SCOPE_LABELS, TEXTS, TUTOR_SYSTEM, CLASSIFIER_SYSTEM, TURN_FORMAT, FINAL_SCHEMA };
