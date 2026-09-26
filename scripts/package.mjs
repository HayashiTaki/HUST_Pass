import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';

const pkg=JSON.parse(await readFile('package.json','utf8'));
const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
if(pkg.version!==manifest.version) throw new Error('Package and manifest versions differ; run npm run build.');
await cp('README.md','dist/README.md');
const files={};
async function collect(directory,prefix='') {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const name=prefix+entry.name;
    if(entry.isDirectory()) await collect(join(directory,entry.name),name+'/');
    else if(entry.isFile()) files[name]=new Uint8Array(await readFile(join(directory,entry.name)));
  }
}
await collect('dist');
const archive=zipSync(files,{level:6});
// Verify every byte before delivering an installable artifact.
const unpacked=unzipSync(archive);
for(const [name,bytes] of Object.entries(files)) {
  if(!Buffer.from(bytes).equals(Buffer.from(unpacked[name] ?? []))) throw new Error(`ZIP verification failed: ${name}`);
}
await mkdir('release',{recursive:true});
const name=`hust-pass-assistant-v${pkg.version}.zip`;
await writeFile(`release/${name}`,archive);
const hash=createHash('sha256').update(archive).digest('hex');
await writeFile(`release/${name}.sha256`,`${hash}  ${name}\n`);
console.log(`Release: release/${name}\nFiles verified: ${Object.keys(files).length}\nBytes: ${archive.length}\nSHA256: ${hash}`);
