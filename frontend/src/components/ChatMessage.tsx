import { Fragment, createContext, memo, useContext, useEffect, useState } from 'react';
import { request } from '../api';
import { T } from '../i18n';
import { host } from '../store';
import type { Json, Message, MessageNote, ToolCall, Turn, Usage } from '../types';
import { CopyButton, Disclosure, Markdown, format } from './Output';
import { MessageStats } from './MessageStats';
import { MessageAttachments } from './Attachments';
import { FileChanges, filesData } from './FileChanges';
import { Slot } from '../slots';

// DOM and class names intentionally mirror the legacy ui-web renderer so output.css applies unchanged.
const compact = (n = 0) => n < 1000 ? String(n) : n < 1e6 ? `${Number((n / 1000).toFixed(n < 10000 ? 1 : 0))}k` : `${Number((n / 1e6).toFixed(1))}M`;
const num = (n = 0) => Number(n || 0).toLocaleString('en-US');
const STATUS: Record<string, () => string> = { aborted: () => T('已停止', 'Stopped'), error: () => T('出错', 'Error') };
const svg = (d: string) => <svg viewBox="0 0 16 16" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
// Input/output = up/down arrows; cache hit = lightning (served from cache); cache write = arrow into tray (stored to cache).
const TOKEN_ICON = { input: svg('M8 13.5V2.5M4 6.5l4-4 4 4'), output: svg('M8 2.5v11M4 9.5l4 4 4-4'), cache_read: svg('M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z'), cache_write: svg('M8 2v7.5M4.8 6.5 8 9.7l3.2-3.2M2.5 10.5v2.5h11v-2.5') };
export function Tokens({ usage }: { usage?: Usage }) {
  if (!usage) return null;
  const labels = [['cache_read', T('缓存命中 ', 'Cache hit ')], ['cache_write', T('缓存写入 ', 'Cache write ')]] as const;
  const present = labels.filter(([key]) => usage[key] != null);
  const title = [T('输入 ', 'In ') + num(usage.input), T('输出 ', 'Out ') + num(usage.output), ...present.map(([key, label]) => label + num(usage[key]))].join(' · ')
    + T('（输入已包含缓存）', ' (input includes cached tokens)');
  return <span className="tok" title={title} aria-label={T('Token 用量：', 'Token usage: ') + title}>
    <span className="tok-cache">{([['input', T('输入 ', 'In ')], ['output', T('输出 ', 'Out ')], ...present] as const).map(([key, label]) =>
      <span key={key} className="tok-ico" title={label + num(usage[key])}>{TOKEN_ICON[key]}{compact(usage[key])}</span>)}</span>
  </span>;
}
function Thinking({ text, stream = false }: { text?: string; stream?: boolean }) {
  return text ? <Disclosure className="thinking" chevron="start" title={<span className="thinking-label">{T('思考', 'Thinking')}</span>}>
    <Markdown text={text} className="thinking-body" stream={stream} /></Disclosure> : null;
}
/**
 * GA core synthesises a missing summary from the first thinking line (clipped to 60 chars + '...').
 * Such a summary was not written by the model: the turn body hides it, while headings still
 * use it as a title, restored to the full first thinking line.
 */
function synthetic(turn?: { summary?: string; thinking?: string } | null) {
  const summary = turn?.summary?.trim();
  if (!summary || !turn?.thinking) return undefined;
  const line = turn.thinking.trim().split('\n', 1)[0].trim();
  return summary === line || (summary.endsWith('...') && line.length > 60 && line.startsWith(summary.slice(0, -3))) ? line : undefined;
}
/** Summary shown inside the turn body; undefined when GA synthesised it. */
function summaryOf(turn?: { summary?: string; thinking?: string } | null) {
  return synthetic(turn) ? undefined : turn?.summary?.trim() || undefined;
}
/** Heading title: the model's summary, or the full thinking line GA clipped into one. */
function titleOf(turn?: { summary?: string; thinking?: string } | null) {
  return synthetic(turn) || turn?.summary?.trim() || undefined;
}
function Summary({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  // The full summary stays in the body; step headings truncate and show the full text on hover.
  return <div className="turn-summary"><svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 4h7M6 8h7M6 12h4M3 4h.01M3 8h.01M3 12h.01" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg><div className="turn-summary-text">{text}</div></div>;
}
// Slot "tool": a plugin may take over the rendering of the tool calls it selects.
// ``turn``/``position`` locate the call inside its message; with MessageIndex they address /api/tool-data.
type ToolProps = { tool: ToolCall; awaiting: boolean; turn?: number; position?: number };
const MessageIndex = createContext<number | null>(null);
function Tool(props: ToolProps) {
  return <Slot name="tool" props={props}><ToolView {...props} /></Slot>;
}
/** The result of a finished call. A long one arrives as a preview and is fetched here, i.e. when the row is first opened. */
function ToolResult({ tool, turn, position }: Omit<ToolProps, 'awaiting'>) {
  const index = useContext(MessageIndex);
  const lazy = !!tool.data_lazy && index != null && turn != null && position != null;
  const [full, setFull] = useState<{ data: Json } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!lazy) return;
    let alive = true;
    setFull(null); setError('');
    const sid = host.getSnapshot().state.session_id || '';
    request<{ data: Json }>(`/api/tool-data?session_id=${encodeURIComponent(sid)}&index=${index}&turn=${turn}&tool=${position}`)
      .then(got => { if (alive) setFull({ data: got.data }); },
        (reason: unknown) => { if (alive) setError(String((reason as Error)?.message || reason)); });
    return () => { alive = false; };
  }, [lazy, index, turn, position]);
  if (!tool.data_lazy || full) return <pre>{format(full ? full.data : tool.data) || T('(空)', '(empty)')}</pre>;
  const note = error ? T('完整结果加载失败：', 'Could not load the full result: ') + error
    : lazy ? T('加载完整结果…', 'Loading the full result…')
    : T('已截断，原长 ', 'Truncated, original ') + (tool.data_chars ?? '?') + T(' 字符', ' chars');
  return <pre>{format(tool.data) + '…\n\n' + note}</pre>;
}
const ToolView = memo(function ToolView({ tool, awaiting, turn, position }: ToolProps) {
  const ask = window.GAHOutput.askUserPayload(tool.name, tool.args, tool.data);
  const receipt = { ...window.GAHOutput.toolSummary(tool.name, tool.args) };
  if (ask) receipt.target = receipt.detail = ask.question || T('等待回复', 'Awaiting reply');
  const state = ask && awaiting && (tool.status !== 'done' || tool.ok) ? 'wait' : tool.status !== 'done' ? 'run' : tool.ok ? 'ok' : 'fail';
  const status = state === 'wait' ? T('等待回复', 'Awaiting reply') : state === 'run' ? T('执行中', 'Running') : state === 'fail' ? T('失败', 'Failed') : ask ? T('已提问', 'Asked') : T('已完成', 'Completed');
  const seconds = tool.seconds == null ? null : Number(tool.seconds);
  const elapsed = state !== 'run' && state !== 'wait' && seconds != null && Number.isFinite(seconds) && seconds >= 0 ? ` · ${seconds.toFixed(1)}s` : '';
  const raw = <>{tool.args != null && <><div className="lbl">{T('参数', 'Arguments')}</div><pre>{format(tool.args)}</pre></>}
    {tool.status === 'done' && <><div className="lbl">{T('结果', 'Result')}</div><ToolResult tool={tool} turn={turn} position={position} /></>}</>;
  return <Disclosure className={'tool' + (ask ? ' ask-user' : '')} chevron="start" initial={!!ask} state={state}
    label={[receipt.kind, tool.name || receipt.tool, receipt.detail, status + elapsed].filter(Boolean).join(' · ')} title={<>
      <span className="tkind">{receipt.kind}</span><span className="tname" title={tool.name || receipt.tool}>{receipt.tool}</span>
      {state !== 'ok' && <span className={'tst ' + state}>{status}</span>}
      <span className="targ" title={receipt.detail}>{receipt.target}</span>
    </>}><div className="tool-body">
      <div className={'tool-meta ' + state}>{status + elapsed}</div>
      {ask ? <>
        {ask.question ? <Markdown text={ask.question} className="ask-question" />
          : <div className="ask-hint">{T('未解析到问题，请展开原始数据查看。', 'Could not parse the question. Expand raw data to inspect it.')}</div>}
        {!!ask.candidates.length && <div className="ask-candidates" role="group" aria-label={T('候选回答', 'Suggested replies')}>
          {ask.candidates.map((candidate, i) => <button key={i} type="button" className="ask-candidate" disabled={state === 'fail'}
            title={T('填入输入框，不会自动发送', 'Fill the composer without sending')} onClick={() => host.emit('draft', candidate)}>{candidate}</button>)}
        </div>}
        {awaiting && state !== 'fail' && <div className="ask-hint">{ask.candidates.length
          ? T('选择一个选项或在下方输入回答，确认后发送。', 'Choose an option or type your answer below, then send when ready.')
          : T('请在下方输入回答并发送。', 'Type your answer below and send it.')}</div>}
        <Disclosure className="ask-raw" chevron="start" title={<span>{T('原始数据', 'Raw data')}</span>}>{raw}</Disclosure>
      </> : raw}
    </div></Disclosure>;
});
const TurnBody = memo(function TurnBody({ turn, awaiting = false, stream = false }: { turn: Turn; awaiting?: boolean; stream?: boolean }) {
  return <><Thinking text={turn.thinking} stream={stream} /><Summary text={summaryOf(turn)} />
    {turn.reply && <Markdown text={turn.reply} className="reply" stream={stream} />}
    {turn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} turn={turn.turn} position={index} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
  </>;
});
const Step = memo(function Step({ turn, live }: { turn: Turn; live: boolean }) {
  const title = titleOf(turn) || turn.reply?.split('\n').find(line => line.trim()) || (turn.tools.length ? turn.tools.map(t => t.name).join(', ') : T('思考中…', 'Thinking…'));
  return <Disclosure className={'step' + (live ? ' running' : '')} initial={live} title={<>
    <span className="no">{T('步骤 ', 'Step ')}{turn.turn}</span><span className="ttl" title={title}>{title}</span>
    {!!turn.tools.length && <span className="cnt">{turn.tools.length}{T(' 个工具', ' tools')}</span>}<Tokens usage={turn.usage} />
  </>}><div className="step-body"><TurnBody turn={turn} stream={live} /></div></Disclosure>;
});
function MessageTime({ message }: { message: Message }) {
  if (typeof message.created_at !== 'number' || !Number.isFinite(message.created_at)) return null;
  const date = new Date(message.created_at * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const locale = T('zh-CN', 'en-US');
  const label = message.role === 'user' ? T('发送时间', 'Sent at') : T('回复开始时间', 'Response started at');
  const title = label + ': ' + date.toLocaleString(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  });
  const pad = (value: number) => String(value).padStart(2, '0');
  const display = message.role === 'assistant'
    ? `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return <time className="message-time" dateTime={date.toISOString()} title={title} aria-label={title}>
    {display}
  </time>;
}
function Note({ note }: { note: MessageNote }) {
  const label = note.kind === 'steer' ? T('引导', 'Steer') : note.kind === 'files' ? T('修改的文件', 'Files changed') : note.kind;
  const files = note.kind === 'files' ? filesData(note.data) : null;
  if (files) return <FileChanges data={files} label={label} />;
  return <div className={'msg-note ' + note.kind}><span className="note-kind">{label}</span><div className="note-body">{note.text}</div></div>;
}
// Machine-written wake-ups are notices, not user bubbles. Child task objectives also
// use source: 'conductor', so only known wake-up headers qualify for that source.
// Keep header matching for historical messages that did not persist a source.
const WAKE_HEAD = '[Conductor] Delegated task(s) finished:';
const ACTIVE_HEAD = '[Conductor] Active mode:';
const AUTOPILOT_HEAD = '[Autopilot]';
const REVIEW_HEAD = '[Conductor] Task(s) still awaiting your review:';
const TASK_STATUS: Record<string, () => string> = { done: () => T('完成', 'done'), error: () => T('失败', 'failed'), aborted: () => T('已停止', 'stopped'), cancelled: () => T('已取消', 'cancelled'), interrupted: () => T('中断', 'interrupted') };
export function isConductorWake(m: Message) {
  if (m.role !== 'user') return false;
  if (m.metadata?.conductor) return true;
  if (m.source === 'conductor-reflect') return true;
  if (m.source && m.source !== 'conductor') return false;
  return [WAKE_HEAD, ACTIVE_HEAD, AUTOPILOT_HEAD, REVIEW_HEAD].some(head => m.text?.startsWith(head));
}
function ConductorWake({ m }: { m: Message }) {
  const text = m.text || '';
  const notice = m.metadata?.conductor;
  const reflect = notice ? ['reflect', 'reflect_error'].includes(notice.kind) : m.source === 'conductor-reflect';
  const reflectError = notice ? notice.kind === 'reflect_error' : reflect && text.startsWith('[Conductor event error \u00b7 ');
  const reflectSource = notice?.title ?? (reflect ? /^\[Conductor event(?: error)? \u00b7 (.*?)\]$/.exec(text.split('\n', 1)[0])?.[1] : undefined);
  const active = notice ? notice.kind === 'active' : !reflect && (text.startsWith(ACTIVE_HEAD) || text.startsWith(AUTOPILOT_HEAD));
  const autopilot = active && (notice ? notice.mode === 'autopilot' : text.startsWith(AUTOPILOT_HEAD));
  const completed = notice ? notice.kind === 'wake' : !reflect && text.startsWith(WAKE_HEAD);
  const tasks = notice ? notice.tasks || [] : completed ? text.split('\n').flatMap(line => {
    const hit = /^- (\S+) \u00b7 (.*) \u00b7 (\w+)$/.exec(line.trim());
    return hit ? [{ id: hit[1], title: hit[2], status: hit[3] }] : [];
  }) : [];
  const still = notice ? notice.running || 0 : completed ? Number(/(\d+) task\(s\) still running/.exec(text)?.[1] || 0) : 0;
  const label = reflectError ? T('\u4e8b\u4ef6\u6e90\u5f02\u5e38', 'Event source error')
    : reflect ? T('\u4e8b\u4ef6\u89e6\u53d1', 'Event triggered') : active ? T('\u81ea\u4e3b\u63a8\u8fdb', 'Autopilot')
    : completed ? T('\u6307\u6325\u5bb6', 'Conductor') : T('\u5f85\u5ba1\u9605\u63d0\u9192', 'Review reminder');
  const description = reflect
    ? (reflectSource ? T(`\u6765\u81ea\u4e8b\u4ef6\u6e90\uff1a${reflectSource}`, `From event source: ${reflectSource}`) : T('\u6765\u81ea\u53cd\u5c04\u4e8b\u4ef6\u6e90', 'From a reflect event source'))
    : autopilot ? T('\u4efb\u52a1\u5c1a\u672a\u7ed3\u675f\uff0c\u81ea\u52a8\u7ee7\u7eed\u6267\u884c\u4e0b\u4e00\u6b65', 'Work is still in progress; continuing automatically')
    : active ? T('\u6307\u6325\u5bb6\u81ea\u52a8\u7ee7\u7eed\u63a8\u8fdb\u4efb\u52a1', 'Conductor is continuing the task')
    : completed ? T(`${tasks.length || ''} \u4e2a\u5b50\u4efb\u52a1\u5b8c\u6210\uff0c\u7ee7\u7eed\u5ba1\u9605`, `${tasks.length || ''} subtask(s) finished, reviewing`)
    : T('\u5b50\u4efb\u52a1\u7ed3\u679c\u5c1a\u672a\u5ba1\u9605\uff0c\u7ee7\u7eed\u68c0\u67e5', 'Subtask results are awaiting review');
  return <div className="msg conductor-wake">
    <div className="cw-head">
      <span className="cw-label">{label}</span>
      <span>{description}</span>
      {still > 0 && <span className="cw-still">{T(`\u53e6\u6709 ${still} \u4e2a\u8fd0\u884c\u4e2d`, `${still} still running`)}</span>}
      <MessageTime message={m} />
    </div>
    {tasks.length ? <ul className="cw-tasks">{tasks.map(t => <li key={t.id}>
      <span className={'cw-status ' + t.status}>{TASK_STATUS[t.status]?.() ?? t.status}</span>
      <span className="cw-title">{t.title}</span><code className="cw-id">{t.id}</code>
    </li>)}</ul> : null}
    {text && <Disclosure className="cw-details" chevron="start" title={reflectError ? T('\u5f02\u5e38\u8be6\u60c5', 'Error details') : reflect ? T('\u4e8b\u4ef6\u6b63\u6587', 'Event content') : T('\u89e6\u53d1\u8be6\u60c5', 'Trigger details')}>
      <div className="cw-text">{text}</div>
    </Disclosure>}
  </div>;
}
// Slot "message": plugins may wrap a whole message.
export const ChatMessage = memo(function ChatMessage({ index, ...props }: { message: Message; last: boolean; index?: number }) {
  return <MessageIndex.Provider value={index ?? null}><Slot name="message" props={props}><MessageView {...props} /></Slot></MessageIndex.Provider>;
});
const MessageView = memo(function MessageView({ message: m, last }: { message: Message; last: boolean }) {
  if (isConductorWake(m)) return <ConductorWake m={m} />;
  const turns = (m.turns ?? []).filter(Boolean), running = m.status === 'running', fin = turns.at(-1);
  // A terminal question is user-facing output, not a hidden execution step.
  const finalQuestion = !!fin && !['aborted', 'error'].includes(m.status ?? '')
    && fin.tools.some(t => window.GAHOutput.isAskUser(t.name) && (t.status !== 'done' || t.ok));
  // Once the run has stopped, its last turn is the outcome the user sees, so it stays
  // visible even when it ended on a tool call; only a live turn stays folded in the steps.
  const finalTurn = fin && ((!fin.tools.length && fin.reply) || finalQuestion
    || (!running && (fin.reply || fin.tools.length || fin.thinking))) ? fin : null;
  const steps = finalTurn ? turns.slice(0, -1) : turns;
  const reply = (fin ? fin.reply : m.text) || '';
  const awaiting = last && finalQuestion;
  // A note records the last turn started when it was delivered, so it belongs after
  // that turn. Steps are split into separate collapsible groups around notes, which
  // keeps the order intact and the notes visible when the steps are collapsed.
  const notes = (m.notes ?? []).map((note, i) => ({ note, i, at: typeof note.turn === 'number' ? note.turn : Infinity }));
  const groups: { steps: Turn[]; notes: typeof notes }[] = [{ steps: [], notes: [] }];
  let pending = notes.slice();
  for (const step of steps) {
    const before = pending.filter(n => n.at < (step.turn ?? 0));
    if (before.length) {
      groups.at(-1)!.notes.push(...before);
      pending = pending.filter(n => !before.includes(n));
      groups.push({ steps: [], notes: [] });
    }
    groups.at(-1)!.steps.push(step);
  }
  // Notes delivered during the final answer (e.g. the run's file-change summary) follow it.
  const finalAt = finalTurn ? finalTurn.turn ?? Infinity : !running && fin?.reply ? -Infinity : Infinity;
  const after = pending.filter(n => n.at >= finalAt);
  groups.at(-1)!.notes.push(...pending.filter(n => !after.includes(n)));
  return <div className={'msg ' + m.role}>
    {m.role === 'assistant' && <div className="meta"><span className="dot" /><span className="assistant-name">GenericAgent</span>
      {m.model?.trim() && <span className="model-name" title={T('使用的模型：', 'Model used: ') + m.model}>{m.model}</span>}
      {m.reasoning_effort?.trim() && <span className="reasoning-effort" title={T('本条回复的思考强度：', 'Reasoning effort for this reply: ') + m.reasoning_effort.trim()}>{m.reasoning_effort.trim()}</span>}
      <MessageTime message={m} />
    </div>}
    {m.role === 'user' ? <>{m.source === 'conductor' && <div className="msg-source conductor">{T('来自指挥家', 'From Conductor')}</div>}<MessageAttachments items={m.attachments} />{m.text ? <div className="body">{m.text}</div> : null}<MessageTime message={m} /></> : turns.length ? <>
      {groups.map((group, g) => {
        const tail = g === groups.length - 1, active = running && tail;
        return <Fragment key={g}>
          {!!group.steps.length && <Disclosure className={'steps' + (active ? ' running' : '')} initial={active} lazy={false} title={<>
            <span className="process-dot" /><span>{active ? T('执行中 · ', 'Working · ') : T('执行过程 · ', 'Steps · ')}{group.steps.length}{T(' 步', ' steps')}</span>
          </>}>{group.steps.map((turn, index) => <Step key={turn.turn} turn={turn} live={active && !finalTurn && index === group.steps.length - 1} />)}</Disclosure>}
          {group.notes.map(n => <Note key={n.i} note={n.note} />)}
        </Fragment>;
      })}
      {finalTurn ? <><div className="final-step-label"><span className="no">{T('步骤 ', 'Step ')}{finalTurn.turn ?? turns.length}</span>
        {titleOf(finalTurn) && <span className="ttl" title={titleOf(finalTurn)}>{titleOf(finalTurn)}</span>}<Tokens usage={finalTurn.usage} /></div>
        <Thinking text={finalTurn.thinking} stream={running} /><Summary text={summaryOf(finalTurn)} />
        {finalTurn.reply && <Markdown text={finalTurn.reply} stream={running} className={'body' + (running && !finalTurn.tools.length ? ' cursor' : '')} />}
        {finalTurn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} turn={finalTurn.turn} position={index} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
      </> : running ? <div className="body working cursor" /> : fin?.reply ? <><Summary text={summaryOf(fin)} /><Markdown text={fin.reply} /></> : null}
      {after.map(n => <Note key={n.i} note={n.note} />)}
    </> : <Markdown text={m.text || ''} stream={running} className={'body' + (running ? ' cursor' : '')} />}
    {m.role === 'assistant' && <div className="message-actions">
      <MessageStats m={m} turns={turns} />
      {reply && !running && <CopyButton text={reply} label={T('复制回复', 'Copy reply')} />}
      <Slot name="message.actions" props={{ message: m }} />
    </div>}
    {(m.status === 'aborted' || m.status === 'error') && <div className={'status ' + m.status}>{STATUS[m.status]()}{m.error ? T('：', ': ') + m.error : ''}</div>}
    <Slot name="message.footer" props={{ message: m }} />
  </div>;
});
