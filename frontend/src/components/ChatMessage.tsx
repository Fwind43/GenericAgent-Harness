import { memo } from 'react';
import { T } from '../i18n';
import { host } from '../store';
import type { Message, ToolCall, Turn, Usage } from '../types';
import { CopyButton, Disclosure, Markdown, format } from './Output';

// DOM and class names intentionally mirror the legacy ui-web renderer so output.css applies unchanged.
const compact = (n = 0) => n < 1000 ? String(n) : n < 1e6 ? `${Number((n / 1000).toFixed(n < 10000 ? 1 : 0))}k` : `${Number((n / 1e6).toFixed(1))}M`;
const num = (n = 0) => Number(n || 0).toLocaleString('en-US');
const STATUS: Record<string, () => string> = { aborted: () => T('已停止', 'Stopped'), error: () => T('出错', 'Error') };
function usageText(u: Usage) {
  let s = T('输入 ', 'In ') + num(u.input);
  if (u.cache_read || u.cache_write) s += T('（缓存命中 ', ' (cache hit ') + num(u.cache_read) + (u.cache_write ? T(' / 写入 ', ' / write ') + num(u.cache_write) : '') + T('）', ')');
  return s + T(' · 输出 ', ' · Out ') + num(u.output);
}
export function Tokens({ usage }: { usage?: Usage }) {
  if (!usage) return null;
  const labels = [['cache_read', T('缓存命中 ', 'Cache hit ')], ['cache_write', T('缓存写入 ', 'Cache write ')]] as const;
  const present = labels.filter(([key]) => usage[key] != null);
  const title = [T('输入 ', 'In ') + num(usage.input), T('输出 ', 'Out ') + num(usage.output), ...present.map(([key, label]) => label + num(usage[key]))].join(' · ')
    + T('（输入已包含缓存）', ' (input includes cached tokens)');
  return <span className="tok" title={title} aria-label={T('Token 用量：', 'Token usage: ') + title}>
    <span>↑{compact(usage.input)} ↓{compact(usage.output)}</span>
    {!!present.length && <span className="tok-cache">{present.map(([key, label]) => label + compact(usage[key])).join(' · ')}</span>}
  </span>;
}
function Thinking({ text }: { text?: string }) {
  return text ? <Disclosure className="thinking" chevron="start" title={<span className="thinking-label">{T('思考', 'Thinking')}</span>}>
    <Markdown text={text} className="thinking-body" /></Disclosure> : null;
}
function Summary({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  // The full summary stays in the body; only step headings may ellipsize.
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
const TurnBody = memo(function TurnBody({ turn, awaiting = false }: { turn: Turn; awaiting?: boolean }) {
  return <><Thinking text={turn.thinking} /><Summary text={turn.summary} />
    {turn.reply && <Markdown text={turn.reply} className="reply" />}
    {turn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
  </>;
});
const Step = memo(function Step({ turn, live }: { turn: Turn; live: boolean }) {
  const title = turn.summary || turn.reply?.split('\n').find(line => line.trim()) || (turn.tools.length ? turn.tools.map(t => t.name).join(', ') : T('思考中…', 'Thinking…'));
  return <Disclosure className={'step' + (live ? ' running' : '')} initial={live} title={<>
    <span className="no">{T('步骤 ', 'Step ')}{turn.turn}</span><span className="ttl">{title}</span>
    {!!turn.tools.length && <span className="cnt">{turn.tools.length}{T(' 个工具', ' tools')}</span>}<Tokens usage={turn.usage} />
  </>}><div className="step-body"><TurnBody turn={turn} /></div></Disclosure>;
});
export const ChatMessage = memo(function ChatMessage({ message: m, last }: { message: Message; last: boolean }) {
  const turns = (m.turns ?? []).filter(Boolean), running = m.status === 'running', fin = turns.at(-1);
  // A terminal question is user-facing output, not a hidden execution step.
  const finalQuestion = !!fin && !['aborted', 'error'].includes(m.status ?? '')
    && fin.tools.some(t => window.GAHOutput.isAskUser(t.name) && (t.status !== 'done' || t.ok));
  const finalTurn = fin && ((!fin.tools.length && fin.reply) || finalQuestion) ? fin : null;
  const steps = finalTurn ? turns.slice(0, -1) : turns;
  const reply = (fin ? fin.reply : m.text) || '';
  const awaiting = last && finalQuestion;
  return <div className={'msg ' + m.role}>
    {m.role === 'assistant' && <div className="meta"><span className="dot" /><span className="assistant-name">GenericAgent</span>
      {m.model?.trim() && <span className="model-name" title={T('使用的模型：', 'Model used: ') + m.model}>{m.model}</span>}
      {m.reasoning_effort?.trim() && <span className="reasoning-effort" title={T('本条回复的思考强度：', 'Reasoning effort for this reply: ') + m.reasoning_effort.trim()}>{m.reasoning_effort.trim()}</span>}
    </div>}
    {m.role === 'user' ? <div className="body">{m.text}</div> : turns.length ? <>
      {!!steps.length && <Disclosure className={'steps' + (running ? ' running' : '')} initial={running} title={<>
        <span className="process-dot" /><span>{running ? T('执行中 · ', 'Working · ') : T('执行过程 · ', 'Steps · ')}{steps.length}{T(' 步', ' steps')}</span>
      </>}>{steps.map((turn, index) => <Step key={turn.turn} turn={turn} live={running && !finalTurn && index === steps.length - 1} />)}</Disclosure>}
      {finalTurn ? <><div className="final-step-label"><span className="no">{T('步骤 ', 'Step ')}{finalTurn.turn ?? turns.length}</span>
        {finalTurn.summary && <span className="ttl">{finalTurn.summary}</span>}<Tokens usage={finalTurn.usage} /></div>
        <Thinking text={finalTurn.thinking} /><Summary text={finalTurn.summary} />
        {finalTurn.reply && <Markdown text={finalTurn.reply} className={'body' + (running && !finalTurn.tools.length ? ' cursor' : '')} />}
        {finalTurn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
      </> : running ? <div className="body working cursor" /> : fin?.reply ? <><Summary text={fin.summary} /><Markdown text={fin.reply} /></> : null}
    </> : <Markdown text={m.text || ''} className={'body' + (running ? ' cursor' : '')} />}
    {m.role === 'assistant' && ((reply && !running) || !!m.usage?.calls) && <div className="message-actions">
      {reply && !running && <CopyButton text={reply} label={T('复制回复', 'Copy reply')} />}
      {!!m.usage?.calls && <div className="usage">{m.usage.calls}{T(' 次调用 · ', ' calls · ')}{usageText(m.usage)}</div>}
    </div>}
    {(m.status === 'aborted' || m.status === 'error') && <div className={'status ' + m.status}>{STATUS[m.status]()}{m.error ? T('：', ': ') + m.error : ''}</div>}
  </div>;
});
