// Browser storage can be disabled; settings then last for the session only.

export function loadSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function saveSetting(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Keep the in-memory value. */ }
}
