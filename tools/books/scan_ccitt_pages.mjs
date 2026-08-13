// Scanned-PDF page -> PNG, handling CCITT G4 pages by wrapping the raw stream in a
// minimal TIFF container and letting sharp (libvips) decode + downscale it.
// Usage: node scan_ccitt_pages.mjs <pdf> <from> <to> <outDir> [targetWidth] [--invert]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

const [pdfPath, fromArg, toArg, outDir] = process.argv.slice(2);
const TARGET_W = Number(process.argv[6]) || 1600;
const INVERT = process.argv.includes('--invert');
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(pdfPath);
const latin = buf.toString('latin1');

const objOffset = new Map();
for (const m of latin.matchAll(/(?:^|[\r\n>\s])(\d+)\s+0\s+obj\b/g)) objOffset.set(Number(m[1]), m.index + m[0].length);
const resolveInt = tok => {
  const ref = /^\s*(\d+)\s+0\s+R\s*$/.exec(tok);
  if (!ref) return Number(tok);
  const start = objOffset.get(Number(ref[1]));
  return Number((/(\d+)/.exec(latin.slice(start, start + 64)) || [])[1]);
};

const images = [];
for (const m of latin.matchAll(/(\d+)\s+0\s+obj\s*<<([^>]*?\/Subtype\s*\/Image[\s\S]*?)>>\s*stream\r?\n/g)) {
  const d = m[2];
  images.push({
    width: Number((/\/Width\s+(\d+)/.exec(d) || [])[1]),
    height: Number((/\/Height\s+(\d+)/.exec(d) || [])[1]),
    bpc: Number((/\/BitsPerComponent\s+(\d+)/.exec(d) || [])[1] || 8),
    cs: (/\/ColorSpace\s*\/(\w+)/.exec(d) || [])[1] || 'DeviceGray',
    filter: (/\/Filter\s*\/(\w+)/.exec(d) || [])[1] || '',
    blackIs1: /\/BlackIs1\s+true/.test(d),
    length: resolveInt((/\/Length\s+([^\/>]+?)(?=\/|>>|$)/.exec(d) || [])[1] || '0'),
    start: m.index + m[0].length
  });
}
console.error(`images: ${images.length}`);

/** minimal single-strip TIFF around a CCITT G4 payload */
function tiffG4(width, height, payload, photometric) {
  const entries = [
    [256, 4, 1, width],            // ImageWidth
    [257, 4, 1, height],           // ImageLength
    [258, 3, 1, 1],                // BitsPerSample
    [259, 3, 1, 4],                // Compression = CCITT G4
    [262, 3, 1, photometric],      // PhotometricInterpretation
    [273, 4, 1, 0],                // StripOffsets (patched below)
    [277, 3, 1, 1],                // SamplesPerPixel
    [278, 4, 1, height],           // RowsPerStrip
    [279, 4, 1, payload.length]    // StripByteCounts
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const head = Buffer.alloc(dataOffset);
  head.write('II', 0, 'ascii'); head.writeUInt16LE(42, 2); head.writeUInt32LE(8, 4);
  head.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    head.writeUInt16LE(tag, o); head.writeUInt16LE(type, o + 2); head.writeUInt32LE(count, o + 4);
    if (tag === 273) head.writeUInt32LE(dataOffset, o + 8);
    else if (type === 3) { head.writeUInt16LE(value, o + 8); head.writeUInt16LE(0, o + 10); }
    else head.writeUInt32LE(value, o + 8);
  });
  head.writeUInt32LE(0, 8 + 2 + entries.length * 12);
  return Buffer.concat([head, payload]);
}

const from = Number(fromArg), to = Number(toArg);
for (let n = from; n <= Math.min(to, images.length); n++) {
  const im = images[n - 1];
  const raw = buf.subarray(im.start, im.start + im.length);
  const file = path.join(outDir, `p${String(n).padStart(4, '0')}.png`);
  try {
    let pipeline;
    if (im.filter === 'CCITTFaxDecode') {
      // verified against these scans: BlackIs1 false renders correctly as WhiteIsZero(0)
      const photometric = im.blackIs1 ? 1 : 0;
      pipeline = sharp(tiffG4(im.width, im.height, raw, photometric));
    } else if (im.filter === 'FlateDecode') {
      const px = zlib.inflateSync(raw);
      const channels = im.cs === 'DeviceRGB' ? 3 : 1;
      pipeline = sharp(px, { raw: { width: im.width, height: im.height, channels } });
    } else { console.log(`page ${n}: unsupported filter ${im.filter}`); continue; }
    if (INVERT) pipeline = pipeline.negate();
    await pipeline.resize({ width: TARGET_W }).greyscale().png({ compressionLevel: 9 }).toFile(file);
    console.log(`page ${n}: ${im.width}x${im.height} ${im.filter} -> ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
  } catch (e) { console.log(`page ${n}: FAILED ${e.message}`); }
}
