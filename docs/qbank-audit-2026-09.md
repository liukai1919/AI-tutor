# 技能题库存量审计的上游落地（2026-09-01）

iOS 端（AITutor-APPLE）用 `Scripts/qbank-audit.py` 对随包的 234 份 en 技能题库做了一轮反向抽查，
判决见他们的《存量技能题库审计（2026-09-01）》。结论：配方（L1 热身 → L2 换情境 → L3 错误分析 / 两步应用）
本身是对的，但有两条系统性的病：**L3 错误分析题靠「选最长的」能蒙对**，**回补链路对六成错误答案是哑的**。
这些都归上游（本仓库的 `qbank.json` → `content/qbank/`），本文记录上游做了什么、量化前后、还剩什么。

## 做了什么

| 审计发现 | 上游动作 | 范围 |
|---|---|---|
| 一（P1）错误分析题正确项最长 | 选项配平：正确项删短、干扰项补「因为……」理由，答案/错数/tags 不动；错误分析题的答案位置全局打散 | en 243 + zh 290 道 L3（所有「正确项唯一最长且超出 10%」的题）；位置打散 44 道 |
| 二（P1）54 份库没有 tags | 给 54 个 `misc[]` 为空的技能登记误区（沿用登记表旧 id 优先，新增 108 条），两种语言 1298 道题逐干扰项打 tags | 54 技能 × 2 语言 |
| 规则前置 | `docs/qbank-standard.md` §2 加「不许靠长度露馅」；`qbankPrompt` en/zh 铁律各加一条；`judgeCommon` 审稿加第 4 项 | 生成侧 + 审稿侧 |
| 四（P2）`ALG.EQ.ONE_STEP.MULTDIV` 难度倒挂 | 天平题下沉 L2、裸算式上浮 L1，en 补 2 道 L1 符号题；zh 同样倒挂，一并对调 | 2 份库 |
| 五（P3）`apply` 库里的裸算式 | 6 道题干改成情境（数字、选项、答案、tags 不动） | TWOSTEP.WORD / ORDER_OPS.WRITE_EXPR / INT.WORD |

近义新 id 已合并（`est.truncate_not_round → est.truncate_decimal`、`word.stop_after_first_step / word.multistep_incomplete → word.stop_early`、
`pat.term_count_off → pat.term_count_off_by_one` 等 11 组），登记表 120 → 228 条，`skills_check` 通过。

## 量化前后（`content/qbank/by-skill/`，同一套信号脚本）

| 信号 | en 前 | en 后 | zh 前 | zh 后 |
|---|---|---|---|---|
| 错误分析题里正确项唯一最长 | 67% | **15%** | 82% | **33%** |
| 其余 L3 里正确项唯一最长 | 20% | **7%** | 30% | **14%** |
| 错误分析题答案在第一位 | 39% | **25%** | 32% | **25%** |
| 干扰项挂真实误区 id | 39.5% | **52%** | 42% | **54%** |
| 完全没有 tags 的库 | 54 | **0** | 54 | **0** |

剩下的「正确项最长」都在 4 个字符 / 10% 的容差内（配平规则允许），不再构成可用的猜题线索。

## 还没做的

- **发现三（一库一诊断）**：180 份原本有 tags 的库里，49% 的 `other` 没有回填——那要给这些技能再登记更多误区，本轮只做了 54 个空技能。
- 配平只动了 L3。L1/L2 不决定通关，没查。
- 本轮改动只到 `content/`（git 分发通道），**没有发新的 content Release**；语音不受影响（闯关题无语音）。
- 这些题都是「改写」而不是「重出」，没过审稿引擎；抽读了 30 道（含全部 22 条脚本警告），改写没有引入数学错误。

## 复现

审计信号脚本随本仓库没有落地（iOS 端的 `qbank-audit.py` 是判决来源）；本轮用的等价 Node 版信号、配平/打标签的输入包、合并脚本都在会话 scratchpad，
关键校验点（4 个选项、答案不动、正确项不最长、tags 落在技能 `misc[]` 内）已写进 `docs/qbank-standard.md`，新出的题由提示词和审稿两道关把住。

## 追加：iOS 端「上游落地清单（2026-09-01）」的处理

| 清单项 | 处理 |
|---|---|
| 批次一：11 份拓展技能题库（en） | Apple 仓库的草稿没推到 GitHub，走清单的第二条路：去掉 `--core` 用 Claude 生成 + 审稿补跑（`pregen --skills --only quiz --langs en --provider claude --judge claude`），11 份全成、审稿拒 1 题后自动补齐。en 题库 234 → **245/245**；zh 按冻结维持 234。`core` 一个都没动。 |
| §5.2 六条新误区 | 已登记 `solid.fev_swap`、`solid.count_visible_only`、`unit.ml_l_factor`、`unit.convert_wrong_direction`、`graph.series_in_circle`、`circle.r_squared_as_r`（登记表 228 → 234）；`sq.*` 四条随 §5.1 一起决定，未登记。 |
| §5.3 八个节点的 `misc[]` | 按表回填，另给 FEV / VOL.REFERENTS / TIME.UNITS 挂上新误区，**在生成前**落好，所以 11 份新题库的 tags 直接对着登记误区出（真实 id 占干扰项 13/36 ～ 34/36）。 |
| 批次二 3.2 节点标题 | `FLU.MULT.3D_BY_1D` en/zh 标题已改成「标准竖式」版；`rep/misc/prereq/hints` 未动。 |
| 批次二 3.3 八条先修边 | 全部追加，`skills_check` 无环通过。 |
| 批次二 3.1 课文替换 | **未做**：新课文只在 Apple 仓库本地，上游拿不到。文件到位后整份替换 `data/lessons/en/YY.MATH.FLU.MULT.3D_BY_1D.json`，再 `prevoice --langs en` 补烘。 |
| 批次三 平方数 | 等 §5.1 拍板。 |
| §5.4 / §5.5 | 本文上半部分已做完（配平 533 道、54 技能登记 108 条误区并回填）。 |
