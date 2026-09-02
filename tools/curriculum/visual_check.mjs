#!/usr/bin/env node
/* 课程配图的 preflight —— 内容入库前 / CI 门禁跑这个。
 *
 *   node tools/curriculum/visual_check.mjs                     # 扫 data/lessons/{zh,en}
 *   node tools/curriculum/visual_check.mjs --dir build/apple-export/lessons
 *   node tools/curriculum/visual_check.mjs --json              # 机器可读
 *   node tools/curriculum/visual_check.mjs --no-caption        # 只查图形合法性，不查空 caption
 *
 * 违约退出码 1，逐条打印「哪节课 哪一步 哪条规则」。
 * 契约本体：data/curriculum/visual-contract.json（唯一事实源）
 * 规则实现：public/visual-check.js（浏览器端 renderVisual 用的是同一个文件，不存在两套判断）
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACT = path.join(ROOT, "data", "curriculum", "visual-contract.json");
const { checkVisual } = createRequire(import.meta.url)(path.join(ROOT, "public", "visual-check.js"));

export { checkVisual };
export function loadContract(file) { return JSON.parse(fs.readFileSync(file || CONTRACT, "utf8")); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, def) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : def; };
  const asJson = argv.includes("--json"), skipCap = argv.includes("--no-caption");
  const dir = path.resolve(ROOT, opt("dir", path.join("data", "lessons")));
  const contract = loadContract(opt("contract"));

  const findings = [];
  let steps = 0, withVisual = 0, files = 0;
  for (const lang of fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, lang)).filter(x => x.endsWith(".json"))) {
      files++;
      const j = JSON.parse(fs.readFileSync(path.join(dir, lang, f), "utf8"));
      (j.lesson?.steps || j.steps || []).forEach((s, i) => {
        steps++;
        const v = s.visual || {};
        if (!v.type || v.type === "none") return;
        withVisual++;
        const add = why => findings.push({ lang, lesson: f.replace(/\.json$/, ""), step: i, type: v.type, nums: v.nums || [], why });
        const r = checkVisual(contract, v.type, v.nums, v.labels);
        if (!r.ok) add(r.why);
        else if (!skipCap && !String(v.caption || "").trim()) add("有图但 caption 为空——看图模式下这一步没有任何文字");
      });
    }
  }

  if (asJson) console.log(JSON.stringify({ contract: contract.version, files, steps, withVisual, findings }, null, 1));
  else {
    console.log(`契约 v${contract.version} · 扫了 ${files} 个课程文件 / ${steps} 步（其中 ${withVisual} 步有图）`);
    if (!findings.length) console.log("✓ 零违约");
    else {
      console.log(`✗ ${findings.length} 处违约：`);
      for (const f of findings) console.log(`  ${f.lang} ${f.lesson} #${f.step} ${f.type} [${f.nums.join(",")}] —— ${f.why}`);
    }
  }
  process.exit(findings.length ? 1 : 0);
}
