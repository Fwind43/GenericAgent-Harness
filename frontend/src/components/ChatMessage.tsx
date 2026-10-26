import { memo } from 'react';
import { T } from '../i18n';
import { host } from '../store';
import type { Message, ToolCall, Turn, Usage } from '../types';
import { CopyButton, Disclosure, Markdown, format } from './Output';

const compact = (n = 0) => n < 1000 ? String(n) : n < 1e6 ? `${Number((n / 1000).toFixed(n < 10000 ? 1 : 0))}k` : `${Number((n / 1e6).toFixed(1))}M`;
export function Tokens({ usage }: { usage?: Usage }) {
  if (!usage) return null;
  const cache = [['cache_read', T('缓存命中 ', 'Cache hit ')], ['cache_write', T('缓存写入 ', 'Cache write ')]] as const;
  const title = [T('输入 ', 'In ') + (usage.input ?? 0).toLocaleString(), T('输出 ', 'Out ') + (usage.output ?? 0).toLocaleString(),
    ...cache.filter(([key]) => usage[key] != null).map(([key, label]) => label + usage[key]!.toLocaleString())].join(' · ');
  return <span className="tok" title={title + T('（输入已包含缓存）', ' (input includes cached tokens)')}>
    <span>↑{compact(usage.input)} ↓{compact(usage.output)}</span>
    <span className="tok-cache">{cache.filter(([key]) => usage[key] != null).map(([key, label]) => label + compact(usage[key])).join(' · ')}</span>
  </span>;
}
function Thinking({ text }: { text?: string }) {
  return text ? <Disclosure className="thinking" title={<span>{T('思考', 'Thinking')}</span>}><Markdown text={text} className="thinking-body" /></Disclosure> : null;
}
function Summary({ text }: { text?: string }) {
  return text?.trim() ? <div className="turn-summary"><span className="turn-summary-icon" aria-hidden="true">◇</span><div className="turn-summary-text">{text}</div></div> : null;
}
const Tool = memo(function Tool({ tool, awaiting }: { tool: ToolCall; awaiting: boolean }) {
  const ask = window.GAHOutput.askUserPayload(tool.name, tool.args, tool.data);
  const receipt = window.GAHOutput.toolSummary(tool.name, tool.args);
  const state = ask && awaiting && (tool.status !== 'done' || tool.ok) ? 'wait' : tool.status !== 'done' ? 'run' : tool.ok ? 'ok' : 'fail';
  const status = state === 'wait' ? T('等待回复', 'Awaiting reply') : state === 'run' ? T('执行中', 'Running') : state === 'fail' ? T('失败', 'Failed') : ask ? T('已提问', 'Asked') : T('已完成', 'Completed');
  const seconds = tool.seconds;
  const elapsed = state !== 'run' && state !== 'wait' && seconds != null && Number.isFinite(seconds) ? ` · ${seconds.toFixed(1)}s` : '';
  const raw = <>{tool.args != null && <><div className="lbl">{T('参数', 'Arguments')}</div><pre>{format(tool.args)}</pre></>}
    {tool.status === 'done' && <><div className="lbl">{T('结果', 'Result')}</div><pre>{format(tool.data) || T('(空)', '(empty)')}</pre></>}</>;
  return <Disclosure className={'tool' + (ask ? ' ask-user' : '')} initial={!!ask} state={state} title={<>
    <span className="tname">{receipt.kind}</span><span className="ttarget" title={ask?.question || receipt.detail}>{ask?.question || receipt.target}</span>
    <span className="tstatus">{status}{elapsed}</span>
  </>}><div className="tool-body">
    {ask ? <><Markdown text={ask.question || T('等待回复', 'Awaiting reply')} className="ask-question" />
      <div className="ask-candidates">{ask.candidates.map((candidate, i) => <button key={i} type="button" disabled={!awaiting} onClick={() => host.emit('draft', candidate)}>{candidate}</button>)}</div>
      <Disclosure className="ask-raw" title={<span>{T('原始数据', 'Raw data')}</span>}>{raw}</Disclosure></> : raw}
  </div></Disclosure>;
});
const TurnBody = memo(function TurnBody({ turn, awaiting = false }: { turn: Turn; awaiting?: boolean }) {
  return <><Thinking text={turn.thinking} /><Summary text={turn.summary} />
    {turn.reply && <Markdown text={turn.reply} className="reply" />}
    {turn.tools.map((tool, index) => <Tool key={tool.id || index} tool={tool} awaiting={awaiting && window.GAHOutput.isAskUser(tool.name)} />)}
  </>;
});
const Step = memo(function Step({ turn, live }: { turn: Turn; live: boolean }) {
  const title = turn.summary || turn.reply?.split('\n').find(line => line.trim()) || turn.tools.map(t => t.name).join(', ') || T('思考中…', 'Thinking…');
  return <Disclosure className={'step' + (live ? ' running' : '')} initial={live} title={<>
    <span className="no">{T('步骤 ', 'Step ')}{turn.turn}</span><span className="ttl">{title}</span>
    {!!turn.tools.length && <span className="cnt">{turn.tools.length}{T(' 个工具', ' tools')}</span>}<Tokens usage={turn.usage} />
  </>}><div className="step-body"><TurnBody turn={turn} /></div></Disclosure>;
});
export const ChatMessage = memo(function ChatMessage({ message: m, last }: { message: Message; last: boolean }) {
  const turns = (m.turns ?? []).filter(Boolean), running = m.status === 'running', fin = turns.at(-1);
  const finalQuestion = !!fin?.tools.some(t => window.GAHOutput.isAskUser(t.name));
  const finalTurn = fin && ((!fin.tools.length && fin.reply) || finalQuestion) ? fin : null;
  const steps = finalTurn ? turns.slice(0, -1) : turns;
  const reply = fin?.reply || m.text || '';
  return <div className={'msg ' + m.role}>
    {m.role === 'assistant' && <div className="meta"><span className="dot" /><span className="assistant-name">GenericAgent</span>
      {m.model && <span className="model-name" title={m.model}>{m.model}</span>}
      {m.reasoning_effort && <span className="reasoning-effort">{m.reasoning_effort}</span>}
    </div>}
    {m.role === 'user' ? <div className="body">{m.text}</div> : turns.length ? <>
      {!!steps.length && <Disclosure className={'steps' + (running ? ' running' : '')} initial={running} title={<>
        <span className="process-dot" /><span>{running ? T('执行中 · ', 'Working · ') : T('执行过程 · ', 'Steps · ')}{steps.length}{T(' 步', ' steps')}</span>
      </>}>{steps.map((turn, index) => <Step key={turn.turn} turn={turn} live={running && !finalTurn && index === steps.length - 1} />)}</Disclosure>}
      {finalTurn ? <><div className="final-step-label"><span className="no">{T('步骤 ', 'Step ')}{finalTurn.turn}</span>
        {finalTurn.summary && <span className="ttl">{finalTurn.summary}</span>}<Tokens usage={finalTurn.usage} /></div>
        <TurnBody turn={finalTurn} awaiting={last && finalQuestion} /></> : running ? <div className="body working cursor" /> : fin?.reply ? <><Summary text={fin.summary} /><Markdown text={fin.reply} /></> : null}
    </> : <Markdown text={m.text || ''} className={'body' + (running ? ' cursor' : '')} />}
    {m.error && <div className="error">{m.error}</div>}
    {m.role === 'assistant' && <div className="message-actions">{reply && !running && <CopyButton text={reply} />}<Tokens usage={m.usage} />
      {m.status === 'aborted' && <span>{T('已停止', 'Stopped')}</span>}</div>}
  </div>;
});
