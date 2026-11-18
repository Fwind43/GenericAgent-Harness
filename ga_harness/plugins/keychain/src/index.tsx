import { useState } from 'react';
import { type PluginAPI, T, SettingsPanel, useOperation, confirmDialog, promptDialog, defineReact } from '@gah/sdk';

interface Item { name: string; length: number }
interface Status { path: string; exists: boolean; items: Item[]; error: string }

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function KeychainPanel({ api }: { api: PluginAPI }) {
  const [data, setData] = useState<Status | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState('');
  const { working, run } = useOperation(api, true);

  async function load() { setData(await api.get<Status>('')); }
  const post = (body: Record<string, unknown>) => run(async () => { setData(await api.post<Status>('', body)); });

  const names = new Set((data?.items ?? []).map(i => i.name));
  const nameOk = NAME_RE.test(name.trim());
  const blocked = !!data?.error;

  async function save() {
    const key = name.trim();
    if (names.has(key) && key !== replacing && !(await confirmDialog({
      title: T('覆盖密钥', 'Overwrite secret'), danger: true,
      message: T(`「${key}」已存在，确定用新值覆盖？`, `"${key}" already exists. Overwrite it with the new value?`) }))) return;
    if (await post({ action: 'set', name: key, value })) { setName(''); setValue(''); setReplacing(''); }
  }

  async function remove(key: string) {
    if (!(await confirmDialog({ title: T('删除密钥', 'Delete secret'), danger: true,
      message: T(`删除「${key}」后，使用它的插件和工具将无法读取。确定删除？`, `Plugins and tools that use "${key}" will no longer be able to read it. Delete it?`) }))) return;
    await post({ action: 'delete', name: key });
  }

  async function rename(key: string) {
    const next = await promptDialog({ title: T('重命名密钥', 'Rename secret'), value: key,
      message: T('新名称：字母开头，仅字母、数字和下划线。', 'New name: starts with a letter; letters, digits and _ only.') });
    if (next === null || next.trim() === key) return;
    if (!NAME_RE.test(next.trim())) { api.notice(T('名称不合法', 'Invalid name')); return; }
    await post({ action: 'rename', name: key, new_name: next.trim() });
  }

  function startReplace(key: string) { setReplacing(key); setName(key); setValue(''); }

  return <SettingsPanel api={api} label={T('密钥串', 'Keychain')} icon="key" order={43} className="kc-dialog" onOpen={load}>
    <div className="kc-head"><div>
      <h3>{T('GA 密钥串', 'GA keychain')}</h3>
      <p className="kc-muted">{T('管理 GenericAgent 的密钥串，插件和工具可按名称读取密钥（例如生图插件的 key_name）。密钥值只写不读，不会显示在此页面。',
        'Manage the GenericAgent keychain. Plugins and tools read secrets by name (for example the image plugin\'s key_name). Values are write-only and never shown here.')}</p>
    </div><button type="button" className="btn" disabled={working} onClick={() => void run(load)}>{T('刷新', 'Refresh')}</button></div>

    {data && <p className="kc-muted kc-path">{T('文件', 'File')}: <code>{data.path}</code>{!data.exists && <> · {T('尚未创建，保存第一个密钥时创建', 'not created yet; created on first save')}</>}</p>}
    {blocked && <p className="kc-error">{data!.error}<br />{T('为避免覆盖已有密钥，已禁止写入。', 'Writes are disabled to avoid overwriting existing secrets.')}</p>}

    <div className="kc-list">
      {data && !data.items.length && !blocked && <p className="kc-muted">{T('还没有密钥。', 'No secrets yet.')}</p>}
      {data?.items.map(item => <div className="kc-row" key={item.name}>
        <code className="kc-name">{item.name}</code>
        <span className="kc-muted kc-len">{'•'.repeat(Math.min(item.length, 12))} {T(`${item.length} 字符`, `${item.length} chars`)}</span>
        <span className="kc-actions">
          <button type="button" className="btn" disabled={working || blocked} onClick={() => startReplace(item.name)}>{T('替换', 'Replace')}</button>
          <button type="button" className="btn" disabled={working || blocked} onClick={() => void rename(item.name)}>{T('重命名', 'Rename')}</button>
          <button type="button" className="btn danger" disabled={working || blocked} onClick={() => void remove(item.name)}>{T('删除', 'Delete')}</button>
        </span>
      </div>)}
    </div>

    <form className="kc-form" autoComplete="off" onSubmit={e => { e.preventDefault(); if (nameOk && value.trim()) void save(); }}>
      <h4>{replacing ? T(`替换「${replacing}」`, `Replace "${replacing}"`) : T('添加密钥', 'Add secret')}</h4>
      <label>{T('名称', 'Name')}
        <input value={name} disabled={working || blocked || !!replacing} spellCheck={false} placeholder="openai_key"
          onChange={e => setName(e.target.value)} />
      </label>
      {name.trim() && !nameOk && <span className="kc-error">{T('字母开头，仅字母、数字和下划线，最多 64 个字符。', 'Start with a letter; letters, digits and _ only; up to 64 chars.')}</span>}
      <label>{T('值', 'Value')}
        <input type="password" value={value} disabled={working || blocked} autoComplete="new-password" spellCheck={false}
          onChange={e => setValue(e.target.value)} />
      </label>
      <div className="kc-buttons">
        {replacing && <button type="button" className="btn" disabled={working} onClick={() => { setReplacing(''); setName(''); setValue(''); }}>{T('取消', 'Cancel')}</button>}
        <button type="submit" className="btn primary" disabled={working || blocked || !nameOk || !value.trim()}>{T('保存', 'Save')}</button>
      </div>
    </form>
  </SettingsPanel>;
}

defineReact('keychain', KeychainPanel);
