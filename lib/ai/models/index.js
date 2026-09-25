/*
 * 模型层：引擎探测、7 个适配器、按任务选路、用量账本、runEngine。#22，#19 Phase 1 第三刀（Phase 8 的地基）。
 *
 * 代码从 server.js 原样搬来，一个字没改，只是包进 create(deps) 里：
 *   cfg            运行配置（provider / providerByTask / ollama / claude / anthropic / openai）
 *   L              (lang, zh, en) 双语取值
 *   JSON_HINT      默认的 JSON 格式说明（讲课用）
 *   LESSON_SCHEMA  默认 schema（讲课用）
 *   DATA_ROOT      账本 usage.jsonl 落在哪
 * 返回的 detected 是一个会被 detectProviders 原地修改的对象，server.js 把同一引用导出给 tools。
 *
 * 下一步（Phase 8）：按能力（fast / reasoning / vision / local）而不是按厂商选路，加回放 Provider 给测试用。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { extractJson } = require("./json.js");

function create(deps) {
  const { cfg, L, JSON_HINT, LESSON_SCHEMA, DATA_ROOT } = deps;

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
    // 名字在外层：先把所有目录扫一遍 .exe，再退而求其次找 .cmd 垫片。
    // （claude 既有 ~/.local/bin/claude.exe 又有 npm 的 claude.cmd，要的是前者）
    for (const n of names) for (const d of dirs) {
      const p = path.join(d, n);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return resolveShim(p); } catch (_) {}
    }
    return null;
  }

  /* Windows：npm 装的全局 CLI 是个 .cmd 垫片，Node 18 起不让直接 spawn（EINVAL），
   * 而改走 cmd.exe 又会被几 KB 带换行的提示词噎死（命令行 8191 字符上限 + 换行截断）。
   * 垫片正文里就写着真正的目标（.exe 或 .js），读出来直接用，绕开整个 cmd.exe。 */
  function resolveShim(p) {
    if (!/\.(cmd|bat)$/i.test(p)) return p;
    let txt = "";
    try { txt = fs.readFileSync(p, "utf8"); } catch (_) { return p; }
    const dir = path.dirname(p);
    for (const m of txt.matchAll(/"([^"\r\n]*?\.(?:exe|js))"/gi)) {
      const target = m[1].replace(/%~?dp0%?/gi, dir + path.sep);
      const abs = path.normalize(path.isAbsolute(target) ? target : path.join(dir, target));
      try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; } catch (_) {}
    }
    return p;   // 没读懂就原样交出去，让 runCmd 的报错去解释
  }

  function runCmd(bin, args, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      // 垫片解析出来的目标可能是个 .js（有的 CLI 没打包成 exe），那就用当前 node 跑它
      const isJs = /\.(js|mjs|cjs)$/i.test(bin);
      const child = spawn(isJs ? process.execPath : bin, isJs ? [bin].concat(args) : args, {
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
      child.on("error", e => {
        clearTimeout(timer);
        // EINVAL 基本就是在 Windows 上撞到了没解析开的 .cmd 垫片，直说比抛系统错有用
        const hint = e.code === "EINVAL" && process.platform === "win32"
          ? "（Windows 不能直接运行 " + path.basename(bin) + " 这种 .cmd 垫片，试试重装这个 CLI，或换一个引擎）" : "";
        reject(new Error("启动引擎失败：" + e.message + hint));
      });
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
    // YY_DEMO（Vercel 在线 demo）：不探测也不启用任何引擎。公开部署不该替访客
    // 花任何人的订阅/API 额度；也保证本地模拟（机器上装着真 CLI）和线上行为一致。
    if (process.env.YY_DEMO) return;
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
    ollama:    { label: "本地模型 (Ollama)", labelEn: "Local model (Ollama)",  supportsImage: true,  note: "免费·离线·第一次要预热", noteEn: "Free · offline · first run warms up" },
    grok:      { label: "Grok Build",        labelEn: "Grok Build",            supportsImage: false, note: "用你的 Grok 登录",        noteEn: "Uses your Grok login" },
    claude:    { label: "Claude Code",       labelEn: "Claude Code",           supportsImage: true,  note: "用你的 Claude 订阅",      noteEn: "Uses your Claude subscription" },
    gemini:    { label: "Gemini CLI",        labelEn: "Gemini CLI",            supportsImage: true,  note: "用你的 Google 登录",      noteEn: "Uses your Google login" },
    codex:     { label: "Codex (OpenAI)",    labelEn: "Codex (OpenAI)",        supportsImage: false, note: "用你的 OpenAI 登录",      noteEn: "Uses your OpenAI login" },
    anthropic: { label: "Anthropic API",     labelEn: "Anthropic API",         supportsImage: true,  note: "key 存在服务器 config.json", noteEn: "API key stored in server config.json" },
    openai:    { label: "OpenAI 兼容 API",   labelEn: "OpenAI-compatible API", supportsImage: true,  note: "OpenRouter / xAI 等",     noteEn: "OpenRouter / xAI etc." }
  };
  const AUTO_ORDER = ["claude", "grok", "gemini", "ollama", "codex", "anthropic", "openai"];

  /* 路由和用量账本共用同一套任务名：先在 /api/usage 看清每类任务真实花多少，
   * 再到 config.providerByTask 里决定谁干什么活（比如出题跑批给本地 Ollama，
   * 拍照问题留给 Claude）。写错的引擎名/任务名启动时吭一声，不悄悄吞。 */
  const TASKS = ["teach", "ask", "quiz", "unit", "fsa", "report",
    "pregen:teach", "pregen:quiz", "pregen:unit", "judge:teach", "judge:quiz", "judge:unit"];
  for (const [t, p] of Object.entries(cfg.providerByTask || {})) {
    if (!PROVIDER_META[p]) console.log(`[config] providerByTask.${t} = "${p}" 不是已知引擎（可选：${Object.keys(PROVIDER_META).join(" / ")}），忽略`);
    else if (!TASKS.includes(t)) console.log(`[config] providerByTask 里的任务名 "${t}" 不认识（可选：${TASKS.join(" / ")}），这条永远不会生效`);
  }

  /* 挑引擎：请求里明选的（家长 ⚙️）> 按任务路由（providerByTask）>
   * 全局默认（provider）> 自动顺序第一个可用的。路由指到的引擎当时不可用
   * （比如本地 Ollama 没开机）就照这个顺序往后落——孩子的课不能被路由表
   * 卡住；实际用了谁，账本里都看得见。 */
  function pickProvider(requested, task) {
    const wants = [
      requested && requested !== "auto" ? requested : null,
      task && cfg.providerByTask ? cfg.providerByTask[task] : null,
      cfg.provider !== "auto" ? cfg.provider : null
    ];
    for (const want of wants) if (want && detected[want] && detected[want].available) return want;
    for (const id of AUTO_ORDER) if (detected[id] && detected[id].available) return id;
    return null;
  }

  /* ---------------- 各引擎适配器 ----------------
   * opts.schema / opts.hint：默认讲课（LESSON_SCHEMA / JSON_HINT），
   * FSA 出卷等其他 JSON 任务传自己的进来，适配器逻辑不变。 */
  /* Ollama 默认不用 format（JSON-schema 语法约束解码）：2026-08-21 用 qwen3.8 跑批时发现，
   * 语法约束下中文字符串会被随机截断（say 在半句处收尾、一节课只剩 2 步），英文几乎不受影响。
   * 改成和 CLI 引擎一样：提示词里把 JSON 结构说清楚，输出再 extractJson + 校验，不过就重试。
   * config.ollama.structured=true 可以切回语法约束（给别的模型试）。 */
  async function genOllama(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const structured = cfg.ollama.structured === true;
    const hint = opts.hint || JSON_HINT[lang] || JSON_HINT.zh;
    const m = { role: "user", content: question };
    if (imageB64) m.images = [imageB64];
    const body = {
      model: detected.ollama.model,
      stream: false,
      messages: [{ role: "system", content: structured ? sys : sys + hint }, m],
      options: { num_predict: 32768 },   // 含思考 token：qwen3 出一批题光思考就要 1~1.5 万，留够余量别把 JSON 截断
      keep_alive: "30m"
    };
    if (structured) body.format = opts.schema || LESSON_SCHEMA;
    /* 思考开关：opts.think 优先于 config。2026-08-22 实测（qwen3.8，一批 12 道题）：
     *   关思考 → 2162 token / 19 秒，JSON 干净，但数学错误率高，审稿 74 次拒了 30 次；
     *   开思考 → 1~1.5 万 token / 1~2 分钟，数学明显更好（6 份样本里解析成功的全部过审）。
     * 结论：出题保持开思考，慢一点换对的题；格式毛病由 num_predict 留余量 + repairJson 兜。 */
    const wantThink = opts.think != null ? opts.think : cfg.ollama.think;
    if (wantThink === false) body.think = false;
    const r = await fetch(cfg.ollama.url + "/api/chat", {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(600000)
    });
    if (!r.ok) throw new Error("Ollama 出错：" + (await r.text()).slice(0, 200));
    const d = await r.json();
    if (opts.meta) { opts.meta.tokensIn = d.prompt_eval_count; opts.meta.tokensOut = d.eval_count; }
    // 思考型模型没被 Ollama 拆开 thinking 时，<think> 块里也会出现花括号，先剥掉
    const content = String((d.message && d.message.content) || "").replace(/<think>[\s\S]*?<\/think>/g, "");
    return extractJson(content);
  }

  async function genGrok(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const dir = tmpWorkdir();
    try {
      const pf = path.join(dir, "prompt.txt");
      fs.writeFileSync(pf, sys + "\n\n" + L(lang, "题目：", "Problem: ") + question, "utf8");
      const out = await runCmd(detected.grok.bin, [
        "--prompt-file", pf,
        "--json-schema", JSON.stringify(opts.schema || LESSON_SCHEMA),
        "--max-turns", "1", "--no-subagents", "--disable-web-search", "--no-memory", "--no-plan"
      ], { cwd: dir, timeout: 300000 });
      const env = JSON.parse(out.slice(out.indexOf("{")));
      const gu = env.usage || {};
      if (opts.meta && (gu.input_tokens || gu.prompt_tokens)) {
        opts.meta.tokensIn = gu.input_tokens || gu.prompt_tokens;
        opts.meta.tokensOut = gu.output_tokens || gu.completion_tokens || 0;
      }
      if (env.structuredOutput) return env.structuredOutput;
      return extractJson(env.result || out);
    } finally { cleanup(dir); }
  }

  async function genClaude(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const dir = tmpWorkdir();
    try {
      const hint = opts.hint || JSON_HINT[lang] || JSON_HINT.zh;
      let prompt = sys + hint + "\n\n" + L(lang, "题目：", "Problem: ") + question;
      if (imageB64) {
        const ext = /png/.test(mediaType || "") ? "png" : "jpg";
        fs.writeFileSync(path.join(dir, "question." + ext), Buffer.from(imageB64, "base64"));
        prompt = sys + hint + "\n\n" +
          L(lang, "题目在当前目录的图片 question." + ext + " 里，请先查看图片。",
                  "The problem is in the image question." + ext + " in the current directory. Look at the image first.") +
          (question ? "\n" + L(lang, "补充说明：", "Additional note: ") + question : "");
      }
      const args = ["-p", prompt, "--output-format", "json"];
      const cc = cfg.claude || {};
      if (cc.model) args.push("--model", String(cc.model));
      if (cc.effort && /^(low|medium|high|xhigh|max)$/.test(cc.effort)) args.push("--effort", String(cc.effort));
      /* 600 秒：effort high 出一批 12 道题通常 1-3 分钟，但个别知识点（多位小数竖式、
       * 分数小数百分数混合排序）会想 5 分钟以上，300 秒时跑全量 444 份有 3 份反复超时。 */
      /* config.claude.timeoutMs 可临时调高：个别技能（如分数混合运算 zh）12 题一批要想 10 分钟以上。 */
      const out = await runCmd(detected.claude.bin, args, { cwd: dir, timeout: Number(cc.timeoutMs) || 600000 });
      const env = JSON.parse(out.slice(out.indexOf("{")));
      if (opts.meta && env.usage) {   // claude CLI 的 JSON 信封自带用量和美元花费，白给的账不记白不记
        const u = env.usage;
        opts.meta.tokensIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        opts.meta.tokensOut = u.output_tokens || 0;
        if (env.total_cost_usd != null) opts.meta.costUsd = env.total_cost_usd;
        const mm = Object.keys(env.modelUsage || {});
        if (mm.length) opts.meta.model = mm.join("+");
      }
      /* 解析不出 JSON 时把 CLI 的原话带上（限额、模型不可用、拒答……都藏在 result 里），否则只剩一句「找不到 JSON」没法排查 */
      try { return extractJson(env.result || out); }
      catch (e) { throw new Error(e.message + (env.is_error ? "（CLI 报错）" : "") + "：" + String(env.result || out).replace(/s+/g, " ").slice(0, 300)); }
    } finally { cleanup(dir); }
  }

  async function genGemini(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const dir = tmpWorkdir();
    try {
      const hint = opts.hint || JSON_HINT[lang] || JSON_HINT.zh;
      let prompt = sys + hint + "\n\n" + L(lang, "题目：", "Problem: ") + question;
      if (imageB64) {
        const ext = /png/.test(mediaType || "") ? "png" : "jpg";
        fs.writeFileSync(path.join(dir, "question." + ext), Buffer.from(imageB64, "base64"));
        prompt = sys + hint + "\n\n" +
          L(lang, "题目在图片 @question." + ext + " 里。", "The problem is in the image @question." + ext + ".") +
          (question ? "\n" + L(lang, "补充说明：", "Additional note: ") + question : "");
      }
      const out = await runCmd(detected.gemini.bin, ["-p", prompt], { cwd: dir, timeout: 300000 });
      return extractJson(out);
    } finally { cleanup(dir); }
  }

  async function genCodex(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const dir = tmpWorkdir();
    try {
      const out = await runCmd(detected.codex.bin,
        ["exec", "--skip-git-repo-check", sys + (opts.hint || JSON_HINT[lang] || JSON_HINT.zh) + "\n\n" + L(lang, "题目：", "Problem: ") + question],
        { cwd: dir, timeout: 300000 });
      return extractJson(out);
    } finally { cleanup(dir); }
  }

  async function genAnthropic(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const content = [];
    if (imageB64) content.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageB64 } });
    content.push({ type: "text", text: question || L(lang, "请讲解图片里的这道数学题。", "Please explain the math problem in the image.") });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.anthropic.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.anthropic.model || "claude-opus-5",
        max_tokens: 16000,
        system: sys,
        output_config: { effort: "medium", format: { type: "json_schema", schema: opts.schema || LESSON_SCHEMA } },
        messages: [{ role: "user", content }]
      }),
      signal: AbortSignal.timeout(300000)
    });
    if (!r.ok) throw new Error("Anthropic API 出错：" + (await r.text()).slice(0, 200));
    const d = await r.json();
    if (opts.meta && d.usage) {   // 拒答也先记账：token 已经花出去了
      opts.meta.tokensIn = d.usage.input_tokens; opts.meta.tokensOut = d.usage.output_tokens;
      if (d.model) opts.meta.model = d.model;
    }
    if (d.stop_reason === "refusal") throw new Error(L(lang, "这道题不方便讲，换一道数学题吧", "I'd rather not cover that one — try another math question!"));
    const tb = (d.content || []).find(b => b.type === "text");
    return extractJson(tb && tb.text);
  }

  async function genOpenAI(sys, question, imageB64, mediaType, lang, opts) {
    opts = opts || {};
    const userContent = imageB64
      ? [{ type: "image_url", image_url: { url: "data:" + (mediaType || "image/jpeg") + ";base64," + imageB64 } },
         { type: "text", text: question || L(lang, "请讲解图片里的这道数学题。", "Please explain the math problem in the image.") }]
      : question;
    const r = await fetch(cfg.openai.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + cfg.openai.apiKey },
      body: JSON.stringify({
        model: cfg.openai.model,
        messages: [{ role: "system", content: sys + (opts.hint || JSON_HINT[lang] || JSON_HINT.zh) }, { role: "user", content: userContent }],
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(300000)
    });
    if (!r.ok) throw new Error("API 出错：" + (await r.text()).slice(0, 200));
    const d = await r.json();
    if (opts.meta && d.usage) {
      opts.meta.tokensIn = d.usage.prompt_tokens; opts.meta.tokensOut = d.usage.completion_tokens;
      if (d.model) opts.meta.model = d.model;
    }
    return extractJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
  }

  const ADAPTERS = { ollama: genOllama, grok: genGrok, claude: genClaude, gemini: genGemini, codex: genCodex, anthropic: genAnthropic, openai: genOpenAI };

  /* ---------------- 用量账本（usage.jsonl） ----------------
   * 每笔引擎调用记一行 JSONL：任务、引擎、模型、耗时、token、花费——能拿到的都记，
   * 拿不到的字段省略（CLI 类引擎不一定报 token）。失败也记一行：token 已经花了，
   * 重试就是账上的两行，「一个任务试了几次才成」正是这本账要回答的问题。
   * pack / bank 命中同样记（零成本），随包内容替这台机器省了多少次调用一眼可见。
   * 账本落在 DATA_ROOT（升级不丢）；写不动（Vercel demo 的只读盘）绝不拦着上课。
   * 家长在 /api/usage 看汇总；构建期 pregen 走同一本账（任务名带 pregen: 前缀）。 */
  const LEDGER_FILE = path.join(DATA_ROOT, "usage.jsonl");
  function ledgerAdd(e) {
    try { fs.appendFileSync(LEDGER_FILE, JSON.stringify(Object.assign({ at: Date.now() }, e)) + "\n"); } catch (_) {}
  }
  function ledgerRead(since) {
    let raw = "";
    try { raw = fs.readFileSync(LEDGER_FILE, "utf8"); } catch (_) { return []; }
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (!since || r.at >= since) rows.push(r); } catch (_) {}   // 坏行跳过，账本不因一行坏而全废
    }
    return rows;
  }

  /* /api/usage 的汇总：和报告一个理念——全部确定性计算，一个数字都不猜 */
  function ledgerSummary(rows) {
    const zero = () => ({ calls: 0, failed: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0 });
    const acc = (b, r) => {
      b.calls++;
      if (r.ok === false) b.failed++;
      if (r.tokensIn) b.tokensIn += r.tokensIn;
      if (r.tokensOut) b.tokensOut += r.tokensOut;
      if (r.costUsd) b.costUsd += r.costUsd;
      if (r.ms) b.ms += r.ms;
    };
    const totals = Object.assign(zero(), { engineCalls: 0, freeHits: 0 });
    const byProvider = {}, byTask = {};
    for (const r of rows) {
      acc(totals, r);
      if (r.provider === "pack" || r.provider === "bank") totals.freeHits++; else totals.engineCalls++;
      const p = byProvider[r.provider] || (byProvider[r.provider] = zero());
      acc(p, r);
      if (r.model && !(p.models || (p.models = [])).includes(r.model)) p.models.push(r.model);
      acc(byTask[r.task || "?"] || (byTask[r.task || "?"] = zero()), r);
    }
    for (const b of [totals, ...Object.values(byProvider), ...Object.values(byTask)])
      b.costUsd = Math.round(b.costUsd * 10000) / 10000;   // 别把浮点尾巴写进报表
    return { totals, byProvider, byTask };
  }

  /* 引擎名 -> 当前模型名（适配器能从返回里读到更准的就用返回里的，见各 opts.meta） */
  function engineModel(id) {
    if (id === "ollama") return (detected.ollama && detected.ollama.model) || "";
    if (id === "anthropic") return cfg.anthropic.model || "";
    if (id === "openai") return cfg.openai.model || "";
    return "";   // CLI 们不一定报模型名
  }

  /* 所有要花钱的调用都从这里过：计时、记账。validate 也算在这一笔里——
   * 引擎答了但格式不合格照样是失败的一次尝试（token 白花了，账上要看得见）。 */
  async function runEngine(providerId, task, sys, question, imageB64, mediaType, lang, opts, validate) {
    const callOpts = Object.assign({}, opts, { meta: {} });   // meta 每笔独立，并发不串账
    const t0 = Date.now();
    let data, err = null;
    try {
      data = await ADAPTERS[providerId](sys, question, imageB64, mediaType, lang, callOpts);
      if (validate) data = validate(data);
    } catch (e) { err = e; }
    const m = callOpts.meta;
    const line = { task, provider: providerId, model: m.model || engineModel(providerId) || undefined, lang, ms: Date.now() - t0, ok: !err };
    if (m.tokensIn != null) line.tokensIn = m.tokensIn;
    if (m.tokensOut != null) line.tokensOut = m.tokensOut;
    if (m.costUsd != null) line.costUsd = Math.round(m.costUsd * 1e6) / 1e6;   // 落盘就修掉浮点尾巴
    if (err) line.err = String((err && err.message) || err).slice(0, 160);
    ledgerAdd(line);
    if (err) throw err;
    return data;
  }

  return {
    which, resolveShim, runCmd, tmpWorkdir, cleanup,
    detected, detectProviders, PROVIDER_META, AUTO_ORDER, TASKS, pickProvider,
    ADAPTERS, LEDGER_FILE, ledgerAdd, ledgerRead, ledgerSummary, engineModel, runEngine,
  };
}

module.exports = { create };
