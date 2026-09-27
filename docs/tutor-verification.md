# 显式验证与可重复 eval（#38，#19 Phase 7）

状态：后端模块 + 单测 / 组合测试 / 回放 eval。**没有 HTTP 路由、没有界面、server.js 没有实例化它**；不连真实模型、不联网、不读写任何现有孩子数据。
现有 quiz 判分规则、课程大纲、存储协议、golden fixture 都没改。

```
lib/ai/verification/number.js    有界精确有理数：答案数字解析、纯算术式精确求值（BigInt，无 eval、无浮点比较）
lib/ai/verification/answer.js    verifyAnswer、createAnswerGrader（可直接作 Phase 6 工作流的 grader）
lib/ai/verification/response.js  verifyResponse（TutorAgent 原有规则抽出 + 正文算术等式 + 可信上下文规则）、extractEqualities、findAnswerLeak、readVerifyContext
lib/ai/verification/workflow.js  verifyStep：工作流步骤后置条件（纯函数）
lib/ai/verification/index.js     汇总导出
tools/test_verification.mjs      单测 + 真实 TutorAgent / 工作流 / memory 组合（108 项）
tools/eval_verification.mjs      中英回放 eval（36 项；22 条 TutorAgent 用例 + 4 条工作流用例在 tools/fixtures/verification_eval.json，另 8 条评分用例）
```

接入点（改动都很小）：
- `lib/ai/tutor/index.js`：schema 仍在这里校验，其余结果规则改为调用 `verifyResponse`（旧规则的文案逐字不变）；新增可选 `req.verify`。
- `lib/ai/harness/index.js`：`validateFinal` 的第二参数多一个 `evidence`（纯增量）。
- `lib/ai/workflows/index.js`：每步发布前 `verifyStep`；TutorAgent 请求带 `verify`；拿回的文字本地复核；新结果码 `INVARIANT_FAILED`、状态 `failed`。

依赖无环：`verification/*` 只 require `tools/calculator.js`、`memory/errors.js`、`memory/events.js` 和自己；TutorAgent 的正文筛查 `screenText` 以回调注入，不 require tutor / workflows / harness / skills（`test_verification.mjs` 在子进程里核对 require 缓存）。

## 0. 三种结论，不混用

| 说法 | 含义 |
|---|---|
| **correct / wrong**（答案）、**true / false**（等式） | 在受支持的语法里做了精确比较，结论确定 |
| **没发现错误**（`ok: true`、coverage 里 `checked`） | 列出的规则跑了、都没触发。**不等于内容正确** |
| **uncertain / unknown / not-covered / not-verified** | 没检查或检查不了。不当作对，也不当作错 |

`coverage.prose` 永远是 `"not-verified"`：自然语言的讲解、一般事实、诊断是否准确，本阶段没有任何 verifier。文档、eval、结果里都不会出现「verified」。

## 1. 数字（number.js）

- **作答 / 答案键**（`parseAnswerNumber`）：先只许数字（半角 / 全角）、`+ - − . / ⁄` 和空白，再 NFKC、合并空白。支持
  整数 `42`、`-0`、`+007`；小数 `0.5`、`.5`（小数点后至少一位）；分数 `3/4`、`-3/6`（分母 > 0）；带分数 `1 1/2`（真分数部分）。
  每段数字 ≤ 30 位，总长 ≤ 64。**其它一律 unsupported**：单位（`3 cm`）、`%`、千分位（`1,000`）、科学计数、上标（`4²`）、`½` 这类字符、代数（`x=4`）、文字 / 中文数字、多个数、空。
- **正文算术式**（`evaluateExact`）：数字、`+ - * / × ÷ ^`、括号、一元正负号；与 `calculator.js` 同一文法，但没有函数 / 常量 / `%`。`^` 的指数必须是 |k| ≤ 64 的整数。
  表达式 ≤ 200 字符、嵌套 ≤ 50 层、中间值 ≤ 1024 bit；超出 → `too-large` / `syntax`，除以零 → `div0`。
- 比较一律精确（交叉相乘）：`0.1 + 0.2` 就是 `3/10`，`9007199254740993 ≠ 9007199254740992`，没有容差、没有浮点碰撞。

## 2. 答案 verifier 与 grader（answer.js）

```js
const { verifyAnswer, createAnswerGrader } = require("./lib/ai/verification/index.js");
verifyAnswer(answer, answerKey)   // → 冻结 { status: "correct"|"wrong"|"uncertain", reason }
const grader = createAnswerGrader();   // 冻结 { grade(req) → 冻结 { outcome } }
```

| 情况 | status | reason |
|---|---|---|
| 值相同、规范写法相同（去前导零、去 `+`、`-0`→`0`；`042` = `42`） | correct | exact-match |
| 值不同 | wrong | value-differs |
| 值相同但写法不同：`4/8` vs `1/2`、`0.5` vs `1/2`、`4.0` vs `4`、`0.50` vs `0.5`、`1 1/2` vs `3/2` | uncertain | equivalent-form |
| 答案键 null / 空 | uncertain | no-key |
| 答案键不受支持（`x = 42`、`ZK:42:…`、文字） | uncertain | key-unsupported |
| 作答不受支持 / 空 | uncertain | answer-unsupported / answer-empty |

- 「值同写法不同」判 uncertain 是故意的：verifier 不知道题目要不要最简分数、几位小数、什么形式，宁可不计分也不误判。
- **从不给误因**：答错本身不是 concept / calculation / careless 等任何一类的证据，grader 的结果只有 `outcome`。
- `grade(req)` 同步、只读 `req` 的**自有数据属性** `answerKey`、`answer`（工作流的 req 还有 ctx / topicId / prompt 等，不读）；getter 不执行，Proxy 陷阱抛错、撤销的 Proxy、非对象、原型链上的字段、`Object.prototype` 污染一律 → uncertain。
- 结果不含答案键或作答原文。过长 / 恶意输入（10 万位数字、深括号）很快返回 uncertain。

## 3. 回复 verifier（response.js）

```js
verifyResponse(output, { mode, strategy?, screen?, question?, context?, evidence? })
// → 冻结 { ok, failures: [{ rule, message }], coverage }
```

`output = { kind, text, scope?, checks? }`。`kind: "refusal"` 时一条规则都不跑（拒答正文本来就换成固定模板）。`text` / `question` 超过 8000 字符 → `shape` 失败。
TutorAgent 抛出第一条失败的 `message` 让模型重写（Harness 的 `maxInvalid` = 2 次机会），用完 → `kind:"error"` + 固定出错模板，被拒的文字不会给孩子。

### 3.1 规则与覆盖

| rule | 何时跑 | 检查什么 | 保证 / 不保证 |
|---|---|---|---|
| scope | 总是（有 scope 字段时） | 非 math scope 只能 refusal | 与之前逐字相同 |
| hint-kind | `mode = hint` | 不许 `kind:"answer"` | 同上 |
| screen | 传了 `screen` 回调 | TutorAgent 的预闸规则 + 禁链接 | 同上 |
| check | 有 `checks` | 每条 `expression` 用 calculator 复算，与 JSON 数字 `value` 相对误差 ≤ 1e-9 | 同上（`value` 是 JSON 数字，所以保留容差；精确比较见下一行） |
| **equality** | **总是（不需要上下文）** | 正文里显式、边界干净的纯算术等式链精确核对 | 见 §3.2；边界不干净的不检查 |
| curriculum-claim | 有 context 且有 evidence（TutorAgent 路径） | 正文里形如 `XX.MATH.…` 的课程 id 必须在范围内：`topicId` / `allowedTopicIds`，或**查的是范围内 id** 的那几次 `curriculum.findTopic` 成功结果里出现的 id（如本话题的先修）。查一个范围外的 id 不会把它或它的先修变成本课话题。没给范围（`verify: {}`）时，任何成功查询结果里的 id 都算有出处 | 只证明「这个 id 在范围内 / 来自大纲数据」；只认这个 id 形状；关于条目的说法对不对不检查 |
| calculator-claim | 同上 | 「I checked/verified … calculator」「我用计算器…」「计算器验算过 / 显示」这类第一人称声明：正文里至少有一条真等式，而且**每条**真等式的值都有本 run 里一次成功的 `calculator.evaluate` 对上（式子能精确求值就精确比，否则按工具回的值 1e-9 相对误差比）。只是调用过计算器不够 | 只认列出的说法；只绑定到正文里边界干净的等式，不绑定散落在文字里的数 |
| answer-leak | 有 context、`mode = hint`、`answerKey` 能按 §1 解析 | 见 §3.3 | 只认列出的显式形式 |
| socratic | 有 context 且 `strategy = socratic-teaching` | 正文必须含 `?` 或 `？` | 只检查「是问句」，不检查问得好不好 |

`coverage = { declaredChecks, equalities: { checked, notChecked }, answerLeak, curriculumClaims, calculatorClaims, socraticForm, prose: "not-verified" }`，
各项取值 `checked` / `not-covered` / `not-applicable`。

**自报的东西不算证据**：`checks` 只证明那几个算式本身算得对，不证明正文用了它们——正文里的假等式即使 `checks` 全对也照样被拒；hint 步把 kind 换成 `hint` 也躲不过 equality / answer-leak。
curriculum / calculator 的证据只来自 Harness 记录的真实工具结果（`evidence`），模型在正文或 `checks` 里说「查过了 / 算过了」不算。

### 3.2 正文算术等式（equality）

- 取文本中由 `数字 . + - * / × ÷ ^ ( ) =` 和空格组成的最长片段（`.` 只有夹在两个数字之间才算小数点），按 `=` 切成链；每一侧都要能被 `evaluateExact` 解析，全部相等 → true，否则 false（除以零也算 false）。
  **整段文本完整扫描**（上限 8000 字符），不会因为前面的链多就停下，后面的假等式照样被拒。
- 只把全角 ASCII（数字、运算符、括号）换成半角，**不做 NFKC**：`2² = 22`、`1½ = 11/2` 不会被折成别的算式（上标 / `½` 算不干净的边界，不判）。
- 链**两端的边界必须干净**，否则整条链 unknown、不检查：
  - 左边：文本开头 / 换行、`。、，：；！？`、`, ; : !`（前面紧挨数字时不算，如 `10:30`、`1,000`）、句末的 `. `、白名单词 `so then thus because since check` / `所以 因为 即 也就是 然后 那么 于是 验算 先算 再算`。
  - 右边：文本结尾 / 换行、`。、，：；！`、`, ; : !`（后面紧挨数字时不算）、句末的 `.`（不是 `..` / `…`）、白名单词 `so then because since` / `所以 因为 然后 那么 于是`。
  - 其它一切（字母、`%`、`√`、上标、`（`、问号、别的词）都算不干净。所以 `15% of 80 = 12`、`2x + 3 = 11`、`3 乘 4 = 12`、`√16 = 4`、`4² = 16`、`13 ÷ 4 = 3 R1`、`3……1`、
    `7 ÷ 2 = 3 and 1/2`、`6 = 2(x+1)`、`3 + 4 = 8?`、`Is 7 × 8 = 54 right?`、`Area = 8 × 5 = 40 square cm` 都**不判**。
- 以 `=` 开头的链（`x = 3 + 4 = 7`、`Area = 8 × 5 = 40`）去掉开头那一侧再判右边部分；只剩一侧（`x = 5`）→ 不判。空的一侧（`8 + 7 = ?`）→ 不判。
- **引用孩子的算式不算模型断言**：链去空白后原样出现在问题里（「我算 45 ÷ 5 = 8，对吗？」）→ unknown。
- 已知误拒风险：模型不带引号、用干净边界复述一个**不在问题里**的错误算式（例如工作流 remediate 里写「45 ÷ 5 = 8, that's not right.」）会被当作断言退回重写一次；
  请用「you wrote …」这类带词的说法。

### 3.3 hint 模式下的答案泄露（answer-leak，`findAnswerLeak`）

只在 `answerKey` 能按 §1 解析成数字时覆盖（否则 `answerLeak: "not-covered"`）。numeral 覆盖 §1 支持的全部写法：整数、小数（含 `.5`）、分数、带分数（`1 1/2`），
与答案键**按值**比较（`4/8` 也算说出了 `1/2`）。numeral 后面必须是完整边界：结尾、空白或句读（句末的 `.` 可以）；紧跟字母 / 数字 / `%` / 上标 / `/`（`4e2`、`4cm`、`4²`）、
接数字的 `,` `.` `:`（`4,000`、`4.5`）、或空白后再接运算（`4 + 1`）都不是一个完整的数，**不截取前缀去比**。认的形式：

| 形式 | 例子 |
|---|---|
| `… = numeral` | `12 ÷ 3 = 4`、`x = 4`、`so 2x = 8, then x = 4.` |
| `numeral = …`（numeral 前不是运算） | `4 = 12 ÷ 3` |
| 英文短语 | `the (final) answer / result / solution is / = / : …`、`equals / is equal to / makes / you get / gives you / comes to …` |
| 中文短语 | `答案 / 结果 / 得数 / 总数 / 乘积 是 / 为 / 就是 / 应该是 / 等于 / : …`、`等于 / 得到 / 得出 / 算出 / 就是 …` |

**不是泄露**：答案只作为运算数出现（`3 × 4 = 12` 里的 4）；同一段数学片段 / 短语（去空白）原样出现在题目里（题目 `If 3 × 4 = 12, what is 12 ÷ 3?` 时的 `3 × 4 = 12`、题目 `What is 4 × 1?` 时复述题目）；
值不同的数（`42.5` 不是 `42`）；数数（`5, 6, 7, 8`）。其它说法（「再加 1 就是题目要的数了」「八」）**发现不了**。

### 3.4 可信上下文（`readVerifyContext` / TutorAgent 的 `req.verify`）

- 形状：纯对象（原型 `Object.prototype` 或 null），只许自有可枚举数据属性 `topicId`（事件话题规则，≤ 96）、`allowedTopicIds`（≤ 20 个话题 id 的真数组）、`answerKey`（1–200 字符文本，去空白非空，无 `\t\n\r` 以外的控制字符）。
  多余键、getter、Symbol、类实例、Proxy 异常 → `VerificationError("INVALID_VERIFY")`，消息是固定文案、不回显内容。结果是冻结的 null 原型对象。
- TutorAgent：`verify` 只认 `req` 的自有数据属性（getter 不执行 → 非法）；`undefined` = 没给。**在公开入口同步读完**，调用方之后改对象不影响本次 ask。非法 → `INVALID_INPUT`（stage input），不调分类器和模型。
- **数据边界**：上下文只进 `validateFinal`。模型请求（system、user 输入 `{question, lang, mode[, strategy]}`、修复说明）、trace、`error.message`、结果都不含答案键；
  有答案键时 check / equality 的失败说明不写复算值或等式原文（可能正好是答案）。测试逐条核对模型收到的全部请求。
  答案键的一个固有侧信道：模型如果自己写出了答案并被退回，它从「被退回」能推断那就是答案——但它本来就算出来了；修复说明本身不含答案。

## 4. 工作流后置条件（workflow.js）

```js
verifyStep(before, after, { workflowId, command, ok, attemptId, replyKind })  // → 冻结 { ok, violations: [{ category, rule }] }
```

`before` / `after` 是工作流的结构化快照（阶段、计数、题目 id / 尝试数 / 提示数 / 最近 attemptId、评分、正在评分的 attemptId、pending、outcome、version、limits；
没有题面、答案键、作答或模型文字）。工作流在执行步骤前**同步**取 before，步骤结束、**发布和缓存结果之前**取 after 并检查。规则按文档独立重算，不调用 `machine.decideAdapt`。

| 类别 | 规则（节选） |
|---|---|
| state | 阶段合法、计数是非负安全整数、plan / teachMode 与阶段一致、成功后没有 pending |
| transition | 命令只能从表里的阶段出发、到表里的阶段；成功必须抬高 version；失败不许前进 |
| counters | 每步的 correct / wrong / uncertain / round 增量（evaluate 恰好按评分 +1，practice round +1，其它为 0）；round ≤ maxRounds；每题尝试 / 提示不超上限；失败不改计数 |
| association | 题目就是最近出的那道且不重复；submit 的 attemptId = `${workflowId}.q${round}.a${n}` 并挂到评分；evaluate 的评分挂在正在评分的那次尝试上；mistake 只随 wrong；hint / remediate 不换题；回复 kind 与本步相符 |
| completion | done ⇔ 有 outcome；goal-reached ⇒ correct ≥ targetCorrect；round-limit ⇒ 轮数用完且未达标；达标后只能停在 adapt 或 done；adapt 的去向必须等于按规则重算的结果 |

**字段保持**：每个命令成功时只许改它自己的字段，没列出的一律与步骤前逐字相同（违反时 rule 为 `unexpected-change:<字段>`）：

| 命令 | 允许变的字段 |
|---|---|
| diagnose | phase、teachMode、plan |
| teach | phase、teachMode（remediate 时整道题——id、尝试数、提示数、最近 attemptId——不变） |
| practice | phase、round、已出题目、evaluation（清空）、题目（换新题） |
| hint | 只有本题的提示数 |
| submit | phase、evaluation（清空）、正在评分的 attemptId、本题的尝试数和最近 attemptId |
| evaluate | phase、correct / wrong / uncertain、evaluation、正在评分的 attemptId |
| adapt | phase、teachMode、outcome、题目（清空或原样保留） |
| 任何失败 | 只有 pending 和 version（不减） |

不通过：结果 `{ ok:false, code:"INVARIANT_FAILED", detail:<类别大写>, reply:null }`，view 的 `status` 为 `failed`、`outcome` 为 null、`allowed` 为空；
工作流移出会话表（之后 get / send → NOT_FOUND），不缓存为成功命令。trace 记一条 `code: INVARIANT_FAILED`（无文本）。
**已经交给 memory 的事件不能撤销**，照原样保留；不写 `topic_mastered`，不宣称完成。后置条件只应在实现有 bug 时触发（测试用临时替换 `machine.decideAdapt` 模拟），触发后应排查代码，不要重试。

工作流里的 TutorAgent 调用（#38）：请求带 `verify = { topicId, answerKey? }`（hint / remediate 带当前题的答案键），TutorAgent 在自己的有限重试里修正；
拿回的文字工作流再用 `verifyResponse(reply, { mode, strategy, question, context: { answerKey? } })` 本地复核（显式算术等式、hint 显式泄露、socratic-teaching 必须是问句；
没有工具证据所以不查课程 id / 计算器声明），不过 → `TUTOR_ERROR` / `detail: VERIFICATION`，固定出错模板，不前进、不记事件，可原样重发（会再问一次模型）。
兼容性：注入的 tutor 在 socratic-teaching 步回非问句，以前会前进，现在是 TUTOR_ERROR；Phase 6 测试里的合成 tutor 因此在这一种策略下回复末尾加了问号（断言没改）。

## 5. 测试与 eval

```
node tools/test_verification.mjs      # 108 项
node tools/eval_verification.mjs      # 36 项；--only <id> 只跑一条
```

- `test_verification.mjs`：数字语法表、精确求值（浮点 / 大数 / 除零 / 深度 / 长度）、答案判定表、grader 的外部 req 严格读取（getter、Proxy、撤销 Proxy、原型污染、同步快照）；
  等式抽取正反例（含所有「不判」的边界、上标 / ½ 不被折叠、50 条之后的假等式照样被拒）、泄露正反例（题目已含答案数字、运算数、非数字答案键、.5 / 带分数 / 句末点、4e2 / 4cm / 4,000 不截前缀）、
  旧文案逐字兼容、上下文规则（话题范围内的查询才扩大范围、计算器声明绑定到值）、上下文严格读取、有界工作量、依赖无环；
  真实 TutorAgent（回放模型 + 真实工具注册表）：默认路径形状不变、假等式退回 / 持续则出错模板、长回复末尾的假等式、引用孩子算式不误拒、verify 同步快照、模型请求 / trace / 错误里没有答案键、
  话题冲突、查过的课程 id 放行、伪造计算器声明、中英 socratic、非法 verify 零模型调用；工作流后置条件 16 个反例 + 6 个字段保持反例（未授权地改尝试数 / 最近 attemptId / 提示数 / plan / limits）
  + 7 条合法路径（wrong / uncertain / 带误因评分、remediate、第二次作答、带 pending 的失败）；
  真实工作流 + createMemory + createFileStore（临时目录）+ 回放 TutorAgent + createAnswerGrader：正确路径、错误 → remediate → 正确、uncertain 不记结果、hint 泄露被拦且重发成功、
  注入的非真 tutor 被本地复核拦下（假等式、说出答案、socratic 非问句）、中文 socratic 首课走真实 TutorAgent、有 bug 的 Adapt 触发 INVARIANT_FAILED（不宣称完成、事件保留、工作流移除）。
- `eval_verification.mjs`（fixture `tools/fixtures/verification_eval.json`）分类：arithmetic、misconception、prerequisite-gap、hint-only、socratic、adversarial、regression、workflow、grade，中英都有。
  每条断言 kind / 模板 / 错误码 / 模型与分类器调用次数 / 工具序列 / 每次退回的规则名 / coverage 字段；全局不变量：送给孩子的答案 / 提示里没有假等式、模型请求不含 `answerKey` / 话题 id / 身份、
  trace 和错误里没有答案键、回放脚本恰好用完（多或少都说明退回次数不对）、工作流不写 `topic_mastered`、磁盘上没有题面 / 答案键、没有 INVARIANT_FAILED。任何不符 → 非零退出。
- 既有 golden、eval 和策略测试保持不变；工作流测试的断言未弱化，Socratic 合成 stub 按新问句契约增加了问号（见 build/phase7/result.md 的回归结果）。

## 6. 扩展方式

- **新的答案语法**（如百分数、单位）：在 `number.js` 加解析并给出规范写法，在 `answer.js` 的判定表加行；先加「不确定」的测试，再放开。不要引入容差比较。
- **新的回复规则**：在 `verifyResponse` 里加一条带 `rule` 名的检查和 coverage 字段；只有需要上下文的规则才放进 `if (ctx)`，否则会改变不传 verify 时的行为。
  失败文案会交回模型，不能含答案键或任何上下文内容。
- **新的上下文字段**：同时改 `CONTEXT_KEYS`、`readVerifyContext` 的校验和本文件 §3.4；TutorAgent 不需要改（它把整个上下文原样交给 `verifyResponse`）。
- **新的工作流步骤**：`verification/workflow.js` 的 `MOVES` 表、`successRules` 的 case 和快照字段要一起改，否则新步骤会被判 INVARIANT_FAILED。

## 7. 限制（重要）

- **规则级、窄覆盖**：只检查上面列出的显式形式。自然语言讲解、一般事实、概念是否讲对、诊断是否准确、练习题难度都没有 verifier，coverage 里是 `not-verified`。
- **等式检查宁漏不误**：边界不干净就不判，所以模型把错误算式写在词中间（「so 37 × 4 = 150 and …」）不会被发现；每个 verify 结果的 `equalities.notChecked` 给出跳过的数量。
- **泄露检查只认数字答案键和列出的说法**；Phase 6 的不透明答案键（如 `ZK:…`）不覆盖。
- **答案 grader 只覆盖数字**，而且写法不同就 uncertain；分数最简、保留位数、单位题等需要按题型的判分器，本阶段不做。
- **课程 id 声明**只认 `XX.MATH.…` 形状，只在 TutorAgent（有 evidence）路径检查；工作流的本地复核没有工具证据，不查这一项。
- **socratic 问句检查**只在传了 verify 的 TutorAgent 调用和工作流的本地复核里做，只看有没有 `?` / `？`。
- **证据只证明出处，不证明内容**：课程 id 规则证明 id 在范围内或来自大纲查询；计算器声明规则证明正文里的等式值有真实计算器结果对上。条目描述、先修关系的说法是否正确都不检查。
- **后置条件失败不回滚已写事件**；工作流状态仍只在进程内存。
- 回放 eval 用写好的模型输出，证明的是「给定输出时规则拦 / 放是否符合预期」，不衡量真实模型的质量。
