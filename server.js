#!/usr/bin/env node
/*
 * 圆圆数学 · 本地桥梁服务器
 * 零依赖 Node.js (>=18)。托管前端页面，并把讲题请求转给你已装好的 AI 引擎：
 *   - Ollama 本地模型（免费，支持看图）
 *   - grok CLI（Grok Build，借用你的登录）
 *   - claude CLI（Claude Code，借用你的订阅）
 *   - gemini CLI（Google，免费额度大）
 *   - codex CLI（OpenAI）
 *   - Anthropic / OpenAI 兼容 API（key 写在 config.json，服务器端保存）
 * 启动：node server.js   （Windows 可双击 start.bat）
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

/* ---------------- 配置 ---------------- */
const ROOT = __dirname;
const DEFAULT_CONFIG = {
  port: 8434,
  accessCode: "",                 // 设置后，前端需输入同样的访问码才能用（部署到外网时强烈建议设置）
  provider: "auto",               // auto | ollama | grok | claude | gemini | codex | anthropic | openai
  ollama: { url: "http://localhost:11434", model: "", think: true },
  anthropic: { apiKey: "", model: "claude-opus-5" },
  openai: { baseUrl: "", apiKey: "", model: "" }   // OpenAI 兼容（OpenRouter / xAI API 等）
};
let cfg = DEFAULT_CONFIG;
try {
  const userCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  cfg = deepMerge(DEFAULT_CONFIG, userCfg);
} catch (_) { /* 没有 config.json 就用默认 */ }
if (process.env.PORT) cfg.port = Number(process.env.PORT);
if (process.env.ACCESS_CODE) cfg.accessCode = process.env.ACCESS_CODE;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], over[k]);
    } else out[k] = over[k];
  }
  return out;
}

/* ---------------- 课程 JSON Schema ---------------- */
const LESSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" },
    isMath: { type: "boolean" },
    steps: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          say: { type: "string" },
          math: { type: "string" },
          visual: {
            type: "object", additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["none", "fractionBar", "numberLine", "areaGrid", "barModel"] },
              nums: { type: "array", items: { type: "number" } },
              labels: { type: "array", items: { type: "string" } },
              caption: { type: "string" }
            }, required: ["type"]
          }
        }, required: ["say", "math", "visual"]
      }
    },
    answer: { type: "string" },
    practice: {
      type: "object", additionalProperties: false,
      properties: { question: { type: "string" }, answer: { type: "string" } },
      required: ["question", "answer"]
    }
  },
  required: ["title", "isMath", "steps", "answer", "practice"]
};

/* ---------------- 提示词 ---------------- */
function systemPrompt(grade, kidName) {
  const name = kidName ? `孩子的名字叫「${kidName}」，讲解时可以偶尔亲切地叫他/她的名字。` : "";
  return `你是「圆圆老师」，一位给${grade || "小学五年级"}孩子（约10-12岁）讲数学的小学老师，说地道、亲切的中文。${name}

你的任务：把一道数学题变成一段【一步一步、看得见、听得懂】的讲解，就像一节小视频课。

铁律：
1. 准确第一。动笔前把每一步算术都验算一遍，答案必须正确。这是给一个真实的孩子看的，算错比不讲更糟。
2. 一步只讲一个小意思，语气鼓励、口语化，多用生活里的例子（分披萨、分糖果、跑步、买东西）。
3. 先讲思路（为什么这么做），再讲步骤（怎么做），最后给答案。

输出字段说明：
- title：这节课的小标题（简短、友好）。
- isMath：是不是一道数学/数字题。如果不是，isMath=false，steps 里放一句温柔的话把孩子引导回数学，answer 和 practice 填占位即可。
- steps：讲解步骤，5～8 步最好。每步：
  - say：要【读出来】给孩子听的话。纯口语中文，不要 LaTeX、不要奇怪符号；数字和加减乘除直接用中文说（如"四分之三"、"乘以"）。
  - math：这一步屏幕上显示的算式，用 LaTeX（如 \\frac{3}{4}+\\frac{1}{6}）。不需要就填 ""。
  - visual：这一步配的图。type 取以下之一：
    · "none"：不配图。
    · "fractionBar"（分数条）：nums=[总份数, 涂色份数]。讲分数、通分好用。
    · "numberLine"（数轴）：nums=[最小值, 最大值, (可选)要标出的点]。讲比大小、加减、小数好用。
    · "areaGrid"（面积格子）：nums=[行数, 列数, (可选)涂色行数, (可选)涂色列数]。讲乘法、面积好用。
    · "barModel"（线段图）：labels=["甲","乙"...]，nums=[各数量...]。讲比多少、分配、倍数好用。
    图要和该步内容一致；用不上就 "none"。数字要小而直观（份数、行列不超过 12）。
- answer：最终答案，简短明确（如"11/12"或"40 平方厘米"），会醒目显示给家长核对。
- practice：一道同类型、换了数字的练习题（question + answer）。

只讲这一道题，用最好懂的方式。`;
}

const JSON_ONLY_HINT = `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。JSON 必须符合这个结构：
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|numberLine|areaGrid|barModel","nums":[数字...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`;

/* ---------------- 工具函数 ---------------- */
function extractJson(text) {
  if (!text) throw new Error("引擎没有返回内容");
  let t = String(text);
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) t = fenced[1];
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("返回内容里找不到 JSON");
  return JSON.parse(t.slice(s, e + 1));
}

function validateLesson(l) {
  if (!l || typeof l !== "object") throw new Error("讲解格式不对");
  if (!Array.isArray(l.steps) || l.steps.length === 0) throw new Error("讲解里没有步骤");
  l.title = String(l.title || "这道题");
  l.isMath = l.isMath !== false;
  l.answer = String(l.answer || "");
  l.steps = l.steps.slice(0, 12).map(s => ({
    say: String((s && s.say) || ""),
    math: String((s && s.math) || ""),
    visual: (s && s.visual && typeof s.visual === "object") ? {
      type: ["none", "fractionBar", "numberLine", "areaGrid", "barModel"].includes(s.visual.type) ? s.visual.type : "none",
      nums: Array.isArray(s.visual.nums) ? s.visual.nums.map(Number).filter(isFinite) : [],
      labels: Array.isArray(s.visual.labels) ? s.visual.labels.map(String) : [],
      caption: String(s.visual.caption || "")
    } : { type: "none", nums: [], labels: [], caption: "" }
  })).filter(s => s.say);
  if (l.steps.length === 0) throw new Error("讲解步骤是空的");
  if (!l.practice || typeof l.practice !== "object") l.practice = { question: "", answer: "" };
  l.practice = { question: String(l.practice.question || ""), answer: String(l.practice.answer || "") };
  return l;
}

function which(bin) {
  const isWin = process.platform === "win32";
  const names = isWin ? [bin + ".exe", bin + ".cmd", bin + ".bat", bin] : [bin];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // 常见的额外安装位置（不一定在服务进程的 PATH 里）
  const home = os.homedir();
  dirs.push(
    path.join(home, ".grok", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".codex", "bin"),
    path.join(home, "AppData", "Roaming", "npm"),
    "/usr/local/bin", "/opt/homebrew/bin"
  );
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

function runCmd(bin, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd || os.tmpdir(),
      env: process.env,
      windowsHide: true
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error("引擎超时了（超过 " + Math.round((opts.timeout || 300000) / 1000) + " 秒），再试一次或换个引擎"));
    }, opts.timeout || 300000);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(new Error("启动引擎失败：" + e.message)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new Error("引擎出错（退出码 " + code + "）：" + err.slice(0, 300)));
      else resolve(out);
    });
    if (opts.stdin) { child.stdin.write(opts.stdin); }
    child.stdin.end();
  });
}

function tmpWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yuanyuan-"));
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

/* ---------------- 引擎检测 ---------------- */
const detected = {}; // id -> {available, bin?, model?, note}
async function detectProviders() {
  // Ollama
  try {
    const r = await fetch(cfg.ollama.url + "/api/tags", { signal: AbortSignal.timeout(2500) });
    const d = await r.json();
    const models = (d.models || []);
    let model = cfg.ollama.model && models.some(m => m.name === cfg.ollama.model) ? cfg.ollama.model : "";
    if (!model && models.length) {
      // 优先选带视觉能力的本地大模型
      const vis = models.find(m => (m.details && m.details.parameter_size) && (m.capabilities || []).includes("vision"));
      model = (vis || models[0]).name;
    }
    detected.ollama = model ? { available: true, model } : { available: false };
  } catch (_) { detected.ollama = { available: false }; }
  // CLI 们
  for (const id of ["grok", "claude", "gemini", "codex"]) {
    const bin = which(id);
    detected[id] = bin ? { available: true, bin } : { available: false };
  }
  // API 们
  detected.anthropic = { available: !!cfg.anthropic.apiKey };
  detected.openai = { available: !!(cfg.openai.apiKey && cfg.openai.baseUrl && cfg.openai.model) };
}

const PROVIDER_META = {
  ollama:    { label: "本地模型 (Ollama)", supportsImage: true,  note: "免费·离线·第一次要预热" },
  grok:      { label: "Grok Build",        supportsImage: false, note: "用你的 Grok 登录" },
  claude:    { label: "Claude Code",       supportsImage: true,  note: "用你的 Claude 订阅" },
  gemini:    { label: "Gemini CLI",        supportsImage: true,  note: "用你的 Google 登录" },
  codex:     { label: "Codex (OpenAI)",    supportsImage: false, note: "用你的 OpenAI 登录" },
  anthropic: { label: "Anthropic API",     supportsImage: true,  note: "key 存在服务器 config.json" },
  openai:    { label: "OpenAI 兼容 API",   supportsImage: true,  note: "OpenRouter / xAI 等" }
};
const AUTO_ORDER = ["claude", "grok", "gemini", "ollama", "codex", "anthropic", "openai"];

function pickProvider(requested) {
  const want = requested && requested !== "auto" ? requested : (cfg.provider !== "auto" ? cfg.provider : null);
  if (want && detected[want] && detected[want].available) return want;
  for (const id of AUTO_ORDER) if (detected[id] && detected[id].available) return id;
  return null;
}

/* ---------------- 各引擎适配器 ---------------- */
async function genOllama(sys, question, imageB64) {
  const m = { role: "user", content: question };
  if (imageB64) m.images = [imageB64];
  const body = {
    model: detected.ollama.model,
    stream: false,
    messages: [{ role: "system", content: sys }, m],
    format: LESSON_SCHEMA,
    options: { num_predict: 8192 },
    keep_alive: "30m"
  };
  if (cfg.ollama.think === false) body.think = false;
  const r = await fetch(cfg.ollama.url + "/api/chat", {
    method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(600000)
  });
  if (!r.ok) throw new Error("Ollama 出错：" + (await r.text()).slice(0, 200));
  const d = await r.json();
  return extractJson(d.message && d.message.content);
}

async function genGrok(sys, question) {
  const dir = tmpWorkdir();
  try {
    const pf = path.join(dir, "prompt.txt");
    fs.writeFileSync(pf, sys + "\n\n题目：" + question, "utf8");
    const out = await runCmd(detected.grok.bin, [
      "--prompt-file", pf,
      "--json-schema", JSON.stringify(LESSON_SCHEMA),
      "--max-turns", "1", "--no-subagents", "--disable-web-search", "--no-memory", "--no-plan"
    ], { cwd: dir, timeout: 300000 });
    const env = JSON.parse(out.slice(out.indexOf("{")));
    if (env.structuredOutput) return env.structuredOutput;
    return extractJson(env.result || out);
  } finally { cleanup(dir); }
}

async function genClaude(sys, question, imageB64, mediaType) {
  const dir = tmpWorkdir();
  try {
    let prompt = sys + JSON_ONLY_HINT + "\n\n题目：" + question;
    if (imageB64) {
      const ext = /png/.test(mediaType || "") ? "png" : "jpg";
      fs.writeFileSync(path.join(dir, "question." + ext), Buffer.from(imageB64, "base64"));
      prompt = sys + JSON_ONLY_HINT + "\n\n题目在当前目录的图片 question." + ext + " 里，请先查看图片。" + (question ? "\n补充说明：" + question : "");
    }
    const out = await runCmd(detected.claude.bin, ["-p", prompt, "--output-format", "json"], { cwd: dir, timeout: 300000 });
    const env = JSON.parse(out.slice(out.indexOf("{")));
    return extractJson(env.result || out);
  } finally { cleanup(dir); }
}

async function genGemini(sys, question, imageB64, mediaType) {
  const dir = tmpWorkdir();
  try {
    let prompt = sys + JSON_ONLY_HINT + "\n\n题目：" + question;
    if (imageB64) {
      const ext = /png/.test(mediaType || "") ? "png" : "jpg";
      fs.writeFileSync(path.join(dir, "question." + ext), Buffer.from(imageB64, "base64"));
      prompt = sys + JSON_ONLY_HINT + "\n\n题目在图片 @question." + ext + " 里。" + (question ? "\n补充说明：" + question : "");
    }
    const out = await runCmd(detected.gemini.bin, ["-p", prompt], { cwd: dir, timeout: 300000 });
    return extractJson(out);
  } finally { cleanup(dir); }
}

async function genCodex(sys, question) {
  const dir = tmpWorkdir();
  try {
    const out = await runCmd(detected.codex.bin,
      ["exec", "--skip-git-repo-check", sys + JSON_ONLY_HINT + "\n\n题目：" + question],
      { cwd: dir, timeout: 300000 });
    return extractJson(out);
  } finally { cleanup(dir); }
}

async function genAnthropic(sys, question, imageB64, mediaType) {
  const content = [];
  if (imageB64) content.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageB64 } });
  content.push({ type: "text", text: question || "请讲解图片里的这道数学题。" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.anthropic.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: cfg.anthropic.model || "claude-opus-5",
      max_tokens: 16000,
      system: sys,
      output_config: { effort: "medium", format: { type: "json_schema", schema: LESSON_SCHEMA } },
      messages: [{ role: "user", content }]
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) throw new Error("Anthropic API 出错：" + (await r.text()).slice(0, 200));
  const d = await r.json();
  if (d.stop_reason === "refusal") throw new Error("这道题不方便讲，换一道数学题吧");
  const tb = (d.content || []).find(b => b.type === "text");
  return extractJson(tb && tb.text);
}

async function genOpenAI(sys, question, imageB64, mediaType) {
  const userContent = imageB64
    ? [{ type: "image_url", image_url: { url: "data:" + (mediaType || "image/jpeg") + ";base64," + imageB64 } },
       { type: "text", text: question || "请讲解图片里的这道数学题。" }]
    : question;
  const r = await fetch(cfg.openai.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + cfg.openai.apiKey },
    body: JSON.stringify({
      model: cfg.openai.model,
      messages: [{ role: "system", content: sys + JSON_ONLY_HINT }, { role: "user", content: userContent }],
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) throw new Error("API 出错：" + (await r.text()).slice(0, 200));
  const d = await r.json();
  return extractJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
}

const ADAPTERS = { ollama: genOllama, grok: genGrok, claude: genClaude, gemini: genGemini, codex: genCodex, anthropic: genAnthropic, openai: genOpenAI };

/* ---------------- HTTP 服务器 ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function authorized(req) {
  if (!cfg.accessCode) return true;
  return (req.headers["x-access-code"] || "") === String(cfg.accessCode);
}

async function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > (limit || 12 * 1024 * 1024)) { reject(new Error("请求太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    /* API */
    if (url.pathname === "/api/providers" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码", authRequired: true });
      await detectProviders();
      const list = Object.keys(PROVIDER_META).map(id => ({
        id, ...PROVIDER_META[id],
        available: !!(detected[id] && detected[id].available),
        model: detected[id] && detected[id].model || undefined
      }));
      return send(res, 200, { authRequired: !!cfg.accessCode, active: pickProvider(cfg.provider), providers: list });
    }

    if (url.pathname === "/api/lesson" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码", authRequired: true });
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const question = String(body.question || "").slice(0, 4000);
      const imageB64 = body.imageB64 || null;
      const mediaType = body.mediaType || "image/jpeg";
      if (!question && !imageB64) return send(res, 400, { error: "题目是空的" });

      const id = pickProvider(body.provider);
      if (!id) return send(res, 503, { error: "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。" });
      if (imageB64 && !PROVIDER_META[id].supportsImage) {
        return send(res, 400, { error: PROVIDER_META[id].label + " 暂不支持看图，请把题目打字输入，或在设置里换一个支持看图的引擎。" });
      }

      const sys = systemPrompt(body.grade, body.kidName);
      const t0 = Date.now();
      console.log(`[lesson] engine=${id} q="${question.slice(0, 40)}" image=${!!imageB64}`);
      let lesson;
      try {
        lesson = validateLesson(await ADAPTERS[id](sys, question, imageB64, mediaType));
      } catch (e1) {
        console.log(`[lesson] first try failed (${e1.message}), retrying once...`);
        lesson = validateLesson(await ADAPTERS[id](sys, question, imageB64, mediaType));
      }
      console.log(`[lesson] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${lesson.steps.length} steps`);
      return send(res, 200, { lesson, provider: id, ms: Date.now() - t0 });
    }

    /* 静态文件 */
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    p = path.normalize(p).replace(/^([.][.][\\/])+/, "");
    const file = path.join(ROOT, "public", p);
    if (!file.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("404"); }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: e.message || "服务器出了点小问题" });
  }
});

detectProviders().then(() => {
  server.listen(cfg.port, () => {
    const avail = Object.keys(PROVIDER_META).filter(id => detected[id] && detected[id].available);
    console.log("");
    console.log("  🧮 圆圆数学 已启动");
    console.log("  本机访问:   http://localhost:" + cfg.port);
    const nets = os.networkInterfaces();
    for (const n of Object.values(nets)) for (const a of n || []) {
      if (a.family === "IPv4" && !a.internal) console.log("  局域网访问: http://" + a.address + ":" + cfg.port);
    }
    console.log("  可用引擎:   " + (avail.length ? avail.map(id => PROVIDER_META[id].label + (detected[id].model ? "(" + detected[id].model + ")" : "")).join("、") : "（没检测到！请看 README）"));
    console.log("  默认引擎:   " + (pickProvider() ? PROVIDER_META[pickProvider()].label : "无"));
    if (!cfg.accessCode) console.log("  ⚠ 未设置访问码。部署到外网前请在 config.json 里设置 accessCode。");
    console.log("");
  });
});
