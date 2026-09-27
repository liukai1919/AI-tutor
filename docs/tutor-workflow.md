# 结构化辅导工作流：Diagnose → Teach → Practice → Evaluate → Adapt（#36，#19 Phase 6）

状态：后端模块 + 单测 / 组合测试。**没有 HTTP 路由、没有界面、server.js 没有实例化它**；不连真实模型、不联网、不读写任何现有孩子数据。
学习事件只经 Phase 5 的 `memory.appendEvent` 写入；TutorAgent、Skill 目录、Harness、memory 的源码一行没改。
**#38（Phase 7）起**：每步结果发布前跑后置条件（§3、§5）；TutorAgent 请求带本地验证上下文、回复再本地复核（§6）；可以用 `createAnswerGrader()` 作 grader（§4.2）。
详见 `docs/tutor-verification.md`。

```
lib/ai/workflows/errors.js    WorkflowError + 读外部值（复用 memory/errors.js 的严格读取）
lib/ai/workflows/machine.js   纯状态机：阶段表、命令表、命令 / 启动参数校验、Diagnose 策略、Adapt 决策（无 I/O、无时钟）
lib/ai/workflows/adapters.js  外部回包的严格读取（练习题、评分、TutorAgent 结果）+ 给 TutorAgent 的问题模板 + 作答安全预闸
lib/ai/workflows/index.js     createTutorWorkflow：会话表、所有者隔离、TTL / 容量、并发、命令幂等、挂起副作用、trace
tools/test_tutor_workflow.mjs 片 1 纯状态机 + 合成适配器；片 2 真实 TutorAgent（回放模型）+ 真实 createMemory + createFileStore（临时目录）
```

## 1. 入口

```js
const { createTutorWorkflow } = require("./lib/ai/workflows/index.js");
const wf = createTutorWorkflow({
  tutor,              // 真实 TutorAgent：createTutorAgent(...)，只用 ask(ctx, req)
  memory,             // Phase 5 createMemory(...)，只用 appendEvent、getStudentMemory
  practice,           // 可信题目接口：next(req) → 题目（§4.1）
  grader,             // 可信评分接口：grade(req) → 评分（§4.2）；Phase 7 verifier 的接缝
  now: Date.now,      // 可注入；≥0 的安全整数毫秒
  ttlMs: 1800000,           // 1000–86400000：闲置多久过期（每个执行过的命令续期；get 不续期）
  maxWorkflows: 100,        // 1–10000：进程内活跃工作流总数
  maxPerOwner: 3,           // 1–100：每个 (userId, kidId) 的活跃工作流
  maxCommands: 500,         // 10–10000：每个工作流执行过的 commandId 数
  adapterTimeoutMs: 10000,  // 1–120000：practice / grader / Diagnose 的 memory 读取，单次调用时限
  tutorTimeoutMs: 120000,   // 1–600000：单次 TutorAgent.ask 的时限（TutorAgent 自己另有 totalTimeoutMs，默认 90 s）
  onTrace, onTraceError,    // 默认 onTraceError 只打印 trace 的 kind，不打印回调抛出的错误信息
});
await wf.start(ctx, { commandId, topicId, title, goal, lang, maxRounds?, targetCorrect?, maxAttempts?, maxHints? });  // → view
await wf.get(ctx, workflowId);                                                                                      // → view
await wf.send(ctx, workflowId, { type, commandId, expectedVersion?, questionId?, answer? });                        // → result
await wf.close(ctx, workflowId);                                                                                    // → view（status closed）
```

选项、ctx、启动参数、命令都必须是纯对象（原型 Object.prototype 或 null），只认列出的自有可枚举数据属性；getter 不执行、多余键 / Symbol / 类实例 / Proxy 异常一律拒绝。
四个注入对象的方法在构造时沿原型链按**数据属性**各读一次，之后换掉也不影响服务。返回的服务对象冻结，只有这四个方法。

- **ctx** = `{ userId, kidId, role }`，规则同 memory：id 1–128 字符无控制字符、role ∈ student / parent。所有者 = JSON 编码的 `[userId, kidId]`。
  别的所有者拿 workflowId 一律 `NOT_FOUND`（不泄露存在性）；role 不给任何跨所有者能力，同一所有者的 parent 可以操作。
  交给 TutorAgent / memory / 适配器的是每次新建的冻结 `{ userId, kidId, role }`。
- **快照**：每个入口在第一个 `await` 之前同步读完 ctx、输入并读一次时钟；调用方之后（同一个 tick 也一样）改原对象不影响本次操作。
- **启动参数**：`commandId`（事件 id 规则，启动幂等键）；`topicId`（事件话题规则）；`title` 1–120、`goal` 1–300 字符（可信调用方给的话题名和学习目标，**不从模型文字里猜**）；
  `lang` zh / en；`maxRounds` 1–20（默认 5）、`targetCorrect` 1–maxRounds（默认 min(3, maxRounds)）、`maxAttempts` 1–5（默认 2，每题尝试数）、`maxHints` 0–5（默认 2，每题提示数）。
  文本字段去空白后非空、除 `\t \n \r` 外无控制字符。**调用方不能指定教学策略**：策略由 Diagnose 决定。
- **命令**：`type` ∈ diagnose / teach / practice / hint / submit / evaluate / adapt；`commandId` 必填；`expectedVersion` 可选；
  hint 必须带 `questionId`，submit 必须带 `questionId` 和 `answer`（1–500 字符文本）；其它命令不许带这些字段。
- **可选字段只认自有属性**：规范化后的命令、评分、evaluation、trace 记录都是 null 原型对象，缺的字段（expectedVersion、mistake、attemptId、questionId……）
  读出来就是 undefined；结果里的 reply / detail 缺省为 null。Object.prototype 被污染也补不出这些字段（测试在污染下跑完整回路核对）。

## 2. 状态图

```
start ─▶ diagnose ─diagnose─▶ teach(lesson) ─teach─▶ practice ─practice─▶ answer ─submit─▶ evaluate ─evaluate─▶ adapt
                                                          ▲                  │  ▲                                   │
                                                          │                hint │ teach(remediate) ◀── wrong, 本题还有尝试 ─┤
                                                          └──────── correct 未达标 / wrong 本题尝试用完 / uncertain ─────┤
                                                                                         done ◀── 达标 / 轮数用完 ─────┘
close：任意阶段（含命令在途）
```

| phase | stage | 允许的命令 | 成功后 | 失败时 |
|---|---|---|---|---|
| diagnose | diagnose | diagnose | teach(lesson)，定 `plan.strategy` | memory 读失败 → STORE_FAILED，不变 |
| teach(lesson)，plan = explain-concept | teach | teach | TutorAgent 回来的必须是讲解（kind answer）：记 `concept_explained` → practice | TutorAgent 拒答 / 安全 / 出错 / 回来的是 hint → 不变、零事件；写失败 → 挂起（§5） |
| teach(lesson)，plan = socratic-teaching | teach | teach | 以 hint 模式问 TutorAgent，只接受 kind hint（引导提问）：→ practice，**不记事件** | 同上（回来的是 answer 也算 TUTOR_ERROR） |
| teach(remediate) | teach | teach | → answer（同一题下一次尝试），不记事件 | 不变 |
| practice | practice | practice | → answer，round + 1 | PRACTICE_* → 不变 |
| answer | practice | hint / submit | hint：记 `hint_requested`，留在 answer；submit：记 `question_attempt` → evaluate | 同上；作答命中自伤求助预闸 → TUTOR_SAFETY，不记尝试 |
| evaluate | evaluate | evaluate | correct / wrong：记 `answer_correct` / `answer_wrong` → adapt；uncertain：不记结果 → adapt | GRADER_* → 不变（尝试保持 unsettled）；写失败 → 挂起 |
| adapt | adapt | adapt | 按下表转移 | — |
| done | done | 无 | — | — |

**Adapt 决策**（`machine.decideAdapt`，只看结构化评分和计数）：

| 评分 | 条件 | 下一步 |
|---|---|---|
| correct | correct ≥ targetCorrect | done，outcome `goal-reached`，status `completed` |
| correct | 否则，round < maxRounds | practice（下一题） |
| wrong | 本题尝试 < maxAttempts | teach(remediate) → 同一题再答 |
| wrong | 本题尝试用完，round < maxRounds | practice |
| uncertain | round < maxRounds | practice（不算对也不算错，不当作错题重练） |
| 任意 | 轮数用完且未达标 | done，outcome `round-limit`，status `ended` |

**Diagnose 策略**（`machine.chooseStrategy`，只看 `getStudentMemory` 投影里**本话题**的计数）：没有历史 / 有先修缺口 / 有 concept 或 prerequisite-gap 误因 / 错多于对 → `explain-concept`；否则 → `socratic-teaching`。
已掌握也照样教（工作流不跳过 Teach）。各步复用的 Skill：lesson = plan 策略（explain-concept 用 answer 模式，socratic-teaching 由 TutorAgent 强制 hint）；
hint = plan 为 socratic-teaching 时 `socratic-teaching`，否则 `give-hint`（都强制 hint）；remediate = `diagnose-error` + hint 模式。
每步只接受与策略相符的 kind：explain-concept 首课只收 answer，socratic 首课、hint、remediate 只收 hint。

**事件语义（保守计数）**：`concept_explained` 只在 explain-concept 首课确实回来一段讲解时记一次（事件 id `${w}.c`，每个工作流至多一次）。
socratic-teaching 首课是一个引导问题，不算「讲解了概念」；现有事件表里没有「引导提问」这一类，所以和 remediate（diagnose-error 反馈）一样**不记事件**。
孩子主动发的 hint 命令照旧记 `hint_requested`。

**从不写 `topic_mastered`**：达成 targetCorrect 只让这个工作流 `completed`，一次（或几次）答对不等于掌握；掌握判定留给 Phase 7 的 verifier / 可信调用方。

## 3. 返回值与错误

- **view**（深冻结的新对象）：
  `{ workflowId, version, status: active|completed|ended|closed|failed, phase, stage, teachMode: lesson|remediate|null, topicId, lang, limits:{maxRounds,targetCorrect,maxAttempts,maxHints}, plan:{strategy}|null, round, correct, wrong, uncertain, question:{questionId,prompt,attempts,hints}|null, evaluation:{attemptId,outcome,mistake?}|null, pending:{type,commandId}|null, outcome: goal-reached|round-limit|null, allowed:[当前可发的命令], createdAt, updatedAt, expiresAt }`。
  `pending` 给出必须原样重发的那条命令的类型和 commandId（§5）。
  没有答案键、作答文本、模型原文、title / goal、学生历史。`plan.strategy` 会间接反映历史好坏（只有两个取值），调用方如需对孩子隐藏请不要展示。
- **send 的结果**（深冻结）：`{ ok, code, detail, view, reply }`。
  - `ok:true`：`code` / `detail` 为 null；`reply` = 要给孩子看的 `{ kind: answer|hint, text }`（lesson / hint / remediate），其它步为 null。
  - `ok:false`：这一步试过了但没成功，阶段不前进。`reply` 为 TutorAgent 的**固定模板**（拒答 / 安全 / 出错，不透传模型自由文本）或 null；`detail` 在 STORE_FAILED 时给 memory 的错误码（如 `STORE_IO`、`CAPACITY`、`BAD_PROJECTION`），
    TUTOR_ERROR 由本地复核拒掉时为 `VERIFICATION`，INVARIANT_FAILED 时为违反的类别（`STATE` / `TRANSITION` / `COUNTERS` / `ASSOCIATION` / `COMPLETION`），其它为 null。

| code（resolve，ok:false） | 何时 |
|---|---|
| TUTOR_REFUSED | TutorAgent 拒答（预闸 / 分类器 / 模型 scope 非 math）；reply = 对应拒答模板 |
| TUTOR_SAFETY | TutorAgent 安全响应；或 submit 的作答命中 TutorAgent 的确定性自伤求助规则（此时不评分、不记尝试） |
| TUTOR_ERROR | TutorAgent 出错（模型错误 / 它自己的超时 / 结果不合格，含 #38 验证规则重试用完）、结果形状不对、kind 与本步策略不符（如 hint 步回来 answer、explain-concept 首课回来 hint）；拿回的文字没过工作流的本地复核（显式算术等式为假、hint 步显式说出答案键、socratic 步不是问句）→ `detail: VERIFICATION` |
| INVARIANT_FAILED | #38：这一步结束后的状态没过后置条件（阶段转换 / 计数 / 题目–尝试–评分关联 / 结束条件）。结果不发布为成功、不缓存；工作流 status `failed`、`outcome` null，并被移出会话表（之后 get / send → NOT_FOUND）；这一步里已写的事件**不撤销** |
| TUTOR_TIMEOUT | 超过 tutorTimeoutMs 还没回来：交给它的 signal 被 abort，迟到的结果丢弃（late trace） |
| PRACTICE_FAILED / PRACTICE_TIMEOUT / PRACTICE_INVALID | 题目接口抛错或 reject / 超时 / 回包不合契约 |
| GRADER_FAILED / GRADER_TIMEOUT / GRADER_INVALID | 评分接口抛错或 reject / 超时 / 回包不合契约 |
| STORE_FAILED | memory 读写失败（`detail` 给原因码；Diagnose 的读取超过 adapterTimeoutMs 时为 `TIMEOUT`） |
| CLOSED | 命令在途时工作流被关闭 |
| INTERNAL | 意外异常（兜底，不应出现） |

| code（reject WorkflowError，什么都没发生） | 何时 |
|---|---|
| INVALID_OPTIONS / INVALID_CTX / INVALID_INPUT | 选项 / ctx / 启动参数 / 命令 / workflowId 不合契约 |
| INVALID_CLOCK | now() 抛错或非 ≥0 安全整数；start / send 时 now + ttlMs 超出安全整数（在任何状态变化之前） |
| NOT_FOUND | 不存在 / 过期 / 已关闭 / 别的所有者 |
| BUSY | 同一工作流上另一个命令正在执行 |
| ILLEGAL_COMMAND | 当前阶段不允许这个命令（含 done） |
| PENDING_OPERATION | 有挂起副作用时发了任何别的命令（包括同类型、同内容但 commandId 不同的命令）；必须先原样重发原命令 |
| STALE | expectedVersion 与当前 version 不符；hint / submit 的 questionId 不是当前题（迟到的旧题作答）；一条没留下 pending 的失败命令在工作流变化之后被重发 |
| COMMAND_CONFLICT | 同一 commandId（或同一启动 commandId）内容不同 |
| LIMIT | 本题提示数用完；本工作流命令数用完 |
| CAPACITY | 活跃工作流总数或本所有者的活跃数达上限（先清过期；不踢旧的） |

## 4. 可信适配器（Phase 7 的接缝）

两个接口都由可信调用方实现（如题库 / 确定性判分器），**不是模型**。可以同步返回或返回 promise；受 `adapterTimeoutMs` 约束，
超时 / close 后到达的结果不采用，只发一条 `kind:"late"` trace。适配器应当是幂等只读的：evaluate 失败重试时可能被再问一次（评分**已拿到**后不会再问）。

### 4.1 `practice.next(req)`

- req（冻结）：`{ ctx, topicId, lang, round, exclude:[已出过的 questionId] }`。
- 回包恰好 `{ questionId, topicId, prompt, answerKey? }`：questionId 按事件 id 规则、不能是本工作流出过的；topicId 必须等于工作流的话题；
  prompt 1–1000 字符文本；answerKey 可选 1–200 字符文本。多余字段（`answer`、`solution`……）、getter、类实例、Proxy 异常 → PRACTICE_INVALID。
- **模型生成的练习文字不是题目**：只有这个接口给的结构化题目会进入 Practice。answerKey 只存在工作流私有状态里，只交给 grader。

### 4.2 `grader.grade(req)`

- req（冻结）：`{ ctx, topicId, questionId, prompt, answerKey|null, answer, attemptId }`。
- 回包恰好 `{ outcome: "correct"|"wrong"|"uncertain", mistake? }`；`mistake` 只能随 `wrong` 出现，且 ∈ concept / calculation / reading / careless / prerequisite-gap。
  其它任何形状（多余字段如 score / feedback、大小写不同、字符串 "correct"、null、getter、类实例）→ GRADER_INVALID，**不猜对错、不猜误因**。
- **从不根据 TutorAgent 的文字判分**：TutorAgent 在工作流里只负责讲解 / 提示 / 诊断反馈，它说的「对 / 错」不进入任何状态。
- **内置确定性 grader（#38）**：`require("./lib/ai/verification/index.js").createAnswerGrader()` 可以直接传给 `grader`：只比较受支持的数字（整数 / 小数 / 分数 / 带分数，精确有理数），
  值不同 → wrong、同值同写法 → correct，其它（值同写法不同、单位、代数、文字、答案键缺失或不支持）→ uncertain；**从不给 mistake**。见 `docs/tutor-verification.md` §2。
- `uncertain` 是合法的结论：不写结果事件（Phase 5 投影里这次尝试保持 `unsettled`），`uncertain` 计数 + 1，Adapt 换下一题。

## 5. 幂等、并发、失败与重试

- **commandId**：同一工作流内，已成功的 commandId 再来且内容相同 → 返回**同一个**冻结结果（不重跑、view 是当时的）；内容不同 → COMMAND_CONFLICT。
  这两项检查排在版本 / 阶段检查之前，所以成功命令的原样重放在工作流前进之后也照样拿到原结果。
  启动用 `start.commandId` 按所有者去重：同内容返回同一个工作流（当前 view），不同内容 → COMMAND_CONFLICT；去重记录随工作流过期 / 关闭一起删除。
- **失败命令的重发**：
  - 留下了 pending 的失败命令（写失败）：见下面「挂起副作用」，只有它自己能继续，而且**跳过 expectedVersion 和阶段检查**（version 是被它自己的 pending 抬高的）。
  - 没留下 pending 的失败命令（拒答、适配器失败、评分非法……）：只要工作流的 version 还是它失败时的值，就可以原样重发（照常过版本 / 阶段检查）；
    一旦别的命令让工作流变了，再重发它 → STALE，不会在新的状态下补做一次（例如提示 A 失败、提示 B 成功之后，重发 A 不会产生第二个提示）。
  - 被拒绝（reject）的命令从没执行过，不记入 commandId 表；之后再发就是一条新命令。
- **并发**：同一工作流同时只执行一个命令。在途时同 commandId 同内容（双击）→ 共享同一次执行和同一个结果；其它命令 → BUSY（明确拒绝，不排队）。`get` 不受影响。
  不同工作流 / 不同所有者之间没有共享可变状态；同一所有者的事件写入由 memory store 的队列串行（组合测试里两个工作流并发写同一文件不丢事件）。
- **越序与迟到**：阶段不允许 → ILLEGAL_COMMAND；`expectedVersion` 可防止基于旧视图的命令；hint / submit 带的 questionId 不是当前题 → STALE。
- **事件 id 全部由 workflowId 派生**（workflowId = `w` + 24 位随机 hex）：lesson `${w}.c`；hint `${w}.q${round}.h${k}`；尝试 `attemptId = ${w}.q${round}.a${k}`，
  其 `question_attempt` 事件 `${attemptId}.qa`、结果事件 `${attemptId}.r`。每个真实尝试一个稳定 attemptId，恰好一个 question_attempt、至多一个结果。
- **挂起副作用（pending）**：每步先完成外部调用，再写事件，写成功才发布结果。pending 属于**创建它的那一条命令**（commandId + 规范内容，内容不可变）：
  只有原样重发这条命令才能继续；任何别的命令（同类型换个 commandId 也一样）→ PENDING_OPERATION；同一 commandId 换内容 → COMMAND_CONFLICT。
  继续成功后，原命令的结果被缓存，再重放拿到同一个结果，不会产生第二个提示 / 尝试 / 结果。
  - lesson / hint：TutorAgent 的文字先私下存住；写失败 → STORE_FAILED、reply 为 null；重试（`teach` / `hint`）**不再问模型**，只重写同一条事件，成功后才把存住的文字给出。
  - submit：`question_attempt` 写失败 → 保持 answer + pending；原命令重发沿用同一 attemptId 和**原来的作答**。已提交（或结果未知）的尝试不会被换绑到另一个作答上：
    想改答案只能等这次尝试写成功、评完，再按正常流程作答。
  - evaluate：评分拿到后先私下存住；结果事件写失败 → 重试只重写这条事件，**不再问评分器**，同一次尝试不会出现两个结果。
  - 有 pending 时只允许原命令和 close，`view.pending = { type, commandId }` 标出要重发的命令。
  - store「已提交但报错」（结果未知）后重试：同一 eventId 同内容 → memory 返回 duplicate，不重复计数。teach / hint / submit / evaluate 四类都有「提交前失败」和「已提交但回报失败」两种用例，
    核对事件恰好一条、模型 / 评分器没有被再问（文件 store 另有 rename 失败 / 落盘后报错 / open 失败的故障注入）。
- **拒答 / 安全 / 出错**：不写任何事件、不前进、不留 pending；可以直接重试。remediate 被拒（例如作答里有注入样的文字）时会一直停在 teach，调用方应 close。
- **close**：随时可调、立即返回 status closed 的最后视图并删除工作流。在途命令的 TutorAgent 调用（经 `signal`）、题目 / 评分 / memory 读取被 abort，
  正在等待的事件写入也不再等——命令立即以 CLOSED 结束、不再写后续事件。**已经交给 memory 的那一次 appendEvent 不能撤销，仍可能之后落盘**
  （例如 lesson 事件已落盘但文字没给出）；迟到的回调只会看到「已关闭」，工作流已从表里删除，不会被复活。不宣称跨模块事务。
- **时限与 TTL**：
  - TutorAgent：每次 ask 受 tutorTimeoutMs（默认 120 s）约束，另有 TutorAgent 自己的 totalTimeoutMs（默认 90 s）；超时 → TUTOR_TIMEOUT，并 abort 交给它的 signal。
  - 题目 / 评分接口、Diagnose 的 memory 读取：adapterTimeoutMs（默认 10 s）；超时放弃结果（它们应当无副作用，放弃是安全的）。
  - memory 写入：**不设超时、不竞速**。写入一旦交出就可能提交，超时后报「失败」会让重试和计数说谎；卡住的 store 会让这个工作流一直 BUSY，直到写入结算或 close。
  - 命令在途时工作流**不过期**（TTL 暂停），命令结束时续期到 now + ttlMs。所以在途时长的上界 = 各步外部调用的时限之和，只有卡住的 memory 写入没有上界；
    这种情况只能 close（立即返回、释放名额）。get 不续期。
- **trace 失败**不影响结果：onTrace 同步抛错 / reject 只交给 onTraceError，那里再出错也吞掉。

## 6. 隐私：什么会交给模型

TutorAgent 收到的 `question` 只由固定模板 + 下面这些字段拼成（上限合计 < 2000，TutorAgent 的输入上限）：

| 步 | 字段 |
|---|---|
| lesson | `title`（≤120）、`goal`（≤300） |
| hint | 题面 `prompt`（≤1000） |
| remediate | `prompt`、孩子**本次**作答 `answer`（≤500）、评分器给的 `mistake` 枚举（如有） |

- **不会**交给模型：answerKey、Student Memory / 历史投影、其它话题、偏好、旧 attemptId、topicId、userId / kidId（ctx 只作为 TutorAgent 的 ctx 参数，Harness 不放进模型请求）。
  组合测试逐条检查回放模型收到的全部请求（system + messages）。
- **本地验证上下文（#38）**：交给 TutorAgent 的请求多一个 `verify = { topicId, answerKey? }`（hint / remediate 步带当前题的答案键）。TutorAgent 只在结果校验里用它
  （hint 步显式说出答案键、正文里出现不是本话题也没查过的课程 id → 退回模型重写），**不放进模型请求、trace、错误信息**；`test_verification.mjs` / `eval_verification.mjs` 逐条核对。
  也就是说答案键现在除 grader 外还交给了**本进程内**的 TutorAgent 校验代码；注入的 tutor 必须是可信的本地实现。
- 拿回来的文字工作流再本地复核一次（注入的 tutor 未必是真 TutorAgent）：显式算术等式为假、hint 步显式说出答案键、socratic-teaching 步不是问句 → TUTOR_ERROR / VERIFICATION，
  固定出错模板，不前进、可原样重发。（兼容性：以前注入的 tutor 在 socratic 步回非问句也会前进；片 1 的合成 tutor 为此在 socratic-teaching 下回复末尾加了问号。）
- TutorAgent 的门控不变：每次都过预闸 + 语义分类 + 结构化结果校验，工具仍只有两个只读工具；工作流不给 TutorAgent 任何新工具，也不把 store / appendEvent 交给模型。
- Diagnose 读投影只在服务内部用于选策略，不存、不外传。
- 学习事件里只有 Phase 5 白名单字段（标识、类型、时间、有限枚举）；题面、作答、模型文字都不落盘。
- 私有状态（题面、answerKey、本次作答、存住的 TutorAgent 文字）只在进程内存，进入 practice / done / close 时丢弃对应部分。
- trace：`{ kind:"workflow", workflowId, command, from, to, ok, code, questionId?, attemptId?, at, ms }` 和 `{ kind:"late", workflowId, source: tutor|practice|grader|memory, ok, at }`，
  null 原型、没有任何文本。默认的 onTraceError 只打印 `kind`，不打印回调抛出的错误信息（那里面可能是任意文本）。

## 7. 测试

```
node tools/test_tutor_workflow.mjs      # 233 项
node tools/test_verification.mjs        # #38：后置条件反例、确定性 grader、本地复核在真实工作流 + memory + TutorAgent 上的路径
```

- 片 1（合成适配器 + 真实 createMemory + 内存桩 store）：49 格命令表、Adapt / Diagnose 决策表、命令与启动参数拒绝面、适配器回包拒绝面；
  中英无关的完整正确回路、错误 → remediate → 再答、轮数用完、历史不外传、拒答 / 安全 / 出错零事件、题目 / 评分失败 / 非法 / 超时 / 迟到、
  teach / hint / submit / evaluate × 提交前失败 / 已提交但回报失败：pending 只属于原命令（别的 commandId → PENDING_OPERATION、换内容 → COMMAND_CONFLICT、原命令带着旧 expectedVersion 也能继续）、
  事件与模型 / 评分调用精确一次；没留下 pending 的失败命令在状态变化后重发 → STALE；commandId 重放 / 冲突 / 双击 / BUSY / STALE、跨所有者、输入变异、
  Object.prototype 污染下的完整回路（缺省的 expectedVersion / reply / detail / mistake / attemptId / questionId 都不被继承）、
  首课事件与策略对齐、TTL / 容量 / 上限 / 时钟、TutorAgent 与 memory 读取的时限、在途 close（含卡住的 memory 写入）、trace 回调故障与默认上报不打印错误信息。
- 片 2（真实 TutorAgent：回放模型 + 真实工具注册表；真实 createMemory + createFileStore，fs.mkdtemp 临时目录，finally 删除）：
  zh 完整回路（含工具调用、hint 步给答案被退回重写）、socratic 首课走真实 TutorAgent 且不记 concept_explained、en 错误 → diagnose-error → 答对（含预置私密历史）、zh 错误 → 诊断 → 再错 → 轮数用完不掌握、分类器拒答、作答自伤求助、作答里的注入在 remediate 被预闸拒、
  模型错误 / 分类器输出不合格、评分不确定、文件 store 故障（rename 失败 / 落盘后报错 / open 失败）、进程重启、同一文件上两个工作流并发、等模型时 close。

## 8. 限制（重要）

- **进程内、不可恢复**：工作流状态只在一个服务实例的内存里；进程重启 / 多实例都看不到，旧 workflowId → NOT_FOUND，挂起的副作用丢失（已写入的学习事件不丢）。
  重启后若旧工作流有一个已写 `question_attempt` 但没结果的尝试，它在投影里永远是 unsettled。
- **没有跨模块事务**：TutorAgent 调用、适配器调用和事件写入是分开的步骤；靠稳定 eventId + 挂起重试做到「每个副作用至多记一次」，不是原子提交。close 时在途写入可能仍完成。
- **评分只信注入的 grader**：#38 提供了确定性的 `createAnswerGrader`（只覆盖数字答案，其余一律 uncertain），但工作流不强制用它；答案键是否被题面泄露（prompt 里写了答案）不在检查范围。
- **TutorAgent 的文字只有规则级验证**：#38 起 hint / remediate 里「= 答案」「答案是 …」这类显式形式、假的显式算术等式会被拦下（数字答案键才覆盖）；
  换个说法说出答案、诊断是否准确、讲解的非算术部分仍没有 verifier（见 `docs/tutor-verification.md` 覆盖表）。
- **后置条件失败不回滚**：INVARIANT_FAILED 时这一步已经交给 memory 的事件照原样保留（例如 evaluate 已记 `answer_correct` 而 adapt 失败）；工作流被终止、不宣称完成。
  后置条件是对本模块实现的独立检查，正常情况下不应触发；触发说明代码有 bug，应当排查而不是重试。
  remediate 会把孩子本次作答交给模型（有长度上限）；作答只在提交时过确定性自伤求助预闸，其它内容照原样作为数据交给评分器和 remediate。
- 卡住的 memory 写入没有时限（见 §5「时限与 TTL」）：工作流一直 BUSY、不过期，只能 close。TutorAgent 最长 tutorTimeoutMs、适配器最长 adapterTimeoutMs，这段时间里该工作流 BUSY。
- socratic-teaching 首课不记任何事件（现有事件表没有「引导提问」）；Student Memory 里因此看不到这类互动。
- 活跃上限是进程级的；done 的工作流在 close 或过期前仍占名额。每个工作流缓存已成功命令的结果（上限 maxCommands 条），最坏内存约 maxWorkflows × maxCommands × 视图大小（默认配置下为几十 MB 量级）。
- 没有 HTTP、界面、家长可见记录、家庭隐私设置；把工作流接到路由前需要 `allow` + `resolveKid` 注入 ctx、限速、`YY_DEMO` 下禁用，并确定 `plan.strategy` / 计数是否给孩子看。
