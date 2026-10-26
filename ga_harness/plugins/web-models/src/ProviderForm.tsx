import { useState } from 'react';
import { T, type ProviderEntry } from '@gah/sdk';
import { Credentials, Field, Protocol, type SaveModel } from './ModelForm';

export function ProviderForm({ entry, used, disabled, onSave }: { entry?: ProviderEntry; used: number; disabled: boolean; onSave: SaveModel }) {
  const [id, setId] = useState(entry?.id || ''), [name, setName] = useState(entry?.values.name || '');
  const [protocol, setProtocol] = useState(entry?.values.protocol || 'oai');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  return <form className="model-provider-form" onSubmit={event => { event.preventDefault(); if (!disabled) onSave('provider_save', id.trim(), { name: name.trim(), protocol, apibase: base.trim(), apikey: secret }); }}>
    <div className="model-grid">
      <Field label={T('\u670d\u52a1\u5546\u6807\u8bc6', 'Provider ID')}><input required pattern="[a-z0-9_-]+" disabled={disabled || !!entry} value={id} onChange={event => setId(event.target.value)} autoFocus={!entry} /></Field>
      <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input disabled={disabled} value={name} onChange={event => setName(event.target.value)} /></Field>
      <Protocol value={protocol} disabled={disabled} onChange={setProtocol} />
      <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} />
    </div>
    <p className="model-help">{used ? T('\u4ecd\u6709\u6a21\u578b\u5f15\u7528\u6b64\u670d\u52a1\u5546\uff0c\u4e0d\u80fd\u5220\u9664\u3002', 'This provider is still used by models and cannot be deleted.') : T('\u9ed8\u8ba4\u534f\u8bae\u4ec5\u7528\u4e8e\u65b0\u6a21\u578b\uff0c\u4e0d\u4f1a\u6539\u53d8\u5df2\u6709\u6a21\u578b\u3002', 'The default protocol is for new models and does not change existing models.')}</p>
    <div className="model-actions"><button type="submit" disabled={disabled}>{T('\u4fdd\u5b58\u5e76\u751f\u6548', 'Save and apply')}</button><button type="button" className="danger" disabled={disabled || !entry || used > 0} onClick={() => { if (window.confirm(T('\u5220\u9664\u8fd9\u4e2a\u670d\u52a1\u5546\uff1f', 'Delete this provider?'))) onSave('provider_delete', id); }}>{T('\u5220\u9664', 'Delete')}</button></div>
  </form>;
}
