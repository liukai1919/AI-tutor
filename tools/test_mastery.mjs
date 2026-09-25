#!/usr/bin/env node
/*
 * lib/domain/mastery.js 的单元测试（#21）。不起服务器、不读盘，毫秒级。
 *
 *   node tools/test_mastery.mjs
 *
 * 和 golden_cases 的分工：golden 从 HTTP 端到端钉住「同样的操作同样的判定」；这里直接喂
 * progress 条目，把每条规则的边界（天数阈值、legacy 分支、误区阈值、未知事件）单独钉死。
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const M = require("../lib/domain/mastery.js");
const { check, summary } = makeChecker();

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 25, 18, 0, 0); // 本地时区无关：dayKey 用本地日期，连续加 DAY 一定跨天

console.log("levelOf / statusOf");
check("no entry -> emerging/new", M.levelOf(undefined) === "emerging" && M.statusOf("emerging") === "new");
check("fresh entry -> emerging", M.levelOf(M.newEntry()) === "emerging");
check("taught only -> developing/seen", M.levelOf({ ...M.newEntry(), taught: 1 }) === "developing" && M.statusOf("developing") === "seen");
check("wrong only -> developing", M.levelOf({ ...M.newEntry(), wrong: 1 }) === "developing");
check("right on 1 day -> developing", M.levelOf({ ...M.newEntry(), right: 5, rightDays: ["a"] }) === "developing");
check("right on 2 days -> proficient/solid", M.levelOf({ ...M.newEntry(), right: 2, rightDays: ["a", "b"] }) === "proficient" && M.statusOf("proficient") === "solid");
check("right on 3 days -> extending/solid", M.levelOf({ ...M.newEntry(), right: 3, rightDays: ["a", "b", "c"] }) === "extending" && M.statusOf("extending") === "solid");
check("manual solid -> proficient", M.levelOf({ ...M.newEntry(), solid: true }) === "proficient");
check("quiz passed -> proficient", M.levelOf({ ...M.newEntry(), quizPassedAt: 1 }) === "proficient");

console.log("applyEvent");
let p = {};
let e = M.applyEvent(p, "X", "taught", { now: T0, lessonId: "L1" });
check("taught: creates entry, taught=1, lessonIds=[L1], lastAt=now", e.taught === 1 && e.lessonIds[0] === "L1" && e.lastAt === T0 && p.X === e, e);
M.applyEvent(p, "X", "taught", { now: T0 + 1, lessonId: "L2" });
check("taught again: lessonIds newest first", p.X.taught === 2 && p.X.lessonIds.join() === "L2,L1", p.X.lessonIds);
for (let i = 0; i < 25; i++) M.applyEvent(p, "X", "taught", { now: T0, lessonId: "L" + (10 + i) });
check("lessonIds capped at 20", p.X.lessonIds.length === 20);
M.applyEvent(p, "X", "practiced-right", { now: T0 });
M.applyEvent(p, "X", "practiced-right", { now: T0 + 1000 });
check("practiced-right same day: right=2, rightDays=1", p.X.right === 2 && p.X.rightDays.length === 1, p.X);
M.applyEvent(p, "X", "practiced-right", { now: T0 + DAY });
check("practiced-right next day: rightDays=2 -> proficient", p.X.rightDays.length === 2 && M.levelOf(p.X) === "proficient", p.X);
M.applyEvent(p, "X", "practiced-wrong", { now: T0 });
check("practiced-wrong: wrong=1, level unchanged", p.X.wrong === 1 && M.levelOf(p.X) === "proficient");
p = {};
M.applyEvent(p, "Q", "quiz-right", { now: T0 }); M.applyEvent(p, "Q", "quiz-right", { now: T0 + DAY }); M.applyEvent(p, "Q", "quiz-right", { now: T0 + 2 * DAY });
check("quiz-right never adds rightDays (no free solid by streaks)", p.Q.right === 3 && p.Q.rightDays.length === 0 && M.levelOf(p.Q) === "developing", p.Q);
M.applyEvent(p, "Q", "quiz-wrong", { now: T0 });
check("quiz-wrong: wrong=1", p.Q.wrong === 1);
e = M.applyEvent(p, "Q", "quiz-pass", { now: T0 + 5 });
check("quiz-pass: quizPassedAt=now, that day counts as a rightDay, proficient", e.quizPassedAt === T0 + 5 && e.rightDays.length === 1 && M.levelOf(e) === "proficient", e);
M.applyEvent(p, "Q", "mark-solid", { now: T0 });
check("mark-solid sets solid", p.Q.solid === true);
M.applyEvent(p, "Q", "unmark-solid", { now: T0 });
check("unmark-solid clears solid but quizPassedAt keeps it proficient", p.Q.solid === false && M.levelOf(p.Q) === "proficient");
p = {};
const bad = M.applyEvent(p, "Z", "quiz-pass-please", { now: T0 });
check("unknown event -> null, entry still created untouched (matches old behaviour)", bad === null && p.Z && p.Z.taught === 0 && p.Z.lastAt === 0, p.Z);
check("applyEvent without opts.now throws (no hidden clock in the domain layer)", [undefined, {}, { now: null }, { now: "1" }, { now: NaN }].every(o => { try { M.applyEvent({}, "T", "taught", o); return false; } catch (e) { return e instanceof TypeError; } }));
check("same input + same now -> identical output", JSON.stringify(M.applyEvent({}, "Q", "quiz-pass", { now: 1 })) === JSON.stringify(M.applyEvent({}, "Q", "quiz-pass", { now: 1 })));
check("EVENTS lists all 8; parent-only and internal sets are subsets", M.EVENTS.length === 8 && [...M.PARENT_ONLY_EVENTS, ...M.INTERNAL_EVENTS].every(x => M.EVENTS.includes(x)));
check("dayKey is a local calendar date", /^\d{4}-\d{2}-\d{2}$/.test(M.dayKey(T0)));

console.log("rollupStandard / evidenceFor");
const skills = {
  S1: { id: "S1", type: "concept", core: true, zh: "一", en: "one" },
  S2: { id: "S2", type: "apply", core: true, zh: "二", en: "two" },
  S3: { id: "S3", type: "fluency", core: false, zh: "三", en: "three" },
  R1: { id: "R1", type: "concept", zh: "补", en: "remedy" },
};
const skillOf = id => skills[id] || null;
check("no skills attached -> null", M.rollupStandard({}, "STD", undefined, skillOf) === null && M.rollupStandard({}, "STD", [], skillOf) === null);
let r = M.rollupStandard({}, "STD", ["S1", "S2", "S3"], skillOf);
check("untouched: emerging, pool = core skills only (2 of 3)", r.level === "emerging" && r.total === 2 && r.touched === 0 && r.proficient === 0 && r.legacy === null, r);
r = M.rollupStandard({ S1: { ...M.newEntry(), taught: 1 } }, "STD", ["S1", "S2", "S3"], skillOf);
check("one core skill touched -> developing", r.level === "developing" && r.touched === 1, r);
r = M.rollupStandard({ S1: { ...M.newEntry(), solid: true }, S2: { ...M.newEntry(), quizPassedAt: 1 } }, "STD", ["S1", "S2", "S3"], skillOf);
check("all core proficient -> proficient (non-core S3 ignored)", r.level === "proficient" && r.proficient === 2, r);
r = M.rollupStandard({ S1: { ...M.newEntry(), solid: true }, S2: { ...M.newEntry(), rightDays: ["a", "b", "c"] } }, "STD", ["S1", "S2", "S3"], skillOf);
check("all proficient + an apply/reason skill at extending -> extending", r.level === "extending", r);
r = M.rollupStandard({ S1: { ...M.newEntry(), rightDays: ["a", "b", "c"] }, S2: { ...M.newEntry(), solid: true } }, "STD", ["S1", "S2", "S3"], skillOf);
check("extending only on a concept skill does not lift the standard past proficient", r.level === "proficient", r);
r = M.rollupStandard({ STD: { ...M.newEntry(), right: 4, rightDays: ["a", "b"] } }, "STD", ["S1", "S2"], skillOf);
check("legacy: progress on the standard itself but no skill touched -> low-confidence evidence", r.level === "emerging" && r.legacy && r.legacy.level === "proficient" && r.legacy.confidence === "low", r);
r = M.rollupStandard({ S3: { ...M.newEntry(), taught: 1 } }, "STD", ["S3"], skillOf);
check("all skills non-core -> pool falls back to all", r.total === 1 && r.level === "developing", r);

let ev = M.evidenceFor({ STD: { ...M.newEntry(), taught: 1, right: 1, lastAt: 5 }, S1: { ...M.newEntry(), right: 2, wrong: 1, lastAt: 9 } }, "STD", ["S1", "S2"], skillOf);
check("evidence sums standard + skills, latest lastAt, level from rollup", ev.taught === 1 && ev.right === 3 && ev.wrong === 1 && ev.lastAt === 9 && ev.level === "developing" && ev.skills && ev.ids.join() === "STD,S1,S2", ev);
ev = M.evidenceFor({ STD: { ...M.newEntry(), solid: true } }, "STD", ["S1"], skillOf);
check("parent star on the standard overrides rollup", ev.level === "proficient" && ev.manualSolid === true, ev);
ev = M.evidenceFor({ STD: { ...M.newEntry(), taught: 1 } }, "STD", undefined, skillOf);
check("no skills -> old levelOf path, skills=null", ev.level === "developing" && ev.skills === null && ev.ids.join() === "STD", ev);

console.log("recordMiss / remediationFor");
const miscs = { "M.ADD": { zh: "进位忘了", en: "forgot carry", remedy: "R1" }, "M.OTHER": { zh: "别的", en: "other", remedy: "" } };
const miscOf = id => miscs[id];
p = {};
M.recordMiss(p, "S1", "M.ADD", T0);
check("first miss: entry created, miss count 1, no remediation yet", p.S1.miss["M.ADD"] === 1 && p.S1.lastAt === T0 && M.remediationFor(p.S1, "S1", skillOf, miscOf) === null, p.S1);
M.recordMiss(p, "S1", "M.ADD", T0 + 1);
let rem = M.remediationFor(p.S1, "S1", skillOf, miscOf);
check("second miss reaches MISS_TRIGGER -> remedy from the misconception table", M.MISS_TRIGGER === 2 && rem && rem.miscId === "M.ADD" && rem.times === 2 && rem.skillId === "R1" && rem.skillZh === "补" && rem.zh === "进位忘了", rem);
const withBranch = id => id === "S1" ? { ...skills.S1, diag: { branch: { "M.ADD": "S2" } } } : skillOf(id);
rem = M.remediationFor(p.S1, "S1", withBranch, miscOf);
check("skill's own diag.branch wins over the table remedy", rem.skillId === "S2" && rem.skillEn === "two", rem);
M.recordMiss(p, "S1", "M.OTHER", T0); M.recordMiss(p, "S1", "M.OTHER", T0); M.recordMiss(p, "S1", "M.OTHER", T0);
rem = M.remediationFor(p.S1, "S1", skillOf, miscOf);
check("most frequent misconception is chosen; unknown remedy -> empty skill", rem.miscId === "M.OTHER" && rem.times === 3 && rem.skillId === "" && rem.skillZh === "", rem);
rem = M.remediationFor(p.S1, "S1", skillOf, () => undefined);
check("misconception missing from the table -> id used as label", rem.zh === "M.OTHER" && rem.en === "M.OTHER", rem);
check("no entry / no miss -> null", M.remediationFor(undefined, "S1", skillOf, miscOf) === null && M.remediationFor(M.newEntry(), "S1", skillOf, miscOf) === null);

process.exit(summary() ? 0 : 1);
