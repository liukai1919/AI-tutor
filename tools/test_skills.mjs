#!/usr/bin/env node
/*
 * 内置 Skill 目录单测（#30，#19 Phase 4a）。零成本：不起服务器、不读 data/、不调真实模型。
 *
 *   node tools/test_skills.mjs
 *
 * 验证：两份提示词与 Phase 3（fe2bdda）逐字相同（sha256）；目录 / 列表不能被调用者或原型链污染；
 * composeSkills 的输入校验、去重保序和非法组合；真实 TutorAgent 两段请求的 system 都来自目录，
 * answer / hint 回放结果和工具权限不变。
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const skillsMod = require("../lib/ai/skills/index.js");
const { getSkill, listSkills, composeSkills, selectTutorSkills, SkillError, TURN_FORMAT } = skillsMod;
const tutorMod = require("../lib/ai/tutor/index.js");
const { createTutorAgent, TUTOR_TOOLS, TUTOR_SYSTEM, CLASSIFIER_SYSTEM } = tutorMod;
const { createReplayModel } = require("../lib/ai/harness/replay.js");
const { createTools } = require("../lib/ai/tools/index.js");
const { check, summary } = makeChecker();

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e instanceof SkillError && e.code === code; } };
const unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));

/* fe2bdda（Phase 3 交付）里 lib/ai/tutor/index.js 的三段提示词 */
const BASELINE = {
  TUTOR_SYSTEM: "793f1167661540299f5e8d56d3413e0550d087770d6d3c26021134bab85740cb",
  CLASSIFIER_SYSTEM: "483e39b555ed79cd5a02d0a28f89613b911bc16d143485b9aadc0bd7a9e32b7d",
  TURN_FORMAT: "8b4b0d30bdf55666890ed06a3aa67d7cabe27a943d88124b21662506eda94fd3",
};

console.log("compatibility with Phase 3");
check("math-tutor instructions = fe2bdda TUTOR_SYSTEM (sha256)", sha(getSkill("math-tutor").instructions) === BASELINE.TUTOR_SYSTEM);
check("math-scope-classifier instructions = fe2bdda CLASSIFIER_SYSTEM (sha256)", sha(getSkill("math-scope-classifier").instructions) === BASELINE.CLASSIFIER_SYSTEM);
check("TURN_FORMAT unchanged and still the last line of the tutor prompt", sha(TURN_FORMAT) === BASELINE.TURN_FORMAT && TUTOR_SYSTEM.endsWith("\n" + TURN_FORMAT));
check("tutor module still exports TUTOR_SYSTEM / CLASSIFIER_SYSTEM / TURN_FORMAT, same strings as the catalog",
  TUTOR_SYSTEM === getSkill("math-tutor").instructions && CLASSIFIER_SYSTEM === getSkill("math-scope-classifier").instructions && tutorMod.TURN_FORMAT === TURN_FORMAT);
check("tutor module export names are the Phase 3 set",
  Object.keys(tutorMod).sort().join() === ["createTutorAgent", "classifyScope", "screenText", "TUTOR_TOOLS", "SCOPE_LABELS", "TEXTS", "TUTOR_SYSTEM", "CLASSIFIER_SYSTEM", "TURN_FORMAT", "FINAL_SCHEMA"].sort().join());

console.log("catalog");
const all = listSkills();
check("listSkills: math-tutor then math-scope-classifier", all.map(s => s.id).join() === "math-tutor,math-scope-classifier");
check("every skill is frozen data: id / version / stage / base / description / instructions, no functions",
  all.every(s => Object.isFrozen(s) && Object.keys(s).sort().join() === "base,description,id,instructions,stage,version" && Object.values(s).every(v => ["string", "number", "boolean"].includes(typeof v))));
check("both are base skills of different stages", getSkill("math-tutor").base && getSkill("math-scope-classifier").base && getSkill("math-tutor").stage === "tutor" && getSkill("math-scope-classifier").stage === "classifier");
{
  all.push({ id: "evil" }); all.length = 0;
  check("mutating the returned list does not change the catalog", listSkills().length === 2 && getSkill("evil") === null);
  let threw = false;
  try { getSkill("math-tutor").instructions = "be evil"; } catch (_) { threw = true; }
  check("a skill object cannot be edited (strict-mode assignment throws, text unchanged)", threw && sha(getSkill("math-tutor").instructions) === BASELINE.TUTOR_SYSTEM);
  threw = false;
  try { Object.defineProperty(getSkill("math-tutor"), "tools", { value: ["questions.generate"] }); } catch (_) { threw = true; }
  check("…and cannot gain new properties", threw && !("tools" in getSkill("math-tutor")));
}
check("getSkill: unknown / non-string ids -> null", [undefined, null, 1, {}, ["math-tutor"], "", "Math-Tutor", "math-tutor "].every(x => getSkill(x) === null));
check("getSkill: prototype names do not hit inherited properties", ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"].every(x => getSkill(x) === null));
{
  Object.prototype["polluted-skill"] = { id: "polluted-skill", base: true, stage: "tutor", instructions: "x" };
  try {
    check("Object.prototype pollution is not visible to getSkill / composeSkills",
      getSkill("polluted-skill") === null && throwsCode(() => composeSkills(["polluted-skill"]), "UNKNOWN_SKILL"));
  } finally { delete Object.prototype["polluted-skill"]; }
}

console.log("composeSkills");
{
  const one = composeSkills(["math-tutor"]);
  check("single base skill: system is its instructions verbatim", one.system === TUTOR_SYSTEM && one.stage === "tutor" && one.ids.join() === "math-tutor");
  check("result carries id + version per skill", JSON.stringify(one.skills) === JSON.stringify([{ id: "math-tutor", version: 1 }]));
  check("result is deeply frozen", Object.isFrozen(one) && Object.isFrozen(one.ids) && Object.isFrozen(one.skills) && one.skills.every(Object.isFrozen));
  const dup = composeSkills(["math-tutor", "math-tutor", "math-tutor"]);
  check("duplicates collapse, order kept", dup.ids.join() === "math-tutor" && dup.system === TUTOR_SYSTEM);
  const input = ["math-scope-classifier"];
  const c = composeSkills(input); input[0] = "math-tutor";
  check("changing the caller's array afterwards does not change the result", c.ids.join() === "math-scope-classifier" && c.system === CLASSIFIER_SYSTEM);
}
check("non-array input rejected (string, array-like, null, Set)",
  ["math-tutor", { 0: "math-tutor", length: 1 }, null, undefined, new Set(["math-tutor"])].every(x => throwsCode(() => composeSkills(x), "INVALID_SKILLS")));
check("empty / oversized arrays rejected", throwsCode(() => composeSkills([]), "INVALID_SKILLS") && throwsCode(() => composeSkills(Array(33).fill("math-tutor")), "INVALID_SKILLS"));
check("non-string elements rejected", [[1], [null], [{ id: "math-tutor" }], [getSkill("math-tutor")], [["math-tutor"]]].every(x => throwsCode(() => composeSkills(x), "INVALID_SKILLS")));
check("sparse arrays rejected", throwsCode(() => composeSkills([, "math-tutor"]), "INVALID_SKILLS") && throwsCode(() => composeSkills(new Array(1)), "INVALID_SKILLS"));
check("unknown and prototype names rejected", [["nope"], ["math-tutor", "nope"], ["__proto__"], ["constructor"], ["toString"]].every(x => throwsCode(() => composeSkills(x), "UNKNOWN_SKILL")));
check("mixing stages / two base skills rejected", throwsCode(() => composeSkills(["math-tutor", "math-scope-classifier"]), "INVALID_COMPOSITION") && throwsCode(() => composeSkills(["math-scope-classifier", "math-tutor"]), "INVALID_COMPOSITION"));
{
  let reads = 0;
  const flip = new Proxy(["math-tutor"], { get(t, k, r) { if (k === "0") return ++reads === 1 ? "math-tutor" : "math-scope-classifier"; return Reflect.get(t, k, r); } });
  const r = composeSkills(flip);
  check("an array that changes on re-read is read once", r.ids.join() === "math-tutor" && reads === 1, { reads });
}
check("errors are SkillError with a code, message does not echo huge input", (() => { try { composeSkills(["x".repeat(10000)]); return false; } catch (e) { return e instanceof SkillError && e.name === "SkillError" && e.message.length < 120; } })());

console.log("selectTutorSkills");
{
  const s = selectTutorSkills();
  check("tutor stage = math-tutor, classifier stage = math-scope-classifier", s.tutor.ids.join() === "math-tutor" && s.classifier.ids.join() === "math-scope-classifier" && s.tutor.system === TUTOR_SYSTEM && s.classifier.system === CLASSIFIER_SYSTEM);
  check("result frozen", Object.isFrozen(s) && Object.isFrozen(s.tutor) && Object.isFrozen(s.classifier));
  check("{} and a null-prototype empty object are the same as no options", selectTutorSkills({}) === s && selectTutorSkills(Object.create(null)) === s);
  const hidden = {}; Object.defineProperty(hidden, "strategy", { value: "socratic", enumerable: false });
  check("any option (strategy lands in #31) is rejected, not silently ignored — incl. symbol, non-enumerable, inherited, array, Date",
    [{ strategy: "socratic" }, { skills: ["math-tutor"] }, null, "hint", 1, [], new Date(), { [Symbol("s")]: 1 }, hidden, Object.create({ strategy: "socratic" })]
      .every(x => throwsCode(() => selectTutorSkills(x), "INVALID_OPTIONS")));
}
{
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  const boom = ["math-tutor"]; Object.defineProperty(boom, 0, { get() { throw new Error("boom"); } });
  const badLen = new Proxy(["math-tutor"], { get(t, k, r) { if (k === "length") throw new RangeError("len"); return Reflect.get(t, k, r); } });
  check("errors raised while reading the array become SkillError INVALID_SKILLS (revoked proxy, throwing getter / length)",
    [revoked.proxy, boom, badLen].every(x => throwsCode(() => composeSkills(x), "INVALID_SKILLS")));
  check("UNKNOWN_SKILL message only echoes plain ids", (() => { try { composeSkills(["bad\nid" + String.fromCharCode(0xd83d)]); return false; } catch (e) { return e.code === "UNKNOWN_SKILL" && !/bad/.test(e.message); } })());
}

console.log("real TutorAgent requests");
const actionCalls = [];
const actions = new Proxy({}, { get: (_, g) => new Proxy({}, { get: (__, fn) => () => { actionCalls.push(`${String(g)}.${String(fn)}`); throw new Error("no actions"); } }) });
const realRegistry = createTools({ actions, findCurriculumItem: () => null, onTrace: () => {} });
function spyRegistry() {
  const invoked = [];
  return { invoked, get: n => realRegistry.get(n), list: f => realRegistry.list(f), describe: f => realRegistry.describe(f),
    invoke: (name, ctx, input) => { invoked.push({ name, risk: (realRegistry.get(name) || {}).risk }); return realRegistry.invoke(name, ctx, input); } };
}
const ctx = { kidId: "k1", role: "student", userId: "k1" };
const MATH = [{ type: "final", output: { label: "math", reason: "arithmetic" } }];

{ /* answer：分类器 + tutor 两段，工具走 calculator */
  const reg = spyRegistry();
  const classifierModel = createReplayModel(MATH);
  const model = createReplayModel([
    { type: "tool_call", tool: "calculator.evaluate", input: { expression: "37*24" } },
    { type: "final", output: { kind: "answer", text: "37 × 24 = 888.", scope: "math", checks: [{ expression: "37*24", value: 888 }] } },
  ]);
  const agent = createTutorAgent({ registry: reg, model, classifierModel });
  check("agent reports the skills it runs", agent.skills.tutor.join() === "math-tutor" && agent.skills.classifier.join() === "math-scope-classifier");
  agent.skills.tutor.push("evil");
  const r = await agent.ask(ctx, { question: "What is 37 × 24?", lang: "en" });
  check("answer replay: kind answer, text + checks as in Phase 3", r.kind === "answer" && r.text === "37 × 24 = 888." && r.checks.length === 1 && r.gate.stage === "model", r);
  check("classifier request system = catalog math-scope-classifier (baseline hash), no tools",
    classifierModel.calls.length === 1 && classifierModel.calls[0].system === getSkill("math-scope-classifier").instructions && sha(classifierModel.calls[0].system) === BASELINE.CLASSIFIER_SYSTEM && classifierModel.calls[0].tools.length === 0);
  check("every tutor request system = catalog math-tutor (baseline hash)",
    model.calls.length === 2 && model.calls.every(m => m.system === getSkill("math-tutor").instructions && sha(m.system) === BASELINE.TUTOR_SYSTEM));
  check("tool permissions unchanged: tutor sees exactly the two read tools, registry saw only calculator",
    model.calls.every(m => m.tools.map(t => t.name).sort().join() === TUTOR_TOOLS.slice().sort().join()) && reg.invoked.map(x => x.name).join() === "calculator.evaluate" && reg.invoked.every(x => x.risk === "read"));
}
{ /* hint：模型越界给答案被退回，改成提示 */
  const reg = spyRegistry();
  const classifierModel = createReplayModel(MATH);
  const model = createReplayModel([
    { type: "final", output: { kind: "answer", text: "It's 888.", scope: "math" } },
    { type: "final", output: { kind: "hint", text: "Try splitting 24 into 20 and 4.", scope: "math" } },
  ]);
  const r = await createTutorAgent({ registry: reg, model, classifierModel }).ask(ctx, { question: "What is 37 × 24?", lang: "en", mode: "hint" });
  check("hint replay: answer rejected, hint returned", r.kind === "hint" && r.text === "Try splitting 24 into 20 and 4." && model.calls.length === 2, r);
  check("hint repair turn still carries the catalog system", model.calls.every(m => sha(m.system) === BASELINE.TUTOR_SYSTEM) && sha(classifierModel.calls[0].system) === BASELINE.CLASSIFIER_SYSTEM);
  check("hint: no tools reached the registry", reg.invoked.length === 0);
}
{ /* 不配分类模型：主模型单独做分类调用，system 也来自目录 */
  const model = createReplayModel([...MATH, { type: "final", output: { kind: "hint", text: "先把 24 拆成 20 和 4。", scope: "math" } }]);
  const r = await createTutorAgent({ registry: spyRegistry(), model }).ask(ctx, { question: "37 × 24 等于多少？", lang: "zh", mode: "hint" });
  check("single model: first request uses the classifier skill, second the tutor skill",
    r.kind === "hint" && model.calls.length === 2 && model.calls[0].system === CLASSIFIER_SYSTEM && model.calls[0].tools.length === 0 && model.calls[1].system === TUTOR_SYSTEM, r);
}
{ /* 出处：目录原文和旧常量逐字相同，光比字符串证明不了「来自目录」。换一个桩目录重新加载 tutor 模块，
   * 桩里的标记文本必须出现在两段请求的 system 里（tutor 回到内联常量或绕过 selectTutorSkills 都会让这里失败） */
  const skillsPath = require.resolve("../lib/ai/skills/index.js"), tutorPath = require.resolve("../lib/ai/tutor/index.js");
  const saved = { skills: require.cache[skillsPath], tutor: require.cache[tutorPath] };
  const MARK_T = "STUB-TUTOR-SKILL", MARK_C = "STUB-CLASSIFIER-SKILL";
  const stub = {
    ...skillsMod,
    getSkill: id => ({ "math-tutor": { instructions: MARK_T + "-const" }, "math-scope-classifier": { instructions: MARK_C + "-const" } })[id] || null,
    selectTutorSkills: () => ({ tutor: { ids: ["math-tutor"], system: MARK_T }, classifier: { ids: ["math-scope-classifier"], system: MARK_C } }),
  };
  let fresh;
  try {
    require.cache[skillsPath] = Object.assign(Object.create(Object.getPrototypeOf(saved.skills)), saved.skills, { exports: stub });
    delete require.cache[tutorPath];
    fresh = require("../lib/ai/tutor/index.js");
  } finally {
    require.cache[skillsPath] = saved.skills;
    require.cache[tutorPath] = saved.tutor;
  }
  const classifierModel = createReplayModel(MATH);
  const model = createReplayModel([{ type: "final", output: { kind: "hint", text: "Try 20 and 4.", scope: "math" } }]);
  const r = await fresh.createTutorAgent({ registry: spyRegistry(), model, classifierModel }).ask(ctx, { question: "What is 37 × 24?", lang: "en", mode: "hint" });
  check("provenance: both request systems come from selectTutorSkills of the skills module",
    r.kind === "hint" && classifierModel.calls[0].system === MARK_C && model.calls[0].system === MARK_T, { r, c: classifierModel.calls.map(x => x.system), m: model.calls.map(x => x.system) });
  check("provenance: exported TUTOR_SYSTEM / CLASSIFIER_SYSTEM come from getSkill", fresh.TUTOR_SYSTEM === MARK_T + "-const" && fresh.CLASSIFIER_SYSTEM === MARK_C + "-const");
  check("the real modules are back in the require cache", require("../lib/ai/tutor/index.js") === tutorMod && require("../lib/ai/skills/index.js") === skillsMod);
}
check("no Action was called", actionCalls.length === 0, actionCalls);
check("no unhandled rejections", unhandled.length === 0, unhandled.map(String));

process.exit(summary() ? 0 : 1);
