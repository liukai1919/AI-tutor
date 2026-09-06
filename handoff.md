# 项目交接（2026-09-05 审查 → 当天已修复）

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
