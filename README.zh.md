# 圆圆数学 🧮

*[English version →](README.md) · [项目主页](https://liukai1919.github.io/AI-tutor/)*

给孩子的 AI 数学小老师：出一道题（打字或拍照），一步一步、配着图、用语音讲给孩子听，最后给答案核对 + 一道同类练习。**支持中文和英文**（右上角一键切换，讲解、界面、语音全套跟着换）。

跑在你自己的电脑或树莓派上，**不需要往网页里填任何 API key** —— 它会自动借用你机器上已登录的 AI 工具。

## 装好就能用（给不折腾的人）

从 [Releases](https://github.com/liukai1919/AI-tutor/releases) 下载对应的包，装完双击图标就开始上课 —— **不用装 Node，不用装 AI，不用联网，不用注册任何服务**：

| 系统 | 下载 | 怎么装 |
|---|---|---|
| Windows | `YuanyuanMath-x.y.z-win-x64-setup.exe` | 双击 → 下一步装完。装在你自己的用户目录，不需要管理员权限。第一次运行 Windows 可能弹「未知发布者」（这个包没买代码签名证书），点「更多信息 → 仍要运行」。 |
| Windows（免安装） | `YuanyuanMath-x.y.z-win-x64.zip` | 解压到任意文件夹，双击里面的 `圆圆数学.bat`。 |
| macOS | `YuanyuanMath-x.y.z-mac.tar.gz` | 双击解压 → 把 `圆圆数学.app` 拖进「应用程序」（必须先拖，否则系统会把它放进只读位置运行，数据存不下来）→ 终端里跑一次 `xattr -dr com.apple.quarantine "/Applications/圆圆数学.app"` 去掉隔离标记（同样是没买苹果签名，系统会先拦；不想用终端就双击让它被拦一次，再到 系统设置 → 隐私与安全性 → 点「仍要打开」。「右键 → 打开」macOS 15 起已被苹果移除）。只需这一次。 |

装完浏览器会自动打开 http://localhost:8434 。先注册家长账号，再给孩子建账号，就能开始了。
同一个 Wi-Fi 下的 iPad / 手机也能用，地址看窗口里打印的「局域网访问」。

**数据存在哪、升级会不会丢**：账号、学习进度、攒下的题库和配置都存在系统的用户数据目录（Windows `%APPDATA%\YuanyuanMath`，macOS `~/Library/Application Support/YuanyuanMath`），**升级、重装、卸载再装都不会丢**。唯一要动手的是从 1.0.0 升级的 macOS 用户——1.0.0 把数据存在 .app 包内部（这正是后来改掉的问题）：替换 .app **之前**，右键旧 `圆圆数学.app` →「显示包内容」，把 `Contents/Resources/app/` 里的 `data` 文件夹和 `config.json`、`qbank.json` 拷到自己新建的 `~/Library/Application Support/YuanyuanMath/` 里，然后再装新版。Windows 从 1.0.0 升级不用动手：装新版（zip 版解压覆盖旧文件夹）后第一次启动会自动接管老数据。

**包里已经带了什么**（都不需要 AI 引擎）：

- BC 省 G4-G7 数学大纲的**全部课程**，中英各一份，点开秒出，断网也能上
- 每节课配套的**闯关题库**
- 每个单元的**单元测试卷**（每年级 5 张，中英各一份）
- **真人感语音**，中英文都有（CosyVoice 预先合成好的，不是浏览器那个机械音）

**什么还需要装 AI 引擎**（下一节讲怎么装，Ollama 免费离线）：

- 自己出题：打字或拍照问一道具体的题
- FSA 模拟卷（跨主线的全省测评风格，只有 G4/G7 有）
- 家长的「完整学习报告」
- 「再出一张新卷」「换个讲法再讲一遍」这类要新内容的操作

没装引擎也不会有报错弹窗——界面会直说哪条路现在能走。

## 支持的 AI 引擎（可选；装了才解锁拍照出题）

| 引擎 | 怎么算钱 | 支持看图（拍题） |
|---|---|---|
| **Claude Code**（`claude` CLI） | 你的 Claude 订阅 | ✅ |
| **Grok Build**（`grok` CLI） | 你的 Grok 账号按量 | ❌（请打字输题） |
| **Gemini CLI**（`gemini`） | Google 免费额度 | ✅ |
| **Codex**（`codex` CLI） | 你的 OpenAI 登录 | ❌ |
| **Ollama 本地模型** | 完全免费、离线 | ✅（需带视觉的模型，如 qwen） |
| Anthropic / OpenAI 兼容 API | key 写在 `config.json`（服务器端） | ✅ |

多个都装了的话，默认自动挑一个，也可以在网页右上角 ⚙️ 里手动选。

## 快速开始（Windows / Mac / Linux）

需要 Node.js 18+（https://nodejs.org）。

```bash
node server.js
```

Windows 直接双击 `start.bat` 也行。然后浏览器打开终端里显示的地址（默认 http://localhost:8434）。手机/平板连同一个 Wi-Fi，访问"局域网访问"那个地址即可。

## 配置（config.json）

```jsonc
{
  "port": 8434,
  "registrationCode": "",    // 第一位家长注册完，注册就自动关闭了；设了邀请码才能再开新家庭
  "provider": "auto",        // 固定用某个引擎：ollama | grok | claude | gemini | codex | anthropic | openai
  "ollama": {
    "url": "http://localhost:11434",
    "model": "",             // 留空自动挑；建议 qwen 系列（数学好、支持中文和看图）
    "think": true            // 关掉可提速，但数学准确率下降，不建议
  },
  "anthropic": { "apiKey": "", "model": "claude-opus-5" },
  "openai": { "baseUrl": "", "apiKey": "", "model": "" },  // OpenRouter/xAI 等 OpenAI 兼容服务
  "tts": { ... }               // 自然语音（可选），见下面「自然语音」一节
}
```

环境变量 `PORT`、`REGISTRATION_CODE` 可覆盖对应配置。
（旧版的 `accessCode` 已弃用：访问控制改由下面的账号系统负责，配置里写了也不再生效。）

## 账号：家长 / 学生两种角色

第一次打开网页会进入**注册向导**：先创建家长账号（用户名 + 密码），再给孩子建账号
（名字 + 4-6 位 PIN，不需要邮箱）。之后每次打开是一个**选择屏**：孩子点自己的名字输 PIN
进入，家长从角落的「我是家长」入口登录。登录 60 天内免重复输入（滑动续期，重启服务器不掉线）。

**权限划分**（服务端强制，不是只藏按钮）：

| | 学生（孩子账号） | 家长 |
|---|---|---|
| 出题讲课、跟大纲学、闯关、单元测试 / FSA 做卷 | ✅ | ✅ |
| 查看/重播自己的历史课、练习自报对错 | ✅ | ✅ |
| 切换年级/教材、语言 | ✅ | ✅ |
| 📊 家长报告、标扎实 ★ | ❌ | ✅ |
| 生成**完整学习报告**（AI 撰写，见下） | ❌ | ✅ |
| 删除记录 / 清空数据 | ❌ | ✅ |
| 指定 AI 引擎（孩子一律用 config 默认） | ❌ | ✅ |
| 创建 / 改名 / 重置 PIN / 删除孩子账号 | ❌ | ✅ |

- **孩子设备上的家长临时解锁**：孩子登录态下点 📊（或触发任何家长功能）会弹出家长登录框，
  验证后进入「家长模式」（页面顶部有徽章）；**关掉标签页自动退出**，不影响孩子的登录。
- **多孩子**：家长可在 ⚙️ 设置里添加多个孩子，每个孩子的进度、历史、卷子（FSA / 单元测试）、报告完全独立
  （存在 `data/kids/<孩子id>/`）；闯关题库全家共享（省引擎费用）。家长界面用「当前孩子」
  选择器切换查看对象。
- **旧数据自动迁移**：老版本根目录的 `progress.json` / `history.json` / `fsa-sets.json`
  会在**创建第一个孩子时**自动搬进 TA 的目录，一条不丢。
- 忘了密码：家长密码忘了就删掉服务器上的 `data/users.json` 里对应条目重新注册（孩子数据不受影响，
  重建后用设置里的孩子管理接回）；孩子 PIN 由家长在设置里重置。
- 防孩子暴力试码：同一设备连错 5 次锁 30 秒。
- 技术细节：密码/PIN 用 scrypt + 随机盐存 `data/users.json`；登录 token 存 `data/sessions.json`；
  语音音频 URL（内容哈希）和静态页面不鉴权——音频是不可枚举的缓存文件，页面本身无机密。

## 完整学习报告（家长专属）

📊 报告弹窗顶部的「**生成完整报告**」：圆圆老师把孩子的全部学习数据（四级分布、各主线
对错、薄弱点、近 14 天动态、单元测试与 FSA 成绩趋势）写成一份**带评语和建议的完整报告**——总评、
各主线分析、亮点、需要加强（每条配一个在家 5-10 分钟的练习建议）、给家长的建议、接下来学什么。

为防 AI 编数字，报告分两层：**统计数字由服务器确定性计算**（附在报告末尾的「数据附录」），
AI 只负责基于这些数字写叙事。生成一份约 1-2 分钟（走一次 AI），自动存档在
`data/kids/<孩子id>/reports.json`（每孩子留最近 50 份），随时回看、对比、打印，不用重新生成。

## 自然语音（可选，CosyVoice 2）

默认用孩子设备浏览器自带的语音朗读（免费、零配置，但比较生硬）。如果服务器这台机器装了
[CosyVoice 2](https://github.com/FunAudioLLM/CosyVoice)（本地模型，Apache-2.0，2-4GB 显存，CPU 也能跑），
配置后讲解会换成自然的真人感声音，中英文同一个音色。

**推荐跑法：常驻守护进程**（模型只加载一次，之后每步 2-9 秒出声）。
用 CosyVoice 自己的 Python 环境启动 `tools/tts_server.py`：

```bash
# 在装了 CosyVoice 的环境里（Windows 上通常是 WSL）：
python tools/tts_server.py --port 9880
# 模型不在 ~/tts/CosyVoice 时：--repo /path/CosyVoice [--model-dir ...]
```

守护进程默认只监听 `127.0.0.1`——`/synth` 没有鉴权，谁连得上谁就能排队占你的显卡。
在 WSL 里跑也不影响 Windows 上的 node 访问（WSL 的端口转发直接打到 VM 的 loopback，实测可用）。
只有守护进程和 node 不在同一台机器上时才需要 `--host 0.0.0.0`，那种情况请自己配防火墙。

然后 config.json 里指过去：

```jsonc
"tts": {
  "enabled": true,
  "url": "http://localhost:9880",   // 守护进程地址（WSL 里跑也是 localhost，自动转发）
  "mode": "zero_shot",              // 跟参考音最像（默认）。instruct 可用指令控语气，但部分
                                    // CosyVoice 版本会把指令念出来，确认没问题再换

  "speed": 1.0,
  "refAudio": "",                   // 换音色：一段 3 秒以上干净人声的路径（引擎侧视角）
  "refText": "",                    // zero_shot 模式需要参考音的逐字转写
  "refLang": "zh"
}
```

Windows + WSL 建议把守护进程装成 systemd 服务（`systemctl enable --now yuanyuan-tts`，
unit 参考 README 同目录的 videogen 写法），跟着 WSL 一起自愈；
**不要**让 Node 每次去 spawn `wsl.exe`——这台机器实测 wslservice 会周期性 wedge（E_UNEXPECTED），
而已在跑的守护进程和 localhost 转发不受影响。

不想常驻的话还有**命令模式**：`"command": ["/path/python", "/path/ai-tutor/tools/tts_batch.py", "{manifest}"]`，
每节课起一次进程批量合成（每次多付 ~12 秒模型加载）。url 和 command 都不配就是纯浏览器语音。

工作方式：出完题服务器就开始按步合成，按内容哈希缓存在 `tts-cache/`（上限 500MB 自动清理，
同一道题再讲直接秒播）。某一步没就绪时前端最多等 15 秒，等不到自动退回浏览器语音，
**任何一环失败都不影响讲课**。英文讲解用同一音色跨语言合成（cross-lingual），不用单独配。

## 部署到树莓派（孩子不在家也能用）

树莓派 4/5（2GB 内存就够，引擎跑在云端/订阅侧，派只做桥梁）。

### 1. 装 Node 和本程序

```bash
sudo apt update && sudo apt install -y nodejs npm
# 把整个 ai-tutor 文件夹拷到派上，比如 /home/pi/ai-tutor
cd /home/pi/ai-tutor && node server.js   # 先手动跑一次确认 OK
```

### 2. 在派上装一个 AI 引擎（推荐 Claude Code 或 Gemini CLI）

```bash
# 方案 A：Claude Code（用你的 Claude 订阅，数学最稳）
npm install -g @anthropic-ai/claude-code
claude   # 跟着提示登录一次即可

# 方案 B：Gemini CLI（免费额度大）
npm install -g @google/gemini-cli
gemini   # 登录一次

# 方案 C：不装 CLI，把 API key 写进 config.json 的 anthropic 或 openai 段
```

> 树莓派跑不动本地大模型，Ollama 方案适合家里的台式机，不适合派。

### 3. 注册账号（第一次打开网页时）

浏览器打开派的地址，跟着注册向导建家长账号和孩子账号即可（见上面「账号」一节）。
**第一位家长注册完，注册接口就自动关闭了**——之后再有人访问到这台服务器，也开不了新家庭。
要再给一个家庭开口子，就在 `config.json` 里设 `registrationCode`（邀请码），拿到码的人才能注册。

### 4. 开机自启（systemd）

```bash
sudo tee /etc/systemd/system/yuanyuan.service > /dev/null <<'EOF'
[Unit]
Description=YuanYuan Math
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pi/ai-tutor/server.js
WorkingDirectory=/home/pi/ai-tutor
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now yuanyuan
```

### 5. 外网访问：用 Tailscale（强烈推荐，别开路由器端口转发）

[Tailscale](https://tailscale.com) 免费、安全、不用配路由器：

```bash
# 派上：
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

再在孩子的平板/手机上装 Tailscale App，登录同一个账号。之后无论在哪，浏览器访问
`http://树莓派的tailscale名字:8434` 就能用，流量端到端加密，陌生人碰不到。

（如果一定要公网直连，用 Cloudflare Tunnel 也可以。注册在第一位家长之后就自动关了，陌生人开不了
新家庭；但公网暴露仍然意味着别人可以试你的家长密码和孩子 PIN，能不暴露就别暴露。）

## 跟大纲学（BC 省数学大纲）

不止「来一题讲一题」——首页的「**跟大纲学**」tab 按加拿大 BC 省官方数学大纲（June 2016）系统教学：

- 选年级（**Grade 4-7** 数据已内置）→ 看到这学期五大主线的全部知识点，
  中英双语对照（英文是官方原文，中文标题给孩子和家长看）。
- 点任一条，圆圆老师按该知识点开讲：生活例子引入 → 核心方法配图 → 1-2 个例题 → 口诀小结，
  中文课里自然带出英文术语（"小数，英文课上叫 decimal"），孩子在学校听英文课能对上号。
- 课末练习按「答对了 ✓ / 还不会 ✗」自报对错，进度记在孩子自己名下
  （`data/kids/<孩子id>/progress.json`）：灰点=还没学，蓝点=讲过，绿点=**扎实**
  （不同日期答对 ≥2 次）。重启服务进度不丢。
- 大纲数据是构建期生成的静态 JSON（`data/curriculum/bc/`），运行期只读、离线可用；
  重新抓取/校对用 `node tools/curriculum/parse_bc.mjs --grade 4`（已有中文层会自动保留）。
- 右上角 📊 是**家长报告**（家长专属，孩子点开会弹家长登录）：按主线汇总（"本学期 18 条内容，
  已讲 X 条，扎实 Y 条"），每条用 BC 学校成绩单同款四级话术（Emerging 起步 / Developing 发展中 /
  Proficient 扎实 / Extending 拓展），配每主线 Big Idea 的双语解释，可直接打印拿去和老师面谈；
  顶部还能一键生成 AI 撰写的**完整学习报告**（见上面专门一节）。
- **单元测试**（📝 按钮在每个单元标题右边）：一个「单元」= BC 大纲的一条主线，或教材里的
  一章。学完一个单元点 📝 出一张卷：8 道题覆盖本单元**全部**知识点，难度从基础 → 应用 →
  挑战排好序（3 / 3 / 2），每题挂着自己的知识点。计时作答，交卷看成绩和逐题解析，
  错题一键转成该知识点的讲解课。**判分和记进度都在服务端**按存档答案算，前端报什么分不算数。
  和另外两种练习分工不同：闯关（⚡）盯**一个**知识点、通关标扎实；FSA（🎯）是跨主线的
  全省测评风格、只有 G4/G7 有；单元测试是**一个单元收尾**，任何年级、任何教材都能出。
- **FSA 模拟练习**（G4 / G7，🎯 按钮在「跟大纲学」里）：FSA 是 BC 4、7 年级秋季全省数学
  素养测评。圆圆老师现场出一卷 6 道 FSA 风格的原创多步骤情境选择题（干扰项都来自真实
  常见错误），计时作答；交卷看成绩和逐题解析，每题对错自动记入学习进度，错题一键转成
  该知识点的完整讲解课。想练英文读题（考场是英文），把界面切到 EN 再出卷即可。
- **生成一次，永久复用**：出过的卷子按孩子保存（FSA 存 `data/kids/<孩子id>/fsa-sets.json`，
  单元测试存 `unit-tests.json`），在「已出过的卷子」/ 单元的 📝 面板里点开直接做、可反复做、
  记每次成绩（🎯 / ＋ 出一张新卷 才是花引擎出新卷）；中途退出只记「做到第几题」，
  不会当成考砸。讲过的知识点再点直接**重播上次那节课**（秒开、语音已缓存、不花引擎），
  行上的 🔄 才会重新生成一节新课。

数据来源：BC 官网 [curriculum.gov.bc.ca](https://curriculum.gov.bc.ca/curriculum/mathematics/4/core)，
条目原文逐字保留并在页面标注来源（BC Curriculum · June 2016）。

## 历史记录

每讲完一道题，服务器会自动把整节课记到孩子名下（`data/kids/<孩子id>/history.json`，
每孩子最多 500 条，滚动淘汰）。网页右上角 📖 打开历史面板：可以按题目/答案搜索、
点一条**原样重播**（不再请求 AI，语音命中 `tts-cache` 的话直接秒开）；删除记录是家长动作
（家长登录后逐条删）。拍照题不保存照片本身，只记一个 📷 标志。
记录跟着服务器走——孩子在平板上讲过的题，家长在电脑上登录家长账号、选中这个孩子就能翻到。

## 自己打包发布

### 先搞清楚：仓库里有什么、没有什么

预生成的内容分两类。**文本进仓库，二进制和用户状态不进**——不然仓库会被几百 MB 音频
和每天都在变的做题记录撑爆。

| 东西 | 在仓库里？ | 说明 |
|---|---|---|
| 课程包 `data/lessons/`（138 节） | ✅ 有 | 1.2 MB 文本，clone 下来直接能用 |
| 单元测试卷 `data/unit-tests/`（40 张） | ✅ 有 | 328 KB 文本 |
| BC 大纲 `data/curriculum/bc/` | ✅ 有 | 省政府公开材料 |
| **闯关题库 `qbank.json`（1656 道）** | ❌ **没有** | 孩子每做一题就会写 `usedAt`，是活的用户状态，进了 git 每天都在脏 |
| **语音包 `data/voice/`（1075 条）** | ❌ **没有** | 158 MB 二进制，进 git 就永久留在历史里删不掉 |
| 用户数据 `data/kids/`、`users.json` | ❌ 没有 | 孩子的学习记录和账号，永远不该进公开仓库 |
| 打包产物 `build/` | ❌ 没有 | 里面还有下载来的 Node 运行时 |

所以：**clone 下来就能跑，也能讲课**（课程包是全的），但**要打一个和我发布的一样完整的
安装包，你得自己补两样**：

```bash
# 补闯关题库：约 92 分钟，需要一个 AI 引擎
node tools/pregen.mjs --only quiz --concurrency 3

# 补语音包：约 3.5 小时，需要 CosyVoice 守护进程 + ffmpeg
node tools/prevoice.mjs --langs zh,en
```

不补也能打包，只是装出来的软件闯关要现场出题（得有引擎）、语音退回浏览器的机械音。

### 三步走

先把课生成好，再把语音烘好，最后打包。全在 `tools/` 里，都能断点续跑（中途 Ctrl-C，
再跑一次接着做，已完成的不重做）。

```bash
# 1. 生成课程 + 闯关题库 + 单元测试卷
#    138 节课、138 组题库、40 张卷。需要一个 AI 引擎。
#    跑一遍大概三四个小时，建议挂着过夜。
node tools/pregen.mjs --concurrency 3

# 2. 预烘语音（中英各约 540 条，共三四个小时，约 160 MB）
#    需要 CosyVoice 守护进程跑着 + ffmpeg。
#    只烘中文的话加 --langs zh，但注意界面默认是英文，
#    新用户开箱听到的就是英文课——不烘英文他们只能听浏览器的机械音。
node tools/prevoice.mjs --langs zh,en

# 3. 打包（自动从 nodejs.org 下 Node 运行时并校验 SHA256）
node tools/pack.mjs --version 1.0.0
```

产物落在 `build/`：Windows 的 `setup.exe` 和免安装 `zip`、macOS 的 `tar.gz`。

几件要知道的事：

- **Windows 的 `setup.exe` 需要 Inno Setup**：`winget install JRSoftware.InnoSetup`。
  没装也不影响，脚本会跳过它，免安装 zip 照出。
- **两个包都没有代码签名**。买证书要钱（Windows 一年几百刀，苹果 99 刀/年），所以用户
  第一次打开会被系统拦一下，上面「装好就能用」那节写了怎么过。真要发给陌生人用，
  签名是最值得先花的那笔钱。
- **书籍课程默认不进包**。`tools/pregen.mjs --books` 和 `tools/pack.mjs --books` 能带上，
  但 AoPS 那四本是有版权的教材，公开分发对着它目录结构做的成品课，风险自己掂量。
  BC 大纲是省政府公开材料，没这个问题。原书正文（`data/curriculum/books/text/`）
  任何情况下都不会进包，脚本里写死了。
- **语音包的文件名哈希跟配置绑定**。`prevoice.mjs` 一律按 `config.example.json` 算，
  `pack.mjs` 也把它作为 `config.json` 发出去，两边才对得上。要是你改了
  `tts.mode` / `speed` / `refAudio` 又只改了一边，用户那边一条语音都命中不了。
- 装好的用户数据（`data/kids/`、`users.json`）是运行时生成的，安装器不认识它们，
  所以卸载不会删，重装能接上。

## 说明

- 中英文：**默认英文界面**（主要面向在英文学校上学的孩子），右上角「EN / 中」一键切换，
  界面、例题、讲解语言、语音全套跟着换；设置里也能改。设备上保存过的语言选择优先于默认值。
- 语音朗读：配置了 CosyVoice 就用自然音色（见上），否则用孩子设备浏览器自带的语音（免费、不走服务器；
  Edge 浏览器的"Natural"在线音色效果最好，会自动优先选用）。
- 图形（分数条、数轴、面积格子、线段图）是程序画的，永远不会画错；AI 只负责选图和填数字。
- AI 讲题偶尔会算错。最终答案会单独醒目显示，建议家长顺手核对。

## 许可证

[MIT](LICENSE)。代码和仓库里预生成的课程内容（课程、闯关题库、单元测试卷）随便用、随便改、
随便再分发。

有两样东西**不在**这个许可证范围内，因为本来就不是我的：

- 课程对齐的 **BC 省数学大纲学习标准**，版权归不列颠哥伦比亚省政府。本项目与省政府无任何
  隶属关系，也未获其背书。
- **AoPS 教材正文**（`data/curriculum/books/text/`）有版权，既不进仓库也不进任何安装包，
  见上面「自己打包发布」。
