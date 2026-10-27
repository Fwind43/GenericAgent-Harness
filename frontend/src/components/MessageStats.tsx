import { useEffect, useState, type ReactNode } from 'react';
import { T } from '../i18n';
import type { Message, Turn, Usage } from '../types';
import { duration } from './SessionStats';

const KEYS = ['input', 'output', 'cache_read', 'cache_write'] as const;
const compact = (n = 0) => n < 1000 ? String(n) : n < 1e6 ? `${Number((n / 1000).toFixed(n < 10000 ? 1 : 0))}k` : `${Number((n / 1e6).toFixed(1))}M`;
const num = (n = 0) => Number(n || 0).toLocaleString('en-US');
const icon = (d: string) => <svg viewBox="0 0 16 16" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** Live totals: sum per-turn usage while running (or when no final usage exists), else trust the final message usage. */
export function liveUsage(m: Message, turns: Turn[]): Usage | null {
  if (m.status !== 'running' && m.usage?.calls) return m.usage;
  const u: Usage = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const t of turns) {
    if (!t.usage) continue;
    u.calls! += 1;
    for (const k of KEYS) u[k] = (u[k] || 0) + (t.usage[k] || 0);
  }
  return u.calls ? u : m.usage?.calls ? m.usage : null;
}

function timing(turns: Turn[]) {
  let llm = 0, tools = 0, out = 0, gen = 0;
  let ttft: number | null = null;
  for (const t of turns) {
    for (const tool of t.tools ?? []) tools += tool.seconds || 0;
    const sec = t.llm?.seconds || 0, first = t.llm?.ttft;
    if (ttft == null && typeof first === 'number') ttft = first;
    llm += sec;
    const g = sec - (typeof first === 'number' ? first : 0);
    if (t.usage?.output && g > 0) { out += t.usage.output; gen += g; }
  }
  return { total: llm + tools, ttft, rate: gen > 0 ? out / gen : 0 };
}

// Same glyphs as the per-step token row, plus clock / first-token / speed / hit-rate for the totals bar.
const ICON = {
  time: icon('M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 4.5V8l2.5 1.5'),
  ttft: icon('M2.5 8h6M6 5l3 3-3 3M12.5 3v10'),
  input: icon('M8 13.5V2.5M4 6.5l4-4 4 4'),
  output: icon('M8 2.5v11M4 9.5l4 4 4-4'),
  cache_read: icon('M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z'),
  cache_write: icon('M8 2v7.5M4.8 6.5 8 9.7l3.2-3.2M2.5 10.5v2.5h11v-2.5'),
  rate: icon('M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l2.8-3.3'),
  hit: icon('M3 8.5 6.5 12 13 4.5'),
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
const Stat = ({ ic, label, value, title }: { ic?: ReactNode; label?: string; value: string; title?: string }) =>
  <span className="stat" title={title ?? (label ? label + ' ' + value : value)}>{ic}{label && <span className="stat-k">{label}</span>}<span className="stat-v">{value}</span></span>;

export function MessageStats({ m, turns }: { m: Message; turns: Turn[] }) {
  const running = m.status === 'running';
  const now = useNow(running && !!m.created_at);
  const u = liveUsage(m, turns), t = timing(turns);
  const elapsed = running && m.created_at ? Math.max(0, now - m.created_at) : t.total;
  if (!u && !(elapsed > 0)) return null;
  const items: ReactNode[] = [<span key="h" className="stat-head">{T('总计', 'Total')}</span>];
  if (elapsed > 0) items.push(<Stat key="time" ic={ICON.time} label={T('耗时', 'Time')} value={duration(elapsed)} />);
  if (t.ttft != null) items.push(<Stat key="ttft" ic={ICON.ttft} label="TTFT" value={`${t.ttft.toFixed(2)}s`} />);
  if (u) {
    items.push(<Stat key="in" ic={ICON.input} label={T('输入', 'In')} value={compact(u.input)} title={num(u.input)} />);
    if (u.cache_write) items.push(<Stat key="cw" ic={ICON.cache_write} label={T('缓存写入', 'Cache write')} value={compact(u.cache_write)} title={num(u.cache_write)} />);
    if (u.cache_read) items.push(<Stat key="cr" ic={ICON.cache_read} label={T('缓存读取', 'Cache read')} value={compact(u.cache_read)} title={num(u.cache_read)} />);
    items.push(<Stat key="out" ic={ICON.output} label={T('输出', 'Out')} value={compact(u.output)} title={num(u.output)} />);
  }
  if (t.rate > 0) items.push(<Stat key="rate" ic={ICON.rate} value={`${t.rate.toFixed(1)} tok/s`} />);
  if (u?.cache_read && u.input) items.push(<Stat key="hit" ic={ICON.hit} label={T('缓存', 'Cache')} value={`${Math.round(u.cache_read / u.input * 100)}%`} />);
  return <div className={'usage stats' + (running ? ' live' : '')}>{items}</div>;
}
