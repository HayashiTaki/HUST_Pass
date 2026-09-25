import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(await mkdtemp(resolve('.cache/edge-test-')), {
  channel: 'msedge', headless: true, viewport: { width: 1000, height: 780 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const results = [], consoleErrors = [], requests = [];
context.on('page', page => {
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).hostname;
  console.log('Loaded Edge extension', extensionId);
  let codeId = '000', codeDelay = 0, postError = '', codeFailure = false;
  const html = () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <main class="panel-right"><h1>密码登录（自动化测试）</h1><input id="un" placeholder="学号"><input id="pd" type="password" placeholder="密码"><input id="code" placeholder="验证码">
  <a class="code-box"><img id="codeImage" src="/cas/code"></a><button id="index_login_btn">登录</button><div id="errormsg"></div><div id="errormsghide" hidden>${postError}</div></main>
  <script>localStorage.clear();sessionStorage.clear();window.clicks=0;document.querySelector('#index_login_btn').onclick=()=>{window.clicks++;};document.querySelector('#codeImage').onclick=()=>{document.querySelector('#codeImage').src='/cas/code?manual='+Date.now()};</script></body></html>`;
  await context.route('https://pass.hust.edu.cn/**', async route => {
    const url = new URL(route.request().url()); requests.push(url.pathname);
    if (url.pathname === '/cas/login') return route.fulfill({ contentType: 'text/html', body: html() });
    if (url.pathname === '/cas/code') {
      const id = codeId;
      if (codeFailure && url.searchParams.has('hust_pass')) return route.fulfill({status:503,body:'unavailable'});
      if (url.searchParams.has('hust_pass') && codeDelay) await new Promise(r => setTimeout(r, codeDelay));
      return route.fulfill({ contentType: 'image/jpeg', body: await readFile(`tests/fixtures/captcha/${id}.gif`) });
    }
    return route.abort();
  });
  await context.route(/^https?:\/\/(?!pass\.hust\.edu\.cn(?:\/|$))/, route => route.abort());
  const page = await context.newPage();
  const reset = async () => { await page.goto('about:blank'); await page.waitForTimeout(200); return worker.evaluate(async () => { await chrome.storage.session.clear(); await chrome.storage.local.set({ enabled: true }); }); };
  const open = async (suffix = '') => { await page.goto('https://pass.hust.edu.cn/cas/login' + suffix); await page.bringToFront(); await page.waitForSelector('#hust-pass-status'); };
  const fill = () => page.evaluate(() => { document.querySelector('#un').value = 'test-only'; document.querySelector('#pd').value = 'not-a-real-password'; });
  const clicked = () => page.waitForFunction(() => window.clicks === 1, null, { timeout: 15_000 });
  const check = name => { results.push({ name, passed: true }); console.log('PASS', name); };

  await reset(); await open('?service=https%3A%2F%2Fexample.invalid%2Fcallback');
  await page.waitForTimeout(1200); assert.equal(await page.evaluate(() => window.clicks), 0);
  await fill(); await clicked();
  assert.equal(await page.inputValue('#code'), '0800');
  assert.match(page.url(), /service=/);
  assert.match(await page.locator('#codeImage').getAttribute('src'), /^blob:/);
  await page.waitForTimeout(1200); assert.equal(await page.evaluate(() => window.clicks), 1);
  check('Delayed browser autofill, leading zero, wrong MIME, offline OCR, original click and query preservation');
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.setViewportSize({ width: 340, height: 400 });
  await popup.waitForFunction(() => !document.querySelector('#status').textContent.includes('正在读取'));
  assert.equal(await popup.locator('#enabled').isChecked(), true);
  await page.bringToFront(); await popup.waitForTimeout(1100);
  await popup.screenshot({ path: 'test-results/popup.png' }); await popup.close();

  postError = '验证码错误'; await open(); await fill(); await clicked();
  await open(); await fill(); await clicked();
  await open(); await fill(); await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  assert.match(await page.locator('#hust-pass-status').innerText(), /3 次/);
  check('CAPTCHA rejection across reloads stops after exactly three attempts despite page storage clearing');

  postError = '用户名或密码错误'; await reset(); await open(); await fill(); await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.clicks), 0); check('Credential error never auto submits');

  postError = ''; await reset(); codeDelay = 2000; await open(); await fill();
  await page.waitForFunction(() => document.querySelector('#hust-pass-status')?.textContent.includes('本地识别'));
  await page.locator('#code').fill('1234'); await page.waitForTimeout(2500);
  assert.equal(await page.inputValue('#code'), '1234'); assert.equal(await page.evaluate(() => window.clicks), 0);
  check('Manual input cancels delayed image and stale OCR');

  await reset(); await open(); await fill();
  await page.waitForFunction(() => document.querySelector('#hust-pass-status')?.textContent.includes('本地识别'));
  await page.locator('#codeImage').click(); await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.clicks), 0); check('Manual image refresh invalidates pending task');

  codeDelay = 0; codeId = '036'; await reset(); await open(); await fill();
  await page.waitForFunction(() => document.querySelector('#hust-pass-status')?.textContent.includes('已尝试 3 次'), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.clicks), 0); check('Low-confidence OCR retries twice then stops without filling');

  codeId = '000'; await reset(); await open(); await page.locator('#pd').evaluate(e => e.style.display = 'none'); await fill();
  await page.waitForTimeout(1500); assert.equal(await page.evaluate(() => window.clicks), 0); check('Hidden password panel does not run');

  await reset(); await open(); await fill(); await clicked();
  await page.evaluate(() => document.querySelector('#errormsg').textContent = '验证码错误');
  await page.waitForFunction(() => window.clicks === 2, null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#errormsg').textContent = '验证码错误');
  await page.waitForFunction(() => window.clicks === 3, null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#errormsg').textContent = '验证码错误');
  await page.waitForTimeout(1500); assert.equal(await page.evaluate(() => window.clicks), 3); check('Repeated identical inline CAPTCHA errors observe the three-attempt budget');

  await reset(); await open(); codeFailure = true; await fill();
  await page.waitForFunction(() => document.querySelector('#hust-pass-status')?.textContent.includes('验证码加载失败'));
  assert.equal(await page.evaluate(() => window.clicks),0); codeFailure = false;
  check('Network failure stops instead of retrying login');

  await reset(); await open(); await page.evaluate(() => { const input=document.createElement('input');input.id='phoneCode';document.body.append(input); }); await fill();
  await page.waitForTimeout(1500);assert.equal(await page.evaluate(() => window.clicks),0);
  assert.match(await page.locator('#hust-pass-status').innerText(), /额外认证/); check('Additional authentication remains manual');

  await reset(); await open();
  const controls = await context.newPage(); await controls.goto(`chrome-extension://${extensionId}/popup.html`);
  await controls.setViewportSize({width:340,height:400}); await page.bringToFront(); await controls.waitForTimeout(1100);
  await controls.evaluate(() => document.querySelector('#enabled').click());
  await page.waitForFunction(() => document.querySelector('#hust-pass-status')?.textContent.includes('暂停'));
  await fill(); await page.waitForTimeout(1200); assert.equal(await page.evaluate(() => window.clicks),0);
  await controls.evaluate(() => document.querySelector('#enabled').click()); await controls.waitForTimeout(1100);
  await controls.evaluate(() => document.querySelector('#retry').click()); await clicked();
  check('Popup toggle and explicit retry work without storing credentials');
  await controls.close();

  await reset(); await open(); codeDelay = 2000; await fill();
  await page.waitForFunction(() => document.querySelector('#hust-pass-status')?.textContent.includes('本地识别'));
  const other = await context.newPage();await other.goto('https://pass.hust.edu.cn/cas/login');await other.bringToFront();
  await other.waitForSelector('#hust-pass-status');await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.clicks),0);await other.close();codeDelay=0;
  check('Another login tab invalidates an in-flight CAPTCHA');

  await reset();await open();
  const conflictPopup=await context.newPage();await conflictPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await conflictPopup.setViewportSize({width:340,height:400});await page.bringToFront();await conflictPopup.waitForTimeout(1100);
  await worker.evaluate(async()=>{const {runtimeState}=await chrome.storage.session.get('runtimeState');runtimeState.owner={tab:99999,token:'test-conflict',expires:Date.now()+60000};await chrome.storage.session.set({runtimeState});});
  await conflictPopup.evaluate(()=>document.querySelector('#retry').click());await conflictPopup.waitForTimeout(2200);
  assert.match(await conflictPopup.locator('#status').innerText(),/另一个登录页正在处理/);
  await conflictPopup.screenshot({path:'test-results/popup-error.png'});await conflictPopup.close();
  check('Popup action errors remain readable across periodic status refreshes');

  assert.equal(consoleErrors.filter(e => !e.includes('net::ERR_ABORTED') && !e.includes('503')).length, 0, consoleErrors.join('\n'));
  await writeFile('test-results/browser.json', JSON.stringify({ browser: context.browser()?.version(), results, consoleErrors, requests }, null, 2));
} catch (error) {
  console.log('PAGE STATES', await Promise.all(context.pages().map(p => p.evaluate(() => ({url:location.href,status:document.querySelector('#hust-pass-status')?.textContent, clicks:window.clicks, code:document.querySelector('#code')?.value})))));
  console.log('BACKGROUND STATE', await context.serviceWorkers()[0].evaluate(() => chrome.storage.session.get(null)));
  await writeFile('test-results/browser-failure.json', JSON.stringify({ results, consoleErrors, error: String(error) }, null, 2));
  throw error;
} finally { await context.close(); }
