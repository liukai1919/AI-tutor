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
| B | #44 | 逐题 v2 审稿（pass / revise / needs-human）、报告、有限修复、稳定 draftId | **已实现，独立复核通过，交付 Review**（§2）；模块与 server 接缝（命令行接线在 C） |
| C | #45 | pregen / audit / export 生产接线（选技能、`--review v2`、按当前版本证据续跑、v2 导出资格）+ 隔离端到端 | **已实现，独立复核通过，交付 Review**（§3）；没有做任何真实运行 |
| D | — | 真实 3 技能试点与人工终审 | **未执行**（§4，清单见 [qbank-v2-pilot.md](qbank-v2-pilot.md)）；A–C 交付后父 #8 仍不能 Done |

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

## 2. B：逐题审稿 v2、报告与有限修复（#44，已实现，待复核）

依赖 A。本节是模块和 server 接缝；命令行接线（`--review v2`）见 §3（#45）。默认路径（v1 审稿、`ensureQuizBank`、zh）一字不变。

### 2.1 模块（`lib/ai/qbank/`，纯编排，副作用全部注入）

- `review.js`（协议，`RUBRIC.version = qbank-review-v2/2`，带哈希）：
  - 每道题的结论 = **逐个选项解题**（`options`：4 条 `{correct, reason}`）+ **9 项检查**（`checks`：每项 `{result, evidence}`）+ **可执行的发现**
    （`findings`：`{category = 检查项 id, field（如 "options[2]" / "visual.nums"）, evidence, reason, suggestedFix}`）+ 状态 `pass / revise / needs-human`。
  - 9 项检查（`V2_CHECKS`）与 n/a 规则——n/a 只看题目事实，**没有图、没有 tags 不能豁免通用检查**：

    | 检查 | 内容 | 允许 n/a |
    |---|---|---|
    | `answer_unique` | 逐个选项求解：标的答案对、其余都错、数学全对 | 从不 |
    | `explain_consistent` | 解析和答案一致、方法对、点出常见坑、不按位置指选项 | 从不 |
    | `distractors` | 干扰项像真错误、正确项不靠长度 / 措辞露馅 | 从不 |
    | `tag_meaning` | 每个干扰项的 tag 真对应它表现的误区（id 合法 ≠ 标得对） | 仅题目没有 tags |
    | `self_contained` | 只凭题干 + 自带的图就能答，不需要 / 不指向没带的图或数据 | 从不 |
    | `visual_semantics` | 图的数量、整体、单位、刻度与题干解析一致，不泄露答案 | 仅题目没有图 |
    | `skill_level` | 考的是 brief 的目标（不是先修 / 后继），符合本级定义 | 从不 |
    | `level_increment` | L2/L3 相对 L1 有实质提升（不是换名字 / 换大数） | **L1 必须 n/a** |
    | `lesson_alignment` | 用课文的术语和方法 | **课文缺失 / 读不动时只能 `not_verified`** |

  - `not_verified`：除上面课文那条外，只有状态是 `needs-human` 时才能写（模型确认不了数学 / 图就交人工，不许硬写 pass/fail）。
  - 状态规则：`pass` = 无 fail、`findings` 为空数组、逐项解题恰好一个对且就是 `answerIndex`；`revise` = 至少一个 fail，且**每个 fail 都有带 suggestedFix 的发现**；
    `needs-human` = 至少一条说明原因的发现。`answer_unique` 为 pass 时逐项解题必须与 `answerIndex` 一致。
  - **缺课文时整体 pass 是允许的**（`lesson_alignment: not_verified`），报告和逐题结论都如实写 not_verified，**不叫「课题一致」**，也不是人工审核。
  - `reviewInput`：白名单拷贝 qid / level / question / options / answerIndex / explain / tags / visual，`id = draftId`（**必须唯一**，重复直接拒）；`usedAt` 和家庭 / 孩子状态不进提示词。
  - `buildReviewRequest(brief, items)`：`renderJudgeBrief(brief)` 原文 + 解题要求 + 检查项 + 状态 / 发现规则 + 题目 JSON；`buildRepairRequest`：`renderGeneratorBrief(brief)` + 失败项 + 发现 + 「同级、不改 qid」。
  - `parseReviewV2` **严格**：送审集合 id 重复 / 不是对象 / 没有 `items` / 未知 id / 重复 id / 缺 id → 整个响应作废；单题的未知状态、缺解题 / 检查项 / 发现、
    未知检查项、结论不在值域或该题不允许、证据为空、发现缺字段、状态与结论不相容 → 只这一题作废。**绝不退回 v1**。
  - `storedPassIsValid`：已存的 pass 用同一个解析器对着这道题重新验一遍（防手改 / 防带问题的 pass / 防旧格式）。
  - `toV1Verdict`：显式的 v1 适配器，合格 v2 折成 `{pass, problems, bad}`（problems 由发现拼出）；任何不合格的 v2 响应都**抛错**，不会变成 v1 的 pass。
  - 哈希：`contentHash(q)` = 发布对象整道题（含 qid、重排后的选项 / tags、visual、任何字段）去掉 `usedAt`；
    `reviewKey` = 内容哈希 + `briefHash` + 课文状态 / sha256 + 规则版本 / 哈希 + rubric 版本 / 哈希 + 审稿引擎身份，组成部分原样存进记录，复用时逐项比对。
  - 引擎身份 `engineIdentity`：`{provider, model, exact, settings?}`。`exact` = 知道确切模型；**不知道确切模型的结论照样落盘，但永远不复用**（报告 `engine.reuse` 写明）。
- `coordinator.js`：`runReviewV2({ brief, raw | resume | audit, deps, opts })`（三种输入只能给一种）：
  - `raw` = 新生成的一批（mode `new`，发布 = 追加）；`resume` = 磁盘上的 draft；`audit` = 题库里已有题的 qid（mode `replace`：没改就不写，修过就**原地替换、保 qid 和发布那一刻的 usedAt**）。
  1. `raw` 先过 A 的硬校验（`validate.js` 新拆出来的不设门槛的 `checkEnglishQuestions`，和 `validateEnglishQbankBatch` 同一段代码）；
     硬校验不过 / 暂存时去重封顶丢掉的题**落成不可发布的 held draft**（白名单内容 + 硬校验发现 + 稳定 draftId），供人工处理，`resume` 不会自动拿它；
  2. **只暂存一次**（`deps.stage`，见 2.2），拿到的就是将来发布的对象；分配 `draftId`；**整组 draftId / qid 必须唯一，撞了的全部拒收**（不猜哪份对，不送审、不写 draft、不发布）；
     暂存后的对象再过一遍硬校验，规范化改了题（多字段、图不合法）就是 `hard_failed`；
  3. 算哈希 / reviewKey；**这个精确版本**的非 dry 有效 pass 且各组成部分逐项相同 → 复用，否则整批送审（`deps.judge`，带超时和 AbortSignal）。
     **题库里已有同样内容也一样要有当前版本的证据**（brief / 课文 / 规则 / 引擎变了就重审）；
  4. **只修 `revise` 的题**：修复输出改 qid / 改难度 / 硬校验不过 → 拒收（耗一轮、不送审）；过了就带原 qid 重新暂存、再硬校验、再审。轮数上限默认 2、最多 3。
     内容换成新版本时旧结论清空（只留在 attempts 和旧版本的审稿记录里），新版本只有拿到有效复审才有结论；
  5. 先写审稿记录 → draft（含 held）→ 报告（`publication: pending`），任何一步写失败 → `storage_failed`，**不发布**；
  6. 再发布通过的题：内容和题库一致的 `replace` 题**按此刻的题库重新核对**（审稿期间被改了 → `stale`，不算 unchanged）；其余交 `deps.publish`，失败 → `publish_failed`，报告改成 failed；
     成功后尽力更新 draft / 报告，写不进去就在返回值 `finalizeErrors` 里如实说，存储里的报告停在 pending（不会把没发的说成发了）。
  - 终态：`passed`、`needs_human`、`exhausted`、`error`（抛错 / 响应不合格）、`timeout`、`cancelled`、`hard_failed`、`stale`；只有 `passed` 会发布
    （`publication`：`added` / `replaced` / `unchanged`）。held draft 的状态是 `hard_rejected` / `staging_dropped`。
  - 报告的课文对齐覆盖按**真正拿到的有效逐题结论**算：`not-reviewed`（一题都没审成，哪怕课文在）/ `model-reviewed-for-some-items` / `model-reviewed-per-item`；课文缺失始终 `not_verified`。
    `humanApproval` 永远是 `none`，`lesson.humanReview` 是 `unknown`。
  - 超时 / 取消：每次调用只在计时器之前接收一次结果，迟到的完成被丢弃（测试里迟到的 pass 什么都没发、什么都没写）；外部 `signal` 取消后不发布。
    **限制**：`runEngine` 的适配器不认 signal，超时后引擎进程 / 请求可能继续跑、继续记账，只是结果不用。
  - **已有题审不过时题库里的原题不动**：`audit` 审出 needs-human / error / 超时 / 耗尽 / hard_failed，B 只是不写新版本、把结论和 draft 落盘——
    原来那道题**仍在题库里、仍会被默认导出带走**。B 不删题、不下架；#45 定的流程：`export_apple --review v2` 不导出没有当前通过证据的题（§3.3 / §3.4），默认导出不变。
  - 旁路记录（审稿记录 / draft / 报告）里的题目一律是白名单内容，**不含 usedAt 或任何家庭 / 孩子字段**；新题追加时 usedAt 由发布接缝置 0，替换时取题库当时的值。
  - dry：记录写在 `dry/` 下、`publication: dry-run`、不复用任何记录；正式运行从不读 dry 记录。
  - 续跑（`resume`）：只收本条目 / 本题库的 draft；题库指纹没变 → 原对象；变了 → 带原 qid 重新暂存（内容变了就重审）；
    内容已在题库（发布成功但收尾没写上）→ 按 `replace` 处理，要有当前版本证据，不重复写；`replace` draft 要替换的版本在题库里已经变了 → 拒收。
- `store.js`：`createReviewStore({ root, fs })`，`<DATA_ROOT>/qbank-review/{records,drafts,reports}` 和 `dry/…`；tmp + rename，失败抛出、清 tmp、旧文件不动；读到坏 JSON 抛错（协调器当作没审过）。

### 2.2 server.js 接缝（只加不改；`qbankSave` / `ensureQuizBank` / v1 审稿 / zh 不动）

- `qbankStageV2(key, items, { baseFingerprint, extra })`：真实 `qbankMerge` 作用在题库的**深拷贝**上，一道一道并：新题走新题路径（去重、封顶、`qbankSpread`、发 qid），
  qid 已在题库的走同 qid 路径（只换内容字段、保 level / usedAt）；同一 qid 在同批里重复 → 丢弃。不动内存和磁盘。
- `qbankPublishV2(key, candidates, { baseFingerprint, modes, fsOps })`：指纹对不上（暂存后同一题库被改过）→ 拒；`new` 追加（qid 不能已在）、`replace` 原地替换（必须在，usedAt 取此刻题库里的值）；
  整份题库 tmp + rename 写盘，**失败抛出**；磁盘成功后才改内存（替换的题原地改对象，和 `qbankMerge` 一样）。
- `qbankBaseV2`（指纹 / qid / 哈希 / 题目拷贝）、`qbankReviewStore(fsOps)`（根 = `DATA_ROOT`）、`qbankReviewDepsV2(item, gradeData, { judgeProvider, repairProvider, judgeModel?, repairModel?, fsOps })`
  （审稿 / 修复经现有 `runEngine`，账本任务名 `judge:quiz` / `quiz:repair`，不开新的网络客户端）、`qbankReviewV2(item, gradeData, { raw | resume | audit, … })`。
- `qbankEngineIdentityV2(provider, declaredModel)`：按适配器实际怎么调来定引擎身份（不改 `engineModel` / v1 路由）：claude CLI = `config.claude.model`（+ `effort`），
  **没配 model 时是 CLI 自己的默认模型 → 未知（exact:false）**；anthropic = 配置的 model，没配就是适配器写死的 `claude-opus-5`；openai = 配置的 model；ollama = 探测到的模型；
  gemini / codex / grok 不传模型参数 → 未知。注入的引擎（测试替身）由调用方用 `judgeModel` / `repairModel` 声明；**对内置的 7 个引擎声明无效**，身份一律按实际配置算。
- **并发约定**：指纹只算这一个题库、不含 `usedAt`（孩子做题不会让发布失败，替换时用发布那一刻的 usedAt）；整份 `qbank.json` 在发布时同步地从**当时的内存题库**生成，
  别的题库在审稿期间完成的写入不会被旧快照盖掉（有交错测试）。同一题库并发两次 v2：后发布的那次指纹对不上 → `publish_failed`，续跑会按新题库重新暂存。
  **跨进程不协调**：同一个 `DATA_ROOT` 的 `qbank.json` 只能有一个进程在写（和现有的 server / pregen 约定一样）；#45 的命令行在一个进程里按条目并发、同一题库不会同时跑两份，沿用这个约定。
- 旁路目录不进 `qbank.json`、不进孩子目录；`tools/pack.mjs` 按显式清单拷文件，带不进安装包；源码模式下落在仓库根，已加进 `.gitignore`。

### 2.3 验证与边界

| 测试 | 内容 |
|---|---|
| `tools/test_qbank_review_v2.mjs` | 送审输入剥离与 id 唯一、提示词绑定、严格解析矩阵（含带发现的 pass、逐项解题不一致、n/a 豁免、needs-human 的 not_verified）、存档 pass 复验、v1 适配器、reviewKey 失效；协调器在合成回放（`tools/fixtures/qbank-review-v2-replay.json`）上的编排：错答案、双正确、tag 含义错、合法图但整体 / 单位不符、需要图却没带、跨技能、L3 无提升、needs-human、耗尽；硬校验（修复输出 / 暂存对象）不被 pass 覆盖；held draft；身份冲突；修复后不继承旧结论；畸形 / 部分响应；抛错 / 超时 / 挂起 / 迟到 / 取消；dry；复用与篡改；已有题的审查（无记录必审、精确复用、brief / 课文 / 规则 / 引擎变了重审、坏题原地修复、替换目标已变、审稿期间被改 → stale）；存储失败 |
| `tools/test_qbank_review_store.mjs` | 真实临时目录 + 注入的写 / 改名故障；重启（新实例）读回；协调器 + 真实存储：报告写失败不发布、发布失败后重启续跑复用 pass、坏记录不复用、held draft 重启后还在 |
| `tools/test_qbank_review_server_seam.mjs` | 进程内隔离 server：真实 `qbankMerge` 暂存一次、发布对象哈希 = 报告哈希、老题不动、`qbank.json` 写 / 改名失败磁盘与内存都不变、旁路文件不含 usedAt、报告写失败不发布、审稿期间题库变了不发布、修复经 `runEngine`、已有题原地修复保 qid / 此刻 usedAt、别的题库审稿期间的写入和孩子的 usedAt 不丢、引擎身份解析（claude 模型 / effort、默认模型未知不复用、openai / anthropic / 无模型参数的引擎）、缺课文、**新进程重启**读回 |

另有 `build/issue44/mutation-check.cjs`：逐条拆掉关键保证（硬校验两层、v1 适配器、缺课文、带发现的 pass、n/a 豁免、逐项解题、id 折叠、迟到结果、只比 key 的复用、dry 复用、
已有内容跳过审稿、身份冲突、修复后继承旧结论、unchanged 不复核、held draft、报告预先宣称、旁路带 usedAt、未知模型也复用、存储 / 发布吞错、先改内存、忽略题库变化、替换丢 usedAt），对应测试都会失败。

**这些测试只证明编排对假引擎是对的**：合成的审稿结论是手写的，证明不了任何真实审稿引擎能发现这些错误，也证明不了题目在教学上正确。真实质量要看 D 的试点和人工终审。

## 3. C：生产脚本接线与隔离端到端（#45，已实现，待复核）

依赖 B。生产路径全部走 B 的 `qbankReviewV2` / `runReviewV2`（暂存、审稿、修复、发布、旁路记录），没有在老的 `ensureQuizBank` / `audit_qbank` 路径上加元数据冒充。
**不带 `--review v2` 时三个脚本的老行为不变**（`tools/test_qbank_cli_v1_regress.mjs` 对照改动前录的输出与落盘结果逐字比对；唯一有意的改动是导出 manifest 里 tags 那条说明，见 3.4）。

### 3.1 命令（空格分隔写法；`--review=v2` 这类等号写法直接报错）

```
node tools/pregen.mjs      --review v2 --skill <id>[,<id>…] [--provider <引擎>] [--judge [<引擎>]] [--concurrency 1-8] [--review-timeout 秒] [--dry]
node tools/audit_qbank.mjs --review v2 --skill <id>[,<id>…] [--judge [<引擎>]] [--concurrency 1-6] [--review-timeout 秒] [--dry]
node tools/export_apple.mjs --review v2 --skill <id>[,<id>…] [--judge <引擎>] --out <目录> [--no-voice] [--dry]
node tools/pregen.mjs      --review v1 --skill <id>[,<id>…] [老流程的其它开关]     # 老流程只做点名条目（试点对照组）
```

- `--review v1 --skill`：**老流程**（`ensureQuizBank` + 老 `--judge`）只做点名条目的课和题库、不做单元卷，给试点对照组用；不能和 `--grades / --books / --no-skills / --skills / --core / --pilot / --limit` 一起用，
  `--only` 只能是 all / lessons / quiz、`--langs` 只能是 zh / en（写错就报错，不会变成「0 个任务、退出 0」）。
  不写 `--review` 时 `--skill` 仍然报错，老默认一字不变。

- **选条目**：`--skill` 收原样的条目 id（逗号分隔，区分大小写）；没有 `--skill`、不认识的 id、重复 id、空值都在调模型之前报错，**v2 绝不默认跑整套大纲**。
  技能在别的年级主题里当复习题会再出现一次（`reviewFrom > 0`），v2 固定用它自己年级那份视图（brief 的年级 / 主题跟着它）；BC 大纲条目只有一份视图。
- **只做英文闯关题库**：pregen 的 `--langs` 只能是 en、`--only` 只能是 quiz（都可以不写）；`--grades / --books / --no-skills / --skills / --core / --pilot / --limit / --force / --unit-count`、
  audit 的 `--prefix / --limit / --provider`、任何没列出的开关都和 v2 冲突，报错。老的裸 `--skills` 开关照旧可用；`--skills <id>`（老解析器会扔掉 id、照样跑全部）现在任何模式都报错。
  `--skill` / `--review-timeout` 不带 `--review v2` 报错；`--review` 重复（不管先写哪个值）报错。以上检查都在加载 server.js 之前做完。
- **引擎**（选路仍是现有的 `pickProvider` / `runEngine`，只是显式要求必须兑现）：`--provider`（出题，路由键 `pregen:quiz`）、`--judge`（审稿，路由键 `judge:quiz`）。
  命令行点名 > `config.providerByTask[任务]` > `config.provider`，**最先出现的那个不可用就报错**，不像老 `pickProvider` 那样悄悄往后落；什么都没指定才按自动顺序挑。
  修复用审稿引擎（B 的默认）。账本任务名：pregen 的出题 `pregen:quiz`、审稿 `judge:quiz`，audit 的审稿沿用老 audit 的 `audit:quiz`，修复 `quiz:repair`。
  审稿引擎身份按 server 的实际配置解析（claude = `config.claude.model` + `effort`）；模型不确定（比如把 claude 的 model 清空）时照样能跑，但结论**永远不复用、也不能给导出作证**（开跑时会提示）。

### 3.2 每个条目怎么跑（`tools/lib/qbank_v2_cli.mjs` 的 `runItemV2`）

1. **续跑**能接着做的正式 draft（`passed` 但没发出去的、`error` / `timeout` / `cancelled` / `stale`）；`needs_human` / `exhausted` / `hard_failed` / `hard_rejected` / `staging_dropped` 留给人，不自动重送。
   协调器拒收的 draft（它要替换的题库版本已经变了、qid 撞了、暂存丢弃）标成 `superseded`（记下原状态和原因，内容留着给人看），**不再遮挡题库里的现行版本**，也不会每次都再续一遍。
2. **审已有题**：题库里每道题按唯一口径 `QB.currentEvidence` 判断（`lib/ai/qbank/evidence.js`，协调器复用、导出也是它）——
   - `certified`：**当前审稿引擎身份**对这道题此刻这个版本（内容 + brief / 课文 / 规则 / rubric）有有效非 dry pass，且没有任何（模型确定的）引擎对同一版本**更新的**有效不过（同一时刻按不过算；更早的不过已被这次 pass 取代）；
   - `held`：当前引擎对这个版本判了 revise / needs-human，或被更新的不过否决——不自动重送，等人工或改内容；
   - `unverified`：没有有效记录（没审过、内容 / 课文 / 规则 / rubric / 引擎 / 模型 / effort 变了、记录残缺或被改过、只有 dry 记录）→ 送审。
   「有效」= 组成部分逐项重算相同、reviewKey 自洽、存的题目对得上、**三种结论都用同一个严格解析器重验**（残缺的 needs-human 不算定论）。
   **老的「题库满了」（`quizDone`）和 `audit-report.jsonl` 在 v2 里既不读也不写，证明不了任何题。**
   本轮续跑真正接手的 qid 不再重复送审。
3. **出新题**（仅 pregen）：通过数不足 4 道的级别各要 4 道（每级封顶 12，和老规则一致），一次运行一批；出题引擎失败重试一次。
   生成用和 `ensureQuizBank` 英文分支同一份请求（抽出成 `qbankEnRequest`，内容不变）经 `qbankGenerateV2` 只生成不入库，原样交给协调器：硬校验 → 暂存 → 审稿 → 只修 revise → 通过的才发布。
4. 每个条目打印每次协调器运行的状态、逐状态计数、新增 / 替换 / 未改仍有效 / 复用记录、扣下的候选、**报告文件路径**，以及题库每级「当前审过 / 总数」。

**退出码**：`1` = 有故障（旁路记录 / draft / 报告写盘失败、题库写盘或发布失败、发布后收尾写入失败、旁路读不动、意外异常）；
`2` = 没故障但没做完（题库不齐、已有题没有当前通过证据，或有调用超时 / 出错 / 畸形结论要重试）；`0` = 点名的条目都齐了。
被扣下等人工的**新候选题**（needs-human / 耗尽 / 硬校验不过）只报数、draft 留在 `qbank-review/drafts/`：题库已经齐了就不算没做完（它们本来就不会发布）。
`--dry`：pregen = 只列计划（不调模型、不写任何文件），读不动旁路 → 1；audit = 真的送审，结论记在 `qbank-review/dry/`，不改题库、以后的正式运行和导出都不认；
dry 只免掉「没发布 / 不齐」，dry 里的超时 / 出错 / 畸形结论照样是 2、读写故障照样是 1。

### 3.3 已有题审不过怎么办（B 契约之上的明确流程）

- **题库里的原题不删、不下架**：audit 审出 needs-human / 耗尽 / 出错 / 超时 / 硬校验不过，只是没有当前通过证据；原题仍在 `qbank.json`、孩子照常能做到、**默认导出照样带着它**。
  修复通过的原地替换（保 qid、保孩子的 usedAt）。
- **v2 导出不带它**（见 3.4），直到有人改了内容（新版本重审通过）或当前审稿引擎对这个版本给出 pass 且之后没有更新的不过。

### 3.4 导出（`tools/export_apple.mjs`）

- 默认导出不变：每题只剥 `usedAt`，离线内容 / 维护包保留 `qid` / `tags` / `visual`。
- `--review v2 --skill …`：点名条目的**英文**题库只导出 `currentEvidence` 判为 `certified` 的题，证明它的是 `--judge`（或 `config.providerByTask["judge:quiz"]` / `config.provider`）
  这个审稿引擎**此刻的身份**——claude 换了 model 或 effort，旧 pass 就不再算；导出不探测引擎（ollama 的模型要探测才知道 → 不确定）；**模型不确定的引擎证明不了任何题**。
  字段 = 审稿白名单（qid / level / question / options / answerIndex / explain / tags / visual），不带 usedAt、draftId、审稿元数据；`qbank-review/` 旁路文件不进包。
  某一级一道合格的都没有 → 这份题库整份不导出（manifest `qbankReview.banks[key].withheld` 写原因），退出码 2。没点名的题库和中文题库按默认规则导出。
  manifest 多一个 `qbankReview`（审稿引擎身份、规则、每个题库的导出 / 排除计数，`humanApproval: "none"`），不含 draftId / reviewKey / runId。
- **预检在删输出目录之前做完**：选条目、审稿引擎、读全部正式审稿记录（有读不动的 → 退出码 1，坏记录可能正好是某道题最新的「不过」）、逐题判资格；任何一步出错，上一份导出原样留着。
- **输出目录保护（所有模式）**：`--out` 是源码根 / 数据根或它们的上级、或落在 `data/`、课程 / 单元卷 / 语音包、用户数据、`qbank-review/`、语音缓存里 → 报错，不删。
- **tags 的边界**：离线内容包里保留 tags（判分后的误区诊断 / 回补要用）；孩子作答的界面 / 接口不能在作答前展示或下发 tags。Node 端的答题 HTTP（`/api/quiz/session`）本来就不下发
  `answerIndex` / `explain` / `tags`（qbank-standard §4）。manifest 和 `docs/handoff-apple.md` 里原来「tags 绝不能下发给客户端」的说法已改成这个区分，字段一个没删。

### 3.5 验证

| 测试 | 内容 |
|---|---|
| `tools/test_qbank_cli_v2.mjs` | **真实脚本子进程**（pregen / audit_qbank / export_apple），临时 DATA_ROOT，假引擎经 `tools/lib/cli_stub_preload.mjs` 注入（内置 7 个适配器全部换成一调就抛错、探测换成空操作；预载器在加载 server.js 之前拒绝未初始化 / 不在临时目录的数据目录）。参数 / 选条目 / 引擎显式校验都在探测和调模型之前失败且不写文件；路由到配置的审稿引擎、内置名 claude 的身份（钉 model 复用、换 effort / model / 清空 model 导出不认、未知模型的旧 pass 和旧 needs-human 都重审）；生成 → 硬校验（缺图、不允许的图扣下）→ 审稿 → revise 修复复审 → 发布，审稿人看到的就是发布的（逐字段）、出题 / 审稿 / 修复同一个 brief；needs-human / 畸形结论 / 超时不发布；多次运行续跑（同 draftId / qid，只发布一次）；内容 / 课文 / 规则 / 审稿引擎变了重审、改回去不重审；导出字段往返、过时版本对照、另一个审稿引擎的更新 needs-human 否决；已有题审不过留在题库、默认导出带、v2 导出不带、修好的原地替换保 usedAt；dry 与正式分开、dry 超时非零；报告写失败 / 题库写失败 / 写完即崩的重启；过时 draft 不遮挡现行版本；两个条目并发不丢写入；导出 withheld、坏记录、输出目录保护 |
| `tools/test_qbank_evidence.mjs` | `matchRecord` / `latestVerdict` / `currentEvidence` 逐条（dry、种类、组成部分、key 自洽、存的题目、三种结论重验、未知模型、更早 / 更新 / 同时刻的不过）、`store.listRecords` 报出坏文件、`exportV2Bank`、参数与选条目、`strictEngine`、输出目录保护（只用临时假根目录） |
| `tools/test_qbank_cli_v1_regress.mjs` | 改动前（30752f2）录的老命令行输出 / 题库 / 审稿报告 / 导出文件哈希，逐字比对 |

**这些测试只证明编排对假引擎是对的**：审稿结论由脚本按题干标记写死，证明不了任何真实审稿引擎能发现这些错误，也证明不了题目在教学上正确。真实质量要看 D。

### 3.6 限制

- 审稿模型不确定的引擎（claude 不钉 model、gemini / codex / grok、没探测的 ollama）：能跑、能发布本次审过的题，但每次都重审已有题，导出不认。
- 白名单外还带别的字段的老题（内容哈希算进去了、记录里的题是白名单）拿不到可复用的证据、也不会被 v2 导出——要先人工清理字段。
- `superseded` 的 draft 和 needs-human / 耗尽的 draft 一样只留给人看，没有自动清理。
- 同一个 `DATA_ROOT` 仍只能有一个进程在写（B 的约定）；v2 命令行按条目并发、同一题库不会同时跑两份。
- 超时后引擎调用可能还在后台跑、照样记账（B 的限制）；命令行结束时最多再等 3 秒就退出，不被挂着的调用拖住。

## 4. D：真实试点（未执行）

A–C 交付后才考虑，需另行授权；当前只开发隔离代码与试点清单，**不把回放测试当真实质量结论**，不自动访问真实题库 / 家庭配置，不发起付费生成。

- 候选（已在已跟踪的技能图谱里核对：g5 / g6 / g5）：`YY.MATH.FRAC.EQUIV.VISUAL`（技能的表示本身是图）、`YY.MATH.DATA.LINE.READ`（issue #5 起源）、`YY.MATH.FLU.MULTDIV.WORD`（多步应用题、barModel 不是题图类型 → 考「不机械配图」）。
- 具体步骤、命令、对照组方法和人工验收模板：[qbank-v2-pilot.md](qbank-v2-pilot.md)（全部**未执行**）。
- 对照口径：同技能、同数量、可比引擎，A 臂现有 `--judge`、B 臂新管线；记录人工确认的剩余错误、误报、修改量、调用数、时长；未跑的写「未跑」。
- 真实生成、人工逐题终审、网页版作答 / 讲评检查、导出同步，都由维护者按当时的流程显式执行，不写进 agent 的自动步骤。

---

## 5. 边界（每片都适用）

- **zh 冻结**：提示词、hint、schema、校验、审稿 zh 文本一字不动；由 `tools/test_qbank_zh_freeze.mjs` 逐字节兜。
- **不碰真实数据**：开发与测试不读、不写根目录 `qbank.json`、`config.json`、`usage.jsonl`、`data/kids/`、账号 / 会话存储；不停、不重启用户正在跑的服务；不升级本机 CLI、不改真实配置。测试用 `YY_DATA_DIR` 临时目录 + `tools/lib/test_fixtures.mjs`（只拷 demo 题库、写空 config、落迁移标记，不从 app 目录接管数据）。
- **不调真实模型、不联网**：测试注入假引擎 / 回放。
- **不改**：课文 `say`（会触发语音补烘）、课程 / 技能图谱数据、`visual-contract.json`（不升 v4）、渲染端 / 协议、语音、UI、导出数据。
- **Bash 工具反斜杠折叠**：含正则 / 模板串的脚本用 Write 落盘再 `node` 跑。
