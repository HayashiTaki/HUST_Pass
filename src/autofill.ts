export type CredentialState = 'missing' | 'preview' | 'ready';

/** Inspect only presence and native autofill state. Never retain credential text. */
export function credentialState(username: HTMLInputElement | null, password: HTMLInputElement | null): CredentialState {
  if (!username || !password) return 'missing';
  const usernamePresent = username.value.trim().length > 0;
  const passwordPresent = password.value.length > 0;
  if (usernamePresent && passwordPresent) return 'ready';
  const autofilled = (element: HTMLInputElement) => {
    for (const selector of [':autofill', ':-webkit-autofill']) {
      try { if (element.matches(selector)) return true; } catch { /* Older engines may not support one spelling. */ }
    }
    return false;
  };
  return (usernamePresent || autofilled(username)) && (passwordPresent || autofilled(password)) ? 'preview' : 'missing';
}
