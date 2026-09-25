import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

async function harness() {
  let listener: any;
  const session: Record<string, any> = {}, local: Record<string, any> = {};
  const area = (data: Record<string, any>) => ({
    get: async (key: string) => structuredClone({ [key]: data[key] }),
    set: async (update: object) => Object.assign(data, structuredClone(update)),
  });
  const chrome = {
    runtime: { id: 'test-extension', getURL: (s: string) => `chrome-extension://test-extension/${s}`,
      onMessage: { addListener: (fn: any) => { listener = fn; } } },
    storage: { session: area(session), local: area(local) },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  vm.runInNewContext(await readFile('dist/background.js','utf8'), { chrome, crypto: webcrypto, URL, Date, setTimeout, clearTimeout, console });
  const sender = (tab = 1, doc = 'first') => ({ id: 'test-extension', tab: {id: tab}, frameId: 0, url: 'https://pass.hust.edu.cn/cas/login', documentId: doc });
  const send = (message: object, tab = 1, doc = 'first'): Promise<any> => new Promise(resolve => listener(message, sender(tab,doc), resolve));
  return { send, session, local, listener };
}

test('concurrent begins have one owner and cannot double increment or submit', async () => {
  const h = await harness(); await h.send({type:'page.init'});
  const starts = await Promise.all([h.send({type:'attempt.begin'}), h.send({type:'attempt.begin'})]);
  assert.equal(starts.filter(r => r.allowed).length, 1);
  assert.equal(h.session.runtimeState.states['1'].count, 1);
  const token = starts.find(r => r.allowed).token;
  const submits = await Promise.all([h.send({type:'attempt.submit',token}),h.send({type:'attempt.submit',token})]);
  assert.equal(submits.filter(r => r.valid).length, 1);
});
test('full-page CAPTCHA rejections preserve the retry count and stop after three', async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) {
    await h.send({type:'page.init',error:i ? 'captcha' : null}, 1, `doc${i}`);
    const start = await h.send({type:'attempt.begin'}, 1, `doc${i}`); assert.equal(start.allowed,true);
    assert.equal((await h.send({type:'attempt.submit',token:start.token}, 1, `doc${i}`)).valid,true);
    await h.send({type:'page.stop',leaving:true}, 1, `doc${i}`);
    assert.equal(h.session.runtimeState.states['1'].phase,'submitted');
  }
  await h.send({type:'page.init',error:'captcha'},1,'fourth');
  assert.equal((await h.send({type:'attempt.begin'},1,'fourth')).allowed,false);
  assert.equal(h.session.runtimeState.states['1'].count,3);
});
test('new login document invalidates another tab\'s pending token', async () => {
  const h = await harness(); await h.send({type:'page.init'});
  const start = await h.send({type:'attempt.begin'});
  await h.send({type:'page.init'},2,'second');
  assert.equal((await h.send({type:'attempt.check',token:start.token})).valid,false);
  assert.equal((await h.send({type:'attempt.submit',token:start.token})).valid,false);
});
test('manual cancellation rejects late results, including after a new attempt', async () => {
  const h = await harness(); await h.send({type:'page.init'});
  const start = await h.send({type:'attempt.begin'});
  await h.send({type:'page.stop',reason:'manual'});
  assert.equal((await h.send({type:'attempt.check',token:start.token})).valid,false);
  assert.equal((await h.send({type:'attempt.submit',token:start.token})).valid,false);
});
test('disabled extension and foreign document cannot authorize submission', async () => {
  const h = await harness(); await h.send({type:'page.init'});
  const start = await h.send({type:'attempt.begin'});
  assert.equal((await h.send({type:'attempt.submit',token:start.token},1,'different')).valid,false);
  h.local.enabled = false;
  assert.equal((await h.send({type:'attempt.submit',token:start.token})).valid,false);
});
test('credential or unknown server errors never authorize automatic retries', async () => {
  const h = await harness(); await h.send({type:'page.init',error:'other'});
  assert.equal((await h.send({type:'attempt.begin'})).allowed,false);
});
test('uncertain OCR exhausts the same three-attempt budget without submitting', async () => {
  const h = await harness(); await h.send({type:'page.init'});
  for (let i = 0; i < 3; i++) {
    const start = await h.send({type:'attempt.begin'});
    assert.equal((await h.send({type:'attempt.reject',token:start.token})).retry,i < 2);
  }
  assert.equal((await h.send({type:'attempt.begin'})).allowed,false);
});
test('external origin and subframes cannot send task messages', async () => {
  const h = await harness();
  for (const sender of [
    {id:'test-extension',tab:{id:1},frameId:0,url:'https://evil.invalid/cas/login'},
    {id:'test-extension',tab:{id:1},frameId:1,url:'https://pass.hust.edu.cn/cas/login'},
  ]) {
    const result: any = await new Promise(resolve => h.listener({type:'attempt.begin'},sender,resolve));
    assert.ok(result.error);
  }
});


test('inline CAPTCHA errors release the same document lease for the next attempt', async () => {
  const h = await harness(); await h.send({type:'page.init'});
  const start = await h.send({type:'attempt.begin'});
  await h.send({type:'attempt.submit',token:start.token});
  await h.send({type:'page.init',error:'captcha'});
  const second = await h.send({type:'attempt.begin'});
  assert.equal(second.allowed,true);
  assert.equal(h.session.runtimeState.states['1'].count,2);
});


test('navigation before any attempt starts a fresh wait on the new login page', async () => {
  const h=await harness(); await h.send({type:'page.init'});
  await h.send({type:'page.stop',leaving:true});
  const initialized=await h.send({type:'page.init'},1,'new-service');
  assert.equal(initialized.state.phase,'waiting');
  assert.equal((await h.send({type:'attempt.begin'},1,'new-service')).allowed,true);
});


test('late pagehide cannot turn a completed navigation into a stopped attempt', async () => {
  const h=await harness();await h.send({type:'page.init'});
  h.session.runtimeState.states['1'].phase='done';h.session.runtimeState.states['1'].count=1;
  await h.send({type:'page.stop',leaving:true});
  const initialized=await h.send({type:'page.init'},1,'next-login');
  assert.equal(initialized.state.phase,'waiting');assert.equal(initialized.state.count,0);
});
