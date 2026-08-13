// Dump the embedded JPEG (DCTDecode) page images of a scanned PDF straight to .jpg files.
// Usage: node jpegpages.mjs <pdf> <outDir> [from] [to]
import fs from 'node:fs';
import path from 'node:path';

const [pdfPath, outDir, fromArg, toArg] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const buf = fs.readFileSync(pdfPath);
const latin = buf.toString('latin1');

const objOffset = new Map();
for (const m of latin.matchAll(/(?:^|[\r\n>\s])(\d+)\s+0\s+obj\b/g)) objOffset.set(Number(m[1]), m.index + m[0].length);
const resolveInt = tok => {
  const ref = /^\s*(\d+)\s+0\s+R\s*$/.exec(tok);
  if (!ref) return Number(tok);
  const s = objOffset.get(Number(ref[1]));
  return Number((/(\d+)/.exec(latin.slice(s, s + 64)) || [])[1]);
};

let i = 0, written = 0;
const from = Number(fromArg || 1), to = Number(toArg || 1e9);
for (const m of latin.matchAll(/(\d+)\s+0\s+obj\s*<<([^>]*?\/Subtype\s*\/Image[\s\S]*?)>>\s*stream\r?\n/g)) {
  i++;
  if (i < from || i > to) continue;
  const d = m[2];
  if (!/\/Filter\s*\/DCTDecode/.test(d)) { console.log(`page ${i}: not JPEG, skipped`); continue; }
  const len = resolveInt((/\/Length\s+([^\/>]+?)(?=\/|>>|$)/.exec(d) || [])[1] || '0');
  const start = m.index + m[0].length;
  const jpg = buf.subarray(start, start + len);
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) { console.log(`page ${i}: not a JPEG SOI, skipped`); continue; }
  fs.writeFileSync(path.join(outDir, `p${String(i).padStart(4, '0')}.jpg`), jpg);
  written++;
}
console.log(`images seen: ${i}, written: ${written} -> ${outDir}`);
