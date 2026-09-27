# 按能力选模型：Router 与旧引擎桥（#40，#19 Phase 8）

状态：后端模块 + 合成测试。**没有接进 server.js、HTTP 路由或界面**；现有 `create(deps)`、`pickProvider`、七个适配器、`runEngine`、用量账本的行为一字未改。
下面的「接入 TutorAgent」只是组合示例，测试里用桩 `runEngine` 跑，不调任何真实模型。

```
lib/ai/models/router.js    createModelRouter：按 intent 选 provider，绑成 Harness / TutorAgent 能直接用的 { next(req) }
lib/ai/models/legacy.js    createLegacyProvider：把 create(deps).runEngine 包成 provider（显式注入，不读配置、不探测）
lib/ai/models/snapshot.js  snapshotJson：有界、只读自有数据属性的 JSON 快照（深冻结）
lib/ai/models/index.js     在原有 { create } 之外追加导出上面这些
tools/test_model_routing.mjs  131 项，全部合成数据 / 桩 provider / 桩 runEngine（外加真实七个适配器 + mock fetch + 生成的桩 CLI 脚本）
```

## 1. 概念

- **intent / capability**（同一套词）：`fast`、`reasoning`、`vision`、`cheap`、`local`、`privacy-sensitive`。上层（TutorAgent、工作流）只说「我要哪种能力」，不写厂商名。
- **provider**：一个能回答 `invoke(request)` 的东西，带一份**可信配置声明**的能力表。
- **route**：每个 intent 一张有序的 provider id 列表，顺序就是优先级。

能力和「是不是本地」**都来自写配置的人的声明**。Router 不探测、不推断（不看 id、不看 URL），也**不能证明**某个 provider 真的在本机、真的不外传数据。
声明错了，硬约束就只是按错的声明执行。所以 provider / route 配置是可信代码写的，模型输出、孩子的问题、请求体都改不了它。

## 2. API

```js
const { createModelRouter, createLegacyProvider } = require("./lib/ai/models/index.js");

const router = createModelRouter({
  providers: [p1, p2, ...],            // 1–32 个
  routes: { fast: ["local-qwen", "claude-cli"], reasoning: ["claude-cli"], "privacy-sensitive": ["local-qwen"] },
  timeoutMs: 300000,                   // 可选，默认 300000；bind 可覆盖；上限 3600000
  onTrace, onTraceError, now,          // 可选
});
const model = router.bind("reasoning", { require: ["cheap"], timeoutMs: 60000 });   // → 冻结的 { intent, require, next(req) }
await model.next(req);                                                               // 和 createReplayModel 同一个接口
router.select("fast", { require, images });   // 只选不调：{ ok:true, provider, skipped } | { ok:false, code, skipped }
router.providers;                              // 冻结的 [{ id, capabilities }]
router.routes;                                 // 冻结的 { intent: [ids] }
```

### provider 契约

```js
{
  id: "local-qwen",                         // ^[a-z][a-z0-9._-]{0,47}$，唯一
  capabilities: ["fast", "cheap", "local", "privacy-sensitive"],
  invoke(request, { signal, deadlineAt }),  // 返回 turn（或它的 promise）
  available() { return true; },             // 可选；必须**同步**返回 true 才算可用
}
```

- 只读**自有数据属性**，只允许这四个键；getter、继承来的字段、多余键、Symbol 键、数组样对象都是 `INVALID_CONFIG`，getter 不会被执行。
- `privacy-sensitive` 必须同时声明 `local`（否则构造失败）。
- `invoke` / `available` 在构造时取一次，调用时 `this` 是 `undefined`（写成闭包）。
- `request` 是深冻结的 `{ intent, system, messages, tools, step, images }`，`step` 没给时是 `null`，`images` 是 `[]` 或一张图。
- `signal` 是 Router 自己的 AbortController：调用方取消 / Router 超时都会 abort 它。provider 应该用它停下请求；不理会也行，但结果不会被采用。

### routes 校验

只允许六个 intent 作为自有数据键；每条 1–16 个、已注册、不重复的 id；**每个 provider 必须声明该 intent 的能力**（`privacy-sensitive` 路由还要 `local`），不符合在构造时就是 `INVALID_CONFIG`，不会留到运行时靠 fallback 碰运气。
`Object.prototype` 被污染（比如 `Object.prototype.fast = [...]`）不会凭空多出路由。构造完成后改原配置对象、原数组都不影响 Router。

### 请求契约（`next(req)`）

- `req` 只能有自有数据键 `system / messages / tools / step / signal / images`；**别的键一律 `INVALID_REQUEST`**（不会把调用方随手塞的字段转发给 provider）。
- `system`：字符串，≤ 200000 字符，没给按 `""`。
- `messages`：数组，每项是纯对象、**自有**的 `role ∈ user / assistant / tool / harness`（Harness 的四种消息；`Object.prototype.role` 被污染时 `{}` 不算消息）。
- `tools`：数组，每项是带**自有** `name` 的纯对象（Harness 给的是 `registry.describe()` 的结果：`name / description / parameters / risk`，没有 `run`）。工具定义只是数据。
- `step`：非负整数；`signal`：真的 `AbortSignal`（Proxy、仿冒对象 → `INVALID_REQUEST`；实例上自定义的 `aborted` 不会被读）。
- `images`：最多**一张** `{ mediaType: "image/png" | "image/jpeg", data: <base64> }`，≤ 10,000,000 字符。这是本阶段唯一的图片契约。
- `messages` / `tools` 用 `snapshotJson` 同步复制并深冻结：深度 ≤ 64、节点 ≤ 20000、单个字符串 ≤ 100000、总字符 ≤ 2,000,000；
  getter 不执行、环 / 空位 / 不可枚举的属性或下标 / 类实例 / NaN / 函数 / 撤销的 Proxy 都拒绝。配置里的数组（capabilities、routes、`require`，包括空数组）用同一套严格读取。`next` 返回之后调用方怎么改自己的对象都不影响这次调用。
- 不合格 → `INVALID_REQUEST`，固定文案 `model request is not supported`，不回显哪个字段或内容；provider 不被调用；`next` 从不同步抛错。

## 3. 选路、回退与硬约束

```
需要的能力 = { intent } ∪ require ∪（有图片 ? vision）∪（含 privacy-sensitive ? local）
按 routes[intent] 顺序：
  缺任何一个能力        → 跳过
  available() 不是同步 true（false / 抛错 / 返回 promise / 1 / "true"）→ 跳过
  第一个通过的           → 调用一次
没有该 intent 的路由 → NO_ROUTE；全部被跳过 → NO_PROVIDER
```

- **回退只发生在调用前**，只看声明的能力和 `available()`。被跳过的 id 记在 trace 的 `skipped` 里。
- **硬约束**：`local` / `privacy-sensitive`（以及 `require: ["local"]`）只会落到声明了 `local` 的 provider；本地的都不可用时就是 `NO_PROVIDER`，**永远不会自动转到远程**。
- **图片不会被悄悄丢掉**：带图的请求只会交给声明了 `vision` 的 provider；没有就 `NO_PROVIDER`。
- **调用后失败不换商**：provider reject / 同步抛错 → `PROVIDER_ERROR`；返回值不是有界纯 JSON → `BAD_OUTPUT`。都**不会**再去试路由里的下一个 provider（避免一个问题被两家各收一次钱）。
- **重试归 Harness**：Harness 的 `modelRetries` 会再调一次 `next`，那是一次全新的选路（同顺序、同过滤）；首选 provider 仍可用就还是它。Router 自己没有重试循环。
- 每次 `next` 都是独立的局部状态；同一个 Router、不同 intent 的并发调用互不影响（测试：24 个并发、乱序结算、5 个 intent）。

## 4. 取消、超时、迟到结果

- 调用前 `signal` 已 abort → `CANCELLED`，不选路、不调用。
- **选路期间也查**：每次调 `available()` 之前、以及真正调用 provider 之前，都再查一次取消和截止时间。`available()` 自己 abort 了、或者拖过了时限，
  后面的 `available()` 一个都不再调，provider 也不调用（`CANCELLED` / `TIMEOUT`）。选不出 provider 时也先做这次检查：
  最后 / 唯一一个 `available()` 取消或耗尽时限后返回 false，报的是 `CANCELLED` / `TIMEOUT`，不是 `NO_PROVIDER`。
- 等待中 abort → 立刻 `CANCELLED`；超过 `timeoutMs` → `TIMEOUT`。两种都会 abort 交给 provider 的 signal。
- **时钟**：注入的 `now()` 抛错或返回非有限数 → `INTERNAL`（固定文案，不回显时钟的异常）；在调用前发现就不调用。无论时钟何时坏掉，`next` 的 promise 都会结算，
  trace 里对应的 `ms` / `at` 是 `null`，不会有挂起的 promise、未处理拒绝或未捕获异常（结算先于 abort / trace）。
- `invoke` 同步阻塞返回后会再查一次；过了截止时间或已取消，结果不采用。
- 被丢下的 promise 结算后只发一条 `route-late` trace，拒绝被接住，没有未处理拒绝。
- **Router 不能收回已经发出的请求**。provider 不理会 signal 时它会继续跑、继续花钱；legacy `runEngine` 就是这样（见 §6）。
- 和 Harness 的关系：Harness 的 `stepTimeoutMs` / `totalTimeoutMs` 更短时由 Harness 先收口，run 结束时 Harness abort `req.signal`，Router 随之 `CANCELLED` 并 abort provider 的 signal。
- 已知边界：provider 自己挂在 signal 上的监听器如果抛错，Node 会把它当未捕获异常上报（与 Harness 自己 abort 时相同），Router 接不住。

## 5. 错误与 trace

| code | 何时 | provider 被调用了吗 |
|---|---|---|
| `INVALID_CONFIG` | 构造 / `bind` / `select` 的可信配置不合格（同步抛出） | — |
| `INVALID_REQUEST` | 请求不合契约 | 否 |
| `NO_ROUTE` | 该 intent 没配路由 | 否 |
| `NO_PROVIDER` | 路由里每个都缺能力或不可用 | 否 |
| `CANCELLED` / `TIMEOUT` | 取消 / 超时 | 可能（调用前取消则否） |
| `PROVIDER_ERROR` | provider reject 或同步抛错 | 是，只调一次 |
| `BAD_OUTPUT` | 返回值不是有界纯 JSON | 是，只调一次 |
| `INTERNAL` | 注入的时钟不可用（兜底） | 调用前发现则否 |

- 运行时错误都是 `RouterError { name, code, intent, provider? }`，`message` 是按 code 固定的英文短句。**Router 从不读取 provider 抛出的错误对象**，所以原始错误文本 / 密钥不会进 `message`、trace 或 Harness 的 `error.message`；
  对方抛的是撤销的 Proxy、带抛错 getter 的对象也不会卡住或逃逸。
- `INVALID_CONFIG` 的文案只回显已通过校验的 id 和固定字段名；配置对象读取时抛出的外部异常（包括调用方自己造的 `RouterError`）一律换成「could not be read」。
- trace（冻结）：`{ kind: "route" | "route-late", intent, provider, ok, code?, skipped, ms, at }`。没有 system、消息、工具入参、图片、错误原文、身份。
  `onTrace` 同步抛错 / 返回 reject 的 promise 交给 `onTraceError`，那里再出错也吞掉，结果不变。

## 6. 旧引擎桥 `createLegacyProvider`

```js
const models = require("./lib/ai/models/index.js").create({ cfg, L, JSON_HINT, LESSON_SCHEMA, DATA_ROOT });   // 现有工厂
const local = createLegacyProvider({
  id: "local-qwen", capabilities: ["fast", "cheap", "local", "privacy-sensitive"],
  runEngine: models.runEngine, engine: "ollama", task: "tutor:classify", lang: "zh",
  options: { think: false },                                                     // 只允许 { schema?, think? }
  available: () => !!(models.detected.ollama && models.detected.ollama.available),
});
```

- **全部显式注入**：`runEngine`、`engine`（七个旧引擎之一）、`task`（账本任务名，`^[a-z][a-z0-9:_-]{0,39}$`）、`lang`（zh / en，只影响旧适配器里「题目：/ Problem:」前缀）、`options`、`available`。桥不读 config、不探测、不 import server。
- 每次 `invoke` **恰好一次**、同步调用（`this = undefined`）：
  `runEngine(engine, task, system + LEGACY_TURN_CONTRACT, question, imageB64 | null, mediaType | null, lang, { hint: LEGACY_HINT, schema, think? }, undefined)`
  - `system` = 请求里的 system（TutorAgent 的 Skill 提示词）原样，后面接 `LEGACY_TURN_CONTRACT`：说明 transcript 格式（四种 role、observation / truncated / harness 的含义）和两种回合。
    **契约放在 system 里**，因为 system 是七个适配器都会发出去的部分——anthropic 只发 `system` 字段、ollama structured 模式只发 system、grok 的 prompt 文件不带 hint；
    测试用真实七个适配器（HTTP 引擎 mock `fetch`，CLI 引擎换成临时生成的桩脚本）核对每条传输里都有契约和 transcript；
  - `hint` = `LEGACY_HINT`，一句固定、**非空**的收尾，不可覆盖：旧适配器写的是 `opts.hint || JSON_HINT[lang]`，空串会退回默认的「讲课 JSON」说明（测试守着：任何传输里都不出现旧 hint）；
  - `question` = `"Transcript JSON:\n" + JSON.stringify({ tools, messages })`：工具定义和整段对话作为数据，observation、历史、harness 退回说明都在；
  - `schema` = `LEGACY_TURN_SCHEMA`（深冻结；grok / anthropic / ollama structured 用），可用 `options.schema` 换；每次调用给一份新的可变副本，某个适配器改了它也串不到别的调用或别的 provider；
  - `validate` 故意不传：回合形状由 Harness 判，形状错的回合变成 `BAD_MODEL_OUTPUT` 修复消息回给模型，和回放模型同一条路（测试守着）。代价是这种回合在账本里记为 `ok:true`。
- 能力声明按旧适配器的**传输能力**校验：`vision` 只允许 ollama / claude / gemini / anthropic / openai（= `PROVIDER_META.supportsImage`，一张 png / jpeg）；
  `local` / `privacy-sensitive` 只允许 ollama。后者仍是可信声明：桥**不检查** `cfg.ollama.url` 是不是本机。
- 调用前 signal 已 abort 就不调 `runEngine`。**调用之后取消不了**：`runEngine` 不收 signal，底层 CLI 进程 / HTTP 请求会跑到自己的超时（300–600 秒），照样花钱、照样记一行账；Router 只是不采用迟到的结果。
- **账本隐私边界（现有行为，本阶段不改）**：`runEngine` 失败时账本 `err` 字段写入引擎错误原文前 160 字（claude 适配器解析失败时里面可能有 CLI 原话）。
  桥没有让这件事更糟：它自己不产生新的错误文本进账本，而上层经 Router 拿到的只有固定文案。账本里的任务名就是注入的 `task`（例如 `tutor`），不在现有 `TASKS` 列表里也照记。

## 7. 接入 TutorAgent（组合示例，未接 HTTP）

```js
const router = createModelRouter({
  providers: [local, remote],
  routes: { fast: ["local-qwen"], reasoning: ["claude-cli"] },
});
const agent = createTutorAgent({ registry, model: router.bind("reasoning"), classifierModel: router.bind("fast") });
```

TutorAgent / Harness 一行没改：它们照旧只调 `model.next(req)`。`tools/test_model_routing.mjs` 用真实 `createTools` 注册表、真实 TutorAgent 和 Harness、桩 `runEngine` 跑完「分类 → tool_call calculator.evaluate → 带 observation 的第二回合 → 通过校验的 final」，并核对 system 原文（+ 契约）、工具定义、完整历史、引擎 / 任务名。
注意 system 多了一段契约，所以经桥发出的提示词和直接用 TURN_FORMAT 的回放测试不是逐字相同；Skill 原文本身不变。

## 8. 加一个 provider / route

1. 写一个 provider 对象（或用 `createLegacyProvider` 包一个旧引擎），在配置里**明确**写它的能力；能不能收图、是不是本地由你负责核实。
2. 把 id 放进需要它的 intent 路由，位置就是优先级。构造时校验会拒绝能力不符的路由。
3. 真实接入（server.js 里用哪几个 provider、`available` 取自 `detected`、`YY_DEMO` 下禁用、限速、家长可见的开关）是后续工作，需要单独评审和用户确认。

## 9. 本阶段没有做

- 没接 server.js / HTTP / UI；`pickProvider` 与家长 ⚙️ 的引擎选择照旧。
- 没有价格比较、负载均衡、健康探测、调用后的故障转移或网络级重试。
- 没有多图、除 png / jpeg 外的图片、流式输出。
- 没有真实模型的回合质量评测：测试只证明契约、选路、取消和收口。
