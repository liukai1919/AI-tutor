# 项目交接（2026-09-05 审查 → 当天已修复）

> **复审更新（2026-09-05，HEAD `e7fb2f6`）**：原 S1–S3、F1–F4 的主要修复已复核通过，S4 全量配图检查已零违规。本次新增 v3 及场次票逻辑仍有 3 项 P2，详见末尾 §5（三项已于当晚修复并验证，见 §5 末表，尚未提交）。下文“尚未提交”是修复时的历史状态；复审时业务改动已提交，工作树仅有未跟踪的 `config.json.pre-g9.bak`（本次另更新此文档）。

基准：`533fe35`（dev）+ 工作树。2026-09-05 上午的代码审查列出 8 项问题（S1–S4、F1–F4），当天下午核实全部成立并**全部修复、验证**，外加一处审查没抓到的内容错误。**所有改动尚未提交**，和 G9 半成品混在同一个工作树里（见 §4）。

## 1. 修了什么（按原审查编号）

| 项 | 修法 | 改动位置 | 验证 |
|---|---|---|---|
| S1 安装包漏配图契约 | `stageApp` 拷 `visual-contract.json`，缺文件直接打包失败；接口读不到契约回 **503 + `missing:true`**（不再回空 `{types:{}}` 冒充契约）；前端非 2xx 视为无契约、放行 | `tools/pack.mjs` stageApp；`server.js` `/api/visual-contract`；`public/index.html` `loadVisualContract` | 隔离实例：200 含 `fractionBar`；改名契约文件重启 → 503 `missing:true` |
| S2 统计图截断后才数类别 | `statSeries` 规则先按原始形状（单列 / 复式带系列名 / 复式无名 / 兜底）数类别，再判上限；非 `allowNeg` 的统计图出现负数也判违约（以前被悄悄丢掉、标签错位） | `public/visual-check.js` | 9 类 statBar → `9 个类别超过上限 8`；全量内容扫描：负数 0 处、兜底形状 3 处（仍合法） |
| S3 非数字必填值放行 | `nums` 必须是数组，给出的每个位置必须是数字，先于所有规则检查；可选位的写法是「不给」 | `public/visual-check.js` | `["bad",3]` → `nums[0] = "bad" 不是数字`；全量内容非数字 0 处，无误伤 |
| S4 九处配图违规 | 逐处按教学含义改数值 / 图型 / 说明，契约没放宽（明细见 §2） | 7 个课程文件 | preflight `972 文件 / 5986 步 / 4574 图步 · 零违约`；改过的图用 index.html 的真实渲染函数各画一遍，SVG 非空 |
| F1 闯关信任客户端 `correct` | `/api/quiz/session` 随题包发**场次票** `session`；`/api/quiz/finish` 凭票结算：对错由服务端按题库 `answerIndex` 判、只认这一场发出的 qid、一票一结，无票 / 票已用 → 400 `staleSession`。前端 3 处结算都带票 | `server.js` `quizOpen*` + 两个接口；`public/index.html` `enterQuiz` / `finishQuiz` / 中途退出 / 切语言；`docs/qbank-standard.md` §4 补了一条 | 错误选项配 `correct:true` → `passed:false`；真答对 → `solid`；重放 / 无票 / 别人的票 / 别场的题 → 400 或忽略（7 条） |
| F2 完整报告漏技能进度 | 新增 `standardEvidence(kidId, standardId)`：级别 = 家长星标 > 技能汇总 > 老口径；计数 = 标准自己 + 挂靠技能合计。实时报告和 `buildReportDigest` 都改用它；近 14 天统计的 id 集合含技能；单元卷同时认 `5` 和 `skills-g5` 两个 key | `server.js` | 桩引擎跑通完整报告：digest 与实时报告的 right/wrong/level 一致；`itemsTouched 7`、`quizPassed 1`；`skills-g5` 主题卷进了数字年级报告 |
| F3 中途退出卷当成绩 | `done === false` 的那次不进 `unitRecent`（老存档没 `done` = 做完了） | `server.js` `buildReportDigest` | 1/8 退出卷被排除，8/8 完整卷保留 |
| F4 续期只在内存 | 节流改成和「上次真正落盘的到期时间」比（`savedExpiresAt`，`sessionsSave` 写盘前盖章） | `server.js` `auth()` / `sessionsSave()` | 可控时钟：逐小时 30 次后磁盘前移 24 h；逐日到第 59 天；第 61 天重启 token 仍有效；闲置 61 天的 token 401 |

审查里 S1 的影响范围说过头了：`build/` 里所有安装包都是 08-18 打的，契约文件 08-25 才加入，没有任何已发布的包受影响，苹果导出（`export_apple.mjs`）本来就带契约。准确说法是「下一次 pack 会全课无图」，现在已堵住。

**行为变化要知道的**：实时报告 `/api/report` 里每条标准的 `taught / right / wrong` 现在是「标准自己 + 挂靠技能」的合计（以前只算标准 id 自己那条），前端 ✓✗ 数字会变多——这是修 F2 的本意，两份报告才对得上。

## 2. S4 内容改法明细（8 处 + 审查没抓到的 1 处）

| 文件 | 步 | 原来 | 改成 | 为什么 |
|---|---|---|---|---|
| `en/YY.MATH.LIN.CONTINUOUS` | 4、5 | coordGrid 12 元一张票 (1,12)…(4,48)，超出坐标上限 12 | 学校电影夜 3 元一张 (1,3)…(4,12)；`say`、`math`（C = 3n）、「2.5 张票 = 7.5 元」一并改 | zh 版本来就是 3 元；G9 语音未烘，改 say 无代价 |
| `en/YY.MATH.PCT.BEYOND100.CONVERT` | 2 | hundredthsGrid [100,22]，一张百格图装不下 122 | barModel [100,22]「一整份 100 + 再多 22」 | 百格图合计 ≤ 100 是硬约束 |
| 同上 | 3 | numberLine 0–0.01 打 1/10 刻度，点落不到刻度上 | hundredthsGrid [1]：一格 = 1%，半格 = 0.5% | 旁白本来就说「看这张格子图，只有一格的一半」，和 zh 版一致 |
| `en` + `zh/YY.MATH.RAT.POWERS` | 5 | fractionBar 25 份，超过分母上限 20 | areaGrid [5,5,4,4]：5×5 里取 4×4 = 16/25 | (4/5)² 本来就是面积，比分数条更贴切；caption 说明 4/5² 只有 4 格 |
| `en/YY.MATH.RATIO.SHARE` | 3 | barModel 10 段（最多 6 段），且只画了 15 份中的 10 份 | areaGrid [1,15,1,1]：15 等份全画、涂出一份 = 7 cm | 忠实于「15 等份、一份 7 cm」 |
| `en/YY.MATH.SIM.UNIT_CONVERT` | 2 | dataTable `nums` 为空 | 表头「1 cm = ? mm …」，值 [10,100,1000,1000] | 照 zh 版写法 |
| `zh/YY.MATH.NUM.POWERS.SQUARE_CUBE_COMPARE` | 3 | solidCube 有图无 caption | caption「长四个、宽四个、高四个：4 × 4 × 4 = 64 个小方块」 | 看图模式需要文字 |
| `en/YY.MATH.PAT.INC_DEC.RULE`（审查没抓到） | 4 | dataTable 三行表：12 个值配 3 个标签，渲染端兜底截成 8 个值、标签错位（一直画错） | 两系列表：表头 Week 1–4，两行「Wrong: add 4」「Right: add 3」 | S2 变严后才被 preflight 揪出；只改 visual，语音不受影响 |

## 3. 验证记录（可复跑）

- `node --check server.js / public/visual-check.js / tools/pack.mjs` 通过；index.html 内联脚本可解析。
- `node tools/curriculum/visual_check.mjs`：零违约，退出码 0。
- `node tools/curriculum/skills_check.mjs`：不变（G4–G9 369 技能 / 600 先修边 / 340 误区）。
- 隔离实例 HTTP 回归 **26/26**：脚本在本会话 scratchpad `…/scratchpad/test-inst.js`（配 `fakeclock.js` 假时钟预载、`inst/` 实例拷贝）。做法：拷 `server.js + public + qbank.json + data/{curriculum,lessons,unit-tests}` 到临时目录，`config.json` 里 ollama 指死端口、openai 指本地桩（`/chat/completions` 固定回一份合规报告 JSON，零成本），`PATH` 只留 node 目录让 CLI 引擎探测不到，`PORT=8437`；先 `POST /api/auth/register` 自助注册再建孩子。scratchpad 是会话临时目录，想长期留就搬进 `tools/`。
- 没做：真实浏览器全流程、完整 pack 打包、iOS 实机；语音没烘（见 §4）。

## 4. 接手要做 / 工作树盘点

1. **提交**：dev 工作树 117 个未跟踪文件 + 15 个已修改文件都没提交。建议分两笔：G9 内容批次（`data/curriculum/skills/g9.json`、49 en + 49 zh 微课、8+8 主题卷、`misconceptions.json` / README / `skill-graph-plan.md` / `pregen.mjs` / `export_apple.mjs` / `skills_check.mjs` 的 G9 改动）；审查修复（`server.js`、`public/index.html`、`public/visual-check.js`、`tools/pack.mjs`、`docs/qbank-standard.md`、8 个课程文件、本文档）。`server.js` 里另有 2 行与 G9、审查都无关的改动（`genClaude` 解析不出 JSON 时把 CLI 原话带上），一并归到 G9 那笔即可。
2. **G9 状态**：49 技能 / 49+49 微课 / 8+8 主题卷 / 题库 49+49 组共 1200 题，`skills_check` 通过。**语音没烘**：`data/voice` 仍是 4546 条（G8 之前的全量），`node tools/prevoice.mjs --langs zh,en --dry` 报 **1452 句待烘，约 83 MB**（G8 142 课 + G9 98 课 + 本次改了 say 的 `en/LIN.CONTINUOUS` 两步）。要先起 CosyVoice 守护进程（WSL `yuanyuan-tts` 9880），烘完重启服务。
3. **app 端同步**（走 GitHub issue 渠道）：8 个课程文件改了配图；校验器变严两处（S2：非 allowNeg 统计图拒负数、按原始形状数类别；S3：nums 非数字即违约），对方 `LessonValidator` 应对齐；`/api/quiz/*` 的场次票只影响 web 端，app 不调这组接口。导出别用 `--no-voice`。
4. **运行实例**：8434 源码实例当前没在跑，下次启动即用新 `server.js`。闯关结算改为凭票后，重启前就开着的闯关页在结算时会 400、提示「成绩没存上」，只此一次。
5. 待决定：`config.json` 新增了 `claude` 段（opus-5 / high / 超时 1500000），根目录留着 `config.json.pre-g9.bak`。
6. 本文档放在仓库根目录、未跟踪；项目惯例交接文档在 `docs/`（如 `docs/handoff-apple.md`），提交时可挪过去。

## 5. 复审结果（HEAD e7fb2f6）

复审范围为 `533fe35..e7fb2f6`，重点检查前次问题的修复及同次新增的配图 v3。未修改业务代码。

### Standards：新增配图仍有两项 P2

**R1 · P2 · 饼图题图没有忠实保留题目数值。** 定位：`public/index.html:2135、2144、2153`。题图模式要求保留 `nums` 原值（`docs/qbank-standard.md` §7），但合计 100 时仍用 `Math.round`：合法输入 `[12.5,87.5]` 显示为 `13%` 与 `88%`，总计变成 101%。另外，小于 9% 的扇区不显示标签，题图图例又去掉了数值；例如 `[2,3,95]` 中两个小扇区的具体值完全丢失，读图题不能靠图恢复各自数据。已通过实际渲染函数的隔离执行确认取整和隐藏行为，未发现当前存量题采用上述输入。建议百分比沿用原值格式化，小扇区通过外置引线等方式显示数值。验收覆盖小数百分比和多个小扇区，确保所有输入值可读且未改写。

**R2 · P2 · 新象形图遇到零值行时仍可静默截断。** 定位：`data/curriculum/visual-contract.json:212`、`public/visual-check.js:114–116`、`public/index.html:2429`。`pictograph` 允许零值，但使用只统计正数的 `count` 规则限制八行。输入 `[0,1,1,1,1,1,1,1,2]`、九个标签 `a..i`、`step=1`，只有八个正数，校验通过；渲染器却按完整数组 `slice(0,8)`，最后的 `i=2` 一行被丢掉。已用校验器和实际渲染函数验证；未发现存量题使用此输入。建议以包含零值的原始行数做上限检查，超限拒绝，不能截断；回归验证八行含零值正常显示、九行输入被拒绝。

### Spec：场次票剩余一项 P2

**R3 · P2 · 闯关票据没有在结算时检查六小时有效期。** 定位：`server.js:2595–2601`。`QUIZ_OPEN_TTL` 只在创建新场次时清理旧票，`quizOpenTake` 不检查时间。因此是否过期取决于这期间有没有人另开一场。已在隔离 HTTP 实例中开场后推进时钟七小时，期间不开新场，提交原票仍返回 `200 / passed:true / status:solid`。建议在取票时检查 `Date.now() - s.at`，超期删除并返回无效场次。验收：六小时内可结算，超过六小时无论是否创建其他场次均拒绝。

### 已通过及验证边界

- `node --check server.js`、`node --check public/visual-check.js`、`node --check tools/pack.mjs` 通过。
- `node tools/curriculum/visual_check.mjs`：972 课、5986 步、4574 个有图步骤，契约 v3 零违规。
- `node tools/curriculum/skills_check.mjs`：369 技能、600 先修边、340 误区登记，通过。
- S1：打包清单已带契约；缺失契约接口/前端降级已修。S2/S3 原始坏输入已不再通过校验。
- F1 HTTP：错误 `picked` 加 `correct:true` 不通关；重复结算返回 400；实际正确的 `picked` 即使 `correct:false` 仍按服务端答案判对。
- F4 HTTP：48 次逐小时访问后，磁盘会话到期时间已前移约 24 小时。
- F2/F3：实际摘要函数加真实 G5 技能映射验证，五个技能加标准历史正确合计 `right=23/wrong=7`，技能活动进入近期统计；对应技能卷及旧版完成卷被纳入，未完成卷和其他年级卷被排除。
- 内容观察：`data/lessons/en/YY.MATH.PCT.BEYOND100.CONVERT.json:43–50` 的半个百分点讲解现用 `[1]` 百格图，画的是完整一格（1%），caption 要读者再想象一半。结构合法，但不是直接展示 0.5%；可改为真正半格，或明确把它作为 1% 的参照图。此项列作教学表达建议，不计入上述三项缺陷。
- 未进行完整安装包构建、真实浏览器全流程或付费 AI 调用。边界渲染复现不等同于现有题目已出现事故。

复审新增：Standards 2 项 P2，Spec 1 项 P2；未发现新的 P1。

### 复审三项的修复（2026-09-05 晚，未提交）

| 项 | 修法 | 位置 | 验证 |
|---|---|---|---|
| R1 | 题图模式扇区标 `fmtNum(v)` 原值不取整（合计 100 才带 %）；< 9% 的窄扇区（长标签如「12.5%」按 < 14%）不再隐藏，拉引线到圆外，左右各排一列、按高度排序至少隔 14px；饼图几何改 cx=118 / R=70 / 高 200，题图模式图例右移到 x=248（名字 14 字、13px）给引线让位；课文模式照旧 | `public/index.html` `vPieChart` | 真实渲染函数：`[12.5,87.5]` 出 `12.5%` / `87.5%`（无 `13%`）；`[2,3,95]` 三个值都在；`[1,1,48]` 计数不带 %；课文模式图例仍带值。浏览器实际看过 6 种排布（四个 4% 连排、两侧各一个 3%），无叠字、无出界、不撞图例 |
| R2 | `count` 规则改数 `nums` 项数（含 0）——渲染端本来就是按整个数组截断；契约 `rules.count` 说明同步改。同一类问题连带修好 `barModel` / `histogram` / `average`（渲染都保留零值再 slice） | `public/visual-check.js`、`data/curriculum/visual-contract.json` | 象形图 9 行含零 → `给了 9 项，最多只画 8 项`；8 行含零 → 通过且画出 8 行；`barModel` 7 项含零 → 拒；存量内容仅 `probLine` 有 0 且在上限内，两边 preflight（课文 972 文件 / 题库 11946 道、123 道题图）零违约 |
| R3 | `quizOpenTake` 取票时检查 `Date.now() - s.at > QUIZ_OPEN_TTL`，过期即删并返回无效 | `server.js` | 隔离实例假时钟：开场后 7 小时、期间不开新场 → 400 `staleSession`；开场后 1 小时 → 正常结算通关。全套回归 28/28 |
| 教学表达 | `PCT.BEYOND100.CONVERT` 第 3 步 caption 改为「Reference: the shaded square is 1% (one of the 100). Half a percent is half of that one square.」，明确它是 1% 参照图（百格图只能涂整格） | `data/lessons/en/YY.MATH.PCT.BEYOND100.CONVERT.json` | preflight 通过；caption 不进语音 |

app 端注意：`count` 语义变化（含 0）已写进契约 `rules.count`，Apple 端 `LessonValidator` 若按旧文案只数正数，会比 web 宽松；preflight 把关内容，不会有两端不一致的存量。
