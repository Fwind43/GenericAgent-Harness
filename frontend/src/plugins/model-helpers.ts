import type { ModelConfig, ModelEntry, ProviderEntry } from '../types';
import { T } from '../i18n';

export const matches = (query: string, ...values: (string | undefined)[]) => query.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word => values.join(' ').toLowerCase().includes(word));
export const sectionKey = (entry: ModelEntry) => entry.provider ? 'provider:' + entry.provider : 'legacy:' + JSON.stringify([entry.protocol, entry.values.apibase || (entry.url_hidden ? entry.key : '')]);
export function endpoint(value?: string) {
  try { const url = new URL(value || ''); return url.host + url.pathname.replace(/\/$/, ''); }
  catch { return value || T('\u672a\u8bbe\u7f6e API \u5730\u5740', 'No API URL set'); }
}
export function sections(config: ModelConfig) {
  const groups = new Map<string, { id: string; title: string; provider?: ProviderEntry; entries: ModelEntry[] }>();
  for (const provider of config.providers || []) groups.set('provider:' + provider.id, {
    id: 'provider:' + provider.id, title: provider.values.name || provider.id, provider, entries: [],
  });
  for (const entry of config.entries) {
    const id = sectionKey(entry);
    if (!groups.has(id)) groups.set(id, { id, title: endpoint(entry.values.apibase) + ' / ' + entry.protocol, entries: [] });
    groups.get(id)!.entries.push(entry);
  }
  return [...groups.values()];
}
export function readonlyText(config: ModelConfig) {
  return (config.reason || T('\u5f53\u524d\u914d\u7f6e\u53ea\u8bfb', 'This configuration is read-only')) + (config.convert?.blocked ? '\n' + config.convert.target + T(' \u5df2\u5b58\u5728\uff0c\u4e0d\u4f1a\u8986\u76d6\u3002', ' already exists and will not be overwritten.') : '');
}
