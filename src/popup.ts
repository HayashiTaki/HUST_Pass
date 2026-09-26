export {};
const toggle = document.getElementById('enabled') as HTMLInputElement;
const retry = document.getElementById('retry') as HTMLButtonElement;
const status = document.getElementById('status')!;
const attempts = document.getElementById('attempts')!;
let operation = false;
let operationError = ''; 
async function send(message: object) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}
async function refresh() {
  if (operation) return;
  try {
    const result = await send({ type: 'ui.status' });
    toggle.checked = result.enabled;
    status.textContent = operationError || (!result.supported ? '请在华中大统一身份认证的密码登录页使用。' : !result.enabled ? '已暂停，可手动登录。' : result.state.message);
    attempts.textContent = result.supported && result.state.count ? `本轮已尝试 ${result.state.count} / 3 次` : '';
    retry.disabled = !result.enabled || !result.supported || ['activating','recognizing','submitted'].includes(result.state?.phase);
  } catch (error) { status.textContent = `无法读取扩展状态：${error instanceof Error ? error.message : '请重新加载扩展'}`; retry.disabled = true; }
}
async function act(message: object) {
  operationError = ''; operation = true; retry.disabled = true; toggle.disabled = true;
  try { await send(message); }
  catch (error) { operationError = error instanceof Error ? error.message : '操作失败，请重试'; status.textContent = operationError; }
  finally { operation = false; toggle.disabled = false; }
  await refresh();
}
toggle.addEventListener('change', () => void act({ type: 'ui.enable', enabled: toggle.checked }));
retry.addEventListener('click', () => void act({ type: 'ui.retry' }));
void refresh(); setInterval(() => void refresh(), 1000);
