import { useCallback, useEffect, useMemo, useState } from 'react';
import { type PluginAPI, ViewPanel, T, errorText, defineReact, useHost } from '@gah/sdk';

// Context view: the saved LLM context of the current chat -- raw messages split into
// blocks, working memory and GA history summary -- from GET /api/p/web-context/?sid=ID.
type Kind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'other';
type Block = { type: Kind; text?: string; chars: number; name?: string; id?: string; images?: number; error?: boolean; redacted?: boolean; bytes?: number; media?: string };
type Msg = { index: number; role: string; blocks: Block[]; chars: number };
type Ctx = {
  id: string; title: string; running: boolean; model: string; effort?: string | null;
  working: Record<string, string>; history: string[]; messages: Msg[];
  totals: Record<Kind, number>; counts: Record<Kind, number>;
  tools: { name: string; calls: number; chars: number }[]; chars: number;
};

const KINDS: Kind[] = ['text', 'thinking', 'tool_use', 'tool_result', 'image', 'other'];
const kindLabel = (k: Kind) => ({
  text: T('文本', 'Text'), thinking: T('思考', 'Thinking'), tool_use: T('工具调用', 'Tool call'),
  tool_result: T('工具结果', 'Tool result'), image: T('图片', 'Image'), other: T('其他', 'Other'),
})[k];
const fmt = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(n);
// Rough: ~4 chars/token for Latin text, ~1.5 for CJK; mixed content lands in between.
const estTokens = (chars: number) => Math.round(chars / 3);
const PREVIEW = 4000;

function Bar({ parts, total }: { parts: [Kind, number][]; total: number }) {
  return <div className="gah-ctx-bar">{parts.filter(([, n]) => n > 0).map(([k, n]) => (
    <i key={k} className={'k-' + k} style={{ width: `${(n / Math.max(1, total)) * 100}%` }} title={`${kindLabel(k)} ${n.toLocaleString()}`} />
  ))}</div>;
}

function Text({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > PREVIEW;
  return <>
    <pre className="gah-ctx-pre">{all || !long ? text : text.slice(0, PREVIEW)}</pre>
    {long && <button type="button" className="gah-ctx-more" onClick={() => setAll(!all)}>
      {all ? T('收起', 'Collapse') : T(`展开全部（${fmt(text.length)} 字符）`, `Show all (${fmt(text.length)} chars)`)}</button>}
  </>;
}

function BlockRow({ block }: { block: Block }) {
  const [open, setOpen] = useState(block.type === 'text' && block.chars < 600);
  const title = block.type === 'tool_use' || block.type === 'tool_result' ? block.name || '' : '';
  const head = block.type === 'image' ? `${block.media || 'image'} · ${fmt(block.bytes || 0)}B`
    : (block.text || '').replace(/\s+/g, ' ').slice(0, 140);
  return <div className={'gah-ctx-block k-' + block.type + (block.error ? ' err' : '')}>
    <button type="button" className="gah-ctx-bhead" aria-expanded={open} onClick={() => setOpen(!open)} disabled={block.type === 'image'}>
      <span className="tag">{kindLabel(block.type)}{title && <b>{title}</b>}</span>
      <span className="peek">{open ? '' : head}</span>
      <span className="size">{fmt(block.chars)}{block.images ? ` +${block.images}🖼` : ''}</span>
    </button>
    {open && block.type !== 'image' && <Text text={block.text || (block.redacted ? T('（已加密的思考）', '(redacted thinking)') : '')} />}
  </div>;
}

function Context({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const sid = state.session_id || '';
  const running = !!state.running;
  const [data, setData] = useState<Ctx | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Kind | ''>('');
  const load = useCallback(() => {
    setLoading(true); setError('');
    api.get<Ctx>(sid ? `?sid=${encodeURIComponent(sid)}` : '').then(setData, e => setError(errorText(e))).finally(() => setLoading(false));
  }, [api, sid]);
  // Reload on chat switch and whenever a run finishes (state is persisted then).
  useEffect(load, [load, running]);
  const msgs = useMemo(() => !data ? [] : !filter ? data.messages
    : data.messages.map(m => ({ ...m, blocks: m.blocks.filter(b => b.type === filter) })).filter(m => m.blocks.length), [data, filter]);
  const extra = data ? Object.values(data.working).reduce((s, v) => s + v.length, 0) + data.history.reduce((s, v) => s + v.length, 0) : 0;
  return <div className="gah-ctx">
    <div className="gah-ctx-top">
      <div className="gah-ctx-head">
        <span className="gah-ctx-sum">{data ? [data.model, data.effort, `${data.messages.length} ${T('条消息', 'messages')}`,
          `${fmt(data.chars)} ${T('字符', 'chars')}`, `≈${fmt(estTokens(data.chars + extra))} tokens`].filter(Boolean).join(' · ') : ''}</span>
        <button type="button" className="gah-ctx-refresh" disabled={loading} onClick={load}>{loading ? T('加载中…', 'Loading…') : T('刷新', 'Refresh')}</button>
      </div>
      {data && <>
        <Bar parts={KINDS.map(k => [k, data.totals[k]])} total={data.chars} />
        <div className="gah-ctx-legend">
          <button type="button" aria-pressed={!filter} onClick={() => setFilter('')}>{T('全部', 'All')}</button>
          {KINDS.filter(k => data.counts[k]).map(k => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(filter === k ? '' : k)}>
            <i className={'k-' + k} />{kindLabel(k)} <span>{data.counts[k]} · {fmt(data.totals[k])} ({((data.totals[k] / Math.max(1, data.chars)) * 100).toFixed(0)}%)</span></button>)}
        </div>
      </>}
      {running && <div className="gah-ctx-note">{T('任务运行中：显示的是本轮开始前保存的上下文，结束后自动刷新。', 'A run is in progress: showing the context saved before it; refreshes when it ends.')}</div>}
      {error && <div className="gah-ctx-error">{error}</div>}
    </div>
    {data && !data.messages.length && !data.history.length && <div className="gah-ctx-empty"><b>{T('上下文为空', 'Context is empty')}</b>{T('发送一条消息后，这里会显示模型实际收到的上下文。', 'After you send a message, the context the model receives appears here.')}</div>}
    {data && <>
      {(Object.keys(data.working).length > 0 || data.history.length > 0) && <section className="gah-ctx-sec">
        <h3>{T('工作记忆与历史摘要', 'Working memory & history')}</h3>
        {Object.entries(data.working).filter(([, v]) => v).map(([k, v]) => <details key={k} className="gah-ctx-card" open={k === 'key_info'}>
          <summary>{k} <span>{fmt(v.length)}</span></summary><Text text={v} /></details>)}
        {data.history.length > 0 && <details className="gah-ctx-card"><summary>history <span>{data.history.length} {T('条', 'lines')}</span></summary>
          <ol className="gah-ctx-hist">{data.history.map((h, i) => <li key={i}>{h}</li>)}</ol></details>}
      </section>}
      {data.tools.length > 0 && <section className="gah-ctx-sec">
        <h3>{T('按工具占用', 'By tool')}</h3>
        <table className="gah-ctx-tools"><tbody>{data.tools.map(t => <tr key={t.name}>
          <td>{t.name}</td><td>{t.calls}×</td>
          <td className="w"><i style={{ width: `${(t.chars / Math.max(1, data.tools[0].chars)) * 100}%` }} /></td><td>{fmt(t.chars)}</td>
        </tr>)}</tbody></table>
      </section>}
      {msgs.length > 0 && <section className="gah-ctx-sec">
        <h3>{T('消息', 'Messages')}</h3>
        <ol className="gah-ctx-msgs">{msgs.map(m => <li key={m.index} className={'role-' + m.role}>
          <div className="gah-ctx-mhead"><span className="role">#{m.index + 1} {m.role}</span>
            <Bar parts={KINDS.map(k => [k, m.blocks.filter(b => b.type === k).reduce((s, b) => s + b.chars, 0)])} total={m.chars} />
            <span className="size">{fmt(m.chars)}</span></div>
          {m.blocks.map((b, i) => <BlockRow key={i} block={b} />)}
        </li>)}</ol>
      </section>}
    </>}
  </div>;
}

function ContextView({ api }: { api: PluginAPI }) {
  return <ViewPanel api={api} label={T('上下文', 'Context')} order={20} className="gah-ctx-view"><Context api={api} /></ViewPanel>;
}

defineReact('web-context', ContextView);
