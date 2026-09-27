#!/usr/bin/env node
/*
 * 构建期：把「跟大纲学」的课和闯关题一次性生成好，随安装包发出去。
 *
 * 为什么要有它：讲课本来按需现场生成，装完机器上没有 AI 引擎就什么都点不动。
 * 预生成一份课程包（data/lessons/<lang>/<条目id>.json）和题库（qbank.json）之后，
 * 「跟大纲学」和「闯关」变成秒开、免费、断网也能用；拍照出题那类还是得有引擎。
 *
 * 用法：
 *   node tools/pregen.mjs                    # BC 全年级（K-9 年级 + 10-12 分科课程）、中英双语、课 + 题
 *   node tools/pregen.mjs --grades 5,6       # 只做某几个年级；分科课程用 id（--grades 8,9,fmp10,pc11,pc12）
 *   node tools/pregen.mjs --langs zh         # 只做一种语言
 *   node tools/pregen.mjs --only lessons     # 只做课（quiz 只做闯关题库，unit 只做单元测试卷）
 *   node tools/pregen.mjs --provider claude  # 一刀切指定引擎（默认按 config.json 的
 *                                            # providerByTask["pregen:teach"|"pregen:quiz"|"pregen:unit"] 路由，再退 provider/自动挑）
 *   node tools/pregen.mjs --judge [claude]   # 生成完送审稿引擎核数学/贴题（便宜引擎跑批 + 强引擎审）：
 *                                            # 没过重生成一次再审，仍没过放弃这条留给下次；
 *                                            # 裸 --judge 按 config providerByTask["judge:*"] 挑审稿引擎，
 *                                            # 写了名字就必须是它——没装/写错当场报错，不悄悄换人
 *   node tools/pregen.mjs --concurrency 3    # 并发（默认 2；CLI 类引擎别开太大）
 *   node tools/pregen.mjs --limit 3          # 只做前 N 个（先验货再开大批）
 *   node tools/pregen.mjs --force            # 已生成的也重做
 *   node tools/pregen.mjs --books            # 书籍课程也算进来（版权自负，默认只做 BC）
 *   node tools/pregen.mjs --no-skills        # 不做技能图谱（data/curriculum/skills/）；2026-09-02 起技能默认就做
 *   node tools/pregen.mjs --grades 5 --only quiz             # 只给 G5（主线 + 技能）出题库
 *   node tools/pregen.mjs --only quiz --pilot                # 只做 23 个带诊断分支的试点技能（先验货）
 *   node tools/pregen.mjs --only quiz --core                 # 只做核心技能，拓展技能先不花钱
 *   node tools/pregen.mjs --dry              # 只列要做什么，不真跑
 *
 * 断点续跑：已有的默认跳过，中途 Ctrl-C 再跑一次接着做。
 *
 * 英文逐题审稿 v2（#45；不带 --review v2 时上面的老行为一字不变）：
 *   node tools/pregen.mjs --review v2 --skill YY.MATH.FRAC.EQUIV.VISUAL,YY.MATH.DATA.LINE.READ --judge claude
 *     只做 --skill 点名的条目（原样的条目 id，逗号分隔；没点名 / 不认识 / 重复 → 报错，绝不默认跑整套），只做英文闯关题库。
 *     每个条目：续跑能接着做的 draft → 审题库里没有「当前版本证据」的已有题 → 通过数不足 4 道的级别出一批新题
 *     → 硬校验 → 逐题审稿 → 只修 revise 的题（有上限）→ 通过的才进题库；审稿记录 / draft / 报告在 DATA_ROOT/qbank-review/。
 *     「当前版本证据」= 这道题此刻的内容 + brief / 课文 / 规则 / rubric + 这个审稿引擎的有效非 dry pass；老的「题库满了」不算。
 *   可选：--provider <引擎>（出题）  --judge [<引擎>]（审稿和修复；裸 --judge / 不写 = config.providerByTask["judge:quiz"] 或自动）
 *         --concurrency N（1-8，按条目并发）  --review-timeout 秒（每次审稿 / 修复调用，默认 180）  --dry（只列计划：不调模型、不写文件）
 *     点名的引擎、config 里配的路由必须真的可用，不可用就报错，不悄悄换人。
 *     不能和 --grades / --books / --no-skills / --skills / --core / --pilot / --limit / --force / --unit-count 一起用；
 *     --langs 只能是 en、--only 只能是 quiz（不写也行）。
 *   退出码：0 = 点名的条目都齐了；1 = 有故障（旁路记录 / 题库写盘 / 发布失败等，先查）；2 = 没故障但没做完（有题要重试 / 题库不齐）。
 *
 * 老流程也能只做点名条目（试点对照组用；不写 --review 仍不认 --skill）：
 *   node tools/pregen.mjs --review v1 --skill YY.MATH.FRAC.EQUIV.VISUAL --only quiz --langs en --provider claude --judge claude
 *     课和题库只做这些条目，不做单元卷；不能和 --grades / --books / --no-skills / --skills / --core / --pilot / --limit 一起用，
 *     --only 只能是 all / lessons / quiz，--langs 只能是 zh / en。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { parseCli, failArgs, exitWhenDone, runPregenV2, resolveSelection } from "./lib/qbank_v2_cli.mjs";

/* 先查参数再加载 server.js：写错的参数不加载题库、不探测引擎（--review / --skill 的检查见 qbank_v2_cli.mjs） */
const CLI = parseCli(process.argv.slice(2), "pregen");
if (CLI.errors.length) { failArgs(CLI.errors, "用法见 tools/pregen.mjs 文件头。"); process.exit(1); }
const V2 = CLI.review === "v2";

const require = createRequire(import.meta.url);
const S = require("../server.js");   // 只借提示词和引擎适配器，require 进来不会监听端口

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flag = name => argv.includes("--" + name);
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const LANGS = String(opt("langs", "zh,en")).split(",").map(s => s.trim()).filter(s => s === "zh" || s === "en");
const ONLY = String(opt("only", "all"));
const CONCURRENCY = Math.max(1, Math.min(8, Number(opt("concurrency", 2)) || 2));
const FORCE = flag("force");
const WITH_BOOKS = flag("books");
const WITH_SKILLS = !flag("no-skills"); // 技能图谱（G4–G9 默认清单）：2026-09-02 起默认做，--no-skills 才跳过（--skills 仍认，兼容老命令）
const DRY = flag("dry");
const GRADES = String(opt("grades", "")).split(",").map(s => s.trim()).filter(Boolean);
const JUDGE = flag("judge");                 // 生成完送另一个引擎审稿：没过重来一次，仍没过就放弃这条
const JUDGE_CLI = opt("judge", null);        // --judge claude = 指定审稿引擎；裸 --judge 按 providerByTask["judge:*"] 路由
const doLessons = ONLY === "all" || ONLY === "lessons";
const doQuiz = ONLY === "all" || ONLY === "quiz";
const doUnit = ONLY === "all" || ONLY === "unit";

/* ---------------- 工作清单 ---------------- */
function sources() {
  const out = [];
  for (const g of S.curriculumGrades()) {
    if (GRADES.length && !GRADES.includes(String(g))) continue;
    out.push(S.curriculum.get(g));
  }
  // 10-12 年级分科课程（FMP10 / Pre-calc 11 / Pre-calc 12）：BC 公开材料，和年级一样默认就做
  for (const c of S.curriculumCourses()) {
    if (GRADES.length && !GRADES.includes(c.id)) continue;
    out.push(S.curriculum.get(c.id));
  }
  if (WITH_BOOKS) for (const b of S.curriculumBooks()) out.push(S.curriculum.get(b.id));
  /* 技能图谱：默认打开（--no-skills 关）；--grades 用它的 id（skills-g5）或光写年级数字（5）都认 */
  if (WITH_SKILLS) for (const sp of S.curriculumSkillsPreviews()) {
    if (GRADES.length && !GRADES.includes(sp.id) && !GRADES.includes(String(sp.grade))) continue;
    out.push(S.curriculum.get(sp.id));
  }
  return out;
}
const sourceTag = d => d.type === "book" ? d.bookId : d.type === "course" ? d.courseId : d.type === "skills-preview" ? d.skillsId : "G" + d.grade;
const jobs = [];
for (const data of sources()) {
  for (const item of data.items || []) {
    for (const lang of LANGS) jobs.push({ item, data, lang });
  }
}

/* 单元 = 大纲的一条主线 / 教材的一章。卷子内容只由（年级, 单元, 语言）决定，所以能预生成。 */
const unitJobs = [];
for (const data of sources()) {
  const gradeKey = data.type === "book" ? String(data.bookId) : data.type === "course" ? String(data.courseId) : data.type === "skills-preview" ? String(data.skillsId) : String(data.grade);
  for (const strand of [...new Set((data.items || []).map(it => it.strand))]) {
    const def = (data.strandDefs || S.STRANDS).find(s => s[0] === strand);
    if (!def) continue;
    for (const lang of LANGS) unitJobs.push({ data, gradeKey, strand, def, lang });
  }
}
/* --review v1 --skill：老流程只做点名条目的课和题库（原样的条目 id，技能取它自己年级那份视图），不做单元卷——
 * 试点对照组要和 v2 同一批技能、同样的量。不带 --skill 时这里什么都不做。 */
const V1_SEL = CLI.v1 ? resolveSelection(S, CLI.v1.skills) : null;
if (V1_SEL && V1_SEL.errors.length) { failArgs(V1_SEL.errors); process.exit(1); }
if (V1_SEL) {
  const keep = new Set(V1_SEL.selected.map(x => x.item));
  jobs.splice(0, jobs.length, ...jobs.filter(j => keep.has(j.item)));
  unitJobs.length = 0;
}
const unitFile = (gradeKey, strand, lang) => path.join(S.UNIT_PACK_DIR, lang, gradeKey + "-" + strand + ".json");
/* done 判定从「能用」收紧为「完整」（2026-08-24 审计）：主题卷要满 8 题且 3/3/2，课程的练习要成对，
 * 题库每级要满 4 道。运行时的宽松判定（unitPackGet/qbankPlayable）保持不动——已经发出去的安装包
 * 缺题也得能开局；缺口只在生成侧由这里判为未完成、下次 pregen 补齐。 */
function unitDone(j) {
  const set = S.unitPackGet(j.gradeKey, j.strand, j.lang);
  if (!set) return false;
  if (!String(j.gradeKey).startsWith("skills-")) return true;   // 老的主线卷没有 8 题/3-3-2 约定
  const lv = { 1: 0, 2: 0, 3: 0 };
  for (const q of set.questions) lv[q.level] = (lv[q.level] || 0) + 1;
  return set.questions.length === 8 && lv[1] === 3 && lv[2] === 3 && lv[3] === 2;
}

const lessonFile = (id, lang) => path.join(S.LESSON_PACK_DIR, lang, id + ".json");
function lessonDone(j) {
  try {
    const raw = JSON.parse(fs.readFileSync(lessonFile(j.item.id, j.lang), "utf8"));
    const l = raw && raw.lesson ? raw.lesson : raw;
    if (!Array.isArray(l.steps) || !l.steps.length || l.steps.some(s => !String(s.say || "").trim())) return false;
    const q = String((l.practice || {}).question || "").trim(), a = String((l.practice || {}).answer || "").trim();
    return !!q === !!a;   // 练习单边空 = 生成截断（见 BC.MATH.G4.NUM.01 zh 旧例）
  } catch (_) { return false; }
}
function quizDone(j) {
  const bank = S.qbankPlayable(j.item.id, j.lang);
  return !!bank && [1, 2, 3].every(lv => bank.questions.filter(q => q.level === lv).length >= 4);
}

const LIMIT = Number(opt("limit", 0)) || 0;
const cap = a => LIMIT ? a.slice(0, LIMIT) : a;
/* 技能图谱的两个子集开关（只对技能条目生效，BC 条目/书籍没有 item.skill，不受影响）：
 *   --core   只做核心技能（core:true），拓展技能先不花钱——设计文档 §7 阶段 2 的建议顺序
 *   --pilot  只做带诊断分支的 23 个试点技能，先验货再开大批 */
const ONLY_CORE = flag("core");
const ONLY_PILOT = flag("pilot");
const skillOk = j => !j.item.skill || ((!ONLY_CORE || j.item.skill.core !== false) && (!ONLY_PILOT || !!j.item.skill.diag));
const todoLessons = V2 ? [] : cap(doLessons ? jobs.filter(j => skillOk(j) && (FORCE || !lessonDone(j))) : []);
const todoQuiz = V2 ? [] : cap(doQuiz ? jobs.filter(j => skillOk(j) && (FORCE || !quizDone(j))) : []);
const todoUnit = V2 ? [] : cap(doUnit ? unitJobs.filter(j => FORCE || !unitDone(j)) : []);

/* ---------------- 小工具 ---------------- */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
  fs.renameSync(tmp, file);
}
const hhmmss = ms => {
  const s = Math.round(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};
async function pool(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }));
}

let stop = false;
process.on("SIGINT", () => {
  if (stop) process.exit(130);
  stop = true;
  console.log("");
  console.log("收到 Ctrl-C：手上这几个跑完就停。已生成的都留着，下次跑接着做。");
});

const t00 = Date.now();
const stats = { lessonOk: 0, lessonFail: 0, quizOk: 0, quizFail: 0, unitOk: 0, unitFail: 0, judgeReject: 0 };
const failures = [];

/* ---------------- 审稿（--judge） ----------------
 * judges.teach/quiz/unit：内容 → {pass, problems}。跑一遍审稿比让强引擎
 * 自己写一遍便宜得多（输入长输出短）；审稿的账记在 judge:* 任务名下，
 * 拒绝次数统一在这里计（quiz 的审在 ensureQuizBank 里层跑，也从这经过）。 */
let judges = null;
function mkJudges(prov) {
  const call = async (kind, sys, lang) => {
    const v = await S.runEngine(prov[kind], "judge:" + kind, sys,
      S.L(lang, "请审这份内容。", "Review this content."), null, null, lang,
      // 题库审稿用带 bad 序号的格式说明：按题剔除，不整批作废（ensureQuizBank 认 v.bad）
      { schema: S.JUDGE_SCHEMA, hint: (kind === "quiz" ? S.JUDGE_HINT_QUIZ : S.JUDGE_HINT)[lang] }, S.validateJudge);
    if (!v.pass) stats.judgeReject++;
    return v;
  };
  return {
    teach: (j, lesson) => call("teach", S.judgeLessonPrompt(j.item, j.data, lesson, j.lang), j.lang),
    // ctx.brief：英文出题时 ensureQuizBank 交过来的同一个 TeachingBrief（#43），审稿和出题读同一份；zh 没有 ctx
    quiz: (j, batch, ctx) => call("quiz", S.judgeQuizPrompt(j.item, j.data, batch, j.lang, ctx && ctx.brief), j.lang),
    unit: (j, set) => call("unit", S.judgeUnitPrompt(j.data, j.strand, set, j.lang), j.lang)
  };
}

/* 生成 → 审 → 没过重来一次 → 仍没过放弃这条（进 failures，下次跑接着补）。
 * gen 自带的「失败重试一次」在里层，这里只管审稿维度。 */
async function withJudge(kind, j, gen) {
  let content = await gen();
  if (!judges) return content;
  let v = await judges[kind](j, content);
  if (v.pass) return content;
  console.log(`    审稿没过（${j.lang} ${kind} ${j.item ? j.item.id : j.gradeKey + "-" + j.strand}），重来：${v.problems[0] || "（没给理由）"}`);
  content = await gen();
  v = await judges[kind](j, content);
  if (!v.pass) throw new Error("审稿两次没过：" + (v.problems[0] || "（没给理由）"));
  return content;
}

/* 构建期的课比现场讲课多一道门：进包的课是给所有用户的，残缺的宁可重生成。
 * 2026-08-21 本地模型跑批时出现过「say 半句截断」「一节课只剩 2 步」这类结构上就不合格的课，
 * 校验过不了就让 runEngine 当失败处理（重试一次，再不行进 failures 下次补）。 */
function validateLessonStrict(lang) {
  const minSay = lang === "en" ? 25 : 10;
  return l => {
    l = S.validateLesson(l);
    if (l.steps.length < 4) throw new Error("只有 " + l.steps.length + " 步（讲课至少 4 步）");
    const short = l.steps.filter(s => s.say.trim().length < minSay);
    if (short.length) throw new Error("有 " + short.length + " 步台词太短，像是被截断了：「" + short[0].say.slice(0, 30) + "」");
    // 台词没有句末标点 = 典型截断（138 节人工校过的课里 1075 步全部以标点/括号/引号收尾）
    const cut = l.steps.find(s => !/[。！？!?.…」”）)"’]$/.test(s.say.trim()));
    if (cut) throw new Error("有一步台词像被截断：「…" + cut.say.slice(-20) + "」");
    if (!l.steps.some(s => s.visual && s.visual.type !== "none")) throw new Error("整节课一张图都没有");
    if (!l.practice.question.trim() || !l.practice.answer.trim()) throw new Error("缺课后练习");
    return l;
  };
}

/* ---------------- 生成一节课 ---------------- */
async function genLesson(j, provider) {
  // 和 /api/lesson 的 teach 分支保持一致；孩子名传空，包里的课对谁都一样
  const sys = S.systemPromptTeach(j.item, j.data, "", j.lang);
  const question = j.lang === "en" ? j.item.en : j.item.zh + "（" + j.item.en + "）";
  const t0 = Date.now();
  const check = validateLessonStrict(j.lang);
  const gen = async () => {
    try { return await S.runEngine(provider, "pregen:teach", sys, question, null, null, j.lang, null, check); }
    catch (e1) { return await S.runEngine(provider, "pregen:teach", sys, question, null, null, j.lang, null, check); }   // 和服务器一样，失败重试一次
  };
  const lesson = await withJudge("teach", j, gen);
  writeJson(lessonFile(j.item.id, j.lang), {
    v: 1, curriculumId: j.item.id, lang: j.lang,
    title: j.lang === "en" ? j.item.en : j.item.zh,
    provider, at: new Date().toISOString().slice(0, 10),
    lesson
  });
  return { steps: lesson.steps.length, ms: Date.now() - t0 };
}

/* ---------------- 生成一张单元测试卷 ---------------- */
const UNIT_COUNT = Math.max(6, Math.min(12, Number(opt("unit-count", 8)) || 8));
async function genUnit(j, provider) {
  const sys = S.unitTestPrompt(j.data, j.strand, j.lang, UNIT_COUNT);
  const q = j.lang === "en" ? "Please write this unit test." : "请出这张单元测验。";
  const opts = { schema: S.UNIT_TEST_SCHEMA, hint: S.UNIT_TEST_HINT[j.lang] };
  const t0 = Date.now();
  const gen = async () => {
    try { return await S.runEngine(provider, "pregen:unit", sys, q, null, null, j.lang, opts, x => S.validateUnitTest(x, j.data, j.strand, UNIT_COUNT)); }
    catch (e1) { return await S.runEngine(provider, "pregen:unit", sys, q, null, null, j.lang, opts, x => S.validateUnitTest(x, j.data, j.strand, UNIT_COUNT)); }
  };
  const set = await withJudge("unit", j, gen);
  writeJson(unitFile(j.gradeKey, j.strand, j.lang), {
    v: 1, grade: j.gradeKey, strand: j.strand, lang: j.lang,
    unitName: { zh: j.def[1], en: j.def[2] },
    provider, at: new Date().toISOString().slice(0, 10),
    set: { title: set.title || (j.lang === "en" ? j.def[2] : j.def[1]), questions: set.questions }
  });
  return { n: set.questions.length, ms: Date.now() - t0 };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  /* --review v2：只做点名的英文题库，走 #44 的逐题审稿（qbank_v2_cli.mjs）；下面的老流程不经过 */
  if (V2) { exitWhenDone(await runPregenV2(S, require("../lib/ai/qbank/index.js"), CLI.v2)); return; }
  await S.detectProviders();
  // 三类任务各自走路由（config.providerByTask 的 pregen:* 键）；--provider 一刀切压过路由
  const cli = opt("provider", null);
  const prov = {
    teach: S.pickProvider(cli, "pregen:teach"),
    quiz: S.pickProvider(cli, "pregen:quiz"),
    unit: S.pickProvider(cli, "pregen:unit")
  };
  if (!prov.teach || !prov.quiz || !prov.unit) {
    console.error("没有可用的 AI 引擎。装一个再来：");
    console.error("  npm i -g @anthropic-ai/claude-code   然后跑一次 claude 登录");
    console.error("或者 gemini / grok / codex / ollama，或者在 config.json 里填 anthropic.apiKey。");
    process.exit(1);
  }

  const provLabel = t => prov[t] + (S.PROVIDER_META[prov[t]] ? "（" + S.PROVIDER_META[prov[t]].label + "）" : "");
  console.log("引擎:     " + (prov.teach === prov.quiz && prov.quiz === prov.unit
    ? provLabel("teach")
    : "课 " + provLabel("teach") + "   题 " + provLabel("quiz") + "   卷 " + provLabel("unit")));

  if (JUDGE) {
    /* 明写了 --judge <引擎名> 就必须是那个引擎。审稿的全部意义是换个更强的把关，
     * 名字打错（--judge cluade）或那台引擎没装却悄悄换人，跑完一晚上批次才发现
     * 「强引擎复核」根本没发生——这种账事后补不回来，不如当场停。
     * 裸 --judge 照旧按 providerByTask 的 judge:* 路由挑，挑不着退 provider/自动。 */
    if (JUDGE_CLI && !(S.detected[JUDGE_CLI] && S.detected[JUDGE_CLI].available)) {
      console.error("--judge " + JUDGE_CLI + "：" + (S.PROVIDER_META[JUDGE_CLI]
        ? "这台机器上没检测到这个引擎，装好再来。"
        : "不是已知引擎（可选：" + Object.keys(S.PROVIDER_META).join(" / ") + "）。"));
      console.error("不指定引擎的话，裸 --judge 会按 config.providerByTask 里的 judge:teach / judge:quiz / judge:unit 路由挑。");
      process.exit(1);
    }
    const jp = {
      teach: S.pickProvider(JUDGE_CLI, "judge:teach"),
      quiz: S.pickProvider(JUDGE_CLI, "judge:quiz"),
      unit: S.pickProvider(JUDGE_CLI, "judge:unit")
    };
    if (!jp.teach || !jp.quiz || !jp.unit) {
      console.error("--judge 需要一个可用的审稿引擎：--judge <引擎名>，或在 config.providerByTask 里配 judge:teach / judge:quiz / judge:unit。");
      process.exit(1);
    }
    judges = mkJudges(jp);
    const jl = t => jp[t] + (S.PROVIDER_META[jp[t]] ? "（" + S.PROVIDER_META[jp[t]].label + "）" : "");
    console.log("审稿:     " + (jp.teach === jp.quiz && jp.quiz === jp.unit
      ? jl("teach")
      : "课 " + jl("teach") + "   题 " + jl("quiz") + "   卷 " + jl("unit")));
    if (jp.teach === prov.teach && jp.quiz === prov.quiz && jp.unit === prov.unit)
      console.log("          （审稿和生成是同一个引擎：自审也能拦低级错，但换个更强的引擎审更稳）");
  }
  console.log("范围:     " + (V1_SEL ? "只做点名条目 " + V1_SEL.selected.map(x => x.id).join("、") : sources().map(sourceTag).join("、"))
    + "   语言 " + LANGS.join("+") + "   并发 " + CONCURRENCY);
  console.log("课程:     " + (doLessons ? todoLessons.length + " 节要生成（共 " + jobs.length + " 节，其余已有）" : "跳过"));
  console.log("题库:     " + (doQuiz ? todoQuiz.length + " 组要生成（共 " + jobs.length + " 组，其余已有）" : "跳过"));
  console.log("单元卷:   " + (doUnit ? todoUnit.length + " 张要生成（共 " + unitJobs.length + " 张，其余已有）" : "跳过"));
  console.log("");

  if (DRY) {
    for (const j of todoLessons) console.log("  课  " + j.lang + "  " + j.item.id + "   " + j.item.zh);
    for (const j of todoQuiz) console.log("  题  " + j.lang + "  " + j.item.id + "   " + j.item.zh);
    for (const j of todoUnit) console.log("  卷  " + j.lang + "  " + j.gradeKey + "-" + j.strand + "   " + j.def[1]);
    return;
  }
  if (!todoLessons.length && !todoQuiz.length && !todoUnit.length) { console.log("没有要做的，已经齐了。"); return; }

  let n = 0;
  const total = todoLessons.length + todoQuiz.length + todoUnit.length;
  const tick = (tag, j, note) => {
    n++;
    const pct = String(Math.round(n / total * 100)).padStart(3, " ");
    console.log("[" + pct + "% " + String(n).padStart(3, " ") + "/" + total + "  " + hhmmss(Date.now() - t00) + "]  "
      + tag + " " + j.lang + " " + j.item.id + "   " + note);
  };

  if (todoLessons.length) {
    console.log("--- 生成课程 ---");
    await pool(todoLessons, CONCURRENCY, async j => {
      if (stop) return;
      try {
        const r = await genLesson(j, prov.teach);
        stats.lessonOk++;
        tick("课", j, r.steps + " 步  " + Math.round(r.ms / 1000) + "s");
      } catch (e) {
        stats.lessonFail++;
        failures.push("课 " + j.lang + " " + j.item.id + "：" + e.message);
        tick("课", j, "失败 — " + e.message);
      }
    });
  }

  if (todoQuiz.length && !stop) {
    console.log("");
    console.log("--- 生成闯关题库 ---");
    await pool(todoQuiz, CONCURRENCY, async j => {
      if (stop) return;
      try {
        const bank = await S.ensureQuizBank(j.item, j.data, j.lang, prov.quiz, "pregen:quiz", judges ? (b, ctx) => judges.quiz(j, b, ctx) : null);
        stats.quizOk++;
        tick("题", j, bank.questions.length + " 道");
      } catch (e) {
        stats.quizFail++;
        failures.push("题 " + j.lang + " " + j.item.id + "：" + e.message);
        tick("题", j, "失败 — " + e.message);
      }
    });
  }

  if (todoUnit.length && !stop) {
    console.log("");
    console.log("--- 生成单元测试卷 ---");
    await pool(todoUnit, CONCURRENCY, async j => {
      if (stop) return;
      const label = j.gradeKey + "-" + j.strand;
      try {
        const r = await genUnit(j, prov.unit);
        stats.unitOk++;
        n++;
        console.log("[" + String(Math.round(n / total * 100)).padStart(3, " ") + "% " + String(n).padStart(3, " ") + "/" + total
          + "  " + hhmmss(Date.now() - t00) + "]  卷 " + j.lang + " " + label + "   " + r.n + " 题  " + Math.round(r.ms / 1000) + "s");
      } catch (e) {
        stats.unitFail++; n++;
        failures.push("卷 " + j.lang + " " + label + "：" + e.message);
        console.log("[" + String(n).padStart(3, " ") + "/" + total + "]  卷 " + j.lang + " " + label + "   失败 — " + e.message);
      }
    });
  }

  console.log("");
  console.log("用时 " + hhmmss(Date.now() - t00)
    + "   课 " + stats.lessonOk + " 成 / " + stats.lessonFail + " 败"
    + "   题 " + stats.quizOk + " 成 / " + stats.quizFail + " 败"
    + "   卷 " + stats.unitOk + " 成 / " + stats.unitFail + " 败"
    + (JUDGE ? "   审稿拒 " + stats.judgeReject + " 次" : ""));
  if (failures.length) {
    console.log("");
    console.log("没成的（再跑一次这个脚本会自动重试，已成的不会重做）：");
    for (const f of failures.slice(0, 40)) console.log("  " + f);
    if (failures.length > 40) console.log("  …还有 " + (failures.length - 40) + " 条");
  }
  const packed = ["zh", "en"].reduce((a, l) => {
    try { return a + fs.readdirSync(path.join(S.LESSON_PACK_DIR, l)).filter(f => f.endsWith(".json")).length; } catch (_) { return a; }
  }, 0);
  console.log("");
  console.log("课程包现在 " + packed + " 节（data/lessons/）。启动 server.js 时开机横幅会报出来。");
}

main().catch(e => { console.error(e); process.exit(1); });
