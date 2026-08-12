# BC 大纲对齐 · 开发计划

> 目标：把圆圆数学从「来一题讲一题」升级为「知道孩子这学期该学什么」——按 BC（British Columbia）省数学大纲系统教学。
> 依据：2026-08-12 竞调结论（加拿大市场"大纲对齐"与"AI 语音讲题"两阵营不相交，BC 比安省更空，"中文讲 BC 大纲"无人做）。
> 原则：**复用现有讲题流水线**（LESSON_SCHEMA / 36 种图形 / TTS / 历史记录全部不动或最小改动）；**保持零依赖架构**（大纲数据 = 构建期生成的静态 JSON，运行期只读、离线可用）。

---

## 全景：五个阶段

| 阶段 | 交付物 | 依赖 | 粗估工作量* |
|---|---|---|---|
| P1 大纲数据管道 | `data/curriculum/bc/` 结构化 JSON（G4-G7 + 中文层） | 无 | 1-2 天 |
| P2 「按大纲学」MVP | 新学习入口 + teach 模式 + 进度标记 | P1 | 2-4 天 |
| P3 家长报告 | 覆盖率报告页（BC 官方四级话术、双语） | P2 | 1-2 天 |
| P4 FSA 备考模式 | G4/G7 FSA 风格情境题成套练习 | P2 | 探索性 |
| P5 扩展 | K-3、G8-9、高中 FOMP10→PC11/12、法语 | P2 | 按需 |

\* 按"独立开发者 + Claude Code 协作日"粗估，含调试。

**建议节奏**：P1 先只做 Grade 4 打通全链（数据→讲课→进度），验证体验后再补 G5-G7，避免在数据层一次铺太宽。

---

## P1 大纲数据管道

### 1.1 数据源（全部官方公开）

- K-9 全册（含 elaborations）：`https://curriculum.gov.bc.ca/sites/curriculum.gov.bc.ca/files/curriculum/mathematics/en_mathematics_k-9_elab.docx`（同路径有 PDF；June 2016 版）
- 每年级网页版（核对用）：`https://curriculum.gov.bc.ca/curriculum/mathematics/4/core` 等
- K→9 分主线进阶表（先修链素材）：`.../continuous-views/en_math_k-9_content.pdf`
- 大纲 2016 年定稿至今无修订计划，可放心作为基线；法语镜像同站（P5 用）。

### 1.2 解析脚本

`tools/curriculum/parse_bc.py`（一次性构建工具，跑在开发机；用 `python-docx`，可在现有 WSL/conda 环境装）：

- 输入：官方 DOCX（elaborations 版）
- 输出：`data/curriculum/bc/grade-4.json` … 每年级一个文件
- 解析目标：每年级 5 条 Big Ideas + 约 13-18 条 Content 及其 elaborations 子条目
- **BC 官方没有条目编号，需要自铸稳定 ID**：`BC.MATH.G4.NUM.01` 格式，主线段按五大 strand 归类（number / computational-fluency / patterning / geometry-measurement / data-probability；financial literacy 条目归入 number）。ID 一旦发布不再变更（进度数据挂在上面）。

### 1.3 数据 Schema

```jsonc
// data/curriculum/bc/grade-4.json
{
  "jurisdiction": "BC",
  "grade": 4,
  "source": {
    "url": "https://curriculum.gov.bc.ca/curriculum/mathematics/4/core",
    "version": "June 2016",
    "fetchedAt": "2026-08-xx"
  },
  "bigIdeas": [
    { "strand": "number", "en": "Fractions and decimals are types of numbers that can represent quantities.", "zh": "分数和小数都是数，都可以用来表示数量。" }
  ],
  "items": [
    {
      "id": "BC.MATH.G4.NUM.02",
      "strand": "number",
      "en": "decimals to hundredths",           // 官方原文 verbatim，不改写
      "zh": "认识小数（到百分位）",               // 中文标题（给孩子/家长看）
      "elaborations": [
        { "en": "counting: multiples, flexible counting strategies, whole number benchmarks", "zh": "…" }
      ],
      "terms": [ { "en": "decimal", "zh": "小数" }, { "en": "hundredths", "zh": "百分位" } ],
      "teachHints": "适合的 visual：placeValue、hundredthsGrid、numberLine"   // 可选，给提示词用
    }
  ]
}
```

要点：

- **原文 verbatim 保留**（`en` 字段不做任何改写），加 `source` 版本信息——这是"真对齐"和"prompt 里塞一句你是 BC 老师"的区别，也是应对大纲将来修订的版本守卫。
- **中文层（`zh` / `terms`）由 AI 辅助翻译 + 人工逐条校对**。这是华人家庭卖点的质量底线，G4 一个年级只有十几条，校对成本可控。术语表沉淀成 `data/curriculum/bc/terms.json` 全年级共享（数感 = number sense、展开图 = net…），讲课提示词和报告都引用它。
- `teachHints` 把每条知识点和现有 36 种 visual 类型预关联（人工标一次），提高讲课时配图命中率。

### 1.4 校验（P1 验收标准）

- 每年级条目数在 13-18 之间；五大主线齐全；与官网网页 spot check 三条无出入。
- 中文层每条经人工过目；术语表无空缺。
- `node -e "require('./data/curriculum/bc/grade-4.json')"` 通过（JSON 有效性入 CI 习惯，虽然本项目没有 CI，写进 start 自检也行）。

### 版权注意

BC 大纲是省政府 Crown copyright。教学产品**引用原文并注明来源**属常规做法（IXL/StudyPug 等都全文对照），但正式对外发布/商用前应过一遍官网 copyright 条款；数据文件里已带 `source.url`，前端展示条目时顺带显示"BC Curriculum · June 2016"来源标注即可。

---

## P2 「按大纲学」模式 MVP

### 2.1 后端（server.js）

**新增：大纲 API**

```
GET /api/curriculum?grade=4        → { grade, bigIdeas, strands: [ { strand, items: [ {id, en, zh, status} ] } ] }
```

- 启动时把 `data/curriculum/bc/*.json` 读进内存（和 history 一样的模式，见 server.js:669 附近）。
- `status` 来自进度存储（见 2.3），三态：`new`（没学过）/ `seen`（讲过）/ `solid`(扎实)。

**扩展：/api/lesson（server.js:792）**

请求体新增两个可选字段：

```jsonc
{ "mode": "teach",                  // 缺省 "solve"（现状，讲一道题）
  "curriculumId": "BC.MATH.G4.NUM.02", ... }
```

- `mode === "teach"` 时，`question` 可为空；服务器按 `curriculumId` 查出条目，生成 teach 版系统提示词。
- 响应和现在完全一样（一节课 JSON），前端 lesson player、TTS、历史记录零改动；`historyAdd` 的记录里加存 `curriculumId` 和 `mode`。

**新增：teach 模式提示词**（在 `systemPrompt()`（server.js:116）旁加一个变体，共用 visual 目录那一大段）：

```
你是「圆圆老师」…（同现有开场）
这节课不是讲一道题，而是给孩子讲一个新知识点。
知识点来自加拿大 BC 省 Grade 4 数学大纲（number 主线）：
  官方原文：decimals to hundredths
  包含子技能：…（elaborations）
  中文说法：认识小数（到百分位）；术语对照：decimal=小数, hundredths=百分位
课的结构（仍然输出 5-8 步 steps）：
  1. 用生活例子引出这个概念（为什么有它、它解决什么问题）
  2. 讲清楚核心方法，配图（优先用：placeValue、hundredthsGrid、numberLine）
  3. 带着孩子做 1-2 个由浅入深的例题
  4. 小结口诀
say 里自然提到英文关键术语一两次（比如"小数，英文课上叫 decimal"），孩子在学校听英文课能对上号。
practice 出一道贴合该知识点、BC 生活场景（加元、公制单位）的练习题。
```

- 英文版对称处理（`lang === "en"` 时全英文授课，不插中文）。
- LESSON_SCHEMA、validateLesson 完全不动。

**新增：进度 API**

```
POST /api/progress   { "curriculumId": "...", "event": "taught" | "practiced-right" | "practiced-wrong" | "mark-solid" }
GET  /api/progress?grade=4
```

### 2.2 进度存储与规则

`progress.json`（复用 history.json 的原子写模式，server.js:677）：

```jsonc
{ "BC.MATH.G4.NUM.02": { "taught": 2, "right": 3, "wrong": 1, "lastAt": 1786…, "solid": false, "lessonIds": ["…"] } }
```

状态推导（先用最简规则，不搞算法）：

- `seen`：讲过 ≥1 次
- `solid`：练习答对 ≥2 次**且分布在不同日期**，或家长手动标记
- 练习对错先靠前端"答对了吗 ✓/✗"两个按钮（现有 practice 已展示答案给家长核对，顺手加按钮即可），AI 自动判题不进 MVP。

### 2.3 前端（public/index.html）

- 顶部新增入口 tab：**「跟大纲学 / Learn」**，与现有"出题讲课"并列。
- 视图：年级选择（复用 `gradeCode`，需把选项扩到 G4-G7，见 index.html:438 附近的下拉填充）→ 五大主线分组的知识点清单，每条显示中文标题 + 英文原文小字 + 状态点（灰=new / 蓝=seen / 绿=solid）→ 点击即调 `/api/lesson {mode:"teach"}`，进现有播放器。
- 课末练习区加"答对了 ✓ / 还不会 ✗"按钮 → `POST /api/progress`。
- i18n 词条补充（zh/en 各 ~10 条）；`gradeText()` 语义改为 "BC Grade N"（中文界面显示"BC 四年级"）。
- 迁移注意：现有 `cfg.gradeCode` 4/5/6 直接沿用，加 7；旧 history 记录无 `curriculumId` 字段，展示时兼容缺省。

### P2 验收标准

- 选 G4 → 看到全部主线和条目（双语）→ 点任一条能生成一节完整可播的课（语音、配图正常）→ 练习标记后回到清单状态变化 → 重启服务进度还在。
- 中文课里英文术语出现自然、不生硬（抽查 5 节）。

---

## P3 家长报告

- `GET /api/report?grade=4` → 按主线汇总：`{ strand, total, seen, solid, items: [...] }`。
- 前端"家长看"视图（从历史面板旁入口进）：
  - 头部一句话：**「本学期 Grade 4 数与运算 12 条内容，已扎实 9 条」**——这是 Kumon 给不了的一句话。
  - 每条状态用 **BC 官方四级话术**呈现（Emerging / Developing / Proficient / Extending 映射到 new/seen/solid+，中文对照"起步/发展中/扎实/拓展"）——和 2023 年起 BC 学校成绩单同一套语言，家长看得懂。
  - 每主线配 Big Idea 的双语解释（"这学期为什么学这个"）。
- 可选：导出/打印样式（家长拿去和老师面谈用，传播点）。

---

## P4 FSA 备考模式（G4 / G7，探索性）

- FSA = BC 4/7 年级秋季全省数学素养测评（菲莎排名数据源，华人家长高度关注；市面无任何专门备考 App）。
- 做法：研究官方样题风格（`gov.bc.ca` FSA samples + Vretta 线上样卷）→ 新 prompt 变体生成**FSA 风格的多步骤情境题**（不复制官方题——版权 + 没必要），按主线组卷，计时练习 + 讲解闭环（错题直接转 teach 模式讲对应知识点）。
- 营销节点：FSA 在秋季（10-11 月），倒推 9 月是上线窗口。
- 前置：G7 数据（P1 已含）+ G7 讲解语气微调（现有提示词是 10-12 岁定位，G7 恰好在边上）。

---

## P5 后续扩展（不进当前计划，只记方向）

- **K-3**：讲解语气要更低幼（步子更小、更多具象图），提示词按年级分层。
- **G8-9** → **高中 FOMP 10 → Pre-calculus 11/12**：高中是 BC 空得最彻底的段位（无省考，拼课内成绩），但需要新增函数图象类 visual（抛物线、指数、三角函数图）——是一次图形系统的扩容，单独立项。
- **法语**：官方法语镜像条目一一对应，schema 里加 `fr` 字段即可承载，等英文版跑通再说。
- **多省**：schema 的 `jurisdiction` 字段已预留；安省（有官方编号）将来映射进同一结构。

---

## 风险与开放问题

1. **teach 模式讲课质量**是 MVP 的真正不确定项——讲知识点比讲题更容易空泛。对策：`teachHints` 预关联 visual、prompt 里强制"例题驱动"、先在 G4 的 number 主线上密集试课调优。
2. **中文翻译校对**是华人卖点的质量底线，必须人工过（量不大）。
3. **版权**：对外发布前过一遍 BC 官网 copyright 条款（引用+署名的常规做法风险低）。
4. **判题**：MVP 用家长/孩子自报对错，防"AI 判错打击孩子"；后续再考虑 AI 判题。
5. **进度归属**：目前单孩子（`kidName` 一个）。多孩子家庭 progress 要按 kidName 分桶——schema 预留即可，MVP 不做。

## 动工顺序（下一步就做）

1. `tools/curriculum/parse_bc.py` + G4 数据（含中文层人工校对）
2. server.js：`/api/curriculum` + teach 提示词 + `/api/lesson` 扩展
3. index.html：「跟大纲学」tab + 进度按钮
4. 试课调优 → 补 G5-G7 数据 → P3 报告
