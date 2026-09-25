#!/usr/bin/env node
/*
 * 闯关的「重放 / 在途退出 / 清库」回归（#23 #24 复审，2026-09-25）。零成本：隔离 YY_DATA_DIR + YY_DEMO=1，不调任何模型。
 *
 *   node tools/test_quiz_flow.mjs
 *
 *   A  HTTP：/api/quiz/answer 必须带 qid；同一请求重放原样回上次的结果、不推进；别的 qid 409；只记一题
 *   B  HTTP：家长清库后旧票答题 400 staleSession、结算什么都不记
 *   C  真实页面函数（public/index.html 闯关段，vm 里跑，api 打到隔离服务器）：
 *      服务端已接受、回包在路上时退出 / 切语言 → 等回包落地再凭原场次结算，只结一次；迟到回包不碰新场次；
 *      回包丢了（网络失败）→ 同题重试拿回原结果，不当下一题；一题没交就退出 → 不结算
 *   D  进程内真实 server.js：清库后「生成」一批新题（确定性桩，不走引擎）→ 新场次能开、能答、能结算
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { launch, makeChecker, ROOT, sleep } from "./lib/isolated_server.mjs";

const { check, summary } = makeChecker();
const until = async (fn, ms = 5000) => { for (let i = 0; i < ms / 20; i++) { if (await fn()) return true; await sleep(20); } return false; };
const tally = p => p ? (p.right || 0) + (p.wrong || 0) : 0;

const srv = await launch({ prefix: "yy-quizflow-" });
let ok = false;
try {
  const fam = await srv.family("quizflow", ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]);
  srv.token = fam.kidTok.A;
  /* 找一个中英文题库都在的知识点（C3 切语言要用） */
  const items = (await srv.call("GET", "/api/curriculum?grade=4")).body.strands.flatMap(s => s.items);
  let cid = null;
  for (const it of items) {
    const en = await srv.call("POST", "/api/quiz/session", { curriculumId: it.id, lang: "en" });
    const zh = await srv.call("POST", "/api/quiz/session", { curriculumId: it.id, lang: "zh" });
    if (en.status === 200 && zh.status === 200) { cid = it.id; break; }
  }
  if (!cid) throw new Error("no grade-4 item has both en and zh banks in the isolated qbank");
  const progressOf = async tok => ((await srv.call("GET", "/api/progress?grade=4", undefined, tok)).body.items || {})[cid] || null;

  /* ---------------- A：带 qid 作答，重放幂等 ---------------- */
  console.log("A  /api/quiz/answer binds the question id");
  let s = await srv.call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" });
  const sid = s.body.session, q1 = s.body.question;
  let r = await srv.call("POST", "/api/quiz/answer", { session: sid, picked: 0 });
  check("no qid -> 400 needQid (no silent fallback to 'current question')", r.status === 400 && r.body.needQid === true, r);
  r = await srv.call("POST", "/api/quiz/answer", { session: sid, qid: "not-this-one", picked: 0 });
  check("foreign qid -> 409 staleQuestion", r.status === 409 && r.body.staleQuestion === true, r);
  const body = { session: sid, qid: q1.qid, picked: 0 };
  const a1 = await srv.call("POST", "/api/quiz/answer", body);
  const a2 = await srv.call("POST", "/api/quiz/answer", body);
  check("first answer 200 and serves the next question (n=2)", a1.status === 200 && a1.body.next && a1.body.n === 2 && !a1.body.replay, a1.body);
  check("identical replay -> 200 replay:true, same reply, same next question, n unchanged", a2.status === 200 && a2.body.replay === true && a2.body.next.qid === a1.body.next.qid && a2.body.n === a1.body.n && a2.body.correct === a1.body.correct, a2.body);
  const a3 = await srv.call("POST", "/api/quiz/answer", { session: sid, qid: q1.qid, picked: 3 });
  check("replay with another pick -> first recorded pick wins", a3.status === 200 && a3.body.replay === true && a3.body.picked === 0 && a3.body.correct === a1.body.correct, a3.body);
  const q2 = a1.body.next;
  const b1 = await srv.call("POST", "/api/quiz/answer", { session: sid, qid: q2.qid, picked: 1 });
  check("the real next question is answerable", b1.status === 200 && !b1.body.replay && b1.body.n === a1.body.n + (b1.body.next ? 1 : 0), b1.body);
  r = await srv.call("POST", "/api/quiz/answer", { session: sid, qid: q1.qid, picked: 0 });
  check("an older question (not the last one) -> 409, nothing recorded", r.status === 409 && r.body.staleQuestion === true, r);
  r = await srv.call("POST", "/api/quiz/finish", { session: sid, curriculumId: cid, lang: "en" });
  const pA = await progressOf(fam.kidTok.A);
  check("finish counts exactly the 2 distinct answers", r.status === 200 && r.body.total === 2 && tally(pA) === 2, { finish: r.body, pA });
  r = await srv.call("POST", "/api/quiz/answer", body);
  check("replay after settle -> 400 staleSession", r.status === 400 && r.body.staleSession === true, r);

  /* ---------------- C：真实页面函数 ---------------- */
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const from = html.indexOf("let quiz=null;"), to = html.indexOf("/* ---------- 家长报告", from);
  if (from < 0 || to < 0) throw new Error("quiz section markers not found in public/index.html");
  const QUIZ_SRC = html.slice(from, to);

  /* 够这段代码用的假 DOM：innerHTML 一写，子节点就重来 */
  function el() {
    let sub = {};
    const e = {
      textContent: "", disabled: false, onclick: null, children: [], className: "",
      classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      set innerHTML(v) { sub = {}; e.children = []; e._html = v; }, get innerHTML() { return e._html || ""; },
      appendChild(c) { e.children.push(c); return c; },
      querySelector(sel) { return sub[sel] || (sub[sel] = el()); },
      querySelectorAll(sel) { return sel === ".fsaOpt" ? e.querySelector(".fsaOpts").children : []; },
    };
    return e;
  }
  /* gate：服务器处理完 /api/quiz/answer 之后、回包交给页面之前卡一下 —— 模拟「服务端已接受，回包在路上 / 丢了」 */
  function page(tok, lang) {
    const els = {}, log = { calls: [], finishes: [], sessions: [], confirms: 0, alerts: [], views: [] };
    let gate = null;
    const gates = {};   // path -> [gate…]：按顺序给该路径接下来的请求各挂一个（开局乱序回包用）
    const ctx = {
      console, Promise, JSON, Object, Array, Number, Math, Error,
      setTimeout: fn => { queueMicrotask(fn); return 0; },
      window: { scrollTo() {} }, document: { createElement: () => el() },
      $: id => els[id] || (els[id] = el()),
      cfg: { lang, provider: "" }, learnIndex: {}, lessonReturnTo: "", fsa: null, lessonCurriculumId: "",
      kidBody: () => ({}), confirm: () => { log.confirms++; return true; }, alert: m => log.alerts.push(m),
      t: k => ({ quizOf: n => "Q" + n, quizToPass: x => "need " + x, quizRightMsgs: ["yay"], quizStatFmt: (a, b) => a + "/" + b, quizPassSub: x => "" + x }[k] ?? k),
      mathText: x => String(x), escapeHtml: x => String(x), renderVisual: () => "",
      showLoading() {}, hideLoading() {}, closeLesson() {}, setFocus() {}, updateTabs() {}, switchView: v => log.views.push(v), startTeach() {},
      api: async (p, o) => {
        o = o || {};
        log.calls.push(p);
        const res = await srv.call(o.method || "GET", p, o.body, tok);
        if (p === "/api/quiz/session") log.sessions.push({ lang: o.body && o.body.lang, res });
        if (p === "/api/quiz/answer" && gate) { const g = gate; gate = null; await g(res); }
        if (gates[p] && gates[p].length) await gates[p].shift()(res);
        if (p === "/api/quiz/finish") log.finishes.push(res);
        if (res.status >= 400) throw Object.assign(new Error(res.body.error || "err"), { status: res.status, data: res.body });
        return res.body;
      },
    };
    vm.createContext(ctx);
    vm.runInContext(QUIZ_SRC, ctx);
    return {
      ctx, els, log,
      get quiz() { return vm.runInContext("quiz", ctx); },
      run: code => vm.runInContext(code, ctx),
      /* 下一次作答：服务器处理完后挂起，返回 { accepted, release(), fail() } */
      hold() {
        let accepted, release, fail;
        const acc = new Promise(r => accepted = r), rel = new Promise((res, rej) => { release = res; fail = () => rej(Object.assign(new Error("offline"), { offline: true })); });
        gate = async res => { accepted(res); await rel; };
        return { accepted: acc, release: () => release(), fail: () => fail() };
      },
      failNext() { gate = async () => { throw Object.assign(new Error("offline"), { offline: true }); }; },
      /* 给 p 的下一个请求挂闸：服务器处理完后挂起，release() 放行、refuse(status, body) 改成失败回包 */
      holdPath(p) {
        let accepted, release, refuse;
        const acc = new Promise(r => accepted = r);
        const rel = new Promise(res => { release = () => res(null); refuse = (status, body) => res({ status, body }); });
        (gates[p] || (gates[p] = [])).push(async res => { accepted(res); const o = await rel; if (o) { res.status = o.status; res.body = o.body; } });
        return { accepted: acc, release: () => release(), refuse: (s, b) => refuse(s, b) };
      },
    };
  }
  const bankOf = lang => JSON.parse(fs.readFileSync(path.join(srv.DATA, "qbank.json"), "utf8"))[cid + "|" + lang];
  /* 开一局英文、答一题（让它有东西要结算），返回页面 */
  async function enQuizAnswered(tok) {
    const P = page(tok, "en");
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    await P.run("answerQuiz(0)");
    await sleep(20);
    return P;
  }
  const rightOf = async (tok, qid, lang) => {   // 只为造「答对 / 答错」用：测试侧从隔离题库文件里查答案
    const bank = JSON.parse(fs.readFileSync(path.join(srv.DATA, "qbank.json"), "utf8"))[cid + "|" + lang];
    return bank.questions.find(q => q.qid === qid).answerIndex;
  };

  console.log("C0 quit before answering anything");
  {
    const P = page(fam.kidTok.B, "en");
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    P.els.quizQuit.onclick();
    await sleep(100);
    check("no confirm, no finish, quiz closed", P.log.confirms === 0 && !P.log.calls.includes("/api/quiz/finish") && P.quiz === null, P.log);
  }

  console.log("C1 explicit quit while the first answer's response is in flight");
  {
    const P = page(fam.kidTok.C, "en");
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    const h = P.hold();
    const pending = P.run("answerQuiz(0)");
    const acc = await h.accepted;
    check("server accepted the answer (200) before the quit", acc.status === 200, acc);
    P.els.quizQuit.onclick();
    check("quit asks for confirmation even though no reply arrived yet", P.log.confirms === 1 && P.quiz === null);
    await sleep(50);
    check("finish is not sent while the answer is still in flight", !P.log.calls.includes("/api/quiz/finish"), P.log.calls);
    h.release(); await pending;
    await until(() => P.log.finishes.length > 0);
    await sleep(100);
    const pC = await progressOf(fam.kidTok.C);
    check("after the reply lands: exactly one finish, settling the 1 accepted answer", P.log.finishes.length === 1 && P.log.finishes[0].status === 200 && P.log.finishes[0].body.total === 1 && tally(pC) === 1, { f: P.log.finishes, pC });
    P.els.quizQuit.onclick(); await sleep(50);
    check("a second quit click does not settle again", P.log.finishes.length === 1);
  }

  console.log("C1b quit while in flight, then the response fails (network)");
  {
    const P = page(fam.kidTok.D, "en");
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    const h = P.hold();
    const pending = P.run("answerQuiz(1)");
    await h.accepted;
    P.els.quizQuit.onclick();
    h.fail(); await pending;
    await until(() => P.log.finishes.length > 0);
    await sleep(100);
    const pD = await progressOf(fam.kidTok.D);
    check("failed reply + quit: still settled once with the server-accepted answer", P.log.finishes.length === 1 && P.log.finishes[0].body.total === 1 && tally(pD) === 1 && P.log.alerts.length === 0, { f: P.log.finishes, pD, alerts: P.log.alerts });
  }

  console.log("C2 reply lost (server accepted), same-question retry, keep going, then quit");
  {
    const P = page(fam.kidTok.E, "en");
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    const q1p = P.quiz.cur;
    const wrong = ((await rightOf(fam.kidTok.E, q1p.qid, "en")) + 1) % 4;
    P.failNext();
    await P.run(`answerQuiz(${wrong})`);
    check("lost reply: buttons usable again, nothing counted locally, same question", P.quiz.busy === false && P.quiz.total === 0 && P.quiz.cur === q1p && P.log.alerts.length === 1, { busy: P.quiz.busy, total: P.quiz.total });
    const other = (wrong + 1) % 4;
    await P.run(`answerQuiz(${other})`);
    const btns = P.els.quizBody.querySelectorAll(".fsaOpt");
    check("retry (even with another option) gets the recorded reply: wrong pick marked, 1 counted", P.quiz.total === 1 && P.quiz.right === 0 && btns[wrong].classList.contains("wrong") && !btns[other].classList.contains("wrong"), { total: P.quiz.total, right: P.quiz.right });
    P.els.quizFb.querySelector("#quizNextBtn").onclick();
    const q2p = P.quiz.cur;
    check("advances to the server's next question (n=2), not a skipped one", q2p && q2p.qid !== q1p.qid && P.quiz.n === 2, { n: P.quiz.n, q2p });
    await P.run(`answerQuiz(${await rightOf(fam.kidTok.E, q2p.qid, "en")})`);
    await sleep(20);
    check("next question answered normally", P.quiz.total === 2 && P.quiz.right === 1);
    P.els.quizQuit.onclick();
    await until(() => P.log.finishes.length > 0); await sleep(100);
    const pE = await progressOf(fam.kidTok.E);
    check("settled 2 answers once (the retry was not a second answer)", P.log.finishes.length === 1 && P.log.finishes[0].body.total === 2 && tally(pE) === 2, { f: P.log.finishes, pE });
  }

  console.log("C3 language switch while the first answer's response is in flight");
  {
    const P = page(fam.kidTok.F, "en");
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    const old = P.quiz;
    const h = P.hold();
    const pending = P.run("answerQuiz(0)");
    await h.accepted;
    P.ctx.cfg.lang = "zh";
    P.run("quizLangChanged()");
    P.run("quizLangChanged()");   // 连切两次也只结一次、只开一局
    await until(() => P.quiz && P.quiz !== old);
    const fresh = P.quiz;
    const snap = JSON.stringify({ sid: fresh.sid, n: fresh.n, total: fresh.total, level: fresh.level, busy: fresh.busy, cur: fresh.cur && fresh.cur.qid });
    check("new zh session opened, old one not settled yet (reply still in flight)", fresh.lang === "zh" && fresh.sid !== old.sid && !P.log.calls.includes("/api/quiz/finish"), P.log.calls);
    h.release(); await pending;
    await until(() => P.log.finishes.length > 0); await sleep(100);
    const after = JSON.stringify({ sid: P.quiz.sid, n: P.quiz.n, total: P.quiz.total, level: P.quiz.level, busy: P.quiz.busy, cur: P.quiz.cur && P.quiz.cur.qid });
    check("late reply of the old session leaves the new session untouched", P.quiz === fresh && after === snap, { snap, after });
    check("old session settled once with its 1 answer", P.log.finishes.length === 1 && P.log.finishes[0].body.total === 1 && P.log.calls.filter(c => c === "/api/quiz/session").length === 2, { f: P.log.finishes, calls: P.log.calls });
    await P.run(`answerQuiz(${await rightOf(fam.kidTok.F, fresh.cur.qid, "zh")})`);
    await sleep(20);
    check("the new session's first question answers normally", P.quiz.total === 1 && P.quiz.right === 1 && P.quiz.n === 2, { total: P.quiz.total, n: P.quiz.n });
    P.els.quizQuit.onclick();
    await until(() => P.log.finishes.length > 1); await sleep(100);
    const pF = await progressOf(fam.kidTok.F);
    check("new session settles only its own answer", P.log.finishes.length === 2 && P.log.finishes[1].body.total === 1 && tally(pF) === 2, { f: P.log.finishes.map(f => f.body), pF });
  }

  /* 二次复审：en → zh → en 快速来回切，开局回包乱序 / 顺序到达；最后选的语言 = 最后有效的场次 */
  const zhQids = new Set(bankOf("zh").questions.map(q => q.qid)), enQids = new Set(bankOf("en").questions.map(q => q.qid));
  for (const order of ["en-first", "zh-first"]) {
    console.log(`C4 en -> zh -> en quick switch, start replies arrive ${order === "en-first" ? "out of order (en first)" : "in order (zh first)"}`);
    const tok = order === "en-first" ? fam.kidTok.G : fam.kidTok.H;
    const P = await enQuizAnswered(tok);
    const old = P.quiz;
    const hz = P.holdPath("/api/quiz/session");
    P.ctx.cfg.lang = "zh"; P.run("quizLangChanged()");
    await hz.accepted;
    const he = P.holdPath("/api/quiz/session");
    P.ctx.cfg.lang = "en"; P.run("quizLangChanged()");
    const heGot = await Promise.race([he.accepted.then(() => true), sleep(1500).then(() => false)]);
    check("switching back to en while the zh start is pending opens an en start", heGot && P.log.sessions.map(s => s.lang).slice(-2).join() === "zh,en", P.log.sessions.map(s => s.lang));
    if (order === "en-first") { he.release(); await until(() => P.quiz !== old); hz.release(); }
    else { hz.release(); await sleep(100); check("stale zh start reply does not enter while the en one is pending", P.quiz === old, { lang: P.quiz && P.quiz.lang }); he.release(); }
    await until(() => P.quiz && P.quiz !== old);
    await sleep(150);
    const enSid = P.log.sessions.filter(s => s.lang === "en").at(-1).res.body.session;
    const q = P.quiz;
    check("final session is the en one: sid, lang, question all en", q && q.sid === enSid && q.lang === "en" && enQids.has(q.cur.qid) && !zhQids.has(q.cur.qid) && q.done === false && q.total === 0, q && { sid: q.sid, enSid, lang: q.lang, qid: q.cur && q.cur.qid });
    await until(() => P.log.finishes.length > 0); await sleep(100);
    check("the original en session settled exactly once (its 1 answer)", P.log.finishes.length === 1 && P.log.finishes[0].body.total === 1, P.log.finishes.map(f => f.body));
    await P.run(`answerQuiz(${enQids.has(q.cur.qid) ? bankOf("en").questions.find(x => x.qid === q.cur.qid).answerIndex : 0})`);
    await sleep(20);
    check("the final en session answers normally", P.quiz === q && q.total === 1 && q.right === 1, { total: q.total });
  }

  console.log("C5 quit while the language-switch start is pending");
  {
    const P = await enQuizAnswered(fam.kidTok.I);
    const hz = P.holdPath("/api/quiz/session");
    P.ctx.cfg.lang = "zh"; P.run("quizLangChanged()");
    await hz.accepted;
    P.els.quizQuit.onclick();
    check("quit closes the quiz right away", P.quiz === null && P.els.quizCard.classList.contains("hidden"));
    hz.release();
    await sleep(200);
    check("the late start reply does not reopen the quiz", P.quiz === null && P.els.quizCard.classList.contains("hidden"), { quiz: P.quiz && P.quiz.sid });
    await until(() => P.log.finishes.length > 0); await sleep(50);
    check("the quit session was settled once", P.log.finishes.length === 1 && P.log.finishes[0].body.total === 1, P.log.finishes.map(f => f.body));
  }

  console.log("C6 language-switch start fails");
  {
    const P = await enQuizAnswered(fam.kidTok.J);
    const hz = P.holdPath("/api/quiz/session");
    P.ctx.cfg.lang = "zh"; P.run("quizLangChanged()");
    await hz.accepted;
    hz.refuse(503, { error: "needs an engine", needsEngine: true });
    await sleep(200);
    check("failed start: not stuck on the old question — quiz closed, back to the list, error shown", P.quiz === null && P.els.quizCard.classList.contains("hidden") && P.log.views.includes("learn") && P.log.alerts.length === 1, { quiz: P.quiz && { lang: P.quiz.lang, done: P.quiz.done }, views: P.log.views, alerts: P.log.alerts });
    await until(() => P.log.finishes.length > 0); await sleep(50);
    check("…and the old en session was still settled once", P.log.finishes.length === 1 && P.log.finishes[0].body.total === 1, P.log.finishes.map(f => f.body));
    await P.run(`startQuiz(${JSON.stringify(cid)})`);
    check("a fresh start afterwards works, in the current UI language", P.quiz && P.quiz.lang === "zh" && zhQids.has(P.quiz.cur.qid) && !P.quiz.done, P.quiz && { lang: P.quiz.lang });
  }

  /* ---------------- B：清库后的旧票 ---------------- */
  console.log("B  parent clears the question bank mid-quiz");
  srv.token = fam.kidTok.B;
  s = await srv.call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" });
  const before = tally(await progressOf(fam.kidTok.B));
  /* 二次复审：另一张票清库前先答一题、重放两次（只记一次），清库后再重放 */
  const tk = fam.kidTok.K;
  const sk = (await srv.call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" }, tk)).body;
  const kq = sk.question.qid;
  const k1 = await srv.call("POST", "/api/quiz/answer", { session: sk.session, qid: kq, picked: 0 }, tk);
  const k2 = await srv.call("POST", "/api/quiz/answer", { session: sk.session, qid: kq, picked: 0 }, tk);
  const k3 = await srv.call("POST", "/api/quiz/answer", { session: sk.session, qid: kq, picked: 2 }, tk);
  check("before clear: answer + two replays -> 200, 200 replay, 200 replay (first pick kept)", k1.status === 200 && !k1.body.replay && k2.body.replay === true && k3.body.replay === true && k3.body.picked === 0, [k1.body, k2.body, k3.body].map(b => ({ replay: b.replay, picked: b.picked })));
  const beforeK = tally(await progressOf(tk));
  r = await srv.call("DELETE", "/api/qbank", undefined, fam.parentTok);
  check("clear -> 200", r.status === 200, r);
  r = await srv.call("POST", "/api/quiz/answer", { session: s.body.session, qid: s.body.question.qid, picked: 0 });
  check("old ticket after clear: answer -> 400 staleSession (not judged from the old bank)", r.status === 400 && r.body.staleSession === true, r);
  r = await srv.call("POST", "/api/quiz/finish", { session: s.body.session, curriculumId: cid, lang: "en" });
  check("old ticket after clear: finish records nothing", r.status === 200 && r.body.total === 0 && tally(await progressOf(fam.kidTok.B)) === before, r.body);
  r = await srv.call("POST", "/api/quiz/answer", { session: sk.session, qid: kq, picked: 0 }, tk);
  check("answered ticket, replay after clear (same pick) -> 400 staleSession, no cached old reply", r.status === 400 && r.body.staleSession === true && !("answerIndex" in r.body), r);
  r = await srv.call("POST", "/api/quiz/answer", { session: sk.session, qid: kq, picked: 3 }, tk);
  check("answered ticket, replay after clear (other pick) -> 400 staleSession", r.status === 400 && r.body.staleSession === true, r);
  r = await srv.call("POST", "/api/quiz/finish", { session: sk.session, curriculumId: cid, lang: "en" }, tk);
  check("answered ticket after clear: finish records nothing from the old bank", r.status === 200 && r.body.total === 0 && tally(await progressOf(tk)) === beforeK && beforeK === 0, { f: r.body, beforeK });

  ok = true;
} catch (e) {
  console.log("  FAIL  crashed: " + (e.stack || e));
  console.log(srv.log.slice(-2000));
} finally { await srv.stop(); srv.cleanup(); }

/* ---------------- D：进程内真实 server.js，清库后新生成的题能答 ---------------- */
console.log("D  in-process server.js: clear, regenerate (deterministic stub), play");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "yy-quizflow-inproc-"));
try {
  fs.mkdirSync(path.join(DATA, "data"), { recursive: true });
  fs.writeFileSync(path.join(DATA, ".migrated-from-app"), "quizflow\n");
  fs.writeFileSync(path.join(DATA, "config.json"), "{}\n");
  for (const cand of [path.join(ROOT, "qbank.json"), path.join(ROOT, "demo", "qbank.json")]) if (fs.existsSync(cand)) { fs.cpSync(cand, path.join(DATA, "qbank.json")); break; }
  Object.assign(process.env, { YY_DATA_DIR: DATA, YY_DEMO: "1", YY_SAVE_RETRY_MS: "300", REGISTRATION_CODE: "iso" });
  const require = createRequire(import.meta.url);
  const log = console.log; console.log = () => {};   // server.js 启动日志太吵
  let mod;
  try { mod = require("../server.js"); } finally { console.log = log; }
  await new Promise(r => mod.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + mod.server.address().port;
  const call = async (method, p, body, tok) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-session": tok || "" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const reg = await call("POST", "/api/auth/register", { username: "inproc", password: "inproc123", name: "P", registrationCode: "iso" });
  const ptok = reg.body.token;
  await call("POST", "/api/kids", { name: "K", pin: "1111" }, ptok);
  const kidId = (await call("GET", "/api/auth/profiles")).body.kids[0].id;
  const ktok = (await call("POST", "/api/auth/login", { kidId, pin: "1111" })).body.token;
  const cid = Object.keys(mod.qbank).map(k => k.split("|")).find(([id, lang]) => lang === "en" && /^BC\.MATH\.G4\./.test(id))[0];
  const old = await call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" }, ktok);
  check("D: session on the bundled bank", old.status === 200, old);
  const oq = old.body.question.qid;
  const o1 = await call("POST", "/api/quiz/answer", { session: old.body.session, qid: oq, picked: 1 }, ktok);
  const o2 = await call("POST", "/api/quiz/answer", { session: old.body.session, qid: oq, picked: 1 }, ktok);
  check("D: answered before clear, replay ok", o1.status === 200 && o2.status === 200 && o2.body.replay === true, [o1.status, o2.status]);
  const cleared = await call("DELETE", "/api/qbank", undefined, ptok);
  check("D: clear empties the exported (live) bank", cleared.status === 200 && Object.keys(mod.qbank).length === 0, Object.keys(mod.qbank).length);
  /* 确定性「生成」：ensureQuizBank 写的就是 qbank[key]（同一个容器），这里直接写同一个对象 */
  const mk = (lv, i) => ({ qid: "NEW" + lv + i, level: lv, question: "new " + lv + i + "?", options: ["a", "b", "c", "d"], answerIndex: i % 4, explain: "e", usedAt: 0 });
  mod.qbank[mod.qbankKey(cid, "en")] = { questions: [1, 2, 3].flatMap(lv => [0, 1, 2, 3].map(i => mk(lv, i))) };
  const fresh = await call("POST", "/api/quiz/session", { curriculumId: cid, lang: "en" }, ktok);
  check("D: new session opens on the regenerated bank", fresh.status === 200 && /^NEW1/.test(fresh.body.question.qid), fresh);
  const q = fresh.body.question;
  const a = await call("POST", "/api/quiz/answer", { session: fresh.body.session, qid: q.qid, picked: Number(q.qid.slice(-1)) % 4 }, ktok);
  check("D: regenerated question answers right away (no staleSession)", a.status === 200 && a.body.correct === true && /^NEW2/.test(a.body.next.qid), a);
  const oa = await call("POST", "/api/quiz/answer", { session: old.body.session, qid: oq, picked: 1 }, ktok);
  check("D: old ticket replay after clear + regenerate -> 400 staleSession", oa.status === 400 && oa.body.staleSession === true, oa);
  const on = await call("POST", "/api/quiz/answer", { session: old.body.session, qid: o1.body.next.qid, picked: 0 }, ktok);
  check("D: old ticket's next question -> 400 staleSession", on.status === 400 && on.body.staleSession === true, on);
  const of = await call("POST", "/api/quiz/finish", { session: old.body.session, curriculumId: cid, lang: "en" }, ktok);
  check("D: old ticket finish records nothing", of.status === 200 && of.body.total === 0, of.body);
  const f = await call("POST", "/api/quiz/finish", { session: fresh.body.session, curriculumId: cid, lang: "en" }, ktok);
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, "qbank.json"), "utf8"));
  check("D: finish settles from the new bank and the new bank is what gets saved", f.status === 200 && f.body.total === 1 && f.body.right === 1 && saved[mod.qbankKey(cid, "en")].questions.find(x => x.qid === q.qid).usedAt > 0, { f: f.body });
  mod.server.close();
} catch (e) {
  ok = false;
  console.log("  FAIL  D crashed: " + (e.stack || e));
} finally { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {} }

process.exit(summary() && ok ? 0 : 1);
