import { useCallback, useEffect, useState } from 'react';
import { type PluginAPI, type HostState, PagePanel, pages, T, errorText, defineReact } from '@gah/sdk';

// Usage overview page: token totals across saved chats, by day, model and chat.
// Data comes from GET /api/p/web-usage/?days=N (N=0 means all time).
type Row = { runs: number; calls: number; input: number; output: number; cache_read: number; cache_write: number };
type Report = {
  days: number; undated: number; totals: Row; session_count: number;
  models: (Row & { model: string })[];
  daily: (Row & { day: string })[];
  sessions: (Row & { id: string; title: string; updated?: number })[];
};

const RANGES = [7, 30, 90, 0];
const fmt = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
const full = (n: number) => Math.round(n).toLocaleString();
const rangeLabel = (d: number) => d ? T(`近 ${d} 天`, `Last ${d} days`) : T('全部', 'All time');
const hitRate = (r: Row) => r.input + r.cache_read ? r.cache_read / (r.input + r.cache_read) : 0;
const tip = (r: Row) => [
  `${T('输入', 'Input')} ${full(r.input)}`, `${T('输出', 'Output')} ${full(r.output)}`,
  `${T('缓存读', 'Cache read')} ${full(r.cache_read)}`, `${T('缓存写', 'Cache write')} ${full(r.cache_write)}`,
  `${T('任务', 'Runs')} ${r.runs}`, `${T('调用', 'Calls')} ${r.calls}`,
].join('\n');

function Cards({ t }: { t: Row }) {
  const cards: [string, string, string?][] = [
    [T('输入', 'Input'), fmt(t.input), full(t.input)],
    [T('输出', 'Output'), fmt(t.output), full(t.output)],
    [T('缓存读', 'Cache read'), fmt(t.cache_read), `${T('命中率', 'Hit rate')} ${(hitRate(t) * 100).toFixed(1)}%`],
    [T('缓存写', 'Cache write'), fmt(t.cache_write), full(t.cache_write)],
    [T('任务 / 调用', 'Runs / calls'), `${t.runs} / ${t.calls}`],
  ];
  return <div className="gah-usage-cards">{cards.map(([k, v, s]) => (
    <div key={k} className="gah-usage-card"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>
  ))}</div>;
}

function Daily({ rows }: { rows: Report['daily'] }) {
  const max = Math.max(1, ...rows.map(r => r.input + r.output + r.cache_read));
  return <div className="gah-usage-daily">{rows.map(r => {
    const h = (n: number) => `${(n / max) * 100}%`;
    return <div key={r.day} className="col" title={`${r.day}\n${tip(r)}`}>
      <div className="bar"><i className="cr" style={{ height: h(r.cache_read) }} /><i className="in" style={{ height: h(r.input) }} /><i className="out" style={{ height: h(r.output) }} /></div>
      <span>{r.day.slice(5)}</span>
    </div>;
  })}</div>;
}

function Table({ head, rows }: { head: string; rows: { key: string; label: string; row: Row; onClick?: () => void }[] }) {
  const max = Math.max(1, ...rows.map(r => r.row.input + r.row.output));
  return <table className="gah-usage-table"><thead><tr>
    <th>{head}</th><th>{T('输入', 'Input')}</th><th>{T('输出', 'Output')}</th><th>{T('缓存读', 'Cache read')}</th><th>{T('任务', 'Runs')}</th>
  </tr></thead><tbody>{rows.map(({ key, label, row, onClick }) => (
    <tr key={key} title={tip(row)}>
      <td className="name">{onClick ? <button type="button" className="link" onClick={onClick}>{label}</button> : label}
        <div className="share" style={{ width: `${((row.input + row.output) / max) * 100}%` }} /></td>
      <td>{fmt(row.input)}</td><td>{fmt(row.output)}</td><td>{fmt(row.cache_read)}</td><td>{row.runs}</td>
    </tr>
  ))}</tbody></table>;
}

function Overview({ api }: { api: PluginAPI }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true); setError('');
    api.get<Report>(`?days=${days}`).then(setData, e => setError(errorText(e))).finally(() => setLoading(false));
  }, [api, days]);
  useEffect(load, [load]);
  const open = async (id: string) => {
    try { const next = await api.host.post<HostState>('/api/sessions', { action: 'select', id }); api.setState(next, true); pages.home(); }
    catch (e) { setError(errorText(e)); }
  };
  const t = data?.totals;
  return <div className="gah-usage">
    <div className="gah-usage-bar">
      <div className="gah-usage-ranges" role="group">{RANGES.map(d => (
        <button key={d} type="button" className={d === days ? 'active' : ''} onClick={() => setDays(d)}>{rangeLabel(d)}</button>
      ))}</div>
      <button type="button" className="gah-usage-refresh" disabled={loading} onClick={load}>{loading ? T('加载中…', 'Loading…') : T('刷新', 'Refresh')}</button>
    </div>
    {error && <div className="gah-usage-error">{error}</div>}
    {t && !t.runs && <div className="gah-usage-empty">{T('这段时间没有记录到用量。', 'No usage recorded in this range.')}</div>}
    {data && t && t.runs > 0 && <>
      <Cards t={t} />
      <h3>{T('每日用量', 'Daily usage')}</h3>
      <div className="gah-usage-legend"><i className="in" />{T('输入', 'Input')}<i className="out" />{T('输出', 'Output')}<i className="cr" />{T('缓存读', 'Cache read')}</div>
      <Daily rows={data.daily} />
      <h3>{T('按模型', 'By model')}</h3>
      <Table head={T('模型', 'Model')} rows={data.models.map(m => ({ key: m.model || '-', label: m.model || T('（未记录）', '(unknown)'), row: m }))} />
      <h3>{T(`用量最多的会话（共 ${data.session_count} 个）`, `Top chats (${data.session_count} total)`)}</h3>
      <Table head={T('会话', 'Chat')} rows={data.sessions.map(s => ({ key: s.id, label: s.title || T('新会话', 'New chat'), row: s, onClick: () => void open(s.id) }))} />
      {data.undated > 0 && <p className="gah-usage-note">{T(`${data.undated} 次较早的任务没有时间记录，按所在会话的最后更新时间计入。`, `${data.undated} older runs have no timestamp and are dated by their chat's last update.`)}</p>}
    </>}
  </div>;
}

function UsagePage({ api }: { api: PluginAPI }) {
  return <PagePanel api={api} label={T('用量总览', 'Usage')} icon="usage" order={10}><Overview api={api} /></PagePanel>;
}

defineReact('web-usage', UsagePage);
