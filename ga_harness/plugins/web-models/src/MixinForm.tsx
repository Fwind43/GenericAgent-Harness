import { useState } from 'react';
import { T, confirmDialog, type ModelConfig, type MixinEntry } from '@gah/sdk';
import { Field, Section, FormActions, useDraft, type SaveModel } from './ModelForm';

export function MixinForm({ entry, config, disabled, onSave, onDirtyChange, onReset }: {
  entry?: MixinEntry; config: ModelConfig; disabled: boolean; onSave: SaveModel;
  onDirtyChange: (dirty: boolean) => void; onReset: () => void;
}) {
  const [id, setId] = useState(entry?.key || 'mixin_config_' + Date.now());
  const [members, setMembers] = useState<string[]>(entry?.indexed ? [] : entry?.members || []);
  const [retries, setRetries] = useState(String(entry?.values.max_retries ?? ''));
  const [delay, setDelay] = useState(String(entry?.values.base_delay ?? ''));
  const [spring, setSpring] = useState(String(entry?.values.spring_back ?? ''));
  const [error, setError] = useState('');
  const dirty = useDraft({ id, members, retries, delay, spring }, onDirtyChange);
  const models = config.entries.map(item => ({ key: item.key, name: item.values.name || item.values.model || '' }));
  const unique = models.filter(item => item.name && models.filter(other => other.name === item.name).length === 1);
  const selected = members.map(name => unique.find(item => item.name === name));
  const native = selected.find(item => item)?.key.includes('native');
  const available = unique.filter(item => !members.includes(item.name) && (native === undefined || item.key.includes('native') === native));
  const invalid = selected.some(item => !item) || new Set(members).size !== members.length
    || new Set(selected.filter(item => item).map(item => item!.key.includes('native'))).size > 1;
  const move = (index: number, offset: number) => {
    setMembers(old => { const next = [...old]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; });
  };
  return <form className="model-form" onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')} onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    if (!id.includes('mixin') || !/(api|config|cookie)/.test(id)) {
      setError(T('标识必须包含 mixin，以及 api、config 或 cookie。', 'The identifier must contain mixin and api, config or cookie.')); return;
    }
    if (invalid || members.length < 2 || members.length > 20) {
      setError(T('请选择 2–20 个名称唯一、类型兼容的模型。', 'Choose 2–20 uniquely named, compatible models.')); return;
    }
    setError('');
    onSave('mixin_save', id, { llm_nos: members, max_retries: retries === '' ? null : Number(retries), base_delay: delay === '' ? null : Number(delay), spring_back: spring === '' ? null : Number(spring) });
  }}>
    <div className="model-form-content">
      {error && <p className="model-error" role="alert">{error}</p>}
      <Section title={T('故障转移组', 'Failover group')} hint={T('第一个模型优先使用，失败后依次切换到后续模型。配置直接保存到 mykey.py。', 'The first model is preferred; failures fall back to later models in order. Saved directly to mykey.py.')}>
        <Field label={T('配置标识', 'Configuration identifier')} wide>
          <input required pattern="[A-Za-z][A-Za-z0-9_]{0,99}" value={id} disabled={disabled || !!entry} onChange={event => setId(event.target.value)} autoComplete="off" spellCheck={false} />
          <small>{T('例如 mixin_config_primary；保存后标识不可修改。', 'For example, mixin_config_primary; the identifier cannot be changed after saving.')}</small>
        </Field>
      </Section>
      <Section title={T('模型顺序', 'Model order')} hint={T('使用模型名称引用，不使用易变的数字下标。Native 与非 Native 模型不能混在同一组。', 'References use model names, not fragile numeric indices. Native and non-native models cannot be mixed in one group.')}>
        <div className="wide mixin-members">
          {entry?.indexed && <p className="model-help">{T('此组原来使用数字下标；请重新选择成员，保存后改用名称引用。', 'This group uses numeric indices. Reselect its members to save name-based references.')}</p>}
          {invalid && <p className="model-error" role="alert">{T('成员缺失、重名或类型不兼容，请移除后重新选择。', 'Some members are missing, ambiguous or incompatible. Remove and reselect them.')}</p>}
          <ol className="mixin-member-list">
            {members.map((name, index) => <li key={index}>
              <span className="mixin-member-name"><small>{index === 0 ? T('首选', 'Primary') : T('备选', 'Fallback')} {index + 1}</small><strong>{name}</strong></span>
              <div className="mixin-member-actions">
                <button type="button" className="secondary" disabled={disabled || index === 0} aria-label={T('上移 ', 'Move up ') + name} onClick={() => move(index, -1)}>↑</button>
                <button type="button" className="secondary" disabled={disabled || index === members.length - 1} aria-label={T('下移 ', 'Move down ') + name} onClick={() => move(index, 1)}>↓</button>
                <button type="button" className="secondary" disabled={disabled} aria-label={T('移除 ', 'Remove ') + name} onClick={() => setMembers(old => old.filter((_, pos) => pos !== index))}>{T('移除', 'Remove')}</button>
              </div>
            </li>)}
          </ol>
          {!members.length && <p className="model-help">{T('先添加首选模型，再添加至少一个备选模型。', 'Add a primary model, then at least one fallback.')}</p>}
          <Field label={T('添加成员', 'Add member')}>
            <select value="" disabled={disabled || members.length >= 20 || !available.length} onChange={event => { if (event.target.value) setMembers(old => [...old, event.target.value]); }}>
              <option value="">{T('选择模型…', 'Choose a model…')}</option>
              {available.map(item => <option key={item.key} value={item.name}>{item.name} · {item.key}</option>)}
            </select>
            <small>{T('仅列出名称唯一且与当前组兼容的模型；重名模型请先在模型页改名。', 'Only uniquely named, compatible models are listed. Rename duplicate models in the Models tab first.')}</small>
          </Field>
        </div>
      </Section>
      <details className="model-advanced">
        <summary>{T('重试与回切参数', 'Retry and return settings')}</summary>
        <Section title={T('可选参数', 'Optional settings')} hint={T('留空使用 GA 默认值；回切设为 0 时，下次请求立即尝试首选模型。', 'Leave empty for GA defaults; 0 retries the primary model on the next request.')}>
          <Field label={T('重试次数', 'Max retries')}><input type="number" min={0} max={20} step={1} value={retries} disabled={disabled} onChange={event => setRetries(event.target.value)} /></Field>
          <Field label={T('基础延迟（秒）', 'Base delay (seconds)')}><input type="number" min={0} max={120} step="any" value={delay} disabled={disabled} onChange={event => setDelay(event.target.value)} /></Field>
          <Field label={T('回切间隔（秒）', 'Return interval (seconds)')}><input type="number" min={0} max={86400} step={1} value={spring} disabled={disabled} onChange={event => setSpring(event.target.value)} /></Field>
        </Section>
      </details>
    </div>
    <FormActions dirty={dirty} existing={!!entry} disabled={disabled} onReset={onReset} onDelete={async () => {
      if (await confirmDialog({ title: T('删除此故障转移组？', 'Delete this failover group?'), message: id, danger: true, confirm: T('删除', 'Delete') })) onSave('mixin_delete', id);
    }} />
  </form>;
}
