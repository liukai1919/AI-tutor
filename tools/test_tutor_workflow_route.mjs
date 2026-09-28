#!/usr/bin/env node
/*
 * /api/tutor/workflow*（#61，#19 Phase 9d）的隔离回归：进程内加载 server.js（临时 DATA_ROOT、demo 题库、空配置），
 * claude 适配器换成桩并手动标成可用，其余引擎一律换成会抛错的桩（断言一次都没被调）。随机端口 listen。
 * 零成本：不调真实模型、不读真实 config / qbank / 孩子数据。练习题是测试自己塞进进程内题库的合成题。
 *
 *   node tools/test_tutor_workflow_route.mjs
 *
 * 另有 service 层（practiceFrom 筛题、readSettings、视图裁剪）的纯单测，放在最后。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { loadIsolatedServer, quiet } from "./lib/inproc_server.mjs";
import { makeChecker } from "./lib/isolated_server.mjs";

const require = createRequire(import.meta.url);
const { CLASSIFIER_SYSTEM } = require("../lib/ai/tutor/index.js");
const { LEGACY_TRANSCRIPT_PREFIX } = require("../lib/ai/models/legacy.js");
const { createWorkflowService, practiceFrom, readSettings, WORKFLOW_SERVICE_DEFAULTS } = require("../lib/ai/workflows/service.js");
const { check, summary } = makeChecker();
const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));

const srv = loadIsolatedServer("workflow-route");
const { S } = srv;

/* ---- 桩引擎：分类一律 math；作答按请求的 mode 给讲解 / 提示（没有数字，不会被本地等式核对或答案键泄露规则拦） ---- */
const calls = [];
const realEngineAttempts = [];
for (const id of Object.keys(S.ADAPTERS)) if (id !== "claude") S.ADAPTERS[id] = async () => { realEngineAttempts.push(id); throw new Error("test: real engine " + id + " must not be called"); };
S.ADAPTERS.claude = async (sys, question) => {
  const isClassifier = sys.startsWith(CLASSIFIER_SYSTEM);
  const t = JSON.parse(question.slice(LEGACY_TRANSCRIPT_PREFIX.length));
  calls.push({ isClassifier, question, t });
  if (isClassifier) return { type: "final", output: { label: "math", reason: "math" } };
  const u = JSON.parse(t.messages.find(m => m.role === "user").content);
  return u.mode === "hint"
    ? { type: "final", output: { kind: "hint", text: "Look at what the question asks first. Which step would you try next?", scope: "math" } }
    : { type: "final", output: { kind: "answer", text: "Place value tells us what each digit is worth: the digit on the left is worth ten times more.", scope: "math" } };
};
const markOnlyStubAvailable = () => {
  for (const id of Object.keys(S.detected)) if (id !== "claude" && S.detected[id]) S.detected[id].available = false;
  S.detected.claude = { available: true, bin: "stub-claude" };
};
markOnlyStubAvailable();

/* ---- 合成题库：6 道合格（数字答案），另有 5 道各不合格一种 ---- */
const CID = "BC.MATH.G4.NUM.01", CID_EMPTY = "BC.MATH.G4.NUM.02", CID_FEW = "BC.MATH.G4.NUM.03";
const good = [
  ["wq1", 1, "What is 7 + 5?", ["10", "12", "14", "16"], 1],
  ["wq2", 1, "What is 20 - 8?", ["11", "13", "12", "14"], 2],
  ["wq3", 2, "Which fraction is three quarters?", ["1/2", "3/4", "2/3", "1/4"], 1],
  ["wq4", 2, "What is 6 x 4?", ["24", "20", "28", "26"], 0],
  ["wq5", 3, "What is 100 / 4?", ["20", "30", "40", "25"], 3],
  ["wq6", 3, "What is 0.5 + 0.25?", ["0.75", "0.7", "0.8", "1"], 0],
].map(([qid, level, question, options, answerIndex]) => ({ qid, level, question, options, answerIndex, explain: "e" }));
const bad = [
  { qid: "wx1", level: 3, question: "How many dots?", options: ["3", "4", "5", "6"], answerIndex: 0, visual: { type: "dots" } },   // 带图
  { qid: "wx2", level: 3, question: "Which animal?", options: ["cat", "dog", "cow", "pig"], answerIndex: 0 },                    // 不是数
  { qid: "wx3", level: 1, question: "Half?", options: ["1/2", "2/4", "3", "4"], answerIndex: 0 },                                // 两个选项等值
  { qid: "bad qid", level: 1, question: "1+1?", options: ["2", "3", "4", "5"], answerIndex: 0 },                                  // qid 不合规则
  { qid: "wx5", level: 2, question: "2+2?", options: ["4", "5"], answerIndex: 7 },                                               // 下标越界
];
S.qbank[S.qbankKey(CID, "en")] = { questions: good.concat(bad) };
S.qbank[S.qbankKey(CID_FEW, "en")] = { questions: [good[0], Object.assign({}, good[2], { level: 2 }), Object.assign({}, bad[1], { level: 3 })] };
S.qbank[S.qbankKey(CID_EMPTY, "en")] = { questions: bad.map((q, i) => Object.assign({}, q, { level: 1 + (i % 3) })) };   // 三级都有题，但一道合格的都没有
const keyOf = qid => { const q = good.find(x => x.qid === qid); return q && q.options[q.answerIndex]; };
const wrongOf = qid => { const q = good.find(x => x.qid === qid); return q && q.options[(q.answerIndex + 1) % q.options.length]; };

let PORT;
await new Promise(r => S.server.listen(0, "127.0.0.1", () => { PORT = S.server.address().port; r(); }));
async function call(method, p, body, tok) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method, headers: { "content-type": "application/json", "x-session": tok || "" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let seq = 0;
const cid = () => "c" + (++seq);
const start = (tok, extra) => call("POST", "/api/tutor/workflow", Object.assign({ curriculumId: CID, lang: "en", commandId: cid() }, extra || {}), tok);
let lastCmd = null;
const cmd = (tok, w, body) => { lastCmd = Object.assign({ commandId: cid() }, body); return call("POST", `/api/tutor/workflow/${w}/command`, lastCmd, tok); };
const learningFile = (familyId, kidId) =>
  path.join(srv.DATA, "data", "kids", kidId, "learning", crypto.createHash("sha256").update(JSON.stringify([familyId, kidId])).digest("hex") + ".json");

try {
  const { value: parentTok } = await quiet(async () => {
    const reg = await call("POST", "/api/auth/register", { username: "wfroute", password: "wfroute12345", name: "P" });
    if (reg.status !== 200) throw new Error("register failed: " + JSON.stringify(reg));
    await call("POST", "/api/kids", { name: "Wren", pin: "1111" }, reg.body.token);
    await call("POST", "/api/kids", { name: "Yara", pin: "2222" }, reg.body.token);
    await call("POST", "/api/kids", { name: "Cole", pin: "3333" }, reg.body.token);
    await call("POST", "/api/kids", { name: "Dana", pin: "4444" }, reg.body.token);
    return reg.body.token;
  });
  const kids = (await call("GET", "/api/auth/profiles")).body.kids;
  const kidA = kids.find(k => k.name === "Wren").id, kidB = kids.find(k => k.name === "Yara").id;
  const tokA = (await call("POST", "/api/auth/login", { kidId: kidA, pin: "1111" })).body.token;
  const tokB = (await call("POST", "/api/auth/login", { kidId: kidB, pin: "2222" })).body.token;
  const kidC = kids.find(k => k.name === "Cole").id, kidD = kids.find(k => k.name === "Dana").id;
  const tokC = (await call("POST", "/api/auth/login", { kidId: kidC, pin: "3333" })).body.token;
  const tokD = (await call("POST", "/api/auth/login", { kidId: kidD, pin: "4444" })).body.token;
  /* familyId 不在公开的用户信息里：从隔离目录的 users.json 读 */
  const usersDoc = JSON.parse(fs.readFileSync(path.join(srv.DATA, "data", "users.json"), "utf8"));
  const familyId = String((Array.isArray(usersDoc) ? usersDoc : usersDoc.users || []).find(u => u.id === kidA).familyId);

  console.log("switches");
  check("config default: tutorWorkflow.enabled is false", S.cfg.tutorWorkflow && S.cfg.tutorWorkflow.enabled === false && S.cfg.tutorWorkflow.perMinute === 6, S.cfg.tutorWorkflow);
  let r = await start(tokA);
  check("server switch off → 404 workflowDisabled", r.status === 404 && r.body.workflowDisabled === true, r);
  r = await call("GET", "/api/tutor/workflow/w000000000000000000000000");
  check("… answered before auth (no 401 probe)", r.status === 404 && r.body.workflowDisabled === true, r);
  r = await call("PUT", "/api/tutor/workflow", {}, tokA);
  check("… a wrong method is 404 too while off (no 405 that reveals the route)", r.status === 404 && r.body.workflowDisabled, r);
  S.cfg.tutorWorkflow.enabled = "true";
  r = await start(tokA);
  check("only enabled === true counts", r.status === 404, r);
  S.cfg.tutorWorkflow.enabled = true;
  S.cfg.tutorAgent.enabled = false;
  r = await start(tokA);
  check("tutorAgent server switch off also closes the workflow (404)", r.status === 404 && r.body.workflowDisabled, r);
  S.cfg.tutorAgent.enabled = true;
  process.env.YY_DEMO = "1";
  r = await start(tokA);
  check("YY_DEMO → 404", r.status === 404, r);
  delete process.env.YY_DEMO;
  r = await start(tokA);
  check("family switch off → 403 tutorOff", r.status === 403 && r.body.tutorOff === true, r);
  let pv = (await call("GET", "/api/providers", undefined, tokA)).body.tutor;
  markOnlyStubAvailable();   // /api/providers 跑了真实探测：本机装的引擎会被标成可用，这里再关掉
  check("/api/providers: tutor.workflow false while the family is off", pv && pv.workflow === false, pv);
  r = await call("POST", "/api/tutor/settings", { enabled: true, kidMode: "hint" }, parentTok);
  check("parent turns Ask-a-tutor on (kids: hints only)", r.status === 200 && r.body.enabled === true, r);
  pv = (await call("GET", "/api/providers", undefined, tokA)).body.tutor;
  markOnlyStubAvailable();
  check("/api/providers: tutor.workflow true now", pv && pv.workflow === true, pv);
  r = await call("PUT", "/api/tutor/workflow", {}, tokA);
  check("wrong method → 405", r.status === 405, r);
  r = await call("POST", "/api/tutor/workflow", undefined, "");
  check("no session → 401", r.status === 401, r);

  console.log("start");
  r = await start(parentTok);
  check("parent with two kids must pick one → 400 kidRequired", r.status === 400 && r.body.kidRequired, r);
  r = await start(tokA, { curriculumId: "BC.MATH.NOPE" });
  check("unknown curriculum item → 400", r.status === 400 && /Unknown curriculum item/.test(r.body.error), r);
  r = await start(tokA, { curriculumId: CID_EMPTY });
  check("topic whose bank has no number-answer questions → 409 noPractice", r.status === 409 && r.body.noPractice === true && r.body.code === "NO_PRACTICE", r);
  r = await start(tokC, { curriculumId: CID_FEW });
  check("a bank with only 2 eligible questions → maxRounds 2, targetCorrect 2", r.status === 200 && r.body.limits.maxRounds === 2 && r.body.limits.targetCorrect === 2, r.body.limits || r);
  await call("DELETE", `/api/tutor/workflow/${r.body.workflowId}`, undefined, tokC);
  r = await start(tokA, { curriculumId: CID, lang: "zh" });
  check("no zh bank for the topic → 409 noPractice", r.status === 409 && r.body.noPractice, r);
  r = await start(tokA, { extra: 1 });
  check("unknown body key → 400", r.status === 400 && r.body.code === "INVALID_INPUT", r);
  r = await call("POST", "/api/tutor/workflow", "{not json", tokA);
  check("malformed JSON → 400", r.status === 400, r);
  r = await start(tokA, { commandId: "" });
  check("bad commandId → 400 INVALID_INPUT (from the workflow)", r.status === 400 && r.body.code === "INVALID_INPUT", r);
  const startBody = { curriculumId: CID, lang: "en", commandId: "start-1" };
  r = await call("POST", "/api/tutor/workflow", startBody, tokA);
  const w = r.body.workflowId;
  check("student starts: 200, phase diagnose, no plan key in the kid's view", r.status === 200 && /^w[0-9a-f]{24}$/.test(w) && r.body.phase === "diagnose" && !("plan" in r.body) && r.body.topicId === CID && r.body.lang === "en", r);
  check("view has no title / goal / answer key", !("title" in r.body) && !("goal" in r.body) && !JSON.stringify(r.body).includes("answerKey"), Object.keys(r.body));
  r = await call("POST", "/api/tutor/workflow", startBody, tokA);
  check("same start commandId → same workflow", r.status === 200 && r.body.workflowId === w, r);
  r = await call("POST", "/api/tutor/workflow", Object.assign({}, startBody, { kid: kidA }), parentTok);
  check("parent + same kid + same commandId → same workflow (owner is family + kid)", r.status === 200 && r.body.workflowId === w, r);

  console.log("ownership");
  r = await call("GET", `/api/tutor/workflow/${w}?kid=${kidA}`, undefined, parentTok);
  check("parent reads the kid's workflow, sees plan (null before diagnose)", r.status === 200 && r.body.workflowId === w && "plan" in r.body && r.body.plan === null, r);
  r = await call("GET", `/api/tutor/workflow/${w}?kid=${kidB}`, undefined, parentTok);
  check("parent looking through the other kid → 404", r.status === 404 && r.body.code === "NOT_FOUND", r);
  r = await call("GET", `/api/tutor/workflow/${w}`, undefined, tokB);
  check("sibling → 404", r.status === 404, r);
  r = await call("GET", `/api/tutor/workflow/${w}?kid=${kidB}`, undefined, tokA);
  check("a kid's kid= parameter is ignored (still only their own)", r.status === 200 && r.body.workflowId === w, r);
  r = await call("GET", `/api/tutor/workflow/not-an-id`, undefined, tokA);
  check("malformed workflow id → 400", r.status === 400 && r.body.code === "INVALID_INPUT", r);

  console.log("full loop");
  r = await cmd(tokA, w, { type: "submit", questionId: "wq1", answer: "12" });
  check("submit during diagnose → 409 ILLEGAL_COMMAND", r.status === 409 && r.body.code === "ILLEGAL_COMMAND", r);
  r = await cmd(tokA, w, { type: "diagnose", expectedVersion: 99 });
  check("wrong expectedVersion → 409 STALE", r.status === 409 && r.body.code === "STALE", r);
  r = await cmd(tokA, w, { type: "diagnose", bogus: 1 });
  check("unknown command key → 400", r.status === 400, r);
  r = await cmd(tokA, w, { type: "diagnose" });
  check("diagnose → teach; kid's view still has no plan", r.status === 200 && r.body.ok === true && r.body.view.phase === "teach" && !("plan" in r.body.view), r);
  r = await call("GET", `/api/tutor/workflow/${w}?kid=${kidA}`, undefined, parentTok);
  check("parent sees plan.strategy explain-concept (no history)", r.body.plan && r.body.plan.strategy === "explain-concept", r.body.plan);
  const before = calls.length;
  r = await cmd(tokA, w, { type: "teach" });
  check("teach (lesson): reply is the explanation, phase practice", r.status === 200 && r.body.ok && r.body.reply && r.body.reply.kind === "answer" && /Place value/.test(r.body.reply.text) && r.body.view.phase === "practice", r);
  check("… one classifier + one answer call went to the stub", calls.length - before === 2 && calls.slice(before).some(c => !c.isClassifier), calls.length - before);
  check("kidMode hint is not forced onto the lesson (TutorAgent got answer mode)", JSON.parse(calls[calls.length - 1].t.messages.find(m => m.role === "user").content).mode === "answer");

  let correct = 0, sawWrong = false, sawUncertain = false, sawHint = false, rounds = 0, v = r.body.view;
  const askedPrompts = [];
  while (v.phase !== "done" && rounds < 10) {
    r = await cmd(tokA, w, { type: "practice" });
    if (!(r.status === 200 && r.body.ok)) { check("practice step", false, r); break; }
    v = r.body.view; rounds++;
    const q = v.question;
    askedPrompts.push(q.prompt);
    if (!sawHint) {
      r = await cmd(tokA, w, { type: "hint", questionId: q.questionId });
      check("hint: reply kind hint, stays in answer, hints counted", r.status === 200 && r.body.ok && r.body.reply.kind === "hint" && r.body.view.phase === "answer" && r.body.view.question.hints === 1, r);
      const hintReq = calls[calls.length - 1].question;
      check("the model sees the prompt but never an answer key field", hintReq.includes(q.prompt.split("\n")[0]) && !hintReq.includes("answerKey"), hintReq.slice(0, 200));
      sawHint = true;
    }
    let answer = keyOf(q.questionId);
    if (!sawWrong) answer = wrongOf(q.questionId);
    else if (!sawUncertain) answer = "B";   // 字母不是数 → uncertain
    r = await cmd(tokA, w, { type: "submit", questionId: q.questionId, answer });
    check("submit → evaluate", r.status === 200 && r.body.ok && r.body.view.phase === "evaluate", r);
    r = await cmd(tokA, w, { type: "evaluate" });
    const outcome = r.body.view && r.body.view.evaluation && r.body.view.evaluation.outcome;
    r = await cmd(tokA, w, { type: "adapt" });
    v = r.body.view;
    if (!sawWrong) {
      sawWrong = true;
      check("wrong answer → evaluation wrong, adapt → teach (remediate)", outcome === "wrong" && v.phase === "teach" && v.teachMode === "remediate", { outcome, phase: v.phase, teachMode: v.teachMode });
      r = await cmd(tokA, w, { type: "teach" });
      check("remediate: reply kind hint, back to answer the same question", r.status === 200 && r.body.ok && r.body.reply.kind === "hint" && r.body.view.phase === "answer" && r.body.view.question.questionId === q.questionId, r);
      r = await cmd(tokA, w, { type: "submit", questionId: q.questionId, answer: keyOf(q.questionId) });
      await cmd(tokA, w, { type: "evaluate" });
      r = await cmd(tokA, w, { type: "adapt" });
      v = r.body.view; correct++;
      check("second try correct → next practice", v.phase === "practice" && v.correct === 1 && v.wrong === 1, v);
    } else if (!sawUncertain) {
      sawUncertain = true;
      check("a letter instead of a number → uncertain, moves on", outcome === "uncertain" && v.uncertain === 1 && v.phase === "practice", { outcome, v });
    } else { check("right answer → correct", outcome === "correct", outcome); correct++; }
  }
  check("loop ends done / completed after 3 correct", v.phase === "done" && v.status === "completed" && v.outcome === "goal-reached" && v.correct === 3, v);
  check("practice prompts list the choices without letters and ask for the number", askedPrompts.every(p => /\nChoices:\n• .+\n• /.test(p) && /Type the number\.$/.test(p) && !/\n[A-F]\. /.test(p)), askedPrompts);
  check("only eligible questions were used, none twice", askedPrompts.length === new Set(askedPrompts).size && askedPrompts.every(p => good.some(g => p.startsWith(g.question))), askedPrompts);
  check("limits: 5 rounds (6 eligible questions), target 3", v.limits.maxRounds === 5 && v.limits.targetCorrect === 3, v.limits);
  const finalCmd = lastCmd;
  r = await call("POST", `/api/tutor/workflow/${w}/command`, finalCmd, tokA);
  check("replaying the final adapt (lost response / double click) → the same completed view", r.status === 200 && r.body.ok && r.body.view.status === "completed" && r.body.view.version === v.version, r);
  r = await call("GET", `/api/tutor/workflow/${w}?kid=${kidA}`, undefined, parentTok);
  check("a finished workflow stays readable (parent reloads after the kid finishes)", r.status === 200 && r.body.status === "completed" && r.body.correct === 3, r);
  r = await cmd(tokA, w, { type: "practice" });
  check("… but takes no more commands (409 ILLEGAL_COMMAND)", r.status === 409 && r.body.code === "ILLEGAL_COMMAND", r);

  console.log("learning events on disk");
  const lf = learningFile(familyId, kidA);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(lf, "utf8")); } catch (_) {}
  const types = doc ? doc.events.map(e => e.type) : [];
  check("events land in data/kids/<kid>/learning/<sha256(family, kid)>.json", !!doc, lf);
  check("… with concept_explained, hint_requested, 5 attempts (wrong, retry, uncertain, 2 more), 1 wrong + 3 correct results (uncertain writes none)", types.includes("concept_explained") && types.includes("hint_requested") && types.filter(t => t === "question_attempt").length === 5 && types.includes("answer_wrong") && types.filter(t => t === "answer_correct").length === 3, types);
  check("… never topic_mastered", !types.includes("topic_mastered"), types);
  check("… no answer text or answer key in the file", !fs.readFileSync(lf, "utf8").includes("Type the number"), "prompt leaked");

  console.log("second workflow: diagnose reads the history");
  r = await start(tokA);
  const w2 = r.body.workflowId;
  await cmd(tokA, w2, { type: "diagnose" });
  r = await call("GET", `/api/tutor/workflow/${w2}?kid=${kidA}`, undefined, parentTok);
  check("with 3 right / 1 wrong on the topic the plan switches to socratic-teaching", r.body.plan && r.body.plan.strategy === "socratic-teaching", r.body.plan);

  console.log("engine / rate");
  S.detected.claude = { available: false };
  let n0 = calls.length;
  r = await cmd(tokA, w2, { type: "teach" });
  check("no engine → 503 noEngine, nothing sent to any engine", r.status === 503 && r.body.noEngine === true && calls.length === n0, r);
  markOnlyStubAvailable();
  /* 新孩子 C 的账号从零开始算：每分钟 2 次 */
  S.cfg.tutorWorkflow.perMinute = 2;
  r = await start(tokC);
  const wc = r.body.workflowId;
  await cmd(tokC, wc, { type: "diagnose" });
  const teachC = { type: "teach", commandId: "teach-c" };
  r = await call("POST", `/api/tutor/workflow/${wc}/command`, teachC, tokC);
  check("C: 1st model step (teach) ok", r.status === 200 && r.body.ok, r);
  const lessonC = r.body.reply;
  r = await cmd(tokC, wc, { type: "practice" });
  const qc = r.body.view.question.questionId;
  n0 = calls.length;
  r = await cmd(tokC, wc, { type: "hint", questionId: "not-the-question" });
  check("a hint that the workflow rejects (STALE) is not charged and never reaches the model", r.status === 409 && r.body.code === "STALE" && calls.length === n0, r);
  r = await cmd(tokC, wc, { type: "teach" });
  check("an illegal teach (409) is not charged either", r.status === 409 && r.body.code === "ILLEGAL_COMMAND", r);
  r = await cmd(tokC, wc, { type: "hint", questionId: qc });
  check("C: 2nd model step (hint) ok", r.status === 200 && r.body.ok, r);
  r = await cmd(tokC, wc, { type: "hint", questionId: qc });
  check("C: 3rd model step in the minute → 429 RATE_LIMITED", r.status === 429 && r.body.code === "RATE_LIMITED", r);
  S.detected.claude = { available: false };
  n0 = calls.length;
  r = await call("POST", `/api/tutor/workflow/${wc}/command`, teachC, tokC);
  check("replaying the successful teach: same reply, no charge, no engine needed, no model call", r.status === 200 && r.body.ok && r.body.reply.text === lessonC.text && calls.length === n0, r);
  markOnlyStubAvailable();
  r = await call("GET", `/api/tutor/workflow/${wc}`, undefined, tokC);
  check("… reading is not rate limited", r.status === 200, r);
  r = await cmd(parentTok, wc, { type: "hint", questionId: qc, kid: kidC });
  check("… the parent's account has its own budget", r.status === 200 && r.body.ok && r.body.reply.kind === "hint", r);
  S.cfg.tutorWorkflow.perMinute = 6;

  console.log("capacity / close");
  const extra = [];
  for (let i = 0; i < 2; i++) extra.push((await start(tokA)).body.workflowId);
  r = await start(tokA);
  check("a 4th active workflow for the same kid → 429 CAPACITY (per child; the finished one doesn't count)", r.status === 429 && r.body.code === "CAPACITY" && /per child/.test(r.body.error), r);
  r = await call("GET", `/api/tutor/workflow?kid=${kidA}`, undefined, parentTok);
  const listed = r.body.items || [];
  check("GET /api/tutor/workflow lists the kid's workflows, newest first, finished one included", r.status === 200 && listed.length === 4 && listed.some(x => x.workflowId === w && x.status === "completed") && listed.every((x, i) => i === 0 || listed[i - 1].createdAt >= x.createdAt), listed.map(x => [x.workflowId, x.status]));
  check("… parent sees plan, kid does not", listed.every(x => "plan" in x) && ((await call("GET", "/api/tutor/workflow", undefined, tokA)).body.items || []).every(x => !("plan" in x)));
  r = await call("GET", "/api/tutor/workflow", undefined, tokC);
  check("… a sibling only sees their own", r.status === 200 && r.body.items.every(x => x.workflowId !== w), r.body.items && r.body.items.length);
  /* 这一家现在活跃：A 3 个 + C 1 个 = 4；再给 D 开 2 个到 6，第 7 个（D 自己只有 2 个）被每家上限拦 */
  const dIds = [];
  for (let i = 0; i < 2; i++) { r = await start(tokD); dIds.push(r.body.workflowId); check("D workflow " + (i + 1), r.status === 200, r); }
  r = await start(tokD);
  check("7th active workflow in one family → 429 CAPACITY (per family), though D has only 2", r.status === 429 && r.body.code === "CAPACITY" && /per family/.test(r.body.error), r);
  await call("DELETE", `/api/tutor/workflow/${wc}`, undefined, tokC);
  r = await start(tokD);
  dIds.push(r.body.workflowId);
  check("closing one frees a family slot", r.status === 200, r);
  for (const x of dIds) await call("DELETE", `/api/tutor/workflow/${x}`, undefined, tokD);
  r = await call("DELETE", `/api/tutor/workflow/${w2}`, undefined, tokA);
  check("DELETE closes: status closed", r.status === 200 && r.body.status === "closed" && !("plan" in r.body), r);
  r = await call("GET", `/api/tutor/workflow/${w2}`, undefined, tokA);
  check("… then it is gone (404)", r.status === 404, r);
  for (const x of extra) await call("DELETE", `/api/tutor/workflow/${x}?kid=${kidA}`, undefined, parentTok);

  console.log("deleted kid");
  /* 把这一家塞满：D 3 个 + C 2 个 + B 1 个 = 6，C 第 3 个被每家上限拦；删掉 D 之后名额立刻回来 */
  for (let i = 0; i < 3; i++) await start(tokD);
  for (let i = 0; i < 2; i++) await start(tokC);
  r = await start(tokB);
  const wb = r.body.workflowId;
  r = await start(tokC);
  check("family full (6 active) → C's 3rd start refused", r.status === 429 && /per family/.test(r.body.error), r);
  r = await quiet(() => call("DELETE", "/api/kids/" + kidD, undefined, parentTok)).then(x => x.value);
  check("parent deletes kid D", r.status === 200, r);
  await new Promise(res => setTimeout(res, 30));
  r = await start(tokC);
  check("… D's abandoned workflows were closed with the kid: C can start again", r.status === 200, r);
  await cmd(tokB, wb, { type: "diagnose" });
  r = await cmd(tokB, wb, { type: "teach" });
  check("kid B's lesson recorded", r.status === 200 && r.body.ok && fs.existsSync(learningFile(familyId, kidB)), r);
  r = await quiet(() => call("DELETE", "/api/kids/" + kidB, undefined, parentTok)).then(x => x.value);
  check("parent deletes kid B", r.status === 200, r);
  const archived = fs.readdirSync(path.join(srv.DATA, "data", "kids")).filter(d => d.startsWith("_deleted-" + kidB));
  check("the learning record is archived with the kid's folder", archived.length === 1 && fs.existsSync(path.join(srv.DATA, "data", "kids", archived[0], "learning")), archived);
  r = await start(parentTok, { kid: kidB });
  check("parent can no longer start one for the deleted kid (400)", r.status === 400 && r.body.kidRequired, r);
  check("the deleted kid's folder was not recreated", !fs.existsSync(path.join(srv.DATA, "data", "kids", kidB)));

  console.log("erase all (learning record)");
  r = await call("DELETE", "/api/tutor/learning", undefined, tokA);
  check("a kid cannot erase the learning record (403)", r.status === 403, r);
  r = await call("DELETE", "/api/tutor/learning", undefined, parentTok);
  check("parent must pick a kid (400)", r.status === 400 && r.body.kidRequired, r);
  r = await start(tokA);
  const wErase = r.body.workflowId;
  check("A has a live workflow before the erase", r.status === 200, r);
  S.cfg.tutorWorkflow.enabled = false;
  r = await call("DELETE", `/api/tutor/learning?kid=${kidA}`, undefined, parentTok);
  check("parent erases kid A's learning record even with the feature switched off", r.status === 200 && r.body.ok && r.body.removed === 1, r);
  S.cfg.tutorWorkflow.enabled = true;
  check("… the file is gone, the folder is not recreated as anything else", !fs.existsSync(learningFile(familyId, kidA)));
  r = await call("GET", `/api/tutor/workflow/${wErase}`, undefined, tokA);
  check("… and A's open workflows were closed", r.status === 404, r);
  r = await start(tokA);
  const wFresh = r.body.workflowId;
  await cmd(tokA, wFresh, { type: "diagnose" });
  r = await call("GET", `/api/tutor/workflow/${wFresh}?kid=${kidA}`, undefined, parentTok);
  check("a new workflow sees no history again (explain-concept)", r.body.plan && r.body.plan.strategy === "explain-concept", r.body.plan);
  await call("DELETE", `/api/tutor/workflow/${wFresh}`, undefined, tokA);
  r = await call("DELETE", `/api/tutor/learning?kid=${kidC}`, undefined, parentTok);
  check("erasing another kid (C) works too", r.status === 200, r);

  console.log("other family");
  S.cfg.registrationCode = "wf2";
  const reg2 = await quiet(() => call("POST", "/api/auth/register", { username: "wfother", password: "other12345", name: "O", registrationCode: "wf2" })).then(x => x.value);
  if (reg2.status === 200) {
    const tok2 = reg2.body.token;
    await quiet(() => call("POST", "/api/kids", { name: "Zed", pin: "3333" }, tok2));
    await call("POST", "/api/tutor/settings", { enabled: true }, tok2);
    r = await call("GET", `/api/tutor/workflow/${w}?kid=${kidA}`, undefined, tok2);
    check("another family's parent naming our kid → 400 kidRequired", r.status === 400 && r.body.kidRequired, r);
    r = await call("GET", `/api/tutor/workflow/${w}`, undefined, tok2);
    check("… and through their own only kid → 404", r.status === 404, r);
  } else check("second family registration for the isolation checks", false, reg2);

  console.log("service unit");
  const pf = q => practiceFrom(q, "T", "en");
  check("practiceFrom: good question → prompt with options, answerKey = the correct option", (() => { const p = pf(good[2]); return p && p.questionId === "wq3" && p.answerKey === "3/4" && p.prompt.includes("\nChoices:\n• 1/2\n• 3/4\n") && p.topicId === "T"; })(), pf(good[2]));
  check("practiceFrom rejects visual / non-number / equal options / bad qid / bad index", bad.every(q => pf(q) === null));
  check("practiceFrom rejects missing / odd shapes", [null, {}, { qid: "a", question: "q", options: "12", answerIndex: 0 }, { qid: "a", question: " ", options: ["1", "2"], answerIndex: 0 }].every(q => pf(q) === null));
  check("practiceFrom: zh tail", practiceFrom(good[0], "T", "zh").prompt.endsWith("可选答案：\n• 10\n• 12\n• 14\n• 16\n写出答案的数。"));
  check("practiceFrom: prompt over 1000 chars rejected", pf(Object.assign({}, good[0], { question: "x".repeat(1000) })) === null);
  check("readSettings defaults", JSON.stringify(readSettings(undefined)) === JSON.stringify({ perMinute: WORKFLOW_SERVICE_DEFAULTS.perMinute }) && readSettings({ perMinute: 0 }).perMinute === 6 && readSettings({ perMinute: 3 }).perMinute === 3);
  check("createWorkflowService requires its deps", (() => { try { createWorkflowService({}); return false; } catch (e) { return e instanceof TypeError; } })());
  const svc = createWorkflowService({ tutor: { ask: async () => ({}) }, engineReady: () => true, memoryFor: () => null, bankFor: () => ({ questions: good }), settings: () => ({}) });
  const uctx = { userId: "f1", kidId: "k1", role: "student" };
  const topic = { id: "T", title: "Topic", goal: "Goal" };
  const s1 = await svc.start(uctx, { commandId: "s1", lang: "en" }, { topic });
  const s2 = await svc.send(uctx, s1.body.workflowId, { type: "diagnose", commandId: "d1" }, { accountId: "a" });
  check("memory gone (deleted kid) → diagnose resolves ok:false STORE_FAILED STORE_IO", s2.status === 200 && s2.body.ok === false && s2.body.code === "STORE_FAILED" && s2.body.detail === "STORE_IO", s2);
  check("start without a topic → 400", (await svc.start(uctx, { commandId: "s2" }, {})).status === 400);

  /* 每家账上最多 20 个：做完的不挡别人，满了从最早做完的开始关（1 道题的话题，一个工作流一轮就完） */
  const { createMemory } = require("../lib/ai/memory/index.js");
  const docs = new Map();
  const memStore = {
    read: async owner => docs.get(JSON.stringify(owner)) || null,
    update: async (owner, transform) => { const d = transform(docs.get(JSON.stringify(owner)) || null); if (d) docs.set(JSON.stringify(owner), d); return { doc: d, written: !!d }; },
  };
  const mem = createMemory({ store: memStore });
  const svc2 = createWorkflowService({
    tutor: { ask: async (c, req) => (req.mode === "hint" ? { ok: true, kind: "hint", text: "What does each digit stand for?" } : { ok: true, kind: "answer", text: "Place value tells what each digit is worth." }) },
    engineReady: () => true, memoryFor: () => mem, bankFor: () => ({ questions: [good[0]] }), settings: () => ({ perMinute: 120 }),
  });
  const ids = [];
  let loopOk = true;
  for (let i = 0; i < 21; i++) {
    const st = await svc2.start(uctx, { commandId: "e" + i, lang: "en" }, { topic });
    const id = st.body.workflowId;
    ids.push(id);
    let last;
    for (const c of [{ type: "diagnose" }, { type: "teach" }, { type: "practice" }]) last = await svc2.send(uctx, id, Object.assign({ commandId: id + c.type }, c), { accountId: "a" });
    last = await svc2.send(uctx, id, { type: "submit", commandId: id + "s", questionId: "wq1", answer: "12" }, { accountId: "a" });
    await svc2.send(uctx, id, { type: "evaluate", commandId: id + "e" }, { accountId: "a" });
    last = await svc2.send(uctx, id, { type: "adapt", commandId: id + "a" }, { accountId: "a" });
    if (!(st.status === 200 && last.body.view.status === "completed")) { loopOk = false; check("eviction loop step " + i, false, { st, last }); break; }
  }
  check("21 one-round workflows in a row for one kid all start and complete (finished ones don't count toward per-child 3)", loopOk);
  const listed2 = (await svc2.list(uctx)).body.items;
  check("… the family keeps at most 20 tracked: the oldest finished one was closed", listed2.length === 20 && !listed2.some(x => x.workflowId === ids[0]) && (await svc2.get(uctx, ids[0])).status === 404 && (await svc2.get(uctx, ids[1])).status === 200, listed2.length);

  check("no real engine adapter was ever invoked", realEngineAttempts.length === 0, realEngineAttempts);
  check("no unhandled rejections", unhandled.length === 0, unhandled.map(e => String(e && e.message || e)));
} finally {
  S.server.closeAllConnections();
  await new Promise(r => S.server.close(() => r()));
  srv.cleanup();
}
process.exitCode = summary() ? 0 : 1;
