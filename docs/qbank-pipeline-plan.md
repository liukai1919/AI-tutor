# 英文出题管线改造（issue #8）· 开发计划

> 一句话：**生成器和审稿器吃同一份确定性的 `TeachingBrief`，题图贯穿生成→硬校验→审稿→导出，审稿结论逐题落盘并绑定内容/brief/规则哈希，修复只动坏题、保身份、有上限。**
>
> 来源：[issue #8](https://github.com/liukai1919/AI-tutor/issues/8)（app 端 2026-09-13 提）。**当前执行计划以 #8 上的最新执行计划评论和各子 Issue 为准**
> （[#8 执行计划](https://github.com/liukai1919/AI-tutor/issues/8#issuecomment-5851999966)）；本文件跟着它更新，冲突时以 Issue 为准。
> 分工：Claude 实现、Codex 独立复核；每片一个 Issue / 堆叠草稿 PR，复核后再推进下一片，不合并、不部署。
> 前置文档：[qbank-standard.md](qbank-standard.md)（题库规则，§7 题图、§8 英文出题链）、[skill-graph-plan.md](skill-graph-plan.md)、[visual-contract-v2.md](visual-contract-v2.md)。
>
> 2026-09-26 重写：旧版（基准 `9655b28`）的 P0「备份根目录 qbank.json / 停掉 8434 / 升级 Claude CLI / 改 config」以及
> 「用 YY_DATA_DIR 首启迁移把个人题库拷进试点目录」都**作废**——开发和测试一律不碰真实题库、真实配置、正在跑的服务和孩子数据。

---

## 0. 切片与状态

| 片 | Issue | 内容 | 状态 |
|---|---|---|---|
| 前置 | #42 | 隔离测试只用已跟踪的 `demo/qbank.json`（`tools/lib/test_fixtures.mjs`），不再拿根目录个人题库兜底 | 已实现，Review（PR #46） |
| **A** | **#43** | 共用 `TeachingBrief` + 英文题图硬校验，server 薄接缝，zh 冻结 | **已实现，独立复核通过，交付 Review（见 §1）** |
| B | #44 | 逐题 v2 审稿（pass / revise / needs-human）、报告、有限修复、稳定 draftId | **未实现**（§2） |
| C | #45 | pregen / audit 生产接线（选技能、`--review v2`、按 reviewKey 续跑）+ 隔离端到端 | **未实现**（§3） |
| D | — | 真实 3 技能试点与人工终审 | **未执行**（§4）；A–C 交付后父 #8 仍不能 Done |

---

## 1. A：共用 TeachingBrief 与题图硬校验（#43，已实现，复核通过）

### 1.1 模块与接缝

- **纯模块 `lib/ai/qbank/`**（零 I/O、不读 config、不碰孩子数据、不调模型）：
  - `buildTeachingBrief(input)` → 深冻结对象，带 `briefHash`（规范化 JSON 的 sha256）和 `briefId`（`tb1-` + 前 16 位）。
  - `renderGeneratorBrief(brief)` / `renderJudgeBrief(brief)`：两边渲染同一个对象、印同一个 `briefId`。
  - `validateEnglishQbankBatch(raw, requested, { brief, checkVisual, allowedTags, existingQids })` → `{ accepted, rejected, warnings, coverage, briefId }`。
  - `englishQbankSchema(base, brief)` / `englishQbankHint(base, brief)`：英文专用 schema / 格式说明（只在 brief 允许题图时加可选 `visual`）；共享的 `QBANK_SCHEMA` / `QBANK_HINT` 对象不动。
- **server.js 薄接缝**：
  - `qbankBriefFor(item, gradeData)`：现读已跟踪的 `data/curriculum/visual-contract.json` 和 `data/lessons/en/<id>.json` 原文，连同相对路径交给模块；从 `skillIndex` 算图谱后继。
  - `qbankPrompt(..., brief)`：en 分支整段由 brief 渲染，删掉了「there is no picture」那句；zh 分支文本一字不动。
  - `validateQbankBatch(raw, requested, allowedTags, ctx)`：不传 `ctx` = 老行为（zh 和老调用方）；传 `ctx = { brief, existingQids }` 走英文硬校验。另导出 `validateQbankBatchEn`（完整报告）。
  - `judgeQuizPrompt(item, gradeData, questions, lang, brief)`：en + brief → 带 brief 和完整题目（qid / tags / visual）的审稿提示词，输出仍是 v1 的 `pass/problems/bad`；不给 brief 或 zh = 老提示词。
  - `ensureQuizBank(item, gradeData, lang, providerId, task, judge, extra)`：en 在这里**建一次** brief（或用 `extra.brief`），同一个冻结对象喂提示词、schema/hint、硬校验和 `judge(batch, { brief, briefId, lang, itemId, hardChecks })`；两次尝试也是同一份。judge 拿到的 batch 是冻结副本，入库的是硬校验过的原对象。只收一个参数的老 judge 照常用。zh 路径不变（judge 仍只收到 batch 本身）。
  - 显式传入的 brief（`extra.brief`、`qbankPrompt` / `judgeQuizPrompt` 的参数）必须是 `buildTeachingBrief` 的原样产物（整棵冻结、`briefHash` 重算对得上），并且条目 id、年级、条目种类、主题都和这道题的视图一致（`qbankBriefExpect` / `QB.briefMismatch`）——同一技能 id 在别的年级视图里当复习题时，本年级的 brief 不能混用。对不上在调用引擎之前就报错。
  - `tools/pregen.mjs`：只加了把 `ctx.brief` 传给 `judgeQuizPrompt` 的一行接力，没有新命令行功能。

### 1.2 brief 里有什么（全部来自注入的事实，不让模型编）

- 目标 = 条目自身的 `en`（注明来源：技能图谱 / 大纲条目）；非技能条目带大纲 elaborations 和术语。
- 技能类型与讲法重心（`SKILL_TYPE`）、表示顺序 `rep`（L1 围绕 `rep[0]`）、所属标准 id + 原文（**原文缺失就记 missing，不补写**，只作背景）。
- 允许的先修（`item.skill.prereq`）；**图谱后继 `outOfScope`**：把本技能列为先修的技能，附来源说明——这是课程结构事实，**不代表任何孩子学过 / 没学过什么**；旧计划「同主题文件顺序靠后 = 还没教」的推断不采用。
- 登记误区（id / en / pattern / remedy，来自 `misconceptions.json` 已展开的 `item.skill.misc`）。
- 难度三级规则文本 + L3 辨析题上限 + §7 题图规则（`rules.version = qbank-en-rules/1`，`rules.hash` 随文本变）。
- 题图：契约路径 / sha256 / 版本；`questionTypes` = 契约 `capabilities.questionVisual.types` 里规格完整的那些（规格没有 `check` 数组、规则名不是 `checkVisual` 实现的那些、规则参数形状不对——比如 `range.min` 不是数字，`checkVisual` 拿 NaN 比较会一律放行——都记进 `unusable`，不允许；只查形状，判定仍全在 `public/visual-check.js`）；`allowed` = 技能 `rep` ∩ questionTypes（非技能条目 = 全部 questionTypes）；允许类型的契约规格原样拷入（校验就用这份）；契约缺失 / 读不动 → 不允许任何题图。契约自己写的渲染限制（`apple:false` + `appleNote`、`questionVisual.fallback`）原文出现在出题和审稿两边，不另定规矩。
- 课文：状态 `present / missing / unreadable`、相对路径、sha256（CRLF 统一成 LF 再算）、标题、各步（配图整份保留 type / nums / labels / caption / step，审稿端全量渲染，出题端只给类型和图注）、文件自带的生成来源；**`humanReview` 一律 `unknown`**——课文文件存在不证明人工审过。某一步没有可读台词、文件声明的 `lang` 不是 en、`curriculumId` 对不上 → `unreadable`，课文对齐不可核对。
- 补充目标：只接受注入的草稿，标 `status: "draft"`，渲染时写明「不是官方标准、未经人工审」。A 不生成任何补充目标。

同输入同哈希；课文字节、契约、规则文本、误区、先修、后继任一变化，`briefHash` 都变（`tools/test_qbank_brief.mjs`）。

### 1.3 硬校验（英文，送审和入库之前）

硬规则不过的题**整道不要**：不进审稿、不进 `qbank`、不落盘；绝不「删掉坏图、题留下」。有效题不足老门槛（`max(3, ceil(requested/2))`）就抛错，账本里记拒绝代码。

| code | 规则 |
|---|---|
| `question_missing` / `options` / `answer_index` / `level` / `explain_missing` | 题干、解析是非空字符串，恰 4 个非空字符串选项；`answerIndex` 为 0-3、`level` 为 1-3 的整数（JSON 数字或纯数字字符串；**不再把 1.6 悄悄四舍五入**，数组 / 对象 / 布尔 / null 不认——`Number([])` 是 0） |
| `visual_shape` / `visual_extra_field` / `visual_nums` / `visual_labels` / `visual_caption` / `visual_step` | visual 只能有 type/nums/labels/caption/step；nums 全是数字；labels 全是字符串；caption 必填；step 给了就 > 0 |
| `visual_unknown_type` / `visual_contract_malformed` / `visual_not_question_type` / `visual_not_allowed` | 类型在契约里、契约规格完整（有 `check` 数组或显式 `unchecked`，每条规则是 `checkVisual` 实现的规则且参数形状正确）、是题图类型、且在 brief.allowed 里 |
| `visual_contract` | `public/visual-check.js` 的 `checkVisual`（渲染端同一份实现）不过 |
| `visual_contract_unavailable` | 契约缺失 / 读不动时带图的题一律拒（验证不了）。渲染端拿不到契约或规则时放行是它的降级口径，出题链不继承 |
| `visual_recited` | 带图但题干还在念图（和 `visual_check --qbank` 同一条正则） |
| `visual_missing` | 没带图但题干指着一张图（固定英文短语：look at / using / in the … graph/chart/pictograph/diagram/picture/figure/image、… below/above/shown） |
| `internal_type_name` | 孩子看得到的文字里出现契约内部驼峰图型名（statBar、pieChart…） |
| `visual_answer_annotation` | caption / labels 明写答案（「the answer is …」「solution:」这类）。只认明确的答案声明：图注里恰好出现和选项相同的数（「Grade 2 books」「the 2.5 km race」）证明不了泄露，不拦，留给审稿 |
| `qid_invalid` / `qid_duplicate` / `qid_conflict` | 显式 qid 格式、批内重复、与题库已有 qid 冲突（冲突会在 merge 时覆盖原题，所以拒） |

标签沿用老规则：未登记 id / 干扰项标 ok → 规范成 `other`，只记 warning，不因此丢题。技能条目的 4 个对齐标签一律保留——
误区登记表为空时 `ok` / `other` 也是合法标签（老路径在这种情况下会丢掉，英文路径不再丢）；非技能条目没有 tags 字段，照旧丢并记 warning。

审稿回调拿到的是**冻结的副本**，入库用的是硬校验通过的原对象：回调就算改了它手里的题（比如塞一张不支持的图）也到不了题库。

**能证明什么就只报什么**（`COVERAGE`）：图与题干 / 解析在数量、整体、单位、刻度上是否一致，答案能否直接从印出的数值（pieChart 扇区）或图上算出，别的措辞下的「引用不存在的图」，数学正确性，课文对齐，干扰项是否真对应所标误区——**这些硬校验都不查**，留给审稿（#44）。

### 1.4 验证

| 测试 | 内容 |
|---|---|
| `tools/test_qbank_brief.mjs` | 确定性、键顺序无关、失效、缺课文 / 读不动 / 空步骤 / 语言不符 / id 不符、课文配图整份进审稿、契约规格残缺、Apple 渲染限制、不编造、深冻结 + 哈希校验（浅冻结的改过的拷贝不认）、视图绑定、生成 / 审稿同一版本 |
| `tools/test_qbank_validate.mjs` | 合法 visual / tags / qid 保留（含空误区表的 ok/other）；各类坏题（含字段类型、明写答案的图注 / 标签、残缺规格）逐条拒、绝不进 accepted；中性数字图注不误拦；纯文字兼容；schema / hint（示例按契约合法、step 可为小数） |
| `tools/test_qbank_server_seam.mjs` | 进程内真实 server.js（隔离临时 DATA_ROOT + 假引擎）：英文路径在送审、merge、落盘之前硬校验；judge 拿到同一个 brief（注入时同一对象引用）且只拿到冻结副本；别的年级视图 / 伪造的 brief 在调用引擎前被拒；qid 冲突不覆盖旧题；全坏 → 什么都不发布 |
| `tools/test_qbank_zh_freeze.mjs` + `tools/fixtures/qbank-zh-freeze.json` | 改代码**之前**在 `4bcb384` 录的 zh 基线：提示词（技能 / 大纲 / 课程 / 书）、hint、schema、校验输出、审稿提示词、入库结果、失败路径，逐字节比对 |

---

## 2. B：逐题审稿 v2、报告与有限修复（#44，未实现）

依赖 A。以下是设计方向，**尚未实现**，以 #44 为准：

- 复用现有 judge 路由与 `pass/problems/bad` 兼容层，新增逐题 `pass / revise / needs-human`；**模型 pass 不能覆盖硬校验失败**；v2 响应非法不降级成可发布的 v1。
- 审稿输入 = `renderJudgeBrief(brief)` + 完整题目（qid / tags / visual，只剥家庭使用状态 `usedAt`）；缺课文时课文对齐项只能是 not_verified，不能 pass。
- 新题分配**稳定 draftId**（A 不做：A 只保留显式合法 qid，新题仍由 `qbankMerge` 发 qid）。
- 报告绑定内容哈希、`briefHash`、`rules.version`、引擎；dry-run 分开记，不算通过。内容哈希必须按**入库后**的对象算：`qbankMerge` 会重排选项和 tags（`qbankSpread`）。
- 修复只动有问题的题、保身份和难度、次数有限，改完重跑硬校验 + 复审；异常、超时、needs-human、耗尽都留 draft 不发布。
- 报告 / draft 落在显式 DATA_ROOT 下的旁路目录，不塞进孩子内容、不进导出包；报告写失败不能假成功。

## 3. C：生产脚本接线与隔离端到端（#45，未实现）

依赖 B。**尚未实现**，以 #45 为准：

- `pregen` / `audit_qbank` 支持选技能与 `--review v2`，原 v1 / zh 行为保留；续跑按有效 reviewKey（内容 + brief + 规则）而不是题库 key。
- 端到端测：生成 → 校验 → 审稿 → 有限修复 → 存储 → export，全在临时目录，不写 Apple 真实 content、不同步仓库。
- **导出现状**（核对过当前代码）：`export_apple` 只剥 `usedAt`，离线维护包保留 `tags` / `visual` / `qid`；这不改变孩子端答题 HTTP 的边界——`/api/quiz/session` 不下发答案 / 解析 / tags，由服务端判分（qbank-standard §4）。旧文档里「tags 永远不下发」说的是答题 API，不是离线维护包；C 只澄清文档，不自行删字段。

## 4. D：真实试点（未执行）

A–C 交付后才考虑，需另行授权；当前只开发隔离代码与试点清单，**不把回放测试当真实质量结论**，不自动访问真实题库 / 家庭配置，不发起付费生成。

- 候选（旧计划核对过、待重新确认）：`YY.MATH.FRAC.EQUIV.VISUAL`（表示是图、存量题零图）、`YY.MATH.DATA.LINE.READ`（issue #5 起源）、`YY.MATH.FLU.MULTDIV.WORD`（多步应用题、barModel 不是题图类型 → 考「不机械配图」）。
- 对照口径：同技能、同数量、可比引擎，A 臂现有 `--judge`、B 臂新管线；记录人工确认的剩余错误、误报、修改量、调用数、时长；未跑的写「未跑」。
- 真实生成、人工逐题终审、网页版作答 / 讲评检查、导出同步，都由维护者按当时的流程显式执行，不写进 agent 的自动步骤。

---

## 5. 边界（每片都适用）

- **zh 冻结**：提示词、hint、schema、校验、审稿 zh 文本一字不动；由 `tools/test_qbank_zh_freeze.mjs` 逐字节兜。
- **不碰真实数据**：开发与测试不读、不写根目录 `qbank.json`、`config.json`、`usage.jsonl`、`data/kids/`、账号 / 会话存储；不停、不重启用户正在跑的服务；不升级本机 CLI、不改真实配置。测试用 `YY_DATA_DIR` 临时目录 + `tools/lib/test_fixtures.mjs`（只拷 demo 题库、写空 config、落迁移标记，不从 app 目录接管数据）。
- **不调真实模型、不联网**：测试注入假引擎 / 回放。
- **不改**：课文 `say`（会触发语音补烘）、课程 / 技能图谱数据、`visual-contract.json`（不升 v4）、渲染端 / 协议、语音、UI、导出数据。
- **Bash 工具反斜杠折叠**：含正则 / 模板串的脚本用 Write 落盘再 `node` 跑。
