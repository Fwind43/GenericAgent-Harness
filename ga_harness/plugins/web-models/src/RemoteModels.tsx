import { useState } from 'react';
import { T, matches } from '@gah/sdk';

export interface RemoteModel { id: string; name?: string }
export interface RemoteSource { provider?: string; key?: string; apibase?: string; apikey?: string; protocol?: string }
export type FetchModels = (source: RemoteSource) => Promise<RemoteModel[]>;
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Provider model list with search + multi-select; existing IDs are shown as added. */
export function RemoteModels({ source, existing, disabled, fetchModels, onAdd }: {
  source: RemoteSource; existing: Set<string>; disabled: boolean; fetchModels: FetchModels; onAdd: (ids: string[]) => void;
}) {
  const [items, setItems] = useState<RemoteModel[] | null>(null), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [picked, setPicked] = useState<Set<string>>(new Set());
  const load = async () => {
    setLoading(true); setError('');
    try { setItems(await fetchModels(source)); setPicked(new Set()); } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  };
  const shown = (items || []).filter(item => matches(query, item.id, item.name));
  const fresh = shown.filter(item => !existing.has(item.id));
  const toggle = (id: string) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  const allPicked = fresh.length > 0 && fresh.every(item => picked.has(item.id));
  return <div className="model-remote wide">
    <div className="model-remote-head">
      <strong>{T('\u670d\u52a1\u5546\u53ef\u7528\u6a21\u578b', 'Available models')}</strong>
      <button type="button" className="secondary" disabled={disabled || loading} onClick={() => { void load(); }}>
        {loading ? T('\u83b7\u53d6\u4e2d...', 'Fetching...') : items ? T('\u91cd\u65b0\u83b7\u53d6', 'Refetch') : T('\u83b7\u53d6\u6a21\u578b\u5217\u8868', 'Fetch model list')}
      </button>
    </div>
    {error && <p className="model-error" role="alert">{error}</p>}
    {items && <>
      {items.length > 8 && <input className="model-search" type="search" value={query} placeholder={T('\u7b5b\u9009\u6a21\u578b...', 'Filter models...')} onChange={event => setQuery(event.target.value)} />}
      {!shown.length ? <p className="model-empty">{items.length ? T('\u6ca1\u6709\u5339\u914d\u9879', 'No matches') : T('\u670d\u52a1\u5546\u672a\u8fd4\u56de\u6a21\u578b', 'The provider returned no models')}</p>
        : <ul className="model-remote-list">{shown.map(item => {
          const added = existing.has(item.id);
          return <li key={item.id}><label className={added ? 'is-added' : ''}>
            <input type="checkbox" disabled={disabled || added} checked={added || picked.has(item.id)} onChange={() => toggle(item.id)} />
            <code>{item.id}</code>{item.name && item.name !== item.id && <span>{item.name}</span>}
            {added && <small>{T('\u5df2\u6dfb\u52a0', 'Added')}</small>}
          </label></li>;
        })}</ul>}
      <div className="model-remote-actions">
        <button type="button" className="model-text-button" disabled={disabled || !fresh.length} onClick={() => {
          const next = new Set(picked); for (const item of fresh) { if (allPicked) next.delete(item.id); else next.add(item.id); } setPicked(next);
        }}>{allPicked ? T('\u53d6\u6d88\u5168\u9009', 'Clear selection') : T('\u5168\u9009', 'Select all')}</button>
        <span>{T('\u5171 ', '') + items.length + T(' \u4e2a\uff0c\u5df2\u6dfb\u52a0 ', ' models, ') + items.filter(item => existing.has(item.id)).length + T('', ' added')}</span>
        <button type="button" disabled={disabled || !picked.size} onClick={() => onAdd([...picked])}>{T('\u6dfb\u52a0\u9009\u4e2d', 'Add selected')} ({picked.size})</button>
      </div>
    </>}
  </div>;
}

/** Compact fetch button that feeds a <datalist> for a single model ID input. */
export function useModelOptions(fetchModels: FetchModels) {
  const [items, setItems] = useState<RemoteModel[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const load = async (source: RemoteSource) => {
    setLoading(true); setError('');
    try { const found = await fetchModels(source); setItems(found); if (!found.length) setError(T('\u670d\u52a1\u5546\u672a\u8fd4\u56de\u6a21\u578b', 'The provider returned no models')); }
    catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  };
  return { items, loading, error, load };
}
