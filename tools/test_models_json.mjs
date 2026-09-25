#!/usr/bin/env node
/*
 * lib/ai/models/json.js 的单元测试（#22）。不起服务器、不调引擎。
 *
 *   node tools/test_models_json.mjs
 *
 * 每一条都是 pregen / 出题跑批时真撞到过的模型输出毛病（见 repairJson 注释和
 * memory 里的「Ollama 批量出题教训」），钉住之后 Phase 8 换 Provider 实现也不能退化。
 */
import { createRequire } from "node:module";
import { makeChecker } from "./lib/isolated_server.mjs";
const require = createRequire(import.meta.url);
const { repairJson, extractJson } = require("../lib/ai/models/json.js");
const { check, summary } = makeChecker();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } };

console.log("extractJson: locating the JSON");
check("plain object", same(extractJson('{"a":1}'), { a: 1 }));
check("prose before and after", same(extractJson('Sure! Here it is:\n{"a":1}\nHope that helps.'), { a: 1 }));
check("```json fence", same(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] }));
check("bare ``` fence", same(extractJson('```\n{"a":1}\n```'), { a: 1 }));
check("top-level array is kept whole (not the first object inside)", same(extractJson('x [{"a":1},{"a":2}] y'), [{ a: 1 }, { a: 2 }]));
check("object first, array later -> object", same(extractJson('{"a":[1]} [2]'), { a: [1] }));
check("array first, object later -> array", same(extractJson('[1] {"a":2}'), [1]));
check("empty -> throws 引擎没有返回内容", throwsWith(() => extractJson(""), /引擎没有返回内容/) && throwsWith(() => extractJson(null), /引擎没有返回内容/));
check("no braces -> throws 找不到 JSON", throwsWith(() => extractJson("just words"), /找不到 JSON/));
check("unrepairable -> rethrows the original parse error", throwsWith(() => extractJson('{"a":}'), /JSON|token|Unexpected/i));

console.log("repairJson: the qwen / CLI failure modes");
check("unescaped quotes inside a Chinese string", same(extractJson('{"say":"老师说"先看个位"再看十位"}'), { say: '老师说"先看个位"再看十位' }));
check("bare newline inside a string", same(extractJson('{"say":"第一行\n第二行"}'), { say: "第一行\n第二行" }));
check("stray quote after a number value", same(extractJson('{"level":2","answerIndex":1"}'), { level: 2, answerIndex: 1 }));
check("stray quote after a string value in an array", same(extractJson('{"tags":["ok","other"","ok"]}'), { tags: ["ok", "other", "ok"] }));
check("stray quote after the last string value", same(extractJson('{"explain":"因为进位""}'), { explain: "因为进位" }));
check("repairJson doubles LaTeX \\frac (f followed by a letter)", same(JSON.parse(repairJson('{"math":"\\frac{1}{2}"}')), { math: "\\frac{1}{2}" }));
check("repairJson doubles \\times and \\begin (t/b followed by a letter)", same(JSON.parse(repairJson('{"math":"3 \\times 4 \\begin{x}"}')), { math: "3 \\times 4 \\begin{x}" }));
/* 已知怪癖（审计 §3）：\f \t \b \n \r 本身是合法 JSON 转义，所以 {"math":"\frac"} 这种单反斜杠的 LaTeX
 * 在其它部分都合法时 JSON.parse 会「成功」，把 \f 吃成换页符，根本走不到 repairJson。这里把现状钉住，修的时候改这条。 */
check("quirk: single-backslash \\frac in otherwise-valid JSON parses as a form feed (never repaired)", extractJson('{"math":"\\frac12"}').math === "\frac12");
check("illegal escape \\( becomes a literal backslash", same(extractJson('{"math":"\\(x\\)"}'), { math: "\\(x\\)" }));
check("valid \\n escape stays a newline", same(extractJson('{"say":"a\\nb"}'), { say: "a\nb" }));
check("\\u sequence kept", same(extractJson('{"s":"\\u4e2d"}'), { s: "中" }));
check("tab inside string escaped, CR dropped", same(extractJson('{"s":"a\tb\rc"}'), { s: "a\tbc" }));
check("empty string value untouched", same(extractJson('{"s":"","t":""}'), { s: "", t: "" }));
check("valid JSON passes through repairJson unchanged", repairJson('{"a":"b","c":[1,2],"d":{"e":null}}') === '{"a":"b","c":[1,2],"d":{"e":null}}');

process.exit(summary() ? 0 : 1);
