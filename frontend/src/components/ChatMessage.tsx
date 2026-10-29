import { Fragment, memo } from 'react';
import { T } from '../i18n';
import { host } from '../store';
import type { Message, MessageNote, ToolCall, Turn, Usage } from '../types';
import { CopyButton, Disclosure, Markdown, format } from './Output';
import { MessageStats } from './MessageStats';

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
  // The full summary stays in the body; step headings wrap rather than truncate.
  return <div className="turn-summary"><svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 4h7M6 8h7M6 12h4M3 4h.01M3 8h.01M3 12h.01" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg><div className="turn-summary-text">{text}</div></div>;
}
const Tool = memo(function Tool({ tool, awaiting }: { tool: ToolCall; awaiting: boolean }) {
  const ask = window.GAHOutput.askUserPayload(tool.name, tool.args, tool.data);
  const receipt = { ...window.GAHOutput.toolSummary(tool.name, tool.args) };
  if (ask) receipt.target = receipt.detail = ask.question || T('等待回复', 'Awaiting reply');
  const state = ask && awaiting && (tool.status !== 'done' || tool.ok) ? 'wait' : tool.status !== 'done' ? 'run' : tool.ok ? 'ok' : 'fail';
  const status = state === 'wait' ? T('等待回复', 'Awaiting reply') : state === 'run' ? T('执行中', 'Running') : state === 'fail' ? T('失败', 'Failed') : ask ? T('已提问', 'Asked') : T('已完成', 'Completed');
  const seconds = tool.seconds == null ? null : Number(tool.seconds);
  const elapsed = state !== 'run' && state !== 'wait' && seconds != null && Number.isFinite(seconds) && seconds >= 0 ? ` · ${seconds.toFixed(1)}s` : '';
  const raw = <>{tool.args != null && <><div className="lbl">{T('参数', 'Arguments')}</div><pre>{format(tool.args)}</pre></>}
    {tool.status === 'done' && <><div className="lbl">{T('结果', 'Result')}</div><pre>{format(tool.data) || T('(空)', '(empty)')}</pre></>}</>;
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
    {turn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
  </>;
});
const Step = memo(function Step({ turn, live }: { turn: Turn; live: boolean }) {
  const title = titleOf(turn) || turn.reply?.split('\n').find(line => line.trim()) || (turn.tools.length ? turn.tools.map(t => t.name).join(', ') : T('思考中…', 'Thinking…'));
  return <Disclosure className={'step' + (live ? ' running' : '')} initial={live} title={<>
    <span className="no">{T('步骤 ', 'Step ')}{turn.turn}</span><span className="ttl">{title}</span>
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
  const label = note.kind === 'steer' ? T('引导', 'Steer') : note.kind;
  return <div className={'msg-note ' + note.kind}><span className="note-kind">{label}</span><div className="note-body">{note.text}</div></div>;
}
export const ChatMessage = memo(function ChatMessage({ message: m, last }: { message: Message; last: boolean }) {
  const turns = (m.turns ?? []).filter(Boolean), running = m.status === 'running', fin = turns.at(-1);
  // A terminal question is user-facing output, not a hidden execution step.
  const finalQuestion = !!fin && !['aborted', 'error'].includes(m.status ?? '')
    && fin.tools.some(t => window.GAHOutput.isAskUser(t.name) && (t.status !== 'done' || t.ok));
  const finalTurn = fin && ((!fin.tools.length && fin.reply) || finalQuestion) ? fin : null;
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
  groups.at(-1)!.notes.push(...pending);
  return <div className={'msg ' + m.role}>
    {m.role === 'assistant' && <div className="meta"><span className="dot" /><span className="assistant-name">GenericAgent</span>
      {m.model?.trim() && <span className="model-name" title={T('使用的模型：', 'Model used: ') + m.model}>{m.model}</span>}
      {m.reasoning_effort?.trim() && <span className="reasoning-effort" title={T('本条回复的思考强度：', 'Reasoning effort for this reply: ') + m.reasoning_effort.trim()}>{m.reasoning_effort.trim()}</span>}
      <MessageTime message={m} />
    </div>}
    {m.role === 'user' ? <><div className="body">{m.text}</div><MessageTime message={m} /></> : turns.length ? <>
      {groups.map((group, g) => {
        const tail = g === groups.length - 1, active = running && tail;
        return <Fragment key={g}>
          {!!group.steps.length && <Disclosure className={'steps' + (active ? ' running' : '')} initial={active} title={<>
            <span className="process-dot" /><span>{active ? T('执行中 · ', 'Working · ') : T('执行过程 · ', 'Steps · ')}{group.steps.length}{T(' 步', ' steps')}</span>
          </>}>{group.steps.map((turn, index) => <Step key={turn.turn} turn={turn} live={active && !finalTurn && index === group.steps.length - 1} />)}</Disclosure>}
          {group.notes.map(n => <Note key={n.i} note={n.note} />)}
        </Fragment>;
      })}
      {finalTurn ? <><div className="final-step-label"><span className="no">{T('步骤 ', 'Step ')}{finalTurn.turn ?? turns.length}</span>
        {titleOf(finalTurn) && <span className="ttl">{titleOf(finalTurn)}</span>}<Tokens usage={finalTurn.usage} /></div>
        <Thinking text={finalTurn.thinking} stream={running} /><Summary text={summaryOf(finalTurn)} />
        {finalTurn.reply && <Markdown text={finalTurn.reply} stream={running} className={'body' + (running && !finalTurn.tools.length ? ' cursor' : '')} />}
        {finalTurn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
      </> : running ? <div className="body working cursor" /> : fin?.reply ? <><Summary text={summaryOf(fin)} /><Markdown text={fin.reply} /></> : null}
    </> : <Markdown text={m.text || ''} stream={running} className={'body' + (running ? ' cursor' : '')} />}
    {m.role === 'assistant' && <div className="message-actions">
      <MessageStats m={m} turns={turns} />
      {reply && !running && <CopyButton text={reply} label={T('复制回复', 'Copy reply')} />}
    </div>}
    {(m.status === 'aborted' || m.status === 'error') && <div className={'status ' + m.status}>{STATUS[m.status]()}{m.error ? T('：', ': ') + m.error : ''}</div>}
  </div>;
});
