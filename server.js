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
  /* Claude Code CLI（走 claude.ai 订阅，不按 token 计费）。model/effort 都空 = 用 CLI 自己的默认。
   * 批量出题建议钉死 model:"claude-opus-5" + effort:"high"：默认 effort 偏低，出题的数学质量靠它。 */
  claude: { model: "claude-opus-5", effort: "high" },
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
function lessonFieldsZh(stepHint) {
  return `输出字段说明：
- title：这节课的小标题（简短、友好）。
- isMath：是不是一道数学/数字题。如果不是，isMath=false，steps 里放一句温柔的话把孩子引导回数学，answer 和 practice 填占位即可。
- steps：讲解步骤，${stepHint || "5～8 步最好"}。每步：
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

function lessonFieldsEn(stepHint) {
  return `Output fields:
- title: a short, friendly title for this lesson.
- isMath: whether this is a math/number question. If not, set isMath=false, put one gentle sentence in steps guiding the child back to math, and fill answer and practice with placeholders.
- steps: ${stepHint || "5-8 steps is best"}. Each step:
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
  const isSkills = isSkillsData(gradeData);
  const sk = isSkills ? (item.skill || {}) : null;
  const courseTitle = (gradeData.title || {});
  const origin = isSkills
    ? `这节课教的是**一个小技能**——它是 BC Grade ${sk.reviewFrom || g} 数学大纲里某条内容拆出来的其中一小步，不是整条内容：
- 这一小步要会什么：${item.zh}（英文说法：${item.en}）
- 它属于的大纲条目（官方原文）：${sk.standardEn || "—"}${sk.standardZh ? "（" + sk.standardZh + "）" : ""}
- 所在主题：${strand ? strand[1] : item.strand}${bigIdea ? "\n- 这个主题为什么学（Big Idea）：" + bigIdea : ""}${sk.reviewFrom ? "\n- 注意：这是从 Grade " + sk.reviewFrom + " 借回来复习的技能，孩子以前学过，这次是回顾加深，别当全新内容从零讲。" : ""}`
    : isBook
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

${isSkills
  ? `这不是一整节大课，是一节 3-5 分钟的**微课**：只把下面这一小步讲透，别顺带把整条大纲内容都讲了。`
  : `这节课不是讲一道题，而是给${isCourse ? "学生" : "孩子"}讲一个新知识点，像一节小视频课。`}
${origin}${elabs ? (isSkills ? "\n- 这节微课怎么讲：\n" : "\n- 包含子技能：\n") + elabs : ""}${terms ? "\n- 术语对照：" + terms : ""}${style}${ref}

铁律：
1. 准确第一。动笔前把每一步算术都验算一遍，答案必须正确。这是给一个真实的孩子看的，算错比不讲更糟。
2. 一步只讲一个小意思，语气鼓励、口语化，多用生活里的例子（${st.exZh || "分披萨、用加元买东西、量身高"}）。
3. 例题驱动，不空泛：每个概念都要落到具体的数字和例子上。${st.toneZh}

${isSkills
  ? `微课的结构（输出 4-6 步 steps，比整节课短）：
1. 一句话接上孩子已经会的东西，点出这一小步要解决什么
2. 把这一小步讲清楚，配图${hints}
3. 一个例题走一遍；如果上面列了常见的坑，专门用一步把坑演一遍：「这样做为什么不对」
4. 最后一步一句话小结
只讲这一小步。要用到的前置知识直接用，不展开重讲；后面才学的内容一个字都不要提前讲。`
  : `课的结构（仍然输出 5-8 步 steps）：
1. 用生活例子引出这个概念（为什么有它、它解决什么问题）
2. 讲清楚核心方法，配图${hints}
3. 带着${isCourse ? "学生" : "孩子"}做 1-2 个由浅入深的小例题
4. 最后一步给一句小结或口诀`}
say 里自然提到英文关键术语一两次（比如「小数，英文课上叫 decimal」），孩子在学校听英文课能对上号，但不要堆砌英文。

${lessonFieldsZh(isSkills ? "4～6 步（这是微课，比整节课短）" : null)}
- answer：这节课的一句话要点或小口诀，简短好记，会醒目显示。
- practice：一道贴合${isSkills ? "这一小步" : "这个知识点"}的练习题（question + answer），用孩子在 BC 的生活场景（加元、公制单位、本地的事物）。${isSkills && (sk.rep || []).length ? `练习题围绕「${SKILL_REP_ZH[sk.rep[0]] || sk.rep[0]}」这个模型出，但练习区没有配图，所以要用文字把数都说清楚（或者让孩子自己动手画），不要写「看下面的图」。` : ""}

只讲${isSkills ? "这一小步" : "这一个知识点"}，用最好懂的方式。`;
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
  const isSkills = isSkillsData(gradeData);
  const sk = isSkills ? (item.skill || {}) : null;
  const courseTitle = (gradeData.title || {});
  const strandDef = (isBook || isCourse || isSkills) ? (gradeData.strandDefs || []).find(s => s[0] === item.strand) : null;
  const origin = isSkills
    ? `This lesson teaches **one small skill** — a single step taken out of a BC Grade ${sk.reviewFrom || g} curriculum content standard, not the whole standard:
- What this one step is: ${item.en}
- The standard it belongs to (official wording): ${sk.standardEn || "—"}
- Topic: ${strandDef ? strandDef[2] : item.strand}${bigIdea ? "\n- Why this topic matters (Big Idea): " + bigIdea : ""}${sk.reviewFrom ? "\n- Note: this skill is borrowed back from Grade " + sk.reviewFrom + " for review — the child met it before, so refresh and deepen it rather than teaching it from scratch." : ""}`
    : isBook
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

${isSkills
  ? `This is not a full lesson — it is a 3-5 minute **micro-lesson**: teach just this one small step well, and do not cover the whole curriculum standard around it.`
  : `This lesson is not about solving one problem — you are teaching the ${isCourse ? "student" : "child"} a new concept, like a little video class.`}
${origin}${elabs ? (isSkills ? "\n- How to teach this micro-lesson:\n" : "\n- Sub-skills included:\n") + elabs : ""}${style}${ref}

Iron rules:
1. Accuracy first. Re-check every bit of arithmetic before writing. The answer must be correct — a real child is watching, and getting it wrong is worse than not teaching at all.
2. One small idea per step. Encouraging, conversational tone; use everyday examples (${st.exEn || "sharing pizza, shopping with dollars, measuring heights"}).
3. Drive the lesson with worked examples — never stay abstract; always land on concrete numbers.${st.toneEn}

${isSkills
  ? `Micro-lesson structure (output 4-6 steps — shorter than a full lesson):
1. One sentence connecting to what the child already knows, naming what this step solves
2. Teach this one step clearly, with pictures${hints}
3. One worked example; if common mistakes are listed above, spend one step showing the mistake and why it is wrong
4. End with a one-line takeaway
Teach only this step. Use prerequisite knowledge freely without re-teaching it, and never preview material that comes later.`
  : `Lesson structure (still output 5-8 steps):
1. Open with a real-life example that shows why this concept exists and what problem it solves
2. Teach the core method clearly, with pictures${hints}
3. Walk the ${isCourse ? "student" : "child"} through 1-2 worked examples, from easy to slightly harder
4. End with a one-line takeaway`}
Use BC-flavoured everyday contexts where natural (Canadian dollars, metric units, local life).

${lessonFieldsEn(isSkills ? "4-6 steps (this is a micro-lesson, shorter than a full one)" : null)}
- answer: the one-line takeaway of this lesson, short and memorable — shown prominently.
- practice: one practice problem matching ${isSkills ? "this one step" : "this concept"} (question + answer), set in a BC everyday context (dollars, metric units).${isSkills && (sk.rep || []).length ? ` Frame the practice problem around the "${sk.rep[0]}" model, but the practice area has no picture — state every number in words (or ask the child to draw it themselves); never write "look at the figure below".` : ""}

Teach just this one ${isSkills ? "step" : "concept"}, in the easiest possible way.`;
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
          explain: { type: "string" },
          /* 技能层题库才有：4 个选项各挂一个标签，正确项 "ok"，干扰项是误区 id（设计文档 §6）。
           * 老题库没有这个字段，判分完全不看它——它只喂给诊断/回补。 */
          tags: { type: "array", items: { type: "string" } }
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
/* 技能层题库多一个 tags（每个选项一个标签），格式说明也要跟着变，否则模型不会输出它 */
const QBANK_HINT_SKILL = {
  zh: QBANK_HINT.zh.replace('"explain":"..."}]}', '"explain":"...","tags":["ok","误区id","误区id","误区id"]}]}'),
  en: QBANK_HINT.en.replace('"explain":"..."}]}', '"explain":"...","tags":["ok","misconception-id","misconception-id","misconception-id"]}]}')
};

function qbankPrompt(item, gradeData, lang, needs, existingStems) {
  const g = gradeData.grade;
  const strand = (gradeData.strandDefs || STRANDS).find(s => s[0] === item.strand) || ["", item.strand, item.strand];
  const wants = [1, 2, 3].filter(lv => needs[lv]);
  const total = wants.reduce((s, lv) => s + needs[lv], 0);
  const avoid = (existingStems || []).slice(0, 30);
  const isBook = gradeData.type === "book";
  const isCourse = isCourseData(gradeData);
  const isSkills = isSkillsData(gradeData);
  const sk = isSkills ? (item.skill || {}) : null;
  const trap = distractorHint(gradeData, lang);
  /* 技能层出题的额外约束（设计文档 §3.3 / §6）：L1 必须用这个技能的第一种表示，
   * L3 的干扰项要逐个打在登记在册的误区上。用数组拼而不是层层嵌套模板——这段要经常改。 */
  const skillRules = (() => {
    if (!isSkills) return "";
    const en = lang === "en";
    const ty = SKILL_TYPE[sk.type] || {};
    const rep0 = (sk.rep || [])[0] || "symbolic";
    const L = [""];
    L.push(en
      ? "This is ONE small skill, not a whole standard — keep every question inside it."
      : "这是一个**小技能**，不是一整条大纲内容——每道题都要落在这一小步里面。");
    L.push(en
      ? `- Skill type: ${ty.en || sk.type} — ${ty.teachEn || ""}.`
      : `- 技能类型：${ty.zh || sk.type}——${ty.teachZh || ""}。`);
    L.push(en
      /* 注意：闯关题是纯文字四选一，没有配图字段。所以「用某种表示出题」= 用文字把那个模型
       * 说清楚（几等份、涂了几份），而不是让孩子去看一张不存在的图。2026-08-22 审稿抓到过
       * 「Look at the fraction bar below」这种引用不存在图形的题，就是这句话没写清楚导致的。 */
      ? `- Level 1 must be framed around the "${rep0}" model, described ENTIRELY IN WORDS: there is no picture, so state every number the child needs (how many equal parts, how many are shaded, what the whole is). Never write "look at the diagram/figure/bar below" or refer to an image — the question must be fully answerable from its own text. Level 2 may move to bare symbols; Level 3 is a context or misconception question.`
      : `- L1 要围绕「${SKILL_REP_ZH[rep0] || rep0}」这个模型出，但必须**全部用文字说清楚**：题目里没有图，所以要把孩子需要的数都写出来（平均分成几份、涂了几份、整体是什么）。绝对不要写「看下面的图/分数条」之类引用图形的话——光读题干就要能答。L2 可以转到纯符号；L3 出情境题或误区辨析题。`);
    L.push(en
      ? `- The standard this skill belongs to (context only, do not test the rest of it): ${sk.standardEn || "—"}`
      : `- 这个技能所属的大纲条目（只作背景，别把整条都考了）：${sk.standardEn || "—"}${sk.standardZh ? "（" + sk.standardZh + "）" : ""}`);
    if ((sk.prereq || []).length) L.push(en
      ? `- The child already has these prerequisites — you may use them, but they must not be the point being tested: ${sk.prereq.map(p => p.en).join("; ")}`
      : `- 孩子已经会的先修（可以用，但考点不能落在它们身上）：${sk.prereq.map(p => p.zh).join("；")}`);
    if ((sk.misc || []).length) {
      L.push(en
        ? "- Build distractors on THESE registered misconceptions, and tag each option with the id:"
        : "- 干扰项请**逐个**建立在下面这些登记在册的误区上，并给每个选项打标签：");
      for (const m of sk.misc) L.push(en
        ? `  · ${m.id} — ${m.en} (looks like: ${m.pattern})`
        : `  · ${m.id} —— ${m.zh}（长这样：${m.pattern}）`);
      L.push(en
        ? `- Also output "tags": an array of 4 strings, one per option in the same order — "ok" for the correct option, and the misconception id for each distractor. Use "other" only if a distractor genuinely matches none of the ids above.`
        : `- 另外输出 "tags"：4 个字符串的数组，顺序和 options 一一对应——正确项写 "ok"，每个干扰项写它对应的误区 id。实在对不上上面任何一个才写 "other"。`);
    }
    return L.join("\n");
  })();
  if (lang === "en") {
    const elab = isSkills ? "" : (item.elaborations || []).map(e => "- " + e.en).join("\n");   // 技能层由 skillRules 讲，别重复一遍
    const terms = itemTerms(item).map(tm => tm.en).join(", ");
    const who = isSkills
      ? `You are a BC math teacher building a question bank for ONE small skill (Grade ${g}, topic "${strand[2]}").`
      : isBook
      ? `You are a math teacher building a question bank for ONE section of the book "${(gradeData.title || {}).en || gradeData.bookId}" (${strand[2]}), studied by a Grade ${g} child in BC, Canada.`
      : isCourse
      ? `You are a BC high-school math teacher building a question bank for ONE topic of the course "${(gradeData.title || {}).en || gradeData.courseId}" (Grade ${g}, unit "${strand[2]}").`
      : `You are a BC math teacher building a question bank for ONE Grade ${g} topic ("${strand[2]}" strand).`;
    return `${who} The child just watched a lesson on it and now answers questions one at a time — right answers raise the difficulty, like the SAT. Write ${total} original multiple-choice questions: ${wants.map(lv => `${needs[lv]} at Level ${lv}`).join(", ")}.

${isSkills ? "The skill" : isBook ? "The section" : "The topic (official wording)"}: ${item.en}${elab ? `
What it covers:
${elab}` : ""}${terms ? `
Key terms: ${terms}` : ""}${skillRules}

Difficulty levels:
- Level 1 (warm-up): one step, direct use of the concept just taught; short stem, no or minimal context. Checks "did you get it".
- Level 2 (level-up): standard textbook difficulty, 1-2 steps, a small real-life context or choosing the right method. Checks "can you use it".
- Level 3 (challenge): FSA-style — a real-life scenario needing at least two reasoning steps, or a question built around the most common misconception in this topic. Checks "is it solid".

Iron rules:
1. Test ONLY this ${isSkills ? "one small skill" : "topic"}. Earlier skills may appear naturally, but the point being tested must be this ${isSkills ? "skill" : "topic"}.
2. Exactly 4 options, exactly 1 correct. Distractors come from real common mistakes (${trap}) — never obviously wrong.
3. answerIndex is the index (0-3) of the correct option. Scatter correct positions across the batch.
4. Numbers must be computable by hand and age-appropriate; use dollars and metric units; scenes from a BC child's life.
5. Accuracy first: re-check every question so exactly one option is correct.
6. explain: one or two sentences — the correct method plus the most common trap. It is shown to the child right after a wrong answer, so write it to teach.
   Never refer to an option by position ("option B", "the third choice") — options get reordered; name the content instead ("the one that says 3/8").
7. Every question must differ from the others in this batch${avoid.length ? ` AND from these existing bank questions:
${avoid.map(s => "- " + s).join("\n")}` : ""}.`;
  }
  const elab = isSkills ? "" : (item.elaborations || []).map(e => "- " + (e.zh || e.en)).join("\n");   // 技能层由 skillRules 讲，别重复一遍
  const terms = itemTerms(item).map(tm => `${tm.en}=${tm.zh}`).join("、");
  const whoZh = isSkills
    ? `你是 BC 省的数学出题老师，为 Grade ${g}「${strand[1]}」主题里的**一个小技能**建题库。`
    : isBook
    ? `你是数学出题老师，为教材《${(gradeData.title || {}).zh || (gradeData.title || {}).en || gradeData.bookId}》（${strand[1]}）里的一个小节建题库；孩子在加拿大 BC 上 Grade ${g}。`
    : isCourse
    ? `你是 BC 省的高中数学出题老师，为 ${(gradeData.title || {}).en || gradeData.courseId}（${(gradeData.title || {}).zh || ""}，Grade ${g}）课程「${strand[1]}」单元里的一个知识点建题库。`
    : `你是 BC 省的数学出题老师，为 Grade ${g}「${strand[1]}」主线里的一个知识点建题库。`;
  return `${whoZh}孩子刚看完这个知识点的讲解课，现在一道一道做题——做对了会升难度（类似 SAT 机制）。请出 ${total} 道原创选择题：${wants.map(lv => `L${lv} ${needs[lv]} 道`).join("、")}。

${isSkills ? "技能（英文说法）" : isBook ? "小节（原书标题）" : "知识点（官方原文）"}：${item.en}
中文：${item.zh}${elab ? `
包含内容：
${elab}` : ""}${terms ? `
关键术语：${terms}` : ""}${skillRules}

难度定义：
- L1 热身：单步、直接套用刚学的概念；题干短，无情境或极简情境。检查「听懂了没」。
- L2 应用：标准课本难度，1-2 步，带简单生活情境或需要自己选方法。检查「会用了没」。
- L3 挑战：FSA 风格——需要至少两步推理的真实情境题，或针对这个知识点最常见误区的辨析题。检查「真扎实没」。

出题铁律：
1. 只考${isSkills ? "这一个小技能" : "这个知识点"}。可以自然用到更早学过的技能，但考点必须落在${isSkills ? "本技能" : "本知识点"}上。
2. 每题恰好 4 个选项、恰好 1 个正确。干扰项必须来自真实常见错误（${trap}），不要一眼假。
3. answerIndex 是正确选项的下标（0~3），整批正确答案的位置要打散，别集中在同一个下标。
4. 数字口算/竖式能算动、适龄；货币用加元、单位用公制，情境用孩子在 BC 的真实生活。
5. 准确第一：每题出完自己验算一遍，确认有且只有一个选项正确。
6. explain 一两句话：正确解法 + 最容易踩的坑。孩子答错后马上会看到，要写得能教会人。
   解析里不要写「选项 B」「第三个选项」这种位置说法（选项顺序会被重排），要说内容本身（如「写成 3/8 的那个」）。
7. 题干用中文，关键数学术语可自然带一次英文对照（如「周长（perimeter）」）。
8. 这批题互相不能重复${avoid.length ? `，也不能和题库里已有的这些题重复：
${avoid.map(s => "- " + s).join("\n")}` : ""}。`;
}

/* 题干里的换行：模型常把换行写成字面量 \n（反斜杠加 n）塞进字符串，前端会原样显示两个字符，换成真换行 */
const unlitNewline = s => String(s == null ? "" : s).replace(/\\n/g, "\n");
/* allowedTags：技能层题库传该技能的误区 id 集合，干扰项标签必须落在里面（"ok"/"other" 永远允许）。
 * 标签只喂诊断/回补，判分完全不看它——所以标签不合格只丢标签，绝不因此丢掉一道好题。 */
function validateQbankBatch(raw, requested, allowedTags) {
  if (!raw || typeof raw !== "object") throw new Error("出题格式不对");
  const qs = (Array.isArray(raw.questions) ? raw.questions : []).map(q => {
    if (!q || typeof q !== "object") return null;
    // answerIndex 指向 options 原数组，绝不能过滤/截断（教训同 FSA：下标一错位就把答对判成答错）
    const options = Array.isArray(q.options) ? q.options.map(o => unlitNewline(o).trim()) : [];
    const ai = Math.round(Number(q.answerIndex));
    const lv = Math.round(Number(q.level));
    if (!String(q.question || "").trim() || options.length !== 4 || options.some(o => !o)
      || !(ai >= 0 && ai <= 3) || !(lv >= 1 && lv <= QUIZ_TOP_LEVEL)) return null;
    const out = { level: lv, question: unlitNewline(q.question).trim(), options, answerIndex: ai, explain: unlitNewline(q.explain).trim() };
    if (allowedTags && Array.isArray(q.tags) && q.tags.length === 4) {
      const tags = q.tags.map((t, i) => {
        const v = String(t || "").trim();
        if (i === ai) return "ok";                       // 正确项的标签一律规范成 ok
        return (v && v !== "ok" && (allowedTags.has(v) || v === "other")) ? v : "other";
      });
      /* 只要模型给了 4 个标签就存，哪怕全是 other。之前这里要求"至少命中一个登记误区"才存，
       * 结果只登记了 1 个误区的技能（如 FRAC.EQUIV.NUMBERLINE）有 3/4 的题被当空壳丢掉——
       * 实测 tags 覆盖率掉到 25%。["ok","other","other","other"] 不是空壳：它明确说明这道题
       * 答错不对应任何登记误区、不该触发回补，和"没打标签"是两回事。 */
      out.tags = tags;
    }
    return out;
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
    problems: { type: "array", items: { type: "string" } },
    /* bad：有问题的题的序号（0 起，对应送审数组的下标）。题库审稿按题剔除用：
     * 12 道里错 1 道只丢那 1 道，不再整批重来。课/卷的审稿不用它。 */
    bad: { type: "array", items: { type: "number" } }
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
/* 题库审稿的格式说明：多一个 bad 数组，指出哪几道题有问题（序号从 0 起）。
 * 2026-08-22 实测 qwen 单题错误率约 4-5%，但「12 道里错 1 道整批作废」把它放大成了
 * 40-50% 的整批拒绝率——95% 的好题跟着倒掉，审稿钱也白花。按题剔除后只补缺的几道。 */
const JUDGE_HINT_QUIZ = {
  zh: JUDGE_HINT.zh.replace('{"pass":true或false,"problems":["发现的问题，一条一句；没有就给空数组"]}',
    '{"pass":true或false,"problems":["发现的问题，一条一句；没有就给空数组"],"bad":[有问题的题的序号，从0起，对应送审数组的下标；没有就给空数组]}\n每条 problem 都要对应 bad 里的一个序号；pass=false 时 bad 不能为空。'),
  en: JUDGE_HINT.en.replace('{"pass":true or false,"problems":["one issue per string; empty array if none"]}',
    '{"pass":true or false,"problems":["one issue per string; empty array if none"],"bad":[0-based indexes of the questions with problems, matching the reviewed array; empty if none]}\nEvery problem must correspond to an index in bad; when pass=false, bad must not be empty.')
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
  // bad 可选：去重、只留非负整数。审稿人偶尔会写 1 起的序号或字符串，这里不猜，调用方按范围再过滤一遍
  // 只认真正的数字或纯数字字符串；null/true/"" 经 Number() 会变成 0，不能让它们把第 0 题冤枉掉
  const bad = [...new Set((Array.isArray(v.bad) ? v.bad : [])
    .filter(n => typeof n === "number" || (typeof n === "string" && /^\s*\d+\s*$/.test(n)))
    .map(n => Math.round(Number(n))).filter(n => Number.isInteger(n) && n >= 0))];
  return { pass: v.pass, problems, bad };
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
        // qwen 的一个固定毛病：值后面多粘一个引号，后面紧跟 , } ] 就丢掉它。
        //   数字后：{"level":2"，{"answerIndex":1"
        //   字符串后：["ok","other"","ok"]、"explain":"…"" —— 合法 JSON 里字符串收尾引号后面
        //   只可能跟 , } ] :，绝不会再来一个引号，所以这里丢掉它是安全的
        //   （空字符串 "" 走的是 inStr 分支，到不了这里）
        const prev = out.replace(/\s+$/, "").slice(-1);
        let j = i + 1; while (j < t.length && /\s/.test(t[j])) j++;
        if (/[0-9el"]/.test(prev) && j < t.length && ",}]".includes(t[j])) continue;
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
      // 后面紧跟一个多余引号、再后面才是 , } ] :（"other"" 这种）：当前这个才是收尾引号，
      // 多余那个留给上面「值后多粘引号」的规则丢掉。不这么判的话收尾引号会被当成内容转义进字符串。
      let stray = false;
      if (t[j] === '"') {
        let k = j + 1;
        while (k < t.length && /\s/.test(t[k])) k++;
        stray = k >= t.length || ",}]:".includes(t[k]);
      }
      if (j >= t.length || ",}]:".includes(t[j]) || stray) { inStr = false; out += c; }
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
  /* 顶层可能是对象也可能是数组：模型偶尔直接吐一个数组（尤其被 format/schema 约束时）。
   * 只按 { } 截会把数组里第一个对象抠出来当整体，报 "Unexpected non-whitespace after JSON"。
   * 取两者中先出现的那个作为起点，配对的收尾符号作为终点。 */
  const so = t.indexOf("{"), sa = t.indexOf("[");
  const useArr = sa >= 0 && (so < 0 || sa < so);
  const s = useArr ? sa : so, e = useArr ? t.lastIndexOf("]") : t.lastIndexOf("}");
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
    const out = await runCmd(detected.claude.bin, args, { cwd: dir, timeout: 600000 });
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
/* 送去合成之前把「看着对、念着错」的写法换成读音：CosyVoice 把 "Ms. Yuanyuan" 按字母念成
 * "M S Yuanyuan"（2026-08-23 用户反馈）。只改送给引擎的文本，**不改哈希**（ttsId 仍按原文算），
 * 否则所有已烘的语音包和缓存全部失效。屏幕上显示的还是 "Ms."。
 * 规则只收最保险的几条，别在这里做大而全的 TTS 归一化。 */
function ttsSpeakable(text, lang) {
  let t = String(text || "");
  if (lang === "en") {
    t = t.replace(/\bMs\.\s*Yuanyuan\b/g, "Miss Yuanyuan")   // 用户钦定的读法
         .replace(/\bMs\.(?=\s)/g, "Miss")
         .replace(/\bMrs\.(?=\s)/g, "Missus")
         .replace(/\bMr\.(?=\s)/g, "Mister")
         .replace(/\bDr\.(?=\s)/g, "Doctor");
  }
  return t;
}

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
    items: pend.map(it => ({ id: it.id, text: ttsSpeakable(it.text, it.lang), lang: it.lang }))
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
          text: ttsSpeakable(it.text, it.lang), lang: it.lang,
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
    // 上限只是防御性护栏：曾经是 600，把 219 段英文旁白拦腰截断（最长 1296，
    // 2026-08-24 盲听项目发现），提到 2000。改这里要同步 prevoice/export_apple 的取词。
    const text = String((raw && raw.text) || "").trim().slice(0, 2000);
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

/* 技能图谱预览（data/curriculum/skills/g*.json，见 docs/skill-graph-plan.md）：设计草稿，还在评审中。
 * 复用书籍的形状（strandDefs=主题，items=技能）挂进同一张 Map，讲课/闯关/进度/报告零改动跑通——
 * 这条路已经被书籍验证过。条目 id 就是技能 id（YY.MATH.xxx），elaborations 由技能的
 * 先修/表示/误区现算，没有额外的人工内容。和书籍一样在 YY_DEMO 跳过（没有预生成课）。 */
const SKILLS_DIR = path.join(ROOT, "data", "curriculum", "skills");
/* 六种技能类型（设计文档 §3.4）：一个技能只测一种能力，讲课和出题都按它调重心 */
const SKILL_TYPE = {
  concept:   { zh: "理解概念", en: "concept",        teachZh: "重点是「这是什么、为什么这样」，别急着教步骤", teachEn: "focus on what it means and why, not the procedure" },
  represent: { zh: "会用表示", en: "representation", teachZh: "重点是同一个意思换几种画法/写法都认得", teachEn: "focus on moving between models, number lines and symbols" },
  procedure: { zh: "会算会做", en: "procedure",      teachZh: "重点是步骤清楚、每步为什么这么做", teachEn: "focus on clear steps and why each step works" },
  reason:    { zh: "会讲道理", en: "reasoning",      teachZh: "重点是让孩子说出理由、判断对错", teachEn: "focus on justifying and judging, not just computing" },
  apply:     { zh: "会用起来", en: "application",    teachZh: "重点是从真实情境里认出该用这个方法", teachEn: "focus on recognizing the situation in real contexts" },
  fluency:   { zh: "练到熟练", en: "fluency",        teachZh: "重点是又快又准，讲策略而不是硬背", teachEn: "focus on speed and accuracy through strategies, not rote memory" }
};
/* 表示方式 → 中文说法（讲课提示词用；未列出的直接用英文 visual 名，它们本来就是配图类型名） */
const SKILL_REP_ZH = {
  symbolic: "算式符号", context: "生活情境", numberLine: "数轴", fractionBar: "分数条", pie: "圆形分数图",
  areaGrid: "方格纸", hundredthsGrid: "百格图", baseTen: "十进制积木", placeValue: "数位表", groups: "分组图",
  areaModel: "面积模型", barModel: "条形图", balance: "天平", coordGrid: "坐标格", dataTable: "表格",
  statBar: "条形统计图", statLine: "折线统计图", pieChart: "扇形统计图", spinner: "转盘", balls: "摸球",
  probLine: "可能性数轴", clock: "钟面", shapeRect: "长方形", shapeTriangle: "三角形", shapeCircle: "圆",
  solidCube: "正方体", solidCuboid: "长方体", solidCylinder: "圆柱", netCuboid: "长方体展开图",
  netCylinder: "圆柱展开图", angle: "角", hundredChart: "百数表"
};
const skillMisconceptions = new Map();   // 误区 id -> { id, zh, en, pattern, remedy }
const skillIndex = new Map();            // 技能 id -> 技能（另带 grade / topicId / topicZh / topicEn）
const skillsByStandard = new Map();      // BC 标准 id -> [技能 id]（只收 primary，标准级汇总用）
try {
  const d = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, "misconceptions.json"), "utf8"));
  for (const m of d.items || []) skillMisconceptions.set(m.id, m);
} catch (_) { /* 没有误区登记表也能跑，只是讲课少一句提醒、出题少一批标签 */ }
const skillOf = id => skillIndex.get(id) || null;
const isSkillsData = d => !!d && d.type === "skills-preview";
/* 技能的「课程说明」：类型 / 表示 / 先修 / 误区，现算成 elaborations 的形状，
 * 让不认识技能层的老代码（单元卷出题、报告）也能拿到有用的上下文 */
function skillElaborations(s) {
  const out = [];
  const ty = SKILL_TYPE[s.type] || { zh: s.type, en: s.type, teachZh: "", teachEn: "" };
  const reps = (s.rep || []).map(r => SKILL_REP_ZH[r] || r);
  out.push({
    en: `Skill type: ${ty.en} — ${ty.teachEn}. Representations to use: ${(s.rep || []).join(", ")}.`,
    zh: `技能类型：${ty.zh}——${ty.teachZh}。要用到的表示方式：${reps.join("、")}。`
  });
  const pre = (s.prereq || []).map(id => skillOf(id)).filter(Boolean);
  if (pre.length) out.push({
    en: "Already learned (build on these, do not re-teach): " + pre.map(p => p.en).join("; "),
    zh: "孩子在这之前已经学过（直接借力，不要从头再讲一遍）：" + pre.map(p => p.zh).join("；")
  });
  const miscs = (s.misc || []).map(id => skillMisconceptions.get(id)).filter(Boolean);
  if (miscs.length) out.push({
    en: "Common mistakes to call out explicitly: " + miscs.map(m => `${m.en} (e.g. ${m.pattern})`).join("; "),
    zh: "这个技能孩子最容易踩的坑，讲课时主动点破：" + miscs.map(m => `${m.zh}（比如「${m.pattern}」）`).join("；")
  });
  return out;
}
if (!process.env.YY_DEMO) try {
  /* 两遍加载：先把所有年级的技能收进 skillIndex，先修/复习才能跨年级解析 */
  const parsed = [];
  for (const f of fs.readdirSync(SKILLS_DIR)) {
    const m = /^g(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
      if (raw.schema !== "yy-skills/1" || !Array.isArray(raw.skills)) {
        console.log(`[curriculum] skills/${f} ignored: needs schema "yy-skills/1" and skills[]`);
        continue;
      }
      const grade = Number(m[1]);
      const topics = new Map((raw.topics || []).map(t => [t.id, t]));
      for (const s of raw.skills) {
        const t = topics.get(s.topic);
        skillIndex.set(s.id, { ...s, grade, topicId: s.topic, topicZh: (t || {}).zh || s.topic, topicEn: (t || {}).en || s.topic });
        if (s.primary) {
          if (!skillsByStandard.has(s.primary)) skillsByStandard.set(s.primary, []);
          skillsByStandard.get(s.primary).push(s.id);
        }
      }
      parsed.push({ grade, raw, topics });
    } catch (e) { console.log(`[curriculum] skills/${f} failed to parse: ${e.message}`); }
  }
  for (const { grade, raw, topics } of parsed) {
    const bcGrade = curriculum.get(grade);   // grade-N.json 已在上面的主循环里加载好，借它的原文和术语
    const stdById = new Map(((bcGrade && bcGrade.items) || []).map(it => [it.id, it]));
    const mkItem = (s, reviewFrom) => {
      const std = stdById.get(s.primary) || null;
      return {
        id: s.id, strand: s.topic, en: s.en, zh: s.zh,
        elaborations: skillElaborations(s),
        terms: (std && std.terms) || [],
        teachHints: s.hints || "",
        /* 技能层专属元数据：讲课 / 出题 / 汇总认这个字段，老代码不认也不受影响 */
        skill: {
          type: s.type, rep: s.rep || [], core: s.core !== false,
          primary: s.primary, supporting: s.supporting || [],
          standardEn: (std && std.en) || "", standardZh: (std && std.zh) || "",
          prereq: (s.prereq || []).map(id => { const p = skillOf(id); return p ? { id, zh: p.zh, en: p.en, grade: p.grade } : null; }).filter(Boolean),
          misc: (s.misc || []).map(id => skillMisconceptions.get(id)).filter(Boolean),
          diag: s.diag || null,
          reviewFrom: reviewFrom || 0        // >0 = 这条是从低年级借来复习的
        }
      };
    };
    const items = raw.skills.map(s => mkItem(s));
    /* 主题的 review[]：把低年级技能借过来放在本主题末尾，不复制定义（设计文档 §3.1） */
    for (const t of raw.topics || []) {
      for (const rid of t.review || []) {
        const r = skillOf(rid);
        if (!r || items.some(it => it.id === rid)) continue;
        items.push({ ...mkItem(r, r.grade), strand: t.id });
      }
    }
    const d = {
      jurisdiction: "BC", type: "skills-preview", skillsId: "skills-g" + grade, grade,
      title: { en: "BC Grade " + grade + " · skills", zh: "BC " + grade + " 年级 · 技能" },
      short: { en: "G" + grade + " skills", zh: "G" + grade + " 技能" },
      /* 来源标注：底层仍是 BC 官方大纲（技能全部对齐到条目），前端页脚显示这一行 */
      source: { kind: "skills-preview", version: (bcGrade && bcGrade.source && bcGrade.source.version) || "",
        label: "BC Curriculum · " + ((bcGrade && bcGrade.source && bcGrade.source.version) || "") + " · curriculum.gov.bc.ca · " + (raw.topics || []).length + " topics / " + raw.skills.length + " skills" },
      strandDefs: (raw.topics || []).map(t => [t.id, t.zh, t.en]),
      /* 主题的「为什么学」借它对齐的 BC Big Idea（同一条主线那句）。BC 每条主线只有一句，
       * 而一条主线下面往往有好几个主题——同一句话挂满整屏是噪音，还会张冠李戴
       * （理财挂到「数与运算」那句上）。所以每条主线只在它的第一个主题上出现一次。 */
      bigIdeas: (() => {
        const used = new Set(), out = [];
        for (const t of raw.topics || []) {
          const std = stdById.get((t.standards || [])[0]);
          if (!std || used.has(std.strand)) continue;
          const bi = (bcGrade.bigIdeas || []).find(b => b.strand === std.strand);
          if (!bi) continue;
          used.add(std.strand);
          out.push({ strand: t.id, en: bi.en, zh: bi.zh });
        }
        return out;
      })(),
      /* 每个主题对齐到哪几条 BC 标准：前端拿来在标题上标注，并给出「总览课」入口——
       * 原来那 69 节条目课不作废，降级成主题的总览课（设计文档 §7 阶段 2）。 */
      topicStandards: Object.fromEntries((raw.topics || []).map(t => [t.id, (t.standards || []).map(sid => {
        const std = stdById.get(sid);
        return { id: sid, zh: (std && std.zh) || sid, en: (std && std.en) || sid };
      })])),
      items
    };
    curriculum.set(d.skillsId, d);
  }
} catch (_) { /* 没有技能图谱草稿也能跑 */ }

function curriculumGrades() { return [...curriculum.keys()].filter(k => typeof k === "number").sort((a, b) => a - b); }
function curriculumBooks() {
  return [...curriculum.entries()].filter(([k, d]) => typeof k === "string" && d.type === "book").map(([k, d]) => ({
    id: k, grade: d.grade || 0,
    zh: ((d.short || d.title || {}).zh) || k,
    en: ((d.short || d.title || {}).en) || k
  }));
}
/* 技能图谱预览（设计草稿）：形状和 curriculumBooks() 一样，前端按同一套下拉/标签逻辑渲染 */
function curriculumSkillsPreviews() {
  return [...curriculum.entries()].filter(([k, d]) => typeof k === "string" && d.type === "skills-preview").map(([k, d]) => ({
    id: k, grade: d.grade || 0,
    zh: ((d.short || d.title || {}).zh) || k,
    en: ((d.short || d.title || {}).en) || k
  })).sort((a, b) => a.grade - b.grade);
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
/* 「跟大纲学」清单用哪份数据：年级有技能图谱（data/curriculum/skills/g<N>.json）就用技能视图
 * （年级 → 主题 → 技能，设计文档 §3），没有就用大纲条目视图。BC 标准树只留给家长报告和 FSA——
 * 那两处继续直接 curriculum.get(数字)。传 view="standards" 可以强制看老清单。 */
function learnView(key, view) {
  const d = curriculum.get(key);
  if (!d || typeof key !== "number" || view === "standards") return d;
  return curriculum.get("skills-g" + key) || d;
}
/* 单元测试 / 题库等按「年级 key + 单元」存档的东西，技能视图下 key 得是技能视图自己的 id，
 * 不然 skills-g5 的主题卷和老 5 年级的主线卷会撞同一个文件名 */
const viewKey = (key, d) => (d && d.type === "skills-preview") ? d.skillsId : key;
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
/* ---------------- 标准级汇总（技能 → BC 标准，设计文档 §6） ----------------
 * 技能进度沿用同一套 progress 事件，key 换成 skillId；一条 BC 标准的级别由它下面的
 * 核心技能（core:true）汇总出来。没有技能挂靠的标准返回 null，调用方回退到原来的
 * 「标准自己那条 progress」——所以 G8/G9、高中课、书籍完全不受影响。 */
const LEVEL_RANK = { emerging: 0, developing: 1, proficient: 2, extending: 3 };
function standardRollup(kidId, standardId) {
  const ids = skillsByStandard.get(standardId);
  if (!ids || !ids.length) return null;
  const core = ids.filter(id => (skillOf(id) || {}).core !== false);
  const pool = core.length ? core : ids;
  const progress = kd(kidId).progress;
  const levels = pool.map(id => progressLevel(kidId, id));
  const touched = pool.filter(id => progress[id]).length;
  const proficient = levels.filter(l => LEVEL_RANK[l] >= 2).length;
  let level = "emerging";
  if (proficient === pool.length) {
    /* 全部核心技能站稳 = Proficient；再要 Extending，得有一个「会讲道理/会用起来」的技能到 Extending */
    const deep = pool.some(id => {
      const s = skillOf(id);
      return s && (s.type === "apply" || s.type === "reason") && progressLevel(kidId, id) === "extending";
    });
    level = deep ? "extending" : "proficient";
  } else if (touched) level = "developing";
  /* 旧数据：孩子在 BC 标准这条 id 上有进度，但一个技能都没做过。不能等价成「所有子技能都会了」，
   * 记成低置信度的历史证据，让前端/报告分开显示，后续做题自然校准（设计文档 §6 / §7 阶段 2）。 */
  const own = progress[standardId];
  const legacy = (!touched && own && (own.taught || own.right || own.wrong || own.solid || own.quizPassedAt))
    ? { level: progressLevel(kidId, standardId), confidence: "low" } : null;
  return { level, total: pool.length, touched, proficient, legacy };
}
/* 误区计数与回补建议（设计文档 §6）
 * 一道题答错、且它的干扰项挂了误区 id，就在这个技能名下记一笔。同一个误区攒到
 * MISS_TRIGGER 次，说明不是手滑而是稳定的错误模式 —— 按技能自己的 diag.branch
 * （没有就按误区登记表的 remedy）找出该回去补的技能。计数写在孩子的 progress 条目里，
 * 和 right/wrong 一起走同一套持久化。 */
const MISS_TRIGGER = 2;
function missRecord(kidId, skillId, miscId) {
  const progress = kd(kidId).progress;
  const e = progress[skillId] || (progress[skillId] = { taught: 0, right: 0, wrong: 0, lastAt: 0, solid: false, rightDays: [], lessonIds: [] });
  const m = e.miss || (e.miss = {});
  m[miscId] = (m[miscId] || 0) + 1;
  e.lastAt = Date.now();
  kidSave(kidId, "progress");
}
/* 这个技能现在该不该回补？返回 { miscId, zh, en, times, skillId, skillZh, skillEn } 或 null */
function remediationFor(kidId, skillId) {
  const e = kd(kidId).progress[skillId];
  if (!e || !e.miss) return null;
  const s = skillOf(skillId);
  let best = null;
  for (const [miscId, times] of Object.entries(e.miss)) {
    if (times < MISS_TRIGGER) continue;
    if (!best || times > best.times) best = { miscId, times };
  }
  if (!best) return null;
  const branch = (s && s.diag && s.diag.branch) || {};
  const targetId = branch[best.miscId] || (skillMisconceptions.get(best.miscId) || {}).remedy || "";
  const target = targetId ? skillOf(targetId) : null;
  const m = skillMisconceptions.get(best.miscId) || {};
  return {
    miscId: best.miscId, times: best.times, zh: m.zh || best.miscId, en: m.en || best.miscId,
    skillId: targetId, skillZh: target ? target.zh : "", skillEn: target ? target.en : ""
  };
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
/* 正确答案位置打散（qbank-standard §1）。提示词里要求过，但模型不听：2026-08-22 实测
 * 120 道题的 answerIndex 分布是 38/53/20/9——闭着眼睛全选 B 就有 44% 正确率。
 * 所以在入库这一步强制重排：options 和 tags 是位置对齐的，必须一起搬。
 * 解析里点名「选项 B」「option C」的题跳过不动，打散了会把解析说岔。 */
const REFS_OPTION_POS = /选项\s*[ABCD一二三四]|第[一二三四1234]\s*个选项|\boption\s*[ABCD]\b|\bchoice\s*[ABCD]\b/i;
function qbankSpread(q, wantIdx) {
  if (q.answerIndex === wantIdx) return q;
  if (REFS_OPTION_POS.test(q.explain || "")) return q;
  const order = [0, 1, 2, 3];
  [order[q.answerIndex], order[wantIdx]] = [order[wantIdx], order[q.answerIndex]];   // 只对调正确项和目标位
  q.options = order.map(i => q.options[i]);
  if (Array.isArray(q.tags) && q.tags.length === 4) q.tags = order.map(i => q.tags[i]);
  q.answerIndex = wantIdx;
  return q;
}
function qbankMerge(bank, batch) {
  const norm = s => s.toLowerCase().replace(/\s+/g, "");
  const seen = new Set(bank.questions.map(q => norm(q.question)));
  // 本题库已有的答案位置分布，新题往最空的位置填，整体自然趋于均匀
  const spread = [0, 1, 2, 3].map(i => bank.questions.filter(x => x.answerIndex === i).length);
  for (const q of batch) {
    const k = norm(q.question);
    if (seen.has(k)) continue;
    if (bank.questions.filter(x => x.level === q.level).length >= QUIZ_LEVEL_CAP) continue;
    seen.add(k);
    const want = spread.indexOf(Math.min(...spread));
    qbankSpread(q, want);
    spread[q.answerIndex]++;
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
  /* 技能层题库：干扰项要打误区标签，格式说明和校验白名单都跟着换 */
  const skillTags = isSkillsData(gradeData) && ((item.skill || {}).misc || []).length
    ? new Set(item.skill.misc.map(m => m.id)) : null;
  /* 出题保持思考开着（跟 config 走）：2026-08-22 实测，关掉思考 JSON 是干净了，
   * 但数学错误率暴涨——审稿在 74 次尝试里拒了 30 次（标错答案、两个选项都对、题干自相矛盾）；
   * 开着思考的样本凡是解析成功的全都过审。格式问题改由 repairJson 兜（值后多粘引号那条）。 */
  const opts = { schema: QBANK_SCHEMA, hint: (skillTags ? QBANK_HINT_SKILL : QBANK_HINT)[lang] };
  const t0 = Date.now();
  console.log(`[quiz] engine=${providerId} topic=${item.id} lang=${lang} need=${[1, 2, 3].filter(l => needs[l]).map(l => `L${l}×${needs[l]}`).join(",")}`);
  const attempt = async () => {
    const batch = await runEngine(providerId, task, sys, msg, null, null, lang, opts, x => validateQbankBatch(x, total, skillTags));
    let keep = batch;
    if (judge) {
      const v = await judge(batch);
      if (!v.pass) {
        /* 按题剔除：审稿人指了序号就只丢那几道，其余照收。
         * 指不出序号（老审稿人/格式不对）才退回整批作废的老行为。 */
        const bad = new Set((v.bad || []).filter(i => i < batch.length));
        if (!bad.size) throw new Error(L(lang, "审稿没过：", "Review failed: ") + (v.problems[0] || L(lang, "（没给理由）", "(no reason given)")));
        keep = batch.filter((_, i) => !bad.has(i));
        console.log(`[quiz] judge dropped ${bad.size}/${batch.length} for ${item.id} ${lang}: ${(v.problems[0] || "").slice(0, 120)}`);
        // 剔完还得剩一半以上，不然说明这批整体质量差，重来更划算
        if (keep.length < Math.ceil(batch.length / 2)) throw new Error(L(lang, "审稿没过：", "Review failed: ") + L(lang, `${bad.size} 道有问题`, `${bad.size} questions rejected`));
      }
    }
    qbankMerge(bank, keep);
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
        curriculumSkillsPreviews: curriculumSkillsPreviews(),
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
      if (!g) return send(res, 200, { grades, courses: curriculumCourses(), books: curriculumBooks(), skillsPreviews: curriculumSkillsPreviews() });
      const d = learnView(g, url.searchParams.get("view"));
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet", grades });
      /* 技能视图下 FSA 仍按 BC 五大主线出卷，清单里的分组是主题，所以另带一份主线名单给 FSA 下拉 */
      const bc = (d.type === "skills-preview") ? curriculum.get(g) : null;
      const fsaStrands = bc ? STRANDS.filter(([s]) => (bc.items || []).some(it => it.strand === s)).map(([s, zh, en]) => ({ strand: s, zhName: zh, enName: en })) : null;
      const kidId = resolveKid(a, url.searchParams.get("kid"));
      if (!kidId) return send(res, 400, NEED_KID_MSG);
      const progress = kd(kidId).progress;
      const strands = strandGroups(d, it => ({
        id: it.id, en: it.en, zh: it.zh, status: progressStatus(kidId, it.id),
        // 最近一节讲过的课：前端点条目直接重播（免费秒开），🔄 才重新生成
        lessonId: ((progress[it.id] || {}).lessonIds || [])[0] || "",
        /* 技能层多带几个字段给前端做徽章和折叠（老年级/书籍没有 it.skill，什么都不多发） */
        ...(it.skill ? {
          type: it.skill.type,
          core: it.skill.core,
          reviewFrom: it.skill.reviewFrom || 0,
          prereqN: (it.skill.prereq || []).length,
          miscN: (it.skill.misc || []).length,
          standard: it.skill.primary || "",
          ...(remediationFor(kidId, it.id) ? { remediate: remediationFor(kidId, it.id) } : {})
        } : {})
      }));
      return send(res, 200, { grade: g, grades, source: d.source, strands,
        ...(d.topicStandards ? { topicStandards: d.topicStandards } : {}),
        ...(fsaStrands ? { fsaStrands } : {}),
        unitKey: String(viewKey(g, d))     // 单元测试存档/读包用的 key（技能视图是 skills-g5，不是 5）
      });
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
        /* 这条 BC 标准下面已经有技能了，就顺带把技能汇总带上（设计文档 §6）：
         * status/level 仍按老规则算，前端可以并排显示「按技能看：3/7 站稳」。
         * 没有技能挂靠（G8/G9、高中、书籍）时 roll 是 null，报告和以前一模一样。 */
        const roll = standardRollup(kidId, it.id);
        /* 有技能挂靠的标准，级别由技能汇总决定（孩子现在学的是技能，标准 id 上不再有新事件）；
         * 家长星标仍是最高优先级的 override。老口径的那条记录放在 legacy 里，前端分开显示 */
        const manual = !!(e && e.solid);
        const level = manual ? "proficient" : roll ? roll.level : progressLevel(kidId, it.id);
        const status = level === "emerging" ? "new" : level === "developing" ? "seen" : "solid";
        return {
          id: it.id, en: it.en, zh: it.zh,
          status, level,
          manualSolid: manual,   // 家长手动标记的「扎实」，前端星标可切换
          taught: e ? e.taught : 0, right: e ? e.right : 0, wrong: e ? e.wrong : 0,
          lastAt: e ? e.lastAt : 0,
          ...(roll ? { skills: roll } : {})
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
      const g0 = curriculumKey(body.grade || 0);
      /* 数字年级 → 技能视图（主题当单元）；单元 id 不在技能视图里就退回大纲视图（老存档里的主线名还能用） */
      let d = learnView(g0);
      const strand = String(body.strand || "");
      if (d && d.type === "skills-preview" && !(d.strandDefs || []).some(s => s[0] === strand)) d = curriculum.get(g0);
      if (!d) return send(res, 404, { error: "这个年级的大纲数据还没准备好 / No curriculum data for this grade yet" });
      const g = viewKey(g0, d);
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
      /* 年级 5 的卷子可能存在两个 key 下：老的主线卷 grade="5"，技能视图的主题卷 grade="skills-g5"。
       * 清单两种都列，前端按 strand（主题 id / 主线名）再分到各自的面板 */
      const keys = new Set([g]);
      if (/^\d+$/.test(g)) keys.add("skills-g" + g);
      return send(res, 200, {
        items: kd(kidId).unitTests
          .filter(r => (!g || keys.has(String(r.grade))) && (!strand || r.strand === strand))
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
        /* 答错且这道题挂了误区标签：记一笔，攒够 2 次就建议回补（技能图谱 §6）。
         * 老题库没有 tags，这里什么都不做，行为和以前一样。 */
        if (!ok && Array.isArray(q.tags)) {
          const picked = Math.round(Number(r && r.picked));
          const tag = (picked >= 0 && picked <= 3) ? q.tags[picked] : "";
          if (tag && tag !== "ok" && tag !== "other") missRecord(kidId, cid, tag);
        }
      }
      if (bank) qbankSave();
      const passed = topRight >= QUIZ_PASS_NEED;
      if (passed) progressRecord(kidId, cid, "quiz-pass");
      return send(res, 200, {
        ok: true, passed, status: progressStatus(kidId, cid), level: progressLevel(kidId, cid),
        ...(remediationFor(kidId, cid) ? { remediate: remediationFor(kidId, cid) } : {})
      });
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
    console.log("  Skill graph:  " + (curriculumSkillsPreviews().length
      ? curriculumSkillsPreviews().map(s => s.en + " (" + s.id + ", " + (curriculum.get(s.id).items || []).length + " skills)").join("; ") + " [design draft, see docs/skill-graph-plan.md]"
      : "none (no skills JSON under data/curriculum/skills/)"));
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
  curriculum, curriculumGrades, curriculumCourses, curriculumBooks, curriculumSkillsPreviews, isCourseData, findCurriculumItem, extractJson,
  systemPromptTeach, validateLesson,
  qbank, qbankKey, qbankSave, ensureQuizBank, qbankPlayable, qbankPrompt, QBANK_HINT,
  ttsId, ttsSpeakable, LESSON_PACK_DIR, VOICE_PACK_DIR, UNIT_PACK_DIR, TTS_CACHE,
  STRANDS, unitTestPrompt, validateUnitTest, UNIT_TEST_SCHEMA, UNIT_TEST_HINT, unitPackGet,
  JUDGE_SCHEMA, JUDGE_HINT, JUDGE_HINT_QUIZ, judgeLessonPrompt, judgeQuizPrompt, judgeUnitPrompt, validateJudge,
};
