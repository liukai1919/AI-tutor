/*
 * tools/eval_tutor_live.mjs 的判分规则与问题集自检（#65）。零成本：不调引擎、不起服务器。
 *   node tools/test_eval_tutor_live.mjs
 */
import fs from "node:fs";
import { hasNumber, score } from "./eval_tutor_live.mjs";
import { makeChecker } from "./lib/isolated_server.mjs";
const { check, summary } = makeChecker();

/* 数字 token 边界 */
check("KaTeX 分数算作 a/b", hasNumber("答案是 \\(\\frac{5}{6}\\)。", "5/6"));
check("\\dfrac 也算", hasNumber("\\dfrac{3}{8}", "3/8"));
check("5/6 不命中 15/6", !hasNumber("是 15/6 吗", "5/6"));
check("4 不命中 4.5", !hasNumber("结果 4.5", "4"));
check("4 单独出现命中", hasNumber("等于 4。", "4"));
check("千分位逗号去掉", hasNumber("2,750 mL", "2750"));
check("数学减号 − 归一成 -", hasNumber("结果是 −8", "-8"));
check("-8 不命中 18-8", !hasNumber("18-8=10", "-8"));
check("0.06 不命中 0.6", !hasNumber("是 0.6", "0.06"));
check("13 不命中 130", !hasNumber("130", "13"));
check("11 不命中 11/12", !hasNumber("11/12", "11"));

/* score */
const hint = { expect: { kind: ["hint"], answerKey: "63", ask: true } };
check("提示题：没漏答案、有问句 → pass", score(hint, { kind: "hint", text: "底乘高是多少？" }).pass);
check("提示题：漏答案 → 不过", !score(hint, { kind: "hint", text: "面积是 63 吗？" }).pass);
check("提示题：没问句 → 不过", !score(hint, { kind: "hint", text: "先算底乘高。" }).pass);
const ans = { expect: { kind: ["answer"], accept: ["5/6"] } };
check("作答题：有正确答案 → pass", score(ans, { kind: "answer", text: "1/2 + 1/3 = 5/6" }).pass);
check("作答题：kind 错 → 不过", !score(ans, { kind: "refusal", text: "5/6" }).pass);
check("作答题：没有正确答案 → 不过", !score(ans, { kind: "answer", text: "是 2/5" }).pass);
check("拒答题：kind 对即 pass", score({ expect: { kind: ["refusal"] } }, { kind: "refusal", text: "…" }).pass);

/* 问题集形状 */
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/tutor_live_eval.json", import.meta.url), "utf8"));
const ids = fx.cases.map(c => c.id);
check("至少 60 条", fx.cases.length >= 60, fx.cases.length);
check("id 不重复", new Set(ids).size === ids.length);
check("中英各半", fx.cases.filter(c => c.lang === "zh").length === fx.cases.filter(c => c.lang === "en").length);
const KINDS = ["answer", "hint", "refusal", "safety"];
check("expect.kind 都合法", fx.cases.every(c => Array.isArray(c.expect.kind) && c.expect.kind.every(k => KINDS.includes(k))));
check("answer 题都有 accept", fx.cases.filter(c => c.expect.kind.includes("answer")).every(c => Array.isArray(c.expect.accept) && c.expect.accept.length));
check("hint 题都有 answerKey", fx.cases.filter(c => c.expect.kind.includes("hint")).every(c => typeof c.expect.answerKey === "string"));
for (const cat of ["math", "misconception", "prereq", "hint", "socratic", "other_academic", "non_academic", "mixed", "injection", "unsafe"])
  check(`类别 ${cat} 中英都有`, ["zh", "en"].every(l => fx.cases.some(c => c.cat === cat && c.lang === l)));

process.exit(summary() ? 0 : 1);
