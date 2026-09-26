import { isLoginUrl } from './protocol';

export interface ActivationPoint { valid: boolean; url?: string; x?: number; y?: number; width?: number; height?: number }
interface Job { cancelled: boolean; detaching: boolean }
const jobs = new Map<number, Job>();

export function cancelActivation(tab: number) { const job = jobs.get(tab); if (job) job.cancelled = true; }
export function debuggerDetached(tab: number): boolean {
  const job = jobs.get(tab);
  if (!job || job.detaching) return false;
  job.cancelled = true; return true;
}

/** No generic CDP bridge: the only commands this module sends are a left click. */
export async function activateAutofill(tab: number, documentId: string, token: string, valid: () => Promise<boolean>): Promise<void> {
  if (jobs.has(tab)) throw new Error('浏览器自动填充激活仍在结束，请稍后重试');
  const job = { cancelled: false, detaching: false };
  jobs.set(tab, job);
  const target = { tabId: tab };
  const deadline = Date.now() + 5000;
  let attached = false;
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('浏览器自动填充激活超时，请刷新页面后重试')), Math.max(0, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer!); }
  };
  const detach = async () => {
    if (!attached) return;
    job.detaching = true; attached = false;
    try { await chrome.debugger.detach(target); } catch { /* Navigation or user cancellation may already detach. */ }
  };
  const point = async (): Promise<Required<ActivationPoint>> => {
    if (job.cancelled || Date.now() >= deadline || !await bounded(valid())) throw new Error('自动填充激活已取消，请检查当前登录页');
    const [current] = await bounded(chrome.tabs.query({ active: true, lastFocusedWindow: true }));
    if (current?.id !== tab) throw new Error('登录页已切换到后台，已停止自动填充激活');
    const result: ActivationPoint = await bounded(chrome.tabs.sendMessage(tab, { type: 'page.activationPoint', token }, { documentId }));
    if (!result?.valid || !isLoginUrl(result.url ?? '') || ![result.x,result.y,result.width,result.height].every(Number.isFinite)
      || result.x! < 0 || result.y! < 0 || result.x! >= result.width! || result.y! >= result.height!) {
      throw new Error('验证码输入框不可点击或已被遮挡，请检查登录页');
    }
    if (job.cancelled || !await bounded(valid())) throw new Error('自动填充激活已取消');
    return result as Required<ActivationPoint>;
  };
  try {
    await point();
    const attaching = chrome.debugger.attach(target, '1.3').then(async () => {
      attached = true;
      // An attach response can arrive after our timeout. Never leave that session behind.
      if (job.cancelled) await detach();
    });
    await bounded(attaching);
    const down = await point();
    await bounded(chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: down.x, y: down.y, button: 'left', buttons: 1, clickCount: 1 }));
    const up = await point();
    if (Math.abs(down.x-up.x) > 1 || Math.abs(down.y-up.y) > 1) throw new Error('登录页布局已改变，已取消自动填充激活');
    await bounded(chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: up.x, y: up.y, button: 'left', buttons: 0, clickCount: 1 }));
  } catch (error) {
    if (error instanceof Error && /another debugger|Cannot attach|restricted|denied/i.test(error.message)) {
      throw new Error('无法激活浏览器自动填充，请关闭此页开发者工具并确认扩展调试权限后刷新');
    }
    throw error;
  } finally {
    job.cancelled = true;
    await detach();
    if (jobs.get(tab) === job) jobs.delete(tab);
  }
}
