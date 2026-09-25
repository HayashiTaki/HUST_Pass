export type Phase = 'waiting' | 'recognizing' | 'submitted' | 'stopped' | 'done';
export interface AttemptState {
  count: number; phase: Phase; message: string; updated: number; token?: string; documentId?: string;
}
export const MAX_ATTEMPTS = 3;
export const isLoginUrl = (url: string) => {
  try { const u = new URL(url); return u.origin === 'https://pass.hust.edu.cn' && u.pathname === '/cas/login'; }
  catch { return false; }
};
export function errorKind(text: string): 'captcha' | 'other' | null {
  const value = text.trim();
  if (!value) return null;
  // Whitelist only an explicit CAPTCHA rejection. Unknown or combined credential errors stop.
  if (/密码|账号|帐号|用户|学号|锁定|password|account|username|locked/i.test(value)) return 'other';
  return /验证码.{0,12}(错误|不正确|失效|过期)|(?:captcha|verification code).{0,25}(invalid|incorrect|expired|wrong)|(?:invalid|incorrect|expired|wrong).{0,15}(?:captcha|verification code)/i.test(value) ? 'captcha' : 'other';
}
