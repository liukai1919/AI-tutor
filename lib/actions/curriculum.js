/*
 * 大纲清单 Action（#24）：view。逻辑从 GET /api/curriculum 原样搬来。
 * deps：curriculum(Map), curriculumGrades, curriculumCourses, curriculumBooks, curriculumSkillsPreviews,
 *       curriculumKey, learnView, viewKey, strandGroups, STRANDS, kd, progressStatus, remediationFor
 */
"use strict";
const { ActionError, needKid } = require("./errors.js");

module.exports = function createCurriculumActions(deps) {
  const { curriculum, curriculumGrades, curriculumCourses, curriculumBooks, curriculumSkillsPreviews,
    curriculumKey, learnView, viewKey, strandGroups, STRANDS, kd, progressStatus, remediationFor } = deps;

  return {
    /* 没给 grade：返回目录（年级 / 课程 / 书籍 / 技能预览），不需要孩子上下文。
     * 给了 grade：这个孩子在这份大纲上的清单，每条带 status / lessonId，技能层多带徽章字段和回补建议。 */
    view(ctx, input) {
      const grades = curriculumGrades();
      const g = curriculumKey((input && input.grade) || 0);
      if (!g) return { grades, courses: curriculumCourses(), books: curriculumBooks(), skillsPreviews: curriculumSkillsPreviews() };
      const d = learnView(g, input && input.view);
      if (!d) throw new ActionError(404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet", grades });
      /* 技能视图下 FSA 仍按 BC 五大主线出卷，清单里的分组是主题，所以另带一份主线名单给 FSA 下拉 */
      const bc = (d.type === "skills-preview") ? curriculum.get(g) : null;
      const fsaStrands = bc ? STRANDS.filter(([s]) => (bc.items || []).some(it => it.strand === s)).map(([s, zh, en]) => ({ strand: s, zhName: zh, enName: en })) : null;
      const kidId = needKid(ctx);
      const progress = kd(kidId).progress;
      const strands = strandGroups(d, it => ({
        id: it.id, en: it.en, zh: it.zh, status: progressStatus(kidId, it.id),
        // 最近一节讲过的课：前端点条目直接重播（免费秒开），🔄 才重新生成
        lessonId: ((progress[it.id] || {}).lessonIds || [])[0] || "",
        /* 技能层多带几个字段给前端做徽章和折叠（老年级/书籍没有 it.skill，什么都不多发） */
        ...(it.skill ? {
          type: it.skill.type,
          core: it.skill.core,
          reviewFrom: it.skill.reviewFrom || 0,
          prereqN: (it.skill.prereq || []).length,
          miscN: (it.skill.misc || []).length,
          standard: it.skill.primary || "",
          ...(remediationFor(kidId, it.id) ? { remediate: remediationFor(kidId, it.id) } : {})
        } : {})
      }));
      return { grade: g, grades, source: d.source, strands,
        ...(d.topicStandards ? { topicStandards: d.topicStandards } : {}),
        ...(fsaStrands ? { fsaStrands } : {}),
        unitKey: String(viewKey(g, d))     // 单元测试存档/读包用的 key（技能视图是 skills-g5，不是 5）
      };
    }
  };
};
