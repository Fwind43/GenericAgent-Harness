import { useMemo, useState } from 'react';
import { type PluginAPI, useHost, T, ViewPanel, defineReact } from '@gah/sdk';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Usage = { input?: number; output?: number; cache_read?: number; calls?: number };
type Tool = { id?: string; name: string; args?: Json; data?: Json; status: string; ok?: boolean; seconds?: number };
type Turn = { turn: number; summary?: string; thinking?: string; reply?: string; status?: string; tools?: Tool[]; usage?: Usage; llm?: { seconds?: number; ttft?: number | null } };
type Note = { kind: string; text: string; turn: number };
type Message = { role: 'user' | 'assistant'; text?: string; status?: string; error?: string; turns?: Turn[]; usage?: Usage; model?: string; reasoning_effort?: string; notes?: Note[] };

// One timeline row. kind drives the dot colour; detail is shown when expanded.
type Row = { key: string; kind: 'input' | 'model' | 'tool' | 'note' | 'output' | 'error'; title: string; meta?: string; seconds?: number; failed?: boolean; detail?: string };
type Run = { key: string; index: number; input: string; status?: string; model?: string; rows: Row[]; seconds: number; tools: number; usage?: Usage };

const secs = (value?: number) => value == null ? '' : value < 1 ? Math.round(value * 1000) + 'ms' : value < 60 ? value.toFixed(1) + 's' : Math.floor(value / 60) + 'm' + Math.round(value % 60) + 's';
const num = (value?: number) => value == null ? '' : value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(value);
const text = (value: Json | undefined) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const clip = (value: string, size = 120) => { const line = value.replace(/\s+/g, ' ').trim(); return line.length > size ? line.slice(0, size) + '…' : line; };
const usageMeta = (usage?: Usage) => usage ? [usage.input != null && T('输入 ', 'in ') + num(usage.input), usage.output != null && T('输出 ', 'out ') + num(usage.output), usage.cache_read ? T('缓存 ', 'cache ') + num(usage.cache_read) : ''].filter(Boolean).join(' · ') : '';
// Short, human hint for a tool call: the most telling argument instead of the whole JSON.
function toolHint(args: Json | undefined) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return clip(text(args), 90);
  for (const key of ['path', 'file', 'url', 'command', 'cmd', 'script', 'query', 'pattern', 'code']) if (typeof args[key] === 'string') return clip(args[key] as string, 90);
  return clip(text(args), 90);
}

export function buildRuns(messages: Message[]): Run[] {
  const runs: Run[] = [];
  let input = '';
  messages.forEach((message, index) => {
    if (message.role === 'user') { input = message.text || ''; return; }
    const rows: Row[] = [{ key: index + ':in', kind: 'input', title: T('用户输入', 'User input'), meta: clip(input, 80), detail: input }];
    const notes = message.notes || [];
    let seconds = 0, tools = 0;
    const pushNotes = (turn: number) => notes.filter(note => note.turn === turn).forEach((note, n) => rows.push({
      key: index + ':n' + turn + ':' + n, kind: 'note', title: note.kind === 'steer' ? T('引导消息', 'Steering message') : note.kind, meta: clip(note.text, 80), detail: note.text,
    }));
    pushNotes(0);
    for (const turn of message.turns || []) {
      const llm = turn.llm?.seconds;
      seconds += llm || 0;
      const meta = [turn.llm?.ttft != null && T('首字 ', 'TTFT ') + secs(turn.llm.ttft), usageMeta(turn.usage)].filter(Boolean).join(' · ');
      rows.push({ key: index + ':m' + turn.turn, kind: 'model', title: T('模型调用 · 第 ', 'Model call · turn ') + turn.turn + T(' 轮', ''), meta: meta || clip(turn.summary || '', 80), seconds: llm,
        detail: [turn.summary && T('摘要：', 'Summary: ') + turn.summary, turn.thinking && T('思考：\n', 'Thinking:\n') + turn.thinking, turn.reply && T('回复：\n', 'Reply:\n') + turn.reply].filter(Boolean).join('\n\n') });
      for (const [n, tool] of (turn.tools || []).entries()) {
        tools += 1; seconds += tool.seconds || 0;
        const failed = tool.ok === false || tool.status === 'error';
        rows.push({ key: index + ':t' + turn.turn + ':' + n, kind: 'tool', title: tool.name, meta: toolHint(tool.args), seconds: tool.seconds, failed,
          detail: T('参数：\n', 'Arguments:\n') + text(tool.args) + (tool.data != null ? T('\n\n结果：\n', '\n\nResult:\n') + text(tool.data) : '') });
      }
      pushNotes(turn.turn);
    }
    if (message.error) rows.push({ key: index + ':err', kind: 'error', title: T('错误', 'Error'), meta: clip(message.error, 80), failed: true, detail: message.error });
    else if (message.text) rows.push({ key: index + ':out', kind: 'output', title: T('最终输出', 'Final output'), meta: clip(message.text, 80), detail: message.text });
    runs.push({ key: String(index), index: runs.length + 1, input, status: message.status, model: message.model, rows, seconds, tools, usage: message.usage });
    input = '';
  });
  return runs;
}

const statusLabel = (status?: string) => ({ running: T('运行中', 'Running'), done: T('完成', 'Done'), error: T('出错', 'Error'), aborted: T('已中止', 'Aborted'), interrupted: T('已中断', 'Interrupted') } as Record<string, string>)[status || ''] || status || '';

function TraceRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  return <li className={'gah-trace-row k-' + row.kind + (row.failed ? ' failed' : '')}>
    <button type="button" className="gah-trace-head" aria-expanded={open} disabled={!row.detail} onClick={() => setOpen(value => !value)}>
      <span className="gah-trace-dot" aria-hidden="true" />
      <span className="gah-trace-title">{row.title}</span>
      {row.meta ? <span className="gah-trace-meta">{row.meta}</span> : null}
      {row.seconds != null ? <span className="gah-trace-secs">{secs(row.seconds)}</span> : null}
    </button>
    {open && row.detail ? <pre className="gah-trace-detail">{row.detail}</pre> : null}
  </li>;
}

function TraceRun({ run, last }: { run: Run; last: boolean }) {
  const [open, setOpen] = useState(last);
  return <section className="gah-trace-run">
    <button type="button" className="gah-trace-run-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="gah-trace-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span className="gah-trace-run-title">{T('任务 ', 'Run ') + run.index}<em>{clip(run.input, 60) || T('（无输入）', '(no input)')}</em></span>
      <span className="gah-trace-run-meta">{[statusLabel(run.status), run.model, run.tools + T(' 次工具', ' tools'), secs(run.seconds), usageMeta(run.usage)].filter(Boolean).join(' · ')}</span>
    </button>
    {open ? <ol className="gah-trace-list">{run.rows.map(row => <TraceRow key={row.key} row={row} />)}</ol> : null}
  </section>;
}

function Trace() {
  const { state } = useHost();
  const runs = useMemo(() => buildRuns((state.messages || []) as Message[]), [state.messages]);
  if (!runs.length) return <div className="gah-trace-empty"><b>{T('还没有轨迹', 'No trace yet')}</b>{T('发送一条消息后，这里会按时间线展示模型调用、工具调用和耗时。', 'After you send a message, model calls, tool calls and timings appear here as a timeline.')}</div>;
  return <div className="gah-trace">{runs.map((run, n) => <TraceRun key={run.key + ':' + runs.length} run={run} last={n === runs.length - 1} />)}</div>;
}

function TraceView({ api }: { api: PluginAPI }) {
  return <ViewPanel api={api} label={T('轨迹', 'Trace')} order={10} className="gah-trace-view"><Trace /></ViewPanel>;
}

defineReact('web-trace', TraceView);
