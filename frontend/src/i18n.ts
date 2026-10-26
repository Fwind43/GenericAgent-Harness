export function saved(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}
const preference = saved('gah-lang');
export const language: 'zh' | 'en' = preference === 'en' ? 'en'
  : preference === 'zh' || navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
export const T = (zh: string, en: string) => language === 'zh' ? zh : en;
window.T = T;
window.GAH_LANG = language;
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
