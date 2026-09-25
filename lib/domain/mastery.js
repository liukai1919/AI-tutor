/*
 * 掌握度判定（领域层，纯函数，零依赖）。issue #21，#19 Phase 1 第一刀。
 *
 * 这里只认 progress 对象和技能查找函数，不碰磁盘、不碰 Date.now()、不知道 kidId：
 *   - progress   一个孩子名下的 { [curriculumId | skillId]: entry }
 *   - entry      { taught, right, wrong, lastAt, solid, rightDays[], lessonIds[], quizPassedAt?, miss?{miscId:n} }
 *   - skillOf(id)     技能 id -> 技能对象（type / core / diag.branch / zh / en）或 null
 *   - miscOf(miscId)  误区 id -> { zh, en, remedy } 或 undefined
 *
 * server.js 里保留同名包装（progressLevel / progressStatus / standardRollup / standardEvidence /
 * missRecord / remediationFor / progressRecord）负责取孩子的 progress、传时间、落盘。
 * 规则本身一个字没改：黄金用例 tools/golden/expected.json 是证据。要改规则先改这里，再 --update 快照。
 */
"use strict";

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function newEntry() {
  return { taught: 0, right: 0, wrong: 0, lastAt: 0, solid: false, rightDays: [], lessonIds: [] };
}

/* BC 官方四级话术（2023 年起成绩单同款）：Emerging / Developing / Proficient / Extending。
 * 映射：new→emerging，seen→developing，solid→proficient；不同日期答对 ≥3 次→extending（solid+） */
function levelOf(e) {
  if (!e) return "emerging";
  const days = (e.rightDays || []).length;
  if (days >= 3) return "extending";
  if (e.solid || e.quizPassedAt || days >= 2) return "proficient";
  return (e.taught || e.right || e.wrong) ? "developing" : "emerging";
}

/* 三态：new（没学过）/ seen（讲过）/ solid（扎实），由四级直接降维。
 * solid = 闯关通关（docs/qbank-standard.md §5），或不同日期答对 ≥2 次，或家长手动标记 */
function statusOf(level) {
  return level === "emerging" ? "new" : level === "developing" ? "seen" : "solid";
}

const LEVEL_RANK = { emerging: 0, developing: 1, proficient: 2, extending: 3 };

/* ---------------- 标准级汇总（技能 → BC 标准，设计文档 §6） ----------------
 * 技能进度沿用同一套 progress 事件，key 换成 skillId；一条 BC 标准的级别由它下面的
 * 核心技能（core:true）汇总出来。没有技能挂靠的标准返回 null，调用方回退到原来的
 * 「标准自己那条 progress」——所以 G8/G9、高中课、书籍完全不受影响。 */
function rollupStandard(progress, standardId, skillIds, skillOf) {
  const ids = skillIds;
  if (!ids || !ids.length) return null;
  const core = ids.filter(id => (skillOf(id) || {}).core !== false);
  const pool = core.length ? core : ids;
  const levels = pool.map(id => levelOf(progress[id]));
  const touched = pool.filter(id => progress[id]).length;
  const proficient = levels.filter(l => LEVEL_RANK[l] >= 2).length;
  let level = "emerging";
  if (proficient === pool.length) {
    /* 全部核心技能站稳 = Proficient；再要 Extending，得有一个「会讲道理/会用起来」的技能到 Extending */
    const deep = pool.some(id => {
      const s = skillOf(id);
      return s && (s.type === "apply" || s.type === "reason") && levelOf(progress[id]) === "extending";
    });
    level = deep ? "extending" : "proficient";
  } else if (touched) level = "developing";
  /* 旧数据：孩子在 BC 标准这条 id 上有进度，但一个技能都没做过。不能等价成「所有子技能都会了」，
   * 记成低置信度的历史证据，让前端/报告分开显示，后续做题自然校准（设计文档 §6 / §7 阶段 2）。 */
  const own = progress[standardId];
  const legacy = (!touched && own && (own.taught || own.right || own.wrong || own.solid || own.quizPassedAt))
    ? { level: levelOf(own), confidence: "low" } : null;
  return { level, total: pool.length, touched, proficient, legacy };
}

/* 一条 BC 标准在孩子名下的全部证据：级别 + 学习计数 + 技能汇总。
 * 级别：家长星标 > 技能汇总（有挂靠时）> 老口径 levelOf；
 * 计数：标准自己那条 progress 加上挂靠技能（primary）的 progress 一起算。
 * 实时报告和 AI 完整报告都从这里拿（2026-09-05 审出两份报告互相打架）。 */
function evidenceFor(progress, standardId, skillIds, skillOf) {
  const e = progress[standardId];
  const roll = rollupStandard(progress, standardId, skillIds, skillOf);
  const manual = !!(e && e.solid);
  const level = manual ? "proficient" : roll ? roll.level : levelOf(e);
  const ids = [standardId].concat(skillIds || []);
  let taught = 0, right = 0, wrong = 0, lastAt = 0;
  for (const id of ids) {
    const p = progress[id];
    if (!p) continue;
    taught += p.taught || 0; right += p.right || 0; wrong += p.wrong || 0;
    if ((p.lastAt || 0) > lastAt) lastAt = p.lastAt;
  }
  return { level, manualSolid: manual, taught, right, wrong, lastAt, skills: roll, ids };
}

/* 误区计数与回补建议（设计文档 §6）
 * 一道题答错、且它的干扰项挂了误区 id，就在这个技能名下记一笔。同一个误区攒到
 * MISS_TRIGGER 次，说明不是手滑而是稳定的错误模式 —— 按技能自己的 diag.branch
 * （没有就按误区登记表的 remedy）找出该回去补的技能。 */
const MISS_TRIGGER = 2;
function recordMiss(progress, skillId, miscId, now) {
  const e = progress[skillId] || (progress[skillId] = newEntry());
  const m = e.miss || (e.miss = {});
  m[miscId] = (m[miscId] || 0) + 1;
  e.lastAt = now;
  return e;
}

/* 这个技能现在该不该回补？返回 { miscId, zh, en, times, skillId, skillZh, skillEn } 或 null */
function remediationFor(entry, skillId, skillOf, miscOf) {
  const e = entry;
  if (!e || !e.miss) return null;
  const s = skillOf(skillId);
  let best = null;
  for (const [miscId, times] of Object.entries(e.miss)) {
    if (times < MISS_TRIGGER) continue;
    if (!best || times > best.times) best = { miscId, times };
  }
  if (!best) return null;
  const branch = (s && s.diag && s.diag.branch) || {};
  const targetId = branch[best.miscId] || (miscOf(best.miscId) || {}).remedy || "";
  const target = targetId ? skillOf(targetId) : null;
  const m = miscOf(best.miscId) || {};
  return {
    miscId: best.miscId, times: best.times, zh: m.zh || best.miscId, en: m.en || best.miscId,
    skillId: targetId, skillZh: target ? target.zh : "", skillEn: target ? target.en : ""
  };
}

/* 进度事件。未知事件返回 null（条目照旧会被建出来，和原实现一致），其余返回更新后的条目。
 * opts.now 必传（毫秒时间戳）：领域层不读真实时钟，同样的输入永远得到同样的输出（Codex 复审 20260925 指出的缺省分支已去掉） */
function applyEvent(progress, id, event, opts) {
  if (!opts || typeof opts.now !== "number" || !Number.isFinite(opts.now)) throw new TypeError("applyEvent: opts.now (ms timestamp) is required");
  const now = opts.now;
  const lessonId = opts.lessonId;
  const e = progress[id] || (progress[id] = newEntry());
  if (event === "taught") {
    e.taught++;
    if (lessonId) e.lessonIds = [lessonId, ...(e.lessonIds || [])].slice(0, 20);
  } else if (event === "practiced-right") {
    e.right++;
    const k = dayKey(now);
    if (!(e.rightDays || (e.rightDays = [])).includes(k)) e.rightDays.push(k);
  } else if (event === "practiced-wrong") e.wrong++;
  else if (event === "quiz-right") e.right++;   // 闯关单题只计 ✓✗ 统计，不计 rightDays：没通关不能靠攒天数白捡 solid（标准 §5）
  else if (event === "quiz-wrong") e.wrong++;
  else if (event === "quiz-pass") {             // 通关：直接 solid，通关当天也算一个 rightDay（继续往 Extending 攒）
    e.quizPassedAt = now;
    const k = dayKey(now);
    if (!(e.rightDays || (e.rightDays = [])).includes(k)) e.rightDays.push(k);
  }
  else if (event === "mark-solid") e.solid = true;
  else if (event === "unmark-solid") e.solid = false;
  else return null;
  e.lastAt = now;
  return e;
}

/* 只有家长能做的进度事件（孩子的自报对错等其余事件全员可用） */
const PARENT_ONLY_EVENTS = new Set(["mark-solid", "unmark-solid"]);
/* 只由服务端内部流程写的事件，不接受从 /api/progress 提交：
 * taught 由 /api/lesson 生成讲解时记，quiz-* 由 /api/quiz/finish 按题库结算记。
 * 放开的话孩子发一条 quiz-pass 就能把知识点直接标成 solid——题都不用看见。 */
const INTERNAL_EVENTS = new Set(["taught", "quiz-right", "quiz-wrong", "quiz-pass"]);
const EVENTS = ["taught", "practiced-right", "practiced-wrong", "quiz-right", "quiz-wrong", "quiz-pass", "mark-solid", "unmark-solid"];

module.exports = {
  dayKey, newEntry, levelOf, statusOf, LEVEL_RANK,
  rollupStandard, evidenceFor,
  MISS_TRIGGER, recordMiss, remediationFor,
  applyEvent, EVENTS, PARENT_ONLY_EVENTS, INTERNAL_EVENTS,
};
