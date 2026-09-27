# Tutor Harness 与只答学术问题的 TutorAgent（#28，#19 Phase 3）

状态：后端模块和回放 eval；#53（Phase 9a）起 server.js 有一个**默认关闭**的 `POST /api/tutor/ask`（§5），**没有孩子端聊天界面**。现有固定流程（讲课、闯关、单元卷、FSA、报告）和 `lib/actions/_engine.js` 的 `generateOnce` 一行没动。

```
lib/ai/harness/index.js    单智能体循环 createHarness
lib/ai/harness/replay.js   确定性回放 Provider createReplayModel
lib/ai/skills/index.js     内置教学 Skill 目录（#30，Phase 4a；教学策略 #31，Phase 4b）：TutorAgent 两段提示词的来源
lib/ai/tutor/index.js      TutorAgent：预闸 + 语义分类接缝 + Harness + 结构化校验（schema 在这里，其余规则在 lib/ai/verification，#38）
tools/test_harness.mjs     Harness 单测（72 项）
tools/eval_tutor.mjs       TutorAgent 回放 eval（68 项，其中 46 条中英用例在 tools/fixtures/tutor_eval.json）
tools/test_skills.mjs      Skill 目录单测 + 真实 TutorAgent 两段请求核对（50 项）
tools/test_tutor_strategies.mjs  教学策略选择 / 快照 / hint 优先 / 门控与权限 + 中英回放（136 项，其中 19 条在 tools/fixtures/tutor_strategies.json）
```

这几个脚本都不起服务器、不读 `data/`、不调任何真实模型，零成本。

## 1. Harness 入口契约

```js
const { createHarness } = require("./lib/ai/harness/index.js");
const h = createHarness({
  registry,                      // lib/ai/tools 的 registry（需要 get / describe / invoke）
  tools: ["calculator.evaluate"],// 本 Harness 能用的工具名单
  allowRisks: ["read"],          // 名单里每个工具的 risk 必须在这里，否则构造时 TypeError
  maxSteps: 6,                   // 模型回合上限
  maxInvalid: 2,                 // 非法回合 + 不合格 final 的修复机会（合计）
  modelRetries: 1,               // 模型 reject 后重试次数（超时不重试）
  stepTimeoutMs: 30000,          // 单次模型调用
  totalTimeoutMs: 90000,         // 整个 run：模型、工具、异步 validateFinal 都算
  onTrace, onTraceError, now,
});
const r = await h.run({ ctx, model, system, input, validateFinal, signal, deadlineAt });
```

- `run` **永远 resolve**：`{ ok:true, output, steps, calls, runId }` 或 `{ ok:false, error:{ code, message }, steps, calls, runId }`。
  停止码：`MAX_STEPS / TIMEOUT / CANCELLED / MODEL_ERROR / BAD_MODEL_OUTPUT / INVALID_FINAL / INVALID_CTX / INVALID_INPUT / INTERNAL`。
- **输入边界**：`system` 是字符串，`input` 是字符串或纯 JSON 值，`deadlineAt` 是有限数字，否则 `INVALID_INPUT`，模型不被调用。`registry.describe` 抛错之类的意外一律收口成 `INTERNAL`。
- **模型接口** `model.next(req) => Promise<turn>`，`req = { system, messages, tools, step, signal }`（冻结；messages / tools 是深拷贝；tools 是 `registry.describe()` 的结果，没有 `run`；没有 ctx）。回合只认两种：
  - `{ "type":"tool_call", "tool":"calculator.evaluate", "input":{...} }`
  - `{ "type":"final", "output": ... }`
  其它字段一律不读（回合里写 `ctx` 没用）。整个回合必须是**纯 JSON 值**（有限数字、纯对象 / 数组、无环；不能有函数、BigInt、undefined、NaN、类实例），否则按 `BAD_MODEL_OUTPUT` 处理，不会被序列化悄悄改掉（NaN 变 null、函数被丢掉）再塞进 Tool 入参。
- **messages**：`user`（input）→ `assistant`（toolCall / final）→ `tool`（observation：`{ ok, result | error, truncated? }`，超过 4000 字符只给 preview）→ `harness`（`BAD_MODEL_OUTPUT` / `INVALID_FINAL` 的说明，让模型修）。
- **ctx** 由调用方注入，run 开始时拷贝冻结成 `{ kidId, role, userId }`；role 只能是 student / parent。之后调用方再改原对象、模型回合里写什么都不影响。
- **validateFinal(output, info)**：`info = { calls, steps, evidence }`。`evidence`（#38，纯增量）是本 run 里成功、且结果没被截断的工具调用 `[{ tool, input, result }]` 的深拷贝——
  和模型在 observation 里看到的是同一份数据，给「声明要有证据」的检查用（见 `docs/tutor-verification.md`）。

### 工具调用规则

| 情况 | 给模型的 observation | 进 registry 吗 |
|---|---|---|
| 不在本 Harness 名单 | `TOOL_NOT_ALLOWED` | 否 |
| write / spend 工具本 run 已 TIMEOUT / INTERNAL（结果未知） | `UNCERTAIN_SIDE_EFFECT` | 否 |
| 其它 | registry 的结果原样：`INVALID_INPUT / PERMISSION / TIMEOUT / ACTION / INTERNAL` 或成功；回包形状不对（`{ok:false}` 没有 `error.code`、非对象、reject）→ `INTERNAL` | 是 |

Harness **从不自动重试工具**；读工具失败后模型可以自己再调，写 / 花钱工具结果未知（TIMEOUT / INTERNAL，含回包畸形）后本 run 内不论参数都不再调。

### 时间、取消、迟到结果

- 每次调用（模型、工具、validateFinal）用绝对截止时间框住：**调用前**先查已取消 / 已到时，是就根本不调（不产生副作用，包括同步 trace 回调里 abort 或占掉预算的情况）；**结果到达时**再查一次，过了截止时间的结果不采用；final 在提交前（校验之后）还要再过一次同样的检查，模型直接给 final 时也不例外（覆盖同步阻塞后返回、经已 resolve 的 promise / 微任务链送达的过期结果）。模型另受 `stepTimeoutMs`，工具自己的 `timeoutMs` 更长也会被总时限截断。JS 不能打断正在同步阻塞的代码，只能拒绝它的结果并停止后续步骤。
- `signal` abort → 立即 `CANCELLED`；run 结束时 Harness 也 abort 自己传给模型的 `req.signal`，好让真实适配器停掉请求。
- 被丢下的 promise 结算后只发一条 `kind:"late"` trace，结果不采用，reject 被接住，不会有未处理拒绝。**限制**：已经发出的写工具在取消后仍可能在后台完成（registry 没有撤销能力）；TutorAgent 不给写工具，所以本阶段不涉及。

### trace

每步一条 `{ runId, step, kind, ok, code?, tool?, source?, ms, at }`，kind ∈ `model / retry / tool / invalid / final / stop / late`，不含提问原文和工具入参。registry 自己仍会对每次 invoke 发它的 tool trace。回调同步抛错 / reject 只交给 `onTraceError`，那里再出错也吞掉，业务结果不变。

## 2. TutorAgent

```js
const { createTutorAgent } = require("./lib/ai/tutor/index.js");
const agent = createTutorAgent({ registry, model, classifierModel, maxSteps, stepTimeoutMs, totalTimeoutMs, onTrace, onTraceError });
const r = await agent.ask(ctx, { question, lang: "zh" | "en", mode: "answer" | "hint", strategy, verify, signal });   // strategy 可选（#31，见 §2.2）；verify 可选（#38）
// r = { ok, kind: answer|hint|refusal|safety|error, text, gate:{ stage, label, rule? }, steps, calls, checks?, error?, strategy?, verification? }
```

- `verify`（#38，可选）：可信调用方给的本地验证上下文 `{ topicId?, allowedTopicIds?, answerKey? }`，公开入口同步严格读取（只认自有数据属性、getter 不执行、多余键拒绝），
  不合契约 → `INVALID_INPUT`（stage input，不调模型，错误信息不回显内容）。它**只交给结果校验**，不进模型请求、system、trace、错误信息；
  传了 verify 的 answer / hint 结果多一个冻结的 `verification` 覆盖摘要。不传时请求、提示词、结果形状与之前逐字相同。规则见 `docs/tutor-verification.md`。

- `ctx` 由可信调用方给（将来的路由：`allow` → `resolveKid` → `actx`），和 Action / Tool 同一个形状。`ask` 在公开入口**同步**取 ctx 和请求字段（question / lang / mode / strategy / signal）的快照，每个字段只读一次，分类和作答两段都用它；调用方拿到 promise 后同一个 tick 里或中途改自己手里的对象，都不影响这次 ask 和任何工具调用。
- **可用工具只有两个，都是只读**：`calculator.evaluate`（确定性算术）、`curriculum.findTopic`（查大纲条目，不碰孩子数据）。registry 里其余 11 个工具（含 `questions.*` 写入 / 花钱、`student.*` 孩子数据、`learning.getReport` 家长专用）一个不给。
- `ask` 永远 resolve；拒答、安全提示、出错的正文都是固定中英模板（`TEXTS`），模型的自由文本只在 `answer` / `hint` 时给孩子。
- `lang` 未知时按 zh；`question` 1–2000 字符；`mode` 只能 answer / hint。

### 学术范围门控（分层，都不是绝对保证）

| 层 | 做什么 | 命中后 | 已知边界 |
|---|---|---|---|
| 0 输入 | ctx / question / mode 校验 | `error`（INVALID_CTX / INVALID_INPUT），不调模型 | — |
| 1 确定性预闸 `classifyScope` | 中英正则：安全求助 → 提示注入 → 非学术**请求**；再看有没有数学信号。NFKC、去零宽字符，中文规则在去空白后的文本上匹配 | `safety` / `refusal`（数学 + 越界请求 = mixed，也拒），不调模型、不调工具 | 只认写进规则的说法；换个说法、错别字、别的语言就漏。针对「请求」而不是名词，所以应用题里的游戏 / 电影不会被误拒，但也意味着只提名词的闲聊要靠下一层 |
| 2 语义分类（每次都跑）`classifierModel` | 同一个 Harness、零工具、分类提示词，模型只输出 `{ label, reason }`，label ∈ math / other_academic / non_academic / mixed / injection / unsafe，schema 校验。**没给 `classifierModel` 时用主模型单独做一次分类调用**，不存在「命中数学关键词就直接回答」的路径 | 非 math 一律拒答（other_academic 用「只辅导数学」模板）；分类失败 / 超时 / 输出不合格 → `error`（fail closed） | LLM 语义判断会错，也可能被精心构造的输入骗过；用同一个模型分类和作答，两步可能被同一段输入一起带偏。eval 只证明**管线**按标签正确收口，不衡量分类准确率 |
| 3 结构化结果校验 | final 必须 `{ kind, text, scope, checks? }`；非 math scope 只能 refusal；hint 模式不许 answer；正文再过预闸规则、禁止链接；`checks` 用 calculator 复算（相对误差 1e-9）；#38 起正文里**显式、边界干净**的纯算术等式按精确有理数核对（不传 verify 也生效）；传了 verify 再查课程 id 证据、计算器声明、hint 显式泄露答案键、socratic 问句 | 不合格 → 退回模型重写（最多 2 次），仍不合格 → `error`；refusal 换成模板 | 正文检查同样是规则；边界不干净的等式（「15% of 80 = 12」「2x + 3 = 11」）不检查；数学讲解本身对不对（非算术部分）没有 verifier，见 `docs/tutor-verification.md` 的覆盖表 |

「学术」在本阶段按 #19 的决定取最窄：只辅导数学；其它学科礼貌拒答并引导回数学。放宽只需改 `REFUSAL_TEMPLATE` 和提示词。

提示词见 `TUTOR_SYSTEM` / `CLASSIFIER_SYSTEM`：问题放在 user 消息的 JSON 字段里当数据，工具结果也是数据。两份原文从 #30 起放在 Skill 目录里（见 §2.1），tutor 模块照旧导出这两个名字，内容与 Phase 3 逐字相同。

### 2.1 内置 Skill 目录（#30，Phase 4a）

```js
const { getSkill, listSkills, composeSkills, selectTutorSkills, SkillError } = require("./lib/ai/skills/index.js");
getSkill("math-tutor");                  // 冻结的 { id, version, stage, base, description, instructions }；未知 → null
listSkills();                            // 每次新数组：[math-tutor, math-scope-classifier, 7 个教学策略]
composeSkills(["math-tutor"]);           // 冻结的 { stage, ids, skills:[{id,version}], system }
selectTutorSkills();                     // 冻结的 { tutor, classifier, strategy:null, mode:"answer" }，TutorAgent 构造时取一次
selectTutorSkills({ strategy, mode });   // #31：按策略 / 模式选组合，见 §2.2
```

| Skill | stage | 用在哪 |
|---|---|---|
| `math-tutor` v1 | tutor | Harness 作答回合的 system（= `TUTOR_SYSTEM`） |
| `math-scope-classifier` v1 | classifier | 每次作答前语义分类的 system（= `CLASSIFIER_SYSTEM`） |

- **Skill 只是文本**：没有函数、工具名单、权限字段。TutorAgent 能调哪两个工具、预闸 / 分类 / 结果校验怎么判、拒答用哪条模板、身份快照、取消和共享总时限，全部还在 `lib/ai/tutor` 与 `lib/ai/harness`，换哪个 Skill 都不会多给能力。
- **目录不可污染**：内部用 `Map` 查找，`"__proto__"` / `"toString"` 这类原型链名字、`Object.prototype` 上后加的属性都查不到；Skill 对象冻结，`listSkills` 每次返回新数组，`composeSkills` 的结果深冻结。
- **组合规则**：`ids` 必须是真数组、1–32 个、元素全是字符串（空位、数组样对象、Set 都拒绝，只按下标读一遍）；去重保序；恰好一个 base Skill 且排第一；所有 Skill 同一个 stage。`system` = 按顺序空行拼接，单个 Skill 时就是原文。错误是带 `code` 的 `SkillError`：`INVALID_SKILLS` / `UNKNOWN_SKILL` / `INVALID_COMPOSITION` / `INVALID_OPTIONS`；读数组时的意外（撤销的 Proxy、getter 抛错，包括调用方自己抛出的 `SkillError`）一律收成我们自己的 `INVALID_SKILLS`，不透传外部的 code / message；错误信息只回显形如 `math-tutor` 的普通 id。
- `selectTutorSkills` 的选项（#31 起）只认 `{ strategy, mode }`，细节见 §2.2；不传、`{}`、null 原型的 `{}` 都返回同一份默认组合（与 #30 相同）。
- `createTutorAgent` 返回的对象多了 `skills: { tutor: [...ids], classifier: [...ids] }`（副本，永远是默认组合，不反映某次 ask 的策略），方便 trace / 调试。
- 兼容性由 `tools/test_skills.mjs` 守：两份提示词和 `TURN_FORMAT` 的 sha256 钉在 fe2bdda 的值上，真实 TutorAgent 的分类请求、每个作答请求（含 hint 被退回后的修复回合）的 `system` 都核对到目录原文，answer / hint 回放结果和工具权限与 Phase 3 相同；另用 require.cache 换上桩目录重新加载 tutor，桩里的标记文本必须出现在两段请求里，证明 system 确实取自目录（tutor 退回内联常量会让这条失败）。

### 2.2 教学策略（#31，Phase 4b）

```js
const { TUTOR_STRATEGIES } = require("./lib/ai/skills/index.js");
// ["math-tutor", "give-hint", "explain-concept", "socratic-teaching", "diagnose-error", "practice-generator", "evaluate-answer", "curriculum-navigation"]
await agent.ask(ctx, { question, lang, mode, strategy: "diagnose-error" });
```

| strategy | tutor 段组合 | 实际输出模式 | 指令要点 |
|---|---|---|---|
| 不传 | `math-tutor` | `mode`（默认 answer） | 与 Phase 3 逐字相同：system、user 消息 `{question, lang, mode}`、结果形状都不变 |
| `math-tutor` | `math-tutor` | `mode` | 显式只用 base；user 消息多一个 `strategy` 字段 |
| `give-hint` | `math-tutor` + `give-hint` | **总是 hint** | 只给一个提示 / 下一步，不给最终答案 |
| `explain-concept` | + `explain-concept` | `mode` | 讲概念和方法为什么成立，一个小例子；hint 模式只讲概念、不算到孩子的结果 |
| `socratic-teaching` | + `socratic-teaching` | **总是 hint** | 一次只问一个引导问题，不替孩子做 |
| `diagnose-error` | + `diagnose-error` | `mode` | 五类误因（#31 指定）：concept / calculation / reading / careless / prerequisite gap；先用计算器复算孩子的数；不凭一道错题就判「粗心」（要孩子的过程里同一步在别处做对过）；证据不足明确说「还不确定」并追问题目和步骤 |
| `practice-generator` | + `practice-generator` | `mode` | 1–3 道同技能练习，不附答案 / 解答；题里的数照 base 规则核算，`checks` 只放本次写出的数，不把练习答案放进 `checks` 或正文；不保存到任何题库、闯关或进度 |
| `evaluate-answer` | + `evaluate-answer` | `mode` | 用计算器复算孩子的答案再判对错；不记分、不改进度 |
| `curriculum-navigation` | + `curriculum-navigation` | `mode` | 只用 `curriculum.findTopic` 查给定 id，不编造条目 / 先修；看不到孩子的进度 |

- **选择契约**：`selectTutorSkills(opts)` 的 `opts` 只能是不传或纯对象（原型为 `Object.prototype` 或 null），自有键只能是字符串 `strategy` / `mode`，且必须是可枚举的数据属性（getter 不执行，直接拒绝）；多余键、Symbol、不可枚举、数组、Date、Map、类实例、原型上的字段、读时抛错的 Proxy（包括它抛出伪造的 `SkillError`）都是我们自己的 `INVALID_OPTIONS`。`strategy` 为 `undefined` 等于不传；null、非字符串、未知 id（含 `math-scope-classifier`、`__proto__`、大小写或空格变体）都拒绝。`mode` 只能 answer / hint。结果 `{ tutor, classifier, strategy, mode }` 深冻结，所有组合在模块加载时组好，同一 (strategy, mode) 每次返回同一份；`classifier` 永远是 `math-scope-classifier`。读选项时不走原型链，`Object.prototype.strategy` 被污染也不影响。
- **TutorAgent 接入**：`strategy` 与 `mode` 一起在公开入口同步快照（只认 `req` 的自有 `strategy` 属性，只读一次）；未知值在预闸和任何模型调用之前返回 `kind:"error"`、`INVALID_INPUT`（stage input）。选中的组合只决定 tutor 段的 system 和实际输出模式，user 消息为 `{question, lang, mode:<实际模式>, strategy}`；结果和 `kind:"tutor"` trace 多一个 `strategy` 字段。agent 上不存「当前策略」，同一个 agent 的并发请求各自按自己的快照走（测试里错开发起、交错结算的 10 个并发请求逐一核对）。
- **hint 优先**：`give-hint`、`socratic-teaching` 不论 `mode` 都按 hint 输出；`mode:"hint"` 对任何策略都按 hint 输出。落实在结构校验上（`kind:"answer"` 被退回重写），不是只靠提示词。
- **能力不变**：每个策略下预闸（注入 / 安全求助）、语义分类、非 math scope 只能拒答、拒答换固定模板、正文规则复查与禁链接、`checks` 计算器复算、共享总时限（另有确定性时钟用例钉住「分类之后不重新起算截止时间」）、工具名单（仍只有两个只读工具；写 / 花钱 / 孩子数据 / 家长专用工具一律 `TOOL_NOT_ALLOWED`、不进 registry）、registry 收到的 ctx 都与不传策略时相同，`test_tutor_strategies.mjs` 对 8 个策略逐一核对。练习 / 评价 / 课程导航「只读不写学习状态」由工具名单保证：它们本来就拿不到任何写工具。
- **边界（重要）**：7 段教学指令只是提示词。测试里对指令文本的断言只证明「要求写进去了」，**不等于 verifier**：
  - hint 输出只能拦住 `kind:"answer"`；提示正文里用自然语言把答案说出来（「答案是 888」写在 hint 里），只有调用方用 `verify.answerKey` 给了可解析的数字答案键时，
    才按 `docs/tutor-verification.md` 列出的显式形式（「= 答案」「答案是 / the answer is / 等于 / equals 答案」…）拦下；别的说法、非数字答案键仍发现不了。
  - socratic-teaching 只在传了 verify 时强制「正文含问号」；引导问题的质量没有检查。
  - `diagnose-error` 选的误因对不对、证据够不够由模型判断，没有 verifier；回放只证明「还不确定」这类回答能原样走通管线。
  - `practice-generator` 是否真的没附答案、题目难度是否合适，没有检查；`checks` 只复算写进去的算式，发现不了正文里没列进 `checks` 的数，也发现不了模型把练习答案写进 `checks`。策略文本不豁免 base 的核算规则（测试守着：任何策略都不许出现免核算的说法，每个组合里 base 第 2 条逐字都在）。
  - `diagnose-error` 的五类是提示词里的分类表；结果 schema 没有「误因」字段，模型选没选、选得对不对都不做结构校验。
  - `curriculum-navigation` 说的先修 / 后续关系若不是 `curriculum.findTopic` 返回的，运行时没有检查。回放测试另有一条只针对 fixture 的核对：正文里出现的条目 id、`groundedIn` 列的说法必须来自问题或工具回包，没有依据的「先修 / 下一步」说法必须同时说明查不到（先修样例用合成条目 `SYN.MATH.G5.DEC3` 的 `skill.prereq`）。
  - 回放 fixture（`tools/fixtures/tutor_strategies.json`，19 条，8 个策略各至少一条中文、一条英文）用的是写好的模型输出，验证的是策略选择、门控、工具权限和结果收口，不衡量真实模型是否遵守教学指令。

## 3. 回放与 eval

`createReplayModel(turns)` 按顺序返回脚本回合：`{type:"tool_call"...}` / `{type:"final"...}` / `{raw}`（任意值，测非法回合）/ `{error}` / `{hang:true}` / `{delayMs, then}`；用完再调就 reject「replay exhausted」；`calls` 记下 Harness 给的每个请求。

```
node tools/test_harness.mjs
node tools/eval_tutor.mjs            # 全部
node tools/eval_tutor.mjs --only zh-privilege-escalation
node tools/test_skills.mjs
node tools/test_tutor_strategies.mjs
```

eval 用真实 `createTools` 注册表（桩 Action：任何 Action 被调都记失败），外面套一层 spy 记录每次 invoke 的工具名、ctx、risk。每条用例断言 kind / gate / 模板文案 / 错误码 / registry 实际收到的工具序列 / 模型与分类器调用次数，并对所有用例检查不变量：只有两个只读工具到过 registry、registry 收到的 ctx 与调用方一致、预闸拒答零模型零工具、tutor 作答前一定有过分类调用且分类请求不带工具、超时 / 取消 500ms 内收口、全程无未处理拒绝、Action 零调用。

用例分类（46 条）：正常数学、常见误区、只要提示（含模型越界给答案被退回）、非学术、数学 + 越界混合（预闸抓到 / 预闸漏掉由分类器抓到）、提示注入（全角、插空格、零宽字符、预闸漏掉由分类器或模型抓到）、其它学科、不给分类模型时由主模型分类（含恶意模型把「数学 + 闲聊」直接作答被分类 schema 拦下）、应用题里有游戏名词不误拒、非法工具参数、越权工具与伪造 ctx、calculator 复算不符被退回、回答正文带链接 / 闲聊被退回、模型异常重试与失败、工具异常、模型超时、分类器超时、分类器 + 模型共享总时限、步数耗尽、取消、安全求助（预闸 / 分类器）、家长角色、非法角色、分类器输出不合格。

**录制**：本阶段没有录制器。将来要录真实调用做回放时，只能在隔离数据目录、用合成问题录，不默认发送真实学生数据。

## 4. 与现有代码的接缝和后续

- `generateOnce` 与六类固定任务不迁入 Harness（issue 写的是「若迁入」，本阶段取不迁，契约零风险）。以后要迁时，一个「单回合、零工具、validateFinal = 现有 validateX、modelRetries = 1」的 Harness run 就是它的等价物，但必须保留提示词、重试次数和 `kidTxn(keep)` 落盘在事务外的边界。
- **模型接缝（Phase 8，#40）**：`lib/ai/models` 的 `createModelRouter` 把一个能力 intent（fast / reasoning / vision / cheap / local / privacy-sensitive）绑成 `{ next(req) }`，直接当 `model` / `classifierModel` 传进来；
  `createLegacyProvider` 把 `runEngine` 包成 provider：`system` 原样后接固定的 transcript + 回合说明（契约放在 system 里，七个适配器都会发出去）、`messages` / `tools` 作为 JSON 数据，回合形状仍由本 Harness 判（修复语义不变），记账照走 `runEngine`（任务名显式注入，如 `tutor`、`tutor:classify`）。
  Harness / TutorAgent 没有改动；Router 调用后失败不换商，重试仍只由 `modelRetries` 管。**还没接 server.js / HTTP**。契约、硬约束、取消边界见 `docs/model-routing.md`。
- 暴露给孩子前还需要：~~路由（`allow` + `resolveKid` 注入 ctx、限速、`YY_DEMO` 下禁用）~~（#53 已做，默认关，见 §5）、界面、家长可见的对话记录与开关、离线的分类质量评测（带人工标注的中英问题集），以及用户确认。
- Phase 4（Skills）：TUTOR_SYSTEM / CLASSIFIER_SYSTEM 已是第一对 Skill（#30，§2.1），按教学策略组合见 §2.2（#31）；谁来选策略：Phase 6 工作流按阶段选（见下），路由 / 家长设置还没接；Phase 5（Memory，#34）：`lib/ai/memory` 已有临时 Session、白名单 Learning Events 和纯投影 Student Memory（见 `docs/tutor-memory.md`），但 Harness / TutorAgent 都没接：工具名单不变，模型拿不到 store，也看不到学习状态；以后要把 Session 或 Student Memory 交给模型（只读工具或提示词里的字段），先定给哪些字段、家长开关和隐私边界，写事件仍只由可信调用方做，给 TutorAgent 加只读的 `student.getProgress` 同理；Phase 6（结构化辅导流程，#36）：`lib/ai/workflows` 的 Diagnose → Teach → Practice → Evaluate → Adapt 状态机（见 `docs/tutor-workflow.md`）按阶段替 TutorAgent 选 `strategy`（explain-concept / socratic-teaching / give-hint / diagnose-error），只通过公开的 `ask` 调用，门控、工具名单、结果校验不变；TutorAgent 的文字只给孩子看，不参与判分和阶段转换，学习事件由工作流经 memory 写；Phase 7（Verifier，#38）：`lib/ai/verification`——TutorAgent 的结果校验规则抽到 `verifyResponse`（旧文案逐字不变）并加了正文算术等式和可信上下文规则，
工作流有确定性答案 grader 和步骤后置条件，见 `docs/tutor-verification.md`；Phase 8（模型抽象，#40）：上面的 Router 与旧引擎桥，见 `docs/model-routing.md`。

## 5. HTTP 接入：`POST /api/tutor/ask`（#53，Phase 9a）

```
lib/ai/tutor/service.js      createTutorService：选引擎、按 (引擎, 语言) 懒建 Router + TutorAgent、限速、在途互斥、回包白名单
server.js                    路由本身：开关 → allow → 读 body → actx → service.ask；客户端断开就 abort
tools/test_tutor_route.mjs   进程内隔离实例 + 桩 claude 适配器的 HTTP 回归（53 项）
```

**开关**：`config.json` 里 `tutorAgent.enabled === true` 才开（字符串 `"true"` 不算），`YY_DEMO` 下永远关。关着时 404 `{ tutorDisabled:true }`，在鉴权之前就回，不调模型。

```jsonc
"tutorAgent": { "enabled": false, "perMinute": 6, "stepTimeoutMs": 120000, "totalTimeoutMs": 300000 }
```

数值不合规（非整数、越界）按默认处理，不报错；`stepTimeoutMs` 不会超过 `totalTimeoutMs`。

**请求**（学生或家长登录，`x-session` 头；body ≤ 16 KB）：

```json
{ "question": "What is 12 times 3?", "lang": "en", "mode": "answer", "strategy": "give-hint", "kid": "k..." }
```

只认这五个字段，多余字段或类型不对 → 400。`lang` 只能 zh / en（缺省 zh，别的值 → 400）；`mode` / `strategy` 的取值和 `question` 的长度由 TutorAgent 校验（§2），不合规 → 400。
`kid` 只给家长用，照 `resolveKid` 规则；家长有多个孩子又没指定、或指定了不是自己家的孩子时 ctx.kidId 为 null（不报错）——TutorAgent 的两个只读工具都不需要孩子。
`mode` / `strategy` 由请求方自己选，**孩子也能选**：发 `mode:"answer"` 就绕开了「只给提示」。9a 默认关、没有界面，所以暂不收紧；开放给孩子之前要按角色或家长设置限定。

**回包**（白名单）：`{ kind, text, lang, strategy?, code? }`

| 情况 | HTTP | body |
|---|---|---|
| answer / hint | 200 | `kind` + 模型正文（已过 §2 的结构校验与计算器复算） |
| refusal / safety（预闸、分类器、模型 scope） | 200 | 固定模板 |
| TutorAgent 出错（引擎失败、超时、取消、校验重试用完） | 200 | `kind:"error"` + 固定模板 + `code`（MODEL_ERROR / TIMEOUT / …） |
| TutorAgent 的 INVALID_INPUT / INVALID_CTX | 400 | 同上 |
| body 不是 JSON、字段不对 | 400 | `{ error, code:"INVALID_INPUT" }` |
| 同一账号已有一个在途 | 429 | `{ code:"BUSY" }` |
| 超过每分钟 `perMinute` 次 | 429 | `{ code:"RATE_LIMITED" }` |
| 没有可用引擎 | 503 | `{ code:"NO_ENGINE" }` |

checks、工具调用、步数、门控细节、verification、runId 都不给客户端。

**模型接入**：`pickProvider(null, "tutor")`——家长可以用 `providerByTask.tutor` 指定引擎，否则照全局 `provider` / 自动顺序（不可用就往后落，和其它任务一样）。
每个 (引擎, stepTimeoutMs, totalTimeoutMs, 语言) 第一次用到时建一对 `createLegacyProvider`（作答 task `tutor`、分类 task `tutor:classify`，都记进用量账本）和一个 `createModelRouter`
（`reasoning` → 作答、`fast` → 分类），再建 TutorAgent；之后复用。桥调用前问一次 `detected[engine].available`。

**日志**：每次 ask 一行 `[tutor] <引擎> <语言> <结果> [code] (<stage>/<label>)`；每次工具调用一行 `[tool] <工具> ok|fail:<code> <ms>ms (tutor) trace=<id>`（问答用自己的一份登记表，不像默认 trace 那样打印 `kid=`）。没有问题原文、没有账号 / 孩子信息。

**限制（诚实版）**

- **取消不了已经发出的引擎调用**：客户端断开 / 超时后 ask 立即收口、在途互斥随之释放，但 `runEngine` 不收 signal，底层 CLI 进程或 HTTP 请求会跑到自己的超时，照样花钱、照样记账。断开后马上再问，可能两次引擎调用同时在跑；每分钟限额是唯一的花费上界。
- 限速和在途表都在进程内存：重启清零，多实例不共享；按账号计，不按家庭计。
- 一次 ask 最坏约 16 次引擎调用：分类 Harness（maxSteps 2，失败重试 1 次）最多 4 次，作答 Harness（maxSteps 6，每回合失败重试 1 次）最多 12 次；每次都是完整的引擎调用。花费上界 ≈ `perMinute` × 16 / 分钟 / 账号，再加上每次断开 / 超时后最多一次跑完才停的孤儿调用。
- 单步时限只由 Harness 的 `stepTimeoutMs` 管（CLI 引擎一次几十秒很正常，默认 120 秒，Harness 自己的默认是 30 秒）；Router 的时限设成 `totalTimeoutMs`，避免 Router 的超时先到被 Harness 当成模型失败再重试一次。
- 没有真实模型的质量评测：测试用桩引擎，只证明路由、门控、限速、白名单和取消收口。

**开放给孩子之前还缺**（另立任务，需要用户确认）：孩子端界面；家长可见的对话记录与开关（现在只进用量账本，不存问答内容）；带人工标注的中英问题集跑真实引擎的分类 / 作答质量评测；工作流（Diagnose → … → Adapt）的 HTTP；Student Memory 给不给模型、给哪些字段。
