import { type ModelConfig, type ModelEntry, type ProviderEntry, T } from '@gah/sdk';

export const sectionKey = (entry: ModelEntry) => entry.provider ? 'provider:' + entry.provider : 'legacy:' + JSON.stringify([entry.protocol, entry.values.apibase || (entry.url_hidden ? entry.key : '')]);
export function endpoint(value?: string) {
  try { const url = new URL(value || ''); return url.host + url.pathname.replace(/\/$/, ''); }
  catch { return value || T('\u672a\u8bbe\u7f6e API \u5730\u5740', 'No API URL set'); }
}
export const protocolLabel = (value?: string) => value === 'claude' ? 'Claude' : 'OpenAI';
export const modelTitle = (entry?: ModelEntry) => entry ? entry.values.name || entry.values.model || entry.key : '';

/** Provider display names; duplicates get their endpoint host appended so they stay distinguishable. */
export function providerNames(config: ModelConfig) {
  const counts = new Map<string, number>(), names = new Map<string, string>();
  const base = (item: ProviderEntry) => item.values.name || item.id;
  for (const item of config.providers || []) counts.set(base(item), (counts.get(base(item)) || 0) + 1);
  for (const item of config.providers || []) {
    const name = base(item), host = endpoint(item.values.apibase).split('/')[0];
    names.set(item.id, (counts.get(name) || 0) > 1 ? name + ' \u00b7 ' + (host || item.id) : name);
  }
  return names;
}
export function sections(config: ModelConfig) {
  const names = providerNames(config);
  const groups = new Map<string, { id: string; title: string; provider?: ProviderEntry; entries: ModelEntry[] }>();
  for (const provider of config.providers || []) groups.set('provider:' + provider.id, {
    id: 'provider:' + provider.id, title: names.get(provider.id) || provider.id, provider, entries: [],
  });
  for (const entry of config.entries) {
    const id = sectionKey(entry);
    if (!groups.has(id)) groups.set(id, { id, title: endpoint(entry.values.apibase) + ' \u00b7 ' + protocolLabel(entry.protocol), entries: [] });
    groups.get(id)!.entries.push(entry);
  }
  return [...groups.values()];
}
export function readonlyText(config: ModelConfig) {
  return config.reason || T('\u5f53\u524d\u914d\u7f6e\u53ea\u8bfb', 'This configuration is read-only');
}
