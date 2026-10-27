import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type PluginAPI, useHost, T, Icon, Modal, PluginSlot, useOperation, confirmDialog, defineReact } from '@gah/sdk';

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

const label = (x: { label: string; label_zh?: string }) => T(x.label_zh || x.label, x.label);
const time = (t: number) => new Date(t * 1000).toLocaleTimeString();
const STATES: Record<string, [string, string]> = {
  running: ['\u8fd0\u884c\u4e2d', 'Running'],
  starting: ['\u542f\u52a8\u4e2d', 'Starting'],
  stopped: ['\u5df2\u505c\u6b62', 'Stopped'],
  error: ['\u51fa\u9519', 'Error'],
  unavailable: ['\u63d0\u4f9b\u65b9\u672a\u52a0\u8f7d', 'Provider not loaded'],
};
const stateText = (c: Channel) => {
  const s = c.available ? c.state : 'unavailable';
  const pair = STATES[s];
  return pair ? T(pair[0], pair[1]) : s;
};

// Incremental log tail: polls ?logs=<id>&after=<last t> every 2s while mounted.
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
  return <div className="channel-logs" ref={box}>
    {lines.length ? lines.map((l, i) => <div key={i} className="channel-log" data-level={l.level}>
      <span className="channel-log-time">{time(l.t)}</span><span className="channel-log-text">{l.text}</span>
    </div>) : <div className="channel-empty">{T('\u6682\u65e0\u65e5\u5fd7', 'No logs yet')}</div>}
  </div>;
}

// Create/edit form. Secret inputs start empty; an empty secret keeps the stored value.
function ChannelForm({ providers, channel, busy, onSave, onCancel }: {
  providers: Provider[]; channel: Channel | null; busy: boolean;
  onSave: (body: Record<string, unknown>) => void; onCancel: () => void;
}) {
  const [kind, setKind] = useState(channel?.provider || providers[0]?.kind || '');
  const [id, setId] = useState('');
  const provider = providers.find(p => p.kind === kind);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(channel?.config || {}) }));
  const set = (k: string, v: string) => setValues(prev => ({ ...prev, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const config: Record<string, string> = {};
    for (const f of provider?.fields || []) config[f.key] = values[f.key] ?? '';
    onSave(channel ? { action: 'update', id: channel.id, config } : { action: 'create', provider: kind, id: id.trim(), config });
  };
  return <form className="channel-form" onSubmit={submit}>
    {!channel && <>
      <label className="channel-field"><span>{T('\u63a5\u5165\u7c7b\u578b', 'Provider')}</span>
        <select value={kind} disabled={busy} onChange={e => setKind(e.target.value)}>
          {providers.map(p => <option key={p.kind} value={p.kind}>{label(p)}</option>)}
        </select></label>
      <label className="channel-field"><span>{T('\u901a\u9053 ID\uff08\u53ef\u7559\u7a7a\uff09', 'Channel ID (optional)')}</span>
        <input value={id} disabled={busy} placeholder={`${kind}-xxxxxx`} pattern="[a-z0-9][a-z0-9_\-]{0,31}" onChange={e => setId(e.target.value)} /></label>
    </>}
    {(provider?.fields || []).map(f => {
      const stored = !!channel?.secrets_set.includes(f.key);
      return <label key={f.key} className="channel-field"><span>{label(f)}{f.required && <em>*</em>}</span>
        <input type={f.secret ? 'password' : 'text'} autoComplete="off" disabled={busy}
          required={f.required && !(f.secret && stored)} value={values[f.key] ?? ''}
          placeholder={f.secret && stored ? T('\u5df2\u4fdd\u5b58\uff0c\u7559\u7a7a\u4e0d\u4fee\u6539', 'Saved; leave empty to keep') : (f.default || '')}
          onChange={e => set(f.key, e.target.value)} /></label>;
    })}
    <div className="channel-actions">
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>{T('\u53d6\u6d88', 'Cancel')}</button>
      <button type="submit" className="btn primary" disabled={busy || !provider}>{T('\u4fdd\u5b58', 'Save')}</button>
    </div>
  </form>;
}

export function ChannelManager({ api }: { api: PluginAPI }) {
  const { changing } = useHost();
  const { working, run } = useOperation(api, true);
  const [open, setOpen] = useState(false), [data, setData] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [editing, setEditing] = useState<'new' | string | null>(null);
  const [error, setError] = useState('');
  const busy = working || changing;
  const load = () => run(async () => { setData(await api.get<Snapshot>('')); setOpen(true); }, setError, true);
  const act = (body: Record<string, unknown>, after?: () => void) => run(async () => {
    setError(''); setData(await api.post<Snapshot>('', body)); after?.();
  }, setError, true);
  const remove = async (c: Channel) => {
    if (!(await confirmDialog({ title: T('\u5220\u9664\u901a\u9053', 'Delete channel'), danger: true,
      message: T(`\u505c\u6b62\u5e76\u5220\u9664\u901a\u9053 ${c.id}\uff1f\u5176\u914d\u7f6e\u548c\u5bc6\u94a5\u5c06\u88ab\u6e05\u9664\u3002`, `Stop and delete channel ${c.id}? Its config and secrets will be removed.`) }))) return;
    void act({ action: 'delete', id: c.id }, () => setSelected(null));
  };
  const channels = data?.channels || [], providers = data?.providers || [];
  const current = channels.find(c => c.id === selected) || null;
  const close = () => { if (!busy) { setOpen(false); setEditing(null); setError(''); } };
  return <>
    <PluginSlot api={api} name="sidebar-foot"><div className="gah-channels">
      <button type="button" className="side-item" disabled={busy} onClick={() => void load()}>
        <Icon name="cpu" />{T('\u901a\u9053\u7ba1\u7406', 'Channels')}</button>
    </div></PluginSlot>
    {open && <Modal className="channel-dialog" label={T('\u901a\u9053\u7ba1\u7406', 'Channels')} busy={busy} onClose={close}>
      <div className="dialog-head"><h2>{T('\u901a\u9053\u7ba1\u7406', 'Channels')}</h2>
        <button type="button" className="icon-btn" disabled={busy} onClick={close} aria-label={T('\u5173\u95ed', 'Close')}><Icon name="x" /></button>
      </div>
      {error && <div className="channel-error" role="alert">{error}</div>}
      <div className="channel-body">
        <aside className="channel-list">
          <button type="button" className="btn primary channel-new" disabled={busy || !providers.length}
            onClick={() => { setEditing('new'); setSelected(null); }}><Icon name="plus" />{T('\u65b0\u5efa\u901a\u9053', 'New channel')}</button>
          {!providers.length && <div className="channel-empty">{T('\u6ca1\u6709\u53ef\u7528\u7684\u63a5\u5165\u63d2\u4ef6\uff0c\u8bf7\u5148\u542f\u7528\u5982 feishu', 'No provider plugins loaded; enable one such as feishu')}</div>}
          {channels.map(c => <button key={c.id} type="button" className="channel-item" aria-pressed={c.id === selected}
            onClick={() => { setSelected(c.id); setEditing(null); }}>
            <span className="channel-dot" data-state={c.available ? c.state : 'unavailable'} />
            <span className="channel-item-name">{c.name || c.id}</span>
            <span className="channel-item-kind">{c.provider}</span>
          </button>)}
          {providers.length > 0 && !channels.length && <div className="channel-empty">{T('\u8fd8\u6ca1\u6709\u901a\u9053', 'No channels yet')}</div>}
        </aside>
        <section className="channel-detail">
          {editing ? <ChannelForm key={editing} providers={providers} busy={busy}
            channel={editing === 'new' ? null : current}
            onCancel={() => setEditing(null)}
            onSave={body => void act(body, () => { setEditing(null); if (body.action === 'create') setSelected(null); })} />
          : current ? <>
            <div className="channel-head">
              <div><h3>{current.name || current.id}</h3>
                <span className="channel-badge" data-state={current.available ? current.state : 'unavailable'}>{stateText(current)}</span>
                {current.since ? <span className="channel-since">{T('\u81ea ', 'since ')}{time(current.since)}</span> : null}</div>
              <div className="channel-actions">
                {current.state === 'running' || current.state === 'starting'
                  ? <button type="button" className="btn" disabled={busy} onClick={() => void act({ action: 'stop', id: current.id })}>{T('\u505c\u6b62', 'Stop')}</button>
                  : <button type="button" className="btn primary" disabled={busy || !current.available} onClick={() => void act({ action: 'start', id: current.id })}>{T('\u542f\u52a8', 'Start')}</button>}
                <button type="button" className="btn" disabled={busy || !current.available} onClick={() => void act({ action: 'restart', id: current.id })}>{T('\u91cd\u542f', 'Restart')}</button>
                <button type="button" className="btn" disabled={busy || !current.available} onClick={() => setEditing(current.id)}><Icon name="pen" />{T('\u7f16\u8f91', 'Edit')}</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void remove(current)}><Icon name="trash" />{T('\u5220\u9664', 'Delete')}</button>
              </div>
            </div>
            {current.error && <div className="channel-error">{current.error}</div>}
            <Logs api={api} id={current.id} />
          </> : <div className="channel-empty">{T('\u9009\u62e9\u5de6\u4fa7\u901a\u9053\u67e5\u770b\u72b6\u6001\u548c\u65e5\u5fd7', 'Select a channel to see its status and logs')}</div>}
        </section>
      </div>
    </Modal>}
  </>;
}

defineReact('web-channels', ChannelManager);
