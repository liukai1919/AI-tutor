# 英文出题管线改造（issue #8）· 开发计划

> 一句话：**生成器和审稿器吃同一份确定性的 `TeachingBrief`，题图贯穿生成→硬校验→审稿→导出，审稿结论逐题落盘并绑定内容/brief/规则哈希，修复只动坏题、保 qid、有上限。**
>
> 来源：[issue #8](https://github.com/liukai1919/AI-tutor/issues/8)（app 端 2026-09-13 提）。基准 `dev@9655b28`。
> 执行者：Opus 会话。本计划把 issue 的「必须改 / 想要但不阻塞 / 只是知会」翻成可执行的文件级任务、验收命令和试点实验；**先做第一阶段（§3 P0–P7），第二阶段（§6）不排期。**
> 前置文档：[qbank-standard.md](qbank-standard.md)（题库规则，§7 题图）、[skill-graph-plan.md](skill-graph-plan.md)（技能节点字段）、[visual-contract-v2.md](visual-contract-v2.md)。

---

## 0. 结论先行

| | 现状（已对着 `9655b28` 逐条核实） | 做完后 |
|---|---|---|
| 生成器拿到的教学约束 | `qbankPrompt` 的 `skillRules` 临时拼：类型 / rep[0] / 先修 / 误区（`server.js:852-888`） | 同一份 `teachingBrief(item, gradeData, lang)`，带 `briefHash` |
| 审稿器拿到的教学约束 | 只有标题 + 年级 + 题目 JSON（`judgeQuizPrompt`，`server.js:1060`） | brief + 完整题目（含 qid/tags/visual）+ 对应英文课文；缺课文时显式 `lessonMissing` |
| 题图 | `QBANK_SCHEMA` 无 `visual`（`:803`）；英文提示词写死「there is no picture」（`:864-868`）；`validateQbankBatch` 重建题目时丢 `visual`（`:973`） | schema / 提示词 / 校验三处一起放开，合法 visual 一路保留；「需要图却没图」「图不合法」→ `revise`，不静默删图放行 |
| 存量审稿输入 | `audit_qbank.mjs:63` 只送 `level/question/options/answerIndex/explain`，丢 qid、tags、visual | 只剥 `usedAt`，其余原样送审；新题一出生就有 qid |
| 审稿结论 | `{pass, problems, bad[]}`；续跑按题库 key 跳过（`audit_qbank.mjs:45-48`） | 逐题 `{id, status: pass/revise/needs-human, findings[]}`，绑定 `contentHash + briefHash + rulesVersion + engine`；内容 / 课文 / 规则一变旧结论作废；dry-run 记录不算通过 |
| 修复 | 整批重来一次或按序号剔除（`ensureQuizBank`，`:2525-2553`） | 只改有 findings 的题、保 qid、硬校验+审稿复审、最多 2 轮；耗尽的留草稿不进题库 |

**不做的**：不接 Agno/Composio/Google Docs；不做常驻多 Agent；不动中文（zh 冻结）；不全库重生成；不加孩子端界面；不把联网/付费模型变成学习依赖。

---

## 1. 现状核对（issue 六条证据 + 顺手发现）

issue 说的六条全部成立。补充三点执行时要知道的：

1. **`server.js` 还没 require `public/visual-check.js`**——契约校验目前只在浏览器和 `visual_check.mjs` 里跑；生成链要校验 visual 得先把它接进来（该文件末尾 `module.exports = api`，CommonJS 可直接 require，`visual_check.mjs:24` 就是这么用的）。
2. **`qbankMerge` 才发 qid，且会重排选项**（`qbankSpread`，`:2418-2428`）：审稿在 merge 之前跑，merge 后 `answerIndex`/`options`/`tags` 顺序会变。→ 报告里的 `contentHash` 必须按**入库后**的对象算（§2.5）。
3. **`YY_DATA_DIR` 已经能把 `qbank.json` / `usage.jsonl` / `audit-report.jsonl` 隔离到别的目录**（`server.js:35-36`），课程包仍从仓库 `data/lessons/` 读。试点对照实验（§4）靠它，不用另写隔离脚本。注意首次启动会把根目录的 `config.json`/`qbank.json`/`data/users.json` 等迁移拷贝进去（`:47-60`），这正好当初始拷贝用。

试点三个技能的现状（en）：

| 技能 | 年级 | rep | 题数 L1/L2/L3 | 有图 | 真 tag | 课文 | 选它的理由 |
|---|---|---|---|---|---|---|---|
| `YY.MATH.FRAC.EQUIV.VISUAL` | G5 | fractionBar, pie, areaGrid | 4/4/4 | **0** | 12/12 | 有 | 表示是图，题库却零图——正是「题图贯穿生成」要证明的场景；issue #7 的「不同大小披萨」就在同主题 |
| `YY.MATH.DATA.LINE.READ` | G6 | statLine | 4/4/4 | 11 | 12/12 | 有 | issue #5 的起源题库（`qmt5r32bluscvl3`），考「图与题干/解析语义一致」 |
| `YY.MATH.FLU.MULTDIV.WORD` | G5 | context, barModel | 4/4/4 | 0 | 12/12 | 有 | 多步应用题，barModel 不在题图白名单 → 考「不机械配图」+ 两步推理 + 误区 tag 标得对不对（登记 2 条） |

（G7 备选：`YY.MATH.DEC.OPS.WORD`，只登记 1 条误区，tag 检查没意思，所以不选。）

---

## 2. 设计

### 2.1 `TeachingBrief`（`server.js`，新函数 `teachingBrief(item, gradeData, lang)`，导出）

**全部确定性构造，不调模型。** 数据源：`item.skill`（`server.js:2015-2023` 已算好 type/rep/primary/supporting/prereq/misc）、`skillIndex`（算「还没教」）、`VISUAL_CONTRACT`、`data/lessons/<lang>/<id>.json`、`docs/qbank-standard.md` §2/§7 的规则文本（写成常量）。

```js
{
  v: 1, rulesVersion: QBANK_RULES_VERSION,          // 常量，提示词/审稿规则/硬校验一改就升
  skillId, grade, lang, core,
  topic: { id, en, zh }, title: { en, zh },
  type, typeTeach,                                   // SKILL_TYPE[type].en / teachEn
  rep: [...],
  standards: { primary, supporting: [], primaryText },
  objectives: {
    goal: item.en,                                   // 学习目标；先用技能标题，备课草稿字段留空位（§6）
    prereqAllowed: [{ id, en }],                     // skill.prereq：可借用，考点不能落在上面
    notYet: [{ id, en }],                            // 反向查 skillIndex：把本技能列为 prereq 的技能 + 同主题文件顺序在后面的技能 = 不能提前考
    hints: s.hints || ""
  },
  misconceptions: [{ id, en, pattern, remedy }],    // 和 item.skill.misc 一样，id 白名单就是它
  levels: { L1, L2, L3, l3SpotMistakeMax: 2 },      // §2 文本；L1 绑定 rep[0]
  visual: {
    contractVersion, allowed: rep ∩ contract.capabilities.questionVisual.types,   // 例：EQUIV.VISUAL → [fractionBar, pie]；MULTDIV.WORD → []
    appleUnsupported: allowed 里 contract.types[t].apple === false 的,             // 目前只有 pictograph
    conventions: { [t]: contract.types[t].nums },                                  // 每种图 nums 怎么写，原文照抄
    rules: [§7 红线：数据进 nums 后题干不念图 / 图不印答案 / 数格子题必给 step / 概念题构图题不配图 / 内部图型名不得出现在文本 / caption 必填 / 「the graph below」必须真有图]
  },
  lesson: { path, hash: sha1(文件内容), title, steps: [{ say, math, headline?, visual? }] } | null,
  lessonMissing: !lesson
}
briefHash = sha1(JSON.stringify(brief))             // lesson.hash 在里面，课文一改 brief 就变
```

渲染成提示词的两个函数：`briefForGenerator(brief)`（紧凑：目标/先修/不能考/误区/难度/题图规则；课文只给标题 + 每步 `headline||math`，控 token）、`briefForJudge(brief)`（完整，含课文每步 `say/math/visual`）。**两者读同一个对象**，报告里记同一个 `briefHash`。禁止在提示词里再写「与课程保持一致」这种空话替代 brief。

### 2.2 题图贯穿生成链

- `QBANK_SCHEMA.questions[].visual`（可选）：`{ type: enum(questionVisual.types), nums: number[], labels?: string[], caption: string, step?: number }`。`QBANK_HINT_SKILL.en` 示例里加一条带 `visual` 的题。**zh 的 hint / prompt 一个字不动。**
- `qbankPrompt` en 技能分支：删掉 `:864-869` 那段「there is no picture」，换成 `briefForGenerator(brief)`；里面的题图规则按 `brief.visual.allowed` 分三种口径：
  - `allowed` 非空：读图题（L1 尤其）**可以**带 visual，规则照 §7；纯文字题照旧无图；
  - `allowed` 为空：明确「本技能不配图，题干必须自足」；
  - 任何情况：不许写「look at the diagram below」而没有 visual；不许把 `statBar` 这种枚举原值写进文本（issue #5 1️⃣ 的教训）。
- `validateQbankBatch(raw, requested, allowedTags, brief?)`：
  - 保留 `visual`（有就带，不重建丢掉）；
  - **一出生就发 qid**（`"q" + Date.now().toString(36) + random`，和 `qbankMerge` 同格式；merge 时 `Object.assign` 后写的 `q` 会保住这个 qid——先确认 `:2459` 这行行为，写个断言）；
  - 不再把校验不过的题直接 `return null`——改成 `q._hard = findings[]`，由 §2.3 的硬校验统一判。只有「根本不是题」（无题干 / 选项不是 4 个 / answerIndex 越界 / level 越界）才丢。

### 2.3 硬校验 `qbankHardChecks(q, brief, bankStems)` → `findings[]`（确定性，模型意见不能覆盖）

| 类别 `category` | 规则 | 结论 |
|---|---|---|
| `schema` | 4 选项非空、answerIndex 0-3、level 1-3、explain 非空 | 不过 → 丢（不是题） |
| `tag_unknown` | tags 里有不在 `brief.misconceptions` ∪ {ok, other} 的 id | 规范成 other 并记 finding（不阻塞；审稿会查「标得对不对」） |
| `visual_contract` | `checkVisual(contract, type, nums, labels, {step})`（require `public/visual-check.js`）不过、或 caption 空、或 type ∉ `brief.visual.allowed` | `revise` |
| `visual_missing` | 无 visual 但题干命中 `/\b(graph|chart|pictograph|table|diagram|figure)\b.*\b(below|shown|above)\b|look at the (graph|chart|picture)|the (bar|line|circle) graph shows/i` | `revise` |
| `type_leak` | 题干/选项/解析出现 `\b(statBar|statLine|pieChart|pictograph|fractionBar|areaGrid|numberLine|barModel|dataTable|coordGrid|hundredthsGrid)\b` | `revise` |
| `visual_recite` | 有 visual 且题干命中 `visual_check.mjs:43` 那条「还在念图」正则 | `revise` |
| `length_giveaway` | 正确项字符数 > 1.15 × 其他项最大值（§2 规则，现在只靠模型看） | `revise` |
| `option_position` | explain 命中 `REFS_OPTION_POS`（`:2417`） | `revise`（现在只是跳过打散，其实是坏题） |
| `duplicate` | 题干（空白不敏感）与本批或题库已有重复 | `revise` |

硬校验不过的题**不送审稿也不入库**，直接进修复轮（§2.5）。

### 2.4 审稿 v2（`judgeQuizPromptV2(brief, questions, lang)` + `JUDGE_SCHEMA_V2` + `validateJudgeV2`）

输入 = `briefForJudge(brief)` + 完整题目数组（含 `qid/level/question/options/answerIndex/explain/tags/visual`，只剥 `usedAt`）。独立调用、独立上下文（`runEngine` 每次都是新调用，天然满足）。逐题必查（issue §3 六条）：

1. `answer_unique`：每个选项分别求解，恰一个对；explain 与答案一致。
2. `distractor_tags`：每个干扰项的 tag 是否真对应那条误区的 `pattern`（「id 在册」≠「标得对」）。
3. `visual_semantics`：图与题干/解析在数量、整体、单位、刻度上一致；「需要图」的题确实有可用图；图没把答案印出来。回归案例 issue #7（课文说不同大小的披萨、图画相同整体）。
4. `on_skill`：考的是 `objectives.goal`，没偷渡 `notYet`，先修只是工具。
5. `level_fit`：符合 L1/L2/L3 定义；L2/L3 真改变了应用/推理要求，不是换名字换数字的重复题；L3 辨析题 ≤ 2。
6. `lesson_alignment`：术语、表示、讲法与课文一致；**`lessonMissing` 时必须填 `not_verified`，不许说「一致」**。

输出：

```json
{ "pass": true, "problems": [], "bad": [],
  "items": [{ "id": "qmt5…", "status": "pass|revise|needs-human",
    "checks": { "answer_unique": "pass|fail|not_verified|n/a", "distractor_tags": "…", "visual_semantics": "…", "on_skill": "…", "level_fit": "…", "lesson_alignment": "…" },
    "findings": [{ "category": "visual_semantics", "field": "visual.nums", "evidence": "…", "reason": "…", "suggestedFix": "…" }] }] }
```

`pass/problems/bad` 由 `items` 推导（兼容层：`bad` = status ≠ pass 的下标），老调用方（zh、`withJudge`）不受影响。`validateJudgeV2` 拿不到合法 `items` 时退回 v1 解析并在记录里标 `judgeFormat:"v1"`。模型判不了的数学/图文问题 → `needs-human`，不以「作者自述」或「多数同意」放行。

### 2.5 报告、修复、失效

**报告**（批次旁路，不进 `content/`）：`data/qbank-review/<skillId>.<lang>.jsonl`，一行一个批次/一轮：

```json
{ "v": 2, "batchId": "…", "at": 1757…, "key": "YY.MATH.FRAC.EQUIV.VISUAL|en", "mode": "pregen|audit", "dry": false, "round": 0,
  "engine": { "gen": "claude/claude-opus-5", "judge": "claude/claude-opus-5", "revise": "…" },
  "rulesVersion": "2026-09-12", "briefHash": "…", "lessonHash": "…|null",
  "items": [{ "qid": "…", "contentHash": "…", "status": "pass", "hard": [], "checks": {…}, "findings": [] }] }
```

- `contentHash = sha1(JSON.stringify({level, question, options, answerIndex, explain, tags, visual}))`，**按入库后的对象算**（§1 第 2 点）。
- `reviewKey = qid + contentHash + briefHash + rulesVersion`。续跑时只有存在 `dry:false` 且 `status:"pass"` 的同 reviewKey 记录才跳过；内容、课文、规则任一变化 → key 变 → 重审。引擎信息只记录不进 key。
- `data/qbank-review/` 加 `.gitignore`（和 `audit-report.jsonl` 同理）。

**修复轮** `reviseQbankItems(brief, items, lang, providerId)`：把 brief + 题目 + findings 交给生成引擎，要求只改必要处、保 `id`、保 level，输出同 schema。修完 → 硬校验 → 审稿 v2 → 仍不过再来，`QBANK_REVISE_MAX = 2`。耗尽 → 写 `data/qbank-review/drafts/<skillId>.<lang>.json`（题 + 全部 findings + 轮次），**不进 `qbank.json`、不进导出包**。修复只针对有 findings 的题，pass 的题一个字不动。

**编排** `reviewQbankBatch({ brief, batch, lang, genProv, judgeProv, mode, dry })` → `{ accepted, rejected, records }`，被两处调用：
- `ensureQuizBank`：新增可选参数 `review`（`{ judgeProv, genProv }`），给了就走 v2；不给保持现状（zh 和老调用方 byte-for-byte 不变）。
- `audit_qbank.mjs --review v2`：对存量题库逐题过；耗尽的题从 `qbank.json` 移到 drafts（现在的行为就是剔除+记录，只是多了修复轮和留档）。

新任务名进 `TASKS`：`revise:quiz`、`audit:quiz`（后者账本里已在用，只是没进路由白名单）。

---

## 3. 任务清单（按顺序做，每步有验收）

### P0 · 准备（半小时）

- `git switch dev`；确认 8434 实例**没在跑**（在跑先停：它退出时会把内存快照写回 `qbank.json`）。
- 备份 `cp qbank.json build/issue8-work/qbank.backup.json`（`build/` 已 gitignore）。
- Claude CLI：`server.js` 跑的是 `~/.local/bin/claude.exe`（不是 shell 里的 npm shim），先 `~/.local/bin/claude.exe update`；`config.json` 的 `claude.timeoutMs=1500000` 保留。
- 读一遍 `docs/qbank-standard.md` §2/§7、`data/curriculum/visual-contract.json` 的 `capabilities.questionVisual`。

### P1 · TeachingBrief（`server.js`）

- 加 `QBANK_RULES_VERSION = "2026-09-12"`、`teachingBrief()`、`briefHash()`、`briefForGenerator()`、`briefForJudge()`；全部导出。
- `notYet` 的两条来源都要实现（后继技能 + 同主题靠后的技能），去重。
- 课文哈希用文件原文 sha1（不是 JSON.stringify 后），路径写相对仓库根。
- **验收**：`node -e` 打印三个试点技能的 brief：`visual.allowed` 分别是 `[fractionBar, pie]` / `[statLine]` / `[]`；`lessonMissing` 全 false；把 `data/lessons/en/YY.MATH.FRAC.EQUIV.VISUAL.json` 改一个字符后 `briefHash` 变、改回来恢复。

### P2 · 题图贯穿 + 硬校验（`server.js`）

- `require("./public/visual-check.js")` 进 `server.js`（放 `VISUAL_CONTRACT` 旁边；读不到契约时 visual 校验跳过并 warn，和现有降级口径一致）。
- 改 `QBANK_SCHEMA` / `QBANK_HINT_SKILL.en` / `qbankPrompt` en 分支 / `validateQbankBatch`（§2.2）；加 `qbankHardChecks`（§2.3）。
- `qbankMerge`：确认预发 qid 能保住；`QBANK_CONTENT_FIELDS` 已含 `visual`，不用动。
- **zh 快照测试**：改之前先把 `qbankPrompt(item, data, "zh", {1:4,2:4,3:4}, [])` 对三个试点技能的输出存成 `tools/test/fixtures/zh-prompt.<id>.txt`，改完后逐字节相等。
- **验收**：`node --check server.js`；`node tools/test/qbank_pipeline_test.mjs`（P5 建）中 P2 相关用例全过。

### P3 · 审稿 v2 + 修复轮 + 编排（`server.js`）

- `JUDGE_SCHEMA_V2` / `JUDGE_HINT_QUIZ_V2.en` / `judgeQuizPromptV2` / `validateJudgeV2` / `reviseQbankItems` / `reviewQbankBatch`（§2.4、§2.5）。
- `ensureQuizBank` 加 `review` 参数；旧路径不动（用 P2 的 zh 快照 + 一个 en 老路径桩引擎用例保证）。
- 报告写入 `data/qbank-review/`；`.gitignore` 加 `data/qbank-review/`。
- **验收**：桩引擎（`S.ADAPTERS.stub = async () => 固定 JSON`，`detected.stub = {available:true}`，用 `S.PROVIDER_META` 补一条）跑通「生成 → 硬校验 → 审 → 修 → 复审 → 入库」，报告行字段齐全；`dry:true` 的记录跑第二遍不被当成已通过。

### P4 · 工具接线

- `tools/pregen.mjs`：加 `--ids a,b,c`（按技能/条目 id 过滤 jobs，试点必需）、`--review v2`（只对 en 生效；zh 即使带了也走 v1 并打印一行说明）。
- `tools/audit_qbank.mjs`：加 `--review v2`（输入保留 qid/tags/visual，逐题 reviewKey 跳过，修复轮，drafts 留档）；`--dry` 下报告行 `dry:true` 且不写 `qbank.json`；老的 `--judge` v1 路径保留。
- `tools/curriculum/visual_check.mjs --qbank`：保持不变（它是导出侧 preflight，继续跑）。
- **验收**：`node tools/pregen.mjs --only quiz --langs en --ids YY.MATH.FRAC.EQUIV.VISUAL --review v2 --dry` 列出 1 组；`node tools/audit_qbank.mjs --prefix YY.MATH.FRAC.EQUIV.VISUAL --review v2 --dry --judge claude` 跑 1 份并落报告。

### P5 · 回归测试（`tools/test/qbank_pipeline_test.mjs`，纯 node，`node:assert`，不调引擎）

issue 要求的六个回归样例各一条 fixture，走硬校验 / 审稿 v2 解析 / reviewKey 三层：

| # | 样例 | 期望 |
|---|---|---|
| 1 | 题干「the line graph below」但无 visual | 硬校验 `visual_missing` → revise |
| 2 | statLine nums 合法但题干说「each square is 6 mm」而 step=4 | 硬校验放行；审稿 v2 fixture 返回 `visual_semantics: fail` → status revise；`bad` 推导正确 |
| 3 | tag 是在册 id 但和干扰项内容不符 | 硬校验放行（只查在册）；审稿 fixture `distractor_tags: fail` → revise |
| 4 | 两个选项都对 / 答案错 | 审稿 fixture `answer_unique: fail`；`needs-human` 也要能表达 |
| 5 | 考了 `notYet` 里的技能 | 审稿 fixture `on_skill: fail` |
| 6 | 已通过的题改一个字 / 改课文 / 升 rulesVersion | reviewKey 三种情况都变，续跑不跳过；`dry:true` 记录不算通过 |
| + | 老路径不变 | zh 提示词快照逐字节相等；`ensureQuizBank` 不带 `review` 时行为同前（桩引擎） |
| + | 带 visual/tags 的题走完 validate → merge → export | `qbankMerge` 保 qid、`visual` 原样；`export_apple --dry` 的题目对象含 `visual`、含 `tags`、不含 `usedAt` |

跑法：`node tools/test/qbank_pipeline_test.mjs`，全过退出 0。写脚本用 Write 工具落盘再 `node` 跑（这台机器 Bash 工具会把 `\\` 折成 `\`，heredoc 里的正则会坏）。

### P6 · 试点 + 对照实验（§4）

### P7 · 合入、导出、回帖（§5）

---

## 4. 试点与对照实验

**目标**：同技能、同产出量、同引擎配置下，比较「现有 `--judge`（A）」和「新管线（B）」；保存人工最终确认的剩余错误、误报、修改量、调用量、耗时。**不能只报模型自评或 JSON 通过率。**

**隔离**：`YY_DATA_DIR=build/issue8-work/armA`（和 `armB`）。首次加载会把根目录 `qbank.json` 迁移拷贝进去；然后用脚本把三个 key（`…|en`）的 `questions` 清空，让 `ensureQuizBank` 每级要 4 道、共 12 道/技能。账本 `usage.jsonl` 也在各自目录，调用量/耗时直接从里面汇总（任务名 `pregen:quiz` / `judge:quiz` / `revise:quiz`）。

**引擎**：两臂都用 `--provider claude --judge claude`（现有 YY 题库就是 Opus 5 high 生成 + Claude 审，manifest 写着）。config 里 `pregen:quiz` 路由到 ollama 是跑批省钱用的，试点不用它（qwen 的截断/粘引号问题会污染对照）。

```
# A：现状
YY_DATA_DIR=build/issue8-work/armA node tools/pregen.mjs --only quiz --langs en --ids <3 ids> --provider claude --judge claude --concurrency 1
# B：新管线
YY_DATA_DIR=build/issue8-work/armB node tools/pregen.mjs --only quiz --langs en --ids <3 ids> --provider claude --judge claude --review v2 --concurrency 1
```

**C 臂（回归样例真机跑）**：拷一份 armB 的 qbank，往三个题库各注入 2 道手工构造的坏题（覆盖 §3 P5 的 1–5 号样例，qid 以 `qbad-` 开头），跑 `audit_qbank.mjs --review v2 --dry`，逐条记录审稿有没有抓到、类别对不对。**没抓到的如实写**。

**人工终审**（Opus 逐题审，用户最终确认）：A、B 各 36 道全部过一遍，表头固定：

| 技能 | 臂 | qid | 级 | 人工结论（对/错/可疑） | 错误类别 | 审稿说了什么 | 是否误报 | 改了几处 |

汇总表：每臂「剩余错误数 / 误报数 / 修改题数 / 引擎调用数 / token 进出 / 总耗时」。**未跑的项写「未跑」。**

**真实网页版检查**：B 臂人工确认后的题合入真 `qbank.json`（见 §5），重启 8434，进这三个技能闯关，看作答态（不印数值、按 step 打格）和讲评态图形；`build/issue5-work/render-harness.mjs` 能离线把 visual 画成 SVG 存 gallery，先用它扫一遍再上浏览器。

---

## 5. 合入、导出、交付

1. **合入**：只把 B 臂人工确认通过的题按 qid 合进根目录 `qbank.json`（现有每级 4 道，加 4 道后 8 ≤ 12 上限）；A 臂的题不合入，留在 armA 作对照存档。合入前 8434 必须停着。
2. **校验链**：`node tools/curriculum/visual_check.mjs --qbank` 零违约 → `node tools/curriculum/skills_check.mjs` 不变（369 技能 / 600 边 / 340 误区）→ `node tools/test/qbank_pipeline_test.mjs` 全过 → `node --check server.js`。
3. **导出**：`node tools/export_apple.mjs`（**不带 `--no-voice`**）→ 拷 `build/apple-export/{qbank,manifest.json}` 到 `content/`；`git diff --stat content/` 只应动三个 by-skill/en 文件 + manifest。demo 只装 BC 老条目库，YY 不用刷。
4. **文档**：`docs/qbank-standard.md` 加 §8「生成链题图与审稿 v2」（brief、硬校验表、报告格式、失效规则）；本文件 §0 状态行更新；`docs/qbank-pipeline-pilot-2026-09.md` 放 §4 的两张表 + C 臂结果 + 测试命令与输出。
5. **提交**：分两笔——代码（server.js / pregen / audit / test / gitignore / docs）和内容（qbank.json / content/）。commit 说明写「回应 issue #8」。push dev。
6. **回帖**（`gh issue comment 8 -F -`，按对方「必须改 / 想要但不阻塞 / 只是知会」三档逐条对应）：commit、变化的 qid 与技能清单、测试命令及结果、`content/` diff、试点对照表、C 臂命中率；说明**没改任何课文 `say`**，语音哈希与语音产物无变化；`tags` 仍不下发、`visual` 沿用契约 v3；报告不在 `content/` 里。关单由 app 端。回帖前确认本地 dev 没有未 push 的 commit。

---

## 6. 第二阶段（想要但不阻塞，本计划不排期）

拿到 §4 的数据后再决定做不做。形态是 **`pregen` 的独立阶段**，不是常驻 Agent：

- `--stage brief`：只算 brief 落盘（`data/qbank-review/briefs/`），维护者可在 `objectives.goal` 等草稿字段上改，改完 `briefHash` 变；
- `--stage author`：按 brief 出题；缺课文才另起「课文作者」阶段（会改 `say` → 触发语音补烘，要单独排期）；
- `--stage review` / `--stage revise`：就是 P3 的两个函数；
- 资料检索只在缺课程依据时按需做并记来源；不接任何孩子在线搜索。

对照口径和 §4 一样：同技能、同数量、同引擎，比剩余错误/误报/调用量。「多 Agent」本身不是完成标准。

---

## 7. 边界与坑（做之前读一遍）

- **分支**：只在 `dev`；`main` 冻结只喂 Vercel demo。
- **zh 冻结**：提示词、hint、审稿 zh 文本一个字不动；代码路径共用的地方用快照测试兜。
- **8434 实例**：改 `qbank.json` 前停掉、改完重启，否则被内存快照盖回。
- **Bash 工具反斜杠折叠**：含正则/模板串的脚本用 Write 落盘再 `node` 跑；`$TMP` 不是 scratchpad。
- **导出**：`export_apple` 别带 `--no-voice` 再拷 manifest（`files` / `voice.files` 会被压低，#3 时踩过）。
- **课文不动**：第一阶段不改任何 `data/lessons/`，避免语音补烘；issue #7 那步已改过（`9655b28`）。
- **Apple 侧**：`tags` 永远不下发；`pictograph` 对方还没画（契约 `apple:false`），出现在新题里合法但要在回帖里点一句；新报告格式不进 `content/`。
- **Ollama**：若有人后来用 ollama 跑 v2，记得 `format=schema` 已默认关、靠提示词 JSON + `repairJson`；出题开思考 + 32768 上下文。试点不用它。
- **不做**：全库重审/重生成（存量 369 组 en 题库走 `audit --review v2` 是后续批次，不在本 issue 交付里）；不改 `visual-contract.json`（不升 v4）。
