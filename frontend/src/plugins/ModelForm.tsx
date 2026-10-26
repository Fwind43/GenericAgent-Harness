import { useState, type ReactNode } from 'react';
import { T } from '../i18n';
import type { ModelConfig, ModelEntry, ModelValues, ProviderEntry } from '../types';

export function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={'model-field' + (wide ? ' wide' : '')}>{label}{children}</label>;
}
export function Credentials({ base, secret, hasKey, hiddenURL, disabled, onBase, onSecret }: {
  base: string; secret: string; hasKey?: boolean; hiddenURL?: boolean; disabled: boolean;
  onBase: (value: string) => void; onSecret: (value: string) => void;
}) {
  return <>
    <Field label="API Base URL" wide><input required disabled={disabled} value={base} autoComplete="off" onChange={e => onBase(e.target.value)} />
      <small>{hiddenURL ? T('\u539f URL \u542b\u654f\u611f\u4fe1\u606f\u5df2\u9690\u85cf\uff0c\u8bf7\u91cd\u65b0\u586b\u5199\u3002', 'The original URL contained sensitive data and is hidden. Enter it again.') : T('\u652f\u6301 ${ENV_NAME} \u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002', 'Supports ${ENV_NAME} environment variable references.')}</small></Field>
    <Field label="API Key" wide><input type="password" autoComplete="new-password" required={!hasKey} disabled={disabled} value={secret} placeholder={hasKey ? '******' : ''} onChange={e => onSecret(e.target.value)} />
      <small>{hasKey ? T('\u7559\u7a7a\u4fdd\u7559\u539f\u5bc6\u94a5\u6216\u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002', 'Leave empty to keep the existing key or environment variable reference.') : T('\u586b\u5199\u5bc6\u94a5\u6216 ${ENV_NAME}\u3002', 'Enter a key or ${ENV_NAME}.')}</small></Field>
  </>;
}
export function Protocol({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Field label={T('\u534f\u8bae', 'Protocol')}><select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="oai">OpenAI compatible</option><option value="claude">Anthropic Claude</option></select></Field>;
}
export type SaveModel = (action: string, id: string, values?: ModelValues & { provider?: string }) => void;
export function ModelForm({ entry, config, initialProvider = '', disabled, onSave }: {
  entry?: ModelEntry; config: ModelConfig; initialProvider?: string; disabled: boolean; onSave: SaveModel;
}) {
  const [protocol, setProtocol] = useState(entry?.protocol || 'oai');
  const [id, setId] = useState(entry?.key || 'native_oai_config_' + Date.now());
  const [provider, setProvider] = useState(entry?.provider || initialProvider);
  const [name, setName] = useState(entry?.values.name || ''), [model, setModel] = useState(entry?.values.model || '');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  const [context, setContext] = useState(String(entry?.values.context_win ?? ''));
  return <form className="model-form" onSubmit={event => {
    event.preventDefault(); if (disabled) return;
    const values: ModelValues & { provider?: string } = provider ? { name: name.trim(), model: model.trim(), provider } : { name: name.trim(), model: model.trim(), apibase: base.trim(), apikey: secret };
    if (context) values.context_win = Number(context);
    onSave('save', id.trim(), values);
  }}>
    <h3>{entry ? T('\u6a21\u578b\u8be6\u60c5', 'Model details') : T('\u65b0\u589e\u6a21\u578b', 'Add model')}</h3>
    <div className="model-grid">
      <Protocol value={protocol} disabled={disabled || !!entry} onChange={value => { setProtocol(value); setId('native_' + value + '_config_' + Date.now()); }} />
      <Field label={T('\u914d\u7f6e\u6807\u8bc6', 'Config key')}><input required value={id} disabled={disabled || !!entry} onChange={event => setId(event.target.value)} /></Field>
      <Field label={T('\u670d\u52a1\u5546', 'Provider')} wide><select disabled={disabled} value={provider} onChange={event => setProvider(event.target.value)}><option value="">{T('\u72ec\u7acb\u914d\u7f6e', 'Standalone')}</option>{config.providers.map(item => <option key={item.id} value={item.id}>{item.values.name || item.id}</option>)}</select><small>{T('\u534f\u8bae\u5c5e\u4e8e\u6a21\u578b\uff0c\u670d\u52a1\u5546\u5171\u4eab URL \u548c\u5bc6\u94a5\u3002', 'Protocol belongs to the model; providers share the URL and key.')}</small></Field>
      <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></Field>
      <Field label={T('\u6a21\u578b\u540d', 'Model name')}><input required value={model} disabled={disabled} onChange={event => setModel(event.target.value)} /></Field>
      <Field label={T('\u4e0a\u4e0b\u6587\u7a97\u53e3', 'Context window')}><input type="number" min={1} step={1} value={context} disabled={disabled} onChange={event => setContext(event.target.value)} /></Field>
      {!provider && <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} />}
    </div>
    <div className="model-actions"><button type="submit" disabled={disabled}>{T('\u4fdd\u5b58\u5e76\u751f\u6548', 'Save and apply')}</button><button type="button" className="danger" disabled={disabled || !entry} onClick={() => { if (window.confirm(T('\u5220\u9664\u8fd9\u4e2a\u6a21\u578b\uff1f', 'Delete this model?'))) onSave('delete', id); }}>{T('\u5220\u9664', 'Delete')}</button></div>
  </form>;
}
