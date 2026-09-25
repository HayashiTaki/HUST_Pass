import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('.cache', {recursive:true}); await mkdir('test-results',{recursive:true});
const extension=resolve('dist');
const ctx=await chromium.launchPersistentContext(await mkdtemp(resolve('.cache/edge-live-')),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
try {
  // Read-only live smoke. No existing browser profile or credentials are loaded.
  await ctx.route('https://pass.hust.edu.cn/**',route => route.request().method()==='POST' ? route.abort() : route.continue());
  const page=await ctx.newPage();
  const records=[];
  for(const url of ['https://pass.hust.edu.cn/cas/login','https://pass.hust.edu.cn/cas/login?service=https%3A%2F%2Fpass.hust.edu.cn%2Fcas%2Foauth2.0%2Fauthorize%3Fclient_id%3DHustSmartEdu0417%26redirect_uri%3Dhttps%253A%252F%252Fsmartcourse.hust.edu.cn%252Fsso%252Flogin%252F3rd%253Fwfwfid%253D1731%2526refer%253Dhttps%253A%252F%252Fsmartcourse.hust.edu.cn%2526response_type%253Dcode']) {
    await page.goto(url,{waitUntil:'domcontentloaded'});
    await page.waitForSelector('#hust-pass-status');
    await page.waitForFunction(()=>document.querySelector('#codeImage')?.naturalWidth>0);
    const record=await page.evaluate(()=>({path:location.pathname,hasService:new URL(location.href).searchParams.has('service'),
      fields:['un','pd','code','codeImage','index_login_btn'].map(id=>({id,exists:!!document.getElementById(id)})),
      credentialsPresent:!!document.querySelector('#un')?.value && !!document.querySelector('#pd')?.value,
      captchaEmpty:document.querySelector('#code')?.value==='',imageWidth:document.querySelector('#codeImage')?.naturalWidth,
      status:document.querySelector('#hust-pass-status')?.textContent}));
    assert.ok(record.fields.every(f=>f.exists)); assert.equal(record.captchaEmpty,true); assert.equal(record.credentialsPresent,false);
    records.push(record);
  }
  await writeFile('test-results/live-smoke.json',JSON.stringify({browser:ctx.browser()?.version(),mode:'Isolated profile, all POST requests blocked; no authenticated login',records},null,2));
  console.log(JSON.stringify(records));
}finally{await ctx.close();}
