import { type ModelConfig, type ModelEntry, type ProviderEntry, T } from '@gah/sdk';

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
  return config.reason || T('\u5f53\u524d\u914d\u7f6e\u53ea\u8bfb', 'This configuration is read-only');
}
