import { chromium } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

await mkdir('.cache', {recursive:true}); await mkdir('test-results', {recursive:true});
const extension=resolve('dist');
const context=await chromium.launchPersistentContext(await mkdtemp(resolve('.cache/edge-autofill-')), {
  channel:'msedge', headless:true, args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const results=[];
let page, worker;
try {
  worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).hostname;
  await worker.evaluate(()=>{
    globalThis.activationStats={attach:0,detach:0,commands:[]};globalThis.activationTestMode='normal';
    const attach=chrome.debugger.attach.bind(chrome.debugger),detach=chrome.debugger.detach.bind(chrome.debugger),command=chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.attach=async(...args)=>{
      globalThis.activationStats.attach++;
      if(globalThis.activationTestMode==='denied') throw new Error('Cannot attach to this target');
      if(globalThis.activationTestMode==='slow') await new Promise(r=>setTimeout(r,1500));
      return attach(...args);
    };
    chrome.debugger.detach=async(...args)=>{globalThis.activationStats.detach++;return detach(...args);};
    chrome.debugger.sendCommand=async(...args)=>{globalThis.activationStats.commands.push({method:args[1],type:args[2]?.type});
      if(globalThis.activationTestMode==='release-slow' && args[2]?.type==='mouseReleased') await new Promise(r=>setTimeout(r,400));
      return command(...args);
    };
  });
  let materialize=true, captureTarget='';
  const html=()=>`<!doctype html><meta charset="utf-8"><style>input {width:180px;height:32px;margin:8px} input:autofill {outline:2px solid green}</style>
    <div id="loginPanel"><input id="un" placeholder="测试学号预览"><input id="pd" type="password" placeholder="测试密码预览"><input id="code"><img id="codeImage" src="/cas/code"><button id="index_login_btn">登录</button><div id="errormsg"></div></div><button id="manual" type="button">手动操作</button>
    <script>window.clicks=0;window.trustedDown=0;window.trustedUp=0;window.gestureEvents=[];
    for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,e=>window.gestureEvents.push({type,target:e.target.id||e.target.tagName,trusted:e.isTrusted}),true);
    document.querySelector('#code').addEventListener('pointerdown',e=>{if('${captureTarget}')document.querySelector('${captureTarget || 'body'}').setPointerCapture(e.pointerId);});
    document.querySelector('#index_login_btn').onclick=()=>window.clicks++;
    document.querySelector('#code').addEventListener('mousedown',e=>{if(e.isTrusted){window.trustedDown++;${materialize ? `document.querySelector('#un').value='test-only';document.querySelector('#pd').value='dummy-password';document.querySelector('#un').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#pd').dispatchEvent(new Event('input',{bubbles:true}));` : ''}}});
    document.querySelector('#code').addEventListener('mouseup',e=>{if(e.isTrusted)window.trustedUp++;});</script>`;
  await context.route('https://pass.hust.edu.cn/**',route=>new URL(route.request().url()).pathname==='/cas/code'
    ? readFile('tests/fixtures/captcha/000.gif').then(body=>route.fulfill({contentType:'image/jpeg',body}))
    : route.fulfill({contentType:'text/html',body:html()}));
  await context.route(/^https?:\/\/(?!pass\.hust\.edu\.cn(?:\/|$))/,route=>route.abort());
  page=await context.newPage();
  const cdp=await context.newCDPSession(page);
  await cdp.send('DOM.enable');await cdp.send('CSS.enable');
  const reset=async(mode='normal')=>{
    await page.goto('about:blank');await page.waitForTimeout(200);
    await worker.evaluate(async(mode)=>{await chrome.storage.session.clear();globalThis.activationStats={attach:0,detach:0,commands:[]};globalThis.activationTestMode=mode;},mode);
    await page.goto('https://pass.hust.edu.cn/cas/login?service=https%3A%2F%2Fexample.invalid');await page.bringToFront();await page.waitForSelector('#hust-pass-status');
  };
  const preview=async()=>{
    const {root}=await cdp.send('DOM.getDocument');
    for(const selector of ['#un','#pd']) {
      const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});
      await cdp.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['autofill']});
    }
    assert.equal(await page.evaluate(()=>document.querySelector('#un').value==='' && document.querySelector('#pd').value==='' && document.querySelector('#pd').matches(':autofill')),true);
  };
  const stats=()=>worker.evaluate(()=>globalThis.activationStats);
  const passed=name=>{results.push({name,passed:true});console.log('PASS',name);};

  await reset();await page.waitForTimeout(1600);
  assert.equal((await stats()).attach,0);assert.equal(await page.evaluate(()=>window.clicks),0);
  passed('Truly empty fields neither attach nor submit');
  await page.evaluate(()=>document.querySelector('#code').click());
  assert.equal(await page.evaluate(()=>document.querySelector('#pd').value), '');
  await preview();
  await page.waitForFunction(()=>window.clicks===1,null,{timeout:20000});
  assert.equal(await page.inputValue('#code'),'0800');
  assert.deepEqual(await page.evaluate(()=>[window.trustedDown,window.trustedUp]),[1,1]);
  assert.deepEqual(await stats(),{attach:1,detach:1,commands:[{method:'Input.dispatchMouseEvent',type:'mousePressed'},{method:'Input.dispatchMouseEvent',type:'mouseReleased'}]});
  const storage=await worker.evaluate(()=>chrome.storage.session.get('runtimeState'));
  assert.equal(Object.values(storage.runtimeState.states)[0].count,1);
  assert.equal(JSON.stringify(storage).includes('dummy-password'),false);
  passed('Native autofill pseudo-state with empty DOM values is materialized by one trusted browser click, then OCR and login run');

  await reset();await page.evaluate(()=>{document.querySelector('#un').value='test-only';document.querySelector('#pd').value='dummy-password';});
  await page.waitForFunction(()=>window.clicks===1,null,{timeout:15000});assert.equal((await stats()).attach,0);
  passed('Already materialized fields bypass debugger activation');

  await reset('denied');await preview();
  await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('调试权限'));
  assert.equal(await page.evaluate(()=>window.clicks),0);assert.equal((await stats()).attach,1);assert.equal((await stats()).commands.length,0);
  passed('Debugger attach failure gives a specific error without submitting or retrying');

  materialize=false;await reset();await preview();
  await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('尚未提供自动填充值'),null,{timeout:12000});
  assert.equal(await page.evaluate(()=>window.clicks),0);
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await page.bringToFront();
  await popup.evaluate(()=>chrome.runtime.sendMessage({type:'ui.retry'}));await page.waitForTimeout(1500);await popup.close();
  assert.equal((await stats()).attach,1);
  assert.equal(Object.values((await worker.evaluate(()=>chrome.storage.session.get('runtimeState'))).runtimeState.states)[0].count,0);
  passed('Materialization timeout stops; explicit retry cannot repeat activation in the same document or spend a CAPTCHA attempt');

  materialize=true;await reset('slow');await preview();
  await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('正在确认'));
  await page.locator('#un').fill('manual-user');
  await page.waitForFunction(()=>window.clicks===1,null,{timeout:15000});assert.equal((await stats()).detach,1);
  passed('Editing a username during activation does not stop automatic login');

  await reset('slow');await preview();await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('正在确认'));
  const other=await context.newPage();await other.goto('https://pass.hust.edu.cn/cas/login');await other.bringToFront();await page.waitForTimeout(2200);
  assert.equal((await stats()).commands.length,0);assert.equal(await page.evaluate(()=>window.clicks),0);await other.close();
  passed('Tab switching cancels pending activation');

  for(const target of ['body','#loginPanel']) {
    captureTarget=target;await reset();await preview();
    await page.waitForFunction(()=>window.clicks===1,null,{timeout:15000});
    assert.equal(await page.inputValue('#code'),'0800');
    const events=await page.evaluate(()=>window.gestureEvents.filter(e=>e.trusted));
    assert.deepEqual(events.map(e=>e.type),['mousedown','mouseup','click']);
    assert.equal(events[0].target,'code');assert.equal(events[2].target,target==='body'?'BODY':'loginPanel');
    assert.equal((await stats()).attach,1);assert.equal((await stats()).detach,1);
    passed(`Pointer capture retargets final click to ${target}; autofill, CAPTCHA and login still complete`);
  }
  captureTarget='';await reset('release-slow');await preview();
  await page.waitForFunction(()=>window.clicks===1,null,{timeout:15000});
  assert.equal((await stats()).attach,1);assert.equal((await stats()).detach,1);
  passed('Delayed release within the registered window completes once');

  await reset('release-slow');await preview();
  await page.waitForFunction(()=>window.trustedDown>=1);
  await page.locator('#code').click();
  await page.waitForFunction(()=>window.clicks===1,null,{timeout:15000});
  assert.equal((await stats()).attach,1);assert.equal((await stats()).detach,1);
  passed('Repeated physical clicks during activation do not cancel login');

  await reset('slow');await preview();
  await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('正在确认'));
  await page.locator('#manual').click();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>window.clicks===1,null,{timeout:15000});
  passed('Ordinary clicks and key presses during activation do not cancel login');

  await reset('slow');await preview();
  await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('正在确认'));
  await page.goto('https://pass.hust.edu.cn/cas/other');await page.waitForTimeout(2200);
  assert.equal((await stats()).commands.length,0);assert.equal(await page.evaluate(()=>window.clicks),0);
  passed('Navigation cancels the old document and sends no late click to its replacement');

  await reset('slow');await preview();
  await page.waitForFunction(()=>document.querySelector('#hust-pass-status').textContent.includes('正在确认'));
  await page.locator('#code').fill('1234');await page.waitForTimeout(2200);
  assert.equal(await page.inputValue('#code'),'1234');assert.equal(await page.evaluate(()=>window.clicks),0);
  assert.equal((await stats()).commands.length,0);
  passed('Explicit manual CAPTCHA input during activation is still preserved');

  await writeFile('test-results/autofill-browser.json',JSON.stringify({browser:context.browser().version(),
    fixture:'CSS.forcePseudoState sets native autofill state with empty DOM values; dummy credentials appear only after a trusted mousedown. This is not a real password-manager account test.',results},null,2));
}catch(error){
  console.error('AUTOFILL FAILURE',String(error));
  if(page)console.error(await page.evaluate(()=>({status:document.querySelector('#hust-pass-status')?.textContent,clicks:window.clicks,empty:document.querySelector('#pd')?.value===''})).catch(()=>null));
  if(worker)console.error(await worker.evaluate(()=>({stats:globalThis.activationStats})).catch(()=>null));
  throw error;
}finally{await context.close();}
