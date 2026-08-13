// 书籍正文提取（构建期工具，运行期不依赖）：
//   按书籍 JSON 里每个条目的 pages 范围，从 PDF 提取该节正文文本，
//   写到 data/curriculum/books/text/<bookId>/<itemId>.txt。
//   server.js 讲课时若发现该文件，会把它作为参考资料附进提示词（讲解仍要求原创）。
//
// 用法（先在本目录 npm install 装 pdfjs-dist，node_modules 已被 gitignore）：
//   node extract_text.mjs <书籍JSON> <PDF路径> <offset>
//   offset = 书页码转 PDF 页码的偏移（PDF页 = 书页 + offset），
//   校准方法：找到书第 1 页（第一章开头）在 PDF 里的页号减 1。
// 例：node extract_text.mjs ../../data/curriculum/books/aops-prealgebra.json ../../books/aops-prealgebra.pdf 20
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [jsonPath, pdfPath, offsetArg] = process.argv.slice(2);
if (!jsonPath || !pdfPath || offsetArg === undefined) {
  console.error('用法: node extract_text.mjs <书籍JSON> <PDF路径> <offset>');
  process.exit(1);
}
const offset = Number(offsetArg);
const book = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const outDir = path.join(path.dirname(path.resolve(jsonPath)), 'text', book.bookId);
fs.mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await getDocument({ data, useSystemFonts: true }).promise;

async function pageText(n) {
  if (n < 1 || n > doc.numPages) return '';
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  let out = '';
  let lastY = null;
  for (const item of tc.items) {
    if (!('str' in item)) continue;
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) out += '\n';
    else if (out && !out.endsWith(' ') && item.str && !item.str.startsWith(' ')) out += ' ';
    out += item.str;
    lastY = y;
  }
  return out.trim();
}

let done = 0;
for (const it of book.items) {
  const [from, to] = it.pages || [];
  if (!from) { console.log(`skip ${it.id} (no pages)`); continue; }
  const parts = [];
  for (let p = from; p <= (to || from); p++) parts.push(await pageText(p + offset));
  const header = `[${book.bookId} ${it.id}] ${it.en} — book pages ${from}-${to || from} (OCR text, may contain noise)\n\n`;
  fs.writeFileSync(path.join(outDir, it.id + '.txt'), header + parts.join('\n\n'), 'utf8');
  done++;
  if (done % 20 === 0) console.log(`${done}/${book.items.length}...`);
}
console.log(`done: ${done} sections -> ${outDir}`);
