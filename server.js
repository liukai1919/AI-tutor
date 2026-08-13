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
/* G7 语气微调（FSA 备考前置）：七年级起称「数学老师」、年龄 12-13、口吻别低幼；G4-6 输出保持原样 */
function seniorTone(gradeNum) {
  if (!(Number(gradeNum) >= 7)) return { ageZh: "约10-12岁", personaZh: "小学老师", toneZh: "", ageEn: "about 10-12 years old", personaEn: "elementary school teacher", toneEn: "" };
  return {
    ageZh: "约12-13岁", personaZh: "数学老师",
    toneZh: "\n4. 孩子已经上七年级了：语气依旧亲切，但别低幼（不要「小朋友」腔），例子贴近大孩子的生活（运动、游戏、手机、零花钱、和朋友出门）。",
    ageEn: "about 12-13 years old", personaEn: "math teacher",
    toneEn: "\n4. The child is in Grade 7 — keep the warmth but don't sound babyish; use tween-appropriate examples (sports, games, phones, allowance, going out with friends)."
  };
}
function systemPrompt(grade, kidName, lang, gradeNum) {
  if (lang === "en") return systemPromptEn(grade, kidName, gradeNum);
  const st = seniorTone(gradeNum);
  const name = kidName ? `孩子的名字叫「${kidName}」，讲解时可以偶尔亲切地叫他/她的名字。` : "";
  return `你是「圆圆老师」，一位给${grade || "小学五年级"}孩子（${st.ageZh}）讲数学的${st.personaZh}，说地道、亲切的中文。${name}

你的任务：把一道数学题变成一段【一步一步、看得见、听得懂】的讲解，就像一节小视频课。

铁律：
1. 准确第一。动笔前把每一步算术都验算一遍，答案必须正确。这是给一个真实的孩子看的，算错比不讲更糟。
2. 一步只讲一个小意思，语气鼓励、口语化，多用生活里的例子（分披萨、分糖果、跑步、买东西）。
3. 先讲思路（为什么这么做），再讲步骤（怎么做），最后给答案。${st.toneZh}

${lessonFieldsZh()}
- answer：最终答案，简短明确（如"11/12"或"40 平方厘米"），会醒目显示给家长核对。
- practice：一道同类型、换了数字的练习题（question + answer）。

只讲这一道题，用最好懂的方式。`;
}

/* solve/teach 两种课共用的输出字段说明（含 visual 目录那一大段） */
function lessonFieldsZh() {
  return `输出字段说明：
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
    图要和该步内容一致。份数、行列、组数不超过 12；图形类（shape…/solid…/net…/clock/placeValue/pieChart/统计图）用题目里的真实数值。`;
}

function systemPromptEn(grade, kidName, gradeNum) {
  const st = seniorTone(gradeNum);
  const name = kidName ? `The child's name is "${kidName}" — feel free to address them by name warmly now and then.` : "";
  return `You are "Ms. Yuanyuan", a kind ${st.personaEn} explaining math to a ${grade || "Grade 5"} child (${st.ageEn}), in natural, warm, everyday English. ${name}

Your task: turn one math problem into a step-by-step lesson the child can SEE and HEAR, like a little video class.

Iron rules:
1. Accuracy first. Re-check every bit of arithmetic before writing. The answer must be correct — a real child is watching, and getting it wrong is worse than not teaching at all.
2. One small idea per step. Encouraging, conversational tone; use everyday examples (sharing pizza, candies, running, shopping).
3. Explain the idea first (why), then the method (how), then give the answer.${st.toneEn}

${lessonFieldsEn()}
- answer: the final answer, short and clear (like "11/12" or "40 square centimeters") — shown prominently for parents to double-check.
- practice: one similar practice problem with different numbers (question + answer).

Teach just this one problem, in the easiest possible way.`;
}

function lessonFieldsEn() {
  return `Output fields:
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
    The picture must match the step. Keep parts/rows/cols/groups at most 12 (shape…/solid…/net…/clock/placeValue/pieChart/stat charts use real values from the problem).`;
}

/* teach 模式：不讲一道题，讲一个 BC 大纲知识点（复用同一套 LESSON_SCHEMA 和 visual 目录） */
const GRADE_ZH = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九" };

/* 书籍条目的原书本节文本（构建期由 tools/books/extract_text.mjs 生成，OCR 有噪声）。
 * 讲课时作为参考喂给 AI：讲法、铺垫、例题类型跟着书走，但必须原创表述、例题换数字。
 * 文件不存在（如还没提取的书）时静默降级为无参考——行为回到只按条目描述讲。 */
const BOOK_TEXT_DIR = path.join(ROOT, "data", "curriculum", "books", "text");
const BOOK_TEXT_LIMIT = 10000;   // 字符截断：够放整节，本地小模型也吃得下
function bookSectionText(gradeData, item) {
  if (gradeData.type !== "book" || !gradeData.bookId) return "";
  try {
    const t = fs.readFileSync(path.join(BOOK_TEXT_DIR, gradeData.bookId, item.id + ".txt"), "utf8").trim();
    return t.length > BOOK_TEXT_LIMIT ? t.slice(0, BOOK_TEXT_LIMIT) + "\n…(truncated)" : t;
  } catch (_) { return ""; }
}
function systemPromptTeach(item, gradeData, kidName, lang) {
  if (lang === "en") return systemPromptTeachEn(item, gradeData, kidName);
  const g = gradeData.grade;
  const name = kidName ? `孩子的名字叫「${kidName}」，讲解时可以偶尔亲切地叫他/她的名字。` : "";
  const st = seniorTone(g);
  const strand = (gradeData.strandDefs || STRANDS).find(s => s[0] === item.strand);
  const bigIdea = (gradeData.bigIdeas || []).find(b => b.strand === item.strand) || {};
  const elabs = (item.elaborations || []).map(e => "  · " + (e.zh || e.en)).join("\n");
  const terms = itemTerms(item).map(t => `${t.zh} = ${t.en}`).join("、");
  const hints = item.teachHints ? `（这个知识点优先用这些图：${item.teachHints}）` : "";
  const isBook = gradeData.type === "book";
  const origin = isBook
    ? `知识点来自数学教材《${(gradeData.title || {}).zh || (gradeData.title || {}).en || gradeData.bookId}》（${(gradeData.source || {}).publisher || ""}）的「${strand ? strand[1] : item.strand}」：
- 小节标题（原书为英文）：${item.en}
- 中文说法：${item.zh}
- 这一章在学什么（Big Idea）：${bigIdea.zh || bigIdea.en || ""}`
    : `知识点来自加拿大 BC 省 Grade ${g} 数学大纲（${strand ? strand[1] : item.strand}主线）：
- 官方原文：${item.en}
- 中文说法：${item.zh}
- 这学期为什么学它（Big Idea）：${bigIdea.zh || bigIdea.en || ""}`;
  const style = isBook && gradeData.teachStyle ? `

这本书的讲课风格（务必保持）：${gradeData.teachStyle.zh || gradeData.teachStyle.en || ""}
注意：用自己的话原创讲解和例题，不要照搬原书文字。` : "";
  const refText = isBook ? bookSectionText(gradeData, item) : "";
  const ref = refText ? `

【原书本节内容】（英文；可能是 OCR 原文（有识别噪声、公式可能走样），也可能是按扫描页整理的内容提要）：
"""
${refText}
"""
参考用法：从中看清这一节教什么、按什么顺序铺垫、例题是什么类型，讲课跟着这个思路走；但讲解必须用你自己的中文表述和自己设计的例子，例题一律换新数字，不逐句翻译原文；文本里走样或存疑的算式，以你自己验算的正确结果为准。` : "";
  return `你是「圆圆老师」，一位给 BC ${GRADE_ZH[g] || g}年级孩子讲数学的${st.personaZh}，说地道、亲切的中文。${name}

这节课不是讲一道题，而是给孩子讲一个新知识点，像一节小视频课。
${origin}${elabs ? "\n- 包含子技能：\n" + elabs : ""}${terms ? "\n- 术语对照：" + terms : ""}${style}${ref}

铁律：
1. 准确第一。动笔前把每一步算术都验算一遍，答案必须正确。这是给一个真实的孩子看的，算错比不讲更糟。
2. 一步只讲一个小意思，语气鼓励、口语化，多用生活里的例子（分披萨、用加元买东西、量身高）。
3. 例题驱动，不空泛：每个概念都要落到具体的数字和例子上。${st.toneZh}

课的结构（仍然输出 5-8 步 steps）：
1. 用生活例子引出这个概念（为什么有它、它解决什么问题）
2. 讲清楚核心方法，配图${hints}
3. 带着孩子做 1-2 个由浅入深的小例题
4. 最后一步给一句小结或口诀
say 里自然提到英文关键术语一两次（比如「小数，英文课上叫 decimal」），孩子在学校听英文课能对上号，但不要堆砌英文。

${lessonFieldsZh()}
- answer：这节课的一句话要点或小口诀，简短好记，会醒目显示。
- practice：一道贴合这个知识点的练习题（question + answer），用孩子在 BC 的生活场景（加元、公制单位、本地的事物）。

只讲这一个知识点，用最好懂的方式。`;
}

function systemPromptTeachEn(item, gradeData, kidName) {
  const g = gradeData.grade;
  const st = seniorTone(g);
  const name = kidName ? `The child's name is "${kidName}" — feel free to address them by name warmly now and then.` : "";
  const bigIdea = (gradeData.bigIdeas || []).find(b => b.strand === item.strand) || {};
  const elabs = (item.elaborations || []).map(e => "  · " + e.en).join("\n");
  const hintTypes = (String(item.teachHints || "").match(/[A-Za-z]+/g) || []).join(", ");
  const hints = hintTypes ? ` (for this concept, prefer these visuals: ${hintTypes})` : "";
  const isBook = gradeData.type === "book";
  const strandDef = isBook ? (gradeData.strandDefs || []).find(s => s[0] === item.strand) : null;
  const origin = isBook
    ? `The concept comes from the math book "${(gradeData.title || {}).en || gradeData.bookId}" (${(gradeData.source || {}).publisher || ""}), ${strandDef ? strandDef[2] : item.strand}:
- Section: ${item.en}
- What this chapter is about (Big Idea): ${bigIdea.en || ""}`
    : `The concept comes from the British Columbia Grade ${g} Mathematics curriculum (${item.strand} strand):
- Official wording: ${item.en}
- Why it matters this term (Big Idea): ${bigIdea.en || ""}`;
  const style = isBook && gradeData.teachStyle ? `

This book's teaching style (keep it): ${gradeData.teachStyle.en || ""}
Note: create your own original explanation and examples — do not reproduce the book's text.` : "";
  const refText = isBook ? bookSectionText(gradeData, item) : "";
  const ref = refText ? `

[This section in the original book] (either raw OCR text — which may be noisy and garble formulas — or a digest written from the scanned pages):
"""
${refText}
"""
How to use it: see what this section teaches, how it builds up, and what kinds of worked examples it uses — follow that flow. But write your own original wording and design your own examples with fresh numbers; never copy sentences from the book. Where the text garbles the math, trust your own verified calculations.` : "";
  return `You are "Ms. Yuanyuan", a kind ${st.personaEn} explaining math to a BC Grade ${g} child, in natural, warm, everyday English. ${name}

This lesson is not about solving one problem — you are teaching the child a new concept, like a little video class.
${origin}${elabs ? "\n- Sub-skills included:\n" + elabs : ""}${style}${ref}

Iron rules:
1. Accuracy first. Re-check every bit of arithmetic before writing. The answer must be correct — a real child is watching, and getting it wrong is worse than not teaching at all.
2. One small idea per step. Encouraging, conversational tone; use everyday examples (sharing pizza, shopping with dollars, measuring heights).
3. Drive the lesson with worked examples — never stay abstract; always land on concrete numbers.${st.toneEn}

Lesson structure (still output 5-8 steps):
1. Open with a real-life example that shows why this concept exists and what problem it solves
2. Teach the core method clearly, with pictures${hints}
3. Walk the child through 1-2 worked examples, from easy to slightly harder
4. End with a one-line takeaway
Use BC-flavoured everyday contexts where natural (Canadian dollars, metric units, local life).

${lessonFieldsEn()}
- answer: the one-line takeaway of this lesson, short and memorable — shown prominently.
- practice: one practice problem matching this concept (question + answer), set in a BC everyday context (dollars, metric units).

Teach just this one concept, in the easiest possible way.`;
}

const JSON_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。JSON 必须符合这个结构：
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|pie|numberLine|areaGrid|barModel|groups|shapeRect|shapeTriangle|shapeCircle|clock|placeValue|balance|pieChart|solidCuboid|solidCube|solidCylinder|solidCone|solidSphere|netCuboid|netCylinder|statBar|statLine|average|spinner|balls|stemLeaf|stackedBar|histogram|coordGrid|angle|areaModel|baseTen|hundredthsGrid|hundredChart|dataTable|probLine","nums":[数字...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. It must match this structure:
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|pie|numberLine|areaGrid|barModel|groups|shapeRect|shapeTriangle|shapeCircle|clock|placeValue|balance|pieChart|solidCuboid|solidCube|solidCylinder|solidCone|solidSphere|netCuboid|netCylinder|statBar|statLine|average|spinner|balls|stemLeaf|stackedBar|histogram|coordGrid|angle|areaModel|baseTen|hundredthsGrid|hundredChart|dataTable|probLine","nums":[numbers...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`
};

/* ---------------- FSA 模拟卷（P4）----------------
 * FSA = BC 4/7 年级秋季全省数学素养测评。这里生成「FSA 风格」的原创多步骤情境选择题
 * （不复制官方题），每题挂一个大纲 curriculumId：答错可以直接转 teach 模式讲对应知识点。 */
const FSA_SET_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" },
    questions: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          curriculumId: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answerIndex: { type: "number" },
          explain: { type: "string" }
        }, required: ["curriculumId", "question", "options", "answerIndex", "explain"]
      }
    }
  }, required: ["title", "questions"]
};
const FSA_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。结构：
{"title":"...","questions":[{"curriculumId":"BC.MATH...","question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences:
{"title":"...","questions":[{"curriculumId":"BC.MATH...","question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`
};

function fsaPrompt(gradeData, strand, lang, count) {
  const g = gradeData.grade;
  const items = (gradeData.items || []).filter(it => !strand || it.strand === strand);
  const strandLabel = STRANDS.find(s => s[0] === strand);
  if (lang === "en") {
    const list = items.map(it => `${it.id} | ${it.en}`).join("\n");
    return `You are a BC math teacher writing a practice set for the Grade ${g} FSA (Foundation Skills Assessment). Create ${count} multiple-choice questions for a child practising at home on a tablet.

FSA-style iron rules:
1. Every question is a real-life scenario needing MULTIPLE steps (at least two steps of reasoning). Use the child's life in BC: shopping with dollars and making change, metric units, school events, parks and ferries, sports, rainy days…
2. Stay inside the curriculum: only test the topics listed below, and tag each question with the single best-matching curriculumId${strandLabel ? ` (this set covers only the "${strandLabel[2]}" strand)` : "; spread the set across different strands"}.
3. Exactly 4 options, exactly 1 correct. Distractors must come from real common mistakes (forgot to regroup, mixed up perimeter and area, skipped a unit conversion, mishandled the remainder) — never obviously wrong.
4. answerIndex is the index (0-3) of the correct option. Scatter the correct positions across the set.
5. Accuracy first: re-check every question so exactly one option is correct.
6. explain: one or two sentences on the correct method and the most common trap.
7. FSA difficulty: makes you think, but never tricky; numbers must be computable by hand.
8. title: a fun theme for the set (e.g., "A Rainy Day at the Vancouver Aquarium"); questions may follow the theme.

Topics (curriculumId | official wording):
${list}`;
  }
  const list = items.map(it => `${it.id} | ${it.en} | ${it.zh}`).join("\n");
  return `你是 BC 省的数学出题老师，为 Grade ${g} 的 FSA（Foundation Skills Assessment，全省基础技能测评）出一卷 ${count} 道选择题的模拟练习，孩子在家用平板作答。

FSA 风格铁律：
1. 每题都是生活情境题，需要【多步骤】推理（至少两步才能得出答案）。场景用孩子在 BC 的真实生活：加元购物找零、公制单位、学校活动、公园渡轮、体育比赛、雨天…
2. 不超纲：只考下面清单里的知识点，每题标注一个最贴合的 curriculumId${strandLabel ? `（本卷只考「${strandLabel[1]}」主线）` : "；整卷尽量覆盖不同主线"}。
3. 每题恰好 4 个选项、恰好 1 个正确。干扰项必须来自真实的常见错误（忘了进位、周长面积混淆、单位没换算、余数处理错），不要一眼假。
4. answerIndex 是正确选项的下标（0~3），整卷正确答案的位置要打散，别集中在同一个下标。
5. 准确第一：每题出完自己验算一遍，确认有且只有一个选项正确。
6. explain 用一两句话讲清正确算法，并点出最容易踩的坑。
7. 难度对齐 FSA：要动脑但不刁钻，数字口算/竖式能算动。
8. title 给这卷起个孩子喜欢的主题名（比如「雨天的温哥华水族馆」），题目可以围绕主题展开。
9. 题面用中文，关键数学术语可自然带一次英文（如「周长（perimeter）」）——孩子考场上见到英文术语能对上号。

知识点清单（curriculumId | 官方原文 | 中文）：
${list}`;
}

function validateFsaSet(set, gradeData, count) {
  if (!set || typeof set !== "object") throw new Error("出卷格式不对");
  const ids = new Set((gradeData.items || []).map(it => it.id));
  const qs = (Array.isArray(set.questions) ? set.questions : []).map(q => {
    if (!q || typeof q !== "object") return null;
    // answerIndex 指向 options 原数组，绝不能过滤/截断——下标一错位就把答对判成答错
    const options = Array.isArray(q.options) ? q.options.map(o => String(o == null ? "" : o).trim()) : [];
    const ai = Math.round(Number(q.answerIndex));
    if (!String(q.question || "").trim() || options.length !== 4 || options.some(o => !o) || !(ai >= 0 && ai <= 3)) return null;
    return {
      curriculumId: ids.has(q.curriculumId) ? q.curriculumId : "",   // 未知 ID 置空，前端就不给「转讲解」按钮
      question: String(q.question).trim(),
      options,
      answerIndex: ai,
      explain: String(q.explain || "").trim()
    };
  }).filter(Boolean);
  if (qs.length < Math.max(3, Math.ceil(count * 0.6))) throw new Error("这卷有效题目太少");
  return { title: String(set.title || "FSA"), questions: qs.slice(0, count) };
}

/* ---------------- 闯关练习题库（P5）----------------
 * 一个知识点一个题库，孩子看完课一道一道做题，SAT 式做对升难度，通关标 solid。
 * 难度定义、数量、判定规则都定在 docs/qbank-standard.md——改规则先改那里。 */
const QUIZ_PER_LEVEL_NEW = 4;     // 每级一次生成 4 道
const QUIZ_LEVEL_CAP = 12;        // 每级封顶（单知识点单语言最多 36 道），到顶按最久没做过复用
const QUIZ_SESSION_PER_LEVEL = 4; // 一次闯关每级最多带出 4 道
const QUIZ_MAX_QUESTIONS = 8;     // 8 题内没通关 = 本次不通关
const QUIZ_PASS_NEED = 2;         // 最高难度累计答对 2 题 = 通关
const QUIZ_TOP_LEVEL = 3;

const QBANK_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    questions: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          level: { type: "number" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answerIndex: { type: "number" },
          explain: { type: "string" }
        }, required: ["level", "question", "options", "answerIndex", "explain"]
      }
    }
  }, required: ["questions"]
};
const QBANK_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。结构：
{"questions":[{"level":1,"question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences:
{"questions":[{"level":1,"question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`
};

function qbankPrompt(item, gradeData, lang, needs, existingStems) {
  const g = gradeData.grade;
  const strand = (gradeData.strandDefs || STRANDS).find(s => s[0] === item.strand) || ["", item.strand, item.strand];
  const wants = [1, 2, 3].filter(lv => needs[lv]);
  const total = wants.reduce((s, lv) => s + needs[lv], 0);
  const avoid = (existingStems || []).slice(0, 30);
  const isBook = gradeData.type === "book";
  if (lang === "en") {
    const elab = (item.elaborations || []).map(e => "- " + e.en).join("\n");
    const terms = itemTerms(item).map(tm => tm.en).join(", ");
    const who = isBook
      ? `You are a math teacher building a question bank for ONE section of the book "${(gradeData.title || {}).en || gradeData.bookId}" (${strand[2]}), studied by a Grade ${g} child in BC, Canada.`
      : `You are a BC math teacher building a question bank for ONE Grade ${g} topic ("${strand[2]}" strand).`;
    return `${who} The child just watched a lesson on it and now answers questions one at a time — right answers raise the difficulty, like the SAT. Write ${total} original multiple-choice questions: ${wants.map(lv => `${needs[lv]} at Level ${lv}`).join(", ")}.

${isBook ? "The section" : "The topic (official wording)"}: ${item.en}${elab ? `
What it covers:
${elab}` : ""}${terms ? `
Key terms: ${terms}` : ""}

Difficulty levels:
- Level 1 (warm-up): one step, direct use of the concept just taught; short stem, no or minimal context. Checks "did you get it".
- Level 2 (level-up): standard textbook difficulty, 1-2 steps, a small real-life context or choosing the right method. Checks "can you use it".
- Level 3 (challenge): FSA-style — a real-life scenario needing at least two reasoning steps, or a question built around the most common misconception in this topic. Checks "is it solid".

Iron rules:
1. Test ONLY this topic. Earlier skills may appear naturally, but the point being tested must be this topic.
2. Exactly 4 options, exactly 1 correct. Distractors come from real common mistakes (forgot to regroup, mixed up perimeter and area, skipped a unit conversion, added denominators straight across) — never obviously wrong.
3. answerIndex is the index (0-3) of the correct option. Scatter correct positions across the batch.
4. Numbers must be computable by hand and age-appropriate; use dollars and metric units; scenes from a BC child's life.
5. Accuracy first: re-check every question so exactly one option is correct.
6. explain: one or two sentences — the correct method plus the most common trap. It is shown to the child right after a wrong answer, so write it to teach.
7. Every question must differ from the others in this batch${avoid.length ? ` AND from these existing bank questions:
${avoid.map(s => "- " + s).join("\n")}` : ""}.`;
  }
  const elab = (item.elaborations || []).map(e => "- " + (e.zh || e.en)).join("\n");
  const terms = itemTerms(item).map(tm => `${tm.en}=${tm.zh}`).join("、");
  const whoZh = isBook
    ? `你是数学出题老师，为教材《${(gradeData.title || {}).zh || (gradeData.title || {}).en || gradeData.bookId}》（${strand[1]}）里的一个小节建题库；孩子在加拿大 BC 上 Grade ${g}。`
    : `你是 BC 省的数学出题老师，为 Grade ${g}「${strand[1]}」主线里的一个知识点建题库。`;
  return `${whoZh}孩子刚看完这个知识点的讲解课，现在一道一道做题——做对了会升难度（类似 SAT 机制）。请出 ${total} 道原创选择题：${wants.map(lv => `L${lv} ${needs[lv]} 道`).join("、")}。

${isBook ? "小节（原书标题）" : "知识点（官方原文）"}：${item.en}
中文：${item.zh}${elab ? `
包含内容：
${elab}` : ""}${terms ? `
关键术语：${terms}` : ""}

难度定义：
- L1 热身：单步、直接套用刚学的概念；题干短，无情境或极简情境。检查「听懂了没」。
- L2 应用：标准课本难度，1-2 步，带简单生活情境或需要自己选方法。检查「会用了没」。
- L3 挑战：FSA 风格——需要至少两步推理的真实情境题，或针对这个知识点最常见误区的辨析题。检查「真扎实没」。

出题铁律：
1. 只考这个知识点。可以自然用到更早学过的技能，但考点必须落在本知识点上。
2. 每题恰好 4 个选项、恰好 1 个正确。干扰项必须来自真实常见错误（忘了进位、周长面积混淆、单位没换算、分母直接相加），不要一眼假。
3. answerIndex 是正确选项的下标（0~3），整批正确答案的位置要打散，别集中在同一个下标。
4. 数字口算/竖式能算动、适龄；货币用加元、单位用公制，情境用孩子在 BC 的真实生活。
5. 准确第一：每题出完自己验算一遍，确认有且只有一个选项正确。
6. explain 一两句话：正确解法 + 最容易踩的坑。孩子答错后马上会看到，要写得能教会人。
7. 题干用中文，关键数学术语可自然带一次英文对照（如「周长（perimeter）」）。
8. 这批题互相不能重复${avoid.length ? `，也不能和题库里已有的这些题重复：
${avoid.map(s => "- " + s).join("\n")}` : ""}。`;
}

function validateQbankBatch(raw, requested) {
  if (!raw || typeof raw !== "object") throw new Error("出题格式不对");
  const qs = (Array.isArray(raw.questions) ? raw.questions : []).map(q => {
    if (!q || typeof q !== "object") return null;
    // answerIndex 指向 options 原数组，绝不能过滤/截断（教训同 FSA：下标一错位就把答对判成答错）
    const options = Array.isArray(q.options) ? q.options.map(o => String(o == null ? "" : o).trim()) : [];
    const ai = Math.round(Number(q.answerIndex));
    const lv = Math.round(Number(q.level));
    if (!String(q.question || "").trim() || options.length !== 4 || options.some(o => !o)
      || !(ai >= 0 && ai <= 3) || !(lv >= 1 && lv <= QUIZ_TOP_LEVEL)) return null;
    return { level: lv, question: String(q.question).trim(), options, answerIndex: ai, explain: String(q.explain || "").trim() };
  }).filter(Boolean);
  if (qs.length < Math.max(3, Math.ceil(requested * 0.5))) throw new Error("有效题目太少");
  return qs;
}

/* ---------------- 工具函数 ---------------- */
const L = (lang, zh, en) => lang === "en" ? en : zh;
/* 请求里的 lang 归一：只认 "zh"，其余一律英文（面向英文学校的孩子） */
const normLang = l => l === "zh" ? "zh" : "en";

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

/* ---------------- 各引擎适配器 ----------------
 * opts.schema / opts.hint：默认讲课（LESSON_SCHEMA / JSON_HINT），
 * FSA 出卷等其他 JSON 任务传自己的进来，适配器逻辑不变。 */
async function genOllama(sys, question, imageB64, mediaType, lang, opts) {
  opts = opts || {};
  const m = { role: "user", content: question };
  if (imageB64) m.images = [imageB64];
  const body = {
    model: detected.ollama.model,
    stream: false,
    messages: [{ role: "system", content: sys }, m],
    format: opts.schema || LESSON_SCHEMA,
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
    const out = await runCmd(detected.claude.bin, ["-p", prompt, "--output-format", "json"], { cwd: dir, timeout: 300000 });
    const env = JSON.parse(out.slice(out.indexOf("{")));
    return extractJson(env.result || out);
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
    provider: r.provider || "",
    mode: r.mode || "solve",                 // 旧记录没有这两个字段，默认为普通讲题
    curriculumId: r.curriculumId || ""
  };
}

/* ---------------- BC 大纲与学习进度 ----------------
 * 大纲数据 = 构建期生成的静态 JSON（tools/curriculum/parse_bc.mjs），启动时读进内存，
 * 运行期只读、离线可用。进度挂在自铸的稳定 ID（BC.MATH.G4.NUM.02）上，
 * progress.json 与 history.json 同一套原子写模式。 */
const STRANDS = [
  ["number", "数与运算", "Number"],
  ["computational-fluency", "运算熟练", "Computational Fluency"],
  ["patterning", "规律与代数", "Patterning"],
  ["geometry-measurement", "图形与测量", "Geometry & Measurement"],
  ["data-probability", "数据与可能性", "Data & Probability"]
];
const CURRICULUM_DIR = path.join(ROOT, "data", "curriculum", "bc");
const curriculum = new Map();   // grade -> grade-N.json 内容
try {
  for (const f of fs.readdirSync(CURRICULUM_DIR)) {
    const m = /^grade-(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      curriculum.set(Number(m[1]), JSON.parse(fs.readFileSync(path.join(CURRICULUM_DIR, f), "utf8")));
    } catch (e) { console.log(`[curriculum] ${f} 解析失败：${e.message}`); }
  }
} catch (_) { /* 没有大纲数据也能跑，「跟大纲学」入口自动隐藏 */ }

/* 书籍课程源（data/curriculum/books/*.json）：和 BC 大纲同一张 Map，key 用字符串 bookId。
 * 结构兼容 grade-N.json，另带 type:"book"、strandDefs（章节代替五大主线）、teachStyle（原书讲法）。
 * 讲课/闯关/进度/报告全部走现有条目 id 机制；FSA 只认数字年级，书籍天然不出卷。 */
const BOOKS_DIR = path.join(ROOT, "data", "curriculum", "books");
try {
  for (const f of fs.readdirSync(BOOKS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, f), "utf8"));
      if (d && d.type === "book" && Array.isArray(d.items)) curriculum.set(String(d.bookId || f.replace(/\.json$/, "")), d);
    } catch (e) { console.log(`[curriculum] books/${f} 解析失败：${e.message}`); }
  }
} catch (_) { /* 没有书籍数据也能跑 */ }
function curriculumGrades() { return [...curriculum.keys()].filter(k => typeof k === "number").sort((a, b) => a - b); }
function curriculumBooks() {
  return [...curriculum.entries()].filter(([k]) => typeof k === "string").map(([k, d]) => ({
    id: k, grade: d.grade || 0,
    zh: ((d.short || d.title || {}).zh) || k,
    en: ((d.short || d.title || {}).en) || k
  }));
}
/* /api/curriculum、/api/report 的 grade 参数：纯数字 = BC 年级，其他 = 书籍 id */
function curriculumKey(raw) {
  const s = String(raw == null ? "" : raw);
  return /^\d+$/.test(s) ? Number(s) : s;
}
function findCurriculumItem(id) {
  for (const d of curriculum.values()) {
    const item = (d.items || []).find(it => it.id === id);
    if (item) return { item, data: d };
  }
  return null;
}

/* 全年级共享术语表（terms.json）：讲课提示词和家长报告都从这里取中英对照 */
let sharedTerms = [];
try {
  const t = JSON.parse(fs.readFileSync(path.join(CURRICULUM_DIR, "terms.json"), "utf8"));
  if (t && Array.isArray(t.terms)) sharedTerms = t.terms.filter(x => x && x.en && x.zh);
} catch (_) { /* 没有术语表也能跑，讲课只用条目自带 terms */ }

/* "likely / unlikely" 这类合并词条按 / 拆开各自匹配；只做整词匹配（否则 net 会命中 planet） */
function termMatches(en, hay) {
  return String(en).split("/").some(part => {
    const p = part.trim().toLowerCase();
    if (!p) return false;
    const re = new RegExp("(^|[^a-z])" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(s|es)?([^a-z]|$)", "i");
    return re.test(hay);
  });
}

/* 条目的术语对照 = 自带 terms + 共享术语表里出现在这条原文/子条目里的词，去重、封顶 10 条 */
function itemTerms(item) {
  const own = (item.terms || []).filter(t => t && t.en && t.zh);
  const hay = (String(item.en || "") + " " + (item.elaborations || []).map(e => (e && e.en) || "").join(" ")).toLowerCase();
  const seen = new Set(own.map(t => t.en.toLowerCase()));
  const extra = sharedTerms.filter(t => !seen.has(t.en.toLowerCase()) && termMatches(t.en, hay));
  return own.concat(extra).slice(0, 10);
}

const PROGRESS_FILE = path.join(ROOT, "progress.json");
let progress = {};   // curriculumId -> { taught, right, wrong, lastAt, solid, quizPassedAt, rightDays[], lessonIds[] }
try {
  const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  if (p && typeof p === "object" && !Array.isArray(p)) progress = p;
} catch (_) { /* 还没有进度 */ }

function progressSave() {
  try {
    const tmp = PROGRESS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(progress), "utf8");
    fs.renameSync(tmp, PROGRESS_FILE);
  } catch (e) { console.log("[progress] 保存失败：" + e.message); }
}
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
/* 三态：new（没学过）/ seen（讲过）/ solid（扎实），由下面的四级直接降维。
 * solid = 闯关通关（docs/qbank-standard.md §5），或不同日期答对 ≥2 次，或家长手动标记 */
function progressStatus(id) {
  const lv = progressLevel(id);
  return lv === "emerging" ? "new" : lv === "developing" ? "seen" : "solid";
}
/* BC 官方四级话术（2023 年起成绩单同款）：Emerging / Developing / Proficient / Extending。
 * 映射：new→emerging，seen→developing，solid→proficient；不同日期答对 ≥3 次→extending（solid+） */
function progressLevel(id) {
  const e = progress[id];
  if (!e) return "emerging";
  const days = (e.rightDays || []).length;
  if (days >= 3) return "extending";
  if (e.solid || e.quizPassedAt || days >= 2) return "proficient";
  return (e.taught || e.right || e.wrong) ? "developing" : "emerging";
}
function progressRecord(id, event, lessonId) {
  const e = progress[id] || (progress[id] = { taught: 0, right: 0, wrong: 0, lastAt: 0, solid: false, rightDays: [], lessonIds: [] });
  const now = Date.now();
  if (event === "taught") {
    e.taught++;
    if (lessonId) e.lessonIds = [lessonId, ...(e.lessonIds || [])].slice(0, 20);
  } else if (event === "practiced-right") {
    e.right++;
    const k = dayKey(now);
    if (!(e.rightDays || (e.rightDays = [])).includes(k)) e.rightDays.push(k);
  } else if (event === "practiced-wrong") e.wrong++;
  else if (event === "quiz-right") e.right++;   // 闯关单题只计 ✓✗ 统计，不计 rightDays：没通关不能靠攒天数白捡 solid（标准 §5）
  else if (event === "quiz-wrong") e.wrong++;
  else if (event === "quiz-pass") {             // 通关：直接 solid，通关当天也算一个 rightDay（继续往 Extending 攒）
    e.quizPassedAt = now;
    const k = dayKey(now);
    if (!(e.rightDays || (e.rightDays = [])).includes(k)) e.rightDays.push(k);
  }
  else if (event === "mark-solid") e.solid = true;
  else if (event === "unmark-solid") e.solid = false;
  else return null;
  e.lastAt = now;
  progressSave();
  return e;
}

/* 大纲条目按主线分组（/api/curriculum 与 /api/report 共用），mapItem 决定每条带哪些字段。
 * BC 用固定五大主线（STRANDS）；书籍数据自带 strandDefs（章节列表），格式相同 [slug, 中文名, 英文名] */
function strandGroups(d, mapItem) {
  return (d.strandDefs || STRANDS)
    .filter(([s]) => (d.items || []).some(it => it.strand === s))
    .map(([s, zhName, enName]) => ({
      strand: s, zhName, enName,
      bigIdea: (d.bigIdeas || []).find(b => b.strand === s) || null,
      items: (d.items || []).filter(it => it.strand === s).map(mapItem)
    }));
}

/* ---------------- FSA 卷持久化 ----------------
 * 出一卷要跑一次 AI（约 2 分钟），所以生成一次就永久保存（fsa-sets.json），
 * 之后直接打开做，不再重新出题；每次作答记一条成绩（attempts）。 */
const FSA_SETS_FILE = path.join(ROOT, "fsa-sets.json");
const FSA_SETS_MAX = 100;
let fsaSets = [];
try {
  const s = JSON.parse(fs.readFileSync(FSA_SETS_FILE, "utf8"));
  if (Array.isArray(s)) fsaSets = s;
} catch (_) { /* 还没有卷子 */ }

function fsaSetsSave() {
  try {
    const tmp = FSA_SETS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(fsaSets), "utf8");
    fs.renameSync(tmp, FSA_SETS_FILE);
  } catch (e) { console.log("[fsa] 保存失败：" + e.message); }
}
function fsaSetsAdd(rec) {
  rec.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  fsaSets.unshift(rec);
  if (fsaSets.length > FSA_SETS_MAX) fsaSets.length = FSA_SETS_MAX;
  fsaSetsSave();
}
function fsaSetSummary(r) {
  return {
    id: r.id, time: r.time, grade: r.grade, strand: r.strand || "", lang: r.lang || "zh",
    title: r.title || "FSA", count: (r.questions || []).length,
    last: (r.attempts || [])[0] || null
  };
}

/* ---------------- 闯关题库持久化（P5）----------------
 * 出一批题要跑一次 AI，所以生成后永久保存（qbank.json，原子写同 progress.json）。
 * 做过的题打 usedAt，优先给没做过的题；不够自动补，封顶后按最久没做过复用。 */
const QBANK_FILE = path.join(ROOT, "qbank.json");
let qbank = {};   // "curriculumId|lang" -> { questions: [{qid, level, question, options, answerIndex, explain, usedAt}] }
try {
  const b = JSON.parse(fs.readFileSync(QBANK_FILE, "utf8"));
  if (b && typeof b === "object" && !Array.isArray(b)) qbank = b;
} catch (_) { /* 还没有题库 */ }

function qbankSave() {
  try {
    const tmp = QBANK_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(qbank), "utf8");
    fs.renameSync(tmp, QBANK_FILE);
  } catch (e) { console.log("[quiz] 保存失败：" + e.message); }
}
const qbankKey = (id, lang) => id + "|" + lang;

/* 新题并入题库：题干去重（空白不敏感）、每级封顶 */
function qbankMerge(bank, batch) {
  const norm = s => s.toLowerCase().replace(/\s+/g, "");
  const seen = new Set(bank.questions.map(q => norm(q.question)));
  for (const q of batch) {
    const k = norm(q.question);
    if (seen.has(k)) continue;
    if (bank.questions.filter(x => x.level === q.level).length >= QUIZ_LEVEL_CAP) continue;
    seen.add(k);
    bank.questions.push(Object.assign({ qid: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), usedAt: 0 }, q));
  }
}

/* 开练前保证每级有足够没做过的题；不足就让 AI 补（初次 = 三级各 4 道一次生成） */
async function ensureQuizBank(item, gradeData, lang, providerId) {
  const key = qbankKey(item.id, lang);
  const bank = qbank[key] || (qbank[key] = { questions: [] });
  const needs = {};
  for (const lv of [1, 2, 3]) {
    const qs = bank.questions.filter(q => q.level === lv);
    if (qs.filter(q => !q.usedAt).length < QUIZ_SESSION_PER_LEVEL && qs.length < QUIZ_LEVEL_CAP) needs[lv] = QUIZ_PER_LEVEL_NEW;
  }
  if (!Object.keys(needs).length) return bank;
  const total = Object.values(needs).reduce((a, b) => a + b, 0);
  const sys = qbankPrompt(item, gradeData, lang, needs, bank.questions.map(q => q.question));
  const msg = L(lang, "请出这批题。", "Please write this batch of questions.");
  const opts = { schema: QBANK_SCHEMA, hint: QBANK_HINT[lang] };
  const t0 = Date.now();
  console.log(`[quiz] engine=${providerId} topic=${item.id} lang=${lang} need=${[1, 2, 3].filter(l => needs[l]).map(l => `L${l}×${needs[l]}`).join(",")}`);
  const attempt = async () => {
    qbankMerge(bank, validateQbankBatch(await ADAPTERS[providerId](sys, msg, null, null, lang, opts), total));
    // 阶梯每一级都得有题可出，缺级就算失败
    if ([1, 2, 3].some(lv => !bank.questions.some(q => q.level === lv))) throw new Error("有难度级还没有题");
  };
  try { await attempt(); }
  catch (e1) {
    console.log(`[quiz] first try failed (${e1.message}), retrying once...`);
    try { await attempt(); }
    catch (e2) {
      qbankSave();   // 两次攒下的合格题先存住，下次接着补
      throw new Error(L(lang, "出题没成功，再试一次吧。", "Couldn't write the questions — try again."));
    }
  }
  qbankSave();
  console.log(`[quiz] bank ${key} ready: ${bank.questions.length} questions in ${Math.round((Date.now() - t0) / 1000)}s`);
  return bank;
}

function shuffleArr(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/* 一次闯关的题包：每级最多 4 道，没做过的优先（打乱），其余按最久没做过补位 */
function quizSession(bank) {
  const out = [];
  for (const lv of [1, 2, 3]) {
    const qs = bank.questions.filter(q => q.level === lv);
    const fresh = shuffleArr(qs.filter(q => !q.usedAt));
    const used = qs.filter(q => q.usedAt).sort((a, b) => a.usedAt - b.usedAt);
    out.push(...fresh.concat(used).slice(0, QUIZ_SESSION_PER_LEVEL));
  }
  return out.map(q => ({ qid: q.qid, level: q.level, question: q.question, options: q.options, answerIndex: q.answerIndex, explain: q.explain }));
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
      return send(res, 200, { authRequired: !!cfg.accessCode, active: pickProvider(cfg.provider), providers: list, tts: ttsAvailable(), curriculumGrades: curriculumGrades(), curriculumBooks: curriculumBooks() });
    }

    if (url.pathname === "/api/tts" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      if (!ttsAvailable()) return send(res, 200, { enabled: false, items: [] });
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8"));
      const defLang = normLang(body.lang);
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

    if (url.pathname === "/api/curriculum" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const grades = curriculumGrades();
      const g = curriculumKey(url.searchParams.get("grade") || 0);
      if (!g) return send(res, 200, { grades, books: curriculumBooks() });
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet", grades });
      const strands = strandGroups(d, it => ({
        id: it.id, en: it.en, zh: it.zh, status: progressStatus(it.id),
        // 最近一节讲过的课：前端点条目直接重播（免费秒开），🔄 才重新生成
        lessonId: ((progress[it.id] || {}).lessonIds || [])[0] || ""
      }));
      return send(res, 200, { grade: g, grades, source: d.source, strands });
    }

    /* P3 家长报告：按主线汇总 + BC 四级话术级别 */
    if (url.pathname === "/api/report" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const grades = curriculumGrades();
      const g = curriculumKey(url.searchParams.get("grade") || 0);
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet", grades });
      const strands = strandGroups(d, it => {
        const e = progress[it.id];
        return {
          id: it.id, en: it.en, zh: it.zh,
          status: progressStatus(it.id),
          level: progressLevel(it.id),
          manualSolid: !!(e && e.solid),   // 家长手动标记的「扎实」，前端星标可切换
          taught: e ? e.taught : 0, right: e ? e.right : 0, wrong: e ? e.wrong : 0,
          lastAt: e ? e.lastAt : 0
        };
      }).map(sg => Object.assign(sg, {
        total: sg.items.length,
        seen: sg.items.filter(i => i.status !== "new").length,
        solid: sg.items.filter(i => i.status === "solid").length
      }));
      const totals = strands.reduce((a, sg) => ({ total: a.total + sg.total, seen: a.seen + sg.seen, solid: a.solid + sg.solid }),
        { total: 0, seen: 0, solid: 0 });
      // 术语对照：这个年级大纲里出现过的中英术语，随报告打印（家长看成绩单/和老师面谈用）
      const termSeen = new Set(); const terms = [];
      for (const it of (d.items || [])) for (const tm of itemTerms(it)) {
        const k = tm.en.toLowerCase();
        if (!termSeen.has(k)) { termSeen.add(k); terms.push({ en: tm.en, zh: tm.zh }); }
      }
      return send(res, 200, { grade: g, grades, source: d.source, strands, totals, terms });
    }

    /* P4 FSA 模拟卷：按大纲出多步骤情境选择题（G4/G7 是 FSA 年级，其他年级也可当普通练习卷） */
    if (url.pathname === "/api/fsa" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8"));
      const lang = normLang(body.lang);
      const g = Number(body.grade || 0);
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" });
      const strand = STRANDS.some(s => s[0] === body.strand) ? body.strand : "";
      const count = Math.max(4, Math.min(10, Number(body.count) || 6));
      const id = pickProvider(body.provider);
      if (!id) return send(res, 503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      const sys = fsaPrompt(d, strand, lang, count);
      const q = L(lang, "请出这一卷 FSA 模拟练习。", "Please create this FSA-style practice set.");
      const opts = { schema: FSA_SET_SCHEMA, hint: FSA_HINT[lang] };
      const t0 = Date.now();
      console.log(`[fsa] engine=${id} grade=${g} strand=${strand || "all"} lang=${lang} n=${count}`);
      let set;
      try {
        set = validateFsaSet(await ADAPTERS[id](sys, q, null, null, lang, opts), d, count);
      } catch (e1) {
        console.log(`[fsa] first try failed (${e1.message}), retrying once...`);
        set = validateFsaSet(await ADAPTERS[id](sys, q, null, null, lang, opts), d, count);
      }
      console.log(`[fsa] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${set.questions.length} questions`);
      // 出一次卷不便宜：立刻持久化，以后直接打开做，不再重新生成
      const rec = { time: Date.now(), grade: g, strand, lang, provider: id, title: set.title, questions: set.questions, attempts: [] };
      fsaSetsAdd(rec);
      return send(res, 200, { set: rec, provider: id, ms: Date.now() - t0 });
    }

    if (url.pathname === "/api/fsa/sets" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const g = Number(url.searchParams.get("grade") || 0);
      return send(res, 200, { items: fsaSets.filter(r => !g || r.grade === g).map(fsaSetSummary) });
    }

    const fsm = /^\/api\/fsa\/sets\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (fsm && (req.method === "GET" || req.method === "DELETE")) {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const i = fsaSets.findIndex(r => r.id === fsm[1]);
      if (i < 0) return send(res, 404, { error: "卷子不存在 / Not found" });
      if (req.method === "DELETE") {
        fsaSets.splice(i, 1);
        fsaSetsSave();
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { record: fsaSets[i] });
    }

    if (url.pathname === "/api/fsa/attempt" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const rec = fsaSets.find(r => r.id === String(body.id || ""));
      if (!rec) return send(res, 404, { error: "卷子不存在 / Not found" });
      // total 以卷内题数为准，right 夹在 [0, total]——不全信客户端
      const total = (rec.questions || []).length;
      const at = {
        time: Date.now(),
        right: Math.min(total, Math.max(0, Math.round(Number(body.right) || 0))),
        total,
        ms: Math.max(0, Math.round(Number(body.ms) || 0))
      };
      rec.attempts = [at, ...(rec.attempts || [])].slice(0, 10);
      fsaSetsSave();
      return send(res, 200, { ok: true });
    }

    /* P5 闯关练习：看完课一道一道做题，SAT 式升降难度，通关标 solid（标准 docs/qbank-standard.md） */
    if (url.pathname === "/api/quiz/session" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const lang = normLang(body.lang);
      const found = findCurriculumItem(String(body.curriculumId || ""));
      if (!found) return send(res, 400, { error: "未知的知识点 / Unknown curriculum item" });
      const id = pickProvider(body.provider);
      if (!id) return send(res, 503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      const bank = await ensureQuizBank(found.item, found.data, lang, id);
      return send(res, 200, {
        questions: quizSession(bank),
        rules: { maxQuestions: QUIZ_MAX_QUESTIONS, passNeed: QUIZ_PASS_NEED, topLevel: QUIZ_TOP_LEVEL }
      });
    }

    /* 闯关结算：单题对错记统计、做过的题打 usedAt；通关判定以服务器题库里的难度为准 */
    if (url.pathname === "/api/quiz/finish" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const cid = String(body.curriculumId || "");
      if (!findCurriculumItem(cid)) return send(res, 400, { error: "未知的知识点 / Unknown curriculum item" });
      const bank = qbank[qbankKey(cid, normLang(body.lang))];
      const now = Date.now();
      const counted = new Set();
      let topRight = 0;
      for (const r of (Array.isArray(body.results) ? body.results : []).slice(0, QUIZ_MAX_QUESTIONS + 4)) {
        const qid = String((r && r.qid) || "");
        const q = bank && bank.questions.find(x => x.qid === qid);
        if (!q || counted.has(qid)) continue;   // 不认识 / 重复的 qid 不记
        counted.add(qid);
        q.usedAt = now;
        const ok = !!(r && r.correct);
        progressRecord(cid, ok ? "quiz-right" : "quiz-wrong");
        if (q.level === QUIZ_TOP_LEVEL && ok) topRight++;
      }
      if (bank) qbankSave();
      const passed = topRight >= QUIZ_PASS_NEED;
      if (passed) progressRecord(cid, "quiz-pass");
      return send(res, 200, { ok: true, passed, status: progressStatus(cid), level: progressLevel(cid) });
    }

    /* 清空（设置里的「清空学习进度 / 清空全部记录」，前端有确认框） */
    if (url.pathname === "/api/progress" && req.method === "DELETE") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      progress = {};
      progressSave();
      console.log("[progress] 已清空");
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/history" && req.method === "DELETE") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      history = [];
      historySave();
      console.log("[history] 已清空");
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/fsa/sets" && req.method === "DELETE") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      fsaSets = [];
      fsaSetsSave();
      console.log("[fsa] 卷子已清空");
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/qbank" && req.method === "DELETE") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      qbank = {};
      qbankSave();
      console.log("[quiz] 题库已清空");
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/progress" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const g = Number(url.searchParams.get("grade") || 0);
      const prefix = g ? `BC.MATH.G${g}.` : "";
      const items = {};
      for (const [id, e] of Object.entries(progress)) {
        if (prefix && !id.startsWith(prefix)) continue;
        items[id] = Object.assign({}, e, { status: progressStatus(id) });
      }
      return send(res, 200, { items });
    }

    if (url.pathname === "/api/progress" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const id = String(body.curriculumId || "");
      if (!findCurriculumItem(id)) return send(res, 400, { error: "未知的知识点 / Unknown curriculum item" });
      const e = progressRecord(id, String(body.event || ""));
      if (!e) return send(res, 400, { error: "未知的事件 / Unknown event" });
      return send(res, 200, { ok: true, status: progressStatus(id), entry: e });
    }

    if (url.pathname === "/api/lesson" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "需要访问码 / Access code required", authRequired: true });
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      let question = String(body.question || "").slice(0, 4000);
      const imageB64 = body.imageB64 || null;
      const mediaType = body.mediaType || "image/jpeg";
      const lang = normLang(body.lang);
      const mode = body.mode === "teach" ? "teach" : "solve";
      let teachCtx = null;
      if (mode === "teach") {
        teachCtx = findCurriculumItem(String(body.curriculumId || ""));
        if (!teachCtx) return send(res, 400, { error: L(lang, "找不到这个知识点，刷新一下再试。", "Can't find that curriculum topic — refresh and try again.") });
        // teach 模式 question 可为空；补一个课题名，历史记录和日志里好认
        if (!question) question = lang === "en" ? teachCtx.item.en : `${teachCtx.item.zh}（${teachCtx.item.en}）`;
      } else if (!question && !imageB64) return send(res, 400, { error: L(lang, "题目是空的", "The question is empty.") });

      const id = pickProvider(body.provider);
      if (!id) return send(res, 503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      if (imageB64 && !PROVIDER_META[id].supportsImage) {
        return send(res, 400, { error: L(lang,
          PROVIDER_META[id].label + " 暂不支持看图，请把题目打字输入，或在设置里换一个支持看图的引擎。",
          (PROVIDER_META[id].labelEn || id) + " can't read images yet. Type the question, or pick an engine that supports images in Settings.") });
      }

      const sys = teachCtx
        ? systemPromptTeach(teachCtx.item, teachCtx.data, body.kidName, lang)
        : systemPrompt(body.grade, body.kidName, lang, Number(body.gradeCode) || 0);
      const t0 = Date.now();
      console.log(`[lesson] engine=${id} mode=${mode} lang=${lang} q="${question.slice(0, 40)}" image=${!!imageB64}`);
      let lesson;
      try {
        lesson = validateLesson(await ADAPTERS[id](sys, question, imageB64, mediaType, lang));
      } catch (e1) {
        console.log(`[lesson] first try failed (${e1.message}), retrying once...`);
        lesson = validateLesson(await ADAPTERS[id](sys, question, imageB64, mediaType, lang));
      }
      console.log(`[lesson] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${lesson.steps.length} steps`);
      const rec = { time: Date.now(), question, hasImage: !!imageB64, lang, grade: String(body.grade || ""), provider: id, lesson };
      if (teachCtx) { rec.mode = "teach"; rec.curriculumId = teachCtx.item.id; }
      historyAdd(rec);
      // 生成即视为「讲过」：进度立刻从 new 变 seen，并把这节课挂到知识点上
      if (teachCtx) progressRecord(teachCtx.item.id, "taught", rec.id);
      // 讲解生成好就立刻预合成语音（不等前端），孩子点开第一步时大概率已就绪
      if (ttsAvailable() && lesson.isMath !== false) {
        try { ttsStates(lesson.steps.map(s => ({ text: s.say, lang })), lang); } catch (_) {}
      }
      const resp = { lesson, provider: id, ms: Date.now() - t0, tts: ttsAvailable() };
      // lessonId 带回给前端：清单/FSA 错题下次点开直接重播这节课，不再重新生成
      if (teachCtx) { resp.curriculumId = teachCtx.item.id; resp.status = progressStatus(teachCtx.item.id); resp.lessonId = rec.id; }
      return send(res, 200, resp);
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
    console.log("  BC 大纲:    " + (curriculumGrades().length
      ? curriculumGrades().map(g => "G" + g).join("、") + " 已加载（进度 " + Object.keys(progress).length + " 条，progress.json）"
      : "未加载（data/curriculum/bc/ 里还没有 grade-N.json）"));
    console.log("  书籍课程:   " + (curriculumBooks().length
      ? curriculumBooks().map(b => b.en + "（" + b.id + "，" + (curriculum.get(b.id).items || []).length + " 节）").join("、")
      : "未加载（data/curriculum/books/ 里还没有书籍 JSON）"));
    console.log("  FSA 卷:     " + fsaSets.length + " 份（fsa-sets.json，上限 " + FSA_SETS_MAX + " 份，做过的卷直接重开不再生成）");
    console.log("  闯关题库:   " + Object.keys(qbank).length + " 个（qbank.json，做对升难度、通关标 solid；标准 docs/qbank-standard.md）");
    if (!cfg.accessCode) console.log("  ⚠ 未设置访问码。部署到外网前请在 config.json 里设置 accessCode。");
    console.log("");
  });
});
