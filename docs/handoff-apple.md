# 给 AITutor-APPLE 的交接：课程目录 v2（技能图谱）在 Node 版落地了什么、哪些能直接拿走

> 写给 `AITutor-APPLE`（Swift 版）的开发者/agent。2026-08-22 ~ 08-23 在 Node 版（`D:\ai-tutor`，`dev` 分支）把课程目录从「69 条 BC 条目」重构成「年级 → 主题 → 技能」，并把题库、审稿、回补整条链路跑通。
> 这份文档的目的：① 说清我做了什么、为什么这么做；② 列出你可以**原样复用**的数据和规则；③ 标出哪些东西是 Node 版特有的、照搬没意义。
> 起点是你们那份《圆圆数学 Knowledge Graph v1》报告——大方向全部采纳，有四处改动，见 §2。

---

## 1. 结果一句话

| | 之前 | 现在 |
|---|---|---|
| G4–G7 可学的「点」 | 69 条 BC 条目 | **245 个技能**，归入 **54 个主题** |
| 每条 BC 条目对应 | 1 个点 | 1–8 个技能（均值 3.6） |
| 先修关系 | 无 | 365 条边（120 条跨年级） |
| 误区 | 只在题目解析文本里 | **120 条登记在册**，技能引用、题目干扰项打标签 |
| 技能题库 | 无 | **468 份 / 5556 题**（234 核心技能 × 中英），每题带误区标签，全部经审稿 |
| 诊断 → 回补 | 无 | 同一误区错 2 次 → 按技能的 `diag.branch` 指出该回补的先修技能 |
| 老的 236 份条目题库 | 从未审过 | 全量审过：35 份不过，剔 42 题，已补齐 |

App 里 G4–G7 选年级即进技能视图；老的 69 节条目课降级成每个主题里的「总览课」。G8–G12 和书籍还是老结构（schema 已兼容，缺数据文件）。

---

## 2. 和你们报告方案的四点不同（其余全部采纳）

| 报告建议 | 我的做法 | 为什么 |
|---|---|---|
| Grade → Domain → **BC Standard → Topic** → Skill 五层 | Grade → Topic → Skill 三层，BC 标准是技能的属性 | 主题天然跨标准（G5「小数到千分位」= NUM.02 + FLU.03；G7「线性关系」= PAT.01 + GEO.03）。Topic 塞在 Standard 下面会把一个主题切成两半。IXL / Khan / Math Academy / Mathspace 的导航也都是主题，不是标准 |
| 每技能维护 7 个证据维度 | 前 5 个维度变成技能 **type**（一个技能只测一种能力）；retention 用「不同日期答对」；misconceptions 用标签 | 维度 × 技能会把题库成本乘 5。竞品也是用「表示/认知前缀」把能力切成不同 skill |
| `knowledge-graph/` 多目录 + 6 个注册表 | 每年级一个文件（主题 + 技能同文件）+ 唯一注册表 `misconceptions.json` | 和现有 `grade-N.json` 形状一致；对齐关系写在节点里，不另建 alignments/ |
| skill 可挂多个年级 | 同意，但只给**完全相同**的技能（目前仅 1 例，用 `topic.review` 引用） | BC 把乘法口诀分 4 年写、题库内容真的不同，拆成 4 个阶段技能 + 先修链更诚实 |

**颗粒度**定在每年级 50–70 个技能、每条标准 3–4 个。一个技能 = IXL 的一条「表示阶梯」（模型 → 数轴 → 符号 → 应用 = IXL 的 2–3 个 skill），阶梯放在技能内部由 L1/L2/L3 三级难度承担。IXL 实测每年级 358–458 个 skill 但只有 31–40% 映射到 BC；Khan 119–154；Math Academy 133–170（每 topic 约 5 条先修边）；Mathspace **没有 BC 教材**。

---

## 3. 可以原样拿走的东西

全部在 Node 仓库 `dev` 分支，纯 JSON / Markdown，和平台无关。

### 3.1 技能图谱数据 `data/curriculum/skills/`

| 文件 | 内容 |
|---|---|
| `g4.json` … `g7.json` | 每年级：`topics[]`（主题）+ `skills[]`（技能） |
| `misconceptions.json` | 120 条误区 `{ id, zh, en, pattern, remedy }` |
| `README.md` | 字段速查 |

技能节点长这样（schema `yy-skills/1`）：

```jsonc
{
  "id": "YY.MATH.FRAC.EQUIV.MULTIPLY",      // ^YY\.MATH\.[A-Z0-9]+(\.[A-Z0-9_]+){1,3}$，不含年级，发布后不改
  "topic": "equivalent-fractions",          // 本文件 topics[] 的 id
  "type": "procedure",                       // concept | represent | procedure | reason | apply | fluency
  "rep": ["fractionBar", "symbolic"],        // 表示阶梯；rep[0] 是 L1 出题/诊断入口用的表示
  "en": "Generate equivalent fractions by multiplying the numerator and denominator by the same number",
  "zh": "分子分母同乘一个数，生成等值分数",
  "primary": "BC.MATH.G5.NUM.03",            // 主归属标准（进度汇总、报告按它）
  "supporting": [],                          // 还服务于哪些标准（多对多）
  "prereq": ["YY.MATH.FRAC.EQUIV.VISUAL", "YY.MATH.FLU.MULT.FACTS.EMERGING"],
  "core": true,                              // 缺省 true；false = 拓展技能，不参与标准级汇总
  "misc": ["frac.add_same_number", "frac.multiply_one_part"],   // misconceptions.json 的 id
  "hints": "fractionBar",                    // 配图提示（沿用 teachHints 词表）
  "diag": {                                  // 试点技能才有（23 个）
    "entry": [{ "level": 1, "rep": "fractionBar" }, { "level": 2, "rep": "symbolic" }],
    "branch": { "frac.add_same_number": "YY.MATH.FRAC.EQUIV.VISUAL",
                "frac.multiply_one_part": "YY.MATH.FRAC.EQUIV.SAME_WHOLE" }
  }
}
```

主题：`{ id, zh, en, strand, domain?, standards[], review?[], pilot? }`。`domain:"financial-literacy"` 标出理财主题（界面可见的学习域，底层仍归 BC 的 number 主线）。`review` 引用更低年级的技能（本主题要复习它，不重复定义）。

`terms` 不单独放在技能上，默认继承 `primary` 标准的 `terms`——你们的 `Curriculum.swift` 已经有这个字段。

### 3.2 校验器 `tools/curriculum/skills_check.mjs`

零依赖 Node 脚本，改 JSON 后跑一遍：id 文法、主题/标准/先修/误区引用存在、先修无环、**不允许先修指向更高年级**、每条 G4–G7 标准至少 1 个 primary 技能、**有 L1 诊断入口时**其表示必须等于 `rep[0]`（23 个试点技能里 13 个没有 L1 入口——`apply`/`reason` 类从 L2/L3 情境起步，这是设计使然，不是缺数据）。`--md` 生成完整目录树。你们用 Swift 解析前可以先用它把关；逻辑也很容易移植成单测。

### 3.3 设计文档 `docs/skill-graph-plan.md`

完整设计 + 竞品实测数据 + 245 技能的目录树 + 掌握度/诊断规则 + 分阶段落地记录。§6 的掌握度规则是**平台无关**的：

- 技能级：沿用四级（Emerging / Developing / Proficient / Extending），证据 = taught / right / wrong / rightDays / quizPassedAt
- 标准级（汇总）：只看 `core:true` 的技能——全部 ≥ Proficient → Proficient；再有一个 `apply`/`reason` 技能到 Extending → Extending；任一技能有记录 → Developing
- 旧进度（标准 id 上的）记成 `legacy: { level, confidence: "low" }`，**不等价**成子技能全会
- 回补：答错且选项挂了误区标签就记一笔；同一误区累计 2 次 → 按技能 `diag.branch`（没有就按登记表 `remedy`）指出该回补的技能

### 3.4 题库：git 里直接拉 `content/qbank/`（2026-08-24 起）

题库**不在** `qbank.json`（那是 gitignore 的本机文件）——干净导出已提交进 `dev`：

- `content/qbank/by-skill/{zh,en}/<技能id>.json` — 468 份 / 5558 题，**每题**带误区 tags（2026-09-01 起：原先 54 个技能没登记误区、其题库无 tags，已补登记 108 条误区并回填；L3 错误分析题的选项已配平，正确项不再是最长的）
- `content/qbank/legacy-by-standard/{zh,en}/<条目id>.json` — 234 份（**已含审稿剔错 42 题后的修正**，
  `demo/qbank.json` 也已刷新到同一版本）
- `content/manifest.json` — 数量与注意事项

已剥掉 `usedAt`、排除 AoPS。每题：

```jsonc
{
  "level": 3,
  "question": "在 Surrey 的社区中心，一个方形蛋糕被平均切成 4 块 … 她要吃的部分写成分数应该是多少？",
  "options": ["3/12", "3/4", "1/12", "9/12"],
  "answerIndex": 0,
  "explain": "块数从 4 变成 12 是乘 3 … 写成 9/12 的那个是把分子分母都加 8 …",
  "tags": ["ok", "frac.multiply_one_part", "frac.multiply_one_part", "frac.add_same_number"]
}
```

`tags` 和 `options` 位置对齐：正确项 `ok`，干扰项是误区 id（或 `other`）。**tags 不能下发给客户端**——`ok` 的位置就是答案。判分不看 tags，只有回补逻辑用。

数据说明：难度 1862/1846/1848，答案位置 1415/1405/1392/1344（入库时强制打散），有误区的 360 份题库 tags 覆盖 100%，坏标签 0，每题都经 Opus 审稿。没登记误区的 108 份题库没有 tags，这是设计使然。

微课已全部烤完：`lessons/skills/{zh,en}/` 共 **490 节**（245 技能 × 中英，4–6 步、接先修、专门演一步误区，全部经审稿）。

### 3.5 配图契约 `data/curriculum/visual-contract.json`（2026-08-25 起，v2）

课程 `steps[].visual` 的图型白名单 + 每种图的 `nums` 约定 + 合法范围，**唯一事实源**。
以前这份名单在三处各抄一份，数目漂成 36 / 39 / 41；更要命的是两端对越界的处理不一样
（web 静默钳位画错图、Apple 降级成无图），同一份数据两种坏法。

- 判定实现 `public/visual-check.js` —— 浏览器 `<script src>` 和 node `require()` 是同一个文件；
- preflight `node tools/curriculum/visual_check.mjs` —— 违约退出码 1，现状全库零违约；
- v2 新增两种画法（假分数、数轴分数刻度），带 `since: 2` 标记，**只实现到 v1 的客户端遇到必须降级成无图**；
- 几何规格、为什么这么定、现网存量清单：见 [visual-contract-v2.md](visual-contract-v2.md)；
- **你们该干什么、按什么顺序、别踩哪几个坑**：见 [apple-todo-visual-v2.md](apple-todo-visual-v2.md)。

`steps[].headline` 是同期加的可选字段（看图模式下没图的步骤靠它撑住屏幕），
解码用 `decodeIfPresent`，老内容不带它。

### 3.6 提示词设计（文字，不是代码）

在 `server.js` 里，但思路可直接搬：

- **微课**（`systemPromptTeach` 的 `isSkills` 分支）：定位 3–5 分钟、4–6 步；origin 段写「这一小步 + 所属标准原文 + 孩子已会的先修（直接借力不重讲）+ 本技能常见误区（主动点破）」；结构「一句接先修 → 讲清这一步 → 一个例题 + 专门一步演误区 → 一句小结」；只讲这一步，后面的内容一个字不提前讲
- **出题**（`qbankPrompt` 的 `skillRules` 段）：L1 必须围绕 `rep[0]` 的模型**用文字说清**（题目没有配图，绝不能写「看下面的图」）；干扰项逐个建立在登记误区上并输出 4 个 tags；解析不按位置指代选项（服务端会重排）
- **审稿**（`judgeCommon` + `JUDGE_HINT_QUIZ`）：数学全对、贴住技能、不误导；返回 `{ pass, problems[], bad:[题序号] }`——**按题剔除**，12 道错 1 道只丢 1 道

---

## 4. 生成管线上踩过的坑（省你们再踩一遍）

1. **单题错误率 4–5%，整批作废会把它放大成 40–50% 拒绝率**。审稿必须返回题序号、按题剔除。
2. **本地 27B 模型（ollama qwen3.8 Q4）出这种带误区标签的题成品率只有 50%**，而且关掉思考 JSON 干净但数学错误率暴涨（审稿 74 次拒 30 次）。开思考要把输出预算留到 32768。最后放弃本地生成，全部用 Claude Opus 5（effort high）：100% 解析成功、1.4 分钟/份、11 小时出完 444 份。
3. **老题库从来没审过**。账本里审稿调用历史 = 0，「80% 成功率」只是 JSON 能解析。全量审后 234 份有 35 份不过，错全在 `explain`（解析把错误做法算错、跑题）而不是标答——家长核对答案发现不了。**你们的题库如果也是本地模型生成的，建议全量送审一遍**。
4. **模型不听「答案位置打散」**：实测 38/53/20/9。入库时服务端强制重排，`options` 和 `tags` 一起搬。
5. **JSON 格式崩的模式很固定**：值后多粘一个引号（`{"level":3","question"`、`["ok","other"","ok"]`）。一个几十行的修复函数能救回几乎全部。Ollama 的 `format: schema` 结构化输出是死路（模型无视 schema）。
6. **Claude Code CLI 走订阅不按 token 计费**，CLI 返回的 `total_cost_usd` 是按牌价折算的等价值，别当账单。

---

## 5. 不建议照搬的（Node 版特有）

- `server.js` 里的加载器、`learnView()`、`standardRollup()`、`missRecord()/remediationFor()` 的具体实现——逻辑见 §3.3，代码是 Node 的
- `tools/pregen.mjs` / `tools/audit_qbank.mjs`：依赖 Node 版的引擎适配器，但**流程**（生成 → 审稿按题剔除 → 补齐缺口 → 断点续跑）值得照着做
- ollama 相关的全部参数：那是这台机器的事

---

## 6. 还没做的

- 11 个拓展技能（`core:false`）的题库
- G8–G12 和 AoPS 书籍的技能文件（schema 兼容，缺数据；高中 `course-*.json` 的 `strandDefs` 已经是单元，只缺技能层）
- ~~主题级单元卷~~ 已烤完（108 份，在 `unit-tests/`，文件名 `skills-g<N>-<topic>.json`）
- 语音：微课的语音**未预烘**（1742 条现有语音只覆盖老总览课；`voice/index.json` 里微课的步大多是 null，客户端退回设备 TTS）。烘的时候注意读音归一：Ms. Yuanyuan 要读成 Miss Yuanyuan（哈希按原文、送合成的文本替换，见 server.js ttsSpeakable）

有问题直接对着 `docs/skill-graph-plan.md` 和这份文档提。数据文件改了请务必先跑校验器。
