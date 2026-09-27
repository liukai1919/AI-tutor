# Tutor Memory：Session / Learning Events / Student Memory（#34，#19 Phase 5）

状态：后端模块 + 单测。**没有 HTTP 路由、没有界面、没有 Tutor 记忆工具，server.js 和 TutorAgent 都没有接它**；
不连模型、不联网、不迁移也不读写任何现有孩子数据。写事件 API 是可信内部服务，不向模型或未认证 HTTP 开放。

```
lib/ai/memory/errors.js       MemoryError + 读外部纯对象的小工具
lib/ai/memory/events.js       事件 schema / 校验 / 重放 / 纯投影（无 I/O）
lib/ai/memory/index.js        createMemory：Session（纯内存）+ Learning Events 服务
lib/ai/memory/file-store.js   createFileStore：显式 rootDir、每所有者一个 JSON 文档、原子替换、同进程队列
tools/test_memory.mjs         事件 / 投影 / Session / 服务（桩 store，不碰磁盘）
tools/test_memory_store.mjs   文件适配器（fs.mkdtemp 临时目录，finally 删除）
```

三层记忆：

| 层 | 存在哪 | 内容 | 寿命 |
|---|---|---|---|
| Session Memory | 服务进程内存 | 当前题目、作答、提示、工具观察摘要、教学阶段（有界临时文本） | TTL 30 分钟；关闭即删；进程重启即无 |
| Learning Events | 注入的 store（文件适配器：每所有者一个 JSON） | 白名单结构化事件：标识、类型、服务时间、有限枚举 | 持久 |
| Student Memory | 不存，每次从事件重算 | 纯投影出来的计数 / 显式掌握 / 误因统计 / 风格偏好 | 随事件 |

## 1. 入口

```js
const { createMemory } = require("./lib/ai/memory/index.js");
const { createFileStore } = require("./lib/ai/memory/file-store.js");
const mem = createMemory({
  store: createFileStore({ rootDir: "/abs/path/that/exists" }),   // 必填，无默认
  now: Date.now,            // 可注入；必须返回 ≥0 的安全整数毫秒
  sessionTtlMs: 1800000,    // 1000–86400000
  maxSessions: 100,         // 1–10000，全局活跃会话
  maxEntries: 32,           // 1–1000，每题每类记录
  maxEvents: 10000,         // 1–100000，每个所有者
});
```

选项必须是纯对象（原型 Object.prototype 或 null），只认上面这些自有、可枚举的数据属性；数值必须是范围内的安全整数；
Object.prototype 上被污染的字段不会被读到。`store` 的 `read` / `update` 在构造时沿原型链按**数据属性**各读一次（类实例的原型方法可以；
getter 不执行、直接 INVALID_OPTIONS；Proxy 陷阱抛错 / 撤销的 Proxy 也收成 INVALID_OPTIONS），之后换掉 store 上的方法不影响本服务。
返回冻结对象，只有七个方法，不暴露 store。

| 方法 | 结果 |
|---|---|
| `createSession(ctx, { stage? })` | 会话快照 |
| `getSession(ctx, sessionId)` | 快照（不续期） |
| `updateSession(ctx, sessionId, patch)` | 快照（续期到 now + TTL） |
| `closeSession(ctx, sessionId)` | `{ closed: true }`，内容删除 |
| `appendEvent(ctx, input)` | `{ event, duplicate }` |
| `getEvents(ctx)` | 冻结事件数组，存储顺序 |
| `getStudentMemory(ctx)` | 纯投影（§4） |

全部返回 Promise；失败 reject `MemoryError`（`code` 见 §6），message 只提字段名，不回显调用方文本。结果一律深冻结（没有历史的所有者拿到的空数组也冻结）。
外部值（ctx、输入、store 回包里的文档 / owner / events 数组、fs 回包、transform 返回值）上的 getter、洞、多余属性、Proxy 异常都收成我们自己的 code，不漏普通 Error。

### ctx 与所有者

- `ctx` = `{ userId, kidId, role }`，恰好这三个自有数据属性；userId / kidId 是 1–128 个字符、无控制字符的字符串；role ∈ student / parent。
- 所有者 = JSON 编码的 `[userId, kidId]`（不是分隔符拼接，`["a,b","c"]` 与 `["a","b,c"]` 是两个人）。
- **role 不参与所有者，也不给任何跨所有者能力**：parent 拿另一个 kidId 只会看到空历史 / SESSION_NOT_FOUND。
  将来接家庭 / 设备身份时，调用方要显式选定 canonical userId，本模块不会跨桶合并。
- 每个入口在第一个 `await` 之前同步读完 ctx、输入并读一次服务时钟，拷成自己的冻结对象；之后调用方改原对象（同一个 tick 也一样）不影响本次操作。getter 不执行、直接拒绝。

## 2. Session Memory（只在内存）

patch 按 `type` 判别，键集合严格：

| type | 字段 | 效果 |
|---|---|---|
| `question` | `text`（1–2000）必填，`topicId` 可选 | 设当前题，**清空上一题的 attempts / hints / observations**（stage 保留） |
| `attempt` | `answer`（1–2000） | 追加；没有当前题 → SESSION_STATE |
| `hint` | `text`（1–2000） | 追加；同上 |
| `observation` | `tool`（如 `calculator.evaluate`）、`summary`（1–2000） | 追加；同上 |
| `stage` | `stage` ∈ understand / explain / hint / practice / check / review | 只是记录字段；流程转换规则留给 Phase 6 |

快照：`{ sessionId, stage, question:{text,topicId,at}|null, attempts:[{answer,at}], hints:[{text,at}], observations:[{tool,summary,at}], createdAt, updatedAt, expiresAt }`，
每次新建数组、条目冻结，改快照改不到会话。

- sessionId = `s_` + 32 位随机 hex；格式不对 → INVALID_INPUT。不存在 / 过期 / 已关闭 / 别的所有者一律 SESSION_NOT_FOUND（不泄露存在性）。
- TTL：`now >= expiresAt` 即过期并清除；create / update 续期，get 不续期。`now + TTL` 不是安全整数时 create / update 直接 INVALID_CLOCK，在任何状态变化（含清理过期会话）之前失败。
- 容量：活跃会话全局 100（先清过期；满了 SESSION_LIMIT，不踢旧会话）；每题每类 32 条（满了 SESSION_LIMIT，不静默丢）。
- Session 从不经过 store，文本永远不落盘；Session 操作全程同步，同一服务上的并发更新按调用顺序串行、不丢。

## 3. Learning Events

### 3.1 字段

| type | topicId | attemptId | mistake | prerequisiteTopicId | style |
|---|---|---|---|---|---|
| question_attempt | 必填 | 必填 | — | — | — |
| hint_requested | 必填 | 可选 | — | — | — |
| answer_correct | 必填 | 必填 | — | — | — |
| answer_wrong | 必填 | 必填 | 可选 | — | — |
| concept_explained | 必填 | — | — | — | — |
| prerequisite_gap_detected | 必填 | — | — | 必填（≠ topicId） | — |
| topic_mastered | 必填 | — | — | — | — |
| preference_set | — | — | — | — | 必填 |

另有每条都必填的 `eventId`、`type`。`at` 由服务时钟填，调用方传 `at` 或表外任何键（question、answer、message、text……）都是 INVALID_INPUT。

- `eventId`、`attemptId`：`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`；`topicId`、`prerequisiteTopicId`：`^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$`。
  标识不是自由文本槽：首字符必须是字母数字（`__proto__` 不可能合法），只许 `. _ : -`。
- `mistake` ∈ concept / calculation / reading / careless / prerequisite-gap（#31 的五类）。
- `style` ∈ visual / step-by-step / concrete / symbolic。只记录调用方显式选定的风格，不从行为推断。
- 字段值必须是原始字符串（String 对象、null、undefined 值都拒绝）；输入对象规则同 ctx（纯对象、无 Symbol / getter / 原型字段）。
- 持久记录按固定键序 `eventId,type,at,topicId,attemptId,mistake,prerequisiteTopicId,style` 写出。单条最长约 400 字节。

### 3.2 追加规则（在 store 事务里，基于最新事件列表）

1. 完整重放现有文档；坏档直接失败，不当空库。
2. eventId 已存在：除 `at` 外内容相同 → 返回原记录（**原 `at`**）、`duplicate:true`、不写盘；内容不同 → EVENT_CONFLICT。
3. question_attempt 的 attemptId 在该所有者内只能用一次（跨话题也不行）→ 否则 EVENT_CONFLICT。
4. answer_correct / answer_wrong 必须引用**同话题**已有尝试（否则 ATTEMPT_NOT_FOUND），每个尝试只接受一个结果（再来 → ATTEMPT_SETTLED）。矛盾结果、重复结果都不会重复计数。
5. hint_requested 带 attemptId 时同样要求同话题已有尝试（结算与否都行）。
6. 事件数已达 maxEvents → CAPACITY（重复 eventId 在第 2 步已返回，满了也能幂等重试）。
7. store 提交成功后服务才返回新记录；任何失败都不发布新事件或派生计数。

## 4. Student Memory（纯投影）

```
{ eventCount,
  topics: [ { topicId, attempts, correct, wrong, unsettled, hints, explanations,
              prerequisiteGaps: [ { topicId, count } ],
              mistakes: { concept, calculation, reading, careless, "prerequisite-gap" },
              mastered, masteredAt, firstAt, lastAt } ],
  mistakes: { 五类总计 },
  preference: { style, at } | null }
```

- 只来自明确事件：`mastered` 只由 topic_mastered 置真（masteredAt 取第一条），答对多少次都不算；误因只统计 answer_wrong 事件**自己的** `mistake` 字段（own property；Object.prototype 被污染也不算）；偏好取最后一条 preference_set。
- 不推断能力、掌握度、学生特征。话题按首次出现顺序；`firstAt` / `lastAt` 是该话题事件时间的最小 / 最大值。
- `events.project(events)` 是纯函数：同一列表输出逐字相同、不改入参；内部用 Map，`constructor` 之类的话题 id 从零计数。
- 投影不落盘；持久文件只有事件。

## 5. Store 契约与文件适配器

```
store.read(owner)               → Promise<doc | null>          owner = 冻结的 [userId, kidId]
store.update(owner, transform)  → Promise<{ doc, written }>
  transform(current: doc | null) 同步；返回新 doc（写）或 null（不写）
doc = { "version": 1, "owner": [userId, kidId], "events": [ ... ] }    恰好这三个键
```

`update` 必须：在该所有者的队列里对**最新**文档调用 transform；transform 抛错 → 原样 reject、不写；提交成功后才 resolve。
服务把 store 的非 MemoryError 异常收成 STORE_IO（原异常在 `.cause`），store 抛的 MemoryError 原样透传。
store 回包本身若是撤销的 Proxy / then getter 抛错的对象，在 `await` 探测 then 时就失败，按 STORE_IO 收口；回包是能读的对象但结构不对 → STORE_CORRUPT。

`createFileStore({ rootDir, maxBytes = 8 MiB, fs })`：

- `rootDir` 必填、绝对路径、必须已存在的目录；没有默认值，不自动创建。首次使用时 `realpath`（结果不是绝对路径字符串 → STORE_IO）。
- owner 与服务同一规则：恰好两个自有数据字符串项（无洞、无 getter、无多余属性、不是类数组对象 / 撤销的 Proxy）、各 1–128 字符、无控制字符；不合法 → INVALID_INPUT，且在任何 fs 调用之前。
- 文件名 `sha256(JSON.stringify([userId, kidId])) + ".json"`；id 里的 `..`、`/`、`\`、盘符、`CON` 都不会成为路径段。文档 owner 与请求不符 → STORE_CORRUPT。
- 读：`lstat`（不是普通文件 → STORE_CORRUPT，含符号链接和目录；超过 maxBytes → STORE_TOO_LARGE，不读内容）→ 严格 UTF-8（BOM 也算坏）→ JSON（文件内容为 `null` 也算坏）→ 信封（version ≠ 1 或缺失 → STORE_VERSION）→ **整份事件按追加规则重放**（坏事件、重复 eventId、坏关联 → STORE_CORRUPT）。ENOENT → null。
  所以坏历史对直接调用 `store.read` / `store.update` 的人同样读不出、也盖不掉（transform 根本不会被调用），文件字节不变。
  `read` 和交给 transform 的 `current` 都是新建的规范文档（事件对象冻结，数组可改），改它不影响盘上内容；`update` 返回 null（不写）时给的 `doc` 也是规范副本。
- fs 回包是外部值：`isFile` 抛错、`readFile` 不给 Buffer、错误对象的 `code` getter 抛错、文件句柄方法是会抛错的 getter，都收成 STORE_IO（写路径照样只删临时文件）。
- 写：transform 结果先按事件规则完整校验（async / thenable / then getter 抛错 / 撤销的 Proxy / undefined / 函数或数字 / 信封或事件不合法 / 数组上藏了多余属性（如 toJSON）→ INVALID_TRANSFORM，队列照常可用），再序列化**校验后的规范副本**（调用方对象上的多余东西不会进盘）；超过 maxBytes → CAPACITY；
  `<target>.<pid>.<rand>.tmp` 用 `wx` 打开 → 写 → fsync → close → rename 覆盖。任何一步失败只 unlink 这个临时文件（失败也吞掉），目标文件字节不变。
- maxBytes 默认 8 MiB：10000 条最长事件约 3.7 MB（测试实测），留一倍多余量，也挡住异常大文件。
- 队列：模块级 Map，键 = 实际目录（win32 转小写）+ 文件名，同进程内所有适配器 / 服务实例共享；read 也排队（Windows 上读句柄会让 rename 报 EPERM，变异测试里去掉共享队列就能复现）。
- `fs` 可注入（默认 `fs.promises`，只用 realpath / stat / lstat / readFile / open / rename / unlink），规则同 store：构造时按数据属性各读一次、getter 不执行、Proxy 异常收成 INVALID_OPTIONS，调用时绑回原对象。测试靠它注入 open / write / fsync / rename / unlink / read 故障，不改全局原型。

## 6. 错误码

| code | 何时 |
|---|---|
| INVALID_OPTIONS | createMemory / createFileStore 选项非法 |
| INVALID_CTX | ctx 不合契约 |
| INVALID_INPUT | 事件 / patch / sessionId / session init / store 的 owner 或 transform 不合契约 |
| INVALID_CLOCK | now() 抛错或不是 ≥0 的安全整数；会话 now + TTL 超出安全整数（什么都不写、不改会话） |
| SESSION_NOT_FOUND | 会话不存在 / 过期 / 已关闭 / 别的所有者 |
| SESSION_STATE | 没有当前题时记录 attempt / hint / observation |
| SESSION_LIMIT | 活跃会话或每类记录达上限 |
| EVENT_CONFLICT | 同 eventId 不同内容；attemptId 复用 |
| ATTEMPT_NOT_FOUND | 结果 / 提示引用不存在或不同话题的尝试 |
| ATTEMPT_SETTLED | 该尝试已有结果 |
| CAPACITY | 事件数达 maxEvents；文档会超过 maxBytes |
| STORE_CORRUPT | 坏 JSON / 非 UTF-8 / JSON null / 信封或事件不合法（含 owner / events 数组的洞、getter、多余属性、Proxy 异常）/ 重放失败 / owner 不符 / 不是普通文件 |
| STORE_VERSION | 未知版本 |
| STORE_TOO_LARGE | 现存文件超过 maxBytes |
| STORE_IO | 底层 I/O 失败、fs 回包畸形、store 的意外异常（含 store 回包在 await 探测 then 时就失败） |
| INVALID_TRANSFORM | 文件 store：transform 返回 thenable / undefined / 非法文档 |

## 7. 测试

```
node tools/test_memory.mjs          # 408 项（含独立复核回归 F1–F7）
node tools/test_memory_store.mjs    # 153 项（含独立复核回归 F2 / F8–F10）
```

都不起服务器、不读 `data/`、不调模型；store 测试只用 `fs.mkdtemp` 临时目录并在 finally 删除。

## 8. 限制（重要）

- **跨进程不支持**：没有文件锁。两个进程同时写同一个 rootDir 会后写覆盖、丢事件。只支持单进程写入；要多进程需要换带锁 / 事务的 store（契约不变）。
- 崩溃或清理失败留下的 `*.tmp` 不会被读，也不自动清理（不敢按模式删，怕误删）。不对目录 fsync，掉电后 rename 的持久性取决于文件系统。
- 每次读和追加都重读并重放整份文档（O(n)，n ≤ 10000 时可接受；服务路径上文件 store 和服务各重放一次）；没有分页 / 归档。事件满了只能明确失败，没有滚动或压缩策略。
- 没有删除 / 更正事件的 API（没有「取消掌握」事件）；家长可见、导出、删除孩子数据留到接路由时一起定。
- Session 活跃上限是全局的，一个所有者可以占满；没有按所有者限额。Session 只在一个服务实例的内存里，多实例 / 重启不共享。
- stage 只是记录字段，不做流程校验；Session 文本的内容不做审查。
- 事件的语义正确性（这次到底算不算「讲解了概念」、误因选得对不对）由可信调用方负责，本模块只保证结构、关联和幂等。
- 没有 HTTP、界面、Tutor 工具；TutorAgent 看不到学习状态。把 Student Memory 交给模型前需要先定隐私边界（给什么字段、家长开关），见 docs/tutor-harness.md §4。
