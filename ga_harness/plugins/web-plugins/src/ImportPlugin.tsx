import { useState } from 'react';
import { type PluginCatalog, T } from '@gah/sdk';

export type ImportResult = PluginCatalog & { imported: { name: string; replaced: boolean; restart_required?: boolean; packages: string[] } };

async function send(path: string, init: RequestInit): Promise<ImportResult> {
  const response = await fetch(path, { method: 'POST', ...init });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${response.status}`);
  if (!data || !data.imported) throw new Error('Invalid JSON response');
  return data as ImportResult;
}

// Install a plugin from a zip archive or a git URL into the user plugin directory.
// The server rescans afterwards; imported plugins start disabled.
export function ImportPlugin({ disabled, run, onError, onDone }: {
  disabled: boolean;
  run: (task: () => Promise<void>, onError: (message: string) => void) => Promise<unknown> | void;
  onError: (message: string) => void;
  onDone: (result: ImportResult) => void;
}) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState<'zip' | 'git'>('zip');
  const [file, setFile] = useState<File | null>(null), [url, setUrl] = useState(''), [ref, setRef] = useState('');
  const [subdir, setSubdir] = useState(''), [replace, setReplace] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    if (mode === 'zip' && !file) return onError(T('\u8bf7\u9009\u62e9 zip \u6587\u4ef6', 'Choose a zip file'));
    if (mode === 'git' && !url.trim()) return onError(T('\u8bf7\u8f93\u5165 Git \u5730\u5740', 'Enter a git URL'));
    onError('');
    void run(async () => {
      let result: ImportResult;
      if (mode === 'zip' && file) {
        const query = new URLSearchParams();
        if (replace) query.set('replace', '1');
        if (subdir.trim()) query.set('subdir', subdir.trim());
        result = await send('/api/plugins/import' + (query.size ? '?' + query : ''), {
          headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
        });
      } else {
        result = await send('/api/plugins/import', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.trim(), ref: ref.trim() || undefined, subdir: subdir.trim() || undefined, replace }),
        });
      }
      setOpen(false); setFile(null); setUrl(''); setRef(''); setSubdir(''); setReplace(false);
      onDone(result);
    }, onError);
  };
  const [dragging, setDragging] = useState(false);
  const pick = (next: File | null | undefined) => { if (next) { setFile(next); onError(''); } };
  if (!open) return <button type="button" className="secondary plugin-import-toggle" disabled={disabled} onClick={() => setOpen(true)}>{T('\u5bfc\u5165', 'Import')}</button>;
  return <>
    <button type="button" className="secondary plugin-import-toggle" aria-pressed="true" disabled={disabled} onClick={() => { setOpen(false); onError(''); }}>{T('\u5bfc\u5165', 'Import')}</button>
    <form className="plugin-import" onSubmit={submit} aria-label={T('\u5bfc\u5165\u63d2\u4ef6', 'Import plugin')}>
      <div className="plugin-import-head">
        <strong>{T('\u5bfc\u5165\u63d2\u4ef6', 'Import plugin')}</strong>
        <div className="plugin-import-modes" role="tablist">
          {(['zip', 'git'] as const).map(key => <button key={key} type="button" role="tab" aria-selected={mode === key} disabled={disabled} onClick={() => setMode(key)}>{key === 'zip' ? T('ZIP \u6587\u4ef6', 'ZIP file') : T('Git \u5730\u5740', 'Git URL')}</button>)}
        </div>
      </div>
      {mode === 'zip'
        ? <label className="plugin-import-drop" data-dragging={dragging || undefined} data-filled={file ? true : undefined}
            onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); pick(event.dataTransfer.files?.[0]); }}>
            <input type="file" accept=".zip,application/zip" disabled={disabled} onChange={event => pick(event.target.files?.[0])} />
            <span className="plugin-import-drop-title">{file ? file.name : T('\u70b9\u51fb\u9009\u62e9\u6216\u62d6\u5165 .zip \u6587\u4ef6', 'Click to choose or drop a .zip file')}</span>
            <span className="plugin-import-drop-hint">{file ? `${(file.size / 1024).toFixed(1)} KB \u00b7 ${T('\u70b9\u51fb\u66f4\u6362', 'click to change')}` : T('\u538b\u7f29\u5305\u5185\u9700\u542b plugin.toml', 'The archive must contain plugin.toml')}</span>
          </label>
        : <div className="plugin-import-row">
            <input className="plugin-import-input" type="text" value={url} placeholder="https://github.com/owner/repo.git" aria-label={T('Git \u5730\u5740', 'Git URL')} disabled={disabled} onChange={event => setUrl(event.target.value)} />
            <input className="plugin-import-input" type="text" value={ref} placeholder={T('\u5206\u652f/\u6807\u7b7e\uff08\u53ef\u9009\uff09', 'Branch/tag (optional)')} aria-label={T('\u5206\u652f/\u6807\u7b7e', 'Branch/tag')} disabled={disabled} onChange={event => setRef(event.target.value)} />
          </div>}
      <input className="plugin-import-input" type="text" value={subdir} placeholder={T('\u5b50\u76ee\u5f55\uff08\u53ef\u9009\uff0c\u5305\u542b\u591a\u4e2a\u63d2\u4ef6\u65f6\u6307\u5b9a\uff09', 'Subdirectory (optional; when the source holds several plugins)')} aria-label={T('\u5b50\u76ee\u5f55', 'Subdirectory')} disabled={disabled} onChange={event => setSubdir(event.target.value)} />
      <label className="plugin-import-check"><input type="checkbox" checked={replace} disabled={disabled} onChange={event => setReplace(event.target.checked)} />{T('\u8986\u76d6\u540c\u540d\u7684\u5df2\u505c\u7528\u7528\u6237\u63d2\u4ef6', 'Replace a disabled user plugin with the same name')}</label>
      <div className="plugin-import-foot">
        <p className="plugin-import-warn">{T('\u4ec5\u5bfc\u5165\u53ef\u4fe1\u6765\u6e90\u7684\u63d2\u4ef6\uff1a\u63d2\u4ef6\u4ee3\u7801\u4ee5\u5f53\u524d\u7528\u6237\u6743\u9650\u8fd0\u884c\u3002\u5bfc\u5165\u540e\u9ed8\u8ba4\u672a\u542f\u7528\u3002', 'Only import plugins you trust: plugin code runs with your user permissions. Imported plugins start disabled.')}</p>
        <div className="plugin-import-actions">
          <button type="button" className="secondary" disabled={disabled} onClick={() => { setOpen(false); onError(''); }}>{T('\u53d6\u6d88', 'Cancel')}</button>
          <button type="submit" className="plugin-import-submit" disabled={disabled || (mode === 'zip' ? !file : !url.trim())}>{T('\u5bfc\u5165', 'Import')}</button>
        </div>
      </div>
    </form>
  </>;
}
