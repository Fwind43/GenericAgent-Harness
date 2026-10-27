import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { T, confirmDialog, type ModelConfig, type ModelEntry, type ModelValues } from '@gah/sdk';
import { endpoint } from './helpers';

export function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={'model-field' + (wide ? ' wide' : '')}>{label}{children}</label>;
}
export function useDraft(value: unknown, onDirtyChange: (dirty: boolean) => void) {
  const initial = useRef(JSON.stringify(value));
  const dirty = initial.current !== JSON.stringify(value);
  useLayoutEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => () => { onDirtyChange(false); }, [onDirtyChange]);
  return dirty;
}
export function Credentials({ base, secret, hasKey, hiddenURL, disabled, onBase, onSecret }: {
  base: string; secret: string; hasKey?: boolean; hiddenURL?: boolean; disabled: boolean;
  onBase: (value: string) => void; onSecret: (value: string) => void;
}) {
  const [show, setShow] = useState(false);
  return <>
    <Field label="API Base URL" wide>
      <input required disabled={disabled} value={base} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" onChange={event => onBase(event.target.value)} />
      {hiddenURL && <small>{T('\u539f URL \u542b\u654f\u611f\u4fe1\u606f\u5df2\u9690\u85cf\uff0c\u8bf7\u91cd\u65b0\u586b\u5199\u3002', 'The original URL contained sensitive data and is hidden. Enter it again.')}</small>}
    </Field>
    <div className="model-field wide">
      <label htmlFor="model-api-key">API Key</label>
      <div className="model-secret-input">
        <input id="model-api-key" type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} required={!hasKey} disabled={disabled} value={secret}
          placeholder={hasKey ? T('\u5df2\u914d\u7f6e\uff0c\u7559\u7a7a\u4e0d\u4fee\u6539', 'Configured; leave empty to keep') : T('\u5bc6\u94a5\u6216 ${ENV_NAME}', 'API key or ${ENV_NAME}')}
          onChange={event => onSecret(event.target.value)} />
        <button type="button" className="secondary" disabled={disabled} aria-pressed={show} onClick={() => setShow(!show)}>{show ? T('\u9690\u85cf', 'Hide') : T('\u663e\u793a', 'Show')}</button>
      </div>
      <small>{T('\u652f\u6301 ${ENV_NAME}\uff1b\u5df2\u4fdd\u5b58\u7684\u5bc6\u94a5\u4e0d\u4f1a\u56de\u663e\u3002', 'Supports ${ENV_NAME}; stored keys are never displayed.')}</small>
    </div>
  </>;
}
export function Protocol({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Field label={T('\u63a5\u53e3\u534f\u8bae', 'Protocol')}><select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="oai">OpenAI compatible</option><option value="claude">Anthropic Claude</option></select></Field>;
}
export type SaveModel = (action: string, id: string, values?: ModelValues & { provider?: string }) => void;
export function FormActions({ dirty, existing, disabled, canDelete = true, onReset, onDelete }: {
  dirty: boolean; existing: boolean; disabled: boolean; canDelete?: boolean; onReset: () => void; onDelete: () => void;
}) {
  return <div className="model-actions">
    {existing && <button type="button" className="danger model-delete" disabled={disabled || !canDelete} onClick={onDelete}>{T('\u5220\u9664', 'Delete')}</button>}
    <span className="model-draft-state" role="status">{dirty ? T('\u6709\u672a\u4fdd\u5b58\u7684\u66f4\u6539', 'Unsaved changes') : ''}</span>
    <button type="button" className="secondary" disabled={disabled || !dirty} onClick={onReset}>{T('\u64a4\u9500\u66f4\u6539', 'Reset changes')}</button>
    <button type="submit" disabled={disabled || (existing && !dirty)}>{T('\u4fdd\u5b58\u5e76\u751f\u6548', 'Save and apply')}</button>
  </div>;
}
export function ModelForm({ entry, config, initialProvider = '', disabled, onSave, onDirtyChange, onReset, onProvider }: {
  entry?: ModelEntry; config: ModelConfig; initialProvider?: string; disabled: boolean; onSave: SaveModel;
  onDirtyChange: (dirty: boolean) => void; onReset: () => void; onProvider: (id: string) => void;
}) {
  const defaultProtocol = config.providers.find(item => item.id === initialProvider)?.values.protocol || 'oai';
  const [protocol, setProtocol] = useState(entry?.protocol || defaultProtocol);
  const [id, setId] = useState(entry?.key || 'native_' + protocol + '_config_' + Date.now());
  const [provider, setProvider] = useState(entry ? entry.provider || '' : initialProvider);
  const [name, setName] = useState(entry?.values.name || ''), [model, setModel] = useState(entry?.values.model || '');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  const [context, setContext] = useState(String(entry?.values.context_win ?? ''));
  const shared = config.providers.find(item => item.id === provider);
  const dirty = useDraft([protocol, id, provider, name, model, base, secret, context], onDirtyChange);
  const changeProtocol = (value: string) => { setProtocol(value); setId('native_' + value + '_config_' + Date.now()); };
  return <form className="model-form" onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')} onSubmit={event => {
    event.preventDefault(); if (disabled) return;
    const values: ModelValues & { provider?: string } = provider ? { name: name.trim(), model: model.trim(), provider }
      : { name: name.trim(), model: model.trim(), provider: '', apibase: base.trim(), apikey: secret };
    if (context) values.context_win = Number(context);
    onSave('save', id.trim(), values);
  }}>
    <div className="model-form-content">
      <div className="model-grid">
        <Field label={T('\u6a21\u578b ID', 'Model ID')}><input required value={model} disabled={disabled} autoFocus={!entry} placeholder="gpt-4.1 / claude-sonnet-4" spellCheck={false} onChange={event => setModel(event.target.value)} /></Field>
        <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input value={name} disabled={disabled} maxLength={120} placeholder={T('\u53ef\u9009\uff0c\u9ed8\u8ba4\u4f7f\u7528\u6a21\u578b ID', 'Optional; defaults to model ID')} onChange={event => setName(event.target.value)} /></Field>
        <Field label={T('\u670d\u52a1\u5546', 'Provider')}><select value={provider} disabled={disabled} onChange={event => {
          const value = event.target.value; setProvider(value);
          if (!entry && value) changeProtocol(config.providers.find(item => item.id === value)?.values.protocol || 'oai');
        }}><option value="">{T('\u72ec\u7acb\u914d\u7f6e', 'Independent configuration')}</option>{config.providers.map(item => <option key={item.id} value={item.id}>{item.values.name || item.id}</option>)}</select></Field>
        <Protocol value={protocol} disabled={disabled || !!entry} onChange={changeProtocol} />
        {shared ? <div className="model-connection wide">
          <div><strong>{shared.values.name || shared.id}</strong><span>{endpoint(shared.values.apibase) || T('\u5730\u5740\u5df2\u9690\u85cf', 'URL hidden')}{' \u00b7 '}{shared.has_key ? T('\u5bc6\u94a5\u5df2\u914d\u7f6e', 'Key configured') : T('\u672a\u914d\u7f6e\u5bc6\u94a5', 'No key')}</span></div>
          <button type="button" className="secondary" disabled={disabled} onClick={() => onProvider(shared.id)}>{T('\u7f16\u8f91\u670d\u52a1\u5546', 'Edit provider')}</button>
          <small>{T('\u5730\u5740\u548c\u5bc6\u94a5\u7531\u670d\u52a1\u5546\u7edf\u4e00\u7ba1\u7406\uff0c\u534f\u8bae\u4ecd\u5c5e\u4e8e\u6b64\u6a21\u578b\u3002', 'The provider manages the URL and key; this model keeps its own protocol.')}</small>
        </div> : <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} />}
      </div>
      {!shared && <p className="model-help">{T('\u591a\u4e2a\u6a21\u578b\u5171\u7528\u5730\u5740\u548c\u5bc6\u94a5\uff1f', 'Sharing a URL and key across models?')} <button type="button" className="model-text-button" disabled={disabled} onClick={() => onProvider('')}>{T('\u53bb\u7ba1\u7406\u670d\u52a1\u5546', 'Manage providers')}</button></p>}
      <details className="model-advanced">
        <summary>{T('\u9ad8\u7ea7\u8bbe\u7f6e', 'Advanced settings')}</summary>
        <div className="model-grid">
          <Field label={T('\u4e0a\u4e0b\u6587\u7a97\u53e3', 'Context window')}><input type="number" min={1024} step={1} value={context} disabled={disabled} placeholder={T('\u9ed8\u8ba4', 'Default')} onChange={event => setContext(event.target.value)} /><small>{T('\u7559\u7a7a\u6cbf\u7528\u73b0\u6709\u503c\u6216\u9ed8\u8ba4\u503c\u3002', 'Leave empty to keep the existing value or default.')}</small></Field>
          <Field label={T('\u914d\u7f6e\u6807\u8bc6', 'Config key')}><input required value={id} readOnly={!!entry} disabled={disabled} spellCheck={false} onChange={event => setId(event.target.value)} /><small>{T('\u5185\u90e8\u6807\u8bc6\uff0c\u901a\u5e38\u65e0\u9700\u4fee\u6539\u3002', 'Internal identifier; usually no changes are needed.')}</small></Field>
        </div>
      </details>
    </div>
    <FormActions dirty={dirty} existing={!!entry} disabled={disabled} onReset={onReset} onDelete={async () => {
      if (await confirmDialog({ title: T('\u5220\u9664\u8fd9\u4e2a\u6a21\u578b\uff1f', 'Delete this model?'), message: entry?.values.name || entry?.values.model || id, danger: true, confirm: T('\u5220\u9664', 'Delete') })) onSave('delete', id);
    }} />
  </form>;
}
