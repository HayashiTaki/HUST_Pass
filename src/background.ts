import { activateAutofill, cancelActivation, debuggerDetached } from './activation';
import { MAX_ATTEMPTS, isLoginUrl, type AttemptState } from './protocol';

interface Store { states: Record<string, AttemptState>; owner?: { tab: number; token: string; expires: number } }
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn); chain = next.catch(() => {}); return next;
}
async function load(): Promise<Store> {
  const { runtimeState } = await chrome.storage.session.get('runtimeState');
  return runtimeState as Store ?? { states: {} };
}
async function save(store: Store) { await chrome.storage.session.set({ runtimeState: store }); }
async function enabled() { return (await chrome.storage.local.get('enabled')).enabled !== false; }
const fresh = (): AttemptState => ({ count: 0, phase: 'waiting', message: '等待浏览器填好学号和密码', updated: Date.now() });
let creating: Promise<void> | undefined;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS], justification: '在本机运行验证码 OCR Worker，不向外部发送图片' }).finally(() => { creating = undefined; });
  await creating;
}

async function handle(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  if (message.target === 'offscreen') return undefined;
  const ownPage = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  const tab = sender.tab?.id;
  const page = tab !== undefined && sender.frameId === 0 && isLoginUrl(sender.url ?? '');
  if (!ownPage && !page) throw new Error('不支持的页面');
  if (message.type === 'ui.status' && ownPage) {
    const current = await chrome.tabs.query({ active: true, currentWindow: true });
    const store = await load();
    let supported = false;
    if (current[0]?.id !== undefined) {
      try { supported = (await chrome.tabs.sendMessage(current[0].id, { type: 'page.ping' }))?.supported === true; } catch {}
    }
    return { enabled: await enabled(), supported, state: supported ? store.states[String(current[0].id)] ?? fresh() : null };
  }
  if (message.type === 'ui.enable' && ownPage) {
    await chrome.storage.local.set({ enabled: message.enabled === true });
    if (!message.enabled) await exclusive(async () => {
      const store = await load();
      for (const [tab, state] of Object.entries(store.states)) {
        cancelActivation(Number(tab));
        if (state.phase !== 'done') { state.phase = 'stopped'; state.message = '已暂停，可手动登录'; delete state.token; }
      }
      delete store.owner; await save(store);
    });
    return { ok: true };
  }
  if (message.type === 'ui.retry' && ownPage) {
    if (!await enabled()) throw new Error('请先启用验证码助手');
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (current?.id === undefined) throw new Error('请先打开密码登录页');
    const pong = await chrome.tabs.sendMessage(current.id, { type: 'page.ping' });
    if (!pong?.supported) throw new Error('请先打开密码登录页');
    await exclusive(async () => {
      const store = await load();
      if (store.owner && store.owner.tab !== current.id && store.owner.expires > Date.now()) throw new Error('另一个登录页正在处理，请稍后重试');
      delete store.owner;
      const old = store.states[String(current.id)];
      store.states[String(current.id)] = { ...fresh(), documentId: old?.documentId, activationDocumentId: old?.activationDocumentId };
      cancelActivation(current.id!); await save(store);
    });
    await chrome.tabs.sendMessage(current.id, { type: 'page.retry' });
    return { ok: true };
  }
  if (!page || tab === undefined) throw new Error('消息来源无效');
  const key = String(tab), documentId = sender.documentId;

  if (message.type === 'autofill.activate') {
    if (!documentId) throw new Error('无法确认登录页面，请刷新后重试');
    const token = await exclusive(async () => {
      const store = await load(), state = store.states[key];
      if (!await enabled() || !state || state.documentId !== documentId || state.phase !== 'waiting') throw new Error('自动填充任务已失效');
      if (state.activationDocumentId === documentId) throw new Error('本页已尝试激活自动填充，请刷新页面后重试');
      if (store.owner && store.owner.expires > Date.now()) throw new Error('另一个登录页正在处理，请稍后重试');
      const token = crypto.randomUUID();
      state.activationDocumentId = documentId; state.phase = 'activating'; state.token = token;
      state.message = '正在确认浏览器自动填充'; state.updated = Date.now();
      store.owner = { tab, token, expires: Date.now() + 7000 }; await save(store); return token;
    });
    const valid = () => exclusive(async () => {
      const store = await load(), state = store.states[key];
      return await enabled() && state?.documentId === documentId && state.phase === 'activating' && state.token === token
        && store.owner?.tab === tab && store.owner.token === token && store.owner.expires > Date.now();
    });
    try {
      await activateAutofill(tab, documentId, token, valid);
      return await exclusive(async () => {
        const store = await load(), state = store.states[key];
        if (!await enabled() || state?.documentId !== documentId || state.phase !== 'activating' || state.token !== token) throw new Error('自动填充激活已取消');
        state.phase = 'waiting'; state.message = '等待浏览器确认账号密码'; delete state.token;
        if (store.owner?.token === token) delete store.owner;
        await save(store); return { ok: true };
      });
    } catch (error) {
      await exclusive(async () => {
        const store = await load(), state = store.states[key];
        if (state?.documentId === documentId && state.token === token) {
          state.phase = 'stopped'; state.message = error instanceof Error ? error.message : '自动填充激活失败，请刷新页面'; delete state.token;
          if (store.owner?.token === token) delete store.owner;
          await save(store);
        }
      });
      throw error;
    }
  }

  if (message.type === 'ocr') {
    const valid = await exclusive(async () => {
      const store = await load();
      return await enabled() && store.owner?.tab === tab && store.owner.token === message.token
        && store.states[key]?.documentId === documentId && store.states[key]?.phase === 'recognizing';
    });
    if (!valid) throw new Error('任务已取消');
    if (typeof message.image !== 'string' || message.image.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(message.image)) throw new Error('验证码数据异常');
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', image: message.image, token: message.token });
  }

  return exclusive(async () => {
    const store = await load();
    let state = store.states[key] ?? fresh();
    store.states[key] = state;
    if (message.type === 'page.init') {
      // A new login document invalidates any in-flight code from another document/tab.
      if (store.owner && (store.owner.tab !== tab || state.documentId !== documentId)) {
        const old = store.states[String(store.owner.tab)];
        if (old && (old.phase === 'recognizing' || old.phase === 'activating')) { old.phase = 'stopped'; old.message = '另一个登录页已加载，请重新尝试'; delete old.token; }
        cancelActivation(store.owner.tab);
        delete store.owner;
      }
      if (state.phase === 'done' || (state.documentId !== documentId && state.count === 0)) state = store.states[key] = fresh();
      if ((state.phase === 'recognizing' || state.phase === 'activating') && state.documentId !== documentId) {
        state.phase = 'stopped'; state.message = '页面已刷新，请重新尝试'; delete state.token;
      }
      if (message.error === 'other') { state.phase = 'stopped'; state.message = '网站提示登录异常，请检查页面提示后手动处理'; }
      else if (state.phase === 'submitted') {
        if (store.owner?.tab === tab) delete store.owner;
        delete state.token;
        if (message.error === 'captcha' && state.count < MAX_ATTEMPTS) { state.phase = 'waiting'; state.message = '验证码错误，准备重试'; }
        else { state.phase = 'stopped'; state.message = message.error === 'captcha' ? '已尝试 3 次，请手动填写或重新尝试' : '上次登录结果未确认，请检查页面后重新尝试'; }
      } else if (message.error === 'captcha' && state.count === 0) {
        state.phase = 'stopped'; state.message = '页面已有登录错误，请确认后重新尝试';
      }
      state.documentId = documentId; state.updated = Date.now(); await save(store);
      return { enabled: await enabled(), state };
    }
    if (message.type === 'attempt.begin') {
      if (!await enabled()) return { allowed: false, message: '验证码助手已暂停' };
      if (state.phase !== 'waiting' || state.count >= MAX_ATTEMPTS) return { allowed: false, message: state.message };
      if (store.owner && store.owner.expires > Date.now()) return { allowed: false, busy: true, message: '另一个登录页正在处理' };
      const token = crypto.randomUUID();
      state = { count: state.count + 1, phase: 'recognizing', message: `正在本地识别，第 ${state.count + 1}/3 次`, token, updated: Date.now(), documentId, activationDocumentId: state.activationDocumentId };
      store.states[key] = state; store.owner = { tab, token, expires: Date.now() + 60_000 }; await save(store);
      return { allowed: true, token };
    }
    if (message.type === 'attempt.check') return { valid: await enabled() && state.token === message.token && state.documentId === documentId && state.phase === 'recognizing' && !!store.owner && store.owner.token === message.token && store.owner.expires > Date.now() };
    if (message.type === 'attempt.submit') {
      if (!await enabled() || state.token !== message.token || state.documentId !== documentId || state.phase !== 'recognizing' || !store.owner || store.owner.token !== message.token || store.owner.expires <= Date.now()) return { valid: false };
      state.phase = 'submitted'; state.message = '已点击登录，等待网站响应'; state.updated = Date.now();
      // Keep session-wide ownership during the POST/redirect, so another tab cannot refresh its code.
      store.owner.expires = Date.now() + 25_000; await save(store); return { valid: true };
    }
    if (message.type === 'attempt.reject' && state.token === message.token && state.phase === 'recognizing') {
      delete store.owner; delete state.token;
      state.phase = state.count < MAX_ATTEMPTS ? 'waiting' : 'stopped';
      state.message = state.phase === 'waiting' ? '识别不确定，准备刷新验证码' : '已尝试 3 次，请手动填写或重新尝试';
      await save(store); return { retry: state.phase === 'waiting' };
    }
    if (message.type === 'page.stop' && state.documentId === documentId) {
      // The old document's pagehide must not undo submitted state needed after a CAPTCHA rejection.
      if (message.leaving && (state.phase === 'submitted' || state.phase === 'done')) return { ok: true };
      cancelActivation(tab);
      state.phase = 'stopped'; state.message = String(message.reason ?? '已停止，请手动登录').slice(0,100); delete state.token;
      if (store.owner?.tab === tab) delete store.owner;
      await save(store); return { ok: true };
    }
    return { ok: false };
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'offscreen') return false;
  handle(message, sender).then(respond, error => respond({ error: error instanceof Error ? error.message : '扩展运行异常' }));
  return true;
});
chrome.tabs.onRemoved.addListener(tab => {
  cancelActivation(tab);
  void exclusive(async () => { const store = await load(); delete store.states[String(tab)]; if (store.owner?.tab === tab) delete store.owner; await save(store); });
});
chrome.tabs.onUpdated.addListener((tab, change) => {
  if (change.status === 'loading' || change.url) cancelActivation(tab);
  if (!change.url || isLoginUrl(change.url)) return;
  void exclusive(async () => {
    const store = await load(), state = store.states[String(tab)];
    if (state) { state.phase = 'done'; state.message = '已离开登录页'; delete state.token; }
    if (store.owner?.tab === tab) delete store.owner;
    await save(store);
  });
});

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) debuggerDetached(source.tabId);
});
