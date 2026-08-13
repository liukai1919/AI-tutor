// Probe a PDF: page count, page sizes, text presence, embedded image inventory.
// textItems=0 on every sampled page means it is a scan — see README for what to run next.
// Usage: node probe_pdf.mjs <pdf>
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const [pdfPath] = process.argv.slice(2);
const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
console.log('pages:', doc.numPages);
const meta = await doc.getMetadata().catch(() => null);
if (meta) console.log('info:', JSON.stringify(meta.info));

for (const n of [1, 10, 30, 200, 600, 1000]) {
  if (n > doc.numPages) continue;
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const ops = await page.getOperatorList();
  let imgs = 0;
  for (const op of ops.fnArray) {
    if (op === OPS.paintImageXObject || op === OPS.paintJpegXObject || op === OPS.paintImageMaskXObject) imgs++;
  }
  console.log(`page ${n}: ${Math.round(vp.width)}x${Math.round(vp.height)}pt | textItems=${tc.items.length} | imageOps=${imgs}`);
}
