import { useLayoutEffect, useState, type KeyboardEvent } from 'react';
import { T, confirmDialog, type ModelEntry, type ModelValues } from '@gah/sdk';

export type QuickSave = (action: 'save' | 'delete', key: string, values?: ModelValues & { provider?: string }) => Promise<boolean>;

/** Models owned by one provider, editable in place without leaving the provider editor. */
export function ProviderModels({ provider, models, disabled, onSave, onOpen, onAdd, onDirtyChange }: {
  provider: string; models: ModelEntry[]; disabled: boolean; onSave: QuickSave;
  onOpen: (key: string) => void; onAdd: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(''), [model, setModel] = useState(''), [name, setName] = useState(''), [context, setContext] = useState('');
  const current = models.find(item => item.key === editing);
  const dirty = !!current && (model !== (current.values.model || '') || name !== (current.values.name || '') || context !== String(current.values.context_win ?? ''));
  useLayoutEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => () => { onDirtyChange(false); }, [onDirtyChange]);
  const start = async (item: ModelEntry) => {
    if (dirty && !await confirmDialog({ title: T('\u653e\u5f03\u672a\u4fdd\u5b58\u7684\u66f4\u6539\uff1f', 'Discard unsaved changes?'), message: current?.values.name || current?.values.model || editing,
      confirm: T('\u653e\u5f03\u66f4\u6539', 'Discard changes'), cancel: T('\u7ee7\u7eed\u7f16\u8f91', 'Keep editing'), danger: true })) return;
    setEditing(item.key); setModel(item.values.model || ''); setName(item.values.name || ''); setContext(String(item.values.context_win ?? ''));
  };
  const save = async () => {
    if (!current || disabled || !dirty || !model.trim()) return;
    const values: ModelValues & { provider?: string } = { name: name.trim(), model: model.trim(), provider };
    if (context) values.context_win = Number(context);
    if (await onSave('save', current.key, values)) setEditing('');
  };
  const remove = async (item: ModelEntry) => {
    if (await confirmDialog({ title: T('\u5220\u9664\u8fd9\u4e2a\u6a21\u578b\uff1f', 'Delete this model?'), message: item.values.name || item.values.model || item.key, danger: true, confirm: T('\u5220\u9664', 'Delete') })
      && await onSave('delete', item.key) && editing === item.key) setEditing('');
  };
  // Enter must not submit the surrounding provider form.
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); void save(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(''); }
  };
  return <div className="model-owned wide">
    <div className="model-remote-head">
      <strong>{T('\u5df2\u6dfb\u52a0\u7684\u6a21\u578b', 'Configured models')} ({models.length})</strong>
      <button type="button" className="secondary" disabled={disabled} onClick={onAdd}>{T('+ \u624b\u52a8\u6dfb\u52a0', '+ Add manually')}</button>
    </div>
    {!models.length ? <p className="model-empty">{T('\u8fd8\u6ca1\u6709\u6a21\u578b\uff0c\u53ef\u4ece\u4e0b\u65b9\u83b7\u53d6\u5217\u8868\u6279\u91cf\u6dfb\u52a0\uff0c\u6216\u624b\u52a8\u6dfb\u52a0\u3002', 'No models yet. Fetch the list below to add in bulk, or add one manually.')}</p>
      : <ul className="model-owned-list">{models.map(item => item.key === editing ? <li key={item.key} className="is-editing" onKeyDown={keys}>
        <div className="model-owned-fields">
          <label className="model-field">{T('\u6a21\u578b ID', 'Model ID')}<input required autoFocus value={model} disabled={disabled} spellCheck={false} autoComplete="off" onChange={event => setModel(event.target.value)} /></label>
          <label className="model-field">{T('\u663e\u793a\u540d\u79f0', 'Display name')}<input value={name} disabled={disabled} maxLength={120} placeholder={model || T('\u9ed8\u8ba4\u4f7f\u7528\u6a21\u578b ID', 'Defaults to model ID')} onChange={event => setName(event.target.value)} /></label>
          <label className="model-field">{T('\u4e0a\u4e0b\u6587\u7a97\u53e3', 'Context window')}<input type="number" min={1024} step={1} value={context} disabled={disabled} placeholder={T('\u9ed8\u8ba4', 'Default')} onChange={event => setContext(event.target.value)} /></label>
        </div>
        <div className="model-owned-actions">
          <button type="button" className="danger" disabled={disabled} onClick={() => { void remove(item); }}>{T('\u5220\u9664', 'Delete')}</button>
          <button type="button" className="model-text-button" disabled={disabled} onClick={() => onOpen(item.key)}>{T('\u66f4\u591a\u8bbe\u7f6e', 'More settings')}</button>
          <span />
          <button type="button" className="secondary" onClick={() => setEditing('')}>{T('\u53d6\u6d88', 'Cancel')}</button>
          <button type="button" disabled={disabled || !dirty || !model.trim()} onClick={() => { void save(); }}>{T('\u4fdd\u5b58', 'Save')}</button>
        </div>
      </li> : <li key={item.key} className="model-owned-item">
        <button type="button" className="model-owned-row" disabled={disabled} title={T('\u70b9\u51fb\u7f16\u8f91', 'Click to edit')} onClick={() => { void start(item); }}>
          <strong>{item.values.name || item.values.model || item.key}</strong>
          {item.values.name && item.values.model && item.values.name !== item.values.model && <code>{item.values.model}</code>}
          {item.values.context_win ? <small>{Math.round(Number(item.values.context_win) / 1000)}K</small> : null}
          <span className="model-owned-edit" aria-hidden="true">{T('\u7f16\u8f91', 'Edit')}</span>
        </button>
        <button type="button" className="model-owned-delete" disabled={disabled} title={T('\u5220\u9664', 'Delete')}
          aria-label={T('\u5220\u9664 ', 'Delete ') + (item.values.name || item.values.model || item.key)} onClick={() => { void remove(item); }}>{T('\u5220\u9664', 'Delete')}</button>
      </li>)}</ul>}
  </div>;
}
