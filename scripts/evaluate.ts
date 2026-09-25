import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWorker, PSM } from 'tesseract.js';
import { PNG } from 'pngjs';
import { prepareImages, decide } from '../src/image.ts';
const split = process.argv[2] ?? 'dev';
const labels = JSON.parse(await readFile('tests/fixtures/labels.json', 'utf8')) as Record<string, string>;
const worker = await createWorker('eng', 1, {
  langPath: resolve('node_modules/@tesseract.js-data/eng/4.0.0_best_int'),
  cachePath: resolve('.cache'), logger: () => {},
});
await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE, user_defined_dpi: '300' });
const rows = [];
try {
  for (const [id, expected] of Object.entries(labels)) {
    if (split === 'dev' ? Number(id) >= 40 : Number(id) < 40) continue;
    const start = performance.now();
    const rasters = prepareImages(await readFile(`tests/fixtures/captcha/${id}.gif`));
    const candidates = [];
    for (const raster of rasters) {
      const png = new PNG({ width: raster.width, height: raster.height }); png.data = Buffer.from(raster.data);
      const { data } = await worker.recognize(PNG.sync.write(png));
      candidates.push({ text: data.text.trim(), confidence: data.confidence });
    }
    const result = decide(candidates);
    const row = { id, expected, ...result, candidates, ms: Math.round(performance.now()-start) };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally { await worker.terminate(); }
const correct = rows.filter(r => r.code === r.expected).length;
const rejected = rows.filter(r => r.code === null).length;
const summary = { split, total: rows.length, correct, rejected, incorrect: rows.length-correct-rejected,
  accuracy: correct/rows.length, meanMs: Math.round(rows.reduce((s,r)=>s+r.ms,0)/rows.length) };
await mkdir('test-results', { recursive: true });
await writeFile(`test-results/ocr-${split}.json`, JSON.stringify({ summary, rows }, null, 2));
console.log(summary);
