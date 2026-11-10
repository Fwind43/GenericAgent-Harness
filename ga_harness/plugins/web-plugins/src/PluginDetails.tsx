import { Fragment, useState } from 'react';
import { T, type Json, type PluginInfo, type PluginInstallJob } from '@gah/sdk';
import { descriptionOf, PluginTags, stateLabel, Switch } from './helpers';

export type PluginChange = (action: 'save' | 'reset', enabled?: boolean, config?: Record<string, Json>) => void;
// Package index presets; an empty URL keeps the installer's default (PyPI / pip config).
const MIRRORS: [string, string][] = [
  ['https://pypi.tuna.tsinghua.edu.cn/simple', '\u6e05\u534e Tsinghua'],
  ['https://mirrors.aliyun.com/pypi/simple/', '\u963f\u91cc\u4e91 Aliyun'],
  ['https://mirrors.cloud.tencent.com/pypi/simple', '\u817e\u8baf\u4e91 Tencent'],
  ['https://pypi.mirrors.ustc.edu.cn/simple', '\u4e2d\u79d1\u5927 USTC'],
];
export function PluginDetails({ plugin, busy, running, error, onChange, onToggle, onInstall, job, installing = false, packageIndex = '' }: {
  plugin: PluginInfo; busy: boolean; running: boolean; error: string; onChange: PluginChange; onToggle?: (enabled: boolean) => void;
  onInstall?: (indexUrl: string) => void; job?: PluginInstallJob | null; installing?: boolean; packageIndex?: string;
}) {
  const [enabled, setEnabled] = useState(plugin.enabled);
  const [mirror, setMirror] = useState(packageIndex);
  const [values, setValues] = useState<Record<string, Json>>({ ...plugin.config });
  const locked = busy || running || plugin.protected;
  const update = (key: string, value: Json) => setValues(previous => ({ ...previous, [key]: value }));
  const warning = [plugin.missing?.length ? T('\u5f53\u524d\u7f3a\u5c11\uff1a', 'Missing: ') + plugin.missing.join(', ') : '',
    plugin.missing_packages?.length ? T('\u7f3a\u5c11 Python \u5305\uff1a', 'Missing Python packages: ') + plugin.missing_packages.join(', ') : '', plugin.error].filter(Boolean).join('; ');
  const submit = () => {
    if (locked) return;
    const config: Record<string, Json> = {};
    for (const [key, spec] of Object.entries(plugin.fields)) {
      const value = values[key] ?? '';
      if (spec.type === 'boolean') config[key] = !!value;
      else if (value !== '' || spec.type === 'string') config[key] = spec.type === 'integer' ? Number(value) : value;
    }
    onChange('save', enabled, config);
  };
  return <div className="plugin-detail-card">
    <div className="plugin-detail-head"><h3 className="plugin-title">{plugin.name}</h3>{plugin.version && <span className="plugin-version">{'v' + plugin.version.replace(/^v/i, '')}</span>}<span className="plugin-badge plugin-status" data-state={plugin.state}>{stateLabel(plugin)}</span></div>
    <div className="plugin-tags"><PluginTags plugin={plugin} /></div>
    <p className="plugin-description">{descriptionOf(plugin) || T('\u6682\u65e0\u8bf4\u660e', 'No description')}</p>
    <dl className="plugin-deps">{([
      ['requires', T('\u4f9d\u8d56\u80fd\u529b', 'Requires')], ['provides', T('\u63d0\u4f9b\u80fd\u529b', 'Provides')], ['dependents', T('\u88ab\u63d2\u4ef6\u4f9d\u8d56', 'Required by')], ['packages', T('Python \u4f9d\u8d56', 'Python packages')],
    ] as const).map(([key, label]) => <Fragment key={key}><dt>{label}</dt><dd>{plugin[key]?.join(T('\u3001', ', ')) || T('\u65e0', 'None')}</dd></Fragment>)}
    {plugin.source_meta && <><dt>{T('\u5b89\u88c5\u6765\u6e90', 'Install source')}</dt><dd>{[
      plugin.source_meta.type === 'git' ? (plugin.source_meta.url || 'git') : (plugin.source_meta.filename || 'zip'),
      plugin.source_meta.commit ? plugin.source_meta.commit.slice(0, 7) : '',
      plugin.source_meta.built_frontend ? T('\u5df2\u7f16\u8bd1\u524d\u7aef', 'frontend built') : '',
    ].filter(Boolean).join(' \u00b7 ')}</dd></>}</dl>
    {!!plugin.workers?.length && <p className="plugin-note plugin-workers">{T('\u4f9d\u8d56 ', 'Depends on ') + plugin.workers.join(T('\u3001', ', ')) + T('\uff08\u4efb\u52a1\u8fdb\u7a0b\u5185\u81ea\u52a8\u52a0\u8f7d\uff09', ' (loaded automatically inside task workers)')}</p>}
    {warning && <p className="plugin-note plugin-warning">{warning}</p>}
    {!!plugin.missing_packages?.length && onInstall && <div className="plugin-actions plugin-install">
      <label className="plugin-mirror"><span>{T('\u955c\u50cf\u6e90', 'Package index')}</span>
        <input type="url" list="gah-pip-mirrors" value={mirror} placeholder={T('\u9ed8\u8ba4\uff08PyPI / pip \u914d\u7f6e\uff09', 'Default (PyPI / pip config)')} disabled={busy || installing} onChange={event => setMirror(event.target.value.trim())} />
        <datalist id="gah-pip-mirrors">{MIRRORS.map(([url, label]) => <option key={url} value={url}>{label}</option>)}</datalist></label>
      <button type="button" className="secondary plugin-install-button" disabled={busy || running || installing} onClick={() => onInstall(mirror)}>{installing && job ? T('\u5b89\u88c5\u4e2d...', 'Installing...') : T('\u5b89\u88c5\u4f9d\u8d56\uff08pip\uff09', 'Install packages (pip)')}</button>
      <small>{installing && !job ? T('\u53e6\u4e00\u4e2a\u63d2\u4ef6\u6b63\u5728\u5b89\u88c5\u4f9d\u8d56', 'Another plugin is installing packages') : T('\u540e\u53f0\u5b89\u88c5\uff0c\u53ef\u5173\u95ed\u9762\u677f\uff1b\u5b8c\u6210\u540e\u91cd\u65b0\u542f\u7528\u6216\u4e0b\u6b21\u542f\u52a8\u751f\u6548', 'Runs in the background; you can close this panel. Re-enable or restart to apply')}</small></div>}
    {job && <div className="plugin-install-log" data-state={job.state}><div className="plugin-install-status">{job.state === 'running' ? T('\u6b63\u5728\u5b89\u88c5\uff1a', 'Installing: ') : job.ok ? T('\u5df2\u5b89\u88c5\uff1a', 'Installed: ') : T('\u5b89\u88c5\u5931\u8d25\uff1a', 'Failed: ')}{job.packages.join(' ')}{job.index_url && <small> ({job.index_url})</small>}</div>
      <pre ref={node => { if (node) node.scrollTop = node.scrollHeight; }}>{job.log || '...'}</pre></div>}
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="plugin-toggle plugin-enable"><Switch checked={enabled} disabled={locked} label={T('\u542f\u7528', 'Enabled')} onToggle={next => { setEnabled(next); if (plugin.hot) onToggle?.(next); }} /><span>{plugin.hot ? T('\u542f\u7528\uff08\u7acb\u5373\u751f\u6548\uff09', 'Enabled (applies immediately)') : T('\u4e0b\u6b21\u542f\u52a8\u65f6\u542f\u7528', 'Enable on next start')}</span></div>
      <div className="model-grid plugin-fields" hidden={!Object.keys(plugin.fields).length}>{Object.entries(plugin.fields).map(([key, spec]) => {
        const label = T(spec.label_zh || spec.label || key, spec.label || key);
        const common = { 'data-plugin-field': key, disabled: locked };
        const text = String(values[key] ?? '');
        return <label key={key} className={spec.type === 'boolean' ? 'plugin-toggle' : 'model-field'}>
          {spec.type !== 'boolean' && <span>{label}</span>}
          {spec.type === 'boolean' ? <><input {...common} type="checkbox" checked={!!values[key]} onChange={event => update(key, event.target.checked)} /><span>{label}</span></>
            : spec.type === 'choice' ? <select {...common} value={text} onChange={event => update(key, event.target.value)}>{spec.options?.map(option => <option key={option.value} value={option.value}>{T(option.label_zh || option.label || option.value, option.label || option.value)}</option>)}</select>
            : spec.multiline && spec.type === 'string' ? <textarea {...common} rows={4} value={text} onChange={event => update(key, event.target.value)} />
            : <input {...common} type={spec.type === 'integer' ? 'number' : 'text'} step={spec.type === 'integer' ? 1 : undefined} min={spec.min} max={spec.max} value={text} onChange={event => update(key, event.target.value)} />}
          {descriptionOf(spec) && <small>{descriptionOf(spec)}</small>}
        </label>;
      })}</div>
      <p className="plugin-note">{running ? T('\u4efb\u52a1\u8fd0\u884c\u4e2d\uff0c\u4ec5\u53ef\u67e5\u770b\u3002', 'A task is running; view only.') : plugin.protected ? T('\u57fa\u7840\u80fd\u529b\u4e0e\u524d\u7aef\u53d7\u4fdd\u62a4\uff0c\u8bf7\u901a\u8fc7\u542f\u52a8\u914d\u7f6e\u8c03\u6574\u3002', 'Core and frontend plugins are protected; change them in the startup config.') : T('\u4ec5\u663e\u793a\u516c\u5f00\u914d\u7f6e\uff1b\u5bc6\u94a5\u8bf7\u5230\u6a21\u578b\u914d\u7f6e\u4e2d\u7ba1\u7406\u3002', 'Only public settings are shown; manage keys in Models.')}</p>
      {error && <p className="gah-error" role="status">{error}</p>}
      <div className="model-actions plugin-actions"><button type="button" className="secondary plugin-reset" disabled={locked || !plugin.overridden} onClick={() => onChange('reset')}>{T('\u6062\u590d\u542f\u52a8\u914d\u7f6e', 'Restore startup settings')}</button><button type="submit" disabled={locked}>{plugin.hot ? T('\u4fdd\u5b58\u5e76\u7acb\u5373\u751f\u6548', 'Save and apply now') : T('\u4fdd\u5b58\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548', 'Save (applies on next start)')}</button></div>
    </form>
  </div>;
}
