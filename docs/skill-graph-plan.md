# 课程目录 v2 · 技能图谱（Skill Graph v1）设计

> 一句话：把「一条 BC 大纲条目 = 一个入口 = 一节课 = 一个题库 = 一个掌握状态」拆成 **年级 → 主题 → 技能** 三层。
> BC 条目退到「对齐层」，**技能**才是教、练、诊、记的最小单位。
>
> 状态（2026-08-22）：设计 + 数据草稿 + **已接进运行链路**（§7 阶段 0-1 全部完成）。
> App 里选年级下拉的「🧩 G4-G7 技能图谱（草稿）」就能看；讲课、闯关、主题测试、进度、报告、误区回补都跑通了。
> 技能题库已全量生成（§7 阶段 2，468 份；2026-09-02 补齐 en/zh 各 249 份）。**2026-09-02 阶段 3 起步：G8 技能文件 `g8.json` 落地**（14 主题 / 71 技能 / 60 条新误区），微课 · 题库 · 主题卷用 `pregen --grades skills-g8 --provider claude --judge claude` 生成。**2026-09-02 起默认随包发布**：`pack.mjs` 默认拷 `skills/` 和 `YY.*` 种子题库，`--no-skills` 才不带。
> 校验：`node tools/curriculum/skills_check.mjs`（加 `--md` 打印本文第 4 节的目录树）。
> 前置文档：[bc-curriculum-plan.md](bc-curriculum-plan.md)（P1–P6 现状）、[qbank-standard.md](qbank-standard.md)（闯关规则，本设计沿用）。

---

## 0. 结论先行

| | 现状 | v2 草稿 |
|---|---|---|
| G4–G7 可学的「点」 | 69 条 BC 条目 | **245 个技能**，归入 **54 个主题**（2026-09-02 加 G8、2026-09-03 加 G9：全图 **369 技能 / 77 主题**，见 §4） |
| 每条 BC 条目 | = 1 个点 | 对应 1–8 个技能（均值 3.6） |
| 导航分组 | 五大主线（固定） | 主题（每年级 11–17 个，按教学顺序） |
| 先修关系 | 无 | 365 条边（120 条跨年级）；含 G8/G9 后 600 条（228 条跨年级） |
| 误区 | 藏在题目 `explain` 文本里 | 228 条登记在册（2026-09-01 补 108 条，245 技能全部 ≥1 条；2026-09-02 加 G8 的 60 条 → 298 条；2026-09-03 加 G9 的 42 条 → 340 条），技能引用、干扰项逐个打标签 |
| 诊断 | 无 | 23 条试点技能带 `diag`（入口题 + 误区→回补分支） |

颗粒度定在哪：**每年级 50–70 个技能、每条标准 3–4 个**。一个圆圆技能 ≈ IXL 的一条「表示阶梯」（模型 → 数轴 → 符号 → 应用，IXL 切成 2–3 个 skill），阶梯放在技能内部由现有的 L1/L2/L3 三级难度承担（§3.3）。这样既比现状细 3.5 倍，又不把内容生成成本乘到 IXL 那个量级（IXL 每年级 358–458 个 skill）。

先做什么：三个试点标准（G5 等值分数、G6 因数倍数、G7 分数/小数/比/百分数，共 23 个技能）已把节点写全（先修、误区、诊断分支），可以直接进入 §7 的阶段 1。

---

## 1. 现状盘点（本仓库，不是 Apple 版报告里的那份）

报告分析的是 `AITutor-APPLE`（69 条、Swift）。本仓库多出来的东西决定了方案细节：

- **三种来源一个形状**。`server.js:1711` 的 `curriculum` Map 同时装 BC 年级（`grade-N.json`，G4–G9 共 91 条）、高中分科课（`course-*.json`，FMP10/PC11/PC12 共 26 条）、AoPS 书（`books/*.json`，4 本）。它们都是 `{ strandDefs?, bigIdeas, items[] }`，`strandGroups()`（`server.js:1914`）按 `strandDefs`（没有就用五大主线 `STRANDS`）分组。**书籍已经证明：任意「单元 → 条目」结构能零改动跑通讲课、闯关、单元测试、进度、报告**——这是 v2 最省力的落地路径。
- **一切挂在条目 id 上**：讲课包 `data/lessons/<lang>/<id>.json`（117 × 2 节）、题库 `qbank.json` 的 key `<id>|<lang>`（236 份）、进度 `data/kids/<kid>/progress.json[id]`、单元卷 / FSA 每题的 `curriculumId`。
- **teach 提示词**（`systemPromptTeach`，`server.js:379`）吃 `en / zh / elaborations / terms / teachHints / bigIdea`。技能层只要提供同名字段就能复用。
- **掌握度**（`progressLevel`，`server.js:1871`）：`emerging → developing → proficient → extending`，证据 = `taught / right / wrong / rightDays / quizPassedAt / solid(家长星标)`。
- **优点，全部保留**：BC 官方原文与来源、`curriculumId` 稳定主键、中英分文件存、确定性判分、离线题库、四级话术、按孩子分桶。

核心不足就是报告说的那一条：`BC.MATH.G5.NUM.03 等值分数` 一条同时是课程入口、一节课、一个 12 题题库、一个 mastery 状态。孩子会画图不会用乘除，系统只能把整条判成一个等级。

顺手发现的数据缺口：`grade-5.json` 有 4 条 `elaborations` 为空（NUM.02 小数到千分位、NUM.03 等值分数、PAT.01 规律法则、GEO.01 面积），而「Two equivalent fractions are two ways to represent the same amount」这条等值分数的官方注释出现在了 NUM.04 下面——疑似解析时串行，建议对着官网核一遍（技能拆分时我按官网原文补的）。

---

## 2. 竞品怎么切（2026-08-22 实测数据）

| | 层级 | 每年级数量（G4/G5/G6/G7） | 技能命名 | 掌握模型 | 先修 / 诊断 | BC 对齐 |
|---|---|---|---|---|---|---|
| **IXL**（ca.ixl.com） | 类别 → skill（平铺，36–54 个类别） | **408 / 458 / 376 / 358** 个 skill | 动词开头 + 表示/范围后缀：「Find equivalent fractions **using area models**」「…**up to thousandths**」；裸标题 = 符号级 | SmartScore 0–100：80 熟练、90 优秀、100 精通；连对涨连错跌 | Real-Time Diagnostic，4 条 strand，首测 45–60 题，每周 5–10 题维持 | 有 BC 对照页，但只有 **31–40%** 的 skill 映射到 BC 标准（G5：458 个里 161 个）；G5 每条标准平均 **8.5** 个 skill（中位 7，1–32） |
| **Khan Academy** | 课程 → 单元 → 课 → 练习（+ quiz / unit test / course challenge） | 单元 14/16/12/9；练习 **154 / 130 / 148 / 119** | 动词 + 对象 + 括号表示：「Equivalent fractions **(fraction models)**」「**Visually** compare fractions」 | 5 级：Attempted / Familiar / Proficient / Mastered；练习最高到 Proficient，**Mastered 只能靠混合测验**，会降级 | 无显式先修图；「Get ready for G5」= 把 G3/G4 练习按 G5 单元名重新打包 | 无（只有一门 2005 版安省 G7） |
| **Math Academy** | 课程 → 单元 → 模块 → **topic**（图谱节点） | topic **140 / 133 / 157 / 170** | 动名词短语，按情形细切：「Three- and Four-Digit by One-Digit Multiplication」 | FIRe：每 topic 记重复次数 + 记忆强度，间隔复习，高阶通过给低阶「隐式学分」 | 手工编码先修图，**每 topic 约 5 条先修边**带权重；诊断找「knowledge frontier」 | 无（CCSS） |
| **Mathspace** | 教材 → 章 → 小节（Lesson / Practice / Outcomes 三个 tab） | 安省 G7：15 章；小节每章 3–10 | 名词短语 + 罗马数字续集：「Comparing fractions I / II」 | Developing / Proficient / Mastered | Skills Check-in：技能节点 = 大纲 outcome code，贝叶斯 IRT 推断；2 题迷你复测 | **没有 BC 教材**（只有安省 3–12），Check-in 不支持任何加拿大大纲 |
| **圆圆 现状** | 年级 → 主线 → 条目 | 条目 18 / 19 / 19 / 13 | BC 原文 | 四级（BC 官方话术） | 无 | 100%（条目就是标准） |
| **圆圆 v2 草稿** | 年级 → 主题 → 技能 | 主题 12/14/17/11；技能 **57 / 67 / 71 / 50** | 动词 + 对象 + 表示/范围（§3.2） | 四级不变 + 标准级汇总（§6） | 365 条先修边；23 条试点技能带诊断分支 | 每个技能 `primary` + `supporting` 标准，多对多 |

从这张表得到的七条判断：

1. **导航层是「主题/单元」，不是「主线」**。四家都是每年级 9–22 个主题；没有人让用户在 5 个大类下面翻几十条。BC 五大主线保留给家长报告和 FSA。
2. **技能命名有公式**：动词 + 对象 + 表示/范围限定。表示（模型 / 数轴 / 符号 / 应用题）要么进名字，要么进元数据。
3. **表示阶梯是公认结构**：IXL 每个类别内部固定「model → number line → symbolic → word problems」；Khan 每个概念 2–4 个练习按「visual → numeric → word problems」排。我们的 L1/L2/L3 正好对上，不必再切成 3 个技能。
4. **掌握度多级、可降级、最高级要靠混合测验**。Khan 的 Mastered 只能通过 quiz / unit test；我们「不同日期答对 ≥2 次」「闯关通关只到 Proficient、单元卷再往上攒」这套是对的，技能层照用。
5. **先修图是 Math Academy 的核心资产**（每 topic 5 边，手工编码）。我们草稿 1.5 边/技能是起点，试点三条标准上密一些（2–3 边）。
6. **理财**：Mathspace 独立成章，IXL 独立类别，Khan / Math Academy 根本没有。BC 官方就有理财条目，做成可见学习域是现成的差异点。
7. **BC 仍然是空的**：Mathspace 没 BC、Khan 没 BC、IXL 有 BC 对照但六成以上的内容游离在外。「按 BC 切 + 中英双语 + AI 讲课」依旧无人做，v2 不改这个定位。

---

## 3. 新结构

```text
年级 Grade（BC 4–7，之后 8–12）              ← 导航第 1 层：沿用现有下拉
└── 主题 Topic（每年级 11–17 个，按教学顺序）   ← 导航第 2 层：取代五大主线做分组
    │                                            📝 单元测试挂这里（现有 unit-test 按 strand 出卷，改成按 topic）
    └── 技能 Skill（每主题 3–8 个）              ← 教 / 练 / 诊 / 记的最小单位
                                                 ⚡ 闯关、micro-lesson、误区标签、先修边都挂这里

BC 标准 Standard（69 条，id 不变）             ← 不再是导航层，而是对齐层：skill.primary / skill.supporting
主线 Strand（5 条）                             ← 标准的官方分组；只在家长报告、FSA、单元卷配比里出现
理财 Financial literacy                        ← 主题上打 domain:"financial-literacy"，界面可见，底层仍归 number 主线
```

两棵树，一套节点：**教学树**（年级 → 主题 → 技能）给孩子导航；**官方树**（年级 → 主线 → 标准）给家长报告。技能同时长在两棵树上，靠 `primary / supporting` 连接。

### 3.1 与 Apple 版报告方案的四点不同

| 报告建议 | 本设计 | 为什么 |
|---|---|---|
| Grade → Domain → **BC Standard → Topic** → Skill，五层 | Grade → Topic → Skill 三层，标准是技能的属性 | 主题天然跨标准：G5「小数到千分位」= NUM.02 + FLU.03，G7「线性关系」= PAT.01 + GEO.03（坐标）。把 Topic 塞在 Standard 下面会把同一主题切成两半；四家竞品的导航也都是主题，不是标准。Domain 变成主题上的标签（`strand` + `domain`），不单独成层 |
| 每个技能维护 7 个证据维度（recognition / representation / procedure / reasoning / application / retention / misconceptions） | 前 5 个维度变成**技能类型** `type`（一个技能只测一种能力）；retention 沿用 `rightDays`；misconceptions 用标签 | 维度 × 技能会把题库成本乘 5。IXL / Khan 也是用「表示 / 认知前缀」把能力切成不同 skill，而不是在 skill 内部分维度。证据模型因此可以原封不动沿用 `progress` |
| 新建 `knowledge-graph/` 目录：`nodes/` 按领域分文件 + `alignments/` + 6 个注册表 | `skills/g<N>.json` 每年级一个文件（主题 + 技能同文件）+ 唯一的注册表 `misconceptions.json`；对齐写在节点里 | 和现有 `grade-N.json` / 加载器 / pregen / pack 的形状一致。跨年级共用的技能用 `topic.review` 引用，不复制 |
| skill id 不含年级；一个 skill 可挂多个年级 | 同意并落地；但「一个技能多年级」只给**完全相同**的技能（目前仅 1 例：基准分数比较 G4 → G5 review） | BC 把乘法口诀分 4 年写（introductory / emerging / developing / extending），题库内容真的不同，拆成 4 个阶段技能 + 先修链更诚实 |

其余（保留 `curriculumId`、保留原文与来源、`starred` 降级为家长 override、误区结构化、分阶段迁移、试点三条标准）全部采纳。

### 3.2 ID 与命名

```text
官方标准（不变）  BC.MATH.G5.NUM.03
圆圆技能          YY.MATH.<FAMILY>.<TOPIC>.<SKILL>     例：YY.MATH.FRAC.EQUIV.MULTIPLY
                  文法 ^YY\.MATH\.[A-Z0-9]+(\.[A-Z0-9_]+){1,3}$，不含年级，发布后不改
FAMILY            NUM 整数与位值 · DEC 小数 · FRAC 分数 · RATIO 比 · PCT 百分数 · REL 表示互化 · INT 负数
                  FLU 运算 · PAT 规律 · ALG 方程 · GEO 图形 · MEAS 测量 · DATA 统计 · PROB 可能性 · FIN 理财
主题 id           文件内唯一的 slug（equivalent-fractions），格式同书籍的 strandDefs，加载器可直接当分组用
```

标题公式（中英都是）：**动词 + 对象 + 表示/范围限定**。

- `用乘法生成等值分数` / `Generate equivalent fractions by multiplying the numerator and denominator by the same number`
- `在数轴上看到等值分数落在同一个点` / `Show that equivalent fractions land on the same point of a number line`
- 范围写进标题而不是另开技能：`小数加减到千分位：对齐小数点，缺位补 0`

### 3.3 一个技能 = 一条表示阶梯

IXL 把「等值分数」切成 5 个 skill（area models → number lines → symbolic → patterns → lowest terms）。我们切成 7 个技能，但每个技能内部仍然是一条阶梯，由 [qbank-standard.md](qbank-standard.md) 的三级承担：

| 级 | 对齐 | 在技能里的含义 | `rep` 字段怎么用 |
|---|---|---|---|
| L1 热身 | Developing | 用 `rep[0]`（通常是模型）直接套概念 | 出题提示词：L1 题必须带这个表示 |
| L2 应用 | Proficient | 符号级 / 标准课本题 | `rep` 里的 symbolic |
| L3 挑战 | Extending | 情境题，或针对 `misc[]` 里误区的辨析题 | 干扰项逐个对应 `misc[]` 的 id |

所以 `rep` 不是装饰：它规定这个技能的题库要走过哪几种表示，`misc` 规定 L3 的辨析题要打谁。

### 3.4 技能节点 schema（`yy-skills/1`）

```jsonc
{
  "id": "YY.MATH.FRAC.EQUIV.MULTIPLY",
  "topic": "equivalent-fractions",            // 本文件 topics[] 里的 id
  "type": "procedure",                         // concept | represent | procedure | reason | apply | fluency
  "rep": ["symbolic", "fractionBar"],          // 表示阶梯；第一项是 L1 用的
  "en": "Generate equivalent fractions by multiplying the numerator and denominator by the same number",
  "zh": "分子分母同乘一个数，生成等值分数",
  "primary": "BC.MATH.G5.NUM.03",              // 主归属标准（进度汇总、报告都按它）
  "supporting": [],                            // 还服务于哪些标准（多对多）
  "prereq": ["YY.MATH.FRAC.EQUIV.VISUAL", "YY.MATH.FLU.MULT.FACTS.EMERGING"],
  "core": true,                                // 缺省 true；false = 拓展技能，不参与标准级汇总
  "misc": ["frac.add_same_number", "frac.multiply_one_part"],   // misconceptions.json 里的 id
  "hints": "fractionBar",                      // 配图提示，沿用 teachHints 词表（校验器会查）
  "diag": {                                    // 试点技能才有
    "entry": [{ "level": 1, "rep": "fractionBar" }, { "level": 2, "rep": "symbolic" }],
    "branch": { "frac.add_same_number": "YY.MATH.FRAC.EQUIV.VISUAL",
                "frac.multiply_one_part": "YY.MATH.FRAC.EQUIV.SAME_WHOLE",
                "mult.fact_error": "YY.MATH.FLU.MULT.FACTS.EMERGING" }
  }
}
```

主题：`{ id, zh, en, strand, domain?, standards[], review?[], pilot? }`。`review` 引用更低年级的技能（本主题要复习它，但不重复定义）。

`terms` 没有单独放在技能上：默认继承 `primary` 标准的 `terms`，需要时再加。`elaborations` 不进技能（它是标准的注释，技能标题本身就是从它派生的）。

六种 `type` 的分布（G4–G7 合计）：概念 44、表示 24、步骤 97、推理 30、应用 40、熟练 10。步骤多是正常的——BC 4–7 年级本来就是算法年级。

### 3.5 误区登记表（`misconceptions.json`）

120 条，每条 `{ id, zh, en, pattern, remedy }`。`pattern` 是出题和判卷时识别它的线索（「2/3 = 3/4」），`remedy` 是稳定出现时该回补的技能；技能自己的 `diag.branch` 可以覆盖 `remedy`。例：

| id | 错法 | 线索 | 回补 |
|---|---|---|---|
| `frac.add_same_number` | 分子分母同加一个数当等值 | 2/3 = 3/4 | `FRAC.EQUIV.VISUAL` |
| `dec.longer_is_bigger` | 小数位数越多越大 | 0.25 > 0.3 | `DEC.PV100.COMPARE` |
| `pct.of_vs_off` | 折扣额和折后价混淆 | $40 打 8 折答 $8 | `PCT.DISCOUNT` |
| `time.base_100` | 时间当 100 进制 | 1 小时 50 分 + 20 分 = 1 小时 70 分 | `MEAS.TIME.ELAPSED.CROSS_HOUR` |
| `gcf_lcm.confuse` | 最大公因数和最小公倍数搞反 | GCF(4,6) = 12 | `NUM.FACTORS.LIST` |

---

## 4. 完整目录（G4–G9，77 个主题 · 369 个技能）

由 `node tools/curriculum/skills_check.mjs --md` 生成；改了 JSON 重新生成贴回来即可。标注：〔类型〕，拓展 = `core:false`，诊断 = 带 `diag`，↻ = 复习低年级技能。

<!-- TREE:BEGIN（由 skills_check.mjs --md 生成） -->

### G4（12 个主题 · 57 个技能）

**万以内的数 · Numbers to 10 000**　`G4.NUM.01`

- `NUM.PV10K.READ_WRITE` 读写 10 000 以内的数（标准式、展开式、文字） / Read and write numbers to 10 000 in standard, expanded and word form 〔概念〕
- `NUM.PV10K.DIGIT_VALUE` 说出每个数位上数字表示的值（千位到个位） / Give the value of a digit by its place (thousands to ones) 〔概念〕
- `NUM.PV10K.COMPARE_ORDER` 比较和排序 10 000 以内的数 / Compare and order numbers to 10 000 〔步骤〕
- `NUM.PV10K.ROUND_ESTIMATE` 凑整到十、百、千，用基准点估计数量 / Round to the nearest 10, 100 or 1000 and estimate quantities with benchmarks 〔步骤〕
- `NUM.PV10K.COUNT_MULTIPLES` 按 25、100、1000 跳着数（正着数、倒着数） / Skip-count forward and backward by 25s, 100s and 1000s 〔熟练·拓展〕

**万以内的加减法 · Addition & subtraction to 10 000**　`G4.FLU.01` `G4.FLU.04`

- `FLU.ADDSUB.FACTS20` 20 以内加减口算（凑十、翻倍等策略） / Recall addition and subtraction facts to 20 using mental strategies (make ten, doubles) 〔熟练〕
- `FLU.ADDSUB.TO10K.MENTAL` 凑整、补偿、拆分：灵活的加减心算策略 / Add and subtract mentally with friendly numbers, compensating and decomposing 〔步骤〕
- `FLU.ADDSUB.TO10K.ALGORITHM` 万以内竖式加减（进位、退位） / Add and subtract to 10 000 with regrouping (column method) 〔步骤〕
- `FLU.ADDSUB.TO10K.ESTIMATE` 估算和与差，判断答案合不合理 / Estimate sums and differences to check whether an answer is reasonable 〔推理〕
- `FLU.ADDSUB.TO10K.WORD` 一步、两步的加减应用题 / Solve one- and two-step addition and subtraction word problems 〔应用〕

**乘法与除法 · Multiplication & division**　`G4.FLU.05` `G4.FLU.02`

- `FLU.MULT.MEANING` 乘法的意义：几个几、阵列、跳数、连加 / Understand multiplication as equal groups, arrays, skip-counting and repeated addition 〔概念〕
- `FLU.MULT.FACTS.2_5_10` 2、5、10 的乘法口诀（能直接说出） / Recall multiplication facts for 2s, 5s and 10s 〔熟练〕
- `FLU.MULT.FACTS.PATTERNS` 用百数表规律、翻倍减半推出其他乘法口诀 / Use patterns, doubling and halving to work out other multiplication facts 〔步骤〕
- `FLU.DIV.MEANING` 除法的意义：平均分、按份分，以及乘除互逆 / Understand division as sharing and grouping, and as the inverse of multiplication 〔概念〕
- `FLU.MULT.2D3D_BY_1D` 两、三位数乘一位数（拆分、面积模型） / Multiply 2- and 3-digit numbers by 1-digit numbers (decomposing, area model) 〔步骤〕
- `FLU.DIV.2D3D_BY_1D` 两、三位数除以一位数（连减、分段商） / Divide 2- and 3-digit numbers by 1-digit numbers (repeated subtraction, partial quotients) 〔步骤〕
- `FLU.MULTDIV.CHOOSE_OP` 应用题：判断该用乘法还是除法 / Solve word problems by choosing multiplication or division 〔应用〕

**小数（到百分位） · Decimals to hundredths**　`G4.NUM.02` `G4.FLU.03`

- `DEC.PV100.MODEL` 在百格图和十进制积木上表示十分之几、百分之几 / Show tenths and hundredths on grids and base-10 blocks 〔表示〕
- `DEC.PV100.READ_WRITE` 读写小数到百分位，认识十分位和百分位 / Read and write decimals to hundredths and name the tenths and hundredths places 〔概念〕
- `DEC.PV100.FRAC_LINK` 同一个量既写成分数又写成小数（3/10 = 0.3） / Write the same amount as a fraction and a decimal (3/10 = 0.3, 25/100 = 0.25) 〔表示〕
- `DEC.PV100.COMPARE` 比较和排序小数（到百分位） / Compare and order decimals to hundredths 〔步骤〕
- `DEC.ADDSUB.100.MODEL` 用百格图、积木、数轴做小数加减 / Add and subtract decimals with grids, base-10 blocks and number lines 〔表示〕
- `DEC.ADDSUB.100.ALGORITHM` 小数加减竖式：对齐小数点 / Add and subtract decimals to hundredths by lining up the decimal point 〔步骤〕
- `DEC.ADDSUB.100.ESTIMATE` 在真实情境里估算小数的和与差（钱、长度） / Estimate decimal sums and differences in real contexts (money, measurements) 〔推理〕

**分数 · Fractions**　`G4.NUM.03`

- `FRAC.PARTS.EQUAL_PARTITION` 把一个整体平均分；认识分子和分母 / Partition a whole into equal parts; name the numerator and denominator 〔概念〕
- `FRAC.MODELS.REGION_SET_LINEAR` 用面积、集合、线段三种模型表示分数 / Show a fraction of a region, of a set and of a length 〔表示〕
- `FRAC.COMPARE.SAME_DENOM` 比较同分母分数 / Compare fractions with the same denominator 〔步骤〕
- `FRAC.COMPARE.BENCHMARKS` 用 0、1/2、1 做基准估计和比较分数 / Estimate and compare fractions using the benchmarks 0, 1/2 and 1 〔推理〕
- `FRAC.ORDER` 把一组分数排序（同分母或用基准） / Order a set of fractions using common denominators or benchmarks 〔应用〕

**规律与方程 · Patterns & equations**　`G4.PAT.01` `G4.PAT.02` `G4.PAT.03`

- `PAT.INC_DEC.EXTEND` 延续递增、递减的数的规律 / Extend increasing and decreasing number patterns 〔步骤〕
- `PAT.INC_DEC.RULE` 用语言和数字说出规律的法则（从…开始，每次加…） / Describe a pattern rule in words and numbers (start at …, add … each time) 〔概念〕
- `PAT.TABLE_CHART` 把变化的规律填进表格、画成图表，再从表里读规律 / Represent a changing pattern in a table or chart and read it back 〔表示〕
- `ALG.RELATION.QUANTITIES` 描述数量之间的关系（每人几个、每组几个、随时间变化） / Describe how one quantity depends on another (per person, per group, over time) 〔应用〕
- `ALG.EQ.ONE_STEP.MEANING` 把等式看成天平，认识未知数（□ + 4 = 15） / Understand an equation as a balance with an unknown number (□ + 4 = 15) 〔概念〕
- `ALG.EQ.ONE_STEP.ADDSUB` 解一步加减方程（未知数在开头、中间或结果） / Solve one-step addition and subtraction equations (start, change or result unknown) 〔步骤〕
- `ALG.EQ.ONE_STEP.MULTDIV` 解一步乘除方程 / Solve one-step multiplication and division equations 〔步骤〕

**时间 · Time**　`G4.GEO.01`

- `MEAS.TIME.ANALOG.5MIN` 看钟面读到 5 分钟；知道 1 小时 = 60 分钟 / Read an analog clock to the nearest 5 minutes; know 60 minutes make an hour 〔步骤〕
- `MEAS.TIME.ANALOG.MINUTE` 看钟面读到 1 分钟 / Read an analog clock to the nearest minute 〔步骤〕
- `MEAS.TIME.AM_PM_24H` 上午/下午（a.m./p.m.）与 12 时、24 时计时法的换算 / Use a.m./p.m. and convert between 12-hour and 24-hour time 〔概念〕
- `MEAS.TIME.FRACTIONS_OF_HOUR` 用分数说时间：半点、一刻、差一刻 / Say times with fractions of an hour: half past, quarter past, quarter to 〔表示〕

**多边形与对称 · Polygons & symmetry**　`G4.GEO.02` `G4.GEO.04`

- `GEO.POLYGON.IDENTIFY` 认识多边形（封闭、直边），按边数命名 / Identify polygons (closed shapes with straight sides) and name them by number of sides 〔概念〕
- `GEO.POLYGON.REGULAR_IRREGULAR` 按边长和角区分规则多边形与不规则多边形 / Sort regular and irregular polygons by side lengths and angles 〔推理〕
- `GEO.SYMMETRY.IDENTIFY` 找出图形和图案的对称轴 / Find lines of symmetry in shapes and designs 〔概念〕
- `GEO.SYMMETRY.COMPLETE` 在方格纸上补全或创作轴对称图案 / Complete or create a design with line symmetry on a grid 〔步骤〕

**周长 · Perimeter**　`G4.GEO.03`

- `MEAS.PERIM.COUNT` 在方格纸、钉板上数单位长求周长 / Find perimeter by counting units on a grid or geoboard 〔概念〕
- `MEAS.PERIM.CALC` 根据边长计算规则和不规则多边形的周长 / Calculate the perimeter of regular and irregular polygons from side lengths 〔步骤〕
- `MEAS.PERIM.MISSING_SIDE` 已知周长，求缺少的边长 / Find a missing side length when the perimeter is known 〔推理·拓展〕

**统计图 · Bar graphs & pictographs**　`G4.DAT.01`

- `DATA.BAR.ONE_TO_ONE` 读和画一对一的条形图、象形图 / Read and make bar graphs and pictographs where one unit stands for one 〔步骤〕
- `DATA.MANY_TO_ONE` 多对一：一个符号或一格代表 5 个 / Use many-to-one correspondence (one symbol or square stands for 5) 〔概念〕
- `DATA.GRAPH.INTERPRET` 从统计图里回答问题、得出结论 / Answer questions and draw conclusions from a graph 〔应用〕

**可能性 · Probability**　`G4.DAT.02`

- `PROB.LIKELIHOOD` 描述可能性：不可能、不太可能、一样可能、很可能、一定 / Describe likelihood: impossible, unlikely, equally likely, likely, certain 〔概念〕
- `PROB.PREDICT_SINGLE` 根据转盘、骰子、袋子的构成预测一次结果 / Predict the outcome of one spin, roll or draw from the make-up of the spinner, die or bag 〔推理〕
- `PROB.RECORD_TALLY` 做可能性实验，用正字（tally）记录结果 / Run a probability experiment and record results with tallies 〔应用〕

**理财 · Financial literacy**　`G4.NUM.04`

- `FIN.MONEY.NOTATION` 用小数记法读写加元金额（$12.05） / Write and read dollar amounts in decimal notation ($12.05) 〔概念〕
- `FIN.TOTALS_TO_100` 算几样东西的总价（100 元以内） / Calculate the total cost of several items (to $100) 〔步骤〕
- `FIN.CHANGE_TO_100` 100 元以内找零：往上数、拆分 / Make change to $100 by counting up or decomposing 〔步骤〕
- `FIN.DECISIONS` 关于挣钱、花钱、存钱、捐赠的简单决定 / Make simple decisions about earning, spending, saving and giving 〔应用〕

### G5（14 个主题 · 67 个技能）

**百万以内的数 · Numbers to 1 000 000**　`G5.NUM.01`

- `NUM.PV1M.READ_WRITE` 读写 1 000 000 以内的数（标准式、展开式、文字） / Read and write numbers to 1 000 000 in standard, expanded and word form 〔概念〕
- `NUM.PV1M.DIGIT_VALUE` 说出到十万位的位值；10 个低一位等于 1 个高一位 / Give the value of a digit up to the hundred thousands place; 10 of one place make the next 〔概念〕
- `NUM.PV1M.COMPARE_ORDER` 比较和排序 1 000 000 以内的数 / Compare and order numbers to 1 000 000 〔步骤〕
- `NUM.PV1M.ROUND_ESTIMATE` 凑整到指定数位，用基准点估计大数量 / Round to a given place and estimate large quantities with benchmarks 〔步骤〕
- `NUM.PV1M.COUNT_MULTIPLES` 从任意数开始按 250、500、1000、25 000 跳数 / Skip-count by 250s, 500s, 1000s and 25 000s from any start 〔熟练·拓展〕

**百万以内的加减法 · Addition & subtraction to 1 000 000**　`G5.FLU.01` `G5.FLU.04`

- `FLU.ADDSUB.FACTS20.EXTEND` 把 20 以内加减口诀用到大数上（从 8 + 7 得 800 + 700） / Use addition and subtraction facts to 20 on larger numbers (800 + 700 from 8 + 7) 〔熟练〕
- `FLU.ADDSUB.TO1M.MENTAL` 凑整、补偿、拆分：大数加减的心算策略 / Add and subtract mentally with friendly numbers, compensating and decomposing 〔步骤〕
- `FLU.ADDSUB.TO1M.ALGORITHM` 多位数竖式加减（连续进位、连续退位） / Add and subtract multi-digit numbers with regrouping across several places 〔步骤〕
- `FLU.ADDSUB.TO1M.ESTIMATE` 估算和与差，判断答案是否合理 / Estimate sums and differences and judge whether an answer is reasonable 〔推理〕
- `FLU.ADDSUB.TO1M.WORD` 多步加减应用题 / Solve multi-step addition and subtraction word problems 〔应用〕

**乘除法（到三位数） · Multiplication & division to 3 digits**　`G5.FLU.05` `G5.FLU.02`

- `FLU.MULT.FACTS.EMERGING` 乘法口诀：2、3、4、5、10（能直接说出） / Recall multiplication facts for 2s, 3s, 4s, 5s and 10s 〔熟练〕
- `FLU.MULT.FACTS.STRATEGIES` 难口诀的策略：翻倍减半、添零、拆分（分配律） / Work out harder facts with doubling/halving, annexing zeros and the distributive property 〔步骤〕
- `FLU.DIV.FACTS` 除法口诀：用乘法口诀倒推 / Recall division facts as the inverse of multiplication facts 〔熟练〕
- `FLU.MULT.3D_BY_1D` 三位数乘一位数（面积模型、分步乘） / Multiply 3-digit numbers by 1-digit numbers (area model, partial products) 〔步骤〕
- `FLU.MULT.2D_BY_2D` 两位数乘两位数 / Multiply 2-digit numbers by 2-digit numbers 〔步骤〕
- `FLU.DIV.3D_BY_1D` 三位数除以一位数 / Divide 3-digit numbers by 1-digit numbers 〔步骤〕
- `FLU.DIV.REMAINDER` 有余数的除法，说清余数表示什么 / Divide with remainders and say what the remainder means 〔概念〕
- `FLU.MULTDIV.WORD` 乘除应用题（余数要怎么处理：进一、舍去、还是就是答案） / Solve multiplication and division word problems, interpreting the remainder 〔应用〕

**小数（到千分位） · Decimals to thousandths**　`G5.NUM.02` `G5.FLU.03`

- `DEC.PV1000.MODEL` 用模型认识千分位：1 = 10 个 0.1 = 100 个 0.01 = 1000 个 0.001 / Model thousandths: 1 whole = 10 tenths = 100 hundredths = 1000 thousandths 〔表示〕
- `DEC.PV1000.READ_WRITE` 读写小数到千分位，说出每一位的位值 / Read, write and give the place value of decimals to thousandths 〔概念〕
- `DEC.PV1000.FRAC_LINK` 小数与分母是 10、100、1000 的分数互相表示（0.125 = 125/1000） / Write decimals as fractions and fractions with denominators 10, 100, 1000 as decimals 〔表示〕
- `DEC.PV1000.COMPARE` 比较和排序小数（到千分位） / Compare and order decimals to thousandths 〔步骤〕
- `DEC.ADDSUB.1000.ALGORITHM` 小数加减到千分位：对齐小数点，缺位补 0 / Add and subtract decimals to thousandths by lining up the decimal point 〔步骤〕
- `DEC.ADDSUB.1000.ESTIMATE` 用凑整或基准点估算小数的和与差 / Estimate decimal sums and differences by rounding or benchmarks 〔推理〕
- `DEC.ADDSUB.1000.WORD` 小数加减应用题（加元、公制单位） / Solve decimal addition and subtraction problems with money and metric measures 〔应用〕

**等值分数 · Equivalent fractions**　`G5.NUM.03`　🧪 试点

- `FRAC.EQUIV.SAME_WHOLE` 说清楚：分数要看同一个整体、而且必须平均分 / Explain that a fraction only makes sense for one whole cut into equal parts 〔概念·诊断〕
- `FRAC.EQUIV.VISUAL` 用分数条、圆形图、方格图识别和画出等值分数 / Recognize and show equivalent fractions with fraction bars, circles and grids 〔表示·诊断〕
- `FRAC.EQUIV.NUMBERLINE` 在数轴上看到等值分数落在同一个点 / Show that equivalent fractions land on the same point of a number line 〔表示·诊断〕
- `FRAC.EQUIV.MULTIPLY` 分子分母同乘一个数，生成等值分数 / Generate equivalent fractions by multiplying the numerator and denominator by the same number 〔步骤·诊断〕
- `FRAC.EQUIV.DIVIDE` 分子分母同除一个公因数，把分数化简 / Simplify a fraction by dividing numerator and denominator by a common factor 〔步骤·诊断〕
- `FRAC.EQUIV.JUDGE` 判断两个分数是否等值，并说出理由 / Decide whether two fractions are equivalent and explain why 〔推理·诊断〕
- `FRAC.EQUIV.APPLY` 用等值分数解决分东西、量东西、配方的问题 / Use equivalent fractions to solve sharing, measuring and recipe problems 〔应用·诊断〕

**整数、分数、小数放一起比 · Benchmarks: whole numbers, fractions & decimals**　`G5.NUM.04`

- `FRAC.COMPARE.UNLIKE` 用等值分数比较异分母分数 / Compare fractions with unlike denominators by making equivalent fractions 〔步骤〕
- `NUM.BENCHMARK.MIXED_ORDER` 把整数、分数、小数放在同一条数轴上比较和排序 / Place and order whole numbers, fractions and decimals together on a number line 〔应用〕
- ↻ `FRAC.COMPARE.BENCHMARKS` 用 0、1/2、1 做基准估计和比较分数 / Estimate and compare fractions using the benchmarks 0, 1/2 and 1 〔复习 · 来自 G4〕

**规律与方程 · Pattern rules & equations**　`G5.PAT.01` `G5.PAT.02`

- `PAT.RULE.WORDS_NUMBERS` 用语言和数字说出递增、递减规律的法则 / State the rule of an increasing or decreasing pattern in words and numbers 〔概念〕
- `PAT.RULE.SYMBOLS` 用符号和变量写规律法则（n + 3、2 × n） / Write a pattern rule with symbols and a variable (n + 3, 2 × n) 〔表示〕
- `PAT.TABLE.PREDICT` 用表格延续规律，预测第 20 项、第 50 项 / Use a table of values to extend a pattern and predict a far-away term 〔步骤〕
- `ALG.EQ.VAR.WRITE` 把问题写成含变量的一步方程（4 + x = 15） / Write a one-step equation with a variable for a problem (4 + x = 15) 〔表示〕
- `ALG.EQ.VAR.SOLVE_ADDSUB` 解含变量的一步加减方程 / Solve one-step addition and subtraction equations with a variable 〔步骤〕
- `ALG.EQ.VAR.SOLVE_MULTDIV` 解含变量的一步乘除方程 / Solve one-step multiplication and division equations with a variable 〔步骤〕

**面积与周长 · Area & perimeter**　`G5.GEO.01` `G5.GEO.02`

- `MEAS.AREA.COUNT_UNITS` 数方格求面积，认识 cm² 和 m² / Measure area by counting square units; use cm² and m² 〔概念〕
- `MEAS.AREA.RECT_FORMULA` 用长 × 宽求长方形、正方形的面积 / Find the area of rectangles and squares with length × width 〔步骤〕
- `MEAS.AREA.MISSING_SIDE` 已知面积求边长 / Find a missing side length from the area 〔推理·拓展〕
- `MEAS.AREA_PERIM.RELATION` 周长相同面积可以不同；面积相同周长也可以不同 / Show that shapes with the same perimeter can have different areas, and vice versa 〔推理〕
- `MEAS.AREA_PERIM.WORD` 面积与周长应用题（围栏、地砖、菜园） / Solve area and perimeter problems (fences, tiles, gardens) 〔应用〕

**经过时间 · Elapsed time**　`G5.GEO.03`

- `MEAS.TIME.ELAPSED.WITHIN_HOUR` 一小时以内的经过时间 / Find elapsed time within one hour 〔步骤〕
- `MEAS.TIME.ELAPSED.CROSS_HOUR` 跨小时的经过时间：在时间数轴上跳着算 / Find elapsed time across hours with jumps on a time line 〔步骤〕
- `MEAS.TIME.ELAPSED.START_END` 已知时长求开始或结束时刻（含 24 时计时法） / Find a start or end time from the duration, including 24-hour times 〔应用〕
- `MEAS.TIME.UNITS` 分、时、天、周之间的换算 / Convert between minutes, hours, days and weeks 〔步骤·拓展〕

**四边形、棱柱与棱锥 · Quadrilaterals, prisms & pyramids**　`G5.GEO.04`

- `GEO.2D.QUADRILATERALS` 按边、角、平行边描述和分类四边形 / Describe and sort quadrilaterals by sides, angles and parallel sides 〔概念〕
- `GEO.3D.PRISM_VS_PYRAMID` 看底面和顶点，区分棱柱和棱锥 / Tell prisms from pyramids by their bases and apex 〔概念〕
- `GEO.3D.NAME_BY_BASE` 按底面形状给棱柱和棱锥命名（三棱柱、四棱锥…） / Name prisms and pyramids by the shape of their base 〔步骤〕
- `GEO.3D.FACES_EDGES_VERTICES` 数面、棱、顶点；用展开图搭出棱柱 / Count faces, edges and vertices; build a prism from a net 〔表示·拓展〕

**平移、翻折、旋转 · Single transformations**　`G5.GEO.05`

- `GEO.TRANSFORM.TRANSLATE` 平移一个图形，说出怎么移的 / Translate (slide) a shape and describe the move 〔步骤〕
- `GEO.TRANSFORM.REFLECT` 把图形沿一条线翻折（反射） / Reflect (flip) a shape over a line 〔步骤〕
- `GEO.TRANSFORM.ROTATE` 把图形旋转 1/4 圈或 1/2 圈（顺时针、逆时针） / Rotate (turn) a shape a quarter or half turn, clockwise or counter-clockwise 〔步骤〕
- `GEO.TRANSFORM.IDENTIFY` 判断图形是平移、翻折还是旋转得到的 / Identify which single transformation maps a shape onto its image 〔推理〕

**复式条形图 · Double bar graphs**　`G5.DAT.01`

- `DATA.DBAR.READ` 读复式条形图（含多对一的刻度） / Read double bar graphs, including many-to-one scales 〔概念〕
- `DATA.DBAR.CREATE` 根据表格画复式条形图，选合适的刻度 / Make a double bar graph from a table and choose a sensible scale 〔步骤〕
- `DATA.DBAR.INTERPRET` 在复式条形图上比较两组数据、回答问题 / Compare two data sets on a double bar graph and answer questions 〔应用〕

**可能性 · Probability**　`G5.DAT.02`

- `PROB.OUTCOMES.LIST` 列出一次事件的所有可能结果 / List all possible outcomes of a single event 〔概念〕
- `PROB.FRACTION.SINGLE` 用分数表示一个结果的可能性 / Write the probability of a single outcome as a fraction 〔表示〕
- `PROB.PREDICT_TEST` 先预测，再做实验，把结果和预测比一比 / Predict, run an experiment and compare the results with the prediction 〔应用〕

**理财 · Financial literacy**　`G5.NUM.05`

- `FIN.CHANGE_TO_1000` 1000 元以内找零：往上数、拆分 / Make change for amounts to $1000 by counting up or decomposing 〔步骤〕
- `FIN.TOTALS_DECIMAL` 用小数记法算总价和差价 / Calculate totals and differences of money using decimal notation 〔步骤〕
- `FIN.PLAN_GOAL` 为一个存钱目标做计划（要存几周？） / Make a simple plan to reach a savings goal (how many weeks?) 〔应用〕
- `FIN.BUDGET_SIMPLE` 做一份收入和支出平衡的简单预算 / Build a simple budget that balances income and expenses 〔应用〕

### G6（17 个主题 · 71 个技能）

**从千分位到十亿 · Numbers from thousandths to billions**　`G6.NUM.01`

- `NUM.PVBIG.READ_WRITE` 读写从千分位到十亿的数，说出每个数位 / Read and write numbers from thousandths to billions, naming each place 〔概念〕
- `NUM.PVBIG.COMPARE_ORDER` 比较、排序、凑整很大和很小的数 / Compare, order and round very large and very small numbers 〔步骤〕
- `NUM.PVBIG.CONTEXT` 理解科学、医学、媒体里的大数和小数（人口、剂量、数据量） / Make sense of large and small numbers in science, medicine and media (populations, doses, data sizes) 〔应用·拓展〕

**因数、倍数、质数 · Factors, multiples & primes**　`G6.NUM.02`　🧪 试点

- `NUM.FACTORS.LIST` 用因数对列出一个数的全部因数 / List all the factors of a number using factor pairs 〔步骤·诊断〕
- `NUM.MULTIPLES.LIST` 列一个数的倍数，找公倍数 / List multiples of a number and find common multiples 〔步骤·诊断〕
- `NUM.PRIME_COMPOSITE` 区分质数和合数（为什么 1 两者都不是） / Tell prime from composite numbers (and why 1 is neither) 〔概念·诊断〕
- `NUM.DIVISIBILITY` 用 2、3、4、5、6、9、10 的整除规则 / Use divisibility rules for 2, 3, 4, 5, 6, 9 and 10 〔步骤·诊断〕
- `NUM.PRIME_FACTORIZATION` 用因数树做质因数分解，并用幂写出来（300 = 2² × 3 × 5²） / Write a number as a product of primes with a factor tree and exponents (300 = 2² × 3 × 5²) 〔步骤·诊断〕
- `NUM.GCF` 求两个数的最大公因数（列举法、维恩图、质因数法） / Find the greatest common factor of two numbers (listing, Venn diagram, prime factors) 〔步骤·诊断〕
- `NUM.LCM` 求两个数的最小公倍数 / Find the least common multiple of two numbers 〔步骤·诊断〕
- `NUM.GCF_LCM.APPLY` 用最大公因数、最小公倍数解决问题（分组、周期相遇、约分） / Solve problems with GCF and LCM (equal groups, repeating events, simplifying fractions) 〔应用·诊断〕

**口算熟练与运算顺序 · Fact fluency & order of operations**　`G6.FLU.01` `G6.FLU.02`

- `FLU.MULT.FACTS.DEVELOPING` 100 以内乘除口诀全部能快速说出 / Recall all multiplication and division facts to 100 quickly 〔熟练〕
- `FLU.MENTAL.MULTI_DIGIT` 多位数心算策略：翻倍再翻倍（23 × 4）、减半 / Multiply and divide mentally with strategies like double-double (23 × 4) and halving 〔步骤〕
- `FLU.ORDER_OPS.NO_BRACKETS` 按运算顺序计算（无括号：先乘除后加减，同级从左到右） / Evaluate expressions using the order of operations without brackets 〔步骤〕
- `FLU.ORDER_OPS.BRACKETS` 带括号的运算顺序 / Evaluate expressions with brackets 〔步骤〕
- `FLU.ORDER_OPS.WRITE_EXPR` 把多步问题写成一个综合算式再计算 / Write a multi-step problem as one expression and evaluate it 〔应用〕

**假分数与带分数 · Improper fractions & mixed numbers**　`G6.NUM.03`

- `FRAC.MIXED.MODEL` 用模型表示大于 1 的分数，认识带分数和假分数 / Show fractions greater than 1 with models and name them as mixed or improper 〔表示〕
- `FRAC.MIXED.TO_IMPROPER` 带分数化成假分数 / Convert mixed numbers to improper fractions 〔步骤〕
- `FRAC.IMPROPER.TO_MIXED` 假分数化成带分数 / Convert improper fractions to mixed numbers 〔步骤〕
- `FRAC.MIXED.NUMBERLINE` 在数轴上标出带分数和假分数 / Place mixed numbers and improper fractions on a number line 〔表示〕
- `FRAC.MIXED.COMPARE_ORDER` 用基准或通分比较、排序带分数、假分数和整数 / Compare and order mixed numbers, improper fractions and whole numbers with benchmarks or common denominators 〔步骤〕

**比 · Ratios**　`G6.NUM.04`

- `RATIO.MEANING` 用比来比较两个量（3:2、3 比 2） / Write a ratio to compare two quantities (3:2, 3 to 2) 〔概念〕
- `RATIO.PART_PART_WHOLE` 区分部分比部分、部分比整体 / Tell part-to-part ratios from part-to-whole ratios 〔概念〕
- `RATIO.EQUIVALENT` 用比例表找等值比 / Find equivalent ratios with a ratio table 〔步骤〕
- `RATIO.APPLY` 比的应用题（配方、调颜色、按比例放大缩小） / Solve ratio problems (recipes, mixing paint, scaling a class list) 〔应用〕

**百分数与打折 · Percents & discounts**　`G6.NUM.05`

- `PCT.MEANING` 百分数的意义：每 100 份里的几份（10 × 10 格） / Understand percent as parts per hundred on a 10 × 10 grid 〔概念〕
- `PCT.FRAC_DEC_LINK` 整数百分数、分数、小数互化（50% = 1/2 = 0.5 = 50:100） / Convert between whole-number percents, fractions and decimals (50% = 1/2 = 0.5 = 50:100) 〔表示〕
- `PCT.OF_NUMBER` 求一个数的百分之几（80 的 25%） / Find a percent of a number (25% of 80) 〔步骤〕
- `PCT.FIND_MISSING` 已知其二求其一：部分、整体、百分比 / Find the missing part, whole or percent 〔推理〕
- `PCT.DISCOUNT` 算打折省了多少、折后价是多少 / Work out a percentage discount and the sale price 〔应用〕

**小数乘除法 · Decimal multiplication & division**　`G6.FLU.03`

- `DEC.MULT.BY_WHOLE` 小数乘整数（0.125 × 3），用模型和估算检查 / Multiply a decimal by a whole number (0.125 × 3) with models and estimation 〔步骤〕
- `DEC.MULT.BY_DECIMAL` 小数乘小数：数小数位数定小数点 / Multiply two decimals and place the decimal point by counting places 〔步骤〕
- `DEC.DIV.BY_WHOLE` 小数除以整数（7.2 ÷ 9） / Divide a decimal by a whole number (7.2 ÷ 9) 〔步骤〕
- `DEC.DIV.BY_DECIMAL` 除以小数：先把除数变成整数 / Divide by a decimal by rewriting as a whole-number division 〔步骤〕
- `DEC.MULTDIV.WORD` 小数乘除应用题（单价、公制单位换算） / Solve decimal multiplication and division problems (unit prices, metric conversions) 〔应用〕

**规律、式子与图象 · Patterns, expressions & graphs**　`G6.PAT.01`

- `PAT.EXPR.FROM_PATTERN` 给规律写式子（3、5、7、… 是 2n + 1） / Write an expression for a pattern (3, 5, 7, … is 2n + 1) 〔表示〕
- `PAT.TABLE.TO_GRAPH` 把表格里的数对描在第一象限 / Plot a table of values as points in the first quadrant 〔表示〕
- `PAT.GRAPH.TO_RULE` 从图或表里读出规律，解释两个量的对应关系 / Read a rule from a graph or table and explain the functional relationship 〔推理〕
- `PAT.VISUAL.TILES` 找出色块图形规律的通项式 / Find the expression for a growing tile pattern 〔应用·拓展〕

**一步方程 · One-step equations**　`G6.PAT.02`

- `ALG.EQ.BALANCE` 等式守恒：两边做同样的事（天平、代数砖） / Keep an equation balanced: do the same thing to both sides 〔概念〕
- `ALG.EQ.ONESTEP.COEFF` 解带系数的一步方程（3x = 12） / Solve one-step equations with a coefficient (3x = 12) 〔步骤〕
- `ALG.EQ.ONESTEP.CHECK` 解一步方程（x + 5 = 11）并代入验算 / Solve one-step equations (x + 5 = 11) and verify by substitution 〔推理〕
- `ALG.EQ.ONESTEP.WORD` 列一步方程解应用题 / Write and solve a one-step equation for a word problem 〔应用〕

**周长与面积 · Perimeter & area**　`G6.GEO.01` `G6.GEO.02`

- `MEAS.PERIM.COMPLEX` 求组合图形的周长（找出没标出的边） / Find the perimeter of complex shapes, including hidden side lengths 〔步骤〕
- `MEAS.AREA.PARALLELOGRAM` 把平行四边形剪拼成长方形，得到底 × 高 / Find the area of a parallelogram by cutting it into a rectangle (base × height) 〔推理〕
- `MEAS.AREA.TRIANGLE` 三角形面积 = 平行四边形的一半（底 × 高 ÷ 2） / Find the area of a triangle as half a parallelogram (base × height ÷ 2) 〔推理〕
- `MEAS.AREA.TRAPEZOID` 梯形面积：拆成三角形和长方形，或用公式 / Find the area of a trapezoid by decomposing or with the formula 〔步骤〕
- `MEAS.AREA.COMPOSITE` 组合图形的面积：分割再相加 / Find the area of composite shapes by splitting them 〔应用〕

**角 · Angles**　`G6.GEO.03`

- `GEO.ANGLE.CLASSIFY` 角的分类：锐角、直角、钝角、平角、优角 / Classify angles as acute, right, obtuse, straight or reflex 〔概念〕
- `GEO.ANGLE.ESTIMATE` 用 45°、90°、180° 做参照估计角的大小 / Estimate angles using 45°, 90° and 180° as references 〔推理〕
- `GEO.ANGLE.MEASURE_DRAW` 用量角器量角、画角 / Measure and draw angles with a protractor 〔步骤〕
- `GEO.ANGLE.IN_POLYGONS` 求三角形、四边形里缺少的角（内角和 180°、360°） / Find missing angles in triangles and quadrilaterals (180°, 360°) 〔应用〕

**三角形 · Triangles**　`G6.GEO.05`

- `GEO.TRI.BY_SIDES` 按边分类三角形：不等边、等腰、等边 / Classify triangles by sides: scalene, isosceles, equilateral 〔概念〕
- `GEO.TRI.BY_ANGLES` 按角分类三角形：直角、锐角、钝角 / Classify triangles by angles: right, acute, obtuse 〔概念〕
- `GEO.TRI.CLASSIFY_BOTH` 同时按边和角给三角形分类，不管怎么摆放 / Classify a triangle by both sides and angles, in any orientation 〔推理〕

**体积与容积 · Volume & capacity**　`G6.GEO.04`

- `MEAS.VOL.COUNT_CUBES` 数小立方体求体积（包括看不见的） / Find volume by counting unit cubes, including hidden ones 〔概念〕
- `MEAS.VOL.RECT_PRISM` 长方体体积 = 长 × 宽 × 高 / Find the volume of a rectangular prism with length × width × height 〔步骤〕
- `MEAS.CAPACITY.UNITS` 体积与容积单位的关系：1 cm³ = 1 mL，1000 mL = 1 L，m³ / Relate volume and capacity units: 1 cm³ = 1 mL, 1000 mL = 1 L, m³ 〔概念〕
- `MEAS.VOL.REFERENTS` 用身边的参照物估计容积（几个杯子是一升？） / Estimate capacity with everyday referents (how many mugs make a litre?) 〔应用·拓展〕

**坐标与组合变换 · Coordinates & combined transformations**　`G6.GEO.06`

- `GEO.COORD.Q1.PLOT` 在第一象限用整数数对描点、读点 / Plot and read points in the first quadrant with whole-number ordered pairs 〔步骤〕
- `GEO.TRANSFORM.COMBO.PERFORM` 对一个图形连续做平移、翻折、旋转，画出最后的像 / Apply a sequence of translations, reflections and rotations to a shape and draw the image 〔步骤〕
- `GEO.TRANSFORM.COMBO.DESCRIBE` 描述图形经过了哪几步变换才变成像 / Describe the transformations that map a shape onto its image 〔推理〕

**折线图 · Line graphs**　`G6.DAT.01`

- `DATA.LINE.READ` 从折线图读数值和变化趋势 / Read values and trends from a line graph 〔概念〕
- `DATA.LINE.CREATE` 根据表格画折线图，选合适的刻度 / Draw a line graph from a table of values with a suitable scale 〔步骤〕
- `DATA.LINE.INTERPRET` 解释随时间的变化，并用折线图做预测 / Interpret change over time and make predictions from a line graph 〔应用〕

**可能性：理论与实验 · Theoretical & experimental probability**　`G6.DAT.02`

- `PROB.THEORETICAL` 列出所有结果，算一个结果的理论可能性 / Find the theoretical probability of a single outcome by listing all outcomes 〔步骤〕
- `PROB.EXPERIMENTAL` 从实验结果算实验可能性（频率） / Find experimental probability from the results of trials 〔步骤〕
- `PROB.COMPARE_TH_EXP` 比较实验结果和理论预期，解释为什么不一样 / Compare experimental results with theoretical expectation and explain the difference 〔推理〕

**理财 · Financial literacy**　`G6.NUM.06`

- `FIN.SAVE_PLAN` 为一次购买做储蓄计划（几周零花钱能买一辆自行车？） / Plan saving toward a purchase (how many weeks of allowance for a bike?) 〔应用〕
- `FIN.CONSUMER.COMPARE` 比价：按价格、分量、折扣做出明智的购买选择 / Compare purchase options by price, size and discount to make an informed choice 〔应用〕
- `FIN.BUDGET.INCOME_EXPENSE` 做一份收支预算并调整它 / Build and adjust a simple budget with income and expenses 〔应用〕

### G7（11 个主题 · 50 个技能）

**整数（含负数）的运算 · Integer operations**　`G7.FLU.02`

- `INT.CONCEPT` 在数轴和生活里认识负数（温度、海拔、账户） / Understand negative numbers on a number line and in context (temperature, elevation, money) 〔概念〕
- `INT.COMPARE_ORDER` 比较和排序整数，找相反数 / Compare and order integers; find opposites 〔步骤〕
- `INT.ADD` 整数加法：先用双色筹码、数轴，再用符号算 / Add integers with two-colour counters and number lines, then symbolically 〔步骤〕
- `INT.SUBTRACT` 整数减法，包括减去负数（9 − (−4) = 13） / Subtract integers, including subtracting a negative (9 − (−4) = 13) 〔步骤〕
- `INT.MULT_DIV` 整数乘除：符号规则 / Multiply and divide integers using the sign rules 〔步骤〕
- `INT.ORDER_OPS` 整数的混合运算顺序（含括号） / Use the order of operations with integers, including brackets 〔步骤〕
- `INT.WORD` 整数应用题（温差、海拔变化、账户余额） / Solve problems with integers (temperature changes, elevation, account balances) 〔应用〕

**小数的四则运算 · Decimal operations**　`G7.FLU.03` `G7.FLU.01`

- `FLU.MULT.FACTS.EXTENDING` 口算拓展：×5 就是 ×10 再 ÷2（214 × 5 = 1070） / Extend mental multiplication and division (×5 = ×10 ÷ 2; 214 × 5 = 1070) 〔熟练〕
- `DEC.OPS.MIXED` 小数四则运算（熟练） / Add, subtract, multiply and divide decimals fluently 〔步骤〕
- `DEC.OPS.ORDER_OPS` 小数的混合运算顺序（含括号） / Use the order of operations with decimals, including brackets 〔步骤〕
- `DEC.OPS.WORD` 多步小数应用题（购物总价、单价、测量） / Solve multi-step decimal problems (shopping totals, unit rates, measurements) 〔应用〕

**分数、小数、比与百分数 · Fractions, decimals, ratios & percents**　`G7.NUM.01`　🧪 试点

- `REL.FRAC_TO_DEC` 分数化小数：分子除以分母 / Convert a fraction to a decimal by dividing the numerator by the denominator 〔步骤·诊断〕
- `REL.DEC_TO_FRAC` 小数化成最简分数 / Convert a decimal to a fraction in lowest terms 〔步骤·诊断〕
- `REL.PCT_CONVERT` 百分数、分数、小数互化（3/8 = 0.375 = 37.5%） / Convert among percents, fractions and decimals (3/8 = 0.375 = 37.5%) 〔步骤·诊断〕
- `REL.RATIO_LINK` 部分比整体的比写成分数、小数、百分数（50:100 = 1/2 = 0.5 = 50%） / Write a part-to-whole ratio as a fraction, decimal and percent (50:100 = 1/2 = 0.5 = 50%) 〔表示·诊断〕
- `REL.TERMINATING_REPEATING` 区分有限小数和循环小数，会写循环节 / Tell terminating from repeating decimals and write repeating decimals with bar notation 〔概念·诊断〕
- `REL.BENCHMARKS` 常用基准值记熟（1/4 = 0.25 = 25%，1/3 ≈ 0.33，3/4 = 75%） / Know common benchmarks by heart (1/4 = 0.25 = 25%, 1/3 ≈ 0.33, 3/4 = 75%) 〔熟练·诊断〕
- `REL.COMPARE_ORDER` 把分数、小数、百分数混在一起比较、排序（数轴） / Compare and order a mix of fractions, decimals and percents on a number line 〔推理·诊断〕
- `REL.APPLY` 选最合适的表示方式解决实际问题（调查结果、海岸清理数据、折扣） / Choose the best representation to solve a real problem (survey results, shoreline cleanup data, discounts) 〔应用·诊断〕

**坐标系与线性关系 · Coordinates & linear relations**　`G7.PAT.01` `G7.GEO.03`

- `GEO.COORD.Q4.PLOT` 四象限描点、读点；认识原点和象限 / Plot and read points in all four quadrants; name the origin and quadrants 〔步骤〕
- `PAT.LINEAR.TABLE` 从表格里看出离散线性关系（每次变化相同） / Recognize a discrete linear relation in a table (constant change) 〔概念〕
- `PAT.LINEAR.EXPRESSION` 写出线性关系的式子（3n + 2）并代入求值 / Write the expression for a linear relation (3n + 2) and evaluate it 〔表示〕
- `PAT.LINEAR.GRAPH` 根据表格或式子描点画离散线性关系 / Graph a discrete linear relation from a table or expression 〔表示〕
- `PAT.LINEAR.FROM_GRAPH` 从图象或表格推出关系式 / Derive the relation from a graph or table of values 〔推理〕
- `PAT.LINEAR.RATE_INTERCEPT` 结合情境解释变化率和起始值（截距） / Explain the rate of change and the starting value (y-intercept) in context 〔推理〕

**两步方程 · Two-step equations**　`G7.PAT.02`

- `ALG.EQ.TWOSTEP.MODEL` 用天平、代数砖或条形图表示两步方程 / Model a two-step equation with a balance, algebra tiles or a bar model 〔表示〕
- `ALG.EQ.TWOSTEP.SOLVE` 解两步方程（3x + 4 = 16）：按顺序逆运算 / Solve two-step equations (3x + 4 = 16) by undoing operations in order 〔步骤〕
- `ALG.EQ.TWOSTEP.VERIFY` 把解代回方程验算 / Verify a solution by substituting it back into the equation 〔推理〕
- `ALG.EQ.TWOSTEP.WORD` 列两步方程解应用题（出行计划、手机套餐） / Write and solve a two-step equation for a word problem (canoe trip planning, phone plans) 〔应用〕

**圆 · Circles**　`G7.GEO.01`

- `GEO.CIRCLE.PARTS` 认识半径、直径、圆周，按给定半径或直径画圆 / Name radius, diameter and circumference and construct a circle from a given radius or diameter 〔概念〕
- `GEO.CIRCLE.PI` 发现周长 ÷ 直径总是约 3.14，得到 C = π × d / Discover that circumference ÷ diameter is always about 3.14 and develop C = π × d 〔推理〕
- `GEO.CIRCLE.CIRCUMFERENCE` 已知半径或直径求周长 / Calculate circumference from the radius or diameter 〔步骤〕
- `GEO.CIRCLE.AREA` 用 A = π × r × r 求圆的面积 / Calculate the area of a circle with A = π × r × r 〔步骤〕
- `GEO.CIRCLE.INVERSE` 已知周长或面积反求半径、直径 / Find the radius or diameter from a given circumference or area 〔推理·拓展〕

**体积 · Volume**　`G7.GEO.02`

- `MEAS.VOL.BASE_HEIGHT` 理解体积 = 底面积 × 高（对任何直棱柱都成立） / Understand volume as area of base × height for any right prism 〔概念〕
- `MEAS.VOL.CYLINDER` 圆柱体积（π r² × h） / Calculate the volume of a cylinder (π r² × h) 〔步骤〕
- `MEAS.VOL.WORD` 长方体和圆柱的体积应用题（箱子、水箱、罐头） / Solve volume problems with rectangular prisms and cylinders (boxes, tanks, cans) 〔应用〕

**组合变换与镶嵌 · Transformations & tessellations**　`G7.GEO.04`

- `GEO.TRANSFORM.Q4.PERFORM` 在四象限里做变换，写出像的坐标 / Transform shapes in four quadrants and give the image coordinates 〔步骤〕
- `GEO.TRANSFORM.Q4.DESCRIBE` 精确描述连续变换的每一步 / Describe a combination of successive transformations precisely 〔推理〕
- `GEO.TESSELLATION` 用变换创作镶嵌图案，解释哪些图形能铺满平面 / Create and explain tessellations using transformations 〔应用〕

**扇形统计图 · Circle graphs**　`G7.DAT.01`

- `DATA.CIRCLE.READ` 读扇形图，把百分数换算成实际数量 / Read a circle graph and convert its percentages into quantities 〔概念〕
- `DATA.CIRCLE.CONSTRUCT` 画扇形图并标注（数量 → 百分数 → 角度） / Construct and label a circle graph (quantity → percent → angle) 〔步骤〕
- `DATA.CIRCLE.CHOOSE_GRAPH` 判断什么时候该用扇形图，什么时候用条形图、折线图 / Decide when a circle graph is the right choice compared with bar and line graphs 〔推理·拓展〕

**两个独立事件 · Two independent events**　`G7.DAT.02`

- `PROB.TWO_EVENTS.OUTCOMES` 用表格或树状图列出两个独立事件的所有结果 / List all outcomes of two independent events with a table or tree diagram 〔表示〕
- `PROB.TWO_EVENTS.EXPERIMENT` 对两个独立事件做多次实验，算实验可能性 / Run many trials of two independent events and find the experimental probability 〔步骤〕
- `PROB.TWO_EVENTS.COMPARE` 比较两个事件的实验结果和预期结果 / Compare experimental results for two events with the expected results 〔推理〕

**理财中的百分数 · Financial percentages**　`G7.NUM.02`

- `FIN.PCT.DISCOUNT` 算折扣额和折后价 / Calculate a discount and the sale price 〔步骤〕
- `FIN.PCT.TAX` 算销售税（GST/PST）和含税总价 / Calculate sales tax (GST/PST) and the total with tax 〔步骤〕
- `FIN.PCT.TIP` 估算和计算小费（10%、15%、20%） / Estimate and calculate a tip (10%, 15%, 20%) 〔步骤〕
- `FIN.PCT.FINAL_PRICE` 先打折再加税的最终价格，以及总的变化百分比 / Find the final price after a discount and tax, and the overall percentage change 〔应用〕

### G8（14 个主题 · 71 个技能）

**完全平方数与完全立方数 · Perfect squares & cubes**　`G8.NUM.01`

- `NUM.SQUARE.TILES` 用方片摆出正方形，认出 400 以内的完全平方数（n × n） / Build perfect squares with colour tiles and identify perfect squares to 400 as n × n 〔表示〕
- `NUM.CUBE.BUILD` 用小方块搭出正方体，认识完全立方数并用指数写出（4³ = 4 × 4 × 4 = 64） / Build perfect cubes with linking cubes and write them with exponents (4³ = 4 × 4 × 4 = 64) 〔概念〕
- `NUM.POWERS.PRIME_FACTOR_TEST` 用质因数分解判断一个数是完全平方数还是完全立方数（324 = 2² × 3⁴ 是平方数） / Use prime factorization to decide whether a number is a perfect square or a perfect cube (324 = 2² × 3⁴ is a square) 〔步骤〕
- `NUM.POWERS.SQUARE_CUBE_COMPARE` 区分平方、立方与乘 2、乘 3；解释为什么 64 既是完全平方数又是完全立方数 / Tell squaring and cubing apart from doubling and tripling, and explain why 64 is both a perfect square and a perfect cube 〔推理〕
- ↻ `NUM.SQUARE.RECOGNIZE` 认识 144 以内的平方数：能摆成正方形点阵的数（n × n） / Recognize perfect squares to 144 as numbers that make a square array (n × n) 〔复习 · 来自 G7〕
- ↻ `NUM.SQUARE.NOTATION` 认识平方记号：7² 表示 7 × 7 = 49，不是 7 × 2 / Read and write square notation: 7² means 7 × 7 = 49, not 7 × 2 〔复习 · 来自 G7〕

**平方根与立方根 · Square & cube roots**　`G8.NUM.02`

- `NUM.ROOT.SQUARE_PERFECT` 求 400 以内完全平方数的平方根，包括分数（√(16/169) = 4/13） / Find square roots of perfect squares to 400, including fractions (√(16/169) = 4/13) 〔步骤〕
- `NUM.ROOT.CUBE_PERFECT` 求完全立方数的立方根（∛125 = 5）：开立方是立方的逆运算 / Find cube roots of perfect cubes (∛125 = 5) as the inverse of cubing 〔步骤〕
- `NUM.ROOT.ESTIMATE` 用相邻的完全平方数估算非平方数的平方根到一位小数（√30 ≈ 5.5） / Estimate the square root of a non-perfect square to one decimal place using the neighbouring perfect squares (√30 ≈ 5.5) 〔推理〕
- `NUM.ROOT.PRIME_FACTOR` 把质因数两两、三三分组求较大数的平方根和立方根（√1764 = 2 × 3 × 7 = 42） / Find square and cube roots of larger numbers by grouping prime factors in pairs or triples (√1764 = 2 × 3 × 7 = 42) 〔步骤〕
- `NUM.ROOT.APPLY` 用平方根、立方根解决问题（由面积求正方形场地的边长、由体积求正方体水箱的棱长） / Use square and cube roots to solve problems (side of a square field from its area, edge of a cubic tank from its volume) 〔应用〕
- ↻ `NUM.SQUARE.ROOT` 求平方数的平方根（√81 = 9）：开方是平方的逆运算 / Find the square root of a perfect square (√81 = 9) as the inverse of squaring 〔复习 · 来自 G7〕
- ↻ `NUM.SQUARE.ROOT_ESTIMATE` 估算非平方数的平方根落在哪两个整数之间（√20 在 4 和 5 之间） / Estimate the square root of a non-square number between two whole numbers (√20 is between 4 and 5) 〔复习 · 来自 G7〕

**分数的四则运算 · Operations with fractions**　`G8.FLU.01`

- `FRAC.ADDSUB.LIKE` 同分母分数加减，结果化成最简（5/8 + 7/8 = 1 1/2） / Add and subtract fractions with like denominators and write the answer in lowest terms (5/8 + 7/8 = 1 1/2) 〔步骤〕
- `FRAC.ADDSUB.UNLIKE` 异分母分数加减：先通分再计算（2/3 + 1/4 = 11/12） / Add and subtract fractions with unlike denominators using a common denominator (2/3 + 1/4 = 11/12) 〔步骤〕
- `FRAC.ADDSUB.MIXED` 带分数加减，不够减时从整数借 1（3 1/4 − 1 3/4 = 1 1/2） / Add and subtract mixed numbers, regrouping a whole when needed (3 1/4 − 1 3/4 = 1 1/2) 〔步骤〕
- `FRAC.MULT` 分数与带分数乘法：先用面积模型，再分子乘分子、分母乘分母（2/3 × 3/4 = 1/2） / Multiply fractions and mixed numbers with an area model, then numerator × numerator over denominator × denominator (2/3 × 3/4 = 1/2) 〔步骤〕
- `FRAC.DIV` 分数除法：先想「能装几份」（3/4 ÷ 1/8 = 6），再学乘倒数 / Divide fractions by asking how many groups fit (3/4 ÷ 1/8 = 6), then by multiplying by the reciprocal 〔步骤〕
- `FRAC.ORDER_OPS` 分数的混合运算顺序（含括号、不含乘方）：½ ÷ 9/6 × (7 − 4/5) / Use the order of operations with fractions, including brackets but not exponents (½ ÷ 9/6 × (7 − 4/5)) 〔步骤〕
- `FRAC.OPS.WORD` 分数应用题：鼓歌里的节拍、按比例改配方、按家庭人数分配收获 / Solve fraction problems in context: beats in a drum song, scaling a recipe, sharing a harvest by family size 〔应用〕

**小于 1 与大于 100 的百分数 · Percents below 1% and above 100%**　`G8.NUM.03`

- `PCT.BEYOND100.MEANING` 在百格图上认识小于 1% 和大于 100% 的百分数（0.5% 是半格；250% 是两格半） / Make sense of percents below 1% and above 100% on hundredths grids (0.5% is half a square; 250% is two and a half grids) 〔概念〕
- `PCT.BEYOND100.CONVERT` 分数形式、小数形式的百分数与小数、分数互化（½% = 0.005，3.25% = 0.0325，122% = 1.22） / Convert fractional and decimal percents to decimals and fractions (½% = 0.005, 3.25% = 0.0325, 122% = 1.22) 〔步骤〕
- `PCT.BEYOND100.OF_NUMBER` 求一个量的小百分数和大百分数（10 亿的 ½%；60 的 150%） / Find fractional and large percents of a quantity (½% of 1 billion; 150% of 60) 〔步骤〕
- `PCT.CHANGE.INCREASE_DECREASE` 算百分比增减后的新量（人口增长 3.25% → 乘 1.0325） / Apply a percent increase or decrease and find the new amount (population up 3.25% → multiply by 1.0325) 〔步骤〕
- `PCT.CHANGE.ORIGINAL` 已知增减后的量倒推原值（工资涨了 122% 后是 $93 940，原来是多少） / Find the original amount before a percent change (a salary is $93 940 after a 122% increase — what was it?) 〔推理〕

**比、比率与比例 · Ratios, rates & proportions**　`G8.NUM.04`

- `RATIO.THREE_TERM` 从情境写出两项比和三项比并化简（6 红 : 4 蓝 : 10 绿 = 3 : 2 : 5） / Write and simplify two- and three-term ratios from a situation (6 red : 4 blue : 10 green = 3 : 2 : 5) 〔表示〕
- `RATIO.SHARE` 按比分配一个总量（105 cm 的绳子按 3 : 5 : 7 剪成三段） / Share a quantity in a given ratio (cut a 105 cm string in the ratio 3 : 5 : 7) 〔步骤〕
- `RATE.UNIT_RATE` 认识比率是不同单位的量之比，会求单位比率（3 小时 240 km = 80 km/h） / Understand a rate as a comparison of different units and find unit rates (240 km in 3 h = 80 km/h) 〔概念〕
- `RATE.COMPARE` 化成同一单位比率来比较（谁跑得快：24 分钟 5 km 还是 15 分钟 3 km） / Compare rates by converting to the same unit rate (who is faster: 5 km in 24 min or 3 km in 15 min?) 〔推理〕
- `PROPORTION.SOLVE` 列比例求未知项（3/8 = x/56）：用倍数关系或交叉相乘 / Set up and solve a proportion for a missing value (3/8 = x/56) using a scale factor or cross-products 〔步骤〕
- `PROPORTION.APPLY` 比、比率、百分数的综合应用（比例图、配方、鼓箱尺寸、速度） / Solve ratio, rate and percent problems in context (scale drawings, recipes, drum-box proportions, speed) 〔应用〕

**理财：怎么买最划算 · Financial literacy: best buys**　`G8.NUM.05`

- `FIN.UNIT_PRICE` 算单价（12 个 $4.68 = 每个 39¢；每 100 g 多少钱）来比较不同包装 / Find unit prices ($4.68 for 12 = 39¢ each; price per 100 g) to compare package sizes 〔步骤〕
- `FIN.COUPON_VS_PERCENT` 比较「减 $5」优惠券和「打 8 折」在某个价格下哪个更省 / Compare a dollar-off coupon with a percent-off discount and decide which saves more on a given price 〔推理〕
- `FIN.MULTI_BUY` 用实际单价评估「3 件 $10」「买二送一」这类促销 / Evaluate multi-buy deals (3 for $10, buy 2 get 1 free) by finding the effective unit price 〔步骤〕
- `FIN.BEST_BUY.DECIDE` 结合单价、实际需要的量、优惠券和保质期，决定怎么买最划算 / Choose the best buy for a real need by weighing unit price, quantity needed, coupons and expiry 〔应用〕

**代数式与代入求值 · Expressions & substitution**　`G8.PAT.02`

- `ALG.EXPR.WRITE` 用代数式描述数量关系（n 张 $12 的票加 $5 手续费 = 12n + 5） / Write an expression to describe a relationship (n tickets at $12 plus a $5 fee = 12n + 5) 〔表示〕
- `ALG.EXPR.PARTS` 认识代数式里的项、系数、变量和常数（0.5n − 3n + 25） / Identify terms, coefficients, variables and constants in an expression (0.5n − 3n + 25) 〔概念〕
- `ALG.EXPR.EVALUATE` 代入求值，含负数和小数（n = 14 时求 0.5n − 3n + 25） / Evaluate an expression by substitution, including negative and decimal values (0.5n − 3n + 25 when n = 14) 〔步骤〕
- `ALG.EXPR.COMBINE_LIKE` 先合并同类项再代入（0.5n − 3n + 25 = −2.5n + 25） / Simplify an expression by combining like terms before substituting (0.5n − 3n + 25 = −2.5n + 25) 〔步骤·拓展〕

**离散线性关系 · Discrete linear relations**　`G8.PAT.01`

- `GEO.COORD.Q4.SCALE` 在刻度不是 1 的坐标轴上（每格 5）四个象限描点、读点 / Plot and read integer points in all four quadrants on axes with scaled tick marks (each square = 5) 〔步骤〕
- `PAT.LINEAR.EXPR_TO_TABLE` 由线性式子列数值表，输入含负数（y = 3x − 4，x 从 −2 到 3） / Build a table of values from a linear expression with integer inputs, including negatives (y = 3x − 4 for x = −2 to 3) 〔步骤〕
- `PAT.LINEAR.TABLE_TO_EXPR` 从等差的数值表写出式子，扩展到较大的数（x 取 0、5、10… → y = 4x + 7） / Find the expression from a table with a constant difference, extended to larger numbers (x = 0, 5, 10… → y = 4x + 7) 〔表示〕
- `PAT.LINEAR.GRAPH_Q4` 在四个象限画离散线性关系的图，说明为什么点之间不连线 / Graph a discrete linear relation in four quadrants and explain why the points are not joined 〔表示〕
- `PAT.LINEAR.GRAPH_TO_EXPR` 从图上读出变化率和 x = 0 时的值，写出式子（点 (0, −3)、(1, −1)、(2, 1) → y = 2x − 3） / Read the rate of change and the value at x = 0 from a graph to write the expression (points (0, −3), (1, −1), (2, 1) → y = 2x − 3) 〔推理〕
- `PAT.LINEAR.APPLY` 用线性关系描述真实情境，用表格、式子或图回答问题（手机套餐：$20 加每 GB $5） / Model a real situation as a linear relation and use a table, expression or graph to answer questions (phone plan: $20 plus $5 per GB) 〔应用〕

**两步方程（含负数） · Two-step equations with integers**　`G8.PAT.03`

- `ALG.EQ.TWOSTEP_INT.MODEL` 用代数砖、天平表示含负数的两步方程（3x − 4 = −13） / Model two-step equations with negatives using algebra tiles or a balance (3x − 4 = −13) 〔表示〕
- `ALG.EQ.TWOSTEP_INT.SOLVE` 解整数系数、常数和解的两步方程（−4x + 7 = 19 → x = −3） / Solve two-step equations with integer coefficients, constants and solutions (−4x + 7 = 19 → x = −3) 〔步骤〕
- `ALG.EQ.TWOSTEP_INT.VERIFY` 把解代回原方程验算，含负数（把 x = −3 代入 −4x + 7 = 19） / Verify a solution by substituting it back, including negatives (check x = −3 in −4x + 7 = 19) 〔推理〕
- `ALG.EQ.TWOSTEP_INT.OTHER_FORMS` 解其他形式的两步方程：x/3 + 5 = 2，2(x + 4) = −6 / Solve two-step equations in other forms: x/3 + 5 = 2 and 2(x + 4) = −6 〔步骤·拓展〕
- `ALG.EQ.TWOSTEP_INT.WORD` 从含负数的情境列两步方程并求解（从 5° 每小时降 3° 降到 −13°：5 − 3h = −13） / Write and solve a two-step equation from a situation with negatives (5° falling 3° per hour reaches −13°: 5 − 3h = −13) 〔应用〕

**勾股定理 · Pythagorean theorem**　`G8.GEO.02`

- `GEO.PYTH.MODEL` 用面积看勾股定理：两条直角边上的正方形面积加起来等于斜边上的正方形面积 / See the Pythagorean relationship as areas: the squares on the two legs together equal the square on the hypotenuse 〔概念〕
- `GEO.PYTH.IDENTIFY` 不管三角形怎么摆都能认出斜边和直角边；用 a² + b² = c² 判断是否直角三角形（勾股数） / Identify the hypotenuse and legs in any orientation, and test whether a triangle is right-angled with a² + b² = c² (Pythagorean triples) 〔推理〕
- `GEO.PYTH.HYPOTENUSE` 已知两条直角边求斜边，精确值或保留一位小数（5 和 12 → 13；4 和 7 → √65 ≈ 8.1） / Find the hypotenuse from the two legs, exactly or to one decimal place (legs 5 and 12 → 13; legs 4 and 7 → √65 ≈ 8.1) 〔步骤〕
- `GEO.PYTH.LEG` 已知斜边和一条直角边求另一条直角边：平方相减（斜边 10、直角边 6 → √(100 − 36) = 8） / Find a missing leg by subtracting squares (hypotenuse 10 and leg 6 → √(100 − 36) = 8) 〔步骤〕
- `GEO.PYTH.APPLY` 勾股定理应用：梯子、屏幕和球场的对角线、独木舟横渡有水流的河 / Apply the Pythagorean theorem to real problems: ladders, diagonals of screens and fields, a canoe crossing a current 〔应用〕

**三视图与展开图 · Views & nets of 3D objects**　`G8.GEO.03`

- `GEO.3D.VIEWS.DRAW` 画出用小方块搭的物体的俯视图、正视图和侧视图 / Draw the top, front and side views of an object built from cubes 〔表示〕
- `GEO.3D.VIEWS.BUILD` 由三视图还原或辨认立体图形，找出符合的最少方块数 / Rebuild or identify a 3D object from its top, front and side views, and find the fewest cubes that fit 〔推理〕
- `GEO.3D.NETS.MATCH` 把展开图和棱柱、圆柱配对，识别折不起来的展开图（6 个正方形却拼不成正方体） / Match nets to prisms and cylinders and spot nets that will not fold (six squares that don't make a cube) 〔推理〕
- `GEO.3D.NETS.DRAW` 画出长方体、三棱柱、圆柱的展开图并标上尺寸 / Draw an accurate net for a rectangular prism, triangular prism or cylinder with the dimensions labelled 〔步骤〕

**表面积与体积 · Surface area & volume**　`G8.GEO.01`

- `MEAS.SA.FROM_NET` 理解表面积就是所有面的面积之和，用展开图来算 / Understand surface area as the total area of every face, found from a net 〔概念〕
- `MEAS.SA.RECT_PRISM` 求长方体的表面积（2lw + 2lh + 2wh） / Find the surface area of a rectangular prism (2lw + 2lh + 2wh) 〔步骤〕
- `MEAS.SA.TRI_PRISM` 求三棱柱的表面积：两个三角形加三个长方形 / Find the surface area of a triangular prism: two triangles plus three rectangles 〔步骤〕
- `MEAS.SA.CYLINDER` 求圆柱的表面积：两个圆加一个长等于圆周长的长方形 / Find the surface area of a cylinder: two circles plus a rectangle whose length is the circumference 〔步骤〕
- `MEAS.VOL.PRISM_BASE_HEIGHT` 用底面积 × 高求直棱柱（三棱柱、梯形柱）和圆柱的体积 / Find the volume of right prisms (triangular, trapezoidal) and cylinders as area of the base × height 〔步骤〕
- `MEAS.SA_VOL.APPLY` 判断题目要的是表面积还是体积（刷漆还是装满），选对单位（cm² 与 cm³）并解题 / Decide whether a problem needs surface area or volume (painting vs. filling), pick the unit (cm² vs. cm³) and solve it 〔应用〕

**平均数、中位数与众数 · Central tendency**　`G8.DAT.01`

- `DATA.MEAN` 求平均数：总和 ÷ 个数（匀一匀），结果可以是小数 / Find the mean as a fair share (total ÷ count), including decimal means 〔步骤〕
- `DATA.MEDIAN_MODE` 求中位数（先排序；偶数个取中间两个的平均）和众数（可能没有，也可能不止一个） / Find the median (order first; average the middle two) and the mode (there may be none or more than one) 〔步骤〕
- `DATA.CENTRAL.COMPARE` 判断哪种统计量最能代表一组数据，解释极端值怎么把平均数拉偏 / Choose which measure best describes a data set and explain how an outlier pulls the mean 〔推理〕
- `DATA.MEAN.MISSING_VALUE` 从平均数倒推：要达到目标平均分，下一次得考多少 / Work backwards from a mean: find the score needed on the next test to reach a target average 〔推理〕
- `DATA.CENTRAL.APPLY` 用平均数、中位数、众数比较和解读真实数据（运动数据、班级调查、价格） / Use mean, median and mode to compare and interpret real data sets (sports stats, class surveys, prices) 〔应用〕

**两个独立事件的可能性 · Probability of two independent events**　`G8.DAT.02`

- `PROB.INDEP.SAMPLE_SPACE` 用树状图或表格列出两个独立事件的样本空间（硬币 + 骰子 = 12 种结果） / List the sample space of two independent events with a tree diagram or table (coin + die = 12 outcomes) 〔表示〕
- `PROB.INDEP.CONCEPT` 认识独立事件：一个结果不影响另一个（放回摸球与不放回摸球） / Recognize independent events: one outcome does not change the other (drawing with vs. without replacement) 〔概念〕
- `PROB.INDEP.MULTIPLY` 用乘法求两个独立事件同时发生的可能性（P(掷出 5 且正面) = 1/6 × 1/2 = 1/12） / Find the probability that two independent events both happen by multiplying (P(5 and heads) = 1/6 × 1/2 = 1/12) 〔步骤〕
- `PROB.INDEP.COMPARE_FAIR` 比较每个玩家获胜的理论可能性，判断游戏或转盘是否公平 / Decide whether a game or spinner is fair by comparing each player's theoretical probability of winning 〔推理〕
- `PROB.INDEP.APPLY` 两个独立事件的应用题（天气和公交、密码、游戏） / Solve probability problems with two independent events in context (weather and the bus, passcodes, games) 〔应用〕

### G9（8 个主题 · 49 个技能）

**有理数的四则运算 · Operations with rational numbers**　`G9.FLU.01`

- `RAT.CONCEPT` 认识有理数（分数、小数、整数，正负都有）并在数轴上定位 / Recognize rational numbers (fractions, decimals, integers, positive and negative) and place them on a number line 〔概念〕
- `RAT.COMPARE_ORDER` 比较和排序不同形式的有理数（−0.75、−2/3、−1/2、0.6） / Compare and order rational numbers written in mixed forms (−0.75, −2/3, −1/2, 0.6) 〔步骤〕
- `RAT.ADDSUB` 有理数加减：整数的符号规则加上分数、小数的功夫（−3/4 + 1/6） / Add and subtract rational numbers, combining the integer sign rules with fraction and decimal skills (−3/4 + 1/6) 〔步骤〕
- `RAT.MULTDIV` 有理数乘除，含负分数（(−3/4) ÷ 1/5 = −15/4） / Multiply and divide rational numbers, including negative fractions ((−3/4) ÷ 1/5 = −15/4) 〔步骤〕
- `RAT.POWERS` 有理数的乘方：分清 (−3)² 和 −3²、(4/5)² 和 4/5² / Evaluate powers of rational numbers and tell (−3)² from −3² and (4/5)² from 4/5² 〔步骤〕
- `RAT.ORDER_OPS` 有理数的混合运算，含括号和乘方（1 − 2 × (4/5)²） / Use the order of operations with rational numbers, brackets and exponents (1 − 2 × (4/5)²) 〔步骤〕
- `RAT.WORD` 有理数应用题（平均气温、账户余额、海拔变化、划桨尺寸） / Solve problems with rational numbers in context (average temperatures, account balances, elevation changes, paddle dimensions) 〔应用〕

**指数与指数运算律 · Exponents & exponent laws**　`G9.NUM.01`

- `EXP.MEANING` 认识非负整数指数的幂，底数可以是字母（2⁷ = 128，n⁴ = n × n × n × n） / Read and expand powers with whole-number exponents, including variable bases (2⁷ = 128, n⁴ = n × n × n × n) 〔概念〕
- `EXP.PRODUCT_QUOTIENT` 同底数幂的乘除：指数相加、相减（n⁵ × n³ = n⁸，y⁷ ÷ y³ = y⁴） / Multiply and divide powers with the same base by adding or subtracting the exponents (n⁵ × n³ = n⁸, y⁷ ÷ y³ = y⁴) 〔步骤〕
- `EXP.POWER_OF_POWER` 幂的乘方、积的乘方、商的乘方（(3²)⁴ = 3⁸，(5n)³ = 125n³，(m/n)⁵ = m⁵/n⁵） / Simplify a power of a power, of a product and of a quotient ((3²)⁴ = 3⁸, (5n)³ = 125n³, (m/n)⁵ = m⁵/n⁵) 〔步骤〕
- `EXP.ZERO_ONE` 用「每次除以底数」的规律说明为什么 6⁰ = 1、m¹ = m / Explain with the divide-by-the-base pattern why any nonzero base to the exponent 0 is 1 and to the exponent 1 is itself (6⁰ = 1, m¹ = m) 〔概念〕
- `EXP.SIGNS` 负底数的幂：说清为什么 (−3)² ≠ −3²、(−2)³ 是负的 / Evaluate powers with negative bases and explain why (−3)² ≠ −3² and (−2)³ is negative 〔推理〕
- `EXP.SIMPLIFY_MIXED` 综合运用几条指数律化简，指数保持非负整数（2³ × 2⁵ ÷ 2⁴；(x²y)³ × x） / Simplify expressions that combine several exponent laws, keeping exponents whole numbers (2³ × 2⁵ ÷ 2⁴; (x²y)³ × x) 〔步骤〕

**多项式 · Polynomials**　`G9.PAT.01`

- `POLY.PARTS` 说出多项式的变量、次数、项数、系数和常数项；认识单项式、二项式、三项式 / Describe a polynomial by its variables, degree, number of terms, coefficients and constant term; name monomials, binomials and trinomials 〔概念〕
- `POLY.TILES` 用代数砖表示多项式（x² 砖、x 砖、单位砖，分正负），能从砖图读出式子 / Model polynomials with algebra tiles (x², x and unit tiles, positive and negative) and read the expression from a tile picture 〔表示〕
- `POLY.ADD` 多项式加法：合并同类项（(x² + 2x − 4) + (2x² − 3x − 4) = 3x² − x − 8） / Add polynomials by collecting like terms ((x² + 2x − 4) + (2x² − 3x − 4) = 3x² − x − 8) 〔步骤〕
- `POLY.SUBTRACT` 多项式减法：把后面每一项都变号再加（(5x − 7) − (2x + 3) = 3x − 10） / Subtract polynomials by adding the opposite of every term ((5x − 7) − (2x + 3) = 3x − 10) 〔步骤〕
- `POLY.MULT_MONOMIAL` 单项式乘多项式：面积模型和分配律（2n(n + 7) = 2n² + 14n） / Multiply a polynomial by a monomial with an area model and the distributive property (2n(n + 7) = 2n² + 14n) 〔步骤〕
- `POLY.DIV_MONOMIAL` 多项式除以单项式：逐项除（(15k² − 10k) ÷ 5k = 3k − 2） / Divide a polynomial by a monomial term by term ((15k² − 10k) ÷ 5k = 3k − 2) 〔步骤〕
- `POLY.APPLY` 用多项式描述周长、面积、费用情境并化简（边长 2x + 3 和 x − 1 的长方形周长） / Use polynomials to model perimeter, area and cost situations, then simplify (perimeter of a rectangle with sides 2x + 3 and x − 1) 〔应用〕

**多步一元一次方程 · Multi-step linear equations**　`G9.PAT.03`

- `LINEQ.DISTRIBUTE` 先去括号再解方程（3(x − 4) = 2x + 1） / Solve equations that need the distributive property first (3(x − 4) = 2x + 1) 〔步骤〕
- `LINEQ.BOTH_SIDES` 等号两边都有未知数：把未知数集中到一边（5x − 2 = 2x + 7） / Solve equations with the variable on both sides by collecting variable terms on one side (5x − 2 = 2x + 7) 〔步骤〕
- `LINEQ.RATIONAL` 系数是分数或小数的方程：先去分母（1 + 2x = 3 − 2/3(x + 6)） / Solve equations with fraction or decimal coefficients by clearing denominators first (1 + 2x = 3 − 2/3(x + 6)) 〔步骤〕
- `LINEQ.PICTORIAL` 用天平或代数砖画出多步解方程的过程，每一步两边都保持相等 / Show a multi-step solution with a balance or algebra-tile picture, keeping both sides equal at every step 〔表示〕
- `LINEQ.VERIFY` 把有理数解代回方程两边验算，并找出错解错在哪一步 / Verify a rational solution by substituting into both sides, and find the step where a wrong solution went off track 〔推理〕
- `LINEQ.WORD` 从情境列多步方程并求解（两种手机套餐何时一样贵、连续整数、周长用式子给出） / Write and solve multi-step equations from situations (when two phone plans cost the same, consecutive numbers, a perimeter given as an expression) 〔应用〕

**二元线性关系 · Two-variable linear relations**　`G9.PAT.02`

- `LIN.CONTINUOUS` 区分连续和离散的线性关系，判断什么时候该把点连成线（时间 vs 票数） / Tell continuous from discrete linear relations and decide when the points should be joined (time vs. tickets) 〔概念〕
- `LIN.GRAPH_TABLE` 用有理数输入列数值表并画出直线，坐标轴刻度按有理数坐标来选 / Make a table of values with rational inputs and graph the line, choosing axis scales that fit rational coordinates 〔步骤〕
- `LIN.HORIZ_VERT` 认识并画出水平线和竖直线（y = 3、x = −2），说明为什么它们的方程只有一个变量 / Recognize and graph horizontal and vertical lines (y = 3, x = −2) and explain why their equations have only one variable 〔概念〕
- `LIN.INTERPOLATE` 内插：在已知点之间从图上读出近似值 / Interpolate: read an approximate value between known points on a line graph 〔步骤〕
- `LIN.EXTRAPOLATE` 外推：延长直线预测数据以外的值，并判断预测合不合理（独木舟行程的每日核对） / Extrapolate beyond the data by extending the line, and judge whether the prediction makes sense (canoe journey daily checks) 〔推理〕
- `LIN.ANALYZE` 分析线性图象：变化率就是斜率、y 截距的含义、方程怎么同时体现两者（y = 2.5x + 10） / Analyze a linear graph: the rate of change as slope, what the y-intercept means, and how the equation shows both (y = 2.5x + 10) 〔推理〕
- `LIN.APPLY` 用二元线性关系描述真实情境，用图回答问题（路程–时间、费用–用量） / Model a real situation with a two-variable linear relation and use the graph to answer questions (distance–time, cost–usage) 〔应用〕

**比例尺图与相似形 · Scale diagrams & similar shapes**　`G9.GEO.01`

- `SIM.UNIT_CONVERT` 公制长度单位换算（mm、cm、m、km，含小数），为比例尺做准备 / Convert between metric length units (mm, cm, m, km) including decimals, as needed for scale work 〔步骤〕
- `SIM.SCALE_FACTOR` 认识比例系数 = 像 ÷ 原：大于 1 放大、0 到 1 之间缩小；读懂 1 : 50 这样的比例尺 / Understand scale factor as image ÷ original: greater than 1 enlarges, between 0 and 1 reduces; read scales such as 1 : 50 〔概念〕
- `SIM.SCALE_DRAW` 在方格纸上按给定比例尺放大或缩小平面图形；从比例尺图求真实长度 / Draw an enlargement or reduction of a 2D shape to a given scale on grid paper, and find real lengths from a scale diagram 〔步骤〕
- `SIM.TRIANGLES_IDENTIFY` 判断两个三角形是否相似：对应角相等、对应边的比相同 / Decide whether two triangles are similar by matching equal angles and checking that corresponding sides share one ratio 〔推理〕
- `SIM.MISSING_SIDE` 用比例或比例系数求相似三角形、相似多边形的未知边 / Find a missing side in similar triangles or polygons using a proportion or the scale factor 〔步骤〕
- `SIM.INDIRECT_MEASURE` 用相似三角形间接测量：用影子求高度、河宽、长屋模型、壁画放大 / Use similar triangles to measure indirectly: heights from shadows, river widths, longhouse models, mural enlargements 〔应用〕

**社会中的统计 · Statistics in society**　`G9.DAT.01`

- `STAT.POP_SAMPLE` 区分总体与样本，说明什么时候该抽样（成本、时间、破坏性检测） / Tell a population from a sample and explain when sampling is the sensible choice (cost, time, destructive tests) 〔概念〕
- `STAT.SAMPLING_METHODS` 比较抽样方法（随机、系统、分层、方便、自愿），选一种能避免偏差的 / Compare sampling techniques (random, systematic, stratified, convenience, voluntary) and pick one that avoids bias 〔概念〕
- `STAT.BIAS` 找出调查里的偏差：诱导性提问、带倾向的用语、问了谁、时机、隐私与文化敏感性 / Spot bias in a survey: leading questions, loaded language, who was asked, timing, privacy and cultural sensitivity 〔推理〕
- `STAT.MISLEADING_GRAPHS` 识破误导性图表和统计：截断的坐标轴、不均匀的刻度、挑着选的区间、没说基数的百分比 / Detect misleading graphs and statistics: truncated axes, uneven scales, cherry-picked ranges, percents without a base 〔推理〕
- `STAT.CRITIQUE` 评析一组真实数据或新闻结论（加拿大统计局、原住民社区水质），提出更公平的收集或呈现方式 / Critique a real data set or news claim (Statistics Canada, First Peoples water quality) and propose a fairer way to collect or display it 〔应用〕

**理财：预算与收支 · Financial literacy: budgets & transactions**　`G9.NUM.02`

- `FIN.BANKING` 看懂银行对账单（存款、取款、借记、手续费、余额），根据一串交易算出余额 / Read a bank statement (deposits, withdrawals, debit, fees, running balance) and keep a balance from a list of transactions 〔概念〕
- `FIN.SIMPLE_INTEREST` 用 I = P × r × t 算单利：利率化成小数、时间按年算（月份换成年的分数） / Compute simple interest I = P × r × t with the rate as a decimal and time in years (months as a fraction of a year) 〔步骤〕
- `FIN.SAVINGS_GROWTH` 比较储蓄方案：本金、利率、时间各自怎么影响利息；到期总额 = 本金 + 利息 / Compare savings options: how principal, rate and time each change the interest, and total = principal + interest 〔推理〕
- `FIN.BUDGET_PLAN` 做一份月度预算：收入、固定支出、变动支出、储蓄，核对是否平衡 / Build a monthly budget with income, fixed and variable expenses and savings, and check that it balances 〔步骤〕
- `FIN.PLANNED_PURCHASE` 为一次购买或活动做计划（举办原住民聚会、买手机）：比较攒够再买和分期付，并调整预算 / Plan a purchase or event (hosting a First Peoples gathering, buying a phone): compare saving up with paying over time, and adjust the budget 〔应用〕

<!-- TREE:END -->

---

## 5. 试点三条标准

| 试点 | 技能数 | 验证什么 |
|---|---|---|
| G5 等值分数 `G5.NUM.03` | 7 | 跨年级先修（G4 平均分、模型 → G5）、图形表示 vs 符号表示的分离、最经典的两个误区（同加、只乘一边） |
| G6 因数倍数 `G6.NUM.02` | 8 | 一条标准拆成一串**顺序**技能（因数 → 质数 → 整除 → 质因数 → GCF / LCM → 应用）、GCF/LCM 互换这类「对称误区」 |
| G7 分数/小数/比/百分数 `G7.NUM.01` | 8 | 多种表示之间的**关系图**（每个技能都是一条转换边）、跨多个低年级主题回补（G5 小数、G6 百分数 / 比） |

G5 等值分数的诊断分支长这样（`diag.branch` 展开）：

```text
等值分数题答错
├── 选了「2/3 = 3/4」（frac.add_same_number）      → 回 FRAC.EQUIV.VISUAL，用分数条再看一次
├── 选了「2/3 = 4/3」（frac.multiply_one_part）     → 回 FRAC.EQUIV.SAME_WHOLE，整体和平均分
├── 图形题对、符号题错                                → 不是概念不懂，是表示转换弱：NUMBERLINE 级再测一次
├── 乘法口诀错（mult.fact_error）                    → 回 FLU.MULT.FACTS.EMERGING
└── 整体不同还拿来比（frac.different_whole）        → 回 FRAC.MODELS.REGION_SET_LINEAR（G4）
```

---

## 6. 掌握度、诊断与回补

**技能级**：完全沿用 `progress` 事件和 `progressLevel()` 四级，只是 key 从 `curriculumId` 变成 `skillId`。闯关规则（L1 起步、对升错降、L3 连对 2 题通关 → Proficient）不动。

**标准级（新增，汇总出来的）**：

| 等级 | 规则（只看 `core:true` 的技能） |
|---|---|
| Emerging | 没有任何技能有记录 |
| Developing | 任一技能有记录 |
| Proficient | 全部核心技能 ≥ Proficient |
| Extending | Proficient，且（任一 `apply` / `reason` 技能 Extending，或本主题单元卷 ≥ 80%） |

家长星标保留，但只作为 override 显示「家长标记」，不再与系统证据等价（报告里分开列）。旧用户在 `curriculumId` 上的进度**不自动等价**成所有子技能已掌握，记成 `legacyEvidence: { standardId, confidence: "low" }`，靠后续做题校准。

**误区标签**：题库每道题的 4 个选项各挂一个 `tag`（正确项 `ok`，干扰项是 `misc[]` 里的 id）——出题提示词本来就要求「干扰项必须来自真实常见错误」（qbank-standard §2），只是把它显式化；`validateQbankBatch`（`server.js:864`）校验 tag 必须在该技能的 `misc[]` 里。同一误区被触发 ≥2 次 → 按 `diag.branch`（没有就按登记表的 `remedy`）把回补技能插到「今天学什么」前面，回补后用**另一种表示**再测本技能。

**诊断**：不做 45 分钟大诊断。主题级「摸底」= 每个核心技能出 1 道 L2 题（沿用题库），5–8 题定出本主题的暂定状态；之后靠平时闯关持续采集。跨年级的 `prereq` 边（120 条）就是 Khan「Get ready for」的自动版：一个技能卡住时，往下追先修链直到找到最近的未掌握技能。

**家长报告两棵树**：官方树「本学期 19 条内容，已扎实 9 条」（BC 四级话术不变）→ 展开任一条看到具体是哪个技能没过、卡在哪个误区。

---

## 7. 对现有代码的影响与最小改动路径

原则：不改 `curriculumId`，不移动 `qbank.json` / `data/lessons` 里的任何东西，不删 `starred`。

### 阶段 0 · 数据与校验（已完成）

`data/curriculum/skills/{g4,g5,g6,g7,misconceptions}.json` + `tools/curriculum/skills_check.mjs`。

### 阶段 1 · 接进运行链路（已完成，2026-08-22）

| 改动点 | 位置 | 落地情况 |
|---|---|---|
| 加载技能视图 | `server.js` 加载器 | 两遍加载（先建 `skillIndex` 再解析先修/复习），每个年级生成一个 `type:"skills-preview"` 课程对象：`strandDefs`=主题、`items`=技能，key `skills-g5`。走的就是书籍那条路，所以列表 / 闯关 / 主题测试 / 进度 / 报告全部零改动跑通。item 上多挂一个 `skill` 字段（类型、表示、先修、误区、诊断分支），老代码不认也不受影响 |
| 讲课提示词 | `systemPromptTeach` / `En` | 中英各加 `isSkills` 分支：定位成 3-5 分钟**微课**、4-6 步（`lessonFieldsZh/En` 新增 `stepHint` 参数）、origin 段写「这一小步 + 所属标准原文 + 已会的先修 + 本技能常见误区」，并要求专门用一步演一遍误区；练习题按 `rep[0]` 出 |
| 题库 | `qbankPrompt` / `validateQbankBatch` | key 用 skillId；新增 `skillRules` 段：L1 必须用 `rep[0]`、干扰项逐个建立在登记在册的误区上、每题输出 4 个 `tags`。校验白名单来自该技能的 `misc[]`，**标签不合格只丢标签、不丢题**（判分不看标签）。`QBANK_HINT_SKILL` 带上 tags 的格式说明 |
| 进度汇总 | `standardRollup(kid, standardId)` | 按 §6 从核心技能汇总出标准级别；`/api/report` 每条标准多带一个 `skills:{level,total,touched,proficient,legacy}`。没有技能挂靠的标准返回 null，G8/G9、高中、书籍的报告完全照旧 |
| 旧进度 | 同上的 `legacy` 字段 | 孩子在 BC 标准 id 上有老进度、但一个技能都没做过 → `{level, confidence:"low"}`，不等价成「子技能全会了」 |
| 误区 → 回补 | `missRecord` / `remediationFor` | 闯关答错且该选项挂了误区标签就记一笔（前端 `results` 多传 `picked`）；同一误区攒到 2 次触发回补，按技能自己的 `diag.branch`（没有就按登记表 `remedy`）给出该回去补的技能。`/api/quiz/finish` 和技能列表都会返回 |
| 前端列表 | `renderLearn` | 主题可折叠（第一个默认展开）、标题带「已扎实/总数」和对齐的标准号；技能行带类型徽章（6 色）、先修数、易错点数、复习来源年级、拓展标记；触发回补的技能显示 🩹 提示并可一键跳去补那条 |
| 总览课 | 同上 | 原来那 69 节「一条大纲一节课」降级成主题的总览课（🎓 行，每条对齐标准一行），走预生成包，实测 84 ms 返回、零引擎成本 |
| 预生成 | `tools/pregen.mjs` | 2026-09-02 起默认做（`--no-skills` 跳过）；`--grades 5 --only quiz` = 只给 G5 出题库 |
| 打包 | `tools/pack.mjs` | 2026-09-02 起默认**进包**；种子题库按前缀过滤，`YY.*` 默认带、`--no-skills` 去掉 |

验证方式：隔离实例（`YY_DATA_DIR` 指到临时目录 + 空 users.json，不碰真实孩子数据）跑通了目录渲染、折叠、标准汇总、legacy 证据、误区触发回补、总览课秒开；微课用本地 Ollama 实跑了一节，5 步、含误区演示、练习用 fractionBar，符合提示词要求。

### 阶段 2 · 内容铺开（已完成，2026-08-23）

**468 份核心技能题库（234 技能 × 中英）全部落地**，5556 题，在 `qbank.json`（gitignore，`pack.mjs` 默认随包发）。

怎么跑的：`pregen --skills --only quiz --core --provider claude --judge`，生成和审稿都是 Claude Code CLI（Opus 5 · effort high，走 Max 订阅），并发 2，444 份用时 11 小时，单份均速 1.4 分钟。

最终体检：难度 1862/1846/1848、答案位置 1415/1405/1392/1344（服务端入库时强制打散）、有误区的 360 份 tags 覆盖 **100%**、坏标签 0、选项重复 0、引用不存在图形 0、每级不足 2 题 0。

路上踩的坑和结论（详见记忆 `ollama-quiz-generation-lessons`）：
- 本地 qwen3.8（实为 27B Q4）出这种带误区标签的题成品率只有 50%，且老题库从未审过、抽 3 份 2 份解析有错——放弃本地生成。
- 审稿改成按题剔除（`JUDGE_HINT_QUIZ` + `bad:[序号]`），12 道错 1 道只丢 1 道：整批拒绝 0 次、按题剔除 54 次。
- `validateQbankBatch` 之前把全 other 的 tags 当空壳丢掉，是 tags 覆盖率低的真因，已修。
- Claude CLI 超时 300 → 600 秒（个别知识点 effort high 要想 5 分钟以上）。
- 旧 BC 题库的 skillId 标签仍未做（拓展技能的 11 份 en 题库 2026-09-01 已按 iOS 端清单去掉 `--core` 补跑，en 245/245；zh 按 2026-08-26 冻结维持 234）。
- **老 BC 题库已全量送审**（2026-08-23，`tools/audit_qbank.mjs`）：234 份审 35 份不过，剔 42 题（1.5%）；错误类型：解析算错 20、跑题 10、标答错/两个正确 6、题干矛盾 2。剔后用 `pregen --only quiz --force --provider claude --judge` 补齐（41 次生成，0 失败）。删掉的题在 `audit-report.jsonl`。
- **技能视图已成为 G4–G7 的默认清单**（`learnView()`）：选年级即「主题 → 技能」，老主线清单 `view=standards` 仍可取但界面不露出；单元测试按主题（存档 key `skills-g<N>`）；FSA 仍按主线（`fsaStrands`）；家长报告按技能汇总定级。主题级单元卷尚无预生成包（108 份），点 📝 现场出。微课只烤了 2 节示例（`pregen --skills --only lessons`，490 节待决定）。

### 阶段 3 · G8–G9、高中、书籍（G8 2026-09-02、G9 2026-09-03 已做）

**G8 已落地**：`data/curriculum/skills/g8.json`——14 个主题（一条 BC 标准一个主题，教学顺序：平方立方 → 根 → 分数运算 → 百分数 → 比与比例 → 比价理财 → 代数式 → 线性关系 → 两步方程 → 勾股 → 三视图展开图 → 表面积体积 → 集中趋势 → 独立事件）、71 个技能（69 核心；拓展 2 条：合并同类项、x/3 + 5 = 2 型方程），每标准 5.1 条（G8 一条标准的跨度比小学大，拆细是对的）。
先修 122 条边（大半接到 G6/G7 技能：G7 的整数、两步方程、线性关系、圆和体积，G6 的比、百分数、质因数），误区新登记 60 条（前缀 cube / root / pyth / views / nets / sa / mean / median / rate / prop / expr 等），`sq.*` 四条沿用 G7 平方数主题。
平方数主题（G7，`core:false`，supporting G8.NUM.01/02）以 `topic.review` 借进 G8 前两个主题末尾复习，不复制定义。
内容：`pregen --grades skills-g8 --provider claude --judge claude`（142 微课 + 142 题库 + 28 主题卷；语气走 `seniorTone(8)` 初中腔，干扰项提示按 ≥8 年级那组）。语音按 2026-09-02 的决定不烘，走系统 TTS 兜底。
**G9 已落地（2026-09-03）**：`skills/g9.json`——8 个主题（一条标准一个主题：有理数运算 → 指数律 → 多项式 → 多步方程 → 二元线性关系 → 比例尺与相似 → 社会统计 → 预算与收支）、49 个技能（全部核心），每标准 6.1 条；先修接 G8（分数运算、两步方程、线性关系、比例、百分数）和 G6/G7；误区新登记 42 条（exp / poly / lin / sim / stat 等）。内容由 **Claude Fable 5.1**（`config.claude.model = claude-fable-5-1`，effort high）生成 + 审稿：`pregen --grades skills-g9 --provider claude --judge claude`。语音同样不烘。
**高中、书籍仍未做。** 同一 schema，加载器已经泛化（读任意 `skills/g<N>.json`），缺的是数据文件本身。高中 `course-*.json` 的 `strandDefs` 本来就是单元、只缺技能层；书籍小节已经够细（AoPS 预备代数 68 节），可以直接当技能用、只补 `primary` 和先修边。

### 不做的事

- 不把 `CurriculumItem` 改名、不给旧 id 换皮。
- 不先搬目录再补模型（报告的警告，完全同意）。
- 不做 IRT / 贝叶斯推断：确定性规则 + 误区标签在这个数据量下够用，而且离线可解释。

---

## 8. 已知问题与待决策

1. **数据缺口**：`grade-5.json` 四条 `elaborations` 为空（见 §1）。拆技能时按官网原文补了，但源文件该修。
2. **G5「乘除到三位数」的范围** BC 没写明。草稿按 3 位 × 1 位、2 位 × 2 位、3 位 ÷ 1 位 + 余数拆；如果学校实际只到 3 位 × 1 位，砍掉 `FLU.MULT.2D_BY_2D` 即可。
3. **主题跨主线**：G7 把坐标系（GEO.03）并进「线性关系」主题、G6 把坐标描点并进「坐标与组合变换」——教学上顺，但单元卷按主题出就会跨主线。FSA 和家长报告仍按主线，不受影响。
4. **技能总数 245** 对应 490 份题库。若觉得重，先只生成核心技能（234），或把 `fluency` 类（10 个）改成不出题、只靠课内练习。
5. **理财**在界面上怎么展示：主题已打 `domain:"financial-literacy"`，是单独一个分组色，还是独立 tab，看 UI 再定。
6. **High-school 技能层**什么时候做：取决于 G4–G7 试点跑完后的体验；schema 已经兼容。
