#!/usr/bin/env node
/*
 * 低年级（G1–G3）出题规则（#74）：6–9 岁的孩子用单独的难度口径和阅读量规则，G4 以上一字不变。
 *
 *   node tools/test_qbank_primary.mjs
 *
 * 纯模块部分直接 require lib/ai/qbank/brief.js；提示词部分进程内加载 server.js（隔离临时 DATA_ROOT，见 tools/lib/inproc_server.mjs），
 * 课程 / 技能图谱读仓库里已跟踪的文件。不调任何模型，不读真实 config / qbank / 孩子数据。
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
import { loadIsolatedServer } from "./lib/inproc_server.mjs";

const require = createRequire(import.meta.url);
const B = require("../lib/ai/qbank/brief.js");
const { check, summary } = makeChecker();

/* ---------- 纯模块：按年级选规则 ---------- */
const CONTRACT = { path: "c.json", raw: JSON.stringify({ version: 3, types: { fractionBar: { nums: "x", check: [] } }, capabilities: { questionVisual: { types: ["fractionBar"] } } }) };
const skillIn = g => ({
  item: { id: "YY.MATH.TEST.SKILL", en: "Test skill", strand: "t", skill: { type: "concept", rep: ["fractionBar", "symbolic"], primary: "BC.MATH.G4.NUM.03", standardEn: "ordering and comparing fractions",
    prereq: [{ id: "YY.MATH.P", en: "pre", grade: g }], misc: [{ id: "m.a", en: "A", pattern: "p", remedy: "YY.MATH.P" }] } },
  context: { kind: "skill", grade: g, topic: { id: "t", en: "T" } }, skillType: { en: "concept", teachEn: "focus" }, dependents: [],
  visualContract: CONTRACT, lesson: { path: "l.json", missing: true }
});
const stdIn = (g, kind = "standard") => ({
  item: { id: "BC.MATH.GX.NUM.01", en: "number concepts", strand: "number", elaborations: [{ en: "counting" }], terms: [{ en: "count" }] },
  context: { kind, grade: g, topic: { id: "number", en: "Number" } }, visualContract: null, lesson: null
});

/* G4 以上的 brief 和改动之前逐字节一样：这两个哈希是 #74 动 brief.js 之前用同样的输入录下的 */
check("G4 skill brief hash unchanged", B.buildTeachingBrief(skillIn(4)).briefHash === "4b391698ebba4031f5f599d2be143108d88b5a98b84f0cec31f6ca81187bbc79");
check("G4 standard brief hash unchanged", B.buildTeachingBrief(stdIn(4)).briefHash === "efa6f325f22410cfdea26da3ebbebe41108a541b3c0a1044f15174747d24e75d");
for (const g of [4, 5, 7, 9, 10, null]) {
  const b = B.buildTeachingBrief(skillIn(g));
  check(`grade ${g}: default rules`, b.rules.version === B.DEFAULT_RULES.version && b.rules.young === undefined && b.rules.l3SpotMistakeMax === 2);
  check(`grade ${g}: no young-learner block`, !/Young learners/.test(B.renderGeneratorBrief(b)) && !/Young learners/.test(B.renderJudgeBrief(b)));
}
for (const g of [1, 2, 3]) {
  for (const [name, input] of [["skill", skillIn(g)], ["standard", stdIn(g)]]) {
    const b = B.buildTeachingBrief(input);
    check(`grade ${g} ${name}: primary rules`, b.rules.version === B.PRIMARY_RULES.version && Array.isArray(b.rules.young) && b.rules.young.length === B.PRIMARY_RULES.young.length && b.rules.l3SpotMistakeMax === 1);
    const gen = B.renderGeneratorBrief(b), judge = B.renderJudgeBrief(b);
    check(`grade ${g} ${name}: generator and judge print the same young-learner rules`,
      gen.includes(`Young learners (Grade ${g})`) && judge.includes(`Young learners (Grade ${g})`) && b.rules.young.every(r => gen.includes("- " + r) && judge.includes("- " + r)));
    check(`grade ${g} ${name}: primary level wording, no FSA`, gen.includes(B.PRIMARY_RULES.levels[3]) && !/FSA/.test(gen) && !/FSA/.test(judge));
    check(`grade ${g} ${name}: picture rules are the shared text`, JSON.stringify(b.rules.visual) === JSON.stringify(B.DEFAULT_RULES.visual) && b.rules.textOnly === B.DEFAULT_RULES.textOnly);
  }
}
/* 书 / 分科课程按对标年级折算，不算低年级条目 */
check("book at grade 3 keeps default rules", B.buildTeachingBrief(stdIn(3, "book")).rules.version === B.DEFAULT_RULES.version);
check("course at grade 2 keeps default rules", B.buildTeachingBrief(stdIn(2, "course")).rules.version === B.DEFAULT_RULES.version);
/* 显式传 rules 仍然压过按年级选 */
check("explicit rules override the grade choice", B.buildTeachingBrief(Object.assign(skillIn(1), { rules: B.DEFAULT_RULES })).rules.version === B.DEFAULT_RULES.version);
check("different rules → different brief", B.buildTeachingBrief(skillIn(1)).briefHash !== B.buildTeachingBrief(Object.assign(skillIn(1), { rules: B.DEFAULT_RULES })).briefHash);

/* ---------- server.js：真实课程数据上的提示词 ---------- */
const srv = loadIsolatedServer("qbank-primary");
const S = srv.S;
try {
  const NEEDS = { 1: 4, 2: 4, 3: 4 };
  const find = id => { const f = S.findCurriculumItem(id); if (!f) throw new Error("item missing from tracked curriculum: " + id); return f; };
  const skillsView = g => S.curriculum.get("skills-g" + g);
  check("curriculum has grades 1-3", [1, 2, 3].every(g => S.curriculumGrades().includes(g) && skillsView(g) && skillsView(g).items.length > 0));

  for (const g of [1, 2, 3]) {
    const data = skillsView(g), item = data.items[0];
    const brief = S.qbankBriefFor(item, data);
    check(`G${g} skill brief uses primary rules`, brief.rules.version === B.PRIMARY_RULES.version && brief.item.grade === g);
    const en = S.qbankPrompt(item, data, "en", NEEDS, [], brief);
    check(`G${g} en prompt: young-learner block + primary distractor hint`, en.includes(`Young learners (Grade ${g})`) && en.includes("how many more") && !en.includes("perimeter and area") && !/FSA/.test(en));
    check(`G${g} en prompt: rule 8 agrees with the brief on Level 3`, en.includes(`At most 1 of the Level-3 questions may be that "spot the mistake" type; the rest follow the Level 3 description above.`) && !en.includes("must be real two-step scenarios"));
    const zh = S.qbankPrompt(item, data, "zh", NEEDS, []);
    check(`G${g} zh prompt: 低年级规则 + 低年级难度口径`, zh.includes("低年级规则") && zh.includes(`才上 Grade ${g}`) && zh.includes("数很小的两步小故事") && !zh.includes("FSA") && !zh.includes("周长面积混淆"));
    const jEn = S.judgeQuizPrompt(item, data, [], "en", brief), jZh = S.judgeQuizPrompt(item, data, [], "zh");
    check(`G${g} judge prompts carry the age check`, jEn.includes(`Young learners (Grade ${g})`) && jEn.includes("6 to 9 years old") && jZh.includes("6-9 岁") && jZh.includes("算超纲"));
    const bc = S.curriculum.get(g), bcItem = bc.items[0];
    const zhBc = S.qbankPrompt(bcItem, bc, "zh", NEEDS, []);
    check(`G${g} standard item zh prompt is also primary`, zhBc.includes("低年级规则") && !zhBc.includes("FSA"));
    const teachZh = S.systemPromptTeach(item, data, "", "zh"), teachEn = S.systemPromptTeach(item, data, "", "en");
    check(`G${g} lesson tone is the primary tier`, teachZh.includes("小学低年级老师") && teachZh.includes("孩子才上") && teachEn.includes("primary school teacher") && teachEn.includes(`only in Grade ${g}`));
  }

  /* G4 以上：原话术原样（逐字节冻结由 tools/test_qbank_zh_freeze.mjs 守，这里只确认没有混进低年级段落） */
  for (const id of ["YY.MATH.FRAC.EQUIV.VISUAL", "BC.MATH.G4.NUM.01"]) {
    const f = find(id);
    const zh = S.qbankPrompt(f.item, f.data, "zh", NEEDS, []);
    const en = S.qbankPrompt(f.item, f.data, "en", NEEDS, []);
    check(`${id}: no primary wording`, !zh.includes("低年级规则") && zh.includes("FSA 风格") && zh.includes("周长面积混淆") && !en.includes("Young learners") && en.includes("FSA-style")
      && en.includes(`At most 2 of the Level-3 questions may be that "spot the mistake" type; the rest must be real two-step scenarios.`));
    const j = S.judgeQuizPrompt(f.item, f.data, [], "zh") + S.judgeLessonPrompt(f.item, f.data, { steps: [] }, "en");
    check(`${id}: judge has no age paragraph`, !j.includes("6-9 岁") && !j.includes("6 to 9 years old"));
  }
  /* 书籍对标年级再低也不是低年级条目（目前没有这样的书，合成一本） */
  const fakeBook = { type: "book", bookId: "fake", grade: 3, title: { en: "Fake", zh: "假书" }, strandDefs: [["c1", "第一章", "Chapter 1"]], items: [] };
  const fakeItem = { id: "FAKE.C01.S01", strand: "c1", en: "Counting", zh: "数数", elaborations: [] };
  check("book at grade 3: zh prompt stays on the default wording", !S.qbankPrompt(fakeItem, fakeBook, "zh", NEEDS, []).includes("低年级规则"));
} finally { srv.cleanup(); }

summary();
