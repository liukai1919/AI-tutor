# 技能图谱（Skill Graph v1）

设计文档：[docs/skill-graph-plan.md](../../../docs/skill-graph-plan.md)。

- `g4.json` … `g7.json`：每年级一个文件，`topics[]`（主题 = 导航分组）+ `skills[]`（技能 = 教/练/诊/记的最小单位）。schema `yy-skills/1`，字段说明见设计文档 §3.4。
- `misconceptions.json`：常见错误模式登记表，技能的 `misc[]`、`diag.branch` 和题库干扰项的 `tags` 都引用这里的 id。
- 校验：`node tools/curriculum/skills_check.mjs`（`--md` 生成设计文档第 4 节的目录树，`--dot` 出先修关系图）。

## 已经接进运行链路

`server.js` 会把每个 `g<N>.json` 加载成一个课程视图（key `skills-g5`，`type:"skills-preview"`），
在「跟大纲学」的年级下拉里显示为「🧩 G5 技能图谱（草稿）」。讲课（微课提示词）、闯关（误区标签）、
主题测试、进度、家长报告、误区回补全部走现有代码。

**但默认不随包发布**：`tools/pack.mjs` 要加 `--skills` 才会拷这个目录，
`tools/pregen.mjs` 也要加 `--skills` 才会给技能出题库。改完 JSON 记得先跑一遍校验器。
