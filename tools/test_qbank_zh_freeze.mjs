#!/usr/bin/env node
/*
 * 中文题库出题链冻结回归（#43）：zh 的提示词 / 格式说明 / schema / 校验输出 / 审稿提示词 / 入库结果，
 * 和 4bcb384（#43 动 server.js 之前）逐字节一致。基线在改代码之前录好，存在 tools/fixtures/qbank-zh-freeze.json。
 *
 *   node tools/test_qbank_zh_freeze.mjs            # 对比
 *   node tools/test_qbank_zh_freeze.mjs --record   # 重录基线（只有 zh 行为本来就该变的时候才用，并在提交说明里写清楚）
 *
 * 进程内加载 server.js（隔离临时 DATA_ROOT，见 tools/lib/inproc_server.mjs），假引擎按顺序回放合成的模型输出，
 * 不调任何真实模型，不读真实 config / qbank / 孩子数据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./lib/isolated_server.mjs";
import { loadIsolatedServer, installStubEngine, quiet } from "./lib/inproc_server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "qbank-zh-freeze.json");
const RECORD = process.argv.includes("--record");
const { check, summary } = makeChecker();

const srv = loadIsolatedServer("qbank-zh-freeze");
const S = srv.S;
const eng = installStubEngine(S, "stubzh");

const ITEMS = {
  skillFrac: "YY.MATH.FRAC.EQUIV.VISUAL",
  skillLine: "YY.MATH.DATA.LINE.READ",
  bc: "BC.MATH.G4.NUM.01",
  book: "AOPS.PA.C01.S01"
};
const find = id => { const f = S.findCurriculumItem(id); if (!f) throw new Error("fixture item missing from tracked curriculum: " + id); return f; };
const courseItem = () => {
  const d = [...S.curriculum.values()].find(x => x && x.type === "course" && x.courseId === "BC.MATH.FMP10") || [...S.curriculum.values()].find(x => x && x.type === "course");
  return { item: d.items[0], data: d };
};

/* 合成的「模型输出」：把 legacy 校验会处理的各种毛病都放进去（标签、字面量 \n、数字字符串、小数下标、坏题…） */
const rawSkillBatch = () => ({ questions: [
  { level: 1, question: "  把 1/2 画成分数条，平均分成 2 份涂 1 份。和它相等的是？ ", options: [" 2/4 ", "1/3", "2/3", "1/4"], answerIndex: 0, explain: "分子分母同乘 2。",
    tags: ["x", "frac.different_whole", "bogus", "other"], visual: { type: "fractionBar", nums: [2, 1], caption: "1/2" }, qid: "qkeep1" },
  { level: "2", question: "第一行\\n第二行：3/6 等于？", options: ["1/2", "1/3", "2/3", "3/3"], answerIndex: "0", explain: "约分\\n得 1/2", tags: ["ok", "frac.count_shaded_only", "frac.different_whole", "other"] },
  { level: 1.6, question: "2/8 和哪个相等？", options: ["1/2", "1/3", "1/4", "1/5"], answerIndex: 2.4, explain: "分子分母同除以 2。", tags: ["frac.count_shaded_only", "ok", "ok", "frac.different_whole"] },
  { level: 1, question: "只有三个选项", options: ["a", "b", "c"], answerIndex: 0, explain: "x" },
  { level: 4, question: "难度越界", options: ["a", "b", "c", "d"], answerIndex: 0, explain: "x" },
  { level: 2, question: "有空选项", options: ["a", "", "c", "d"], answerIndex: 0, explain: "x" },
  { level: 3, question: "标签只有三个 4/6 等于？", options: ["2/3", "3/4", "4/5", "1/6"], answerIndex: 0, explain: "同除以 2。", tags: ["ok", "frac.different_whole", "other"] },
  { level: 3, question: "小明说 2/3 = 4/5，他错在哪？", options: ["分子分母加同一个数，因为他以为那样不变", "分子乘 2 没错，因为分母也乘了", "他其实对了，因为都差 1", "只有分母要变，因为分子是份数"], answerIndex: 0, explain: "选项 B 那种说法不对：必须同乘同除。", tags: ["ok", "frac.count_shaded_only", "frac.different_whole", "frac.count_shaded_only"] },
  { level: 2, question: "6/9 最简是？", options: ["2/3", "3/4", "1/3", "6/9"], answerIndex: 3, explain: "同除以 3 得 2/3。" },
  null, "not a question",
  { level: 3, question: "一块披萨切 8 份吃了 4 份，另一块同样大小切 4 份吃了 2 份，谁吃得多？", options: ["一样多", "第一个", "第二个", "看不出"], answerIndex: 0, explain: "4/8 = 2/4。", tags: ["ok", "frac.different_whole", "frac.count_shaded_only", "other"] },
  { level: 1, question: "3/4 = ?/8", options: ["6", "7", "5", "4"], answerIndex: 0, explain: "分母乘 2，分子也乘 2。", tags: ["ok", "other", "other", "frac.count_shaded_only"] }
] });
const rawBcBatch = () => ({ questions: [
  { level: 1, question: "4 在千位表示多少？", options: ["4000", "400", "40", "4"], answerIndex: 0, explain: "千位是 1000 的倍数。", tags: ["ok", "a", "b", "c"], visual: { type: "statBar", nums: [1, 2], labels: ["a", "b"], caption: "c" }, qid: "qbc1" },
  { level: 2, question: "3 个千和 5 个十是？", options: ["3050", "3500", "350", "30050"], answerIndex: 0, explain: "千位 3、十位 5。" },
  { level: 3, question: "比 9999 大 1 的数是？", options: ["10000", "9990", "10999", "1000"], answerIndex: 0, explain: "满十进一。" },
  { level: 2, question: "5 个百是？", options: ["500", "50", "5000", "5"], answerIndex: 0, explain: "百位。" },
  { level: 1, question: "7 在十位表示？", options: ["70", "7", "700", "7000"], answerIndex: 0, explain: "十位。" },
  { level: 3, question: "一万里有几个千？", options: ["10", "100", "1000", "1"], answerIndex: 0, explain: "10 个千是一万。" },
  { level: 2, question: "2 个万是？", options: ["20000", "2000", "200", "200000"], answerIndex: 1, explain: "看选项 A：万位是 10000 的倍数。" }
] });

const stripVolatile = qs => qs.map(q => {
  const c = Object.assign({}, q);
  const hadQid = typeof c.qid === "string" && c.qid.length > 0;
  delete c.qid;
  return Object.assign(c, { _hadQid: hadQid });
});
const ledgerRows = () => {
  let raw = ""; try { raw = fs.readFileSync(path.join(srv.DATA, "usage.jsonl"), "utf8"); } catch (_) {}
  return raw.split("\n").filter(Boolean).map(l => JSON.parse(l)).map(r => ({ task: r.task, provider: r.provider, lang: r.lang, ok: r.ok, err: r.err }));
};
const resetLedger = () => { try { fs.rmSync(path.join(srv.DATA, "usage.jsonl")); } catch (_) {} };

async function runEnsure(id, data, item, raws, judgeImpl) {
  const key = S.qbankKey(item.id, "zh");
  S.qbank[key] = { questions: [] };
  eng.reset(); resetLedger();
  eng.queue(...raws);
  const judgeCalls = [];
  const judge = judgeImpl ? function (...args) { judgeCalls.push({ argc: args.length, batch: JSON.parse(JSON.stringify(args[0])) }); return judgeImpl(args[0]); } : null;
  let error = null;
  try { await quiet(() => S.ensureQuizBank(item, data, "zh", eng.id, "test:quiz", judge)); }
  catch (e) { error = e.message; }
  const out = {
    engineCalls: eng.calls.map(c => ({ sys: c.sys, question: c.question, lang: c.lang, schema: c.schema, hint: c.hint })),
    judgeCalls, error,
    bank: stripVolatile(S.qbank[key].questions),
    ledger: ledgerRows()
  };
  delete S.qbank[key];
  return out;
}

const snapshot = {};
{
  const sample = [{ level: 1, question: "题干", options: ["a", "b", "c", "d"], answerIndex: 1, explain: "因为", tags: ["other", "ok", "other", "other"] }];
  for (const [name, id] of Object.entries(ITEMS)) {
    const { item, data } = find(id);
    snapshot["prompt.full." + name] = S.qbankPrompt(item, data, "zh", { 1: 4, 2: 4, 3: 4 }, []);
    snapshot["prompt.partial." + name] = S.qbankPrompt(item, data, "zh", { 2: 4 }, ["已有题 A", "已有题 B"]);
    snapshot["judge.prompt." + name] = S.judgeQuizPrompt(item, data, sample, "zh");
  }
  const c = courseItem();
  snapshot["prompt.full.course"] = S.qbankPrompt(c.item, c.data, "zh", { 1: 4, 2: 4, 3: 4 }, []);
  snapshot["judge.prompt.course"] = S.judgeQuizPrompt(c.item, c.data, sample, "zh");
  snapshot["const.QBANK_HINT"] = S.QBANK_HINT;
  snapshot["const.JUDGE_HINT_QUIZ.zh"] = S.JUDGE_HINT_QUIZ.zh;
  snapshot["const.JUDGE_SCHEMA"] = S.JUDGE_SCHEMA;

  const f = find(ITEMS.skillFrac);
  snapshot["ensure.skill.pass"] = await runEnsure("pass", f.data, f.item, [rawSkillBatch()], () => ({ pass: true, problems: [], bad: [] }));
  snapshot["ensure.skill.dropTwo"] = await runEnsure("drop", f.data, f.item, [rawSkillBatch()], () => ({ pass: false, problems: ["第 0、1 题有问题"], bad: [0, 1] }));
  snapshot["ensure.skill.noJudge"] = await runEnsure("nojudge", f.data, f.item, [rawSkillBatch()], null);
  const few = { questions: rawSkillBatch().questions.slice(0, 2) };
  snapshot["ensure.skill.tooFew"] = await runEnsure("few", f.data, f.item, [few, few], null);
  const b = find(ITEMS.bc);
  snapshot["ensure.bc.pass"] = await runEnsure("bc", b.data, b.item, [rawBcBatch(), rawBcBatch()], () => ({ pass: true, problems: [], bad: [] }));
}

if (RECORD) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify({ note: "zh freeze baseline for #43, recorded at 4bcb384 before any server.js edit. Do not re-record unless zh behaviour is meant to change.", snapshot }, null, 1) + "\n");
  console.log("recorded " + Object.keys(snapshot).length + " zh snapshots -> " + path.relative(process.cwd(), FIXTURE));
  srv.cleanup();
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).snapshot;
console.log("zh freeze vs baseline (" + Object.keys(base).length + " snapshots)");
check("same snapshot names as the baseline", JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify(Object.keys(base).sort()), Object.keys(snapshot));
for (const k of Object.keys(base)) {
  const a = JSON.stringify(snapshot[k]), e = JSON.stringify(base[k]);
  let where = null;
  if (a !== e) { let i = 0; while (i < a.length && a[i] === e[i]) i++; where = { at: i, got: (a || "").slice(Math.max(0, i - 60), i + 80), want: (e || "").slice(Math.max(0, i - 60), i + 80) }; }
  check("zh " + k + " unchanged", a === e, where);
}
/* 基线本身要有意义：确实走到了引擎、审稿和入库，不是一堆空数组在互相比 */
const pass = base["ensure.skill.pass"];
check("baseline sanity: skill pass case called the engine once and the judge once with one argument",
  pass.engineCalls.length === 1 && pass.judgeCalls.length === 1 && pass.judgeCalls[0].argc === 1, { e: pass.engineCalls.length, j: pass.judgeCalls });
check("baseline sanity: legacy zh validator dropped visual/qid, kept 4 tags, and stored a bank with every level",
  pass.judgeCalls[0].batch.every(q => !("visual" in q) && !("qid" in q)) && pass.judgeCalls[0].batch[0].tags.join() === "ok,frac.different_whole,other,other"
  && [1, 2, 3].every(lv => pass.bank.some(q => q.level === lv)), pass.judgeCalls[0].batch[0]);
check("baseline sanity: too-few case failed and published nothing", !!base["ensure.skill.tooFew"].error && base["ensure.skill.tooFew"].bank.length === 0, base["ensure.skill.tooFew"].error);
srv.cleanup();
process.exit(summary() ? 0 : 1);
