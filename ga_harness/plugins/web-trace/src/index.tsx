import { useMemo, useState } from 'react';
import { type PluginAPI, useHost, T, ViewPanel, defineReact } from '@gah/sdk';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Usage = { input?: number; output?: number; cache_read?: number; calls?: number };
type Tool = { id?: string; name: string; args?: Json; data?: Json; status: string; ok?: boolean; seconds?: number };
type Turn = { turn: number; summary?: string; thinking?: string; reply?: string; status?: string; tools?: Tool[]; usage?: Usage; llm?: { seconds?: number; ttft?: number | null } };
type Note = { kind: string; text: string; turn: number };
type Message = { role: 'user' | 'assistant'; text?: string; status?: string; error?: string; turns?: Turn[]; usage?: Usage; model?: string; reasoning_effort?: string; notes?: Note[] };

// One flat trace event. lane picks the timeline row; kind picks the chip and colour.
type Lane = 'input' | 'model' | 'tool';
type Kind = 'input' | 'context' | 'model' | 'output' | 'tool' | 'error';
export type TraceEvent = {
  key: string; run: number; lane: Lane; kind: Kind;
  name?: string; args?: string; result?: string; text: string;
  seconds?: number; failed?: boolean; detail: string; haystack: string;
};
export type TraceRun = { run: number; input: string; status?: string; model?: string; seconds: number; tools: number; usage?: Usage; events: TraceEvent[] };
type Mode = 'duration' | 'calls';

const SLOW = 10;
const secs = (value?: number) => value == null ? '' : value < 1 ? Math.round(value * 1000) + 'ms' : value < 60 ? value.toFixed(1) + 's' : Math.floor(value / 60) + 'm' + Math.round(value % 60) + 's';
const num = (value?: number) => value == null ? '' : value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(value);
const text = (value: Json | undefined) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const compact = (value: Json | undefined) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const line = (value: string, size = 240) => { const flat = value.replace(/\s+/g, ' ').trim(); return flat.length > size ? flat.slice(0, size) + '…' : flat; };
const usageText = (usage?: Usage) => usage ? [usage.input != null && T('输入 ', 'in ') + num(usage.input), usage.output != null && T('输出 ', 'out ') + num(usage.output), usage.cache_read ? T('缓存 ', 'cache ') + num(usage.cache_read) : ''].filter(Boolean).join(' · ') : '';
const section = (title: string, body?: string) => body ? title + '\n' + body : '';
const join = (...parts: string[]) => parts.filter(Boolean).join('\n\n');

export function buildTrace(messages: Message[]): TraceRun[] {
  const runs: TraceRun[] = [];
  let input = '';
  messages.forEach((message, index) => {
    if (message.role === 'user') { input = message.text || ''; return; }
    const run = runs.length + 1;
    const events: TraceEvent[] = [];
    const push = (event: Omit<TraceEvent, 'run' | 'haystack'>) => events.push({ ...event, run,
      haystack: [event.name, event.args, event.result, event.text].filter(Boolean).join(' ').toLowerCase() });
    if (input) push({ key: index + ':in', lane: 'input', kind: 'input', text: line(input), detail: input });
    const notes = message.notes || [];
    const pushNotes = (turn: number) => notes.filter(note => note.turn === turn).forEach((note, n) => push({
      key: index + ':n' + turn + ':' + n, lane: 'input', kind: 'context',
      name: note.kind === 'steer' ? T('引导', 'steer') : note.kind, text: line(note.text), detail: note.text,
    }));
    pushNotes(0);
    let seconds = 0, tools = 0, lastReply = '';
    for (const turn of message.turns || []) {
      const said = turn.reply || turn.summary || '';
      if (turn.reply) lastReply = turn.reply;
      seconds += turn.llm?.seconds || 0;
      push({ key: index + ':m' + turn.turn, lane: 'model', kind: 'model',
        text: line(said) || T('第 ', 'Turn ') + turn.turn + T(' 轮', ''), seconds: turn.llm?.seconds,
        detail: join(
          [T('第 ', 'Turn ') + turn.turn + T(' 轮', ''), turn.llm?.ttft != null ? T('首字 ', 'TTFT ') + secs(turn.llm.ttft) : '', usageText(turn.usage)].filter(Boolean).join(' · '),
          section(T('摘要：', 'Summary:'), turn.summary), section(T('思考：', 'Thinking:'), turn.thinking), section(T('回复：', 'Reply:'), turn.reply)) });
      for (const [n, tool] of (turn.tools || []).entries()) {
        tools += 1; seconds += tool.seconds || 0;
        const failed = tool.ok === false || tool.status === 'error';
        const result = compact(tool.data);
        push({ key: index + ':t' + turn.turn + ':' + n, lane: 'tool', kind: 'tool', name: tool.name,
          args: line(compact(tool.args), 160), result: line(result), text: '', seconds: tool.seconds, failed,
          detail: join(section(T('参数：', 'Arguments:'), text(tool.args)), section(T('结果：', 'Result:'), text(tool.data)) || (tool.status === 'running' ? T('运行中…', 'Running…') : '')) });
      }
      pushNotes(turn.turn);
    }
    if (message.error) push({ key: index + ':err', lane: 'model', kind: 'error', text: line(message.error), failed: true, detail: message.error });
    else if (message.text && message.text.trim() !== lastReply.trim()) push({ key: index + ':out', lane: 'model', kind: 'output', text: line(message.text), detail: message.text });
    runs.push({ run, input, status: message.status, model: message.model, seconds, tools, usage: message.usage, events });
    input = '';
  });
  return runs;
}

// Timeline geometry: sequential layout. Duration mode sums per-step seconds (no start
// timestamps are recorded, so idle gaps are not shown); calls mode gives each event one slot.
export function layout(events: TraceEvent[], mode: Mode) {
  const total = events.reduce((sum, event) => sum + (event.seconds || 0), 0);
  const floor = mode === 'duration' && total > 0 ? total * 0.004 : 1;
  const widths = events.map(event => mode === 'duration' && total > 0 ? Math.max(event.seconds || 0, floor) : 1);
  const span = widths.reduce((sum, width) => sum + width, 0) || 1;
  let x = 0;
  return events.map((event, n) => { const left = x / span * 100; x += widths[n]; return { event, left, width: widths[n] / span * 100 }; });
}

const LANES: Array<[Lane, () => string]> = [['input', () => T('输入', 'Input')], ['model', () => T('模型', 'Model')], ['tool', () => T('工具', 'Tool')]];
const CHIP: Record<Kind, () => string> = {
  input: () => T('用户', 'User'), context: () => T('上下文', 'Context'), model: () => T('助手', 'Assistant'),
  output: () => T('输出', 'Output'), tool: () => T('工具', 'Tool'), error: () => T('错误', 'Error'),
};
const statusLabel = (status?: string) => ({ running: T('运行中', 'Running'), done: T('完成', 'Done'), error: T('出错', 'Error'), aborted: T('已中止', 'Aborted'), interrupted: T('已中断', 'Interrupted') } as Record<string, string>)[status || ''] || status || '';
const domId = (key: string) => 'gah-trace-' + key.replace(/[^\w-]/g, '_');

function Timeline({ events, mode, query, focus, onPick }: { events: TraceEvent[]; mode: Mode; query: string; focus: string; onPick: (key: string) => void }) {
  const blocks = useMemo(() => layout(events, mode), [events, mode]);
  const starts = useMemo(() => {
    const seen = new Set<number>();
    return blocks.filter(block => !seen.has(block.event.run) && seen.add(block.event.run) && block.event.run > 1);
  }, [blocks]);
  return <div className="gah-tl" role="group" aria-label={T('时间轴', 'Timeline')}>
    {LANES.map(([lane, label]) => <div className="gah-tl-lane" key={lane}>
      <span className="gah-tl-label">{label()}</span>
      <div className="gah-tl-track">
        {starts.map(block => <i key={'s' + block.event.run} className="gah-tl-run" style={{ left: block.left + '%' }} />)}
        {blocks.filter(block => block.event.lane === lane).map(({ event, left, width }) => {
          const dim = !!query && !event.haystack.includes(query);
          const tip = [CHIP[event.kind](), event.name, event.seconds != null && secs(event.seconds), event.text && line(event.text, 60)].filter(Boolean).join(' · ');
          return <button type="button" key={event.key} title={tip} aria-label={tip}
            className={'gah-tl-block k-' + event.kind + (event.failed ? ' failed' : '') + (dim ? ' dim' : '') + (focus === event.key ? ' on' : '')}
            style={{ left: left + '%', width: width + '%' }} onClick={() => onPick(event.key)} />;
        })}
      </div>
    </div>)}
  </div>;
}

function Row({ event, open, focus, onToggle }: { event: TraceEvent; open: boolean; focus: boolean; onToggle: () => void }) {
  return <li id={domId(event.key)} className={'gah-tr k-' + event.kind + (event.failed ? ' failed' : '') + (focus ? ' on' : '')}>
    <button type="button" className="gah-tr-head" aria-expanded={open} onClick={onToggle}>
      <span className="gah-tr-chip">{CHIP[event.kind]()}</span>
      <span className="gah-tr-body">
        {event.name ? <b className="gah-tr-name">{event.name}</b> : null}
        {event.args ? <span className="gah-tr-args">{event.args}</span> : null}
        {event.kind === 'tool' && event.result ? <><span className="gah-tr-arrow" aria-hidden="true">→</span><span className="gah-tr-result">{event.result}</span></> : null}
        {event.text ? <span className="gah-tr-text">{event.text}</span> : null}
      </span>
      {event.seconds != null ? <span className={'gah-tr-secs' + (event.seconds >= SLOW ? ' slow' : '')}>{secs(event.seconds)}</span> : null}
    </button>
    {open ? <pre className="gah-tr-detail">{event.detail || T('（无内容）', '(empty)')}</pre> : null}
  </li>;
}

function Trace() {
  const { state } = useHost();
  const runs = useMemo(() => buildTrace((state.messages || []) as Message[]), [state.messages]);
  const events = useMemo(() => runs.flatMap(run => run.events), [runs]);
  const [mode, setMode] = useState<Mode>(() => localStorage.getItem('gah-trace-mode') === 'calls' ? 'calls' : 'duration');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState('');
  const query = search.trim().toLowerCase();
  const shown = query ? events.filter(event => event.haystack.includes(query)) : events;
  const pickMode = (value: Mode) => { setMode(value); localStorage.setItem('gah-trace-mode', value); };
  const toggle = (key: string) => setOpen(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const pick = (key: string) => {
    setFocus(key);
    setOpen(prev => new Set(prev).add(key));
    if (query && !events.find(event => event.key === key)?.haystack.includes(query)) setSearch('');
    requestAnimationFrame(() => document.getElementById(domId(key))?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };
  if (!events.length) return <div className="gah-trace-empty"><b>{T('还没有轨迹', 'No trace yet')}</b>{T('发送一条消息后，这里会按时间线展示输入、模型调用和工具调用。', 'After you send a message, inputs, model calls and tool calls appear here as a timeline.')}</div>;
  const total = runs.reduce((sum, run) => sum + run.seconds, 0);
  const toolCount = runs.reduce((sum, run) => sum + run.tools, 0);
  const visibleRuns = runs.filter(run => shown.some(event => event.run === run.run));
  return <div className="gah-trace">
    <div className="gah-trace-top">
      <div className="gah-trace-bar">
        <div className="gah-seg" role="group" aria-label={T('时间轴刻度', 'Timeline scale')}>
          <button type="button" aria-pressed={mode === 'duration'} onClick={() => pickMode('duration')}>{T('时长', 'Duration')}</button>
          <button type="button" aria-pressed={mode === 'calls'} onClick={() => pickMode('calls')}>{T('调用', 'Calls')}</button>
        </div>
        <span className="gah-trace-sum">{[runs.length + T(' 个任务', ' runs'), toolCount + T(' 次工具', ' tools'), secs(total)].join(' · ')}</span>
        <input className="gah-trace-search" type="search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder={T('搜索工具、参数、结果…', 'Search tools, args, results…')} aria-label={T('搜索轨迹', 'Search trace')} />
      </div>
      <Timeline events={events} mode={mode} query={query} focus={focus} onPick={pick} />
      {mode === 'duration' ? <p className="gah-trace-hint">{T('按各步耗时依次排列，不含步骤之间的等待时间。', 'Steps are laid out by their own durations; idle gaps between steps are not shown.')}</p> : null}
    </div>
    {!shown.length ? <div className="gah-trace-none">{T('没有匹配的事件', 'No matching events')}</div> : null}
    {visibleRuns.map(run => <section className="gah-trace-run" key={run.run}>
      <header className="gah-trace-sep">
        <b>{T('任务 ', 'Run ') + run.run}</b>
        <span className="gah-trace-sep-input">{line(run.input, 80) || T('（无输入）', '(no input)')}</span>
        <span className="gah-trace-sep-meta">{[statusLabel(run.status), run.model, secs(run.seconds)].filter(Boolean).join(' · ')}</span>
      </header>
      <ol className="gah-trace-list">
        {shown.filter(event => event.run === run.run).map(event => <Row key={event.key} event={event} open={open.has(event.key)} focus={focus === event.key} onToggle={() => { setFocus(event.key); toggle(event.key); }} />)}
      </ol>
    </section>)}
  </div>;
}

function TraceView({ api }: { api: PluginAPI }) {
  return <ViewPanel api={api} label={T('轨迹', 'Trace')} order={10} className="gah-trace-view"><Trace /></ViewPanel>;
}

defineReact('web-trace', TraceView);
