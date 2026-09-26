import { credentialState } from './autofill';
import { errorKind, isLoginUrl } from './protocol';

if (isLoginUrl(location.href) && window === window.top) void main();

async function main() {
  let enabled = true, stopped = false, busy = false, submitted = false;
  let epoch = 0, stableSince = 0, readyKey = '', ownBlob = '', ownCode = '';
  let errorRevision = 0, submittedRevision = 0;
  let activating = false, activationAttempted = false, activationGeneration = 0, activationToken = '';
  const credentials = () => credentialState(input('un'), input('pd'));
  let abort: AbortController | undefined;
  let submitTimer: ReturnType<typeof setTimeout> | undefined;
  const send = async (message: object) => {
    const result = await chrome.runtime.sendMessage(message);
    if (result?.error) throw new Error(result.error);
    return result;
  };
  const input = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const image = () => document.getElementById('codeImage') as HTMLImageElement | null;
  const button = () => document.getElementById('index_login_btn') as HTMLButtonElement | null;
  function visible(element: Element | null) {
    if (!element || !element.getClientRects().length) return false;
    const css = getComputedStyle(element);
    return css.visibility !== 'hidden' && css.display !== 'none';
  }
  const errorText = () => [document.getElementById('errormsghide')?.textContent ?? '',
    visible(document.getElementById('errormsg')) ? document.getElementById('errormsg')?.textContent ?? '' : ''].join(' ').trim();
  function status(message: string) {
    let node = document.getElementById('hust-pass-status');
    if (!node && button()) {
      node = document.createElement('div'); node.id = 'hust-pass-status'; node.setAttribute('role', 'status');
      node.style.cssText = 'font:12px/1.5 system-ui,sans-serif;color:#595752;margin:8px 0;overflow-wrap:anywhere';
      button()!.insertAdjacentElement('afterend', node);
    }
    if (node && node.textContent !== message) node.textContent = message;
  }
  function invalidate() { epoch++; abort?.abort(); abort = undefined; stableSince = 0; readyKey = ''; }
  function stop(reason: string, leaving = false) {
    stopped = true; invalidate(); if (submitTimer) clearTimeout(submitTimer);
    if (!leaving) status(reason);
    void send({ type: 'page.stop', reason, leaving }).catch(() => {});
  }
  function pageReady() {
    return enabled && !stopped && !submitted && document.visibilityState === 'visible'
      && visible(input('pd')) && visible(input('un')) && visible(input('code')) && visible(image())
      && visible(button()) && !button()?.disabled && !input('pd')?.disabled && !input('un')?.disabled
      && !input('code')?.disabled && !input('code')?.readOnly;
  }
  function ready() { return pageReady() && credentials() === 'ready'; }
  async function confirmAutofill() {
    if (activationAttempted) { stop('浏览器尚未提供自动填充值，请刷新页面后重试'); return; }
    activating = true; activationAttempted = true; activationGeneration = epoch; activationToken = '';
    const generation = epoch;
    status('正在确认浏览器自动填充…');
    try {
      await send({ type: 'autofill.activate' });
      const deadline = Date.now() + 5000;
      while (generation === epoch && pageReady() && credentials() !== 'ready' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (generation !== epoch || stopped) return;
      if (!pageReady()) { stop('登录页状态已改变，请刷新后重试'); return; }
      if (credentials() !== 'ready') { stop('浏览器尚未提供自动填充值，请刷新页面后重试'); return; }
      status('账号密码已就绪，准备识别验证码…');
    } catch (error) {
      if (generation === epoch) stop(error instanceof Error ? error.message : '浏览器自动填充激活失败，请刷新页面');
    } finally { activating = false; stableSince = 0; readyKey = ''; }
  }
  function unchanged(generation: number, img: HTMLImageElement) {
    return generation === epoch && ready() && image() === img && img.src === ownBlob && (!input('code')?.value || input('code')?.value === ownCode);
  }
  async function run() {
    busy = true;
    const generation = epoch, img = image()!;
    try {
      const start = await send({ type: 'attempt.begin' });
      if (!start.allowed) {
        if (!start.busy) stopped = true;
        status(start.message); return;
      }
      if (generation !== epoch || !ready()) { stop('页面状态已改变，请重新尝试'); return; }
      status('正在本地识别验证码…');
      const token = start.token;
      abort = new AbortController();
      const timer = setTimeout(() => abort?.abort(), 10_000);
      let bytes: Uint8Array;
      try {
        const response = await fetch(`/cas/code?hust_pass=${crypto.randomUUID()}`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw new Error('验证码加载失败，请手动刷新');
        bytes = new Uint8Array(await response.arrayBuffer());
      } finally { clearTimeout(timer); }
      if (generation !== epoch || !ready()) return;
      if (!['GIF87a','GIF89a'].includes(new TextDecoder().decode(bytes.slice(0,6))) || bytes.length > 1_000_000) throw new Error('验证码格式已改变，请手动填写');
      const previous = ownBlob;
      ownBlob = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/gif' }));
      // Set the exact bytes being recognized, without making a second code endpoint request.
      img.src = ownBlob;
      if (previous) URL.revokeObjectURL(previous);
      const base64 = btoa(Array.from(bytes, c => String.fromCharCode(c)).join(''));
      let timeout: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        send({ type: 'ocr', token, image: base64 }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('识别超时，请重新尝试')), 30_000); }),
      ]).finally(() => clearTimeout(timeout!));
      if (!unchanged(generation, img) || result.token !== token) return;
      const check = await send({ type: 'attempt.check', token });
      if (!check.valid || !unchanged(generation, img)) { stop('验证码任务已失效，请重新尝试'); return; }
      if (!result.code || !/^\d{4}$/.test(result.code)) {
        const rejected = await send({ type: 'attempt.reject', token });
        if (!rejected.retry) stop('已尝试 3 次，请手动填写或重新尝试');
        else { status('识别不确定，正在准备重试…'); stableSince = Date.now(); }
        return;
      }
      if (errorKind(errorText()) === 'other') { stop('网站提示登录异常，请检查页面提示'); return; }
      const permission = await send({ type: 'attempt.submit', token });
      if (!permission.valid || !unchanged(generation, img)) { stop('页面状态已改变，请重新尝试'); return; }
      ownCode = result.code;
      input('code')!.value = ownCode;
      input('code')!.dispatchEvent(new Event('input', { bubbles: true }));
      input('code')!.dispatchEvent(new Event('change', { bubbles: true }));
      submitted = true;
      submittedRevision = errorRevision;
      status('验证码已填写，正在登录…');
      button()!.click();
      submitTimer = setTimeout(() => stop('登录响应超时，请检查页面后手动处理'), 20_000);
    } catch (error) {
      if (generation === epoch) stop(error instanceof Error && error.name !== 'AbortError' ? error.message : '验证码请求超时，请手动刷新');
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'page.activationPoint') {
      const field = input('code');
      if (!activating || activationGeneration !== epoch || !pageReady() || !field || field.value || credentials() === 'missing'
        || (activationToken && activationToken !== message.token)) { respond({ valid: false }); return false; }
      activationToken = message.token;
      const rect = field.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      respond({ valid: rect.width > 0 && rect.height > 0 && document.elementFromPoint(x,y) === field,
        url: location.href, x, y, width: innerWidth, height: innerHeight });
      return false;
    }
    if (message.type === 'page.ping') { respond({ supported: true }); return false; }
    if (message.type === 'page.retry') {
      invalidate(); stopped = false; submitted = false;
      if (submitTimer) clearTimeout(submitTimer);
      if (input('code')?.value === ownCode) input('code')!.value = '';
      ownCode = ''; status('等待浏览器填好学号和密码'); respond({ ok: true });
    }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled) stop('验证码助手已暂停，可手动登录');
      else status('验证码助手已启用，点击扩展中的“重新尝试”开始');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && (busy || activating) && !submitted) stop('页面已切换到后台，请重新尝试');
    stableSince = 0;
  });
  window.addEventListener('pagehide', () => { stop('已离开登录页', true); if (ownBlob) URL.revokeObjectURL(ownBlob); });
  document.addEventListener('beforeinput', e => {
    if (activating && e.isTrusted && ['un','pd','code'].includes((e.target as HTMLElement)?.id)) stop('你正在编辑登录信息，已停止自动填充激活');
  }, true);
  document.addEventListener('input', e => {
    if (!e.isTrusted) return;
    const id = (e.target as HTMLElement)?.id;
    if (id === 'code') { ownCode = ''; stop('已切换为手动填写'); }
    if (id === 'un' || id === 'pd') { if (busy) stop('账号信息正在修改，请重新尝试'); stableSince = 0; }
  }, true);
  document.addEventListener('click', e => {
    if (!e.isTrusted) return;
    const target = e.target as Element;
    if (activating && !target.closest('#code')) { stop('你正在操作登录页，已停止自动填充激活'); return; }
    if (target.closest('#index_login_btn')) stop('已由你手动提交登录');
    else if (target.closest('#codeImage,.code-box')) stop('验证码已手动刷新，请手动填写或重新尝试');
    else if (target.closest('.switch-login')) stop('登录方式已切换，请重新尝试');
  }, true);
  document.addEventListener('keydown', e => {
    if (activating && e.isTrusted && !['Shift','Control','Alt','Meta'].includes(e.key)) { stop('你正在操作登录页，已停止自动填充激活'); return; }
    if (e.isTrusted && e.key === 'Enter' && ['un','pd','code'].includes((e.target as HTMLElement)?.id)) stop('已由你手动提交登录');
  }, true);
  if (document.readyState === 'loading') await new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  try {
    const init = await send({ type: 'page.init', error: errorKind(errorText()) });
    enabled = init.enabled; stopped = init.state.phase === 'stopped';
    activationAttempted = !!init.state.activationDocumentId && init.state.activationDocumentId === init.state.documentId;
    status(enabled ? init.state.message : '验证码助手已暂停，可手动登录');
  } catch { stop('扩展连接失败，请刷新页面'); return; }
  const observer = new MutationObserver(records => {
    if (records.some(r => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest('#errormsg,#errormsghide'))) errorRevision++;
    if (busy && !submitted && records.some(r => r.target === image() && r.attributeName === 'src') && image()?.src !== ownBlob) stop('验证码已改变，请重新尝试');
  });
  observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true, characterData: true, attributeFilter: ['src','style','class'] });
  setInterval(() => {
    if (!enabled || stopped) return;
    if (visible(document.getElementById('phoneCode'))) { stop('需要额外认证，请按页面提示完成'); return; }
    const error = errorKind(errorText());
    if (error === 'other') { stop('网站提示登录异常，请检查页面提示后手动处理'); return; }
    if (submitted) {
      // CAS currently uses full-page POSTs; also handle an inline CAPTCHA rejection.
      if (error === 'captcha' && errorRevision > submittedRevision) {
        submitted = false; if (submitTimer) clearTimeout(submitTimer);
        busy = true;
        void send({ type: 'page.init', error }).then(init => {
          stopped = init.state.phase === 'stopped';
          if (input('code')?.value === ownCode) input('code')!.value = '';
          ownCode = ''; status(init.state.message);
        }).catch(() => stop('扩展连接失败，请刷新页面')).finally(() => { busy = false; });
      } else if (visible(document.getElementById('phoneCode'))) stop('需要额外认证，请按页面提示完成');
      return;
    }
    if (activating) { if (!pageReady()) stop('登录页状态已改变，请刷新后重试'); return; }
    if (busy) { if (!ready()) stop('登录页面状态已改变，请重新尝试'); return; }
    if (!pageReady() || credentials() === 'missing') { stableSince = 0; return; }
    if (input('code')!.value && input('code')!.value !== ownCode) { stop('已有手动验证码，请手动登录'); return; }
    if (!image()!.complete || !image()!.naturalWidth) return;
    const state = credentials();
    const key = state === 'preview' ? 'autofill-preview' : `${input('un')!.value.trim().length}:${input('pd')!.value.length}`;
    if (!stableSince || key !== readyKey) { stableSince = Date.now(); readyKey = key; return; }
    if (Date.now() - stableSince >= 800) {
      if (state === 'preview') void confirmAutofill();
      else void run();
    }
  }, 250);
}
