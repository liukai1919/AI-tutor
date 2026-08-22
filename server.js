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

/* ---------------- 可写数据根目录 ----------------
 * 随包内容（代码、课程、语音包、seed/）在 ROOT，升级时整体替换；
 * 用户数据（账号、进度、题库、config、语音缓存）在 DATA_ROOT，升级绝不能碰。
 * 源码模式下两者是同一个目录（数据照旧写在仓库里，开发流不变）；
 * 打包运行（pack.mjs 会在 app 目录放一个 .packaged 标记）时切到系统的用户数据目录：
 *   macOS    ~/Library/Application Support/YuanyuanMath
 *   Windows  %APPDATA%\YuanyuanMath
 *   其他     $XDG_DATA_HOME/YuanyuanMath（默认 ~/.local/share/...）
 * 环境变量 YY_DATA_DIR 永远最优先（U 盘便携、多套数据、测试都靠它）。 */
const PACKAGED = fs.existsSync(path.join(ROOT, ".packaged"));
const DATA_ROOT = (() => {
  if (process.env.YY_DATA_DIR) return path.resolve(process.env.YY_DATA_DIR);
  if (!PACKAGED) return ROOT;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "YuanyuanMath");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "YuanyuanMath");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "YuanyuanMath");
})();

/* 老版本把用户数据留在 app 目录里（Windows 覆盖安装 / 原地解压升级后原样还在）：
 * DATA_ROOT 启用后第一次启动整体拷过来接管。只拷不删——迁移中途出任何差错，
 * 旧数据必须原样留在老位置；已存在的目标一律不覆盖。全部成功才落标记，
 * 之后每次启动零成本跳过；中途失败下次启动自动续拷。 */
if (DATA_ROOT !== ROOT) {
  const migratedFlag = path.join(DATA_ROOT, ".migrated-from-app");
  if (!fs.existsSync(migratedFlag)) {
    const carry = [
      "config.json", "qbank.json", "tts-cache",
      path.join("data", "users.json"), path.join("data", "sessions.json"), path.join("data", "kids"),
      "history.json", "progress.json", "fsa-sets.json"   // 远古单用户版留在根目录的单例
    ];
    let copied = 0, failed = 0;
    for (const rel of carry) {
      const src = path.join(ROOT, rel), dst = path.join(DATA_ROOT, rel);
      try {
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true, force: false });
        copied++;
      } catch (e) { failed++; console.log("[data] migrate " + rel + " failed: " + e.message); }
    }
    if (copied) console.log("[data] took over " + copied + " item(s) of user data from the app folder -> " + DATA_ROOT);
    if (!failed) {
      try {
        fs.mkdirSync(DATA_ROOT, { recursive: true });
        fs.writeFileSync(migratedFlag, new Date().toISOString() + " from " + ROOT + "\n", "utf8");
      } catch (_) { /* 标记写不上只是下次多扫一遍，不致命 */ }
    }
  }
}

/* 随包种子：seed/config.json 首启落到 DATA_ROOT（预烘语音包的哈希按默认配置算，
 * 配置对不上语音包一条都命中不了）。用户已有 config 永远不动。
 * seed/qbank.json 在题库模块加载后合并（见 qbank 一节）。 */
const SEED_DIR = path.join(ROOT, "seed");
if (DATA_ROOT !== ROOT && !fs.existsSync(path.join(DATA_ROOT, "config.json"))) {
  // 老包（1.0.0）的种子在 ROOT/config.json；迁移没赶上的极端情况这里兜底
  for (const seedCfg of [path.join(SEED_DIR, "config.json"), path.join(ROOT, "config.json")]) {
    if (!fs.existsSync(seedCfg)) continue;
    try {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.cpSync(seedCfg, path.join(DATA_ROOT, "config.json"), { force: false });
    } catch (e) { console.log("[config] could not seed config.json: " + e.message); }
    break;
  }
}

const DEFAULT_CONFIG = {
  port: 8434,
  accessCode: "",                 // 已弃用：账号系统（注册/登录）取代了访问码，此项不再参与鉴权
  registrationCode: "",           // 第一位家长注册完注册就自动关了；设了这个邀请码才能再注册新家庭
  provider: "auto",               // auto | ollama | grok | claude | gemini | codex | anthropic | openai
  providerByTask: {},             // 按任务挑引擎（可选），例 { "quiz": "ollama", "ask": "claude" }；任务名同用量账本，见 pickProvider
  ollama: { url: "http://localhost:11434", model: "", think: true, structured: false },   // structured: 见 genOllama
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
  // 去掉 BOM：Windows 记事本「另存为 UTF-8」会加一个，JSON.parse 见了就抛，
  // 结果整份配置被静默忽略——端口、邀请码、API key 全回默认，语音包也跟着失效。
  const raw = fs.readFileSync(path.join(DATA_ROOT, "config.json"), "utf8").replace(/^\uFEFF/, "");
  cfg = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
} catch (e) {
  // 文件不存在是正常情况（用默认）；存在却读不动必须吭声，否则就像上面那样悄悄坏掉
  if (e.code !== "ENOENT") console.log("[config] could not read config.json (" + e.message + ") - falling back to defaults.");
}
if (process.env.PORT) cfg.port = Number(process.env.PORT);
if (process.env.ACCESS_CODE) cfg.accessCode = process.env.ACCESS_CODE;
if (process.env.REGISTRATION_CODE) cfg.registrationCode = process.env.REGISTRATION_CODE;

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
  "baseTen", "hundredthsGrid", "hundredChart", "dataTable", "probLine",
  // 高中（G8-12）加的：函数图像、直角三角形、一般三角形、单位圆
  "funcGraph", "rightTriangle", "triangle", "unitCircle"
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
/* 年级语气分层：G4-6 小学腔原样不动（已发布的课就是这个口吻）；G7 起称「数学老师」、不低幼（FSA 备考前置）；
 * G8-9 初中；G10-12 高中——例子换成打工工资、手机套餐、开车、存大学学费，术语直接用正式说法
 * （函数、斜率、渐近线），该严谨的地方严谨，但仍然是一步一个小意思、落到具体例子的讲法。 */
function seniorTone(gradeNum) {
  const g = Number(gradeNum) || 0;
  if (g < 7) return { ageZh: "约10-12岁", personaZh: "小学老师", toneZh: "", ageEn: "about 10-12 years old", personaEn: "elementary school teacher", toneEn: "" };
  if (g === 7) return {
    ageZh: "约12-13岁", personaZh: "数学老师",
    toneZh: "\n4. 孩子已经上七年级了：语气依旧亲切，但别低幼（不要「小朋友」腔），例子贴近大孩子的生活（运动、游戏、手机、零花钱、和朋友出门）。",
    ageEn: "about 12-13 years old", personaEn: "math teacher",
    toneEn: "\n4. The child is in Grade 7 — keep the warmth but don't sound babyish; use tween-appropriate examples (sports, games, phones, allowance, going out with friends)."
  };
  if (g <= 9) return {
    ageZh: "约13-15岁", personaZh: "初中数学老师",
    exZh: "运动比分、手机流量、兼职零花钱、和朋友出门的开销", exEn: "sports scores, phone data, part-time allowance, splitting costs with friends",
    toneZh: "\n4. 学生已经上" + (GRADE_ZH[g] || g) + "年级了：语气亲切但平视，不要「小朋友」腔；例子用青少年的生活（运动队、游戏、手机流量、兼职零花钱、和朋友出门）。数学术语直接用正式说法（如「系数」「指数」「线性关系」），关键术语顺带给英文。",
    ageEn: "about 13-15 years old", personaEn: "middle-school math teacher",
    toneEn: "\n4. The student is in Grade " + g + " — warm but peer-level, never babyish; use teen-life examples (sports teams, games, phone data, part-time allowance, going out with friends). Use proper math vocabulary (coefficient, exponent, linear relation)."
  };
  return {
    ageZh: "约15-18岁", personaZh: "高中数学老师",
    exZh: "兼职工资和扣税、手机套餐、开车和油费、存大学学费、运动数据", exEn: "part-time pay and deductions, phone plans, driving and gas, saving for university, sports stats",
    toneZh: "\n4. 学生是 BC 高中" + (GRADE_ZH[g] || g) + "年级的学生：用平视、尊重的口吻（不要儿童腔，不要过度夸张的鼓励）；例子用高中生的世界（兼职工资和扣税、手机套餐、开车和油费、存大学学费、运动数据、游戏里的数值）。术语用正式说法并顺带英文（函数 function、斜率 slope、渐近线 asymptote……），推导要严谨，但依旧一步只讲一个小意思、每个概念都落到具体例子上。",
    ageEn: "about 15-18 years old", personaEn: "high-school math teacher",
    toneEn: "\n4. The student is in BC Grade " + g + " — speak as a respectful, peer-level teacher (no kiddie voice, no over-the-top cheering); draw examples from a teen's world (part-time pay and deductions, phone plans, driving and gas, saving for university, sports stats, game mechanics). Use proper vocabulary (function, slope, asymptote) and keep derivations rigorous, while still teaching one small idea per step and grounding every concept in a concrete example."
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
2. 一步只讲一个小意思，语气鼓励、口语化，多用生活里的例子（${st.exZh || "分披萨、分糖果、跑步、买东西"}）。
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
  - say：要【读出来】给孩子听的话。纯口语中文，不要 LaTeX、不要奇怪符号；数字和加减乘除直接用中文说（如"四分之三"、"乘以"）。百分数读作"百分之五""百分之零点五""百分之一百二十二"（不要写成"五百分之"），负数读"负三"，幂读"二的三次方"，根号读"根号二"，函数读"f of x"或"f x"。
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
    · "funcGraph"（函数图像）：labels=[表达式1, 表达式2, ...]（最多 3 条，用 x 做变量，写法如 "2*x+1"、"x^2-4*x+3"、"2^x"、"log(x)"（以 10 为底）、"ln(x)"、"sin(x)"（x 为弧度）、"1/(x-2)"、"abs(x)"、"sqrt(x)"），nums=[x最小, x最大, y最小, y最大]（可省略，默认 -6～6）。画坐标系和曲线，不同曲线不同颜色并标出表达式。讲一次函数、二次函数、指数/对数、三角函数、有理函数、函数变换必配。
    · "rightTriangle"（直角三角形）：nums=[底边, 竖直边]（按比例画，直角在左下），labels=[底边标注, 竖直边标注, 斜边标注, 角的标注]（如 ["8 m","x","","35°"]，不需要的填 ""；角标在底边右端那个锐角上）。讲勾股定理、三角比（sin/cos/tan）必配。
    · "triangle"（一般三角形）：nums=[边a, 边b, 边c]（三边长，按比例画），labels=[边a标注, 边b标注, 边c标注, 角A标注, 角B标注, 角C标注]（角A 对边a，以此类推；不需要的填 ""）。讲正弦定理、余弦定理、相似三角形必配。
    · "unitCircle"（单位圆）：nums=[角度]（标准位置角，-360～720），labels=[角的名称]（可选，如 ["θ"]）。画单位圆、终边、从 x 轴正向起的角和参考角。讲标准位置角、参考角、特殊角、三角函数定义必配。
    图要和该步内容一致。份数、行列、组数不超过 12；图形类（shape…/solid…/net…/clock/placeValue/pieChart/统计图）用题目里的真实数值。`;
}

function systemPromptEn(grade, kidName, gradeNum) {
  const st = seniorTone(gradeNum);
  const name = kidName ? `The child's name is "${kidName}" — feel free to address them by name warmly now and then.` : "";
  return `You are "Ms. Yuanyuan", a kind ${st.personaEn} explaining math to a ${grade || "Grade 5"} child (${st.ageEn}), in natural, warm, everyday English. ${name}

Your task: turn one math problem into a step-by-step lesson the child can SEE and HEAR, like a little video class.

Iron rules:
1. Accuracy first. Re-check every bit of arithmetic before writing. The answer must be correct — a real child is watching, and getting it wrong is worse than not teaching at all.
2. One small idea per step. Encouraging, conversational tone; use everyday examples (${st.exEn || "sharing pizza, candies, running, shopping"}).
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
  - say: the words to be READ ALOUD to the child. Plain spoken English — no LaTeX, no odd symbols (no ^, *, /, _ or markdown); say numbers and operations in words (like "three quarters", "times", "x squared", "the square root of two", "f of x", "two to the power of five").
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
    · "funcGraph" (function graph): labels=[expression1, expression2, ...] (up to 3, in the variable x, written like "2*x+1", "x^2-4*x+3", "2^x", "log(x)" (base 10), "ln(x)", "sin(x)" (x in radians), "1/(x-2)", "abs(x)", "sqrt(x)"), nums=[xmin, xmax, ymin, ymax] (optional, default -6..6). Draws axes and the curves in different colours with the expressions labeled. A must for linear/quadratic functions, exponentials and logs, trig functions, rational functions, transformations.
    · "rightTriangle": nums=[base, vertical side] (drawn to scale, right angle at bottom-left), labels=[base label, vertical label, hypotenuse label, angle label] (e.g. ["8 m","x","","35°"]; use "" for ones you don't need; the angle is marked at the acute angle at the right end of the base). A must for the Pythagorean theorem and sin/cos/tan ratios.
    · "triangle" (general triangle): nums=[side a, side b, side c] (three side lengths, drawn to scale), labels=[label a, label b, label c, label of angle A, angle B, angle C] (angle A is opposite side a, etc.; "" for ones you don't need). A must for the sine law, cosine law, similar triangles.
    · "unitCircle": nums=[angle in degrees] (standard position, -360..720), labels=[angle name] (optional, e.g. ["θ"]). Draws the unit circle, the terminal arm, the angle from the positive x-axis and the reference angle. A must for angles in standard position, reference angles, special angles, trig definitions.
    The picture must match the step. Keep parts/rows/cols/groups at most 12 (shape…/solid…/net…/clock/placeValue/pieChart/stat charts use real values from the problem).`;
}

/* teach 模式：不讲一道题，讲一个 BC 大纲知识点（复用同一套 LESSON_SCHEMA 和 visual 目录） */
const GRADE_ZH = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九", 10: "十", 11: "十一", 12: "十二" };

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
  const bigIdea = bigIdeaText(gradeData, item.strand, "zh");
  const elabs = (item.elaborations || []).map(e => "  · " + (e.zh || e.en)).join("\n");
  const terms = itemTerms(item).map(t => `${t.zh} = ${t.en}`).join("、");
  const hints = item.teachHints ? `（这个知识点优先用这些图：${item.teachHints}）` : "";
  const isBook = gradeData.type === "book";
  const isCourse = isCourseData(gradeData);
  const courseTitle = (gradeData.title || {});
  const origin = isBook
    ? `知识点来自数学教材《${(gradeData.title || {}).zh || (gradeData.title || {}).en || gradeData.bookId}》（${(gradeData.source || {}).publisher || ""}）的「${strand ? strand[1] : item.strand}」：
- 小节标题（原书为英文）：${item.en}
- 中文说法：${item.zh}
- 这一章在学什么（Big Idea）：${bigIdea}`
    : isCourse
    ? `知识点来自加拿大 BC 省高中数学课程 ${courseTitle.en || gradeData.courseId}（${courseTitle.zh || ""}，Grade ${g}）的「${strand ? strand[1] : item.strand}」单元：
- 官方原文：${item.en}
- 中文说法：${item.zh}${bigIdea ? "\n- 这个单元为什么学它（Big Idea）：" + bigIdea : ""}`
    : `知识点来自加拿大 BC 省 Grade ${g} 数学大纲（${strand ? strand[1] : item.strand}主线）：
- 官方原文：${item.en}
- 中文说法：${item.zh}
- 这学期为什么学它（Big Idea）：${bigIdea}`;
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
  const who = isCourse
    ? `你是「圆圆老师」，一位给 BC 高中 ${courseTitle.en || gradeData.courseId} 课（${GRADE_ZH[g] || g}年级）的学生讲数学的${st.personaZh}，说地道、亲切的中文。`
    : `你是「圆圆老师」，一位给 BC ${GRADE_ZH[g] || g}年级孩子讲数学的${st.personaZh}，说地道、亲切的中文。`;
  return `${who}${name}

这节课不是讲一道题，而是给${isCourse ? "学生" : "孩子"}讲一个新知识点，像一节小视频课。
${origin}${elabs ? "\n- 包含子技能：\n" + elabs : ""}${terms ? "\n- 术语对照：" + terms : ""}${style}${ref}

铁律：
1. 准确第一。动笔前把每一步算术都验算一遍，答案必须正确。这是给一个真实的孩子看的，算错比不讲更糟。
2. 一步只讲一个小意思，语气鼓励、口语化，多用生活里的例子（${st.exZh || "分披萨、用加元买东西、量身高"}）。
3. 例题驱动，不空泛：每个概念都要落到具体的数字和例子上。${st.toneZh}

课的结构（仍然输出 5-8 步 steps）：
1. 用生活例子引出这个概念（为什么有它、它解决什么问题）
2. 讲清楚核心方法，配图${hints}
3. 带着${isCourse ? "学生" : "孩子"}做 1-2 个由浅入深的小例题
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
  const bigIdea = bigIdeaText(gradeData, item.strand, "en");
  const elabs = (item.elaborations || []).map(e => "  · " + e.en).join("\n");
  const hintTypes = (String(item.teachHints || "").match(/[A-Za-z]+/g) || []).join(", ");
  const hints = hintTypes ? ` (for this concept, prefer these visuals: ${hintTypes})` : "";
  const isBook = gradeData.type === "book";
  const isCourse = isCourseData(gradeData);
  const courseTitle = (gradeData.title || {});
  const strandDef = (isBook || isCourse) ? (gradeData.strandDefs || []).find(s => s[0] === item.strand) : null;
  const origin = isBook
    ? `The concept comes from the math book "${(gradeData.title || {}).en || gradeData.bookId}" (${(gradeData.source || {}).publisher || ""}), ${strandDef ? strandDef[2] : item.strand}:
- Section: ${item.en}
- What this chapter is about (Big Idea): ${bigIdea}`
    : isCourse
    ? `The concept comes from the British Columbia high-school course "${courseTitle.en || gradeData.courseId}" (Grade ${g}), unit "${strandDef ? strandDef[2] : item.strand}":
- Official wording: ${item.en}${bigIdea ? "\n- Why this unit matters (Big Idea): " + bigIdea : ""}`
    : `The concept comes from the British Columbia Grade ${g} Mathematics curriculum (${item.strand} strand):
- Official wording: ${item.en}
- Why it matters this term (Big Idea): ${bigIdea}`;
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
  const who = isCourse
    ? `You are "Ms. Yuanyuan", a kind ${st.personaEn} explaining math to a BC student taking ${courseTitle.en || gradeData.courseId} (Grade ${g}), in natural, warm, everyday English.`
    : `You are "Ms. Yuanyuan", a kind ${st.personaEn} explaining math to a BC Grade ${g} child, in natural, warm, everyday English.`;
  return `${who} ${name}

This lesson is not about solving one problem — you are teaching the ${isCourse ? "student" : "child"} a new concept, like a little video class.
${origin}${elabs ? "\n- Sub-skills included:\n" + elabs : ""}${style}${ref}

Iron rules:
1. Accuracy first. Re-check every bit of arithmetic before writing. The answer must be correct — a real child is watching, and getting it wrong is worse than not teaching at all.
2. One small idea per step. Encouraging, conversational tone; use everyday examples (${st.exEn || "sharing pizza, shopping with dollars, measuring heights"}).
3. Drive the lesson with worked examples — never stay abstract; always land on concrete numbers.${st.toneEn}

Lesson structure (still output 5-8 steps):
1. Open with a real-life example that shows why this concept exists and what problem it solves
2. Teach the core method clearly, with pictures${hints}
3. Walk the ${isCourse ? "student" : "child"} through 1-2 worked examples, from easy to slightly harder
4. End with a one-line takeaway
Use BC-flavoured everyday contexts where natural (Canadian dollars, metric units, local life).

${lessonFieldsEn()}
- answer: the one-line takeaway of this lesson, short and memorable — shown prominently.
- practice: one practice problem matching this concept (question + answer), set in a BC everyday context (dollars, metric units).

Teach just this one concept, in the easiest possible way.`;
}

const JSON_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。字符串值里不要出现英文双引号 "（要引用词语用「」或“”），反斜杠要写成 \\\\（如 \\\\frac）。JSON 必须符合这个结构：
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|pie|numberLine|areaGrid|barModel|groups|shapeRect|shapeTriangle|shapeCircle|clock|placeValue|balance|pieChart|solidCuboid|solidCube|solidCylinder|solidCone|solidSphere|netCuboid|netCylinder|statBar|statLine|average|spinner|balls|stemLeaf|stackedBar|histogram|coordGrid|angle|areaModel|baseTen|hundredthsGrid|hundredChart|dataTable|probLine|funcGraph|rightTriangle|triangle|unitCircle","nums":[数字...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes or “ ” to quote words), and escape every backslash as \\\\ (e.g. \\\\frac). It must match this structure:
{"title":"...","isMath":true,"steps":[{"say":"...","math":"...","visual":{"type":"none|fractionBar|pie|numberLine|areaGrid|barModel|groups|shapeRect|shapeTriangle|shapeCircle|clock|placeValue|balance|pieChart|solidCuboid|solidCube|solidCylinder|solidCone|solidSphere|netCuboid|netCylinder|statBar|statLine|average|spinner|balls|stemLeaf|stackedBar|histogram|coordGrid|angle|areaModel|baseTen|hundredthsGrid|hundredChart|dataTable|probLine|funcGraph|rightTriangle|triangle|unitCircle","nums":[numbers...],"labels":["..."],"caption":"..."}}],"answer":"...","practice":{"question":"...","answer":"..."}}`
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

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。字符串值里不要出现英文双引号 "（要引用词语用「」或“”），反斜杠要写成 \\\\（如 \\\\frac）。结构：
{"title":"...","questions":[{"curriculumId":"BC.MATH...","question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes or “ ” to quote words), and escape every backslash as \\\\ (e.g. \\\\frac):
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

/* ---------------- 单元测试（P6）----------------
 * 一个「单元」= 大纲里的一条主线（Number / Patterning…）或教材里的一章（ch01…），
 * 也就是「跟大纲学」清单里的一个分组。学完一个单元出一张卷收尾。
 * 和另外两种练习分工不同：
 *   闯关（P5）= 单个知识点、自适应升降难度、通关标 solid；
 *   FSA（P4）= 跨主线的全省测评风格，只有 G4/G7 有；
 *   单元测试 = 覆盖整个单元的章节测验，任何年级、任何教材都能出，用来找「这一章还有哪里没学会」。
 * 每题挂本单元的 curriculumId + 难度 level，答错能直接转讲解。 */
const UNIT_TEST_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" },
    questions: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          curriculumId: { type: "string" },
          level: { type: "number" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answerIndex: { type: "number" },
          explain: { type: "string" }
        }, required: ["curriculumId", "level", "question", "options", "answerIndex", "explain"]
      }
    }
  }, required: ["title", "questions"]
};
const UNIT_TEST_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。字符串值里不要出现英文双引号 "（要引用词语用「」或“”），反斜杠要写成 \\\\（如 \\\\frac）。结构：
{"title":"...","questions":[{"curriculumId":"BC.MATH...","level":1,"question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes or “ ” to quote words), and escape every backslash as \\\\ (e.g. \\\\frac):
{"title":"...","questions":[{"curriculumId":"BC.MATH...","level":1,"question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`
};

/* 出题提示词里「干扰项要来自真实错因」的例子：小学和中学/高中的典型错法不一样，按年级换一组 */
function distractorHint(gradeData, lang) {
  const g = Number(gradeData && gradeData.grade) || 0;
  if (g >= 8) return lang === "en"
    ? "sign errors with negatives, dropping a negative exponent or treating x^0 as 0, forgetting the ± or an extraneous root, mixing up slope and intercept, a wrong-order operation"
    : "负号处理错、负指数或零次幂算错、开方漏了 ±、没排除增根、斜率和截距弄反、运算顺序错";
  return lang === "en"
    ? "forgot to regroup, mixed up perimeter and area, skipped a unit conversion, added denominators straight across"
    : "忘了进位、周长面积混淆、单位没换算、分母直接相加";
}

/* 一卷的难度配比：基础 ≈ 3/8、挑战 ≈ 1/4、其余应用。8 题 = 3/3/2 */
function unitTestMix(count) {
  const l1 = Math.ceil(count * 0.375);
  const l3 = Math.max(1, Math.floor(count * 0.25));
  return { 1: l1, 2: Math.max(1, count - l1 - l3), 3: l3 };
}

function unitTestPrompt(gradeData, strand, lang, count) {
  const g = gradeData.grade;
  const items = (gradeData.items || []).filter(it => it.strand === strand);
  const def = (gradeData.strandDefs || STRANDS).find(s => s[0] === strand) || ["", strand, strand];
  const isBook = gradeData.type === "book";
  const isCourse = isCourseData(gradeData);
  const mix = unitTestMix(count);
  const bookName = (gradeData.title || {});
  const trap = distractorHint(gradeData, lang);
  if (lang === "en") {
    const list = items.map(it => `${it.id} | ${it.en}${(it.elaborations || []).length ? ` — ${it.elaborations.map(e => e.en).join("; ").slice(0, 260)}` : ""}`).join("\n");
    const who = isBook
      ? `You are a math teacher writing the end-of-chapter test for "${def[2]}" from the book "${bookName.en || gradeData.bookId}", taken by a Grade ${g} child in BC, Canada.`
      : isCourse
      ? `You are a BC high-school math teacher writing the end-of-unit test for the unit "${def[2]}" of the course "${bookName.en || gradeData.courseId}" (Grade ${g}).`
      : `You are a BC math teacher writing an end-of-unit test for the Grade ${g} "${def[2]}" strand.`;
    return `${who} The child has just finished this ${isBook ? "chapter" : "unit"} and takes the test on a tablet, one question at a time. Write ${count} original multiple-choice questions.

Difficulty mix (put the easy ones first, hardest last): ${mix[1]} at Level 1, ${mix[2]} at Level 2, ${mix[3]} at Level 3.
- Level 1 (basic): one step, direct use of the idea; checks "did you get it".
- Level 2 (application): standard textbook difficulty, 1-2 steps, a small real-life context or choosing the right method.
- Level 3 (challenge): a real-life scenario needing at least two reasoning steps, or a question built around the most common misconception in this ${isBook ? "chapter" : "unit"}.

Iron rules:
1. Cover the whole ${isBook ? "chapter" : "unit"}: spread the questions across the topics below, ${items.length >= count ? "each topic at most once" : "each topic at least once"}. Tag every question with the single best-matching curriculumId from this list — no other ids.
2. Exactly 4 options, exactly 1 correct. Distractors must come from real common mistakes (${trap}) — never obviously wrong.
3. answerIndex is the index (0-3) of the correct option. Scatter the correct positions across the paper.
4. Numbers must be computable by hand and age-appropriate; dollars and metric units; scenes from a BC child's life.
5. Accuracy first: re-check every question so exactly one option is correct.
6. explain: one or two sentences — the correct method plus the most common trap. It is shown on the score report, so write it to teach.
7. title: name the paper after the ${isBook ? "chapter" : "unit"} (e.g., "${def[2]} · Unit Test").

Topics in this ${isBook ? "chapter" : "unit"} (curriculumId | ${isBook ? "section" : "official wording"}):
${list}`;
  }
  const list = items.map(it => `${it.id} | ${it.en} | ${it.zh}${(it.elaborations || []).length ? ` — ${it.elaborations.map(e => e.zh || e.en).join("；").slice(0, 260)}` : ""}`).join("\n");
  const whoZh = isBook
    ? `你是数学出题老师，为教材《${bookName.zh || bookName.en || gradeData.bookId}》的「${def[1]}」出一张章末测验；孩子在加拿大 BC 上 Grade ${g}。`
    : isCourse
    ? `你是 BC 省的高中数学出题老师，为 ${bookName.en || gradeData.courseId}（${bookName.zh || ""}，Grade ${g}）课程的「${def[1]}」单元出一张单元测验。`
    : `你是 BC 省的数学出题老师，为 Grade ${g}「${def[1]}」这条主线出一张单元测验。`;
  return `${whoZh}孩子刚学完这个${isBook ? "章" : "单元"}，在平板上一道一道做。请出 ${count} 道原创选择题。

难度配比（简单的排前面，最难的压轴）：L1 ${mix[1]} 道、L2 ${mix[2]} 道、L3 ${mix[3]} 道。
- L1 基础：单步、直接套用本单元的概念，检查「听懂了没」。
- L2 应用：标准课本难度，1-2 步，带简单生活情境或需要自己选方法。
- L3 挑战：需要至少两步推理的真实情境题，或针对本${isBook ? "章" : "单元"}最常见误区的辨析题。

出题铁律：
1. 覆盖整个${isBook ? "章" : "单元"}：题目要分散到下面的知识点上，${items.length >= count ? "同一个知识点最多出 1 题" : "每个知识点至少 1 题"}。每题标注一个最贴合的 curriculumId，只能从下面这份清单里选。
2. 每题恰好 4 个选项、恰好 1 个正确。干扰项必须来自真实常见错误（${trap}），不要一眼假。
3. answerIndex 是正确选项的下标（0~3），整卷正确答案的位置要打散，别集中在同一个下标。
4. 数字口算/竖式能算动、适龄；货币用加元、单位用公制，情境用孩子在 BC 的真实生活。
5. 准确第一：每题出完自己验算一遍，确认有且只有一个选项正确。
6. explain 一两句话：正确解法 + 最容易踩的坑。成绩单上会逐题展示，要写得能教会人。
7. title 用${isBook ? "章" : "单元"}名（如「${def[1]} · 单元测试」）。
8. 题干用中文，关键数学术语可自然带一次英文对照（如「周长（perimeter）」）。

本${isBook ? "章" : "单元"}的知识点清单（curriculumId | ${isBook ? "原书小节" : "官方原文"} | 中文）：
${list}`;
}

/* 单元测试校验：题目只认本单元的 curriculumId（挂到别的单元就没法按单元统计了），
 * level 越界夹回 1~3。答对/答错由服务端按 answerIndex 判，所以下标绝不能错位（教训同 FSA）。 */
function validateUnitTest(set, gradeData, strand, count) {
  if (!set || typeof set !== "object") throw new Error("出卷格式不对");
  const ids = new Set((gradeData.items || []).filter(it => it.strand === strand).map(it => it.id));
  const qs = (Array.isArray(set.questions) ? set.questions : []).map(q => {
    if (!q || typeof q !== "object") return null;
    const options = Array.isArray(q.options) ? q.options.map(o => String(o == null ? "" : o).trim()) : [];
    const ai = Math.round(Number(q.answerIndex));
    if (!String(q.question || "").trim() || options.length !== 4 || options.some(o => !o) || !(ai >= 0 && ai <= 3)) return null;
    const lv = Math.round(Number(q.level));
    return {
      curriculumId: ids.has(q.curriculumId) ? q.curriculumId : "",   // 不属于本单元就置空，前端不给「转讲解」按钮
      level: lv >= 1 && lv <= 3 ? lv : 2,
      question: unlitNewline(q.question).trim(),
      options: options.map(unlitNewline),
      answerIndex: ai,
      explain: unlitNewline(q.explain).trim()
    };
  }).filter(Boolean);
  if (qs.length < Math.max(4, Math.ceil(count * 0.7))) throw new Error("这卷有效题目太少");
  // 挂不上知识点的题占一半以上 = 这卷没按单元出，重试比将就好
  if (qs.filter(q => q.curriculumId).length < Math.ceil(qs.length / 2)) throw new Error("这卷没对上本单元的知识点");
  qs.sort((a, b) => a.level - b.level);   // 简单的排前面，压轴题放最后
  return { title: String(set.title || "").trim(), questions: qs.slice(0, count) };
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

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。字符串值里不要出现英文双引号 "（要引用词语用「」或“”），反斜杠要写成 \\\\（如 \\\\frac）。结构：
{"questions":[{"level":1,"question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes or “ ” to quote words), and escape every backslash as \\\\ (e.g. \\\\frac):
{"questions":[{"level":1,"question":"...","options":["...","...","...","..."],"answerIndex":0,"explain":"..."}]}`
};

function qbankPrompt(item, gradeData, lang, needs, existingStems) {
  const g = gradeData.grade;
  const strand = (gradeData.strandDefs || STRANDS).find(s => s[0] === item.strand) || ["", item.strand, item.strand];
  const wants = [1, 2, 3].filter(lv => needs[lv]);
  const total = wants.reduce((s, lv) => s + needs[lv], 0);
  const avoid = (existingStems || []).slice(0, 30);
  const isBook = gradeData.type === "book";
  const isCourse = isCourseData(gradeData);
  const trap = distractorHint(gradeData, lang);
  if (lang === "en") {
    const elab = (item.elaborations || []).map(e => "- " + e.en).join("\n");
    const terms = itemTerms(item).map(tm => tm.en).join(", ");
    const who = isBook
      ? `You are a math teacher building a question bank for ONE section of the book "${(gradeData.title || {}).en || gradeData.bookId}" (${strand[2]}), studied by a Grade ${g} child in BC, Canada.`
      : isCourse
      ? `You are a BC high-school math teacher building a question bank for ONE topic of the course "${(gradeData.title || {}).en || gradeData.courseId}" (Grade ${g}, unit "${strand[2]}").`
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
2. Exactly 4 options, exactly 1 correct. Distractors come from real common mistakes (${trap}) — never obviously wrong.
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
    : isCourse
    ? `你是 BC 省的高中数学出题老师，为 ${(gradeData.title || {}).en || gradeData.courseId}（${(gradeData.title || {}).zh || ""}，Grade ${g}）课程「${strand[1]}」单元里的一个知识点建题库。`
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
2. 每题恰好 4 个选项、恰好 1 个正确。干扰项必须来自真实常见错误（${trap}），不要一眼假。
3. answerIndex 是正确选项的下标（0~3），整批正确答案的位置要打散，别集中在同一个下标。
4. 数字口算/竖式能算动、适龄；货币用加元、单位用公制，情境用孩子在 BC 的真实生活。
5. 准确第一：每题出完自己验算一遍，确认有且只有一个选项正确。
6. explain 一两句话：正确解法 + 最容易踩的坑。孩子答错后马上会看到，要写得能教会人。
7. 题干用中文，关键数学术语可自然带一次英文对照（如「周长（perimeter）」）。
8. 这批题互相不能重复${avoid.length ? `，也不能和题库里已有的这些题重复：
${avoid.map(s => "- " + s).join("\n")}` : ""}。`;
}

/* 题干里的换行：模型常把换行写成字面量 \n（反斜杠加 n）塞进字符串，前端会原样显示两个字符，换成真换行 */
const unlitNewline = s => String(s == null ? "" : s).replace(/\\n/g, "\n");
function validateQbankBatch(raw, requested) {
  if (!raw || typeof raw !== "object") throw new Error("出题格式不对");
  const qs = (Array.isArray(raw.questions) ? raw.questions : []).map(q => {
    if (!q || typeof q !== "object") return null;
    // answerIndex 指向 options 原数组，绝不能过滤/截断（教训同 FSA：下标一错位就把答对判成答错）
    const options = Array.isArray(q.options) ? q.options.map(o => unlitNewline(o).trim()) : [];
    const ai = Math.round(Number(q.answerIndex));
    const lv = Math.round(Number(q.level));
    if (!String(q.question || "").trim() || options.length !== 4 || options.some(o => !o)
      || !(ai >= 0 && ai <= 3) || !(lv >= 1 && lv <= QUIZ_TOP_LEVEL)) return null;
    return { level: lv, question: unlitNewline(q.question).trim(), options, answerIndex: ai, explain: unlitNewline(q.explain).trim() };
  }).filter(Boolean);
  if (qs.length < Math.max(3, Math.ceil(requested * 0.5))) throw new Error("有效题目太少");
  return qs;
}

/* ---------------- 构建期审稿（pregen --judge） ----------------
 * 便宜引擎跑批生成，强引擎只当审稿人：读一遍、判过/不过、列出问题。
 * 审稿输入长输出短，比让强引擎自己写一遍便宜得多；审稿的账单独记
 * （judge:teach / judge:quiz / judge:unit），在 /api/usage 里能直接算
 * 「便宜引擎生成 + 强引擎审 + 重来」的总价和让强引擎直接写的差价。 */
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    problems: { type: "array", items: { type: "string" } }
  },
  required: ["pass", "problems"]
};
const JUDGE_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。字符串值里不要出现英文双引号 "（要引用词语用「」或“”），反斜杠要写成 \\\\（如 \\\\frac）：
{"pass":true或false,"problems":["发现的问题，一条一句；没有就给空数组"]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes or “ ” to quote words), and escape every backslash as \\\\ (e.g. \\\\frac):
{"pass":true or false,"problems":["one issue per string; empty array if none"]}`
};

function judgeCommon(lang, gradeData) {
  const senior = Number(gradeData && gradeData.grade) >= 8;
  return L(lang,
`你是一位严格的${senior ? "中学数学" : "小学数学"}教研审稿人。下面是自动生成、要发给${senior ? "学生" : "孩子"}的内容，请逐项核查：
1. 数学必须全对：每一步计算、每个最终答案、每道选择题标的正确选项，错一处就不能过；
   标成正确答案的选项必须真的对，其余选项必须真的错。
2. 内容要贴住指定的知识点和年级，不能跑题、不能明显超纲。
3. 讲法不能引入会误导孩子的说法。
只报真问题：风格和口味上的小瑕疵放过，数学错误和跑题一个都不能放。
判定：有任何数学错误或明显跑题 → pass=false，problems 里一条一句写清哪里错、为什么错；
否则 pass=true（problems 给空数组）。`,
`You are a strict ${senior ? "secondary-math" : "elementary-math"} content reviewer. The content below was auto-generated for a ${senior ? "student" : "child"}. Check:
1. The math must be entirely correct: every step, every final answer, and for multiple choice the
   option marked correct must truly be correct and the other options truly wrong. One error fails it.
2. The content must stay on the given curriculum topic and grade level.
3. No explanation may teach the child something misleading.
Report real problems only: let style quibbles pass; never let a math error or off-topic drift pass.
Verdict: any math error or clear off-topic drift → pass=false with one issue per problems entry
(where and why); otherwise pass=true with an empty problems array.`);
}
const gradeTag = d => d.type === "book" ? String(d.bookId || "") : isCourseData(d) ? String(d.courseId || "") + " (Grade " + d.grade + ")" : "G" + d.grade;

function judgeLessonPrompt(item, gradeData, lesson, lang) {
  return judgeCommon(lang, gradeData)
    + "\n\n" + L(lang, "知识点（", "Curriculum item (") + gradeTag(gradeData) + "）：" + item.zh + " / " + item.en
    + "\n\n" + L(lang, "待审的讲课内容（JSON，steps 是一步步的讲解，practice 是课后练习）：\n",
                       "Lesson under review (JSON; steps are the walkthrough, practice is the follow-up exercise):\n")
    + JSON.stringify(lesson);
}
function judgeQuizPrompt(item, gradeData, questions, lang) {
  return judgeCommon(lang, gradeData)
    + "\n\n" + L(lang, "知识点（", "Curriculum item (") + gradeTag(gradeData) + "）：" + item.zh + " / " + item.en
    + "\n\n" + L(lang, "待审的选择题（JSON，answerIndex 指向 options 里标为正确的那项）：\n",
                       "Multiple-choice questions under review (JSON; answerIndex marks the correct option):\n")
    + JSON.stringify(questions);
}
function judgeUnitPrompt(gradeData, strand, set, lang) {
  return judgeCommon(lang)
    + "\n\n" + L(lang, "单元（", "Unit (") + gradeTag(gradeData) + "）：" + strand
    + "\n\n" + L(lang, "待审的单元测试卷（JSON，answerIndex 指向 options 里标为正确的那项）：\n",
                       "Unit test under review (JSON; answerIndex marks the correct option):\n")
    + JSON.stringify(set);
}

function validateJudge(v) {
  if (!v || typeof v !== "object" || typeof v.pass !== "boolean") throw new Error("审稿结果格式不对");
  const problems = (Array.isArray(v.problems) ? v.problems : []).map(p => String(p == null ? "" : p).trim()).filter(Boolean).slice(0, 10);
  return { pass: v.pass, problems };
}

/* ---------------- 工具函数 ---------------- */
const L = (lang, zh, en) => lang === "en" ? en : zh;
/* 请求里的 lang 归一：只认 "zh"，其余一律英文（面向英文学校的孩子） */
const normLang = l => l === "zh" ? "zh" : "en";

/* 模型手写 JSON 最常见的毛病：字符串里夹着没转义的英文双引号（中文课文爱用 "..." 引东西）和裸换行。
 * 修法：逐字符走一遍，字符串内遇到 " 时往后看——后面（跳过空白）不是 , } ] : 之一，就当它是正文里的引号转义掉。
 * 只在 JSON.parse 失败后才走这条路，修不好照旧抛错让上层重试。 */
function repairJson(t) {
  let out = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) {
      if (c === '"') {
        // qwen 的一个固定毛病：数字值后面多粘一个引号（"level":2"，"answerIndex":1"）——前面是个值、后面紧跟 , } ] 就丢掉它
        const prev = out.replace(/\s+$/, "").slice(-1);
        let j = i + 1; while (j < t.length && /\s/.test(t[j])) j++;
        if (/[0-9el]/.test(prev) && j < t.length && ",}]".includes(t[j])) continue;
        inStr = true;
      }
      out += c; continue;
    }
    if (c === "\\") {
      // 字符串里的反斜杠：合法 JSON 转义原样过；\frac \times \begin 这种 LaTeX 命令（\f \t \b \n \r 后面紧跟字母）
      // 和 \( \s \c 这类非法转义，都是模型忘了双写反斜杠，补一个
      const n = t[i + 1] || "";
      const validJson = '"\\/bfnrtu'.includes(n);
      const latexLike = /[fbnrt]/.test(n) && /[A-Za-z]/.test(t[i + 2] || "");
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(i + 2, i + 6))) { out += "\\u"; i++; continue; }
      if (!validJson || latexLike || n === "u") { out += "\\\\"; continue; }
      out += c + n; i++; continue;
    }
    if (c === "\n") { out += "\\n"; continue; }
    if (c === "\r" || c === "\t") { out += c === "\t" ? "\\t" : ""; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && /\s/.test(t[j])) j++;
      if (j >= t.length || ",}]:".includes(t[j])) { inStr = false; out += c; }
      else out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}
function extractJson(text) {
  if (!text) throw new Error("引擎没有返回内容");
  let t = String(text);
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) t = fenced[1];
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("返回内容里找不到 JSON");
  const body = t.slice(s, e + 1);
  try { return JSON.parse(body); }
  catch (err) {
    try { return JSON.parse(repairJson(body)); }
    catch (_) { throw err; }
  }
}

/* math 字段要的是裸 LaTeX（前端直接 katex.render）。本地模型爱带 $$…$$ / \[…\] / \(…\) 定界符，
 * KaTeX 会把 $ 当错误字符整段标红，所以进包前剥掉外层定界符；里面的内容一字不动。 */
function stripMathDelims(m) {
  // 模型把换行写成字面量 \n 塞进 LaTeX（KaTeX 报 Undefined control sequence \n），换成 LaTeX 的换行 \\；
  // \nabla、\neq、\not 这类以 n 开头的真命令后面跟字母，不会被误伤
  let t = String(m || "").replace(/\\n(?![A-Za-z])/g, " \\\\ ").replace(/\\r(?![A-Za-z])/g, " ").trim();
  for (;;) {
    const u = t
      .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
      .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
      .replace(/^\\\(([\s\S]*)\\\)$/, "$1")
      .replace(/^\$([^$]*)\$$/, "$1")
      .trim();
    if (u === t) return t;
    t = u;
  }
}
function validateLesson(l) {
  if (!l || typeof l !== "object") throw new Error("讲解格式不对");
  if (!Array.isArray(l.steps) || l.steps.length === 0) throw new Error("讲解里没有步骤");
  l.title = String(l.title || "这道题");
  l.isMath = l.isMath !== false;
  l.answer = String(l.answer || "");
  l.steps = l.steps.slice(0, 12).map(s => ({
    say: String((s && s.say) || ""),
    math: stripMathDelims(s && s.math),
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
    options: { num_predict: 16384 },   // 含思考 token：思考长一点的题也别把 JSON 截断
    keep_alive: "30m"
  };
  if (structured) body.format = opts.schema || LESSON_SCHEMA;
  if (cfg.ollama.think === false) body.think = false;
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
    const out = await runCmd(detected.claude.bin, ["-p", prompt, "--output-format", "json"], { cwd: dir, timeout: 300000 });
    const env = JSON.parse(out.slice(out.indexOf("{")));
    if (opts.meta && env.usage) {   // claude CLI 的 JSON 信封自带用量和美元花费，白给的账不记白不记
      const u = env.usage;
      opts.meta.tokensIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      opts.meta.tokensOut = u.output_tokens || 0;
      if (env.total_cost_usd != null) opts.meta.costUsd = env.total_cost_usd;
      const mm = Object.keys(env.modelUsage || {});
      if (mm.length) opts.meta.model = mm.join("+");
    }
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

/* ---------------- 语音合成（CosyVoice 等本地 TTS，可选） ----------------
 * 思路来自 vediotube-videogen：config 声明一条本地命令，服务器只管「文本进、wav 出」。
 * 这里按整节课批量提交（tools/tts_batch.py 一次加载模型合成全部步骤），
 * 结果按内容哈希落盘缓存；文件出现 = 就绪。没配置或失败时前端自动退回浏览器语音。 */
const TTS_CACHE = path.resolve(DATA_ROOT, (cfg.tts && cfg.tts.cacheDir) || "tts-cache");
const TTS_FAIL_TTL = 5 * 60 * 1000;
const ttsInFlight = new Set();     // 已排队/正在合成的 id
const ttsFailed = new Map();       // id -> 失败时间（TTL 内不重试，前端走兜底）
let ttsChain = Promise.resolve();  // 单队列：同一时刻只跑一个合成进程，防止模型重复加载挤显存

/* 能不能「现场合成」：CosyVoice 守护进程或命令。随包发的语音包是成品，不算引擎。 */
function ttsEngineAvailable() {
  const t = cfg.tts;
  if (!t || t.enabled === false) return false;
  if (t.url) return true;   // 守护进程模式；真实可达性在合成时体现，失败会走兜底
  if (!Array.isArray(t.command) || t.command.length < 2) return false;
  const bin = t.command[0];
  return path.isAbsolute(bin) ? fs.existsSync(bin) : !!which(bin);
}
/* 前端问的是「有没有自然语音可放」：随包发的语音包也算，哪怕这台机器一个引擎都没有。 */
function ttsAvailable() {
  if (cfg.tts && cfg.tts.enabled === false) return false;
  return ttsEngineAvailable() || voicePack.size > 0;
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

/* ---------------- 预烘语音包（安装包随附，只读） ----------------
 * data/voice/<和 ttsId 同一套 sha1>.m4a —— 构建期由 tools/prevoice.mjs 生成。
 * 和 tts-cache 共用命名，所以两者天然共存：先查现场缓存的 .wav，再查包。
 * 包是只读的，ttsPruneCache 只清 tts-cache，永远不会把它删掉。
 * 启动时扫一遍建索引：包随安装包发，跑起来之后不会变。 */
const VOICE_PACK_DIR = path.join(ROOT, "data", "voice");
const VOICE_MIME = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" };
const voicePack = new Map();   // sha1 -> 绝对路径
try {
  for (const f of fs.readdirSync(VOICE_PACK_DIR)) {
    const ext = path.extname(f).toLowerCase();
    const id = path.basename(f, ext);
    if (VOICE_MIME[ext] && /^[a-f0-9]{40}$/.test(id) && !voicePack.has(id)) voicePack.set(id, path.join(VOICE_PACK_DIR, f));
  }
} catch (_) { /* 没有语音包，全走现场合成 / 浏览器语音 */ }
function voicePackPath(id) { return voicePack.get(id) || null; }

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
  console.log(`[tts] synthesizing ${pend.length} clip(s)...`);
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
    console.log(`[tts] done ${ok}/${items.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
    ttsPruneCache();
  }
}

/* 守护进程模式：逐条 POST /synth，模型常驻所以每条只要几秒；
 * 连挂两条视为守护进程不在，剩下的直接判失败让前端走兜底 */
async function ttsRunJobDaemon(items, pend) {
  const base = cfg.tts.url.replace(/\/$/, "");
  const t0 = Date.now();
  console.log(`[tts] daemon synthesizing ${pend.length} clip(s)...`);
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
      console.log(`[tts] ${it.id.slice(0, 8)} failed: ${e.message}`);
    }
  }
  let ok = 0;
  for (const it of items) {
    ttsInFlight.delete(it.id);
    if (fs.existsSync(ttsWavPath(it.id))) ok++;
    else ttsFailed.set(it.id, Date.now());
  }
  console.log(`[tts] done ${ok}/${items.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
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
    if (fs.existsSync(ttsWavPath(id)) || voicePack.has(id)) state = "ready";
    else if (!ttsEngineAvailable()) state = "failed";   // 只有语音包、没有合成引擎：包外的文本直接兜底，别让前端空等
    else if (ttsInFlight.has(id)) state = "pending";
    else if (ttsFailed.has(id) && now - ttsFailed.get(id) < TTS_FAIL_TTL) state = "failed";
    else { state = "pending"; ttsFailed.delete(id); submit.push({ id, text, lang }); }
    out.push({ id, state, url: "/api/tts/audio/" + id + ".wav" });
  }
  if (submit.length) ttsSubmit(submit);
  return out;
}

/* ---------------- 按孩子分桶的学习数据 ----------------
 * 每个孩子一个目录 data/kids/<kidId>/，四个 JSON 各司其职：
 *   history.json   讲过的课（完整讲解 JSON，可重播）      上限 500
 *   progress.json  知识点进度（taught/right/wrong/solid…）
 *   fsa-sets.json  FSA 模拟卷 + 每次成绩                   上限 100
 *   reports.json   家长生成的完整学习报告                   上限 50
 * qbank.json（闯关题库）仍是全局共享：题按知识点缓存，多孩子复用省 LLM 费用。
 * 全部沿用原子写（.tmp + rename）。旧版根目录的三个单例文件在创建第一个孩子时自动迁入。 */
const KIDS_DIR = path.join(DATA_ROOT, "data", "kids");
const HISTORY_MAX = 500;
const FSA_SETS_MAX = 100;
const UNIT_TESTS_MAX = 100;
const REPORTS_MAX = 50;
const KID_FILES = { history: [], progress: {}, fsaSets: [], unitTests: [], reports: [] };
const KID_FILE_NAMES = { history: "history.json", progress: "progress.json", fsaSets: "fsa-sets.json", unitTests: "unit-tests.json", reports: "reports.json" };
const kidData = new Map();   // kidId -> { history:[], progress:{}, fsaSets:[], unitTests:[], reports:[] }

function kidDir(kidId) { return path.join(KIDS_DIR, String(kidId)); }

function kidLoad(kidId) {
  const bucket = {};
  for (const [key, empty] of Object.entries(KID_FILES)) {
    let v = Array.isArray(empty) ? [] : {};
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(kidDir(kidId), KID_FILE_NAMES[key]), "utf8"));
      if (Array.isArray(empty) ? Array.isArray(raw) : (raw && typeof raw === "object" && !Array.isArray(raw))) v = raw;
    } catch (_) { /* 该文件还没有数据 */ }
    bucket[key] = v;
  }
  kidData.set(String(kidId), bucket);
  return bucket;
}
try {
  for (const d of fs.readdirSync(KIDS_DIR)) {
    if (d.startsWith("_") || !fs.statSync(path.join(KIDS_DIR, d)).isDirectory()) continue;
    kidLoad(d);
  }
} catch (_) { /* 还没有孩子目录 */ }

/* 孩子的数据桶；账号存在但目录还没建（或被手工删了）时给空桶，首次写入落盘 */
function kd(kidId) { return kidData.get(String(kidId)) || kidLoad(kidId); }

function kidSave(kidId, key) {
  try {
    fs.mkdirSync(kidDir(kidId), { recursive: true });
    const f = path.join(kidDir(kidId), KID_FILE_NAMES[key]);
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(kd(kidId)[key]), "utf8");
    fs.renameSync(tmp, f);
  } catch (e) { console.log(`[kid:${kidId}] could not save ${KID_FILE_NAMES[key]}: ` + e.message); }
}

function newRecId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function historyAdd(kidId, rec) {
  rec.id = newRecId();
  const h = kd(kidId).history;
  h.unshift(rec);
  if (h.length > HISTORY_MAX) h.length = HISTORY_MAX;
  kidSave(kidId, "history");
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
/* 同一张 Map 放三种来源：数字 key = BC K-9 年级（grade-N.json）；
 * 字符串 key = 10-12 年级分科课程（course-<id>.json，type:"course"，BC 公开材料，随包发）
 *            或书籍课程（books/*.json，type:"book"，只留本地）。
 * 分科课程没有五大主线，自带 strandDefs（单元）——和书籍一样的形状，下游代码不用区分。 */
const curriculum = new Map();
try {
  for (const f of fs.readdirSync(CURRICULUM_DIR)) {
    const m = /^grade-(\d+)\.json$/.exec(f);
    const c = /^course-([a-z0-9-]+)\.json$/.exec(f);
    if (!m && !c) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CURRICULUM_DIR, f), "utf8"));
      if (m) curriculum.set(Number(m[1]), d);
      else if (d && d.type === "course" && Array.isArray(d.items)) curriculum.set(String(d.courseId || c[1]), d);
      else console.log(`[curriculum] ${f} ignored: not a course file (needs type:"course" and items[])`);
    } catch (e) { console.log(`[curriculum] ${f} failed to parse: ${e.message}`); }
  }
} catch (_) { /* 没有大纲数据也能跑，「跟大纲学」入口自动隐藏 */ }

/* 书籍课程源（data/curriculum/books/*.json）：和 BC 大纲同一张 Map，key 用字符串 bookId。
 * 结构兼容 grade-N.json，另带 type:"book"、strandDefs（章节代替五大主线）、teachStyle（原书讲法）。
 * 讲课/闯关/进度/报告全部走现有条目 id 机制；FSA 只认数字年级，书籍天然不出卷。 */
const BOOKS_DIR = path.join(ROOT, "data", "curriculum", "books");
/* YY_DEMO（Vercel 在线 demo，入口 api/index.js）不放书籍课程：demo 没有引擎，
 * 书籍小节又没有预生成课，列出来点进去全是死路。本地/打包运行不设这个变量，不受影响。 */
if (!process.env.YY_DEMO) try {
  for (const f of fs.readdirSync(BOOKS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, f), "utf8"));
      if (d && d.type === "book" && Array.isArray(d.items)) curriculum.set(String(d.bookId || f.replace(/\.json$/, "")), d);
    } catch (e) { console.log(`[curriculum] books/${f} failed to parse: ${e.message}`); }
  }
} catch (_) { /* 没有书籍数据也能跑 */ }
function curriculumGrades() { return [...curriculum.keys()].filter(k => typeof k === "number").sort((a, b) => a - b); }
function curriculumBooks() {
  return [...curriculum.entries()].filter(([k, d]) => typeof k === "string" && d.type === "book").map(([k, d]) => ({
    id: k, grade: d.grade || 0,
    zh: ((d.short || d.title || {}).zh) || k,
    en: ((d.short || d.title || {}).en) || k
  }));
}
/* 10-12 年级分科课程：按年级排，前端下拉接在 G9 后面 */
function curriculumCourses() {
  return [...curriculum.entries()].filter(([k, d]) => typeof k === "string" && d.type === "course").map(([k, d]) => ({
    id: k, grade: d.grade || 0,
    zh: ((d.short || d.title || {}).zh) || k,
    en: ((d.short || d.title || {}).en) || k,
    titleZh: (d.title || {}).zh || "", titleEn: (d.title || {}).en || ""
  })).sort((a, b) => a.grade - b.grade || a.id.localeCompare(b.id));
}
const isCourseData = d => !!d && d.type === "course";
/* 一个主线/单元的 Big Idea 文案：K-9 每主线恰好一条；分科课程一个单元可能挂多条（或零条），全带上 */
function bigIdeaText(gradeData, strand, lang) {
  return ((gradeData && gradeData.bigIdeas) || []).filter(b => b.strand === strand)
    .map(b => lang === "en" ? b.en : (b.zh || b.en)).filter(Boolean).join(lang === "en" ? " / " : "；");
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

/* ---------------- 预生成课程包（安装包随附） ----------------
 * data/lessons/<lang>/<条目id>.json = { lesson, provider, model, at }
 * 构建期由 tools/pregen.mjs 生成。teach 模式命中就直接返回：装完机器上没有
 * 任何 AI 引擎，「跟大纲学」照样能上课，而且秒开、不花钱、断网也行。
 * 想听不一样的讲法就传 fresh=true 现场重讲——那条路才需要引擎。 */
const LESSON_PACK_DIR = path.join(ROOT, "data", "lessons");
const lessonPackMemo = new Map();          // "<lang>/<id>" -> lesson | null（没有的也记，免得反复读盘）
function lessonPackGet(id, lang) {
  if (!id || (lang !== "zh" && lang !== "en")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;    // 条目 id 直接拼路径，先挡穿越
  const key = lang + "/" + id;
  if (lessonPackMemo.has(key)) return lessonPackMemo.get(key);
  let lesson = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(LESSON_PACK_DIR, lang, id + ".json"), "utf8"));
    lesson = validateLesson(raw && raw.lesson ? raw.lesson : raw);
  } catch (_) { lesson = null; }
  lessonPackMemo.set(key, lesson);
  return lesson;
}
function lessonPackCount() {
  let n = 0;
  for (const lang of ["zh", "en"]) {
    try { n += fs.readdirSync(path.join(LESSON_PACK_DIR, lang)).filter(f => f.endsWith(".json")).length; } catch (_) {}
  }
  return n;
}

/* 单元测试也随包发：内容只由（年级/教材, 单元, 语言）决定，和课程包一个道理。
 * 差别是卷子要按孩子存（各自的作答记录），所以命中之后仍然给每个孩子发一份副本。
 * data/unit-tests/<lang>/<年级或书id>-<单元>.json */
const UNIT_PACK_DIR = path.join(ROOT, "data", "unit-tests");
const unitPackMemo = new Map();
function unitPackGet(gradeKey, strand, lang) {
  if (!strand || (lang !== "zh" && lang !== "en")) return null;
  const stem = String(gradeKey) + "-" + strand;
  if (!/^[A-Za-z0-9._-]+$/.test(stem)) return null;
  const key = lang + "/" + stem;
  if (unitPackMemo.has(key)) return unitPackMemo.get(key);
  let set = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(UNIT_PACK_DIR, lang, stem + ".json"), "utf8"));
    const qs = (raw && raw.set && raw.set.questions) || (raw && raw.questions);
    if (Array.isArray(qs) && qs.length) set = { title: String((raw.set || raw).title || ""), questions: qs };
  } catch (_) { set = null; }
  unitPackMemo.set(key, set);
  return set;
}
function unitPackCount() {
  let n = 0;
  for (const lang of ["zh", "en"]) {
    try { n += fs.readdirSync(path.join(UNIT_PACK_DIR, lang)).filter(f => f.endsWith(".json")).length; } catch (_) {}
  }
  return n;
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

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
/* 三态：new（没学过）/ seen（讲过）/ solid（扎实），由下面的四级直接降维。
 * solid = 闯关通关（docs/qbank-standard.md §5），或不同日期答对 ≥2 次，或家长手动标记 */
function progressStatus(kidId, id) {
  const lv = progressLevel(kidId, id);
  return lv === "emerging" ? "new" : lv === "developing" ? "seen" : "solid";
}
/* BC 官方四级话术（2023 年起成绩单同款）：Emerging / Developing / Proficient / Extending。
 * 映射：new→emerging，seen→developing，solid→proficient；不同日期答对 ≥3 次→extending（solid+） */
function progressLevel(kidId, id) {
  const e = kd(kidId).progress[id];
  if (!e) return "emerging";
  const days = (e.rightDays || []).length;
  if (days >= 3) return "extending";
  if (e.solid || e.quizPassedAt || days >= 2) return "proficient";
  return (e.taught || e.right || e.wrong) ? "developing" : "emerging";
}
function progressRecord(kidId, id, event, lessonId) {
  const progress = kd(kidId).progress;
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
  kidSave(kidId, "progress");
  return e;
}
/* 只有家长能做的进度事件（孩子的自报对错等其余事件全员可用） */
const PARENT_ONLY_EVENTS = new Set(["mark-solid", "unmark-solid"]);
/* 只由服务端内部流程写的事件，不接受从 /api/progress 提交：
 * taught 由 /api/lesson 生成讲解时记，quiz-* 由 /api/quiz/finish 按题库结算记。
 * 放开的话孩子发一条 quiz-pass 就能把知识点直接标成 solid——题都不用看见。 */
const INTERNAL_EVENTS = new Set(["taught", "quiz-right", "quiz-wrong", "quiz-pass"]);

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

/* ---------------- FSA 卷持久化（按孩子，存 data/kids/<id>/fsa-sets.json） ----------------
 * 出一卷要跑一次 AI（约 2 分钟），所以生成一次就永久保存，
 * 之后直接打开做，不再重新出题；每次作答记一条成绩（attempts）。 */
function fsaSetsAdd(kidId, rec) {
  rec.id = newRecId();
  const sets = kd(kidId).fsaSets;
  sets.unshift(rec);
  if (sets.length > FSA_SETS_MAX) sets.length = FSA_SETS_MAX;
  kidSave(kidId, "fsaSets");
}
function fsaSetSummary(r) {
  return {
    id: r.id, time: r.time, grade: r.grade, strand: r.strand || "", lang: r.lang || "zh",
    title: r.title || "FSA", count: (r.questions || []).length,
    last: (r.attempts || [])[0] || null
  };
}

/* ---------------- 单元测试卷持久化（P6，data/kids/<id>/unit-tests.json） ----------------
 * 同 FSA：出一卷要跑一次 AI，生成后永久保存，之后点开直接做。
 * grade 这里是课程源的 key（数字年级或 bookId），配 strand 一起才能定位到「哪本书的哪一章」。 */
function unitTestsAdd(kidId, rec) {
  rec.id = newRecId();
  const list = kd(kidId).unitTests;
  list.unshift(rec);
  if (list.length > UNIT_TESTS_MAX) list.length = UNIT_TESTS_MAX;
  kidSave(kidId, "unitTests");
}
function unitTestSummary(r) {
  return {
    id: r.id, time: r.time, grade: String(r.grade), strand: r.strand || "", lang: r.lang || "zh",
    title: r.title || "", count: (r.questions || []).length,
    last: (r.attempts || [])[0] || null
  };
}

/* ---------------- 闯关题库持久化（P5）----------------
 * 出一批题要跑一次 AI，所以生成后永久保存（qbank.json，原子写同 progress.json）。
 * 做过的题打 usedAt，优先给没做过的题；不够自动补，封顶后按最久没做过复用。 */
const QBANK_FILE = path.join(DATA_ROOT, "qbank.json");
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
  } catch (e) { console.log("[quiz] could not save qbank.json: " + e.message); }
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

/* 随包种子题库：打包模式每次启动把 seed/qbank.json 里没见过的题并进来
 * （qbankMerge 按题干去重、每级封顶）。升级带来的新题就这样进用户题库，
 * 用户自己攒的题永远不丢。源码模式没有 seed/，天然跳过。 */
try {
  const seedFile = path.join(SEED_DIR, "qbank.json");
  if (DATA_ROOT !== ROOT && fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    let added = 0;
    if (seed && typeof seed === "object" && !Array.isArray(seed)) {
      for (const [key, sb] of Object.entries(seed)) {
        const qs = (sb && Array.isArray(sb.questions) ? sb.questions : [])
          .filter(q => q && typeof q.question === "string" && [1, 2, 3].includes(q.level))
          .map(q => { const c = Object.assign({}, q); delete c.usedAt; return c; });   // 种子的做题记录不带过来
        if (!qs.length) continue;
        const bank = qbank[key] || (qbank[key] = { questions: [] });
        const n0 = bank.questions.length;
        qbankMerge(bank, qs);
        added += bank.questions.length - n0;
      }
    }
    if (added) {
      qbankSave();
      console.log("[quiz] merged " + added + " new question(s) from the bundled seed bank");
    }
  }
} catch (e) { console.log("[quiz] seed bank merge skipped: " + e.message); }

/* 开练前保证每级有足够没做过的题；不足就让 AI 补（初次 = 三级各 4 道一次生成） */
/* 题库够不够直接开一局：三级都有题就够（做过的按最久没做过复用，见 quizSession）。
 * 随包发的题库靠这个让没装引擎的人也能闯关；装了引擎的照旧自动补新题。 */
function qbankPlayable(itemId, lang) {
  const bank = qbank[qbankKey(itemId, lang)];
  if (!bank || !Array.isArray(bank.questions)) return null;
  return [1, 2, 3].every(lv => bank.questions.some(q => q.level === lv)) ? bank : null;
}

/* judge（可选，pregen --judge 用）：拿到一批新题先送审，没过就抛错——
 * 正好落进下面「失败重试一次」的既有路径：重新生成一批、再审一次。
 * 审没过的批次绝不 merge 进题库。 */
async function ensureQuizBank(item, gradeData, lang, providerId, task, judge) {
  task = task || "quiz";
  const key = qbankKey(item.id, lang);
  const bank = qbank[key] || (qbank[key] = { questions: [] });
  const needs = {};
  for (const lv of [1, 2, 3]) {
    const qs = bank.questions.filter(q => q.level === lv);
    if (qs.filter(q => !q.usedAt).length < QUIZ_SESSION_PER_LEVEL && qs.length < QUIZ_LEVEL_CAP) needs[lv] = QUIZ_PER_LEVEL_NEW;
  }
  if (!Object.keys(needs).length) { ledgerAdd({ task, provider: "bank", lang, ms: 0, ok: true }); return bank; }
  const total = Object.values(needs).reduce((a, b) => a + b, 0);
  const sys = qbankPrompt(item, gradeData, lang, needs, bank.questions.map(q => q.question));
  const msg = L(lang, "请出这批题。", "Please write this batch of questions.");
  const opts = { schema: QBANK_SCHEMA, hint: QBANK_HINT[lang] };
  const t0 = Date.now();
  console.log(`[quiz] engine=${providerId} topic=${item.id} lang=${lang} need=${[1, 2, 3].filter(l => needs[l]).map(l => `L${l}×${needs[l]}`).join(",")}`);
  const attempt = async () => {
    const batch = await runEngine(providerId, task, sys, msg, null, null, lang, opts, x => validateQbankBatch(x, total));
    if (judge) {
      const v = await judge(batch);
      if (!v.pass) throw new Error(L(lang, "审稿没过：", "Review failed: ") + (v.problems[0] || L(lang, "（没给理由）", "(no reason given)")));
    }
    qbankMerge(bank, batch);
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

/* ---------------- 账号与会话 ----------------
 * 家长自助注册（可选邀请码），孩子由家长创建（名字 + 4-6 位 PIN），不需要邮箱。
 * 登录发随机 token（x-session 头），60 天滑动过期，落盘 data/sessions.json 重启不掉线。
 * 密码/PIN 用 scrypt + 每用户随机盐存储；登录失败限速防孩子暴力试家长密码。 */
const USERS_FILE = path.join(DATA_ROOT, "data", "users.json");
const SESSIONS_FILE = path.join(DATA_ROOT, "data", "sessions.json");
const SESSION_TTL = 60 * 24 * 3600 * 1000;
const SESSIONS_MAX = 200;

let users = [];      // {id, role:"parent"|"kid", name, username?, salt, hash, familyId, createdAt}
let sessions = {};   // token -> {userId, createdAt, expiresAt}
try {
  const u = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  if (Array.isArray(u)) users = u;
} catch (_) { /* 还没有账号：前端走注册向导 */ }
try {
  const s = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  if (s && typeof s === "object" && !Array.isArray(s)) {
    const now = Date.now();
    for (const [k, v] of Object.entries(s)) if (v && v.expiresAt > now) sessions[k] = v;
  }
} catch (_) { /* 还没有会话 */ }

/* 账号是唯一不能「存不下也算成功」的数据：注册返回了 token 却没落盘的话，
 * 家长当场能用，服务器一重启就登不进来了——而孩子还挂在那个再也没人认领的 familyId 上。
 * 所以这里失败就抛，由 usersCommit 回滚内存、让请求 500。 */
function usersSave() {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(users), "utf8");
  fs.renameSync(tmp, USERS_FILE);
}
/* 改内存 + 落盘的唯一入口。mutate() 里做改动，可以返回一个撤销函数
 * （改对象字段用；增删账号靠整表快照就能兜住）。落盘失败 = 内存回到改之前 + 抛错。 */
function usersCommit(mutate) {
  const before = users.slice();
  const undo = mutate();
  try { usersSave(); }
  catch (e) {
    users = before;
    if (typeof undo === "function") undo();
    console.log("[users] save failed, in-memory change rolled back: " + e.message);
    throw new Error("账号没能存进磁盘，检查服务器的磁盘空间和写权限 / Couldn't save the account — check server disk space and write permissions");
  }
}
function sessionsSave() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const tmp = SESSIONS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sessions), "utf8");
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.log("[sessions] could not save: " + e.message); }
}

function hashSecret(secret, salt) { return crypto.scryptSync(String(secret), salt, 32).toString("hex"); }
function makeCred(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashSecret(secret, salt) };
}
function checkCred(user, secret) {
  try { return crypto.timingSafeEqual(Buffer.from(user.hash, "hex"), Buffer.from(hashSecret(secret, user.salt), "hex")); }
  catch (_) { return false; }
}
function userById(id) { return users.find(u => u.id === id); }
function familyKids(familyId) { return users.filter(u => u.role === "kid" && u.familyId === familyId); }
function publicUser(u) { return { id: u.id, role: u.role, name: u.name }; }

function sessionCreate(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
  const keys = Object.keys(sessions);
  if (keys.length > SESSIONS_MAX) {
    keys.sort((a, b) => sessions[a].expiresAt - sessions[b].expiresAt);
    for (const k of keys.slice(0, keys.length - SESSIONS_MAX)) delete sessions[k];
  }
  sessionsSave();
  return token;
}
function sessionDestroy(token) { if (sessions[token]) { delete sessions[token]; sessionsSave(); } }
function sessionsDropUser(userId) {
  let n = 0;
  for (const [k, v] of Object.entries(sessions)) if (v.userId === userId) { delete sessions[k]; n++; }
  if (n) sessionsSave();
}

/* 请求 -> {user, role:"parent"|"student"} 或 null。60 天滑动续期（攒满一天才落盘一次） */
function auth(req) {
  const tok = String(req.headers["x-session"] || "");
  const s = tok && sessions[tok];
  if (!s || s.expiresAt < Date.now()) return null;
  const u = userById(s.userId);
  if (!u) return null;
  const exp = Date.now() + SESSION_TTL;
  if (exp - s.expiresAt > 24 * 3600 * 1000) { s.expiresAt = exp; sessionsSave(); } else s.expiresAt = exp;
  return { user: u, role: u.role === "parent" ? "parent" : "student" };
}

/* 路由门卫：没登录 401、学生碰家长端点 403；通过返回 {user, role}（UI 隐藏只是体验，这里才是边界） */
function allow(req, res, minRole) {
  const a = auth(req);
  if (!a) { send(res, 401, { error: "请先登录 / Please sign in", authRequired: true }); return null; }
  if (minRole === "parent" && a.role !== "parent") {
    send(res, 403, { error: "需要家长权限 / Parent access required", parentRequired: true });
    return null;
  }
  return a;
}

/* 登录/注册失败限速：同 IP+账号 60 秒内错 5 次 → 锁 30 秒（429） */
const authFails = new Map();
function rateKey(req, who) { return (req.socket.remoteAddress || "?") + "|" + String(who || "").toLowerCase(); }
function rateLocked(key) { const e = authFails.get(key); return !!(e && e.until > Date.now()); }
function rateFail(key) {
  const now = Date.now();
  const e = authFails.get(key) || { times: [], until: 0 };
  e.times = e.times.filter(ts => now - ts < 60000);
  e.times.push(now);
  if (e.times.length >= 5) { e.until = now + 30000; e.times = []; }
  authFails.set(key, e);
}
function rateClear(key) { authFails.delete(key); }
const RATE_MSG = { error: "试太多次啦，休息 30 秒再试 / Too many attempts — wait 30 seconds", rateLimited: true };

/* 旧版单用户数据无损接管：创建第一个孩子时把根目录三个单例文件搬进 TA 的目录 */
function migrateLegacyData(kidId) {
  let moved = 0;
  fs.mkdirSync(kidDir(kidId), { recursive: true });
  for (const f of ["history.json", "progress.json", "fsa-sets.json"]) {
    const src = path.join(DATA_ROOT, f);
    try {
      if (fs.existsSync(src)) { fs.renameSync(src, path.join(kidDir(kidId), f)); moved++; }
    } catch (e) { console.log(`[migrate] ${f} failed to move: ` + e.message); }
  }
  if (moved) {
    kidLoad(kidId);
    console.log(`[migrate] moved ${moved} legacy file(s) from the project root into data/kids/${kidId}/`);
  }
}

/* 孩子上下文：学生 = 只能是自己；家长 = ?kid=/body.kid 指定（必须同家庭），只有一个孩子时可省略 */
function resolveKid(a, kidRaw) {
  if (a.role === "student") return String(a.user.id);
  const kids = familyKids(a.user.familyId);
  const want = String(kidRaw || "");
  if (want) { const k = kids.find(u => u.id === want); return k ? k.id : null; }
  return kids.length === 1 ? kids[0].id : null;
}
const NEED_KID_MSG = { error: "请指定要查看的孩子 / Please pick which child", kidRequired: true };

/* ---------------- 完整学生报告（家长专属） ----------------
 * 两层设计防 LLM 编数字：服务端先确定性算出事实摘要 digest（总量、四级分布、
 * 各主线对错、薄弱点、近 14 天动态、FSA 成绩），LLM 只负责基于 digest 写叙事；
 * 最终报告 = 叙事 + digest 数据附录（附录由前端直接渲染事实数字，不经 LLM）。 */
const REPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" },
    overall: { type: "string" },
    strandComments: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: { strand: { type: "string" }, comment: { type: "string" } },
        required: ["strand", "comment"]
      }
    },
    highlights: { type: "array", items: { type: "string" } },
    weakSpots: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: { topic: { type: "string" }, why: { type: "string" }, practice: { type: "string" } },
        required: ["topic", "why", "practice"]
      }
    },
    parentTips: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } }
  },
  required: ["title", "overall", "strandComments", "highlights", "weakSpots", "parentTips", "nextSteps"]
};
const REPORT_HINT = {
  zh: `

【输出格式要求】只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。字符串值里不要出现英文双引号 "（要引用词语用「」或“”），反斜杠要写成 \\\\（如 \\\\frac）。结构：
{"title":"...","overall":"...","strandComments":[{"strand":"...","comment":"..."}],"highlights":["..."],"weakSpots":[{"topic":"...","why":"...","practice":"..."}],"parentTips":["..."],"nextSteps":["..."]}`,
  en: `

[Output format] Output ONE JSON object only — no other text, no markdown code fences. Never put a double-quote character " inside a string value (use single quotes or “ ” to quote words), and escape every backslash as \\\\ (e.g. \\\\frac):
{"title":"...","overall":"...","strandComments":[{"strand":"...","comment":"..."}],"highlights":["..."],"weakSpots":[{"topic":"...","why":"...","practice":"..."}],"parentTips":["..."],"nextSteps":["..."]}`
};

function reportPrompt(kidName, lang) {
  if (lang === "en") return `You are "Ms. Yuanyuan", an experienced BC elementary math teacher. Using ONLY the real learning data (JSON) provided, write a complete math progress report about ${kidName ? `the child "${kidName}"` : "the child"} for their parents.

Iron rules:
1. Ground every statement in the data. Never invent numbers or facts that are not in the data; any number you quote must match it.
2. Professional, warm and specific — like a teacher speaking with parents at a conference. Affirm effort generously; make every concern actionable.
3. Describe mastery using BC report-card language: Emerging / Developing / Proficient / Extending.
4. weakSpots: pick only from the data's weakSpots list; "practice" is one concrete 5-10 minute at-home exercise. nextSteps: prefer topics from the data's notYet list.
5. In the data, right/wrong are practice answer counts; recent14 is the last 14 days of activity; fsaRecent are FSA practice-set scores; unitRecent are end-of-unit test scores (quote them by unit when commenting on that strand).

Fields: title (report title with the child's name and scope); overall (one paragraph, 4-6 sentences); strandComments (one per strand in the data: {strand: strand name, comment: 2-4 sentences}); highlights (2-4 bright spots); weakSpots (at most 4: {topic, why, practice}); parentTips (2-3 suggestions for parents); nextSteps (2-4 topics to learn next).`;
  return `你是「圆圆老师」，一位经验丰富的 BC 省小学数学老师。请只根据下面提供的真实学习数据（JSON），给家长写一份关于${kidName ? `孩子「${kidName}」` : "孩子"}的完整数学学习报告。

铁律：
1. 只根据数据说话：禁止编造数据里没有的数字或事实，引用的每个数字都必须和数据一致。
2. 语气专业、温暖、具体，像家长会上老师面对面交流；多肯定孩子的努力，问题要给出可操作的建议。
3. 用 BC 成绩单四级话术描述掌握程度：Emerging（起步）/ Developing（发展中）/ Proficient（扎实）/ Extending（拓展）。
4. weakSpots 只能从数据的 weakSpots 列表里选，practice 给一条在家 5-10 分钟能完成的具体练习；nextSteps 优先从数据的 notYet 列表里挑。
5. 数据里 right/wrong 是练习答对/答错次数；recent14 是近 14 天动态；fsaRecent 是 FSA 模拟卷成绩；unitRecent 是单元测试成绩（评价对应主线时把这个分数说出来）。

字段：title 报告标题（带孩子名字和课程范围）；overall 总评一段话（4-6 句）；strandComments 数据里每个主线一条 {strand: 主线名, comment: 2-4 句评语}；highlights 亮点 2-4 条；weakSpots 最多 4 条 {topic, why, practice}；parentTips 给家长的建议 2-3 条；nextSteps 接下来学什么 2-4 条。`;
}

/* 事实摘要：全部由内存数据确定性计算，一个数字都不让 LLM 猜 */
function buildReportDigest(kidId, gradeKey) {
  const d = curriculum.get(gradeKey);
  if (!d) return null;
  const bucket = kd(kidId);
  const progress = bucket.progress;
  const now = Date.now(), win = 14 * 24 * 3600 * 1000;
  const levels = { emerging: 0, developing: 0, proficient: 0, extending: 0 };
  const strands = strandGroups(d, it => {
    const e = progress[it.id];
    const lv = progressLevel(kidId, it.id);
    levels[lv]++;
    return {
      id: it.id, en: it.en, zh: it.zh, level: lv,
      taught: e ? e.taught : 0, right: e ? e.right : 0, wrong: e ? e.wrong : 0, lastAt: e ? e.lastAt : 0
    };
  }).map(sg => ({
    strand: sg.strand, zhName: sg.zhName, enName: sg.enName,
    total: sg.items.length,
    seen: sg.items.filter(i => i.level !== "emerging").length,
    solid: sg.items.filter(i => i.level === "proficient" || i.level === "extending").length,
    right: sg.items.reduce((s, i) => s + i.right, 0),
    wrong: sg.items.reduce((s, i) => s + i.wrong, 0),
    items: sg.items
  }));
  const allItems = strands.flatMap(sg => sg.items);
  const weakSpots = allItems
    .filter(it => it.wrong > 0 && (it.wrong >= it.right || it.level === "developing"))
    .sort((a, b) => (b.wrong - b.right) - (a.wrong - a.right) || b.wrong - a.wrong)
    .slice(0, 5)
    .map(it => ({ id: it.id, en: it.en, zh: it.zh, right: it.right, wrong: it.wrong, level: it.level }));
  const notYet = allItems.filter(it => it.level === "emerging").slice(0, 8).map(it => ({ id: it.id, en: it.en, zh: it.zh }));
  const idSet = new Set(allItems.map(it => it.id));
  const recentLessons = bucket.history.filter(h => now - h.time < win);
  const fsaRecent = [];
  for (const s of bucket.fsaSets) for (const at of (s.attempts || []))
    fsaRecent.push({ time: at.time, right: at.right, total: at.total, title: s.title || "FSA" });
  fsaRecent.sort((a, b) => b.time - a.time);
  // 单元测试成绩：只算当前课程源的（换年级/换书不串数据），按单元报给报告
  const unitRecent = [];
  for (const s of bucket.unitTests) {
    if (String(s.grade) !== String(gradeKey)) continue;
    const un = s.unitName || {};
    for (const at of (s.attempts || []))
      unitRecent.push({ time: at.time, right: at.right, total: at.total, unit: un.zh || un.en || s.strand || "" });
  }
  unitRecent.sort((a, b) => b.time - a.time);
  const activeDays = new Set();
  let itemsTouched = 0, quizPassed = 0;
  for (const [id, e] of Object.entries(progress)) {
    if (!idSet.has(id)) continue;   // 只统计当前课程源（换年级/换书不串数据）
    if (e.lastAt && now - e.lastAt < win) itemsTouched++;
    if (e.quizPassedAt && now - e.quizPassedAt < win) quizPassed++;
    for (const day of (e.rightDays || [])) {
      const ts = new Date(day + "T00:00:00").getTime();
      if (isFinite(ts) && now - ts < win) activeDays.add(day);
    }
  }
  return {
    generatedAt: now,
    source: d.type === "book"
      ? { kind: "book", title: (d.title || {}).zh || (d.title || {}).en || String(gradeKey), grade: d.grade || 0 }
      : isCourseData(d)
      ? { kind: "course", id: String(gradeKey), title: (d.title || {}).zh || (d.title || {}).en || String(gradeKey), titleEn: (d.title || {}).en || "", grade: d.grade || 0 }
      : { kind: "bc", grade: d.grade },
    totals: {
      total: allItems.length,
      seen: allItems.filter(i => i.level !== "emerging").length,
      solid: allItems.filter(i => i.level === "proficient" || i.level === "extending").length,
      levels
    },
    strands: strands.map(({ items, ...rest }) => rest),
    weakSpots, notYet,
    recent14: {
      lessonsTeach: recentLessons.filter(h => h.mode === "teach").length,
      lessonsSolve: recentLessons.filter(h => h.mode !== "teach").length,
      itemsTouched, quizPassed, activeDays: activeDays.size
    },
    fsaRecent: fsaRecent.slice(0, 8),
    unitRecent: unitRecent.slice(0, 8)
  };
}

function validateFullReport(r) {
  if (!r || typeof r !== "object") throw new Error("报告格式不对");
  const s = v => String(v == null ? "" : v).trim();
  const arrS = (a, n) => (Array.isArray(a) ? a : []).map(s).filter(Boolean).slice(0, n);
  const out = {
    title: s(r.title),
    overall: s(r.overall),
    strandComments: (Array.isArray(r.strandComments) ? r.strandComments : [])
      .map(x => (x && typeof x === "object") ? { strand: s(x.strand), comment: s(x.comment) } : null)
      .filter(x => x && x.comment).slice(0, 8),
    highlights: arrS(r.highlights, 4),
    weakSpots: (Array.isArray(r.weakSpots) ? r.weakSpots : [])
      .map(x => (x && typeof x === "object") ? { topic: s(x.topic), why: s(x.why), practice: s(x.practice) } : null)
      .filter(x => x && x.topic).slice(0, 4),
    parentTips: arrS(r.parentTips, 3),
    nextSteps: arrS(r.nextSteps, 4)
  };
  if (!out.overall) throw new Error("报告缺少总评");
  return out;
}

function reportsAdd(kidId, rec) {
  rec.id = newRecId();
  const list = kd(kidId).reports;
  list.unshift(rec);
  if (list.length > REPORTS_MAX) list.length = REPORTS_MAX;
  kidSave(kidId, "reports");
}
function reportSummary(r) {
  return { id: r.id, time: r.time, grade: r.grade, lang: r.lang || "zh", provider: r.provider || "", title: (r.content && r.content.title) || "" };
}

/* ---------------- HTTP 服务器 ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
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
    /* ---- 账号：注册 / 登录 / 登出 / 我是谁 / 登录前的孩子名单 ---- */
    if (url.pathname === "/api/auth/profiles" && req.method === "GET") {
      // 登录前的引导信息（不鉴权）：有没有账号、要不要邀请码、孩子选择屏名单
      const needsSetup = !users.some(u => u.role === "parent");
      return send(res, 200, {
        needsSetup,
        registrationCodeRequired: !!cfg.registrationCode,
        registrationOpen: needsSetup || !!cfg.registrationCode,   // 首位家长之后只剩邀请码这一条路
        kids: users.filter(u => u.role === "kid").map(publicUser),
        // Vercel demo 专用：登录屏显示演示账号提示，免得陌生访客卡在 PIN 上。
        // 明文只活在 api/index.js（永不进安装包）；这里原样透传，不关心具体是什么。
        demoPin: process.env.YY_DEMO_PIN || undefined,
        demoParent: process.env.YY_DEMO_PARENT || undefined
      });
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || "").trim().slice(0, 12) || "家长";
      const rk = rateKey(req, "register");
      if (rateLocked(rk)) return send(res, 429, RATE_MSG);
      // 第一位家长 = 首次安装，谁先打开页面谁建；之后注册自动关闭，
      // 否则任何能连到本服务的人都能开个新家庭，白用这台机器的订阅/API/GPU。
      // 真要再开一个家庭：在 config.json 里设 registrationCode，拿邀请码注册。
      if (users.some(u => u.role === "parent") && !cfg.registrationCode) {
        return send(res, 403, { error: "注册已关闭（本服务器只允许第一位家长自助注册）/ Registration is closed — only the first parent can self-register" });
      }
      if (cfg.registrationCode && String(body.registrationCode || "") !== String(cfg.registrationCode)) {
        rateFail(rk);
        return send(res, 403, { error: "邀请码不对 / Wrong registration code" });
      }
      if (!/^[a-z0-9_@.\-]{3,32}$/.test(username)) return send(res, 400, { error: "用户名要 3-32 位字母/数字 / Username: 3-32 letters or digits" });
      if (password.length < 6) return send(res, 400, { error: "密码至少 6 位 / Password needs at least 6 characters" });
      if (users.some(u => u.role === "parent" && u.username === username)) return send(res, 409, { error: "用户名已存在 / Username already taken" });
      const user = Object.assign({
        id: "p" + newRecId(), role: "parent", name, username,
        familyId: "f" + newRecId(), createdAt: Date.now()
      }, makeCred(password));
      usersCommit(() => { users.push(user); });
      rateClear(rk);
      console.log(`[auth] new parent registered: ${name} (${username})`);
      return send(res, 200, { token: sessionCreate(user.id), user: publicUser(user) });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      let user = null, rk;
      if (body.kidId) {          // 孩子：选择屏点头像 + PIN
        rk = rateKey(req, body.kidId);
        if (rateLocked(rk)) return send(res, 429, RATE_MSG);
        const u = users.find(x => x.role === "kid" && x.id === String(body.kidId));
        if (u && checkCred(u, String(body.pin || ""))) user = u;
      } else {                   // 家长：用户名 + 密码
        const username = String(body.username || "").trim().toLowerCase();
        rk = rateKey(req, username);
        if (rateLocked(rk)) return send(res, 429, RATE_MSG);
        const u = users.find(x => x.role === "parent" && x.username === username);
        if (u && checkCred(u, String(body.password || ""))) user = u;
      }
      if (!user) { rateFail(rk); return send(res, 401, { error: "账号或密码不对 / Wrong account or password" }); }
      rateClear(rk);
      return send(res, 200, { token: sessionCreate(user.id), user: publicUser(user) });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      sessionDestroy(String(req.headers["x-session"] || ""));
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const a = allow(req, res, "student"); if (!a) return;
      const resp = { user: publicUser(a.user), role: a.role };
      if (a.role === "parent") resp.kids = familyKids(a.user.familyId).map(publicUser);
      return send(res, 200, resp);
    }

    /* ---- 孩子账号管理（家长专属）：创建 / 改名 / 重置 PIN / 软删除 ---- */
    if (url.pathname === "/api/kids" && req.method === "POST") {
      const a = allow(req, res, "parent"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const name = String(body.name || "").trim().slice(0, 12);
      const pin = String(body.pin || "");
      if (!name) return send(res, 400, { error: "孩子的名字不能为空 / Name is required" });
      if (!/^\d{4,6}$/.test(pin)) return send(res, 400, { error: "PIN 要 4-6 位数字 / PIN must be 4-6 digits" });
      const firstKidEver = !users.some(u => u.role === "kid");
      const user = Object.assign({
        id: "k" + newRecId(), role: "kid", name,
        familyId: a.user.familyId, createdBy: a.user.id, createdAt: Date.now()
      }, makeCred(pin));
      usersCommit(() => { users.push(user); });
      if (firstKidEver) migrateLegacyData(user.id);   // 旧版单用户数据无损归到第一个孩子名下
      fs.mkdirSync(kidDir(user.id), { recursive: true });
      console.log(`[auth] new kid account: ${name} (parent: ${a.user.name})`);
      return send(res, 200, { kid: publicUser(user) });
    }

    const km = /^\/api\/kids\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (km && (req.method === "PATCH" || req.method === "DELETE")) {
      const a = allow(req, res, "parent"); if (!a) return;
      const kid = users.find(u => u.role === "kid" && u.id === km[1] && u.familyId === a.user.familyId);
      if (!kid) return send(res, 404, { error: "孩子不存在 / Not found" });
      if (req.method === "PATCH") {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
        // 先全部校验，再一次性提交：落盘失败时不留下改了一半的账号
        let name = null, cred = null;
        if (body.name != null) {
          name = String(body.name).trim().slice(0, 12);
          if (!name) return send(res, 400, { error: "名字不能为空 / Name is required" });
        }
        if (body.pin != null) {
          const pin = String(body.pin);
          if (!/^\d{4,6}$/.test(pin)) return send(res, 400, { error: "PIN 要 4-6 位数字 / PIN must be 4-6 digits" });
          cred = makeCred(pin);
        }
        const snap = Object.assign({}, kid);
        usersCommit(() => {
          if (name) kid.name = name;
          if (cred) Object.assign(kid, cred);
          return () => Object.assign(kid, snap);   // 改的是对象字段，整表快照兜不住，用字段快照回滚
        });
        if (cred) sessionsDropUser(kid.id);   // 落盘成功后再踢：重置 PIN 后旧设备的登录全部失效
        return send(res, 200, { kid: publicUser(kid) });
      }
      // 软删除：账号移除、会话踢掉、数据目录归档为 _deleted-<id>-<时间>，不物理删除
      usersCommit(() => { users = users.filter(u => u.id !== kid.id); });
      sessionsDropUser(kid.id);
      kidData.delete(kid.id);
      try {
        if (fs.existsSync(kidDir(kid.id))) fs.renameSync(kidDir(kid.id), path.join(KIDS_DIR, `_deleted-${kid.id}-${Date.now().toString(36)}`));
      } catch (e) { console.log("[auth] could not archive the kid's data: " + e.message); }
      console.log(`[auth] kid account deleted (data archived): ${kid.name}`);
      return send(res, 200, { ok: true });
    }

    /* API */
    if (url.pathname === "/api/providers" && req.method === "GET") {
      const a = allow(req, res, "student"); if (!a) return;
      await detectProviders();
      const list = Object.keys(PROVIDER_META).map(id => ({
        id, ...PROVIDER_META[id],
        available: !!(detected[id] && detected[id].available),
        model: detected[id] && detected[id].model || undefined
      }));
      const resp = {
        active: pickProvider(cfg.provider), routes: cfg.providerByTask || {}, providers: list, tts: ttsAvailable(),
        packedLessons: lessonPackCount(), packedUnitTests: unitPackCount(),
        curriculumGrades: curriculumGrades(), curriculumCourses: curriculumCourses(), curriculumBooks: curriculumBooks(),
        role: a.role, user: publicUser(a.user)
      };
      if (a.role === "parent") resp.kids = familyKids(a.user.familyId).map(publicUser);
      return send(res, 200, resp);
    }

    /* 用量账本（家长专属）：讲课/出题/报告各花了多少次调用、token、时间、美元，
     * pack/bank 又免费顶了多少次。?days=30 只看最近 30 天，不传看全部。 */
    if (url.pathname === "/api/usage" && req.method === "GET") {
      const a = allow(req, res, "parent"); if (!a) return;
      const days = Math.max(0, Number(url.searchParams.get("days")) || 0);
      const rows = ledgerRead(days ? Date.now() - days * 24 * 3600 * 1000 : 0);
      const s = ledgerSummary(rows);
      return send(res, 200, { days, file: LEDGER_FILE, totals: s.totals, byProvider: s.byProvider, byTask: s.byTask, recent: rows.slice(-20).reverse() });
    }

    if (url.pathname === "/api/tts" && req.method === "POST") {
      if (!allow(req, res, "student")) return;
      if (!ttsAvailable()) return send(res, 200, { enabled: false, items: [] });
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8"));
      const defLang = normLang(body.lang);
      return send(res, 200, { enabled: true, items: ttsStates(body.items, defLang) });
    }

    if (url.pathname.startsWith("/api/tts/audio/") && req.method === "GET") {
      const m = /^\/api\/tts\/audio\/([a-f0-9]{40})\.wav$/.exec(url.pathname);
      // 先现场合成的缓存，再随包发的语音包。URL 一律 .wav，实际格式看 content-type（浏览器认头不认后缀）
      let p = null, st = null;
      if (m) {
        for (const cand of [ttsWavPath(m[1]), voicePackPath(m[1])]) {
          if (!cand) continue;
          try { st = fs.statSync(cand); p = cand; break; } catch (_) {}
        }
      }
      if (!st) { res.writeHead(404); return res.end(); }
      const head = { "content-type": VOICE_MIME[path.extname(p).toLowerCase()] || "audio/wav", "accept-ranges": "bytes", "cache-control": "public, max-age=604800, immutable" };
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
      const a = allow(req, res, "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      return send(res, 200, { items: kd(kidId).history.map(historySummary) });
    }

    const hm = /^\/api\/history\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (hm && (req.method === "GET" || req.method === "DELETE")) {
      // 删除是家长动作（防误删、防「藏起错题」），查看/重播孩子自己就行
      const a = allow(req, res, req.method === "DELETE" ? "parent" : "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const list = kd(kidId).history;
      const i = list.findIndex(r => r.id === hm[1]);
      if (i < 0) return send(res, 404, { error: "记录不存在 / Not found" });
      if (req.method === "DELETE") {
        list.splice(i, 1);
        kidSave(kidId, "history");
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { record: list[i] });
    }

    if (url.pathname === "/api/curriculum" && req.method === "GET") {
      const a = allow(req, res, "student"); if (!a) return;
      const grades = curriculumGrades();
      const g = curriculumKey(url.searchParams.get("grade") || 0);
      if (!g) return send(res, 200, { grades, courses: curriculumCourses(), books: curriculumBooks() });
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet", grades });
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const progress = kd(kidId).progress;
      const strands = strandGroups(d, it => ({
        id: it.id, en: it.en, zh: it.zh, status: progressStatus(kidId, it.id),
        // 最近一节讲过的课：前端点条目直接重播（免费秒开），🔄 才重新生成
        lessonId: ((progress[it.id] || {}).lessonIds || [])[0] || ""
      }));
      return send(res, 200, { grade: g, grades, source: d.source, strands });
    }

    /* P3 家长报告（家长专属）：按主线汇总 + BC 四级话术级别 */
    if (url.pathname === "/api/report" && req.method === "GET") {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const grades = curriculumGrades();
      const g = curriculumKey(url.searchParams.get("grade") || 0);
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet", grades });
      const progress = kd(kidId).progress;
      const strands = strandGroups(d, it => {
        const e = progress[it.id];
        return {
          id: it.id, en: it.en, zh: it.zh,
          status: progressStatus(kidId, it.id),
          level: progressLevel(kidId, it.id),
          manualSolid: !!(e && e.solid),   // 家长手动标记的「扎实」，前端星标可切换
          taught: e ? e.taught : 0, right: e ? e.right : 0, wrong: e ? e.wrong : 0,
          lastAt: e ? e.lastAt : 0
        };
      }).map(sg => Object.assign(sg, {
        total: sg.items.length,
        seen: sg.items.filter(i => i.status !== "new").length,
        solid: sg.items.filter(i => i.status === "solid").length
      }));
      const totals = strands.reduce((a2, sg) => ({ total: a2.total + sg.total, seen: a2.seen + sg.seen, solid: a2.solid + sg.solid }),
        { total: 0, seen: 0, solid: 0 });
      // 术语对照：这个年级大纲里出现过的中英术语，随报告打印（家长看成绩单/和老师面谈用）
      const termSeen = new Set(); const terms = [];
      for (const it of (d.items || [])) for (const tm of itemTerms(it)) {
        const k = tm.en.toLowerCase();
        if (!termSeen.has(k)) { termSeen.add(k); terms.push({ en: tm.en, zh: tm.zh }); }
      }
      const kidUser = userById(kidId);
      return send(res, 200, { grade: g, grades, source: d.source, strands, totals, terms, kid: kidUser ? publicUser(kidUser) : null });
    }

    /* 完整学生报告（家长专属）：生成（💰 LLM）/ 列表 / 单份查看 / 删除 */
    if (url.pathname === "/api/report/full" && req.method === "POST") {
      const a = allow(req, res, "parent"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const lang = normLang(body.lang);
      const g = curriculumKey(body.grade || 0);
      const digest = buildReportDigest(kidId, g);
      if (!digest) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" });
      const id = pickProvider(body.provider, "report");
      if (!id) return send(res, 503, { error: L(lang,
        "没有检测到可用的 AI 引擎。请看 README 配置一个（Ollama / grok / claude / gemini / codex 或 API）。",
        "No AI engine detected. See the README to set one up (Ollama / grok / claude / gemini / codex or an API).") });
      const kidUser = userById(kidId);
      const sys = reportPrompt(kidUser ? kidUser.name : "", lang);
      const q = L(lang, "学习数据如下：\n", "The learning data:\n") + JSON.stringify(digest);
      const opts = { schema: REPORT_SCHEMA, hint: REPORT_HINT[lang] };
      const t0 = Date.now();
      console.log(`[report] engine=${id} kid=${kidId} grade=${g} lang=${lang}`);
      let content;
      try {
        content = await runEngine(id, "report", sys, q, null, null, lang, opts, validateFullReport);
      } catch (e1) {
        console.log(`[report] first try failed (${e1.message}), retrying once...`);
        content = await runEngine(id, "report", sys, q, null, null, lang, opts, validateFullReport);
      }
      console.log(`[report] ok in ${Math.round((Date.now() - t0) / 1000)}s`);
      const rec = { time: Date.now(), grade: String(g), lang, provider: id, kidName: kidUser ? kidUser.name : "", digest, content };
      reportsAdd(kidId, rec);
      return send(res, 200, { report: rec, ms: Date.now() - t0 });
    }

    if (url.pathname === "/api/report/full/list" && req.method === "GET") {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      return send(res, 200, { items: kd(kidId).reports.map(reportSummary) });
    }

    const rfm = /^\/api\/report\/full\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (rfm && (req.method === "GET" || req.method === "DELETE")) {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const list = kd(kidId).reports;
      const i = list.findIndex(r => r.id === rfm[1]);
      if (i < 0) return send(res, 404, { error: "报告不存在 / Not found" });
      if (req.method === "DELETE") {
        list.splice(i, 1);
        kidSave(kidId, "reports");
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { record: list[i] });
    }

    /* P4 FSA 模拟卷：按大纲出多步骤情境选择题（G4/G7 是 FSA 年级，其他年级也可当普通练习卷） */
    if (url.pathname === "/api/fsa" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const lang = normLang(body.lang);
      const g = Number(body.grade || 0);
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" });
      const strand = STRANDS.some(s => s[0] === body.strand) ? body.strand : "";
      const count = Math.max(4, Math.min(10, Number(body.count) || 6));
      const id = pickProvider(a.role === "parent" ? body.provider : null, "fsa");   // 学生不能指定引擎，走 config 默认
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
        set = await runEngine(id, "fsa", sys, q, null, null, lang, opts, x => validateFsaSet(x, d, count));
      } catch (e1) {
        console.log(`[fsa] first try failed (${e1.message}), retrying once...`);
        set = await runEngine(id, "fsa", sys, q, null, null, lang, opts, x => validateFsaSet(x, d, count));
      }
      console.log(`[fsa] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${set.questions.length} questions`);
      // 出一次卷不便宜：立刻持久化，以后直接打开做，不再重新生成
      const rec = { time: Date.now(), grade: g, strand, lang, provider: id, title: set.title, questions: set.questions, attempts: [] };
      fsaSetsAdd(kidId, rec);
      return send(res, 200, { set: rec, provider: id, ms: Date.now() - t0 });
    }

    if (url.pathname === "/api/fsa/sets" && req.method === "GET") {
      const a = allow(req, res, "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const g = Number(url.searchParams.get("grade") || 0);
      return send(res, 200, { items: kd(kidId).fsaSets.filter(r => !g || r.grade === g).map(fsaSetSummary) });
    }

    const fsm = /^\/api\/fsa\/sets\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (fsm && (req.method === "GET" || req.method === "DELETE")) {
      // 删卷是家长动作，打开做卷孩子自己就行
      const a = allow(req, res, req.method === "DELETE" ? "parent" : "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const sets = kd(kidId).fsaSets;
      const i = sets.findIndex(r => r.id === fsm[1]);
      if (i < 0) return send(res, 404, { error: "卷子不存在 / Not found" });
      if (req.method === "DELETE") {
        sets.splice(i, 1);
        kidSave(kidId, "fsaSets");
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { record: sets[i] });
    }

    if (url.pathname === "/api/fsa/attempt" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const rec = kd(kidId).fsaSets.find(r => r.id === String(body.id || ""));
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
      kidSave(kidId, "fsaSets");
      return send(res, 200, { ok: true });
    }

    /* P6 单元测试：一个单元（BC 主线 / 教材章节）一张卷，覆盖本单元知识点，难度 L1→L3 混排。
     * 出卷同 FSA（跑一次 AI 就永久存档）；判分和记进度都在服务端做（见 /api/unit-test/attempt）。 */
    if (url.pathname === "/api/unit-test" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const lang = normLang(body.lang);
      const g = curriculumKey(body.grade || 0);
      const d = curriculum.get(g);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" });
      const strand = String(body.strand || "");
      const def = (d.strandDefs || STRANDS).find(s => s[0] === strand);
      const unitItems = (d.items || []).filter(it => it.strand === strand);
      if (!def || !unitItems.length) return send(res, 400, { error: "未知的单元 / Unknown unit" });
      const count = Math.max(6, Math.min(12, Number(body.count) || 8));

      // 随包发的卷子：命中就直接发一份给这个孩子，不碰引擎。
      // fresh=true 是「再出一张新的」，那条路照旧要引擎。
      if (!body.fresh) {
        const packed = unitPackGet(g, strand, lang);
        if (packed) {
          const rec = {
            time: Date.now(), grade: String(g), strand, lang, provider: "pack",
            title: packed.title || (lang === "en" ? def[2] : def[1]),
            unitName: { zh: def[1], en: def[2] },
            questions: packed.questions, attempts: []
          };
          unitTestsAdd(kidId, rec);
          console.log(`[unit] pack hit grade=${g} unit=${strand} lang=${lang} kid=${kidId}`);
          ledgerAdd({ task: "unit", provider: "pack", lang, ms: 0, ok: true });
          return send(res, 200, { set: rec, provider: "pack", ms: 0, packed: true });
        }
      }

      const id = pickProvider(a.role === "parent" ? body.provider : null, "unit");   // 学生不能指定引擎，走 config 默认
      if (!id) return send(res, 503, {
        error: L(lang,
          "这个单元的卷子不在随附的题库里，现出卷需要一个 AI 引擎。怎么装看 README（Ollama 免费离线 / claude / gemini / grok / codex 或 API）。",
          "This unit's test isn't in the bundled set, so writing one needs an AI engine. See the README to set one up (Ollama is free and offline / claude / gemini / grok / codex or an API)."),
        needsEngine: true });
      const sys = unitTestPrompt(d, strand, lang, count);
      const q = L(lang, "请出这张单元测验。", "Please write this unit test.");
      const opts = { schema: UNIT_TEST_SCHEMA, hint: UNIT_TEST_HINT[lang] };
      const t0 = Date.now();
      console.log(`[unit] engine=${id} grade=${g} unit=${strand} lang=${lang} n=${count}`);
      let set;
      try {
        set = await runEngine(id, "unit", sys, q, null, null, lang, opts, x => validateUnitTest(x, d, strand, count));
      } catch (e1) {
        console.log(`[unit] first try failed (${e1.message}), retrying once...`);
        set = await runEngine(id, "unit", sys, q, null, null, lang, opts, x => validateUnitTest(x, d, strand, count));
      }
      console.log(`[unit] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${set.questions.length} questions`);
      const rec = {
        time: Date.now(), grade: String(g), strand, lang, provider: id,
        // 标题兜底用单元名：AI 偶尔给个空串，存档列表里就成了无名卷
        title: set.title || (lang === "en" ? def[2] : def[1]),
        unitName: { zh: def[1], en: def[2] },
        questions: set.questions, attempts: []
      };
      unitTestsAdd(kidId, rec);
      return send(res, 200, { set: rec, provider: id, ms: Date.now() - t0 });
    }

    if (url.pathname === "/api/unit-test/sets" && req.method === "GET") {
      const a = allow(req, res, "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const g = String(url.searchParams.get("grade") || "");
      const strand = String(url.searchParams.get("strand") || "");
      return send(res, 200, {
        items: kd(kidId).unitTests
          .filter(r => (!g || String(r.grade) === g) && (!strand || r.strand === strand))
          .map(unitTestSummary)
      });
    }

    const utm = /^\/api\/unit-test\/sets\/([a-z0-9]{6,24})$/.exec(url.pathname);
    if (utm && (req.method === "GET" || req.method === "DELETE")) {
      // 删卷是家长动作，打开做卷孩子自己就行（同 FSA）
      const a = allow(req, res, req.method === "DELETE" ? "parent" : "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const list = kd(kidId).unitTests;
      const i = list.findIndex(r => r.id === utm[1]);
      if (i < 0) return send(res, 404, { error: "卷子不存在 / Not found" });
      if (req.method === "DELETE") {
        list.splice(i, 1);
        kidSave(kidId, "unitTests");
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { record: list[i] });
    }

    /* 交卷：只收「第几题选了第几个」，对错由服务端按存档里的答案算，顺带把每题记进对应知识点的进度。
     * （FSA 是前端逐题上报，这里收口到一次请求：少一半往返，也不用信客户端报的分数。） */
    if (url.pathname === "/api/unit-test/attempt" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const rec = kd(kidId).unitTests.find(r => r.id === String(body.id || ""));
      if (!rec) return send(res, 404, { error: "卷子不存在 / Not found" });
      const qs = rec.questions || [];
      const answers = qs.map((_, i) => {
        const v = Math.round(Number((Array.isArray(body.answers) ? body.answers : [])[i]));
        return v >= 0 && v <= 3 ? v : -1;   // -1 = 没作答（中途退出也能交）
      });
      const answered = answers.filter(v => v >= 0).length;
      // 一题没答就别记成绩：否则存档列表里「上次 0/8」看着像考砸了，其实是点进来又退出去
      if (!answered) return send(res, 200, { ok: true, right: 0, total: qs.length, answered: 0, skipped: true });
      let right = 0;
      qs.forEach((q, i) => {
        if (answers[i] < 0) return;
        const ok = answers[i] === q.answerIndex;
        if (ok) right++;
        // 选择题判定是确定性的（不是 AI 判题），直接记进度；没挂上知识点的题只计分不记进度
        if (q.curriculumId) progressRecord(kidId, q.curriculumId, ok ? "practiced-right" : "practiced-wrong");
      });
      const at = {
        time: Date.now(), right, total: qs.length, answered,
        done: answered === qs.length,   // 中途退出的那次别当成绩单报，列表里标「没做完」
        ms: Math.max(0, Math.round(Number(body.ms) || 0)),
        answers
      };
      rec.attempts = [at, ...(rec.attempts || [])].slice(0, 10);
      kidSave(kidId, "unitTests");
      return send(res, 200, { ok: true, right, total: qs.length, answered });
    }

    /* P5 闯关练习：看完课一道一道做题，SAT 式升降难度，通关标 solid（标准 docs/qbank-standard.md）
     * 题库是全局共享的内容缓存，这一步不写孩子数据；成绩在 /api/quiz/finish 记到孩子名下 */
    if (url.pathname === "/api/quiz/session" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const lang = normLang(body.lang);
      const found = findCurriculumItem(String(body.curriculumId || ""));
      if (!found) return send(res, 400, { error: "未知的知识点 / Unknown curriculum item" });
      const id = pickProvider(a.role === "parent" ? body.provider : null, "quiz");   // 学生不能指定引擎
      const ready = qbankPlayable(found.item.id, lang);   // 随包发的题库：没引擎也能闯
      if (!id && !ready) return send(res, 503, {
        error: L(lang,
          "这一节的闯关题不在随附的题库里，现出题需要一个 AI 引擎。" + "怎么装看 README（Ollama 免费离线 / claude / gemini / grok / codex 或 API）。",
          "This topic's quiz questions aren't in the bundled question bank, so writing them needs an AI engine." + " See the README to set one up (Ollama is free and offline / claude / gemini / grok / codex or an API)."),
        needsEngine: true });
      let bank;
      if (id) bank = await ensureQuizBank(found.item, found.data, lang, id);
      else { ledgerAdd({ task: "quiz", provider: "bank", lang, ms: 0, ok: true }); bank = ready; }   // 没引擎、纯吃随包题库
      return send(res, 200, {
        questions: quizSession(bank),
        rules: { maxQuestions: QUIZ_MAX_QUESTIONS, passNeed: QUIZ_PASS_NEED, topLevel: QUIZ_TOP_LEVEL }
      });
    }

    /* 闯关结算：单题对错记统计、做过的题打 usedAt；通关判定以服务器题库里的难度为准 */
    if (url.pathname === "/api/quiz/finish" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
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
        progressRecord(kidId, cid, ok ? "quiz-right" : "quiz-wrong");
        if (q.level === QUIZ_TOP_LEVEL && ok) topRight++;
      }
      if (bank) qbankSave();
      const passed = topRight >= QUIZ_PASS_NEED;
      if (passed) progressRecord(kidId, cid, "quiz-pass");
      return send(res, 200, { ok: true, passed, status: progressStatus(kidId, cid), level: progressLevel(kidId, cid) });
    }

    /* 清空（家长专属，设置里的「清空学习进度 / 清空全部记录」；只作用于指定孩子，题库全局共享除外） */
    if (url.pathname === "/api/progress" && req.method === "DELETE") {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      kd(kidId).progress = {};
      kidSave(kidId, "progress");
      console.log(`[progress] cleared (kid=${kidId})`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/history" && req.method === "DELETE") {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      kd(kidId).history = [];
      kidSave(kidId, "history");
      console.log(`[history] cleared (kid=${kidId})`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/fsa/sets" && req.method === "DELETE") {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      kd(kidId).fsaSets = [];
      kidSave(kidId, "fsaSets");
      console.log(`[fsa] practice sets cleared (kid=${kidId})`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/unit-test/sets" && req.method === "DELETE") {
      const a = allow(req, res, "parent"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      kd(kidId).unitTests = [];
      kidSave(kidId, "unitTests");
      console.log(`[unit] tests cleared (kid=${kidId})`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/qbank" && req.method === "DELETE") {
      if (!allow(req, res, "parent")) return;
      qbank = {};
      qbankSave();
      console.log("[quiz] question bank cleared (it is shared by the whole family)");
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/progress" && req.method === "GET") {
      const a = allow(req, res, "student"); if (!a) return;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const g = Number(url.searchParams.get("grade") || 0);
      const prefix = g ? `BC.MATH.G${g}.` : "";
      const items = {};
      for (const [id, e] of Object.entries(kd(kidId).progress)) {
        if (prefix && !id.startsWith(prefix)) continue;
        items[id] = Object.assign({}, e, { status: progressStatus(kidId, id) });
      }
      return send(res, 200, { items });
    }

    if (url.pathname === "/api/progress" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const event = String(body.event || "");
      // 内部事件不从这里进：跟不认识的事件一样回 400，不额外告诉调用方它存在
      if (INTERNAL_EVENTS.has(event)) return send(res, 400, { error: "未知的事件 / Unknown event" });
      // 标扎实/取消标扎实是家长的评价动作；孩子只能自报练习对错
      if (PARENT_ONLY_EVENTS.has(event) && a.role !== "parent") {
        return send(res, 403, { error: "需要家长权限 / Parent access required", parentRequired: true });
      }
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const id = String(body.curriculumId || "");
      if (!findCurriculumItem(id)) return send(res, 400, { error: "未知的知识点 / Unknown curriculum item" });
      const e = progressRecord(kidId, id, event);
      if (!e) return send(res, 400, { error: "未知的事件 / Unknown event" });
      return send(res, 200, { ok: true, status: progressStatus(kidId, id), entry: e });
    }

    if (url.pathname === "/api/lesson" && req.method === "POST") {
      const a = allow(req, res, "student"); if (!a) return;
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const kidId = resolveKid(a, body.kid);
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const kidUser = userById(kidId);
      const kidName = kidUser ? kidUser.name : "";   // 讲课称呼来自账号，不再信请求体
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

      // 预生成课程包：teach 模式先查包，命中就不用引擎（秒开、免费、断网也行）。
      // fresh=true 是「换个讲法再讲一遍」，那条路照旧走引擎。
      if (teachCtx && !body.fresh) {
        const packed = lessonPackGet(teachCtx.item.id, lang);
        if (packed) {
          const rec = { time: Date.now(), question, hasImage: false, lang, grade: String(body.grade || ""),
            provider: "pack", lesson: packed, mode: "teach", curriculumId: teachCtx.item.id };
          historyAdd(kidId, rec);
          progressRecord(kidId, teachCtx.item.id, "taught", rec.id);
          if (ttsAvailable() && packed.isMath !== false) {
            try { ttsStates(packed.steps.map(s => ({ text: s.say, lang })), lang); } catch (_) {}
          }
          console.log(`[lesson] pack hit ${teachCtx.item.id} lang=${lang} kid=${kidId}`);
          ledgerAdd({ task: "teach", provider: "pack", lang, ms: 0, ok: true });
          return send(res, 200, {
            lesson: packed, provider: "pack", ms: 0, tts: ttsAvailable(), packed: true,
            curriculumId: teachCtx.item.id, status: progressStatus(kidId, teachCtx.item.id), lessonId: rec.id
          });
        }
      }

      const id = pickProvider(a.role === "parent" ? body.provider : null, teachCtx ? "teach" : "ask");   // 学生不能指定引擎
      if (!id) return send(res, 503, {
        error: L(lang,
          (teachCtx ? "这一节课不在随附的课程包里，现场讲需要一个 AI 引擎。"
                    : "自己出题（打字或拍照）需要一个 AI 引擎——「跟大纲学」里的课不用，可以直接上。") + "怎么装看 README（Ollama 免费离线 / claude / gemini / grok / codex 或 API）。",
          (teachCtx ? "This lesson isn't in the bundled course pack, so teaching it live needs an AI engine."
                    : "Asking your own question (typed or photographed) needs an AI engine — the lessons under Follow the curriculum don't, so you can start there.") + " See the README to set one up (Ollama is free and offline / claude / gemini / grok / codex or an API)."),
        needsEngine: true });
      if (imageB64 && !PROVIDER_META[id].supportsImage) {
        return send(res, 400, { error: L(lang,
          PROVIDER_META[id].label + " 暂不支持看图，请把题目打字输入，或在设置里换一个支持看图的引擎。",
          (PROVIDER_META[id].labelEn || id) + " can't read images yet. Type the question, or pick an engine that supports images in Settings.") });
      }

      const sys = teachCtx
        ? systemPromptTeach(teachCtx.item, teachCtx.data, kidName, lang)
        : systemPrompt(body.grade, kidName, lang, Number(body.gradeCode) || 0);
      const t0 = Date.now();
      console.log(`[lesson] engine=${id} mode=${mode} kid=${kidId} lang=${lang} q="${question.slice(0, 40)}" image=${!!imageB64}`);
      let lesson;
      try {
        lesson = await runEngine(id, teachCtx ? "teach" : "ask", sys, question, imageB64, mediaType, lang, null, validateLesson);
      } catch (e1) {
        console.log(`[lesson] first try failed (${e1.message}), retrying once...`);
        lesson = await runEngine(id, teachCtx ? "teach" : "ask", sys, question, imageB64, mediaType, lang, null, validateLesson);
      }
      console.log(`[lesson] ok in ${Math.round((Date.now() - t0) / 1000)}s, ${lesson.steps.length} steps`);
      const rec = { time: Date.now(), question, hasImage: !!imageB64, lang, grade: String(body.grade || ""), provider: id, lesson };
      if (teachCtx) { rec.mode = "teach"; rec.curriculumId = teachCtx.item.id; }
      historyAdd(kidId, rec);
      // 生成即视为「讲过」：进度立刻从 new 变 seen，并把这节课挂到知识点上
      if (teachCtx) progressRecord(kidId, teachCtx.item.id, "taught", rec.id);
      // 讲解生成好就立刻预合成语音（不等前端），孩子点开第一步时大概率已就绪
      if (ttsAvailable() && lesson.isMath !== false) {
        try { ttsStates(lesson.steps.map(s => ({ text: s.say, lang })), lang); } catch (_) {}
      }
      const resp = { lesson, provider: id, ms: Date.now() - t0, tts: ttsAvailable() };
      // lessonId 带回给前端：清单/FSA 错题下次点开直接重播这节课，不再重新生成
      if (teachCtx) { resp.curriculumId = teachCtx.item.id; resp.status = progressStatus(kidId, teachCtx.item.id); resp.lessonId = rec.id; }
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

/* 直接 node server.js 才起服务。构建期脚本（tools/pregen.mjs / prevoice.mjs）把本文件
 * require 进来，只为借用上面的提示词、引擎适配器和 ttsId，不监听端口。 */
if (require.main === module) detectProviders().then(() => {
  server.listen(cfg.port, () => {
    const avail = Object.keys(PROVIDER_META).filter(id => detected[id] && detected[id].available);
    console.log("");
    console.log("  🧮 Yuanyuan Math is running");
    console.log("  Local:        http://localhost:" + cfg.port);
    const nets = os.networkInterfaces();
    for (const n of Object.values(nets)) for (const a of n || []) {
      if (a.family === "IPv4" && !a.internal) console.log("  On your LAN:  http://" + a.address + ":" + cfg.port);
    }
    console.log("  AI engines:   " + (avail.length
      ? avail.map(id => (PROVIDER_META[id].labelEn || id) + (detected[id].model ? " (" + detected[id].model + ")" : "")).join(", ")
      : "none detected - lessons still work from the bundled pack; see the README to add one"));
    console.log("  Default:      " + (pickProvider() ? (PROVIDER_META[pickProvider()].labelEn || pickProvider()) : "none"));
    const voiceBits = [];
    if (ttsEngineAvailable()) voiceBits.push("live synthesis via " + (cfg.tts.url ? "daemon " + cfg.tts.url : "command mode") + " (" + (cfg.tts.mode || "instruct") + ")");
    if (voicePack.size) voiceBits.push(voicePack.size + " pre-baked clips (data/voice/, read-only)");
    console.log("  Voice:        " + (voiceBits.length
      ? voiceBits.join(" + ")
      : "browser speech only (see the Natural Voice section of the README)"));
    console.log("  Data folder:  " + (DATA_ROOT === ROOT
      ? DATA_ROOT + " (source run - user data lives next to the code)"
      : DATA_ROOT + " (outside the app - upgrades and reinstalls never touch it)"));
    const nParents = users.filter(u => u.role === "parent").length;
    const nKids = users.filter(u => u.role === "kid").length;
    console.log("  Accounts:     " + (nParents
      ? nParents + " parent(s), " + nKids + " kid(s) - data/users.json; per-kid data under data/kids/"
      : "none yet - open the address above and create a parent account, then a kid account"));
    console.log("  Curriculum:   " + (curriculumGrades().length
      ? "BC " + curriculumGrades().map(g => "G" + g).join(", ") + " loaded"
      : "not loaded (no grade-N.json under data/curriculum/bc/)"));
    console.log("  HS courses:   " + (curriculumCourses().length
      ? curriculumCourses().map(c => c.en + " (" + c.id + ", " + (curriculum.get(c.id).items || []).length + " topics)").join("; ")
      : "none (no course-*.json under data/curriculum/bc/)"));
    console.log("  Book courses: " + (curriculumBooks().length
      ? curriculumBooks().map(b => b.en + " (" + b.id + ", " + (curriculum.get(b.id).items || []).length + " sections)").join("; ")
      : "none (no book JSON under data/curriculum/books/)"));
    console.log("  Quiz banks:   " + Object.keys(qbank).length + " (qbank.json, shared by the whole family)");
    const nPack = lessonPackCount();
    console.log("  Lesson pack:  " + (nPack
      ? nPack + " pre-generated (data/lessons/ - instant, no engine needed)"
      : "empty (data/lessons/ has none; every lesson goes to an engine live)"));
    const nUnit = unitPackCount();
    console.log("  Unit tests:   " + (nUnit
      ? nUnit + " pre-generated (data/unit-tests/ - no engine needed)"
      : "empty (data/unit-tests/ has none; every test goes to an engine live)"));
    if (cfg.accessCode) console.log("  ! accessCode in config.json is deprecated - access is handled by the account system now; you can delete it.");
    console.log("  Sign-up:      " + (!nParents
      ? "open, waiting for the first parent (closes itself once one exists)"
      : cfg.registrationCode ? "needs the invite code (registrationCode in config.json)"
      : "closed - a parent already exists. Set registrationCode in config.json to let another family in."));
    console.log("");
  });
});

/* 构建期脚本和 Vercel demo 包装器（api/index.js 取 server）用得到的内部件。
 * 服务器自己不依赖这个导出，删了也不影响本地运行。 */
module.exports = {
  server,
  cfg, ROOT, DATA_ROOT, PACKAGED, L, DEFAULT_CONFIG, deepMerge,
  ADAPTERS, PROVIDER_META, detectProviders, pickProvider, detected, TASKS,
  runEngine, ledgerAdd, ledgerRead, ledgerSummary, LEDGER_FILE,
  curriculum, curriculumGrades, curriculumCourses, curriculumBooks, isCourseData, findCurriculumItem, extractJson,
  systemPromptTeach, validateLesson,
  qbank, qbankKey, qbankSave, ensureQuizBank, qbankPlayable, qbankPrompt, QBANK_HINT,
  ttsId, LESSON_PACK_DIR, VOICE_PACK_DIR, UNIT_PACK_DIR, TTS_CACHE,
  STRANDS, unitTestPrompt, validateUnitTest, UNIT_TEST_SCHEMA, UNIT_TEST_HINT, unitPackGet,
  JUDGE_SCHEMA, JUDGE_HINT, judgeLessonPrompt, judgeQuizPrompt, judgeUnitPrompt, validateJudge,
};
