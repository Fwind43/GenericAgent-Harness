import { useState } from 'react';
import { T, confirmDialog, type ProviderEntry } from '@gah/sdk';
import { Credentials, Field, FormActions, Protocol, useDraft, type SaveModel } from './ModelForm';

export function ProviderForm({ entry, used, disabled, onSave, onDirtyChange, onReset, onModels }: {
  entry?: ProviderEntry; used: number; disabled: boolean; onSave: SaveModel;
  onDirtyChange: (dirty: boolean) => void; onReset: () => void; onModels: () => void;
}) {
  const [id, setId] = useState(entry?.id || ''), [name, setName] = useState(entry?.values.name || '');
  const [protocol, setProtocol] = useState(entry?.values.protocol || 'oai');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  const dirty = useDraft([id, name, protocol, base, secret], onDirtyChange);
  return <form className="model-provider-form" onSubmit={event => { event.preventDefault(); if (!disabled) onSave('provider_save', id.trim(), { name: name.trim(), protocol, apibase: base.trim(), apikey: secret }); }}>
    <div className="model-form-content">
      <div className="model-grid">
        <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input disabled={disabled} value={name} maxLength={120} placeholder={T('\u4f8b\u5982 OpenAI', 'For example, OpenAI')} onChange={event => setName(event.target.value)} autoFocus={!entry} /></Field>
        <Field label={T('\u670d\u52a1\u5546\u6807\u8bc6', 'Provider ID')}><input required pattern="[a-z0-9_-]+" disabled={disabled || !!entry} value={id} placeholder="openai" spellCheck={false} onChange={event => setId(event.target.value)} /></Field>
        <Protocol value={protocol} disabled={disabled} onChange={setProtocol} />
        <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} />
      </div>
      <p className="model-help">{T('\u5730\u5740\u548c\u5bc6\u94a5\u4f1a\u540c\u6b65\u5230\u5f15\u7528\u6b64\u670d\u52a1\u5546\u7684\u6a21\u578b\uff1b\u9ed8\u8ba4\u534f\u8bae\u53ea\u7528\u4e8e\u65b0\u6a21\u578b\u3002', 'URL and key updates apply to models using this provider; the default protocol is only for new models.')}</p>
      {entry && <div className="model-provider-usage">
        <button type="button" className="secondary" disabled={disabled} onClick={onModels}>{T('\u67e5\u770b\u6a21\u578b', 'View models')} ({used})</button>
        {used > 0 && <small>{T('\u6709\u6a21\u578b\u5f15\u7528\u65f6\u4e0d\u80fd\u5220\u9664\u670d\u52a1\u5546', 'Providers in use cannot be deleted')}</small>}
      </div>}
    </div>
    <FormActions dirty={dirty} existing={!!entry} disabled={disabled} canDelete={used === 0} onReset={onReset} onDelete={async () => {
      if (await confirmDialog({ title: T('\u5220\u9664\u8fd9\u4e2a\u670d\u52a1\u5546\uff1f', 'Delete this provider?'), message: entry?.values.name || id, danger: true, confirm: T('\u5220\u9664', 'Delete') })) onSave('provider_delete', id);
    }} />
  </form>;
}
