import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { T, confirmDialog, matches, type ModelConfig, type ModelEntry, type ModelValues, type MixinValues } from '@gah/sdk';
import { endpoint, providerNames } from './helpers';
import { useModelOptions, type FetchModels } from './RemoteModels';
import { AdvancedOptions, useOptions, type OptionValue } from './AdvancedOptions';

export function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={'model-field' + (wide ? ' wide' : '')}>{label}{children}</label>;
}
export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="model-section"><header><h4>{title}</h4>{hint && <p>{hint}</p>}</header><div className="model-grid">{children}</div></section>;
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
export type SaveModel = (action: string, id: string, values?: ModelValues & MixinValues & { provider?: string; options?: Record<string, OptionValue | null> }) => void;
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
export function ModelForm({ entry, config, initialProvider = '', disabled, onSave, onDirtyChange, onReset, onProvider, fetchModels }: {
  entry?: ModelEntry; config: ModelConfig; initialProvider?: string; disabled: boolean; onSave: SaveModel;
  onDirtyChange: (dirty: boolean) => void; onReset: () => void; onProvider: (id: string) => void; fetchModels: FetchModels;
}) {
  const options = useModelOptions(fetchModels), names = providerNames(config);
  const defaultProtocol = config.providers.find(item => item.id === initialProvider)?.values.protocol || 'oai';
  const [protocol, setProtocol] = useState(entry?.protocol || defaultProtocol);
  const [id, setId] = useState(entry?.key || 'native_' + protocol + '_config_' + Date.now());
  const [provider, setProvider] = useState(entry ? entry.provider || '' : initialProvider);
  const [name, setName] = useState(entry?.values.name || ''), [model, setModel] = useState(entry?.values.model || '');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  const [context, setContext] = useState(String(entry?.values.context_win ?? ''));
  const [suggest, setSuggest] = useState(false);
  const opts = useOptions(entry?.options);
  const shared = config.providers.find(item => item.id === provider);
  const dirty = useDraft([protocol, id, provider, name, model, base, secret, context, opts.draft], onDirtyChange);
  const changeProtocol = (value: string) => { setProtocol(value); setId('native_' + value + '_config_' + Date.now()); };
  const canFetch = !!provider || !!base.trim() || !!entry;
  const fetchList = () => { setSuggest(true); void options.load(provider ? { provider } : { key: entry?.key, apibase: base.trim(), apikey: secret, protocol }); };
  const exact = options.items.some(item => item.id === model);
  const visible = options.items.filter(item => !model || exact || matches(model, item.id, item.name)).slice(0, 50);
  return <form className="model-form" onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')} onSubmit={event => {
    event.preventDefault(); if (disabled) return;
    const values: Parameters<SaveModel>[2] & {} = provider ? { name: name.trim(), model: model.trim(), provider }
      : { name: name.trim(), model: model.trim(), provider: '', apibase: base.trim(), apikey: secret };
    if (context) values.context_win = Number(context);
    const changed = opts.diff(); if (Object.keys(changed).length) values.options = changed;
    onSave('save', id.trim(), values);
  }}>
    <div className="model-form-content">
      <Section title={T('\u8fde\u63a5', 'Connection')} hint={T('\u6a21\u578b\u4ece\u54ea\u91cc\u8c03\u7528\u3002\u9009\u62e9\u670d\u52a1\u5546\u53ef\u5171\u7528\u5730\u5740\u548c\u5bc6\u94a5\u3002', 'Where this model is called. Pick a provider to share its URL and key.')}>
        <Field label={T('\u670d\u52a1\u5546', 'Provider')}><select value={provider} disabled={disabled} onChange={event => {
          const value = event.target.value; setProvider(value);
          if (!entry && value) changeProtocol(config.providers.find(item => item.id === value)?.values.protocol || 'oai');
        }}><option value="">{T('\u4e0d\u4f7f\u7528\u670d\u52a1\u5546\uff08\u5355\u72ec\u586b\u5199\uff09', 'None (enter URL and key)')}</option>{config.providers.map(item => <option key={item.id} value={item.id}>{names.get(item.id)}</option>)}</select></Field>
        <Protocol value={protocol} disabled={disabled || !!entry} onChange={changeProtocol} />
        {shared ? <div className="model-connection wide">
          <div><strong>{names.get(shared.id)}</strong><span>{endpoint(shared.values.apibase)}{' \u00b7 '}{shared.has_key ? T('\u5bc6\u94a5\u5df2\u914d\u7f6e', 'Key configured') : T('\u672a\u914d\u7f6e\u5bc6\u94a5', 'No key')}</span></div>
          <button type="button" className="secondary" disabled={disabled} onClick={() => onProvider(shared.id)}>{T('\u7f16\u8f91\u670d\u52a1\u5546', 'Edit provider')}</button>
        </div> : <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} />}
      </Section>
      <Section title={T('\u6a21\u578b', 'Model')}>
        <div className="model-field wide">
          <label htmlFor="model-id-input">{T('\u6a21\u578b ID', 'Model ID')}</label>
          <div className="model-id-row">
            <input id="model-id-input" required value={model} disabled={disabled} autoFocus={!entry} autoComplete="off" placeholder="gpt-4.1 / claude-sonnet-4" spellCheck={false}
              onFocus={() => setSuggest(true)} onChange={event => { setModel(event.target.value); setSuggest(true); }} />
            <button type="button" className="secondary" disabled={disabled || options.loading || !canFetch} title={canFetch ? '' : T('\u5148\u9009\u62e9\u670d\u52a1\u5546\u6216\u586b\u5199 API \u5730\u5740', 'Choose a provider or enter an API URL first')} onClick={fetchList}>
              {options.loading ? T('\u83b7\u53d6\u4e2d\u2026', 'Fetching\u2026') : options.items.length ? T('\u91cd\u65b0\u83b7\u53d6', 'Refresh') : T('\u4ece\u670d\u52a1\u5546\u83b7\u53d6', 'Fetch from provider')}
            </button>
          </div>
          {options.error ? <small className="model-error">{options.error}</small>
            : options.items.length ? <small>{T('\u670d\u52a1\u5546\u8fd4\u56de ' + options.items.length + ' \u4e2a\u6a21\u578b\uff0c\u8f93\u5165\u53ef\u7b5b\u9009\uff0c\u70b9\u51fb\u9009\u7528', options.items.length + ' models available; type to filter, click to use')}</small>
            : <small>{T('\u4f20\u7ed9\u63a5\u53e3\u7684 model \u53c2\u6570\uff0c\u53ef\u624b\u52a8\u586b\u5199\u6216\u4ece\u670d\u52a1\u5546\u83b7\u53d6\u3002', 'The model parameter sent to the API. Type it or fetch from the provider.')}</small>}
          {suggest && options.items.length > 0 && <div className="model-suggest" role="listbox" aria-label={T('\u53ef\u7528\u6a21\u578b', 'Available models')}>
            {visible.length ? visible.map(item => <button type="button" role="option" key={item.id} aria-selected={item.id === model} disabled={disabled}
              onClick={() => { setModel(item.id); setSuggest(false); }}><span>{item.id}</span>{item.name && item.name !== item.id && <small>{item.name}</small>}</button>)
              : <p>{T('\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b\uff0c\u5c06\u4f7f\u7528\u8f93\u5165\u7684 ID', 'No match; the typed ID will be used')}</p>}
          </div>}
        </div>
        <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input value={name} disabled={disabled} maxLength={120} placeholder={model || T('\u9ed8\u8ba4\u4f7f\u7528\u6a21\u578b ID', 'Defaults to model ID')} onChange={event => setName(event.target.value)} /></Field>
        <Field label={T('\u4e0a\u4e0b\u6587\u7a97\u53e3', 'Context window')}><input type="number" min={1024} step={1} value={context} disabled={disabled} placeholder={T('\u9ed8\u8ba4', 'Default')} onChange={event => setContext(event.target.value)} /></Field>
      </Section>
      <details className="model-advanced">
        <summary>{T('\u9ad8\u7ea7', 'Advanced')}</summary>
        <div className="model-grid">
          <Field label={T('\u914d\u7f6e\u6807\u8bc6', 'Config key')} wide><input required value={id} readOnly={!!entry} disabled={disabled} spellCheck={false} onChange={event => setId(event.target.value)} /><small>{T('mykey.py \u4e2d\u7684\u53d8\u91cf\u540d\uff0c\u521b\u5efa\u540e\u4e0d\u53ef\u4fee\u6539\u3002', 'Variable name in mykey.py; fixed after creation.')}</small></Field>
        </div>
        <AdvancedOptions protocol={protocol} draft={opts.draft} hidden={entry?.options_hidden} disabled={disabled} onChange={opts.set} />
      </details>
    </div>
    <FormActions dirty={dirty} existing={!!entry} disabled={disabled} onReset={onReset} onDelete={async () => {
      if (await confirmDialog({ title: T('\u5220\u9664\u8fd9\u4e2a\u6a21\u578b\uff1f', 'Delete this model?'), message: entry?.values.name || entry?.values.model || id, danger: true, confirm: T('\u5220\u9664', 'Delete') })) onSave('delete', id);
    }} />
  </form>;
}
