#!/usr/bin/env node
/*
 * Phase 7 验证回放 eval（#38，#19 Phase 7）。零成本：模型 / 分类器都是 tools/fixtures/verification_eval.json 里的回放脚本，
 * 工具注册表是真实的 createTools（桩 Action，被调到即失败），工作流用真实 createTutorWorkflow + createMemory + createFileStore（临时目录），
 * 评分用确定性 createAnswerGrader。不起服务器、不读学生数据、不联网。任何一条预期不符 → 非零退出。
 *
 *   node tools/eval_verification.mjs            跑全部
 *   node tools/eval_verification.mjs --only id  只跑一条
 *
 * 它检查「给定模型输出时，验证规则是否在送给孩子之前拦下 / 放行」，不衡量真实模型的教学质量。
 * 「通过」= 列出的规则没发现错误，不是「内容已被证明正确」。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const { createTutorAgent, TEXTS } = require("../lib/ai/tutor/index.js");
const { createReplayModel } = require("../lib/ai/harness/replay.js");
const { createTools } = require("../lib/ai/tools/index.js");
const { createTutorWorkflow } = require("../lib/ai/workflows/index.js");
const { createMemory } = require("../lib/ai/memory/index.js");
const { createFileStore } = require("../lib/ai/memory/file-store.js");
const { createAnswerGrader, verifyAnswer, extractEqualities } = require("../lib/ai/verification/index.js");
const { check, summary } = makeChecker();

const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/verification_eval.json", import.meta.url), "utf8"));
const J = v => JSON.stringify(v);

const actionCalls = [];
const actions = new Proxy({}, { get: (_, g) => new Proxy({}, { get: (__, fn) => () => { actionCalls.push(`${String(g)}.${String(fn)}`); throw new Error("no actions"); } }) });
const ITEMS = {
  "BC.MATH.G5.N2": { id: "BC.MATH.G5.N2", en: "Decimals to thousandths", zh: "小数（到千分位）", strand: "number", skill: { prerequisites: ["BC.MATH.G4.N3"] } },
  "BC.MATH.G4.N3": { id: "BC.MATH.G4.N3", en: "Place value", zh: "位值", strand: "number" },
};
const realRegistry = createTools({ actions, findCurriculumItem: id => (Object.prototype.hasOwnProperty.call(ITEMS, id) ? { item: ITEMS[id] } : null), onTrace: () => {} });
function spyRegistry() {
  const invoked = [];
  return { invoked, get: n => realRegistry.get(n), list: f => realRegistry.list(f), describe: f => realRegistry.describe(f),
    invoke: (name, ctx, input) => { invoked.push(name); return realRegistry.invoke(name, ctx, input); } };
}
const MATHL = { type: "final", output: { label: "math", reason: "math" } };
/* 修复提示（Harness 交回模型的 observation）→ 规则名；按文案前缀识别，更具体的在前 */
const RULES = [["the text says it was checked", "calculator-claim"], ["the text says", "equality"], ["curriculum id", "curriculum-claim"],
  ["hint mode: the text states", "answer-leak"], ["hint mode: give a hint", "hint-kind"], ["socratic-teaching:", "socratic"], ["check failed", "check"], ["answer text contains", "screen"]];
const ruleOf = msg => { const r = RULES.find(([p]) => msg.startsWith(p)); return r ? r[1] : "other:" + msg.slice(0, 30); };
const byCat = {};
const tally = (cat, ok) => { byCat[cat] = byCat[cat] || { pass: 0, fail: 0 }; byCat[cat][ok ? "pass" : "fail"]++; };

console.log("tutor cases (real TutorAgent, replayed model)");
for (const c of fixture.tutorCases) {
  if (only && c.id !== only) continue;
  const reg = spyRegistry();
  const model = createReplayModel(c.model || []), classifierModel = createReplayModel(c.classifier || [MATHL]);
  const traces = [];
  const agent = createTutorAgent({ registry: reg, model, classifierModel, onTrace: t => traces.push(t) });
  const req = Object.assign({ question: c.question, lang: c.lang }, c.mode ? { mode: c.mode } : {}, c.strategy ? { strategy: c.strategy } : {}, c.verify !== undefined ? { verify: c.verify } : {});
  let res, rejected = null;
  try { res = await agent.ask({ kidId: "k1", role: "student", userId: "u1" }, req); } catch (e) { rejected = e; }
  const e = c.expect, why = [];
  if (rejected) why.push("ask rejected: " + rejected.message);
  else {
    if (res.kind !== e.kind) why.push(`kind ${res.kind} != ${e.kind}`);
    if (e.errorCode && (!res.error || res.error.code !== e.errorCode)) why.push(`error ${res.error && res.error.code} != ${e.errorCode}`);
    if (e.template && res.text !== TEXTS[c.lang][e.template]) why.push(`text is not the ${e.template} template`);
    if (e.textStartsWith && !String(res.text).startsWith(e.textStartsWith)) why.push(`text ${J(res.text).slice(0, 60)}`);
    if (e.modelCalls != null && model.calls.length !== e.modelCalls) why.push(`model calls ${model.calls.length} != ${e.modelCalls}`);
    if (e.classifierCalls != null && classifierModel.calls.length !== e.classifierCalls) why.push(`classifier calls ${classifierModel.calls.length} != ${e.classifierCalls}`);
    if (e.tools && J(reg.invoked) !== J(e.tools)) why.push(`tools ${J(reg.invoked)} != ${J(e.tools)}`);
    const repairs = model.calls.length ? model.calls[model.calls.length - 1].messages.filter(m => m.role === "harness").map(m => ruleOf(m.error.message)) : [];
    if (J(repairs) !== J(e.repairRules || [])) why.push(`repairs ${J(repairs)} != ${J(e.repairRules || [])}`);
    if (e.verification) for (const [k, v] of Object.entries(e.verification)) if (!res.verification || res.verification[k] !== v) why.push(`verification.${k} = ${res.verification && res.verification[k]} != ${v}`);
    if (e.noVerificationField && "verification" in res) why.push("verification field present without verify");
    if (e.equalitiesChecked != null) { const n = extractEqualities(res.text, c.question).filter(x => x.status === true).length; if (n !== e.equalitiesChecked) why.push(`equalities checked ${n} != ${e.equalitiesChecked}`); }
    if (["answer", "hint"].includes(res.kind) && extractEqualities(res.text, c.question).some(x => x.status === false)) why.push("a false equation reached the child");
    if (res.verification && J(res.verification).includes('"verified"')) why.push("coverage claims something is 'verified'");
    if (res.error && /stack|at .*\.js:/.test(J(res.error))) why.push("error leaks a stack");
  }
  /* 全局不变量：可信上下文不进模型请求 / trace / 错误；脚本恰好用完（多出或不够都说明预期的修复次数不对） */
  const reqText = J([...model.calls, ...classifierModel.calls].map(r => ({ system: r.system, messages: r.messages })));
  const v = c.verify && typeof c.verify === "object" ? c.verify : {};
  if (/answerKey/.test(reqText)) why.push("a model request mentions answerKey");
  if (v.answerKey && !c.question.includes(v.answerKey) && model.calls.some(r => J(r.messages.filter(m => m.role !== "assistant")).includes(v.answerKey))) why.push("the answer key reached a model request");
  if (v.topicId && !c.question.includes(v.topicId) && reqText.includes(v.topicId)) why.push("the topic id reached a model request");
  /* 答案键可能只有一位数：trace 里查带引号的字符串值，错误信息里查独立的数字 token（时间戳等数字不算） */
  const keyToken = v.answerKey ? new RegExp(`(^|[^0-9.])${v.answerKey.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^0-9])`) : null;
  if (keyToken && (J(traces).includes(J(v.answerKey)) || (res && res.error && keyToken.test(res.error.message)))) why.push("the answer key reached a trace or an error");
  if (!rejected && model.remaining !== 0) why.push(`${model.remaining} replay turns unused`);
  tally(c.cat, why.length === 0);
  check(`[${c.cat}] ${c.id}`, why.length === 0, why);
}

console.log("workflow cases (real workflow + memory + file store + TutorAgent + deterministic grader)");
const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), "yy-verify-eval-"));
const OWNER = Object.freeze({ userId: "eval-user", kidId: "eval-kid", role: "student" });
try {
  for (const c of fixture.workflowCases) {
    if (only && c.id !== only) continue;
    const root = await fsp.mkdtemp(path.join(tmpBase, "w-"));
    const memory = createMemory({ store: createFileStore({ rootDir: root }) });
    const model = createReplayModel(c.tutor), classifierModel = createReplayModel(Array(c.classify).fill(MATHL));
    const agent = createTutorAgent({ registry: spyRegistry(), model, classifierModel, onTrace: () => {} });
    const qs = c.questions.map(q => Object.assign({ topicId: c.start.topicId }, q));
    const traces = [];
    const wf = createTutorWorkflow({ tutor: agent, memory, practice: { next: () => (qs.length ? qs.shift() : Promise.reject(new Error("none"))) }, grader: createAnswerGrader(),
      onTrace: t => traces.push(t), adapterTimeoutMs: 500 });
    const why = [];
    const v = await wf.start(OWNER, Object.assign({ commandId: "start", lang: c.lang }, c.start));
    let n = 0;
    for (const s of c.steps) {
      const r = await wf.send(OWNER, v.workflowId, Object.assign({ commandId: "c" + (++n) }, s.cmd));
      const x = s.expect || { ok: true };
      const tag = `${s.cmd.type}#${n}`;
      if (r.ok !== x.ok) why.push(`${tag}: ok ${r.ok} (${r.code}/${r.detail})`);
      if (x.code && r.code !== x.code) why.push(`${tag}: code ${r.code} != ${x.code}`);
      if (x.phase && r.view.phase !== x.phase) why.push(`${tag}: phase ${r.view.phase} != ${x.phase}`);
      if (x.status && r.view.status !== x.status) why.push(`${tag}: status ${r.view.status} != ${x.status}`);
      if (x.outcome && r.view.outcome !== x.outcome) why.push(`${tag}: outcome ${r.view.outcome} != ${x.outcome}`);
      if (x.evaluation && (!r.view.evaluation || r.view.evaluation.outcome !== x.evaluation)) why.push(`${tag}: evaluation ${J(r.view.evaluation)} != ${x.evaluation}`);
      if (x.noMistake && r.view.evaluation && "mistake" in r.view.evaluation) why.push(`${tag}: grader invented a mistake category`);
      if (x.replyKind && (!r.reply || r.reply.kind !== x.replyKind)) why.push(`${tag}: reply ${J(r.reply)}`);
      if (x.template && (!r.reply || r.reply.text !== TEXTS[c.lang][x.template])) why.push(`${tag}: reply is not the ${x.template} template`);
      if (r.code === "INVARIANT_FAILED") why.push(`${tag}: postcondition failed (${r.detail})`);
      if (r.reply && ["answer", "hint"].includes(r.reply.kind) && extractEqualities(r.reply.text).some(q => q.status === false)) why.push(`${tag}: a false equation reached the child`);
    }
    const events = await memory.getEvents(OWNER);
    if (J(events.map(e => e.type)) !== J(c.events)) why.push(`events ${J(events.map(e => e.type))} != ${J(c.events)}`);
    if (events.some(e => e.type === "topic_mastered")) why.push("topic_mastered was written");
    if (c.unsettled != null) { const sm = await memory.getStudentMemory(OWNER); if (sm.topics[0].unsettled !== c.unsettled) why.push(`unsettled ${sm.topics[0].unsettled} != ${c.unsettled}`); }
    const reqText = J([...model.calls, ...classifierModel.calls].map(r => ({ system: r.system, messages: r.messages })));
    if (/answerKey|eval-user|eval-kid/.test(reqText) || reqText.includes(c.start.topicId)) why.push("a model request carries the key field, owner ids or the topic id");
    for (const q of c.questions) {
      if (model.calls.some(r => J(r.messages.filter(m => m.role !== "assistant")).includes(q.answerKey) && !q.prompt.includes(q.answerKey))) why.push("the answer key reached a model request");
      if (J(traces).includes(`"${q.answerKey}"`)) why.push("the answer key reached a trace");
    }
    const disk = (await fsp.readdir(root)).filter(f => f.endsWith(".json")).map(f => fs.readFileSync(path.join(root, f), "utf8")).join("");
    if (c.questions.some(q => disk.includes(q.prompt) || disk.includes(`"${q.answerKey}"`))) why.push("prompt or key on disk");
    if (model.remaining !== 0 || classifierModel.remaining !== 0) why.push(`replay turns unused: tutor ${model.remaining}, classifier ${classifierModel.remaining}`);
    tally(c.cat, why.length === 0);
    check(`[${c.cat}] ${c.id}`, why.length === 0, why);
  }
} finally {
  await fsp.rm(tmpBase, { recursive: true, force: true });
}

console.log("grade cases");
for (const g of fixture.gradeCases) {
  if (only) continue;
  const r = verifyAnswer(g.answer, g.key);
  tally("grade", r.status === g.status);
  check(`[grade] ${J(g.answer)} vs ${J(g.key)} → ${g.status}`, r.status === g.status, r);
}

await new Promise(r => setTimeout(r, 50));
check("no action was ever called", actionCalls.length === 0, actionCalls);
check("no unhandled rejections", unhandled.length === 0, unhandled.map(String));
console.log("\nby category:", Object.entries(byCat).map(([k, v]) => `${k} ${v.pass}/${v.pass + v.fail}`).join(", "));
console.log("note: replayed model outputs — 'pass' means the listed rules found no error, not that the content is proven correct.");
process.exit(summary() ? 0 : 1);
