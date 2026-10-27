import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type PluginAPI, useHost, T, Icon, SettingsPanel, useOperation, confirmDialog, defineReact } from '@gah/sdk';

// Channel management UI backed by the channel_manager service (see main.py).
type Field = { key: string; label: string; label_zh?: string; secret?: boolean; required?: boolean; default?: string };
type Provider = { kind: string; label: string; label_zh?: string; fields: Field[] };
type Channel = {
  id: string; name: string; provider: string; enabled: boolean; available: boolean;
  config: Record<string, string>; secrets_set: string[];
  state: string; error?: string; since?: number;
};
type Snapshot = { providers: Provider[]; channels: Channel[] };
type LogLine = { t: number; level: string; text: string };
type Editor = { kind: 'new' } | { kind: 'edit'; id: string };

const label = (x: { label: string; label_zh?: string }) => T(x.label_zh || x.label, x.label);
const time = (t: number) => new Date(t * 1000).toLocaleTimeString();
const STATES: Record<string, [string, string]> = {
  running: ['\u8fd0\u884c\u4e2d', 'Running'],
  starting: ['\u542f\u52a8\u4e2d', 'Starting'],
  stopped: ['\u5df2\u505c\u6b62', 'Stopped'],
  error: ['\u51fa\u9519', 'Error'],
  unavailable: ['\u63a5\u5165\u63d2\u4ef6\u672a\u52a0\u8f7d', 'Provider not loaded'],
};
const stateKind = (c: Channel) => c.available ? c.state : 'unavailable';
const stateText = (c: Channel) => {
  const state = stateKind(c), text = STATES[state];
  return text ? T(...text) : state;
};
function Status({ channel }: { channel: Channel }) {
  return <span className="channel-state" data-state={stateKind(channel)}>
    <i aria-hidden="true" />{stateText(channel)}
  </span>;
}

// Incremental log tail: mounted only while its disclosure is open.
function Logs({ api, id }: { api: PluginAPI; id: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const box = useRef<HTMLDivElement>(null), last = useRef(0);
  useEffect(() => {
    let stop = false;
    last.current = 0; setLines([]);
    const tick = async () => {
      try {
        const res = await api.get<{ logs: LogLine[] }>(`?logs=${encodeURIComponent(id)}&after=${last.current}`);
        if (stop || !res.logs.length) return;
        last.current = res.logs[res.logs.length - 1].t;
        setLines(prev => prev.concat(res.logs).slice(-500));
      } catch { /* transient; next tick retries */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [api, id]);
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [lines]);
  return <div className="channel-logs" ref={box} role="region" aria-label={T('\u901a\u9053\u65e5\u5fd7', 'Channel logs')} tabIndex={0}>
    {lines.length ? lines.map((line, index) => <div key={index} className="channel-log" data-level={line.level}>
      <span className="channel-log-time">{time(line.t)}</span><span className="channel-log-text">{line.text}</span>
    </div>) : <div className="channel-log-empty">{T('\u6682\u65e0\u65e5\u5fd7', 'No logs yet')}</div>}
  </div>;
}
function LogPanel({ api, id }: { api: PluginAPI; id: string }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="channel-log-panel" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span>{T('\u8fd0\u884c\u65e5\u5fd7', 'Activity logs')}</span>
      <span className="channel-log-hint">{expanded ? T('\u6bcf 2 \u79d2\u66f4\u65b0', 'Updates every 2s') : T('\u5c55\u5f00\u67e5\u770b', 'Show logs')}</span>
    </summary>
    {expanded && <Logs api={api} id={id} />}
  </details>;
}

function ChannelForm({ providers, channel, busy, onSave, onCancel }: {
  providers: Provider[]; channel?: Channel; busy: boolean;
  onSave: (body: Record<string, unknown>) => void; onCancel: () => void;
}) {
  const [kind, setKind] = useState(channel?.provider || providers[0]?.kind || '');
  const [id, setId] = useState('');
  const provider = providers.find(p => p.kind === kind);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(channel?.config || {}) }));
  const set = (key: string, value: string) => setValues(prev => ({ ...prev, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const config: Record<string, string> = {};
    for (const field of provider?.fields || []) config[field.key] = values[field.key] ?? '';
    onSave(channel ? { action: 'update', id: channel.id, config } : { action: 'create', provider: kind, id: id.trim(), config });
  };
  return <form className="channel-form" onSubmit={submit}>
    <div className="channel-section-heading">
      <h3>{channel ? T('\u7f16\u8f91\u901a\u9053', 'Edit channel') : T('\u65b0\u5efa\u901a\u9053', 'New channel')}</h3>
      <p>{channel ? T('\u66f4\u65b0\u8fde\u63a5\u914d\u7f6e\uff0c\u5df2\u4fdd\u5b58\u7684\u5bc6\u94a5\u65e0\u9700\u91cd\u65b0\u586b\u5199\u3002', 'Update the connection settings. Saved secrets can be left unchanged.')
        : T('\u9009\u62e9\u63a5\u5165\u7c7b\u578b\u5e76\u586b\u5199\u8fde\u63a5\u4fe1\u606f\uff0c\u4fdd\u5b58\u540e\u5373\u53ef\u542f\u52a8\u3002', 'Choose a provider and enter its connection settings, then save to get started.')}</p>
    </div>
    {!channel && <fieldset className="channel-provider-picker" disabled={busy}>
      <legend>{T('\u63a5\u5165\u7c7b\u578b', 'Provider')}</legend>
      <div className="channel-provider-options">{providers.map(option => <label key={option.kind} className="channel-provider-option" data-selected={kind === option.kind}>
        <input type="radio" name="channel-provider" value={option.kind} checked={kind === option.kind}
          onChange={() => { setKind(option.kind); setValues({}); }} />
        <span><strong>{label(option)}</strong><small>{option.kind}</small></span>
      </label>)}</div>
    </fieldset>}
    <div className="channel-fields">{(provider?.fields || []).map(field => {
      const stored = !!channel?.secrets_set.includes(field.key);
      return <label key={field.key} className="channel-field"><span>{label(field)}{field.required && <em aria-hidden="true">*</em>}</span>
        <input type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} disabled={busy}
          required={field.required && !(field.secret && stored)} value={values[field.key] ?? ''}
          placeholder={field.secret && stored ? T('\u5df2\u4fdd\u5b58', 'Saved') : (field.default || '')}
          onChange={event => set(field.key, event.target.value)} />
        {field.secret && stored && <small>{T('\u7559\u7a7a\u5373\u53ef\u4fdd\u7559\u73b0\u6709\u5bc6\u94a5\u3002', 'Leave empty to keep the saved secret.')}</small>}
      </label>;
    })}</div>
    {!channel && <details className="channel-advanced">
      <summary>{T('\u9ad8\u7ea7\u8bbe\u7f6e', 'Advanced settings')}</summary>
      <label className="channel-field"><span>{T('\u901a\u9053 ID', 'Channel ID')} <small>{T('\u53ef\u9009', 'Optional')}</small></span>
        <input value={id} disabled={busy} placeholder={`${kind}-xxxxxx`} pattern="[a-z0-9][a-z0-9_\-]{0,31}" maxLength={32}
          autoComplete="off" spellCheck={false} onChange={event => setId(event.target.value)} />
        <small>{T('\u7559\u7a7a\u81ea\u52a8\u751f\u6210\u3002\u53ef\u4f7f\u7528\u5c0f\u5199\u5b57\u6bcd\u3001\u6570\u5b57\u3001\u4e0b\u5212\u7ebf\u548c\u77ed\u6a2a\u7ebf\uff0c\u4ee5\u5b57\u6bcd\u6216\u6570\u5b57\u5f00\u5934\u3002', 'Generated automatically if empty. Use lowercase letters, digits, underscores or hyphens; start with a letter or digit.')}</small>
      </label>
    </details>}
    <div className="channel-form-actions">
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>{T('\u53d6\u6d88', 'Cancel')}</button>
      <button type="submit" className="btn primary" disabled={busy || !provider}>{channel ? T('\u4fdd\u5b58\u66f4\u6539', 'Save changes') : T('\u521b\u5efa\u901a\u9053', 'Create channel')}</button>
    </div>
  </form>;
}

function ChannelDetail({ api, channel, provider, busy, onAct, onEdit, onRemove }: {
  api: PluginAPI; channel: Channel; provider?: Provider; busy: boolean;
  onAct: (action: string) => void; onEdit: () => void; onRemove: () => void;
}) {
  const active = channel.state === 'running' || channel.state === 'starting';
  return <>
    <div className="channel-profile">
      <div className="channel-profile-heading"><div>
        <p className="channel-eyebrow">{provider ? label(provider) : channel.provider}</p>
        <h3>{channel.name || channel.id}</h3>
      </div><Status channel={channel} /></div>
      <div className="channel-controls">
        {active
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => onAct('stop')}>{T('\u505c\u6b62\u901a\u9053', 'Stop channel')}</button>
          : <button type="button" className="btn primary" disabled={busy || !channel.available} onClick={() => onAct('start')}>{T('\u542f\u52a8\u901a\u9053', 'Start channel')}</button>}
        <button type="button" className="btn" disabled={busy || !channel.available} onClick={() => onAct('restart')}>{T('\u91cd\u542f', 'Restart')}</button>
        {channel.since && <span className="channel-since">{T('\u72b6\u6001\u66f4\u65b0\u4e8e', 'Updated')} {new Date(channel.since * 1000).toLocaleString()}</span>}
      </div>
    </div>
    {!channel.available && <div className="channel-notice" role="status">{T('\u63a5\u5165\u63d2\u4ef6\u5c1a\u672a\u52a0\u8f7d\u3002\u8bf7\u5728\u63d2\u4ef6\u7ba1\u7406\u4e2d\u542f\u7528\u5bf9\u5e94\u63d2\u4ef6\uff0c\u5373\u53ef\u7f16\u8f91\u6216\u542f\u52a8\u6b64\u901a\u9053\u3002', 'This provider is not loaded. Enable it in Plugins to edit or start this channel.')}</div>}
    {channel.error && <div className="channel-error" role="alert">{channel.error}</div>}
    <section className="channel-config" aria-label={T('\u8fde\u63a5\u914d\u7f6e', 'Connection settings')}>
      <div className="channel-section-title"><h4>{T('\u8fde\u63a5\u914d\u7f6e', 'Connection settings')}</h4>
        <button type="button" className="btn channel-edit" disabled={busy || !channel.available} onClick={onEdit}><Icon name="pen" />{T('\u7f16\u8f91', 'Edit')}</button>
      </div>
      <dl className="channel-config-rows">
        <div><dt>{T('\u901a\u9053 ID', 'Channel ID')}</dt><dd><code>{channel.id}</code></dd></div>
        {(provider?.fields || []).map(field => <div key={field.key}>
          <dt>{label(field)}</dt><dd>{field.secret
            ? <span className="channel-secret">{channel.secrets_set.includes(field.key) ? T('\u5df2\u914d\u7f6e', 'Configured') : T('\u672a\u914d\u7f6e', 'Not configured')}</span>
            : channel.config[field.key] || <span className="channel-value-empty">{T('\u672a\u8bbe\u7f6e', 'Not set')}</span>}</dd>
        </div>)}
      </dl>
    </section>
    <LogPanel key={channel.id} api={api} id={channel.id} />
    <div className="channel-detail-footer"><button type="button" className="channel-delete" disabled={busy} onClick={onRemove}>
      <Icon name="trash" />{T('\u5220\u9664\u901a\u9053', 'Delete channel')}
    </button></div>
  </>;
}

export function ChannelManager({ api }: { api: PluginAPI }) {
  const { changing } = useHost();
  const { working, run } = useOperation(api, true);
  const [data, setData] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [editing, setEditing] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const busy = working || changing;
  const load = () => run(async () => {
    setError(''); setData(await api.get<Snapshot>(''));
  }, message => { setError(message); api.notice(message); }, true);
  const act = (body: Record<string, unknown>, after?: (snapshot: Snapshot) => void) => run(async () => {
    setError('');
    const snapshot = await api.post<Snapshot>('', body);
    setData(snapshot); after?.(snapshot);
  }, setError, true);
  const remove = async (channel: Channel) => {
    if (!(await confirmDialog({ title: T('\u5220\u9664\u901a\u9053', 'Delete channel'), danger: true,
      message: T(`\u505c\u6b62\u5e76\u5220\u9664\u901a\u9053 ${channel.id}\uff1f\u5176\u914d\u7f6e\u548c\u5bc6\u94a5\u5c06\u88ab\u6e05\u9664\u3002`, `Stop and delete channel ${channel.id}? Its config and secrets will be removed.`) }))) return;
    void act({ action: 'delete', id: channel.id }, () => setSelected(null));
  };
  const channels = data?.channels || [], providers = data?.providers || [];
  const current = channels.find(channel => channel.id === selected) || channels[0] || null;
  const edited = editing?.kind === 'edit' ? channels.find(channel => channel.id === editing.id) : undefined;
  const running = channels.filter(channel => channel.available && channel.state === 'running').length;
  const create = () => { setEditing({ kind: 'new' }); setError(''); };
  const save = (body: Record<string, unknown>) => void act(body, snapshot => {
    if (editing?.kind === 'new') {
      setSelected(snapshot.channels.find(channel => !channels.some(old => old.id === channel.id))?.id || null);
    }
    setEditing(null);
  });
  return <>
    <SettingsPanel api={api} label={T('\u901a\u9053', 'Channels')} icon="channels" order={20} className="channel-dialog" onOpen={load}>
      <div className="dialog-head channel-dialog-head"><div className="channel-heading">
        <h2>{T('\u901a\u9053\u7ba1\u7406', 'Channels')}</h2>
        <p>{channels.length ? T(`${channels.length} \u4e2a\u901a\u9053 \u00b7 ${running} \u4e2a\u8fd0\u884c\u4e2d`, `${channels.length} channels \u00b7 ${running} running`)
          : T('\u7ba1\u7406\u6d88\u606f\u63a5\u5165\u4e0e\u901a\u9053\u8fd0\u884c\u72b6\u6001', 'Manage your messaging connections')}</p>
      </div><div className="channel-header-actions">
        {!editing && channels.length > 0 && <button type="button" className="btn channel-refresh" disabled={busy} onClick={() => void load()}>{T('\u5237\u65b0', 'Refresh')}</button>}
      </div></div>
      {error && <div className="channel-error channel-page-error" role="alert">{error}</div>}
      <div className="channel-body" data-has-channels={channels.length > 0}>
        {channels.length > 0 && <aside className="channel-list" aria-label={T('\u901a\u9053\u5217\u8868', 'Channel list')}>
          <div className="channel-list-heading"><span>{T('\u5168\u90e8\u901a\u9053', 'All channels')}</span><span>{channels.length}</span></div>
          <nav className="channel-items" aria-label={T('\u9009\u62e9\u901a\u9053', 'Choose a channel')}>{channels.map(channel => {
            const provider = providers.find(option => option.kind === channel.provider);
            return <button key={channel.id} type="button" className="channel-item" disabled={busy}
              aria-pressed={!editing && current?.id === channel.id}
              onClick={() => { setSelected(channel.id); setEditing(null); setError(''); }}>
              <span className="channel-item-name">{channel.name || channel.id}</span>
              <span className="channel-item-provider">{provider ? label(provider) : channel.provider}</span>
              <Status channel={channel} />
            </button>;
          })}</nav>
          <button type="button" className="btn channel-new" disabled={busy || !providers.length}
            title={!providers.length ? T('\u8bf7\u5148\u5728\u63d2\u4ef6\u7ba1\u7406\u4e2d\u542f\u7528\u63a5\u5165\u63d2\u4ef6', 'Enable a provider in Plugins first') : undefined}
            onClick={create}><Icon name="plus" />{T('\u65b0\u5efa\u901a\u9053', 'New channel')}</button>
        </aside>}
        <section className="channel-detail" aria-label={T('\u901a\u9053\u8be6\u60c5', 'Channel details')} aria-busy={busy}>
          {editing ? <ChannelForm key={editing.kind === 'new' ? 'new' : `edit:${editing.id}`} providers={providers}
            channel={edited} busy={busy} onSave={save} onCancel={() => { setEditing(null); setError(''); }} />
            : current ? <ChannelDetail api={api} channel={current} provider={providers.find(provider => provider.kind === current.provider)}
              busy={busy} onAct={action => void act({ action, id: current.id })}
              onEdit={() => { setSelected(current.id); setEditing({ kind: 'edit', id: current.id }); setError(''); }}
              onRemove={() => void remove(current)} />
            : <div className="channel-empty">
              <span className="channel-empty-icon" aria-hidden="true"><Icon name="cpu" /></span>
              <h3>{providers.length ? T('\u8fde\u63a5\u4f60\u7684\u7b2c\u4e00\u4e2a\u901a\u9053', 'Connect your first channel') : T('\u5148\u542f\u7528\u4e00\u4e2a\u63a5\u5165\u63d2\u4ef6', 'Enable a messaging provider')}</h3>
              <p>{providers.length ? T('\u5c06\u6d88\u606f\u5e73\u53f0\u8fde\u63a5\u5230\u52a9\u624b\u3002\u5728\u8fd9\u91cc\u7edf\u4e00\u7ba1\u7406\u914d\u7f6e\u3001\u542f\u505c\u548c\u8fd0\u884c\u65e5\u5fd7\u3002', 'Connect a messaging platform to your assistant. Manage settings, start or stop connections, and view logs here.')
                : T('\u5728\u63d2\u4ef6\u7ba1\u7406\u4e2d\u542f\u7528\u98de\u4e66\u7b49\u63a5\u5165\u63d2\u4ef6\uff0c\u7136\u540e\u56de\u5230\u8fd9\u91cc\u521b\u5efa\u901a\u9053\u3002', 'Enable a provider such as Feishu in Plugins, then return here to create a channel.')}</p>
              {providers.length > 0 && <>
                <button type="button" className="btn primary" disabled={busy} onClick={create}><Icon name="plus" />{T('\u65b0\u5efa\u901a\u9053', 'New channel')}</button>
                <small>{T('\u53ef\u7528\u63a5\u5165\uff1a', 'Available providers: ')}{providers.map(label).join(' / ')}</small>
              </>}
            </div>}
        </section>
      </div>
    </SettingsPanel>
  </>;
}

defineReact('web-channels', ChannelManager);
