# Tutor Harness 与只答学术问题的 TutorAgent（#28，#19 Phase 3）

状态：后端模块和回放 eval。**没有 HTTP 路由、没有孩子端聊天界面、server.js 没有实例化它**，现有固定流程（讲课、闯关、单元卷、FSA、报告）和 `lib/actions/_engine.js` 的 `generateOnce` 一行没动。

```
lib/ai/harness/index.js    单智能体循环 createHarness
lib/ai/harness/replay.js   确定性回放 Provider createReplayModel
lib/ai/tutor/index.js      TutorAgent：预闸 + 语义分类接缝 + Harness + 结构化校验
tools/test_harness.mjs     Harness 单测（72 项）
tools/eval_tutor.mjs       TutorAgent 回放 eval（68 项，其中 46 条中英用例在 tools/fixtures/tutor_eval.json）
```

两个脚本都不起服务器、不读 `data/`、不调任何真实模型，零成本。

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
const r = await agent.ask(ctx, { question, lang: "zh" | "en", mode: "answer" | "hint", signal });
// r = { ok, kind: answer|hint|refusal|safety|error, text, gate:{ stage, label, rule? }, steps, calls, checks?, error? }
```

- `ctx` 由可信调用方给（将来的路由：`allow` → `resolveKid` → `actx`），和 Action / Tool 同一个形状。`ask` 在公开入口**同步**取 ctx 和请求字段（question / lang / mode / signal）的快照，分类和作答两段都用它；调用方拿到 promise 后同一个 tick 里或中途改自己手里的对象，都不影响这次 ask 和任何工具调用。
- **可用工具只有两个，都是只读**：`calculator.evaluate`（确定性算术）、`curriculum.findTopic`（查大纲条目，不碰孩子数据）。registry 里其余 11 个工具（含 `questions.*` 写入 / 花钱、`student.*` 孩子数据、`learning.getReport` 家长专用）一个不给。
- `ask` 永远 resolve；拒答、安全提示、出错的正文都是固定中英模板（`TEXTS`），模型的自由文本只在 `answer` / `hint` 时给孩子。
- `lang` 未知时按 zh；`question` 1–2000 字符；`mode` 只能 answer / hint。

### 学术范围门控（分层，都不是绝对保证）

| 层 | 做什么 | 命中后 | 已知边界 |
|---|---|---|---|
| 0 输入 | ctx / question / mode 校验 | `error`（INVALID_CTX / INVALID_INPUT），不调模型 | — |
| 1 确定性预闸 `classifyScope` | 中英正则：安全求助 → 提示注入 → 非学术**请求**；再看有没有数学信号。NFKC、去零宽字符，中文规则在去空白后的文本上匹配 | `safety` / `refusal`（数学 + 越界请求 = mixed，也拒），不调模型、不调工具 | 只认写进规则的说法；换个说法、错别字、别的语言就漏。针对「请求」而不是名词，所以应用题里的游戏 / 电影不会被误拒，但也意味着只提名词的闲聊要靠下一层 |
| 2 语义分类（每次都跑）`classifierModel` | 同一个 Harness、零工具、分类提示词，模型只输出 `{ label, reason }`，label ∈ math / other_academic / non_academic / mixed / injection / unsafe，schema 校验。**没给 `classifierModel` 时用主模型单独做一次分类调用**，不存在「命中数学关键词就直接回答」的路径 | 非 math 一律拒答（other_academic 用「只辅导数学」模板）；分类失败 / 超时 / 输出不合格 → `error`（fail closed） | LLM 语义判断会错，也可能被精心构造的输入骗过；用同一个模型分类和作答，两步可能被同一段输入一起带偏。eval 只证明**管线**按标签正确收口，不衡量分类准确率 |
| 3 结构化结果校验 | final 必须 `{ kind, text, scope, checks? }`；非 math scope 只能 refusal；hint 模式不许 answer；正文再过预闸规则、禁止链接；`checks` 用 calculator 复算（相对误差 1e-9） | 不合格 → 退回模型重写（最多 2 次），仍不合格 → `error`；refusal 换成模板 | 正文检查同样是规则；没写进 checks 的数字不会被复算；数学讲解本身对不对（非算术部分）没有 verifier |

「学术」在本阶段按 #19 的决定取最窄：只辅导数学；其它学科礼貌拒答并引导回数学。放宽只需改 `REFUSAL_TEMPLATE` 和提示词。

提示词见 `TUTOR_SYSTEM` / `CLASSIFIER_SYSTEM`：问题放在 user 消息的 JSON 字段里当数据，工具结果也是数据。

## 3. 回放与 eval

`createReplayModel(turns)` 按顺序返回脚本回合：`{type:"tool_call"...}` / `{type:"final"...}` / `{raw}`（任意值，测非法回合）/ `{error}` / `{hang:true}` / `{delayMs, then}`；用完再调就 reject「replay exhausted」；`calls` 记下 Harness 给的每个请求。

```
node tools/test_harness.mjs
node tools/eval_tutor.mjs            # 全部
node tools/eval_tutor.mjs --only zh-privilege-escalation
```

eval 用真实 `createTools` 注册表（桩 Action：任何 Action 被调都记失败），外面套一层 spy 记录每次 invoke 的工具名、ctx、risk。每条用例断言 kind / gate / 模板文案 / 错误码 / registry 实际收到的工具序列 / 模型与分类器调用次数，并对所有用例检查不变量：只有两个只读工具到过 registry、registry 收到的 ctx 与调用方一致、预闸拒答零模型零工具、tutor 作答前一定有过分类调用且分类请求不带工具、超时 / 取消 500ms 内收口、全程无未处理拒绝、Action 零调用。

用例分类（46 条）：正常数学、常见误区、只要提示（含模型越界给答案被退回）、非学术、数学 + 越界混合（预闸抓到 / 预闸漏掉由分类器抓到）、提示注入（全角、插空格、零宽字符、预闸漏掉由分类器或模型抓到）、其它学科、不给分类模型时由主模型分类（含恶意模型把「数学 + 闲聊」直接作答被分类 schema 拦下）、应用题里有游戏名词不误拒、非法工具参数、越权工具与伪造 ctx、calculator 复算不符被退回、回答正文带链接 / 闲聊被退回、模型异常重试与失败、工具异常、模型超时、分类器超时、分类器 + 模型共享总时限、步数耗尽、取消、安全求助（预闸 / 分类器）、家长角色、非法角色、分类器输出不合格。

**录制**：本阶段没有录制器。将来要录真实调用做回放时，只能在隔离数据目录、用合成问题录，不默认发送真实学生数据。

## 4. 与现有代码的接缝和后续

- `generateOnce` 与六类固定任务不迁入 Harness（issue 写的是「若迁入」，本阶段取不迁，契约零风险）。以后要迁时，一个「单回合、零工具、validateFinal = 现有 validateX、modelRetries = 1」的 Harness run 就是它的等价物，但必须保留提示词、重试次数和 `kidTxn(keep)` 落盘在事务外的边界。
- **还没有真实模型适配器**：要接 `runEngine` 时写一个 `model.next(req)`：把 `system` / `messages` / `tools` 拼成提示词，用 `TURN_FORMAT` 要求单个 JSON 回合，`extractJson` 解析，记账走 `runEngine`（任务名需要加进 `TASKS`，如 `tutor`、`tutor:classify`）。这是 Phase 8 的活。
- 暴露给孩子前还需要：路由（`allow` + `resolveKid` 注入 ctx、限速、`YY_DEMO` 下禁用）、界面、家长可见的对话记录与开关、离线的分类质量评测（带人工标注的中英问题集），以及用户确认。
- Phase 4（Skills）：TUTOR_SYSTEM / CLASSIFIER_SYSTEM 可以变成第一对 Skill；Phase 5（Memory）：给 TutorAgent 加只读的 `student.getProgress` 前要先定隐私边界；Phase 6（结构化辅导流程）：把 hint → answer 升级做成状态机；Phase 7（Verifier）：checks 复算是雏形；Phase 8（模型抽象）：上面的适配器和按能力路由。
