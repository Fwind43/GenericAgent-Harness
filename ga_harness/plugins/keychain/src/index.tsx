import { useEffect, useRef, useState } from 'react';
import { type PluginAPI, T, SettingsPanel, useOperation, confirmDialog, promptDialog, defineReact } from '@gah/sdk';

interface Item { name: string; length: number }
interface Status { path: string; exists: boolean; items: Item[]; error: string }

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SEARCH_MIN = 6;

function RowMenu({ disabled, onRename, onDelete }: { disabled: boolean; onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return <span className="kc-more" ref={box}>
    <button type="button" className={`kc-icon-btn${open ? ' open' : ''}`} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={T('更多操作', 'More actions')} title={T('更多操作', 'More actions')} onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
    </button>
    {open && <span className="kc-menu" role="menu">
      <button type="button" role="menuitem" onClick={pick(onRename)}>{T('重命名', 'Rename')}</button>
      <button type="button" role="menuitem" className="kc-danger" onClick={pick(onDelete)}>{T('删除', 'Delete')}</button>
    </span>}
  </span>;
}

function KeychainPanel({ api }: { api: PluginAPI }) {
  const [data, setData] = useState<Status | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState('');
  const [query, setQuery] = useState('');
  const valueRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { working, run } = useOperation(api, true);

  async function load() { setData(await api.get<Status>('')); }
  const post = (body: Record<string, unknown>) => run(async () => { setData(await api.post<Status>('', body)); });

  const items = data?.items ?? [];
  const names = new Set(items.map(i => i.name));
  const nameOk = NAME_RE.test(name.trim());
  const blocked = !!data?.error;
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter(i => i.name.toLowerCase().includes(q)) : items;

  useEffect(() => {
    if (!formOpen) return;
    (replacing ? valueRef : nameRef).current?.focus();
  }, [formOpen, replacing]);

  function closeForm() { setFormOpen(false); setReplacing(''); setName(''); setValue(''); }
  function openAdd() { setReplacing(''); setName(''); setValue(''); setFormOpen(true); }
  function startReplace(key: string) { setReplacing(key); setName(key); setValue(''); setFormOpen(true); }

  async function save() {
    const key = name.trim();
    if (names.has(key) && key !== replacing && !(await confirmDialog({
      title: T('覆盖密钥', 'Overwrite secret'), danger: true,
      message: T(`「${key}」已存在，确定用新值覆盖？`, `"${key}" already exists. Overwrite it with the new value?`) }))) return;
    if (await post({ action: 'set', name: key, value })) closeForm();
  }

  async function remove(key: string) {
    if (!(await confirmDialog({ title: T('删除密钥', 'Delete secret'), danger: true,
      message: T(`删除「${key}」后，使用它的插件和工具将无法读取。确定删除？`, `Plugins and tools that use "${key}" will no longer be able to read it. Delete it?`) }))) return;
    if (replacing === key) closeForm();
    await post({ action: 'delete', name: key });
  }

  async function rename(key: string) {
    const next = await promptDialog({ title: T('重命名密钥', 'Rename secret'), value: key,
      message: T('新名称：字母开头，仅字母、数字和下划线。', 'New name: starts with a letter; letters, digits and _ only.') });
    if (next === null || next.trim() === key) return;
    if (!NAME_RE.test(next.trim())) { api.notice(T('名称不合法', 'Invalid name')); return; }
    if (replacing === key) closeForm();
    await post({ action: 'rename', name: key, new_name: next.trim() });
  }

  const form = formOpen && <form className="kc-form" autoComplete="off" onSubmit={e => { e.preventDefault(); if (nameOk && value.trim()) void save(); }}>
    <div className="kc-form-title">
      {replacing ? <>{T('替换', 'Replace')} <code>{replacing}</code> {T('的值', 'value')}</> : T('添加密钥', 'Add secret')}
    </div>
    <div className="kc-fields">
      <label>{T('名称', 'Name')}
        <input ref={nameRef} value={name} disabled={working || blocked || !!replacing} spellCheck={false} placeholder="openai_key"
          aria-invalid={!!name.trim() && !nameOk} onChange={e => setName(e.target.value)} />
      </label>
      <label>{replacing ? T('新值', 'New value') : T('值', 'Value')}
        <input ref={valueRef} type="password" value={value} disabled={working || blocked} autoComplete="new-password" spellCheck={false}
          placeholder={T('粘贴密钥值', 'Paste the secret value')} onChange={e => setValue(e.target.value)} />
      </label>
    </div>
    {name.trim() && !nameOk
      ? <span className="kc-error">{T('字母开头，仅字母、数字和下划线，最多 64 个字符。', 'Start with a letter; letters, digits and _ only; up to 64 chars.')}</span>
      : <span className="kc-hint">{replacing
        ? T('保存后旧值会被覆盖，无法恢复。', 'The old value is overwritten on save and cannot be recovered.')
        : T('保存后值不可再查看，只能替换。', 'Once saved, the value cannot be viewed again, only replaced.')}</span>}
    <div className="kc-buttons">
      <button type="button" className="btn" disabled={working} onClick={closeForm}>{T('取消', 'Cancel')}</button>
      <button type="submit" className="btn primary" disabled={working || blocked || !nameOk || !value.trim()}>{T('保存', 'Save')}</button>
    </div>
  </form>;

  return <SettingsPanel api={api} label={T('密钥串', 'Keychain')} icon="key" order={43} className="kc-dialog" onOpen={load}>
    <div className="dialog-content kc-body">
    <div className="kc-head">
      <h3>{T('GA 密钥串', 'GA keychain')}</h3>
      <p className="kc-muted">{T('插件和工具按名称读取这里的密钥（例如生图插件的 key_name）。密钥值只写不读，不会在此显示。',
        'Plugins and tools read these secrets by name (for example the image plugin\'s key_name). Values are write-only and never shown here.')}</p>
      {data && <p className="kc-muted kc-path" title={data.path}><code>{data.path}</code>{!data.exists && <> · {T('尚未创建，保存第一个密钥时创建', 'not created yet; created on first save')}</>}</p>}
    </div>

    {blocked && <p className="kc-error kc-banner">{data!.error}<br />{T('为避免覆盖已有密钥，已禁止写入。', 'Writes are disabled to avoid overwriting existing secrets.')}</p>}

    <div className="kc-toolbar">
      {items.length > SEARCH_MIN
        ? <input type="search" className="kc-search" value={query} spellCheck={false} placeholder={T(`搜索 ${items.length} 个密钥`, `Search ${items.length} secrets`)}
            aria-label={T('搜索密钥', 'Search secrets')} onChange={e => setQuery(e.target.value)} />
        : <span className="kc-count">{data ? T(`${items.length} 个密钥`, `${items.length} secrets`) : ''}</span>}
      <button type="button" className="kc-icon-btn" disabled={working} aria-label={T('刷新', 'Refresh')} title={T('刷新', 'Refresh')} onClick={() => void run(load)}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" /><path d="M13.5 2.5v3h-3" /></svg>
      </button>
      <button type="button" className="btn primary" disabled={working || blocked || (formOpen && !replacing)} onClick={openAdd}>{T('添加密钥', 'Add secret')}</button>
    </div>

    {form}

    {data && !items.length && !blocked && !formOpen && <div className="kc-empty">
      <span className="gah-ico" data-i="key" aria-hidden="true" />
      <strong>{T('还没有密钥', 'No secrets yet')}</strong>
      <span className="kc-muted">{T('添加后，插件可以通过名称引用它，而无需把明文写进配置。', 'Once added, plugins can refer to it by name instead of storing it in plain text.')}</span>
    </div>}

    {!!items.length && <div className="kc-list">
      {!shown.length && <p className="kc-muted kc-nomatch">{T(`没有名称包含「${query.trim()}」的密钥。`, `No secret names contain "${query.trim()}".`)}</p>}
      {shown.map(item => <div className={`kc-row${replacing === item.name ? ' active' : ''}`} key={item.name}>
        <code className="kc-name" title={item.name}>{item.name}</code>
        <span className="kc-len">{T(`${item.length} 字符`, `${item.length} chars`)}</span>
        <span className="kc-actions">
          <button type="button" className="btn ghost" disabled={working || blocked} onClick={() => startReplace(item.name)}>{T('替换', 'Replace')}</button>
          <RowMenu disabled={working || blocked} onRename={() => void rename(item.name)} onDelete={() => void remove(item.name)} />
        </span>
      </div>)}
    </div>}
    </div>
  </SettingsPanel>;
}

defineReact('keychain', KeychainPanel);
