# AI-native 重构前的仓库审计（#19 Phase 0 / #20）

审计基准：`dev` 分支 `1d9242b`（2026-09-25）。行号都指这个提交的 `server.js` 和 `public/index.html`，之后会漂移，但段落划分短期不会变。

这份文档回答四件事：现在的架构和数据流是什么样、哪些地方是依赖热点、把它搬到 #19 的目标架构有什么风险、现有模块建议怎么映射过去。末尾给出 Phase 1 的切入建议和与在办 issue 的顺序。

## 0. 先说结论

1. **起点是一个零依赖的双单体**：`server.js` 4022 行装了全部 39 条路由（一个 850 行的 if 链），`public/index.html` 4552 行装了全部界面（内联 JS 3800 行，无框架、无打包）。根目录没有 `package.json`，没有测试框架。
2. **产品今天没有「智能体循环」**。实时调模型的只有 6 个任务（teach / ask / quiz / unit / fsa / report），每次都是「一段提示词 → 一次结构化 JSON 输出 → 校验 → 落盘」，最多重试一次。没有工具调用、没有多轮、没有对话记忆。`teach`、`quiz`、`unit` 三种在发行版里绝大多数命中预生成包，零引擎调用。
3. **所以 #19 的 Phase 3 到 6（Harness / TutorAgent / Skills / Memory / 结构化辅导流程）是新功能，不是重构**。它们描述的是一个「孩子能自由对话、模型会调工具查学生状态」的产品，而现在的产品是「固定讲课 → 闯关 → 单元卷 → 报告」。这个方向要先拍板，再决定 Phase 3 起做多大。反过来，Phase 0 到 2 和 Phase 7、8 是对现有代码的整理，方向不需要讨论。
4. **Phase 8（模型抽象）已经做了一半**：`ADAPTERS` 表 7 家引擎统一签名，`pickProvider` 支持按任务路由。缺的是把它搬出 server.js、补按能力（fast / reasoning / vision / local）而不是按厂商路由。
5. **Phase 1 最值得先做的不是 issue 里举的 `student.getProfile`，而是把「掌握度判定」和「闯关规则」抽成纯函数**。它们是辅导产品真正的业务核心，现在散在服务端和前端两处，而且前端那份能决定下一题和通关。本轮已经把它们的输入输出录成黄金用例（§6），抽的时候有依据。
6. **有一组硬约束必须先列出来**（§5），碰了就会让离线安装包、Vercel demo、iOS 端或语音包断掉。

## 1. 当前架构与数据流

### 1.1 进程与文件

```
浏览器 public/index.html（单页，内联 JS）
   │  fetch /api/*，x-session 头
   ▼
server.js（http.createServer，一个回调分发 39 条路由）
   ├─ 启动：全部读进内存（config、大纲、账号、每个孩子的桶、题库）
   ├─ 内存是唯一真相，写盘 = 整份 JSON 覆盖（.tmp + rename）
   ├─ 模型：ADAPTERS{ollama,grok,claude,gemini,codex,anthropic,openai}
   ├─ 语音：tts-cache + data/voice 预烘包 + 两台守护进程（zh 9880 / en 9881）
   └─ module.exports 把提示词、适配器、账本、哈希函数借给 tools/*.mjs 和 api/index.js
```

`ROOT`（随包只读内容）和 `DATA_ROOT`（用户状态）在 server.js:22-89 分开：`YY_DATA_DIR` 最优先；源码模式两者相同；有 `.packaged` 标记时切到系统数据目录并做一次只拷不删的迁移。

### 1.2 server.js 分段

| 行号 | 段落 | 目标架构里的归宿 |
|---|---|---|
| 22-153 | 数据根目录、DEFAULT_CONFIG、deepMerge、环境变量 | infrastructure/config |
| 155-200 | 配图契约、LESSON_SCHEMA | domain/lesson |
| 202-558 | 讲课提示词：seniorTone、systemPrompt(En)、lessonFields、systemPromptTeach(En) | ai/skills |
| 560-1088 | FSA / 单元卷 / 题库 / 审稿的 schema、hint、prompt、validate | ai/skills + domain 校验 |
| 1090-1206 | repairJson、extractJson、validateLesson | ai/models（输出解析） |
| 1208-1283 | which / resolveShim / runCmd（CLI 引擎的进程管理） | ai/models |
| 1285-1348 | detectProviders、PROVIDER_META、AUTO_ORDER、TASKS、pickProvider | ai/models（Router） |
| 1350-1529 | 7 个 gen* 适配器 | ai/models（Provider） |
| 1531-1606 | usage.jsonl 账本、runEngine | ai/models + infrastructure |
| 1608-1825 | TTS：ttsIdWith 哈希、语音包索引、守护进程调用、缓存清理 | infrastructure/tts |
| 1827-2002 | 孩子数据桶：kidData、kidTxn、kidCommit、kidRevert、后台重试 | infrastructure/storage |
| 2004-2250 | 大纲加载：grade-N / course-* / books / skills；findCurriculumItem | domain/curriculum + infrastructure |
| 2252-2306 | 预生成包读取 lessonPackGet / unitPackGet | infrastructure/content |
| 2308-2482 | 术语、**progressStatus / progressLevel / standardRollup / standardEvidence / missRecord / remediationFor / progressRecord** | **domain/mastery（核心）** |
| 2484-2731 | FSA 卷、单元卷存取；**题库 qbankMerge / qbankPlayable / ensureQuizBank / quizSession / 场次票** | domain/quiz + infrastructure |
| 2733-2885 | 账号、会话、scrypt、auth、allow、resolveKid、限速 | infrastructure/auth |
| 2887-3070 | 完整报告：reportPrompt、buildReportDigest | domain/report + ai/skills |
| 3094-3944 | 路由分发 | app（HTTP 适配层） |
| 4009-4022 | module.exports（给 tools 和 Vercel 用） | 公共入口 |

### 1.3 六条实时模型调用

| 路由 | 任务名 | 先查什么 | 现场调用条件 |
|---|---|---|---|
| POST /api/lesson（teach） | teach | data/lessons 包 | 未命中或 `fresh=true` |
| POST /api/lesson（打字 / 拍照） | ask | 无 | 总是 |
| POST /api/quiz/session | quiz | qbank.json | 该知识点各级题不够时才补题 |
| POST /api/unit-test | unit | data/unit-tests 包 | 未命中或 `fresh=true` |
| POST /api/fsa | fsa | 无 | 总是 |
| POST /api/report/full | report | 无 | 总是 |

每一条都是同一个模板：`pickProvider(task)` → 组 system prompt + 短用户消息 → `runEngine`（计时、记账）→ `extractJson`/`repairJson` → `validateX` → 失败原样再跑一次 → `kidTxn(keep)` 落盘。这套模板在 4 个路由里各复制了一份（3427、3484、3592、3905），是 Phase 3 「最小 Harness」真正要收敛的东西。

构建期另有 `pregen:*`、`judge:*` 六个任务名，由 tools/pregen.mjs 和 audit_qbank.mjs 使用同一套导出函数。

### 1.4 持久化

- **孩子桶** `data/kids/<kidId>/{history,progress,fsa-sets,unit-tests,reports}.json`：`kidTxn` 单例事务、两段式提交、失败回滚内存；keep 模式下内容照给、挂 `saveFailed` 警告、60 秒后台重试（#16 修的）。事务体必须是同步代码。
- **题库** `qbank.json`：全局共享、不分家庭（故意的）。`qbankSave` 失败只打日志。`DELETE /api/qbank` 会把整个对象重新赋值，导出给 tools 的引用从此失效。
- **账号** `data/users.json`：`usersCommit` 失败就抛错，绝不「没存上也算成功」。
- **只在内存**：闯关场次票 `quizOpen`（key 是家长的 user.id，不是 kidId）、限速表、TTS 在途表、包文件 memo（连「文件不存在」也缓存）。

### 1.5 前端持有的业务逻辑

index.html 不只是视图。以下逻辑在前端，重构时要么搬到服务端，要么明确接受：

| 逻辑 | 位置 | 后果 |
|---|---|---|
| ~~闯关升降级、借题顺序、通关判定~~ | ~~3811-3873~~ | **#23 已搬到服务端**（`lib/domain/quiz.js` + 场次票持有状态 + `POST /api/quiz/answer`）；前端只展示当前题，结算失败不再本地判通关 |
| FSA 和单元卷连 `answerIndex` 一起下发（闯关 #23 起不再下发） | 3629、3648 | 答案在客户端 |
| FSA 分数由前端算完上报 | 3688 | 服务端只夹值，属于可信任前端 |
| FSA 逐题进度事件由前端判定后发 | 3632 | 同上 |
| 单元卷成绩单分数本地另算 | 3648 | 和服务端判分可能对不上 |
| 「有存档就重播，否则重新生成」 | 3460 | 课程导航策略 |
| FSA 只对 4/7 年级开放 | 3504 | 硬编码 |
| 引擎选择只存 localStorage，随每个请求带 `provider` | 4161 | 服务端没有「这个孩子用什么引擎」的概念 |

### 1.6 外围

- `tools/pregen.mjs`、`prevoice.mjs`、`export_apple.mjs`、`pack.mjs`、`audit_qbank.mjs` 全靠 `require("../server.js")` 借函数。**server.js 的导出表就是构建工具的 API**，重构时它是一条不能断的契约。
- `api/index.js` 把 server.js 当 Vercel 函数跑：`YY_DEMO=1`、数据在 /tmp、种子账号和题库来自 `demo/`。
- 内容与状态的分界：内容 = `data/curriculum`、`data/lessons`、`data/unit-tests`、`data/voice`、`seed/`；状态 = `config.json`、`qbank.json` 的 `usedAt`、`data/users.json`、`data/sessions.json`、`data/kids`、`tts-cache`、`usage.jsonl`。`qbank.json` 两边都占。

## 2. 依赖热点

**最大的函数**：路由回调 850 行；`qbankPrompt` 120 行；技能图谱加载 IIFE 90 行；`buildReportDigest` 88 行；`systemPromptTeach` 和 `systemPromptTeachEn` 各 80 行且逻辑平行复制。

**多处改写的全局状态**：`kidData` 桶（6 个写入函数 + 路由里直接 splice / 整体赋值 4 处）、`qbank`（4 处）、`detected`（每次 `GET /api/providers` 都重新探测，含 Ollama 网络请求和文件系统扫描）、`kidTx` 单例。

**逻辑复制**：
- 「模型调用 → 校验 → 重试一次」模板复制 4 份。
- 「没有检测到可用的 AI 引擎」文案复制 5 份（3417、3475、3582、3698、3887）。
- 中英提示词函数成对复制（systemPrompt / En、Teach / TeachEn、所有 HINT 常量）。
- `QBANK_HINT_SKILL` 和 `JUDGE_HINT_QUIZ` 由基础版 `String.replace` 生成，基础文案一改替换就静默失效。
- `parseStatSeries` 在 index.html 和 visual-check.js 各一份。

**UI 文案渗进服务端**：错误文案 `中文 / English` 双语拼在一个字符串里由前端 `pickLangMsg` 拆；`PROVIDER_META` 带前端要显示的 label / note；引擎层有面向孩子的拒答文案；启动横幅 60 行。

**提示词与 schema 不同源**：39 种配图的参数说明写死在 `lessonFieldsZh/En` 文本里，而枚举来自 `visual-contract.json`。

**git 变更热点（2026-08-01 起 70 个提交）**：server.js 34 次、index.html 26 次、pregen.mjs 11 次、pack.mjs 9 次、export_apple.mjs 7 次。拆 server.js 会和所有在办分支冲突。

## 3. 顺带发现的缺陷（本轮未修，各自开单或并入 Phase 1）

| 位置 | 问题 |
|---|---|
| server.js:1443 | `.replace(/s+/g, " ")` 少了反斜杠，会把错误信息里的字母 s 换成空格 |
| server.js:1194 | `visual-contract.json` 缺失时 `VISUAL_TYPES` 为 null，`validateLesson` 抛 TypeError，所有课失败；和 161-165 「读不到就放宽」的本意矛盾 |
| server.js:1072 | `judgeUnitPrompt` 没把 gradeData 传给 `judgeCommon`，单元卷审稿永远按小学口径 |
| server.js:3813 | `GET /api/progress` 只认 `BC.MATH.G<g>.` 前缀，技能 / 课程 / 书籍条目过滤不出来 |
| server.js:3522 | `/api/fsa/attempt` 由客户端上报答对数，和 unit-test / quiz 的服务端判分不一致 |
| server.js:4018 | `DELETE /api/qbank` 后导出的 `qbank` 引用失效 |
| server.js:2630 | `ensureQuizBank` 同一知识点并发请求会各自花钱生成 |
| lib/ai/models/json.js `extractJson` | `\f \t \b \n \r` 是合法 JSON 转义，所以模型写单反斜杠的 `\frac` / `\times` / `\begin` 而其余部分合法时，`JSON.parse` 会「成功」并把它们吃成控制字符，永远走不到 `repairJson`。`tools/test_models_json.mjs` 已把现状钉住 |
| server.js:1290 | `YY_DEMO=1` 同时关掉引擎、书籍和技能图谱。隔离测试因此看不到技能视图和误区回补，建议拆成 `YY_NO_ENGINE` 一个独立开关 |
| index.html 3885 | 闯关结算请求失败时前端仍显示通关 |
| index.html 3798 | `startQuiz` 不带 `kid`，家长代孩子闯关时场次票绑在家长 user.id 上 |
| tools/visual_check.mjs | `--qbank --json` 会把 `--json` 当文件路径；读的是 ROOT 而非 DATA_ROOT |
| export_apple.mjs / prevoice.mjs | manifest 和头注释仍写 CosyVoice，英文已是 Kokoro |
| README / .gitignore / content/README | 课程、卷子、题数、语音条数全部过时 |

黄金用例还暴露了两条**规则事实**（不一定是 bug，但 Phase 1 抽 mastery 时要保留或有意改掉）：练习事件 `practiced-right` 累计再多也停在 developing，只有闯关通关或家长手动标记能到 solid / proficient；通关后再闯一次全错，solid 不掉。

## 4. 迁移风险

1. **拆文件 = 和所有在办分支冲突**。#15 到 #18 在 Review、#9 / #12 在 In Progress，都改 server.js。先把它们合并或冻结，再动结构。
2. **server.js 的 `module.exports` 是构建工具的 API**。pregen / prevoice / export_apple / audit_qbank / api/index.js 依赖 `runEngine`、`pickProvider`、`systemPromptTeach`、`validate*`、`judge*Prompt`、`ttsIdWith`、`ttsSpeakable`、`qbank`、`qbankSave`、`LESSON_PACK_DIR` 等二十多个名字。拆分后 server.js 必须继续原样导出（做成 façade），否则发版链断。
3. **`ttsIdWith` 哈希绝不能变**：sha1 的 7 个字段固定，4548 条预烘语音靠它索引。任何搬动都要保证同一输入同一 sha1，且 `say` 文本一个字都不能改。
4. **内存快照模型**：运行期从不重读磁盘、写盘整份覆盖。Action 层如果引入「每次从存储读」会和它打架；Phase 1 应该先在内存模型之上抽 Action，存储改造留到后面单独做。
5. **`kidTxn` 要求事务体同步**。Action 一旦 async（比如调模型）就不能包在事务里，这正是现在「模型调用在事务外、落盘在 kidTxn(keep) 里」的原因。Harness 设计时要保留这个边界。
6. **CRLF**：server.js 是 CRLF，别让工具或编辑器整文件转成 LF，否则 diff 不可读。
7. **前端硬依赖的响应字段**：index.html 对 30 多个响应字段有硬依赖（错误通道 `error` 双语串 / `parentRequired` / `kidRequired` / `saveFailed`；`/api/tts` 的 items 按下标一一对应；`/api/curriculum` 的 item 字段；`/api/report` 的 level 枚举等）。这些在 tools/smoke_flows.mjs 里已经断言了一部分，Action 的输出契约应从它们反推，而不是重新设计。
8. **Vercel demo 的 250 MB 函数上限**和 `includeFiles` 白名单：新目录（`src/ai/...`）要进 `vercel.json`，否则 demo 冷启动找不到模块。
9. **打包白名单**：pack.mjs 的 `stageApp` 只拷 server.js、public、data 的几个子目录和三个 .py。新增源码目录不进白名单就不进安装包。
10. **iOS 端契约**：`content/qbank` 格式、`tags` 不下发、visual v3、`headline` 可选。这些由 export_apple.mjs 产出，不受服务端重构影响，但 Action 层若改题目对象的字段名会顺着 `S.qbank` 传到导出。

## 5. 不可变接口清单

重构过程中以下东西按「冻结」处理，改动需要单独开单：

- `server.js` 的 `module.exports` 名单和语义。
- `ttsIdWith` 的哈希输入和 `data/voice/<sha1>.m4a` 命名。
- 环境变量：`PORT`、`YY_DATA_DIR`、`YY_DEMO`、`YY_DEMO_PIN`、`YY_DEMO_PARENT`、`YY_SAVE_RETRY_MS`、`REGISTRATION_CODE`。
- `DATA_ROOT` 判定顺序、`.packaged` / `.migrated-from-app` 标记、`seed/` 的落地规则。
- 磁盘格式：`data/kids/*` 五个文件、`qbank.json` 的 `"id|lang"` 键、`data/lessons` 和 `data/unit-tests` 的包格式、`usage.jsonl` 行格式、`config.json` 键。
- 39 条 `/api/*` 路由的路径、方法、状态码语义和前端硬依赖的字段（§4 第 7 条）。
- 题库全局共享不分家庭；`tags` 不下发客户端；场次票一票一结。
- `visual-contract.json` 是唯一事实源，`public/visual-check.js` 浏览器和 node 共用。
- `pack.mjs` 白名单和 `vercel.json` 的 `includeFiles`（新增目录时同步改，而不是绕开）。

## 6. 基线与回归

全部零成本、全程隔离（临时目录当 `YY_DATA_DIR`，`YY_DEMO=1`，随机端口），不碰仓库里的真实账号和孩子数据。

| 检查 | 命令 | 基线（1d9242b） |
|---|---|---|
| 语法 | `node --check server.js && node --check public/visual-check.js` | 通过 |
| 健壮性回归（#15/#16/#17） | `node tools/regress_server.mjs` | 24 / 24 |
| **主流程冒烟（本轮新增）** | `node tools/smoke_flows.mjs` | 47 / 47 |
| **辅导黄金用例（本轮新增）** | `node tools/golden_cases.mjs` | 12 / 12 |
| **掌握度纯函数单元测试（#21 新增）** | `node tools/test_mastery.mjs` | 42 / 42，不起服务器 |
| **模型输出 JSON 修复单元测试（#22 新增）** | `node tools/test_models_json.mjs` | 24 / 24，不起服务器 |
| **闯关规则单元测试（#23 新增）** | `node tools/test_quiz.mjs` | 26 / 26，不起服务器 |

#23 之后 smoke 是 57 项（闯关 C 组改走 `/api/quiz/answer`），golden 快照只多了 `path` 键（服务端决定的难度序列），其余键值与 1d9242b 时一致。
| 配图契约：课程 | `node tools/curriculum/visual_check.mjs` | 972 课 5986 步零违约 |
| 配图契约：题库 | `node tools/curriculum/visual_check.mjs --qbank` | 11946 题零违约 |
| 配图契约：单元卷 | `node tools/curriculum/visual_check.mjs --unit-tests` | 1936 题零违约 |
| 技能图谱 | `node tools/curriculum/skills_check.mjs` | 77 主题 369 技能通过 |

### 6.1 冒烟覆盖什么

`tools/smoke_flows.mjs` 走一遍「注册家长 → 建两个孩子 → 孩子登录 → 大纲 → 随包课 → 历史重播 → 闯关（通关和失败两条）→ 随包单元卷 → 家长报告 / 进度 / 用量对账 → 权限边界与孩子隔离 → 无引擎时的 503 → 重启后与磁盘一致」。它断言的是 #19 后续每一步都不能弄坏的行为，特别是：服务端判分不信客户端的 `correct` 字段、场次票一票一结、报告和进度的 right/wrong 总数相等、用量账本零引擎调用。

### 6.2 黄金用例

`tools/golden_cases.mjs` 把辅导核心判定录成快照 `tools/golden/expected.json`，每个用例一个新孩子：

| 用例 | 钉住的规则 |
|---|---|
| teach-once / teach-zh | 讲课 new → seen，taught 计数，中英两份课程包 |
| quiz-pass-minimal / quiz-pass-without-teach | 最短通关路径（L1 对 1、L2 对 1、L3 对 passNeed）→ solid / proficient；不依赖 taught |
| quiz-fail-all-wrong / quiz-top-level-short | 不通关的两种形态，wrong 累加，级别停在 developing |
| quiz-pass-then-fail | 通关后再失败 solid 不掉 |
| unit-test-half-right / unit-test-all-right | 随包卷按题分发到 4 个标准的 right/wrong，报告级别 |
| mastery-table | 11 种练习序列 → status / level 对照表 |
| manual-solid | 家长标 / 取消扎实，孩子无权，内部事件被拒 |
| report-empty | 空报告的汇总口径和五大主线数量 |

改了掌握度或闯关规则时用 `--update` 重录，并在 PR 里说明为什么快照该变。

### 6.3 已知缺口

- **误区回补（`missRecord` → `remediationFor`）没有黄金用例**：它只在技能视图（`YY.MATH.*`）下工作，而 `YY_DEMO=1` 会跳过技能图谱加载。修法是把「不启用引擎」拆成独立开关（§3 表），之后补一条「同一误区命中 2 次出现 remediate」的用例。
- 前端逻辑（闯关升降级、FSA 计分）没有自动化测试：index.html 里没有任何测试钩子，`Audio`、`speechSynthesis`、`fetch` 全是裸全局。要测只能在页面上 stub，或者先把这些逻辑搬到服务端再测。
- 现场调模型的路径（ask / fsa / report、包未命中）没有零成本测法。Phase 3 引入 Harness 时应同时引入一个「回放 Provider」：把一次真实调用的请求和响应录下来，之后用录音跑。

## 7. 现有模块 → 目标架构映射

沿用仓库的零依赖、CommonJS、单进程习惯。不建 `src/`，直接在根目录加 `lib/`，server.js 逐段 `require` 回来并保持导出不变。

| 目标层 | 从 server.js 搬过去的东西 | 备注 |
|---|---|---|
| `lib/domain/mastery.js` | progressStatus、progressLevel、standardRollup、standardEvidence、missRecord、remediationFor、progressRecord 的纯计算部分 | **Phase 1 第一刀**。纯函数，输入 progress 条目 + 事件，输出新条目 + 状态；黄金用例已就位 |
| `lib/domain/quiz.js` | QUIZ_* 常量、quizSession 选题、通关判定（现在在前端）、qbankPlayable、qbankMerge | 把前端 3811-3873 的升降级逻辑搬进来，服务端出「下一题」 |
| `lib/domain/curriculum.js` | STRANDS、curriculumKey、learnView、viewKey、findCurriculumItem、bigIdeaText、strandGroups、术语 | 加载留在 infrastructure |
| `lib/domain/report.js` | buildReportDigest、reportSummary | 叙事生成留在 ai |
| `lib/actions/*` | 每条路由里「解析参数 → 调业务 → 落盘」的中段 | 输入输出契约从 §4 第 7 条反推；UI 和未来的 Tool 都调它 |
| `lib/ai/models/` | ADAPTERS、gen*、detectProviders、pickProvider、runEngine、extractJson、repairJson、账本 | Phase 8。先原样搬，再加按能力路由 |
| `lib/ai/skills/` | systemPrompt(En)、systemPromptTeach(En)、seniorTone、lessonFields、所有 HINT、fsaPrompt、unitTestPrompt、qbankPrompt、reportPrompt、judge*Prompt | Phase 4。一个 Skill = 一对中英提示词 + schema + validate |
| `lib/ai/harness/` | 4 份复制的「调用 → 校验 → 重试」模板 | Phase 3 的最小版本就是把这 4 份收成一个 `runStructured(task, skill, input)`；工具循环是之后的事 |
| `lib/ai/memory/` | 现在的 history / progress / reports 就是学生记忆；kidTxn 是它的存储 | Phase 5 主要是给 progressRecord 的事件起正式名字（issue 里的 learning events）并分离原始事件和派生状态 |
| `lib/infra/storage.js` | kidData、kidTxn、kidCommit、kidRevert、后台重试、usersCommit、sessionsSave、qbankSave | 保持内存快照模型 |
| `lib/infra/auth.js` | scrypt、auth、allow、resolveKid、限速 | 不改语义 |
| `lib/infra/tts.js` | ttsIdWith、ttsSpeakable、语音包索引、守护进程调用 | 哈希冻结 |
| `lib/infra/content.js` | 大纲 / 技能 / 书籍加载、lessonPackGet、unitPackGet | memo 行为要保留（或有意修掉「缓存不存在」） |
| `server.js` | 只剩路由分发 + `module.exports` façade | 路由本身之后再拆成按资源的文件 |

**不映射、保持原样**的：`public/index.html`（Phase 1 只把判定逻辑搬走，不重写界面）、`tools/*`（只要导出不变它们不用动）、`api/index.js`。

## 8. Phase 1 切入建议与顺序

1. **先收口在办 issue**：#15 到 #18 已经在 dev 上（1d9242b），把它们关掉；#9 / #12 换声音只剩人工试听，不再改 server.js，可以并行。
2. **第一刀：`lib/domain/mastery.js`**。把 progressStatus / progressLevel / standardRollup / progressRecord 搬成纯函数，server.js 原地 require，跑 golden + smoke + regress 三组必须全绿且快照不变。这一步不改任何路由。
3. **第二刀：`lib/domain/quiz.js` + 服务端出下一题**。新增 `POST /api/quiz/next`（或在 session 里返回策略），前端改为调它；旧的本地升降级保留一段时间做对照，快照里加「服务端选题序列」。这是唯一一处会动前端的 Phase 1 工作。
4. **第三刀：`lib/ai/models/`**。原样搬 ADAPTERS / pickProvider / runEngine / 账本，server.js 和 tools 通过 façade 继续用。之后才是按能力路由。
5. **第四刀：Actions**。按路由逐条抽「中段」，每抽一条在 smoke 里对应加断言。顺序建议 progress → curriculum → quiz → unit-test → lesson → report。
6. **同时做的小事**：`YY_DEMO` 拆开 `YY_NO_ENGINE`；补误区回补黄金用例；修 §3 表里两行代码就能修的（1443、1194、1072）。
7. **拍板项（Phase 3 前）**：孩子端要不要自由对话的 TutorAgent。如果要，Phase 3 的 Harness 需要工具循环、会话记忆和一个回放 Provider；如果不要，Phase 3 只做 `runStructured` 收敛四份模板，Phase 5 / 6 就是给现有流程起名字和加 Verifier。

每一刀一个子 issue、一个 PR，验收标准统一为：三组测试全绿、快照不变（或有意变更且注明）、`module.exports` 名单不变、`node tools/pregen.mjs --dry` 和 `node tools/export_apple.mjs --dry` 仍能跑。
