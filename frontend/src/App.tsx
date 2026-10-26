import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { request } from './api';
import { language, save, T } from './i18n';
import { host, useHost } from './store';
import { plugins } from './plugin-runtime';
import { ChatMessage } from './components/ChatMessage';
import { SessionStats, sessionStats } from './components/SessionStats';
import type { SlotName } from './sdk';

// React never reconciles the children owned by a plugin.
const Slot = memo(function Slot({ name }: { name: SlotName }) {
  return <div className="gah-slot" data-slot={name} />;
});
export function App() {
  const { state, connected, changing, notice } = useHost();
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false), [sidebar, setSidebar] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLElement>(null);
  const stick = useRef(true), submitting = useRef(false);
  const busy = state.running || changing || sending;
  const stats = sessionStats(state.messages ?? []);
  useEffect(() => host.connect(), []);
  useEffect(() => {
    plugins.sync(state.web_plugins ?? []);
  }, [state.web_plugins]);
  useEffect(() => () => plugins.dispose(), []);
  useEffect(() => host.on('draft', value => { setDraft(String(value)); input.current?.focus(); }), []);
  useEffect(() => { host.emit('composer-draft', draft); }, [draft]);
  useEffect(() => host.on('reset', () => { setDraft(''); stick.current = true; setSidebar(false); }), []);
  useEffect(() => {
    // Legacy plugins dispatch a non-bubbling input event after setting .value.
    const node = input.current;
    const sync = () => { if (node) setDraft(node.value); };
    node?.addEventListener('input', sync);
    return () => node?.removeEventListener('input', sync);
  }, []);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-gah-close]')) setSidebar(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setSidebar(false); };
    document.addEventListener('click', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => {
    document.body.classList.add('app');
    document.body.classList.toggle('side-open', sidebar);
    return () => document.body.classList.remove('side-open');
  }, [sidebar]);
  useLayoutEffect(() => {
    const node = input.current;
    if (node) { node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }
  }, [draft]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [state.messages, state.session_id]);
  async function send(event: FormEvent) {
    event.preventDefault();
    const task = draft.trim();
    if (!task || busy || submitting.current) return;
    submitting.current = true; setSending(true); host.notice();
    try {
      if (!(await plugins.claim(task))) await request('/api/run', { task });
      setDraft(''); stick.current = true;
    } catch (error) { host.report(error); }
    finally { submitting.current = false; setSending(false); input.current?.focus(); }
  }
  async function abort() {
    setStopping(true);
    try { await request('/api/abort', {}); } catch (error) { host.report(error); }
    finally { setStopping(false); }
  }
  return <>
    <aside className="sidebar" id="sidebar">
      <div className="side-head"><img className="side-logo" src="/ui-web-assets/ga-logo.png" width={28} height={28} alt="" /><h1>ga-harness</h1><button type="button" className="icon-btn side-close" data-gah-close aria-label={T('收起侧边栏', 'Close sidebar')}>×</button></div>
      <div className="side-body"><Slot name="sidebar" /></div>
      <div className="side-foot"><Slot name="sidebar-foot" /><div className="side-conn"><span id="dot" className={'dot' + (connected ? ' live' : '')} /><span id="conn">{connected ? T('已连接', 'Connected') : T('连接中…', 'Connecting…')}</span></div></div>
    </aside>
    <div className="scrim" data-gah-close />
    <div className="main-col">
      <header><button type="button" className="icon-btn" id="sideOpen" aria-controls="sidebar" aria-expanded={sidebar} aria-label={T('打开侧边栏', 'Open sidebar')} onClick={() => setSidebar(true)}>☰</button>
        <span className="spacer" /><Slot name="header" />
        <button type="button" className="icon-btn lang-btn" id="langBtn" title={T('Switch to English', '切换到中文')} onClick={() => { save('gah-lang', language === 'zh' ? 'en' : 'zh'); location.reload(); }}>{T('EN', '中')}</button>
      </header>
      <nav className="toolbar gah-bar" aria-label={T('工具栏', 'Toolbar')}><Slot name="toolbar" /></nav>
      <div id="notice" role="status" hidden={!notice}>{notice}</div>
      <main id="scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
        <div id="thread">{state.messages.length ? state.messages.map((message, index) => <ChatMessage key={`${state.session_id ?? ''}:${index}`} message={message} last={index === state.messages.length - 1} />) : <div className="empty">{T('开始一个新任务', 'Start a new task')}</div>}</div>
      </main>
      <footer><form id="form" onSubmit={send}>
        <Slot name="composer-top" />
        <textarea id="input" ref={input} rows={1} autoFocus value={draft} placeholder={T('给 GenericAgent 发消息…', 'Message GenericAgent…')} aria-label={T('消息', 'Message')} onChange={event => setDraft(event.target.value)} onFocus={() => host.emit('composer-focus', true)} onBlur={() => host.emit('composer-focus', false)} onKeyDown={event => {
          host.emit('composer-key', event);
          if (event.defaultPrevented) return;
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className="composer-row"><Slot name="composer" /><span className="spacer" />
          <button type="button" id="stop" className="stop" hidden={!state.running} disabled={stopping} onClick={abort}>{T('停止', 'Stop')}</button>
          <button type="submit" id="send" disabled={busy || !draft.trim()}>{T('发送', 'Send')}</button>
        </div>
      </form>{stats.length ? <SessionStats messages={state.messages} /> : <div className="hint">{T('Enter 发送 · Shift+Enter 换行 · 同一时间只运行一个任务', 'Enter to send · Shift+Enter for a new line · one task at a time')}</div>}</footer>
    </div><Slot name="overlay" />
  </>;
}
