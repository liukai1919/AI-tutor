# 圆圆数学 🧮

给孩子的 AI 数学小老师：出一道题（打字或拍照），一步一步、配着图、用语音讲给孩子听，最后给答案核对 + 一道同类练习。

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
  "openai": { "baseUrl": "", "apiKey": "", "model": "" }   // OpenRouter/xAI 等 OpenAI 兼容服务
}
```

环境变量 `PORT`、`ACCESS_CODE` 可覆盖对应配置。

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

## 说明

- 语音朗读用的是孩子设备上浏览器自带的中文语音，免费、不走服务器。
- 图形（分数条、数轴、面积格子、线段图）是程序画的，永远不会画错；AI 只负责选图和填数字。
- AI 讲题偶尔会算错。最终答案会单独醒目显示，建议家长顺手核对。
