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
const crypto = require("crypto");
const { spawn } = require("child_process");

/* ---------------- 配置 ---------------- */
const ROOT = __dirname;
const DEFAULT_CONFIG = {
  port: 8434,
  accessCode: "",                 // 设置后，前端需输入同样的访问码才能用（部署到外网时强烈建议设置）
  provider: "auto",               // auto | ollama | grok | claude | gemini | codex | anthropic | openai
  ollama: { url: "http://localhost:11434", model: "", think: true },
  anthropic: { apiKey: "", model: "claude-opus-5" },
  openai: { baseUrl: "", apiKey: "", model: "" },  // OpenAI 兼容（OpenRouter / xAI API 等）
  tts: {
    // 自然语音（CosyVoice 2 等本地引擎）。url 和 command 都空 = 关闭，前端自动退回浏览器语音。
    // 推荐 url：tools/tts_server.py 常驻守护进程（模型不用反复加载，单步 2-9 秒），
    //   例 "http://localhost:9880"（守护进程跑在 WSL/本机都行，见 README）。
    // command 备选：每节课起一次 tools/tts_batch.py，{manifest} 会被替换成任务清单路径，
    //   例（Linux 同机）：["/home/you/miniconda3/envs/cosyvoice/bin/python","/path/ai-tutor/tools/tts_batch.py","{manifest}"]
    enabled: true,
    url: "",
    command: [],
    // zero_shot：跟参考音最像（默认）。instruct 理论上可控语气，但部分 CosyVoice
    // 版本会把指令当正文念出来（2026-08-12 实测中招），确认你那版没问题再换。
    mode: "zero_shot",
    speed: 1.0,
    repo: "", modelDir: "",       // 留空用 tts_batch.py 的默认（~/tts/CosyVoice）
    refAudio: "", refText: "", refLang: "zh",
    instruct: {
      zh: "用温柔亲切的语气，像小学老师给孩子讲课一样，语速稍慢。",
      en: "Speak warmly and gently, like a friendly elementary school teacher, at a slightly slow pace."
    },
    cacheDir: "tts-cache",
    maxCacheMB: 500,
    timeoutMs: 420000
  }
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
const VISUAL_TYPES = [
  "none", "fractionBar", "pie", "numberLine", "areaGrid", "barModel", "groups",
  "shapeRect", "shapeTriangle", "shapeCircle", "clock", "placeValue", "balance", "pieChart",
  "solidCuboid", "solidCube", "solidCylinder", "solidCone", "solidSphere", "netCuboid", "netCylinder",
  "statBar", "statLine", "average", "spinner", "balls",
  "stemLeaf", "stackedBar", "histogram", "coordGrid", "angle", "areaModel",
  "baseTen", "hundredthsGrid", "hundredChart", "dataTable", "probLine"
];
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
              type: { type: "string", enum: VISUAL_TYPES },
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
function systemPrompt(grade, kidName, lang) {
  if (lang === "en") return systemPromptEn(grade, kidName);
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
  - visual：这一步配的图。图是孩子理解的关键：只要能画，就配一张，至少一半的步骤应该有图。type 取以下之一：
    · "none"：实在没有合适的图才用。
    · "fractionBar"（分数条）：nums=[总份数, 涂色份数]。比较或通分时给两条：nums=[份数1, 涂色1, 份数2, 涂色2]，会画成两条对齐的分数条。
    · "pie"（分数圆，像切披萨）：nums=[总份数, 涂色份数]；也可以给两个圆比较：[份数1, 涂色1, 份数2, 涂色2]。讲"几分之几"的意义最直观。
    · "numberLine"（数轴）：nums=[最小值, 最大值, 标记点, (可选)第二个点]。给两个点会画出从第一个点跳到第二个点的箭头，讲加减、比大小、小数好用。
    · "areaGrid"（面积格子）：nums=[行数, 列数, 涂色行数, 涂色列数]。行和列都只涂一部分时会突出重叠区域，讲分数乘分数、乘法意义好用。
    · "barModel"（线段图）：labels=["甲","乙"...]，nums=[各数量...]。讲比多少、分配、倍数好用。
    · "groups"（分组圆点图）：nums=[组数, 每组个数, (可选)剩余个数]。讲乘法意义、平均分、有余数的除法好用。
    · "shapeRect"（长方形/正方形）：nums=[长, 宽]，labels=["单位"]（如 ["厘米"]）。边长会标在图上，讲周长、面积必配；数值多大都行。
    · "shapeTriangle"（三角形）：nums=[底, 高]，labels=["单位"]。会用虚线画出高。
    · "shapeCircle"（圆）：nums=[半径]，labels=["单位"]。会画出半径并标注。
    · "clock"（钟面）：nums=[时, 分]；算经过时间给两个钟：[时1, 分1, 时2, 分2]，中间会标出经过的时间。
    · "placeValue"（数位表）：nums=[一个数]（如 [0.25] 或 [3407]）。讲数位、小数的意义好用。
    · "balance"（天平）：labels=["左边", "右边"]（如 ["x + 3", "10"]），nums=[0] 平衡 / [1] 左边重 / [-1] 右边重。讲方程、等式两边好用。
    · "pieChart"（扇形统计图）：nums=[各部分数值...]，labels=[各部分名称...]，最多 6 份。讲百分数、统计好用。
    · "solidCuboid"（长方体）：nums=[长, 宽, 高]，labels=["单位"]。立体图，看不见的棱画虚线，三条棱标尺寸。讲长方体的认识、表面积、体积必配。
    · "solidCube"（正方体）：nums=[棱长]，labels=["单位"]。
    · "solidCylinder"（圆柱）：nums=[底面半径, 高]，labels=["单位"]。会标出底面半径和高。
    · "solidCone"（圆锥）：nums=[底面半径, 高]，labels=["单位"]。虚线画出高，讲圆锥体积好用。
    · "solidSphere"（球）：nums=[半径]，labels=["单位"]。
    · "netCuboid"（长方体/正方体的展开图）：nums=[长, 宽, 高]（正方体三个数相等）。相对的面涂同色，讲表面积特别好。
    · "netCylinder"（圆柱的展开图）：nums=[底面半径, 高]。侧面展开成长方形，标出"底面周长"，讲侧面积、表面积好用。
    · "statBar"（条形统计图）：labels=[类别...]，nums=[各数值...]（最多 8 类），带纵轴刻度。画复式条形图就给 2×类别数 个数值（前一半是甲、后一半是乙），并在 labels 末尾追加两项作为甲、乙的名称。
    · "statLine"（折线统计图）：labels=[时间/类别...]，nums=[各数值...]。讲变化趋势必配；复式折线图的给法和 statBar 一样。
    · "average"（平均数图）：labels=[名称...]，nums=[各数值...]。会画出红色平均线，高出平均的部分变绿、不足的画虚线框。讲"移多补少"求平均数必配。
    · "spinner"（可能性转盘）：nums=[各颜色占的份数...]（总份数不超过 12），labels=[各部分名称...]。讲可能性大小、游戏公平不公平必配。
    · "balls"（摸球）：nums=[各种颜色球的个数...]（总数不超过 20），labels=["红球","白球"...]。讲摸球的可能性好用。
    · "stemLeaf"（茎叶图）：nums=[一组 0～99 的数据...]（最多 16 个）。自动按十位分茎、个位作叶并排好序。
    · "stackedBar"（堆叠条形图）：给法和复式 statBar 一样（2×类别数 个数值，labels 末尾追加两个系列名），两段叠在同一根条上。
    · "histogram"（直方图）：labels=[区间...]（如 ["0-9","10-19"]），nums=[各区间的频数...]。条与条相连，讲连续数据的分布。
    · "coordGrid"（坐标格）：nums=[x1, y1, x2, y2, ...]（最多 6 个点，整数，-12～12）。有负数自动画四个象限，否则画第一象限；labels=[各点名称...]（可选）。讲坐标、平移必配。
    · "angle"（角）：nums=[度数]（1～360）。画出两条边、弧线和度数，90° 画直角记号。讲锐角/直角/钝角、量角器必配。
    · "areaModel"（乘法面积模型）：nums=[因数1, 因数2]（两位数以内）。自动按数位拆开（如 23×15 拆成 20+3 和 10+5），每格标出部分积。讲两位数乘法必配。
    · "baseTen"（十进制积木）：nums=[一个整数]（1～999）。画出百格板、十条、个块。讲数的组成、进位退位好用。
    · "hundredthsGrid"（百格图）：nums=[涂色格数, (可选)第二种颜色格数]（合计 ≤100）。10×10 的一百个格子，讲百分数、0.01 的意义必配。
    · "hundredChart"（百数表）：nums=[要圈出的数...]（1～100，最多 16 个）。讲倍数、质数、跳着数好用。
    · "dataTable"（数据表）：labels=[列标题...]，nums=[各数值...]。一行数值就是频数表；两行数值（给法同复式 statBar）可以做比率表、找规律的表。
    · "probLine"（可能性线）：nums=[各事件的可能性 0~1...]（最多 4 个），labels=[事件名...]。把事件标在"不可能→一定"的线上。
    图要和该步内容一致。份数、行列、组数不超过 12；图形类（shape…/solid…/net…/clock/placeValue/pieChart/统计图）用题目里的真实数值。
- answer：最终答案，简短明确（如"11/12"或"40 平方厘米"），会醒目显示给家长核对。
- practice：一道同类型、换了数字的练习题（question + answer）。

只讲这一道题，用最好懂的方式。`;
}

function systemPromptEn(grade, kidName) {
  const name = kidName ? `The child's name is "${kidName}" — feel free to address them by name warmly now and then.` : "";
  return `You are "Ms. Yuanyuan", a kind elementary school teacher explaining math to a ${grade || "Grade 5"} child (about 10-12 years old), in natural, warm, everyday English. ${name}

Your task: turn one math problem into a step-by-step lesson the child can SEE and HEAR, like a little video class.

Iron rules:
1. Accuracy first. Re-check every bit of arithmetic before writing. The answer must be correct — a real child is watching, and getting it wrong is worse than not teaching at all.
2. One small idea per step. Encouraging, conversational tone; use everyday examples (sharing pizza, candies, running, shopping).
3. Explain the idea first (why), then the method (how), then give the answer.

Output fields:
- title: a short, friendly title for this lesson.
- isMath: whether this is a math/number question. If not, set isMath=false, put one gentle sentence in steps guiding the child back to math, and fill answer and practice with placeholders.
- steps: 5-8 steps is best. Each step:
  - say: the words to be READ ALOUD to the child. Plain spoken English — no LaTeX, no odd symbols; say numbers and operations in words (like "three quarters", "times").
  - math: the formula shown on screen for this step, in LaTeX (e.g. \\frac{3}{4}+\\frac{1}{6}). Use "" if not needed.
  - visual: the picture for this step. Pictures are how the child understands: add one whenever possible — at least half the steps should have one. type is one of:
    · "none": only when nothing fits.
    · "fractionBar": nums=[total parts, shaded parts]. For comparing or common denominators give two bars: nums=[parts1, shaded1, parts2, shaded2] — they are drawn aligned.
    · "pie" (fraction circle, like slicing a pizza): nums=[total parts, shaded parts]; or two circles to compare: [parts1, shaded1, parts2, shaded2]. The clearest way to show what a fraction means.
    · "numberLine": nums=[min, max, point, (optional) second point]. With two points an arrow shows the jump from the first to the second — great for adding/subtracting, comparing, decimals.
    · "areaGrid": nums=[rows, cols, shaded rows, shaded cols]. When both rows and cols are partial, the overlap is highlighted — great for fraction × fraction and the meaning of multiplication.
    · "barModel": labels=["A","B"...], nums=[amounts...]. Great for comparisons, sharing, multiples.
    · "groups" (groups of dots): nums=[groups, per group, (optional) left over]. Great for the meaning of multiplication, equal sharing, division with remainders.
    · "shapeRect" (rectangle/square): nums=[length, width], labels=["unit"] (e.g. ["cm"]). Side lengths are labeled on the picture — a must for perimeter/area; any size numbers are fine.
    · "shapeTriangle": nums=[base, height], labels=["unit"]. The height is drawn as a dashed line.
    · "shapeCircle": nums=[radius], labels=["unit"]. The radius is drawn and labeled.
    · "clock": nums=[hour, minute]; for elapsed time give two clocks: [h1, m1, h2, m2] — the elapsed time is labeled between them.
    · "placeValue": nums=[one number] (e.g. [0.25] or [3407]). Great for place value and decimal meaning.
    · "balance" (scale): labels=["left side", "right side"] (e.g. ["x + 3", "10"]), nums=[0] balanced / [1] left heavier / [-1] right heavier. Great for equations.
    · "pieChart": nums=[values...], labels=[names...], at most 6 slices. Great for percentages and statistics.
    · "solidCuboid" (rectangular prism / cuboid): nums=[length, width, height], labels=["unit"]. A 3D drawing — hidden edges dashed, three edges labeled. A must for cuboid recognition, surface area, volume.
    · "solidCube": nums=[edge length], labels=["unit"].
    · "solidCylinder": nums=[base radius, height], labels=["unit"]. Radius and height are labeled.
    · "solidCone": nums=[base radius, height], labels=["unit"]. The height is drawn dashed — great for cone volume.
    · "solidSphere": nums=[radius], labels=["unit"].
    · "netCuboid" (net of a cuboid/cube): nums=[length, width, height] (equal numbers for a cube). Opposite faces share a color — wonderful for surface area.
    · "netCylinder" (net of a cylinder): nums=[base radius, height]. The side unrolls into a rectangle labeled "base circumference" — great for lateral/surface area.
    · "statBar" (bar chart): labels=[categories...], nums=[values...] (at most 8), with a y-axis. For a double bar chart give 2×categories values (first half series A, second half series B) and append the two series names to labels.
    · "statLine" (line chart): labels=[times/categories...], nums=[values...]. A must for trends; double line charts work like statBar.
    · "average": labels=[names...], nums=[values...]. Draws a red dashed mean line; parts above the mean turn green, deficits get dashed outlines. A must for teaching averages (leveling off).
    · "spinner" (probability spinner): nums=[parts per color...] (total at most 12), labels=[names...]. A must for likelihood and fairness.
    · "balls" (drawing balls): nums=[balls per color...] (at most 20 total), labels=["red","white"...]. Great for probability with drawing from a box.
    · "stemLeaf" (stem-and-leaf plot): nums=[data values 0-99...] (at most 16). Automatically split into tens (stem) and ones (leaf), sorted.
    · "stackedBar": same input as a double statBar (2×categories values, two series names appended to labels) — the two parts stack on one bar.
    · "histogram": labels=[intervals...] (e.g. ["0-9","10-19"]), nums=[frequencies...]. Bars touch — for distributions of continuous data.
    · "coordGrid" (coordinate grid): nums=[x1, y1, x2, y2, ...] (up to 6 points, integers -12..12). Negatives draw all four quadrants, otherwise the first quadrant; labels=[point names...] (optional). A must for coordinates and translations.
    · "angle": nums=[degrees] (1-360). Draws the two arms, arc, and degree label; 90° gets a right-angle mark. A must for acute/right/obtuse angles and protractor work.
    · "areaModel" (multiplication area model): nums=[factor1, factor2] (up to 2 digits). Automatically splits by place value (23×15 → 20+3 and 10+5) with each partial product labeled. A must for multi-digit multiplication.
    · "baseTen" (base ten blocks): nums=[a whole number] (1-999). Draws hundreds flats, tens rods, ones cubes. Great for place value and regrouping.
    · "hundredthsGrid": nums=[shaded cells, (optional) second-color cells] (≤100 total). A 10×10 grid of 100 cells — a must for percent and hundredths.
    · "hundredChart" (hundred chart): nums=[numbers to circle...] (1-100, at most 16). Great for multiples, primes, skip counting.
    · "dataTable": labels=[column headers...], nums=[values...]. One row of values = a frequency table; two rows (same input as double statBar) = ratio tables or pattern tables.
    · "probLine" (likelihood line): nums=[probabilities 0-1...] (up to 4 events), labels=[event names...]. Marks events on the impossible→certain line.
    The picture must match the step. Keep parts/rows/cols/groups at most 12 (shape…/solid…/net…/clock/placeValue/pieChart/stat charts use real values from the problem).
- answer: the final answer, short and clear (like "11/12" or "40 square centimeters") — shown prominently for parents to double-check.
- practice: one similar practice problem with different numbers (question + answer).

Teach just this one problem, in the easiest possible way.`;
}

const JSON_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。JSON 必须符合这个结构：
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|pie|numberLine|areaGrid|barModel|groups|shapeRect|shapeTriangle|shapeCircle|clock|placeValue|balance|pieChart|solidCuboid|solidCube|solidCylinder|solidCone|solidSphere|netCuboid|netCylinder|statBar|statLine|average|spinner|balls|stemLeaf|stackedBar|histogram|coordGrid|angle|areaModel|baseTen|hundredthsGrid|hundredChart|dataTable|probLine","nums":[数字...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. It must match this structure:
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|pie|numberLine|areaGrid|barModel|groups|shapeRect|shapeTriangle|shapeCircle|clock|placeValue|balance|pieChart|solidCuboid|solidCube|solidCylinder|solidCone|solidSphere|netCuboid|netCylinder|statBar|statLine|average|spinner|balls|stemLeaf|stackedBar|histogram|coordGrid|angle|areaModel|baseTen|hundredthsGrid|hundredChart|dataTable|probLine","nums":[numbers...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`
};

/* ---------------- 工具函数 ---------------- */
const L = (lang, zh, en) => lang === "en" ? en : zh;

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
      type: VISUAL_TYPES.includes(s.visual.type) ? s.visual.type : "none",
      nums: Array.isArray(s.visual.nums) ? s.visual.nums.map(Number).filter(isFinite).slice(0, 16) : [],
      labels: Array.isArray(s.visual.labels) ? s.visual.labels.map(String).slice(0, 10) : [],
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
  ollama:    { label: "本地模型 (Ollama)", labelEn: "Local model (Ollama)",  supportsImage: true,  note: "免费·离线·第一次要预热", noteEn: "Free · offline · first run warms up" },
  grok:      { label: "Grok Build",        labelEn: "Grok Build",            supportsImage: false, note: "用你的 Grok 登录",        noteEn: "Uses your Grok login" },
  claude:    { label: "Claude Code",       labelEn: "Claude Code",           supportsImage: true,  note: "用你的 Claude 订阅",      noteEn: "Uses your Claude subscription" },
  gemini:    { label: "Gemini CLI",        labelEn: "Gemini CLI",            supportsImage: true,  note: "用你的 Google 登录",      noteEn: "Uses your Google login" },
  codex:     { label: "Codex (OpenAI)",    labelEn: "Codex (OpenAI)",        supportsImage: false, note: "用你的 OpenAI 登录",      noteEn: "Uses your OpenAI login" },
  anthropic: { label: "Anthropic API",     labelEn: "Anthropic API",         supportsImage: true,  note: "key 存在服务器 config.json", noteEn: "API key stored in server config.json" },
  openai:    { label: "OpenAI 兼容 API",   labelEn: "OpenAI-compatible API", supportsImage: true,  note: "OpenRouter / xAI 等",     noteEn: "OpenRouter / xAI etc." }
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

async function genGrok(sys, question, imageB64, mediaType, lang) {
  const dir = tmpWorkdir();
  try {
    const pf = path.join(dir, "prompt.txt");
    fs.writeFileSync(pf, sys + "\n\n" + L(lang, "题目：", "Problem: ") + question, "utf8");
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

async function genClaude(sys, question, imageB64, mediaType, lang) {
  const dir = tmpWorkdir();
  try {
    const hint = JSON_HINT[lang] || JSON_HINT.zh;
    let prompt = sys + hint + "\n\n" + L(lang, "题目：", "Problem: ") + question;
    if (imageB64) {
      const ext = /png/.test(mediaType || "") ? "png" : "jpg";
      fs.writeFileSync(path.join(dir, "question." + ext), Buffer.from(imageB64, "base64"));
      prompt = sys + hint + "\n\n" +
        L(lang, "题目在当前目录的图片 question." + ext + " 里，请先查看图片。",
                "The problem is in the image question." + ext + " in the current directory. Look at the image first.") +
        (question ? "\n" + L(lang, "补充说明：", "Additional note: ") + question : "");
    }
    const out = await runCmd(detected.claude.bin, ["-p", prompt, "--output-format", "json"], { cwd: dir, timeout: 300000 });
    const env = JSON.parse(out.slice(out.indexOf("{")));
    return extractJson(env.result || out);
  } finally { cleanup(dir); }
}

async function genGemini(sys, question, imageB64, mediaType, lang) {
  const dir = tmpWorkdir();
  try {
    const hint = JSON_HINT[lang] || JSON_HINT.zh;
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

async function genCodex(sys, question, imageB64, mediaType, lang) {
  const dir = tmpWorkdir();
  try {
    const out = await runCmd(detected.codex.bin,
      ["exec", "--skip-git-repo-check", sys + (JSON_HINT[lang] || JSON_HINT.zh) + "\n\n" + L(lang, "题目：", "Problem: ") + question],
      { cwd: dir, timeout: 300000 });
    return extractJson(out);
  } finally { cleanup(dir); }
}

async function genAnthropic(sys, question, imageB64, mediaType, lang) {
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
      output_config: { effort: "medium", format: { type: "json_schema", schema: LESSON_SCHEMA } },
      messages: [{ role: "user", content }]
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) throw new Error("Anthropic API 出错：" + (await r.text()).slice(0, 200));
  const d = await r.json();
  if (d.stop_reason === "refusal") throw new Error(L(lang, "这道题不方便讲，换一道数学题吧", "I'd rather not cover that one — try another math question!"));
  const tb = (d.content || []).find(b => b.type === "text");
  return extractJson(tb && tb.text);
}

async function genOpenAI(sys, question, imageB64, mediaType, lang) {
  const userContent = imageB64
    ? [{ type: "image_url", image_url: { url: "data:" + (mediaType || "image/jpeg") + ";base64," + imageB64 } },
       { type: "text", text: question || L(lang, "请讲解图片里的这道数学题。", "Please explain the math problem in the image.") }]
    : question;
  const r = await fetch(cfg.openai.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + cfg.openai.apiKey },
    body: JSON.stringify({
      model: cfg.openai.model,
      messages: [{ role: "system", content: sys + (JSON_HINT[lang] || JSON_HINT.zh) }, { role: "user", content: userContent }],
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) throw new Error("API 出错：" + (await r.text()).slice(0, 200));
  const d = await r.json();
  return extractJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
}

const ADAPTERS = { ollama: genOllama, grok: genGrok, claude: genClaude, gemini: genGemini, codex: genCodex, anthropic: genAnthropic, openai: genOpenAI };

/* ---------------- 语音合成（CosyVoice 等本地 TTS，可选） ----------------
 * 思路来自 vediotube-videogen：config 声明一条本地命令，服务器只管「文本进、wav 出」。
 * 这里按整节课批量提交（tools/tts_batch.py 一次加载模型合成全部步骤），
 * 结果按内容哈希落盘缓存；文件出现 = 就绪。没配置或失败时前端自动退回浏览器语音。 */
const TTS_CACHE = path.join(ROOT, (cfg.tts && cfg.tts.cacheDir) || "tts-cache");
const TTS_FAIL_TTL = 5 * 60 * 1000;
const ttsInFlight = new Set();     // 已排队/正在合成的 id
const ttsFailed = new Map();       // id -> 失败时间（TTL 内不重试，前端走兜底）
let ttsChain = Promise.resolve();  // 单队列：同一时刻只跑一个合成进程，防止模型重复加载挤显存

function ttsAvailable() {
  const t = cfg.tts;
  if (!t || t.enabled === false) return false;
  if (t.url) return true;   // 守护进程模式；真实可达性在合成时体现，失败会走兜底
  if (!Array.isArray(t.command) || t.command.length < 2) return false;
  const bin = t.command[0];
  return path.isAbsolute(bin) ? fs.existsSync(bin) : !!which(bin);
}
function ttsUsesWsl() { return /(^|[\\/])wsl(\.exe)?$/i.test(String(cfg.tts.command[0] || "")); }
function toWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? "/mnt/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/") : p.replace(/\\/g, "/");
}
function ttsId(text, lang) {
  const t = cfg.tts;
  return crypto.createHash("sha1").update(JSON.stringify(
    [t.mode, t.refAudio, t.refText, (t.instruct || {})[lang] || "", t.speed, lang, text]
  )).digest("hex");
}
function ttsWavPath(id) { return path.join(TTS_CACHE, id + ".wav"); }

function ttsSubmit(items) {
  for (const it of items) ttsInFlight.add(it.id);
  ttsChain = ttsChain.then(() => ttsRunJob(items));
}

async function ttsRunJob(items) {
  const pend = items.filter(it => !fs.existsSync(ttsWavPath(it.id)));
  if (!pend.length) { for (const it of items) ttsInFlight.delete(it.id); return; }
  fs.mkdirSync(TTS_CACHE, { recursive: true });
  if (cfg.tts.url) return ttsRunJobDaemon(items, pend);
  const wsl = ttsUsesWsl();
  const manifest = {
    repo: cfg.tts.repo || null, modelDir: cfg.tts.modelDir || null,
    outDir: wsl ? toWslPath(TTS_CACHE) : TTS_CACHE,
    mode: cfg.tts.mode || "instruct",
    speed: cfg.tts.speed || 1.0,
    refAudio: cfg.tts.refAudio || null, refText: cfg.tts.refText || null,
    refLang: cfg.tts.refLang || "zh",
    instruct: cfg.tts.instruct || {},
    items: pend.map(it => ({ id: it.id, text: it.text, lang: it.lang }))
  };
  const mf = path.join(TTS_CACHE, "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".json");
  fs.writeFileSync(mf, JSON.stringify(manifest), "utf8");
  const argv = cfg.tts.command.map(a => a === "{manifest}" ? (wsl ? toWslPath(mf) : mf) : a);
  const t0 = Date.now();
  console.log(`[tts] 合成 ${pend.length} 条…`);
  try {
    await runCmd(argv[0], argv.slice(1), { timeout: cfg.tts.timeoutMs || 420000, cwd: ROOT });
  } catch (e) {
    console.log("[tts] " + e.message);
  } finally {
    try { fs.unlinkSync(mf); } catch (_) {}
    let ok = 0;
    for (const it of items) {
      ttsInFlight.delete(it.id);
      if (fs.existsSync(ttsWavPath(it.id))) ok++;
      else ttsFailed.set(it.id, Date.now());
    }
    console.log(`[tts] 完成 ${ok}/${items.length}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    ttsPruneCache();
  }
}

/* 守护进程模式：逐条 POST /synth，模型常驻所以每条只要几秒；
 * 连挂两条视为守护进程不在，剩下的直接判失败让前端走兜底 */
async function ttsRunJobDaemon(items, pend) {
  const base = cfg.tts.url.replace(/\/$/, "");
  const t0 = Date.now();
  console.log(`[tts] 守护进程合成 ${pend.length} 条…`);
  let consecFail = 0;
  for (const it of pend) {
    if (consecFail >= 2) break;
    try {
      const r = await fetch(base + "/synth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: it.text, lang: it.lang,
          mode: cfg.tts.mode || "instruct",
          speed: cfg.tts.speed || 1.0,
          instruct: cfg.tts.instruct || {},
          refAudio: cfg.tts.refAudio || null, refText: cfg.tts.refText || null,
          refLang: cfg.tts.refLang || "zh"
        }),
        signal: AbortSignal.timeout(180000)   // 首条可能撞上模型加载（daemon 侧会等）
      });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 120));
      const buf = Buffer.from(await r.arrayBuffer());
      const tmp = ttsWavPath(it.id) + ".tmp";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, ttsWavPath(it.id));
      consecFail = 0;
    } catch (e) {
      consecFail++;
      console.log(`[tts] ${it.id.slice(0, 8)} 失败: ${e.message}`);
    }
  }
  let ok = 0;
  for (const it of items) {
    ttsInFlight.delete(it.id);
    if (fs.existsSync(ttsWavPath(it.id))) ok++;
    else ttsFailed.set(it.id, Date.now());
  }
  console.log(`[tts] 完成 ${ok}/${items.length}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  ttsPruneCache();
}

function ttsPruneCache() {
  try {
    const max = ((cfg.tts && cfg.tts.maxCacheMB) || 500) * 1024 * 1024;
    const files = fs.readdirSync(TTS_CACHE).filter(f => f.endsWith(".wav")).map(f => {
      const p = path.join(TTS_CACHE, f); const st = fs.statSync(p);
      return { p, size: st.size, t: st.mtimeMs };
    });
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= max) return;
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= max) break;
      try { fs.unlinkSync(f.p); total -= f.size; } catch (_) {}
    }
  } catch (_) {}
}

/* 请求里的条目 -> {id,state,url}；没见过的顺手入队（幂等，前端轮询就是重复 POST） */
function ttsStates(reqItems, defLang) {
  const now = Date.now();
  const out = [], submit = [];
  for (const raw of (reqItems || []).slice(0, 24)) {
    const text = String((raw && raw.text) || "").trim().slice(0, 600);
    if (!text) continue;
    const lang = raw.lang === "en" || raw.lang === "zh" ? raw.lang : defLang;
    const id = ttsId(text, lang);
    let state;
    if (fs.existsSync(ttsWavPath(id))) state = "ready";
    else if (ttsInFlight.has(id)) state = "pending";
    else if (ttsFailed.has(id) && now - ttsFailed.get(id) < TTS_FAIL_TTL) state = "failed";
    else { state = "pending"; ttsFailed.delete(id); submit.push({ id, text, lang }); }
    out.push({ id, state, url: "/api/tts/audio/" + id + ".wav" });
  }
  if (submit.length) ttsSubmit(submit);
  return out;
}

/* ---------------- 历史记录 ----------------
 * 每讲完一道题自动存一条（含完整讲解 JSON），落盘 history.json。
 * 前端可以翻看、搜索、点开重播、删除。重播不再请求 AI；
 * 语音按文本哈希命中 tts-cache，大概率秒开。图片题不存图片本身（太大），只记个标志。 */
const HISTORY_FILE = path.join(ROOT, "history.json");
const HISTORY_MAX = 500;
let history = [];
try {
  const h = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  if (Array.isArray(h)) history = h;
} catch (_) { /* 还没有记录 */ }

function historySave() {
  try {
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(history), "utf8");
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) { console.log("[history] 保存失败：" + e.message); }
}

function historyAdd(rec) {
  rec.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  history.unshift(rec);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  historySave();
}

function historySummary(r) {
  return {
    id: r.id, time: r.time,
    title: (r.lesson && r.lesson.title) || "",
    question: String(r.question || "").slice(0, 140),
    answer: (r.lesson && r.lesson.answer) || "",
    isMath: !(r.lesson && r.lesson.isMath === false),
    hasImage: !!r.hasImage,
    lang: r.lang || "zh",
    provider: r.provider || ""
  };
}

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
      return send(res, 200, { authRequired: !!cfg.accessCode, active: pickProvider(cfg.provider), providers: list, tts: ttsAvailable() });
    }

    if (url.pathname === "/api/tts" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      if (!ttsAvailable()) return send(res, 200, { enabled: false, items: [] });
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8"));
      const defLang = body.lang === "en" ? "en" : "zh";
      return send(res, 200, { enabled: true, items: ttsStates(body.items, defLang) });
    }

    if (url.pathname.startsWith("/api/tts/audio/") && req.method === "GET") {
      const m = /^\/api\/tts\/audio\/([a-f0-9]{40})\.wav$/.exec(url.pathname);
      const p = m && ttsWavPath(m[1]);
      let st = null;
      try { st = p && fs.statSync(p); } catch (_) {}
      if (!st) { res.writeHead(404); return res.end(); }
      const head = { "content-type": "audio/wav", "accept-ranges": "bytes", "cache-control": "public, max-age=604800, immutable" };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (range && (range[1] || range[2])) {   // iPad/Safari 播放媒体要求支持 Range
        const start = range[1] ? parseInt(range[1], 10) : 0;
        const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { "content-range": "bytes */" + st.size }); return res.end(); }
        res.writeHead(206, Object.assign(head, { "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 }));
        return fs.createReadStream(p, { start, end }).pipe(res);
      }
      res.writeHead(200, Object.assign(head, { "content-length": st.size }));
      return fs.createReadStream(p).pipe(res);
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      return send(res, 200, { items: history.map(historySummary) });
    }

    const hm = /^\/api\/history\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (hm && (req.method === "GET" || req.method === "DELETE")) {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const i = history.findIndex(r => r.id === hm[1]);
      if (i < 0) return send(res, 404, { error: "记录不存在 / Not found" });
      if (req.method === "DELETE") {
        history.splice(i, 1);
        historySave();
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { record: history[i] });
    }

    if (url.pathname === "/api/lesson" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const question = String(body.question || "").slice(0, 4000);
      const imageB64 = body.imageB64 || null;
      const mediaType = body.mediaType || "image/jpeg";
      const lang = body.lang === "en" ? "en" : "zh";
      if (!question && !imageB64) return send(res, 400, { error: L(lang, "题目是空的", "The question is empty.") });

      const id = pickProvider(body.provider);
      if (!id) return send(res, 503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      if (imageB64 && !PROVIDER_META[id].supportsImage) {
        return send(res, 400, { error: L(lang,
          PROVIDER_META[id].label + " 暂不支持看图，请把题目打字输入，或在设置里换一个支持看图的引擎。",
          (PROVIDER_META[id].labelEn || id) + " can't read images yet. Type the question, or pick an engine that supports images in Settings.") });
      }

      const sys = systemPrompt(body.grade, body.kidName, lang);
      const t0 = Date.now();
      console.log(`[lesson] engine=${id} lang=${lang} q="${question.slice(0, 40)}" image=${!!imageB64}`);
      let lesson;
      try {
        lesson = validateLesson(await ADAPTERS[id](sys, question, imageB64, mediaType, lang));
      } catch (e1) {
        console.log(`[lesson] first try failed (${e1.message}), retrying once...`);
        lesson = validateLesson(await ADAPTERS[id](sys, question, imageB64, mediaType, lang));
      }
      console.log(`[lesson] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${lesson.steps.length} steps`);
      historyAdd({ time: Date.now(), question, hasImage: !!imageB64, lang, grade: String(body.grade || ""), provider: id, lesson });
      // 讲解生成好就立刻预合成语音（不等前端），孩子点开第一步时大概率已就绪
      if (ttsAvailable() && lesson.isMath !== false) {
        try { ttsStates(lesson.steps.map(s => ({ text: s.say, lang })), lang); } catch (_) {}
      }
      return send(res, 200, { lesson, provider: id, ms: Date.now() - t0, tts: ttsAvailable() });
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
    console.log("  自然语音:   " + (ttsAvailable()
      ? "已开启（" + (cfg.tts.url ? "守护进程 " + cfg.tts.url : "命令模式") + " · " + (cfg.tts.mode || "instruct") + " · 缓存 " + path.basename(TTS_CACHE) + "/）"
      : "未配置（用浏览器语音兜底，见 README 的「自然语音」一节）"));
    console.log("  历史记录:   " + history.length + " 条（history.json，上限 " + HISTORY_MAX + " 条）");
    if (!cfg.accessCode) console.log("  ⚠ 未设置访问码。部署到外网前请在 config.json 里设置 accessCode。");
    console.log("");
  });
});
