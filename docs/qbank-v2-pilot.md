# 英文题库 v2 真实试点清单（issue #8 · 子任务 D）

> **状态：未执行。** 本文件只是步骤、命令和记录模板；截至 #45 交付，没有跑过任何真实生成 / 审稿，没有访问真实家庭数据，没有同步 Apple 内容。
> 开跑前要维护者对**本清单定义的试点范围**（这三个技能、两臂、下面的命令与重跑上限、会产生的模型调用费用）**一次性明确授权**；授权后按清单执行，不逐步重复审批。
> 结果写回 #8，没跑的写「未跑」。
> #43–#45 的测试只证明编排对假引擎是对的（审稿结论是脚本写死的），**不能**当成真实题目质量或真实审稿能力的证据——那正是本试点要回答的问题。
> 命令语法以 [qbank-pipeline-plan.md](qbank-pipeline-plan.md) §3 为准。

---

## 0. 准备：两个全新的隔离数据目录（不碰真实家庭数据）

- **不要**把真实数据目录（仓库根目录的 `qbank.json` / `config.json` / `data/kids` / 账号，或打包版的用户数据目录）拿来试点，也**不要**让首次启动「接管」个人数据：
  `YY_DATA_DIR` 指向一个没有 `.migrated-from-app` 标记的新目录时，server.js 会把 app 目录里的 `config.json`、`qbank.json`、`data/kids`、账号等**拷过去**。所以标记、配置、题库要在跑任何命令之前先放好。
- A 臂（对照：现有 `--judge` 流程）和 B 臂（v2）各一个目录，起点完全相同：已跟踪的 `demo/qbank.json`（只有 `BC.*` 题库，三个试点技能在里面都没有题）。
- 配置里**钉死**模型和 effort：v2 的审稿记录绑定审稿引擎身份，claude 不钉 model = 模型不确定，结论永远不复用、`export --review v2` 也不认。两臂用同一份配置。

PowerShell（在仓库根目录；把 `<MODEL>` 换成要试的模型，端口避开正在跑的 8434）。两个目录必须是**全新**的：已经存在就停下、换一个新目录名，
绝不覆盖 / 重置之前的试点证据；文件一律按不带 BOM 的 UTF-8 写：

```powershell
$P = "D:\pilot\qbank-v2-<日期>"
$utf8 = New-Object System.Text.UTF8Encoding $false
foreach ($arm in "arm-a", "arm-b") {
  $d = Join-Path $P $arm
  if (Test-Path $d) { throw "$d 已存在：试点目录必须全新，换一个目录名，不要覆盖之前的试点证据" }
  [System.IO.Directory]::CreateDirectory((Join-Path $d "data")) | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $d ".migrated-from-app"), "pilot data dir: no takeover`n", $utf8)
  Copy-Item demo\qbank.json (Join-Path $d "qbank.json")
  [System.IO.File]::WriteAllText((Join-Path $d "config.json"), '{ "port": 8435, "claude": { "model": "<MODEL>", "effort": "high" } }', $utf8)
}
```

记下：代码 commit、`<MODEL>` / effort、出题引擎 `<GEN>` 和审稿引擎 `<JUDGE>`（两臂必须相同）、开始时间。
下面每一步都先设 `$env:YY_DATA_DIR`；试点结束后 `Remove-Item Env:YY_DATA_DIR`，免得之后的命令还落在试点目录（或反过来，没设就落进真实数据目录）。

## 1. 三个技能（已在已跟踪的技能图谱里核对）

| 技能 id | 年级 | 为什么选它 |
|---|---|---|
| `YY.MATH.FRAC.EQUIV.VISUAL` | g5 | 技能的表示本身是图（fractionBar / pie）：看题图生成、题图语义审稿 |
| `YY.MATH.DATA.LINE.READ` | g6 | issue #5 的起源（折线图读数）：看 statLine 题图与「题干念图」 |
| `YY.MATH.FLU.MULTDIV.WORD` | g5 | 多步应用题；barModel 不是题图类型：看「不机械配图」、题目自足 |

## 2. A 臂：现有 `--judge` 流程（对照组）

```powershell
$env:YY_DATA_DIR = Join-Path $P "arm-a"
node tools/pregen.mjs --review v1 --skill YY.MATH.FRAC.EQUIV.VISUAL,YY.MATH.DATA.LINE.READ,YY.MATH.FLU.MULTDIV.WORD --only quiz --langs en --provider <GEN> --judge <JUDGE>
```

老流程（`ensureQuizBank` + v1 审稿：整批 `pass/problems/bad`，按题剔除、没过重来一次）只做这三个技能的英文题库，每级 4 道。
老流程的退出码不反映「没做完」：跑完用同一条命令加 `--dry` 看还剩哪些题库要做（列出 `题  en  <id>` 就是没齐）。
**重跑上限和 B 臂一样**：首跑之后最多再跑 2 次，只要 `--dry` 还列出要做的就再跑；每次的输出存成文件。

## 3. B 臂：v2 流程（实验组）

```powershell
$env:YY_DATA_DIR = Join-Path $P "arm-b"
node tools/pregen.mjs --review v2 --skill YY.MATH.FRAC.EQUIV.VISUAL,YY.MATH.DATA.LINE.READ,YY.MATH.FLU.MULTDIV.WORD --provider <GEN> --judge <JUDGE> --concurrency 1
```

- 退出码 `2` = 没做完（某级通过数不足 4 道，或有调用要重试）：首跑之后**最多再跑 2 次**（和 A 臂同一个上限；每次只补不足的级别），每次的退出码、输出都记下；
  退出码 `1` = 有故障，先停下查「故障」行，不算进重跑次数之前先弄清楚原因。
- 每次运行的报告在 `arm-b\qbank-review\reports\`；扣下等人工的候选题在 `arm-b\qbank-review\drafts\`（状态 needs_human / exhausted / hard_rejected …）——人工终审时也要看它们（算误拒）。
- 导出（只读题库和旁路记录，不调模型；输出到试点目录，不写 Apple 仓库）：

```powershell
node tools/export_apple.mjs --review v2 --skill YY.MATH.FRAC.EQUIV.VISUAL,YY.MATH.DATA.LINE.READ,YY.MATH.FLU.MULTDIV.WORD --judge <JUDGE> --out (Join-Path $P "export-b") --no-voice
```

  看 `export-b\manifest.json` 的 `qbankReview.banks`：每个题库导出几道、排除几道（needs-human / revise / 没有证据）、有没有整份 withheld。

## 4. 可比性（两臂必须一致，否则结论不成立）

- 同样的三个技能、同一个 `<GEN>` / `<JUDGE>`、同一份 config（model / effort）、同一个代码 commit、同样的重跑上限（首跑 + 最多 2 次）。
- **主比较样本（事先定好，不看结果再挑）**：每臂每技能每级取**前 4 道**——A 臂按 `arm-a\qbank.json` 里该题库的顺序，B 臂按 `export-b` 里该题库的顺序（都 = 发布顺序）。
  多出来的题（重跑补出来的、超过 4 道的）也逐题审，但单独列，不进主比较；
  某臂某技能某级在重跑上限内凑不满 4 道 → 这一格记「不匹配」，写明各有几道，**这一格不下对比结论**。
- 全部候选和费用都要入账，不只看发布的：两臂都记「生成的候选总数 / 发布数 / 进主比较的数」。
- 调用数与耗时从各自的 `usage.jsonl` 统计：按 `task`（A：`pregen:quiz` / `judge:quiz`；B：`pregen:quiz` / `judge:quiz` / `quiz:repair`）数行数、加总 `ms`、有 `costUsd` / token 的一并加总。
- 不能跑满的（比如某臂中途额度不够）如实写「未跑完」及停在哪一步，不外推。

## 5. 人工逐题终审（两臂都做；审题人不看模型结论先判，判完再对照）

每道**发布的题**一行，B 臂另外把**扣下的候选**（needs_human / exhausted / hard_rejected）也各审一行：

| 臂 | 技能 | qid / draftId | 级 | 题干（前 40 字） | 答案唯一且对 | 解析对、不按位置指选项 | 干扰项像真错误、tags 含义对 | 题图需要且与题干一致 / 不需要且没有 | 在本技能内、符合本级 | 和课文说法一致 | 人工结论（收 / 改后收 / 拒） | 需要的修改 | 模型结论（B 臂） | 审题人 / 用时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

汇总（每臂一份）：

| 指标 | A 臂 | B 臂 |
|---|---|---|
| 发布题数 / 生成候选数 | | |
| 人工确认的**残留错误**（发布了但人工拒 / 必须改） | | |
| **误放**：模型判过、人工拒（B 臂按逐题结论算；A 臂按整批 pass 算） | | |
| **误拒**：模型扣下 / 剔除、人工认为可收 | | |
| 需要修改的题数与修改量（字数或处数） | | |
| 模型调用数（按任务）/ 总耗时 / 费用 | | |
| 未跑 / 中断的步骤 | | |

## 6. 网页版作答与讲评检查（B 臂数据，另开端口，不动正在跑的服务）

```powershell
$env:YY_DATA_DIR = Join-Path $P "arm-b"
node server.js      # 读的是 arm-b 的 config.json（端口 8435）；第一次打开时注册一个试点家长 / 学生账号
```

逐个技能进闯关，每级至少做到一题：题图是否画出来、在看图模式下能不能答、答完的讲解和答案是否一致、答错时的误区提示是否对得上所选选项。
结果记进第 5 节表格的「题图」「解析」两列旁边的备注。检查完关掉这个进程；8434 上正在跑的服务不停、不重启。

## 7. 不在本清单里的事

- Apple 端内容同步（把 `export-b` 拷进 AITutor-APPLE 仓库）：试点结论出来之后由维护者单独决定、单独执行。
- 把试点题并进真实题库 / 发新内容包：同上。
- 试点里改题、改课文：改了之后按 v2 规则会重新审稿，重跑第 3 节即可；改课文 `say` 会影响语音包，另走语音流程。

## 8. 结果写回

在 #8 下贴：commit、模型与 effort、两臂命令与每次退出码、第 4 节统计、第 5 节汇总表（逐题表作为附件）、第 6 节检查结果、所有「未跑」项。
没有人工终审结论之前，父 #8 不能标 Done。
