import { useState } from 'react';
import { T, matches, type ModelConfig, type ModelResult } from '@gah/sdk';
import { Field } from './ModelForm';
import { errorText, type RemoteModel } from './RemoteModels';

type Post = <R>(path: string, body: unknown) => Promise<R>;
interface Template { id: string; name: string; base: string; protocol: 'oai' | 'claude' | 'auto'; key?: string; hint?: string; pick?: string[] }

/** Common providers; picking one fills the URL so beginners only paste a key. */
export const TEMPLATES: Template[] = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', protocol: 'oai', pick: ['deepseek-chat'] },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', protocol: 'oai' },
  { id: 'anthropic', name: 'Anthropic Claude', base: 'https://api.anthropic.com', protocol: 'claude' },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', protocol: 'oai' },
  { id: 'siliconflow', name: '\u7845\u57fa\u6d41\u52a8 SiliconFlow', base: 'https://api.siliconflow.cn/v1', protocol: 'oai' },
  { id: 'moonshot', name: 'Kimi / Moonshot', base: 'https://api.moonshot.cn/v1', protocol: 'oai' },
  { id: 'zhipu', name: '\u667a\u8c31 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'oai' },
  { id: 'dashscope', name: '\u963f\u91cc\u901a\u4e49 DashScope', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'oai' },
  { id: 'ollama', name: 'Ollama (\u672c\u673a)', base: 'http://localhost:11434/v1', protocol: 'oai', key: 'ollama', hint: '\u672c\u673a Ollama \u4e0d\u6821\u9a8c\u5bc6\u94a5\uff0c\u4fdd\u7559\u9ed8\u8ba4\u503c\u5373\u53ef\u3002' },
  { id: 'custom', name: '\u4e2d\u8f6c\u7ad9 / \u5176\u4ed6', base: '', protocol: 'auto', hint: '\u586b\u5199\u670d\u52a1\u5546\u7ed9\u4f60\u7684\u5730\u5740\uff0c\u534f\u8bae\u4f1a\u81ea\u52a8\u8bc6\u522b\u3002' },
];

/** Three steps: choose a service -> paste URL + key -> tick models. One atomic quick_add write. */
export function QuickAdd({ config, disabled, post, onDone, onCancel }: {
  config: ModelConfig; disabled: boolean; post: Post; onDone: (result: ModelResult, count: number) => void; onCancel: () => void;
}) {
  const [tpl, setTpl] = useState<Template | null>(null);
  const [base, setBase] = useState(''), [key, setKey] = useState(''), [show, setShow] = useState(false);
  const [protocol, setProtocol] = useState<string>('auto');
  const [models, setModels] = useState<RemoteModel[] | null>(null), [picked, setPicked] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(''), [query, setQuery] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [tested, setTested] = useState('');
  const choose = (t: Template) => { setTpl(t); setBase(t.base); setKey(t.key || ''); setProtocol(t.protocol); setModels(null); setError(''); setTested(''); };
  const step = !tpl ? 1 : models === null ? 2 : 3;
  const connect = async () => {
    setBusy('connect'); setError('');
    try {
      const out = await post<{ models: RemoteModel[]; protocol: string }>('/api/models/remote', { apibase: base.trim(), apikey: key.trim(), protocol });
      setProtocol(out.protocol || protocol); setModels(out.models || []);
      const ids = new Set((out.models || []).map(m => m.id));
      setPicked(new Set((tpl?.pick || []).filter(id => ids.has(id))));
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const chosen = () => {
    const ids = [...picked];
    for (const id of manual.split(/[\s,\uff0c]+/)) if (id && !ids.includes(id)) ids.push(id);
    return ids;
  };
  const test = async () => {
    const [model] = chosen(); if (!model) return;
    setBusy('test'); setError(''); setTested('');
    try {
      const out = await post<{ ms: number; reply: string; protocol: string }>('/api/models/test', { apibase: base.trim(), apikey: key.trim(), protocol, model });
      setProtocol(out.protocol || protocol);
      setTested(T('\u8fde\u63a5\u6210\u529f\uff1a' + model + ' \u7528\u65f6 ' + out.ms + ' ms', 'Works: ' + model + ' answered in ' + out.ms + ' ms'));
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const save = async () => {
    const ids = chosen(); if (!ids.length) return;
    const proto = protocol === 'auto' ? 'oai' : protocol, stamp = Date.now();
    setBusy('save'); setError('');
    try {
      const result = await post<ModelResult>('/api/models/config', {
        action: 'quick_add', revision: config.revision,
        provider: { values: { name: tpl && tpl.id !== 'custom' ? tpl.name : '', protocol: proto, apibase: base.trim(), apikey: key.trim() } },
        items: ids.map((model, i) => ({ key: 'native_' + proto + '_config_' + stamp + '_' + i, values: { name: model, model } })),
      });
      onDone(result, ids.length);
    } catch (e) { setError(errorText(e)); setBusy(''); }
  };
  const lock = disabled || !!busy;
  const shown = (models || []).filter(m => matches(query, m.id, m.name));
  const toggle = (id: string) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  return <div className="model-quick">
    <header className="model-quick-head">
      <h3>{T('\u5feb\u901f\u6dfb\u52a0\u6a21\u578b', 'Quick add')}</h3>
      <ol className="model-quick-steps">
        {[T('\u9009\u670d\u52a1', 'Service'), T('\u586b\u5bc6\u94a5', 'Key'), T('\u9009\u6a21\u578b', 'Models')].map((label, i) => <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step > i + 1 ? 'is-done' : ''}>{label}</li>)}
      </ol>
      <button type="button" className="secondary" onClick={onCancel}>{T('\u53d6\u6d88', 'Cancel')}</button>
    </header>
    {error && <p className="model-error" role="alert">{error}</p>}
    {step === 1 && <div className="model-quick-templates">
      {TEMPLATES.map(t => <button type="button" key={t.id} disabled={lock} onClick={() => choose(t)}>
        <strong>{t.name}</strong><span>{t.base ? t.base.replace(/^https?:\/\//, '') : T('\u81ea\u5b9a\u4e49\u5730\u5740', 'Custom URL')}</span>
      </button>)}
    </div>}
    {step === 2 && tpl && <form className="model-grid" onSubmit={event => { event.preventDefault(); void connect(); }}>
      {tpl.hint && <p className="model-quick-hint wide">{tpl.hint}</p>}
      <Field label="API Base URL" wide><input required disabled={lock} value={base} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" onChange={event => setBase(event.target.value)} /></Field>
      <div className="model-field wide">
        <label htmlFor="quick-api-key">API Key</label>
        <div className="model-secret-input">
          <input id="quick-api-key" required type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} disabled={lock} value={key} placeholder="sk-..." onChange={event => setKey(event.target.value)} />
          <button type="button" className="secondary" aria-pressed={show} onClick={() => setShow(!show)}>{show ? T('\u9690\u85cf', 'Hide') : T('\u663e\u793a', 'Show')}</button>
        </div>
        <small>{T('\u5bc6\u94a5\u53ea\u4fdd\u5b58\u5728\u672c\u673a mykey.py\uff0c\u4e0d\u4f1a\u53d1\u7ed9\u9664\u8be5\u670d\u52a1\u5546\u5916\u7684\u4efb\u4f55\u5730\u65b9\u3002', 'The key is stored only in your local mykey.py and sent only to this provider.')}</small>
      </div>
      <div className="model-quick-actions wide">
        <button type="button" className="secondary" disabled={lock} onClick={() => setTpl(null)}>{T('\u4e0a\u4e00\u6b65', 'Back')}</button>
        <button type="button" className="secondary" disabled={lock || !base.trim() || !key.trim()} onClick={() => { setModels([]); setPicked(new Set()); }}>{T('\u8df3\u8fc7\uff0c\u624b\u52a8\u586b\u6a21\u578b\u540d', 'Skip, type model names')}</button>
        <button type="submit" disabled={lock || !base.trim() || !key.trim()}>{busy === 'connect' ? T('\u8fde\u63a5\u4e2d...', 'Connecting...') : T('\u8fde\u63a5\u5e76\u83b7\u53d6\u6a21\u578b', 'Connect')}</button>
      </div>
    </form>}
    {step === 3 && <div className="model-grid">
      {models && models.length > 0 ? <div className="model-remote wide">
        <div className="model-remote-head"><strong>{T('\u52fe\u9009\u8981\u7528\u7684\u6a21\u578b\uff08' + models.length + ' \u4e2a\u53ef\u7528\uff09', 'Pick models (' + models.length + ' available)')}</strong></div>
        {models.length > 8 && <input className="model-search" type="search" value={query} placeholder={T('\u7b5b\u9009\u6a21\u578b...', 'Filter models...')} onChange={event => setQuery(event.target.value)} />}
        <ul className="model-remote-list">{shown.map(m => <li key={m.id}><label>
          <input type="checkbox" disabled={lock} checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
          <code>{m.id}</code>{m.name && m.name !== m.id && <span>{m.name}</span>}
        </label></li>)}</ul>
      </div> : <p className="model-quick-hint wide">{T('\u670d\u52a1\u5546\u6ca1\u6709\u8fd4\u56de\u6a21\u578b\u5217\u8868\uff0c\u8bf7\u5728\u4e0b\u9762\u624b\u52a8\u586b\u5199\u6a21\u578b\u540d\u3002', 'The provider did not list models; type model names below.')}</p>}
      <Field label={T('\u624b\u52a8\u586b\u5199\u6a21\u578b\u540d\uff08\u53ef\u9009\uff0c\u591a\u4e2a\u7528\u9017\u53f7\u5206\u9694\uff09', 'Model names (optional, comma separated)')} wide>
        <input disabled={lock} value={manual} spellCheck={false} placeholder="gpt-4o-mini, deepseek-chat" onChange={event => setManual(event.target.value)} />
      </Field>
      {tested && <p className="model-quick-ok wide" role="status">{tested}</p>}
      <div className="model-quick-actions wide">
        <button type="button" className="secondary" disabled={lock} onClick={() => { setModels(null); setTested(''); }}>{T('\u4e0a\u4e00\u6b65', 'Back')}</button>
        <button type="button" className="secondary" disabled={lock || !chosen().length} onClick={() => { void test(); }}>{busy === 'test' ? T('\u6d4b\u8bd5\u4e2d...', 'Testing...') : T('\u6d4b\u8bd5\u7b2c\u4e00\u4e2a\u6a21\u578b', 'Test first model')}</button>
        <button type="button" disabled={lock || !chosen().length} onClick={() => { void save(); }}>{busy === 'save' ? T('\u4fdd\u5b58\u4e2d...', 'Saving...') : T('\u6dfb\u52a0 ' + chosen().length + ' \u4e2a\u6a21\u578b', 'Add ' + chosen().length + ' models')}</button>
      </div>
    </div>}
  </div>;
}
