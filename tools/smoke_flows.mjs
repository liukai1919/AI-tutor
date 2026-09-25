#!/usr/bin/env node
/*
 * 主用户流冒烟（issue #20，#19 Phase 0 的基线）。
 *
 *   node tools/smoke_flows.mjs
 *
 * 隔离、零成本：见 tools/lib/isolated_server.mjs。覆盖的是「现在能跑通的核心流程」，
 * 每一条都是 #19 后续阶段重构时不能弄坏的行为：
 *
 *   A  注册家长 → 建两个孩子 → 孩子 PIN 登录 → /api/providers 身份与目录
 *   B  跟大纲学：/api/curriculum → 随包课程 /api/lesson(teach) → 状态 new→seen → 历史可重播
 *   C  闯关：/api/quiz/session → 服务端按 qid+picked 判分 → /api/quiz/finish → 状态 solid
 *   D  单元卷：随包卷 /api/unit-test → /api/unit-test/attempt 服务端判分 → 存档列表
 *   E  家长报告 /api/report、进度 /api/progress、用量 /api/usage 的口径一致
 *   F  权限边界：孩子碰家长接口 403 parentRequired；家长多孩子不指定 kid 400 kidRequired；孩子之间数据隔离
 *   G  无引擎时：自由提问 / FSA / 完整报告明确 503，不是崩溃
 *   H  重启后与磁盘一致
 *
 * 前提：data/lessons/en、data/unit-tests/en/4-number.json 和一份题库（根目录 qbank.json 或 demo/qbank.json）。
 * 缺题库时 C 组跳过。
 */
import { launch, makeChecker } from "./lib/isolated_server.mjs";

const { check, summary } = makeChecker();
const srv = await launch({ prefix: "yy-smoke-" });
let exitCode = 1;
try {
  console.log("A  accounts and identity");
  const fam = await srv.family("smoke", ["A", "B"]);
  check("parent registered, two kids created", !!fam.parentTok && Object.keys(fam.kids).length === 2);
  check("kid PIN login gives a token", typeof fam.kidTok.A === "string" && fam.kidTok.A.length > 10);
  srv.token = fam.kidTok.A;
  let r = await srv.call("GET", "/api/providers");
  check("providers: student role, no engine (demo), packed lessons present",
    r.status === 200 && r.body.role === "student" && r.body.active === null && r.body.packedLessons > 0, r.body);
  check("providers: curriculum grades listed", Array.isArray(r.body.curriculumGrades) && r.body.curriculumGrades.includes(4));
  r = await srv.call("GET", "/api/auth/me");
  check("auth/me returns kid identity", r.status === 200 && r.body.user && r.body.user.name === "A", r.body);

  console.log("B  follow the curriculum: lesson from the bundled pack");
  r = await srv.call("GET", "/api/curriculum?grade=4");
  check("curriculum: 5 strands, items start as new", r.status === 200 && r.body.strands.length === 5 && r.body.strands[0].items[0].status === "new", r.body.strands && r.body.strands[0]);
  const item = r.body.strands[0].items[0];
  r = await srv.call("POST", "/api/lesson", { mode: "teach", curriculumId: item.id, grade: "Grade 4", gradeCode: "4", lang: "en" });
  check("lesson: served from pack, zero cost", r.status === 200 && r.body.packed === true && r.body.provider === "pack" && r.body.ms === 0, r.body);
  const lesson = r.body.lesson, lessonId = r.body.lessonId;
  check("lesson: shape title/steps[].say/visual, practice q+a", lesson && lesson.title && Array.isArray(lesson.steps) && lesson.steps.length >= 3
    && lesson.steps.every(s => typeof s.say === "string" && s.say.length > 0)
    && (!lesson.practice || (lesson.practice.question && lesson.practice.answer)), lesson && Object.keys(lesson));
  check("lesson: response carries status=seen and a lessonId", r.body.status === "seen" && typeof lessonId === "string" && lessonId.length > 5, r.body);
  r = await srv.call("GET", "/api/curriculum?grade=4");
  check("curriculum: item now seen with lessonId", r.body.strands[0].items[0].status === "seen" && r.body.strands[0].items[0].lessonId === lessonId, r.body.strands[0].items[0]);
  r = await srv.call("GET", "/api/history");
  check("history: one teach record", r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === lessonId && r.body.items[0].mode === "teach", r.body);
  r = await srv.call("GET", "/api/history/" + lessonId);
  check("history/:id: replayable record with the same lesson", r.status === 200 && r.body.record && r.body.record.lesson && r.body.record.lesson.title === lesson.title && r.body.record.curriculumId === item.id, r.body);
  r = await srv.call("POST", "/api/lesson", { mode: "teach", curriculumId: item.id, grade: "Grade 4", gradeCode: "4", lang: "en" });
  check("lesson again: still pack, taught count grows but status stays seen", r.status === 200 && r.body.packed === true && r.body.status === "seen", r.body);
  r = await srv.call("GET", "/api/progress?grade=4");
  check("progress: taught=2, no right/wrong yet", r.body.items[item.id] && r.body.items[item.id].taught === 2 && !r.body.items[item.id].right && !r.body.items[item.id].wrong, r.body.items && r.body.items[item.id]);

  console.log("C  quiz: server-side scoring, pass -> solid");
  r = await srv.call("POST", "/api/quiz/session", { curriculumId: item.id, lang: "en" });
  if (r.status !== 200 || !r.body.questions || !r.body.questions.length) {
    console.log("  skip  no quiz bank for " + item.id + " (" + r.status + ")");
  } else {
    const qs = r.body.questions, rules = r.body.rules || {}, session = r.body.session;
    check("quiz/session: ticket + rules + leveled questions with qid", typeof session === "string" && rules.passNeed >= 1 && rules.topLevel === 3
      && qs.every(q => q.qid && [1, 2, 3].includes(q.level) && Array.isArray(q.options) && q.options.length === 4), { rules, n: qs.length });
    const byLevel = l => qs.filter(q => q.level === l);
    check("quiz/session: at least passNeed questions at the top level", byLevel(3).length >= rules.passNeed, { l3: byLevel(3).length });
    // 客户端上报的 correct 一律不信：这里故意把 correct 写反，服务端应按 qid+picked 自己判
    const results = [];
    for (const [lvl, n] of [[1, 1], [2, 1], [3, rules.passNeed]]) for (const q of byLevel(lvl).slice(0, n)) results.push({ qid: q.qid, correct: false, picked: q.answerIndex });
    r = await srv.call("POST", "/api/quiz/finish", { curriculumId: item.id, lang: "en", session, results });
    check("quiz/finish: passed, status solid, level proficient (client 'correct' flag ignored)", r.status === 200 && r.body.passed === true && r.body.status === "solid" && r.body.level === "proficient", r.body);
    r = await srv.call("POST", "/api/quiz/finish", { curriculumId: item.id, lang: "en", session, results });
    check("quiz/finish: settled ticket cannot be replayed", r.status === 400 && r.body.staleSession === true, r);
    r = await srv.call("GET", "/api/curriculum?grade=4");
    check("curriculum: item now solid", r.body.strands[0].items[0].status === "solid", r.body.strands[0].items[0]);
    r = await srv.call("GET", "/api/progress?grade=4");
    const p = r.body.items[item.id];
    check("progress: quiz right counted, quizPassedAt set", p && p.right === results.length && !p.wrong && typeof p.quizPassedAt === "number", p);
    // 失败路径：另一个知识点全答错
    const item2 = (await srv.call("GET", "/api/curriculum?grade=4")).body.strands[0].items[1];
    r = await srv.call("POST", "/api/quiz/session", { curriculumId: item2.id, lang: "en" });
    if (r.status === 200 && r.body.questions && r.body.questions.length) {
      const wrong = r.body.questions.filter(q => q.level === 1).slice(0, 2).map(q => ({ qid: q.qid, correct: true, picked: (q.answerIndex + 1) % 4 }));
      r = await srv.call("POST", "/api/quiz/finish", { curriculumId: item2.id, lang: "en", session: r.body.session, results: wrong });
      check("quiz/finish: all wrong -> not passed (client 'correct:true' ignored)", r.status === 200 && r.body.passed === false, r.body);
      const p2 = (await srv.call("GET", "/api/progress?grade=4")).body.items[item2.id];
      check("progress: wrong counted, status not solid", p2 && p2.wrong === wrong.length && !p2.right && p2.status !== "solid", p2);
    } else console.log("  skip  no quiz bank for " + item2.id);
  }

  console.log("D  unit test from the bundled pack, server-side scoring");
  r = await srv.call("POST", "/api/unit-test", { grade: 4, strand: "number", count: 8, lang: "en" });
  check("unit-test: bundled paper, 8 questions with answerIndex+explain", r.status === 200 && r.body.packed === true && r.body.set && r.body.set.questions.length === 8
    && r.body.set.questions.every(q => q.curriculumId && Number.isInteger(q.answerIndex) && q.explain), r.body.set && r.body.set.questions[0]);
  const set = r.body.set;
  const answers = set.questions.map((q, i) => i % 2 ? q.answerIndex : (q.answerIndex + 1) % 4);
  const expectRight = answers.filter((a, i) => a === set.questions[i].answerIndex).length;
  r = await srv.call("POST", "/api/unit-test/attempt", { id: set.id, answers, ms: 5000 });
  check("unit-test/attempt: server scores right/total/answered", r.status === 200 && r.body.right === expectRight && r.body.total === 8 && r.body.answered === 8, r.body);
  r = await srv.call("GET", "/api/unit-test/sets?grade=4");
  check("unit-test/sets: archived with last attempt", r.status === 200 && r.body.items.length === 1 && r.body.items[0].last && r.body.items[0].last.right === expectRight && r.body.items[0].last.done === true, r.body);
  r = await srv.call("GET", "/api/unit-test/sets/" + set.id);
  check("unit-test/sets/:id: record with questions", r.status === 200 && r.body.record && r.body.record.questions && r.body.record.questions.length === 8, r.body && Object.keys(r.body));

  console.log("E  parent report, progress and usage agree");
  const prog = (await srv.call("GET", "/api/progress?grade=4")).body.items;
  const sumProg = k => Object.values(prog).reduce((s, e) => s + (e[k] || 0), 0);
  r = await srv.call("GET", "/api/report?grade=4&kid=" + fam.kids.A, undefined, fam.parentTok);
  check("report: parent sees kid A, totals seen/solid counted", r.status === 200 && r.body.totals && r.body.totals.seen >= 1 && r.body.totals.total >= r.body.totals.seen, r.body.totals);
  const repItems = (r.body.strands || []).flatMap(s => s.items);
  const sumRep = k => repItems.reduce((s, e) => s + (e[k] || 0), 0);
  check("report: right/wrong totals equal progress totals", sumRep("right") === sumProg("right") && sumRep("wrong") === sumProg("wrong"), { report: [sumRep("right"), sumRep("wrong")], progress: [sumProg("right"), sumProg("wrong")] });
  check("report: every item has a BC level", repItems.length > 0 && repItems.every(it => ["emerging", "developing", "proficient", "extending"].includes(it.level)), repItems.slice(0, 2));
  r = await srv.call("GET", "/api/usage?days=7", undefined, fam.parentTok);
  check("usage: every call was a free pack/bank hit, zero engine calls", r.status === 200 && r.body.totals.engineCalls === 0 && r.body.totals.freeHits === r.body.totals.calls && r.body.totals.costUsd === 0, r.body.totals);
  check("usage: tasks teach/quiz/unit recorded", r.body.byTask && r.body.byTask.teach && r.body.byTask.unit, Object.keys(r.body.byTask || {}));

  console.log("F  permission boundaries and kid isolation");
  r = await srv.call("GET", "/api/report?grade=4");
  check("kid on parent endpoint -> 403 parentRequired", r.status === 403 && r.body.parentRequired === true, r);
  r = await srv.call("GET", "/api/usage", undefined, fam.kidTok.A);
  check("kid on /api/usage -> 403", r.status === 403, r);
  r = await srv.call("GET", "/api/report?grade=4", undefined, fam.parentTok);
  check("parent with two kids and no kid param -> 400 kidRequired", r.status === 400 && r.body.kidRequired === true, r);
  r = await srv.call("GET", "/api/report?grade=4&kid=" + fam.kids.B, undefined, fam.parentTok);
  check("kid B untouched by kid A's work", r.status === 200 && r.body.totals.seen === 0 && r.body.totals.solid === 0, r.body.totals);
  r = await srv.call("GET", "/api/history", undefined, fam.kidTok.B);
  check("kid B has no history", r.status === 200 && r.body.items.length === 0, r.body);
  const ownHist = (await srv.call("GET", "/api/history", undefined, fam.kidTok.A)).body.items.length;
  r = await srv.call("GET", "/api/history?kid=" + fam.kids.B, undefined, fam.kidTok.A);
  check("kid A asking ?kid=B still only sees kid A (param ignored for students)", r.status === 403 || (r.status === 200 && r.body.items.length === ownHist && ownHist > 0), { status: r.status, n: r.body.items && r.body.items.length, ownHist });
  r = await srv.call("GET", "/api/curriculum?grade=4", undefined, "");
  check("unauthenticated -> 401", r.status === 401, r);
  const other = await srv.family("other", ["Z"]);
  r = await srv.call("GET", "/api/report?grade=4&kid=" + fam.kids.A, undefined, other.parentTok);
  check("another family's parent cannot read kid A", r.status === 403 || r.status === 404 || r.status === 400, r);

  console.log("G  without an engine: honest 503, never a crash");
  r = await srv.call("POST", "/api/lesson", { question: "what is 2+2", grade: "Grade 4", gradeCode: "4", lang: "en" });
  check("free question -> 503 needsEngine", r.status === 503 && r.body.needsEngine === true, r);
  r = await srv.call("POST", "/api/fsa", { grade: 4, strand: "number", count: 6, lang: "en" });
  check("FSA -> 503 (no pack exists for FSA)", r.status === 503, r);
  r = await srv.call("POST", "/api/report/full", { grade: 4, lang: "en", kid: fam.kids.A }, fam.parentTok);
  check("full report -> 503", r.status === 503, r);
  r = await srv.call("POST", "/api/tts", { lang: "en", items: [{ text: "hello", lang: "en" }] });
  check("tts: answers per item in order (daemon absent -> failed state, not an error)", r.status === 200 && Array.isArray(r.body.items) && r.body.items.length === 1 && ["pending", "ready", "failed"].includes(r.body.items[0].state), r.body);
  r = await srv.call("GET", "/api/visual-contract", undefined, "");
  check("visual contract served (v3 types)", r.status === 200 && r.body.version >= 3 && r.body.types && Object.keys(r.body.types).length >= 39, r.body && r.body.version);
  check("server process still alive", !srv.child.exited);

  console.log("H  restart: memory equals disk");
  const before = (await srv.call("GET", "/api/curriculum?grade=4")).body.strands[0].items.map(i => i.status);
  await srv.restart();
  r = await srv.call("GET", "/api/curriculum?grade=4");
  check("statuses survive a restart", r.status === 200 && JSON.stringify(r.body.strands[0].items.map(i => i.status)) === JSON.stringify(before), { before, after: r.body.strands && r.body.strands[0].items.map(i => i.status) });
  r = await srv.call("GET", "/api/unit-test/sets?grade=4");
  check("unit test archive survives a restart", r.status === 200 && r.body.items.length === 1);

  exitCode = summary() ? 0 : 1;
} catch (e) {
  console.error("\nsmoke aborted:", e && e.stack || e);
  console.error(srv.log.slice(-1500));
} finally {
  await srv.stop();
  srv.cleanup();
}
process.exit(exitCode);
