import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { request } from './api';
import { save, saved, T } from './i18n';
import { host, useHost } from './store';
import { plugins } from './plugin-runtime';
import { Settings } from './components/Settings';
import { GeneralSettings } from './components/GeneralSettings';
import { ChatMessage } from './components/ChatMessage';
import { ModeBadge, ModePicker } from './components/ModePicker';
import { SessionStats, sessionStats } from './components/SessionStats';
import type { SlotName } from './sdk';

// React never reconciles the children owned by a plugin.
const Slot = memo(function Slot({ name }: { name: SlotName }) {
  return <div className="gah-slot" data-slot={name} />;
});
// Desktop sidebar: collapsible and resizable, both remembered locally. Narrow screens keep the drawer.
const SIDE_MIN = 200, SIDE_MAX = 480, SIDE_DEFAULT = 260, SIDE_SNAP = 140;
const narrow = () => window.matchMedia('(max-width:760px)').matches;
const clampSide = (value: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(value)));
const savedSide = () => { const value = Number(saved('gah-side-width')); return value ? clampSide(value) : SIDE_DEFAULT; };
// The backend stores this default chat title untranslated; it is localized only for display.
const NEW_TITLE = '\u65b0\u4f1a\u8bdd';
export function App() {
  const { state, connected, changing, notice } = useHost();
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false), [sidebar, setSidebar] = useState(false);
  const [collapsed, setCollapsed] = useState(() => saved('gah-side-collapsed') === '1');
  const [sideWidth, setSideWidth] = useState(savedSide), [resizing, setResizing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLElement>(null);
  const stick = useRef(true), submitting = useRef(false);
  const busy = state.running || changing || sending;
  const stats = sessionStats(state.messages ?? []);
  const currentSession = state.sessions?.find((session) => session.id === state.session_id);
  const sessionTitle = !currentSession ? '' : !currentSession.title || currentSession.title === NEW_TITLE ? T(NEW_TITLE, 'New chat') : currentSession.title;
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
  useEffect(() => {
    document.body.classList.toggle('side-collapsed', collapsed);
    save('gah-side-collapsed', collapsed ? '1' : '0');
  }, [collapsed]);
  useEffect(() => { document.body.classList.toggle('side-resizing', resizing); }, [resizing]);
  useEffect(() => { if (!resizing) save('gah-side-width', String(sideWidth)); }, [sideWidth, resizing]);
  useLayoutEffect(() => {
    const node = input.current;
    if (node) { node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }
  }, [draft]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [state.messages, state.session_id]);
  function toggleSide(open: boolean) { if (narrow()) setSidebar(open); else setCollapsed(!open); }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget, left = handle.parentElement?.getBoundingClientRect().left ?? 0;
    handle.setPointerCapture(event.pointerId); setResizing(true);
    let raw = sideWidth;
    const move = (e: PointerEvent) => { raw = e.clientX - left; setSideWidth(clampSide(raw)); };
    const end = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      setResizing(false);
      if (raw < SIDE_SNAP) setCollapsed(true);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }
  function resizeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft') setSideWidth(w => clampSide(w - step));
    else if (event.key === 'ArrowRight') setSideWidth(w => clampSide(w + step));
    else if (event.key === 'Home') setSideWidth(SIDE_MIN);
    else if (event.key === 'End') setSideWidth(SIDE_MAX);
    else return;
    event.preventDefault();
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const task = draft.trim();
    // While a task runs, plugins (e.g. run-queue) may claim the message; otherwise it is refused.
    if (!task || changing || sending || submitting.current) return;
    submitting.current = true; setSending(true); host.notice();
    try {
      if (!(await plugins.claim(task))) {
        if (state.running) { host.notice(T('任务运行中，请稍候', 'A task is running; please wait')); return; }
        await request('/api/run', { task, session_id: state.session_id });
      }
      setDraft(''); stick.current = true;
    } catch (error) { host.report(error); }
    finally { submitting.current = false; setSending(false); input.current?.focus(); }
  }
  async function abort() {
    setStopping(true);
    try { await request('/api/abort', { run_id: state.run_id, session_id: state.session_id }); } catch (error) { host.report(error); }
    finally { setStopping(false); }
  }
  return <>
    <aside className="sidebar" id="sidebar" style={{ '--side-w': `${sideWidth}px` } as CSSProperties}>
      <div className="side-head"><img className="side-logo" src="/ui-web-assets/ga-logo.png" width={28} height={28} alt="" /><h1>GenericAgent-Harness</h1><button type="button" className="icon-btn side-close" data-gah-close onClick={() => { if (!narrow()) setCollapsed(true); }} title={T('收起侧边栏', 'Collapse sidebar')} aria-label={T('收起侧边栏', 'Close sidebar')}>×</button></div>
      <div className="side-body"><Slot name="sidebar" /></div>
      <div className="side-resize" role="separator" aria-orientation="vertical" aria-controls="sidebar" aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX} aria-valuenow={sideWidth} aria-label={T('拖动调整侧边栏宽度', 'Resize sidebar')} title={T('拖动调整宽度，双击恢复默认', 'Drag to resize, double-click to reset')} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeKey} onDoubleClick={() => setSideWidth(SIDE_DEFAULT)} />
      <div className="side-foot"><Slot name="sidebar-foot" /><Settings><GeneralSettings /><Slot name="settings" /></Settings><div className="side-conn"><span id="dot" className={'dot' + (connected ? ' live' : '')} /><span id="conn">{connected ? T('已连接', 'Connected') : T('连接中…', 'Connecting…')}</span></div></div>
    </aside>
    <div className="scrim" data-gah-close />
    <div className="main-col">
      <header><button type="button" className="icon-btn" id="sideOpen" aria-controls="sidebar" aria-expanded={sidebar} aria-label={T('打开侧边栏', 'Open sidebar')} title={T('展开侧边栏', 'Expand sidebar')} onClick={() => toggleSide(true)}>☰</button>
        {sessionTitle ? <h2 className="session-title" title={sessionTitle}>{sessionTitle}</h2> : null}{sessionTitle ? <ModeBadge /> : null}<span className="spacer" /><Slot name="header" />
      </header>
      <nav className="toolbar gah-bar" aria-label={T('工具栏', 'Toolbar')}><Slot name="toolbar" /></nav>
      <div id="notice" role="status" hidden={!notice}>{notice}</div>
      <main id="scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
        <div id="thread">{state.messages.length ? state.messages.map((message, index) => <ChatMessage key={`${state.session_id ?? ''}:${index}`} message={message} last={index === state.messages.length - 1} />) : <div className="empty">{T('开始一个新任务', 'Start a new task')}</div>}</div>
      </main>
      <footer>{state.messages.length ? null : <div className="new-chat-bar"><ModePicker disabled={busy} /></div>}<form id="form" onSubmit={send}>
        <Slot name="composer-top" />
        <textarea id="input" ref={input} rows={1} autoFocus value={draft} placeholder={T('给 GenericAgent 发消息…', 'Message GenericAgent…')} aria-label={T('消息', 'Message')} onChange={event => setDraft(event.target.value)} onFocus={() => host.emit('composer-focus', true)} onBlur={() => host.emit('composer-focus', false)} onKeyDown={event => {
          host.emit('composer-key', event);
          if (event.defaultPrevented) return;
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className="composer-row"><Slot name="composer" /><span className="spacer" />
          <button type="button" id="stop" className="stop" hidden={!state.running} disabled={stopping} onClick={abort}>{T('停止', 'Stop')}</button>
          <button type="submit" id="send" disabled={changing || sending || !draft.trim()}>{T('发送', 'Send')}</button>
        </div>
      </form>{stats.length ? <SessionStats messages={state.messages} /> : <div className="hint">{T('Enter 发送 · Shift+Enter 换行 · 同一时间只运行一个任务', 'Enter to send · Shift+Enter for a new line · one task at a time')}</div>}</footer>
    </div><Slot name="overlay" />
  </>;
}
