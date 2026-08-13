# 圆圆数学 🧮

给孩子的 AI 数学小老师：出一道题（打字或拍照），一步一步、配着图、用语音讲给孩子听，最后给答案核对 + 一道同类练习。**支持中文和英文**（右上角一键切换，讲解、界面、语音全套跟着换）。

跑在你自己的电脑或树莓派上，**不需要往网页里填任何 API key** —— 它会自动借用你机器上已登录的 AI 工具。

## 支持的 AI 引擎（自动检测，装了哪个用哪个）

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
  "accessCode": "",          // 设置后，网页需输入同样的访问码（部署到外网必设！）
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

环境变量 `PORT`、`ACCESS_CODE` 可覆盖对应配置。

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

### 3. 设置访问码（必做）

```bash
# 编辑 config.json，把 accessCode 改成一个孩子记得住的码，比如 "0817"
```

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

（如果一定要公网直连，用 Cloudflare Tunnel 也可以；无论哪种方式，`accessCode` 都要设置。）

## 跟大纲学（BC 省数学大纲）

不止「来一题讲一题」——首页的「**跟大纲学**」tab 按加拿大 BC 省官方数学大纲（June 2016）系统教学：

- 选年级（**Grade 4-7** 数据已内置）→ 看到这学期五大主线的全部知识点，
  中英双语对照（英文是官方原文，中文标题给孩子和家长看）。
- 点任一条，圆圆老师按该知识点开讲：生活例子引入 → 核心方法配图 → 1-2 个例题 → 口诀小结，
  中文课里自然带出英文术语（"小数，英文课上叫 decimal"），孩子在学校听英文课能对上号。
- 课末练习按「答对了 ✓ / 还不会 ✗」自报对错，进度记在 `progress.json`：
  灰点=还没学，蓝点=讲过，绿点=**扎实**（不同日期答对 ≥2 次）。重启服务进度不丢。
- 大纲数据是构建期生成的静态 JSON（`data/curriculum/bc/`），运行期只读、离线可用；
  重新抓取/校对用 `node tools/curriculum/parse_bc.mjs --grade 4`（已有中文层会自动保留）。
- 右上角 📊 是**家长报告**：按主线汇总（"本学期 18 条内容，已讲 X 条，扎实 Y 条"），
  每条用 BC 学校成绩单同款四级话术（Emerging 起步 / Developing 发展中 / Proficient 扎实 /
  Extending 拓展），配每主线 Big Idea 的双语解释，可直接打印拿去和老师面谈。
- **FSA 模拟练习**（G4 / G7，🎯 按钮在「跟大纲学」里）：FSA 是 BC 4、7 年级秋季全省数学
  素养测评。圆圆老师现场出一卷 6 道 FSA 风格的原创多步骤情境选择题（干扰项都来自真实
  常见错误），计时作答；交卷看成绩和逐题解析，每题对错自动记入学习进度，错题一键转成
  该知识点的完整讲解课。想练英文读题（考场是英文），把界面切到 EN 再出卷即可。
- **生成一次，永久复用**：出过的 FSA 卷保存在 `fsa-sets.json`，「跟大纲学」里的
  「已出过的卷子」列表点开直接做、可反复做、记每次成绩（🎯 才是出新卷）；讲过的
  知识点再点直接**重播上次那节课**（秒开、语音已缓存、不花引擎），行上的 🔄 才会
  重新生成一节新课。

数据来源：BC 官网 [curriculum.gov.bc.ca](https://curriculum.gov.bc.ca/curriculum/mathematics/4/core)，
条目原文逐字保留并在页面标注来源（BC Curriculum · June 2016）。

## 历史记录

每讲完一道题，服务器会自动把整节课记到 `history.json`（最多 500 条，滚动淘汰）。
网页右上角 📖 打开历史面板：可以按题目/答案搜索、点一条**原样重播**（不再请求 AI，
语音命中 `tts-cache` 的话直接秒开）、也可以逐条删除。拍照题不保存照片本身，只记一个 📷 标志。
记录跟着服务器走——孩子在平板上讲过的题，家长在电脑上打开同一地址就能翻到。

## 说明

- 中英文：**默认英文界面**（主要面向在英文学校上学的孩子），右上角「EN / 中」一键切换，
  界面、例题、讲解语言、语音全套跟着换；设置里也能改。设备上保存过的语言选择优先于默认值。
- 语音朗读：配置了 CosyVoice 就用自然音色（见上），否则用孩子设备浏览器自带的语音（免费、不走服务器；
  Edge 浏览器的"Natural"在线音色效果最好，会自动优先选用）。
- 图形（分数条、数轴、面积格子、线段图）是程序画的，永远不会画错；AI 只负责选图和填数字。
- AI 讲题偶尔会算错。最终答案会单独醒目显示，建议家长顺手核对。
