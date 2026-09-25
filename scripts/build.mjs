import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('dist/vendor/core', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['src/content.ts', 'src/background.ts', 'src/offscreen.ts', 'src/popup.ts'],
  outdir: 'dist', bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', legalComments: 'eof' });
await cp('node_modules/tesseract.js/dist/worker.min.js', 'dist/vendor/worker.min.js');
for (const file of await readdir('node_modules/tesseract.js-core')) {
  if (/^tesseract-core.*\.wasm(\.js)?$/.test(file)) await cp(resolve('node_modules/tesseract.js-core',file), resolve('dist/vendor/core',file));
}
await mkdir('dist/vendor/lang', { recursive: true });
await cp('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'dist/vendor/lang/eng.traineddata.gz');
const dependencies = ['tesseract.js','tesseract.js-core','gifuct-js','js-binary-schema-parser','@tesseract.js-data/eng'];
let notices = 'Third-party packages bundled in this extension\n\n';
for (const name of dependencies) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  notices += `${name} ${pkg.version} — ${pkg.license}\n`;
  const files = await readdir(`node_modules/${name}`);
  for (const file of files.filter(f => /^(licen[cs]e|copying|notice)/i.test(f))) {
    notices += await readFile(`node_modules/${name}/${file}`, 'utf8') + '\n';
  }
  notices += '\n';
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices);
console.log('Built extension: dist/ (OCR worker, WASM and language model are bundled locally)');
