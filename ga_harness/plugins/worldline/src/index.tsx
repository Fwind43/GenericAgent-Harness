import { useEffect } from 'react';
import { useHost, T, defineReact, host, type PluginAPI } from '@gah/sdk';

type Variant = { order?: (number | null)[]; branches: number[]; count: number; current: number };
type Variants = Record<string, Variant>;

const MARK = 'gah-wl';

function button(label: string, title: string, onClick: () => void, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'gah-wl-btn'; b.textContent = label; b.title = title; b.disabled = disabled;
  b.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return b;
}

async function act(api: PluginAPI, path: string, body: Record<string, unknown>) {
  try { await api.post(path, body); return true; } catch (error) { host.report(error); return false; }
}

// The message being edited in place. It lives outside React so that repaints (state pushes,
// thread re-renders) keep the draft and re-attach the editor to whichever node holds it.
type Editing = { sid: string; index: number; draft: string; sending: boolean };
let editing: Editing | null = null;
let repaint = () => {};

function closeEditor() { editing = null; repaint(); }

function editor(api: PluginAPI, current: Editing, busy: boolean) {
  const box = document.createElement('div');
  box.className = 'gah-wl-edit';
  const area = document.createElement('textarea');
  area.className = 'gah-wl-edit-input';
  area.value = current.draft;
  area.rows = 1;
  const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
  const actions = document.createElement('div');
  actions.className = 'gah-wl-edit-actions';
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'gah-wl-edit-cancel', textContent: T('\u53d6\u6d88', 'Cancel') });
  const send = Object.assign(document.createElement('button'), { type: 'button', className: 'gah-wl-edit-send', textContent: T('\u53d1\u9001', 'Send') });
  const sync = (running: boolean) => { send.disabled = running || current.sending || !area.value.trim(); };
  const submit = async () => {
    if (send.disabled) return;
    current.sending = true; sync(busy);
    const ok = await act(api, 'fork', { session_id: current.sid, index: current.index, text: area.value });
    current.sending = false;
    if (ok && editing === current) closeEditor(); else sync(busy);
  };
  area.addEventListener('input', () => { current.draft = area.value; fit(); sync(busy); });
  area.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
  });
  cancel.addEventListener('click', event => { event.stopPropagation(); closeEditor(); });
  send.addEventListener('click', event => { event.stopPropagation(); void submit(); });
  actions.append(cancel, send);
  box.append(area, actions);
  (box as HTMLElement & { gahSync?: (running: boolean) => void }).gahSync = running => { busy = running; sync(running); };
  sync(busy);
  requestAnimationFrame(() => { fit(); area.focus(); area.setSelectionRange(area.value.length, area.value.length); });
  return box;
}

function bar(api: PluginAPI, sid: string, index: number, text: string, info: Variant | undefined, busy: boolean) {
  const box = document.createElement('div');
  box.className = 'gah-wl-bar';
  box.append(button('\u270e', T('\u7f16\u8f91\u5e76\u91cd\u53d1', 'Edit and resend'), () => {
    editing = { sid, index, draft: text, sending: false };
    repaint();
  }, busy));
  box.append(button('\u21bb', T('\u91cd\u65b0\u751f\u6210', 'Regenerate'), () => act(api, 'fork', { session_id: sid, index }), busy));
  if (info && info.count > 1) {
    const order = info.order ?? [...info.branches, null];
    const prev = order[info.current - 2], next = order[info.current];
    const go = (id: number | null | undefined) => () => { if (typeof id === 'number') void act(api, 'switch', { session_id: sid, branch_id: id }); };
    const nav = document.createElement('span');
    nav.className = 'gah-wl-nav';
    nav.append(
      button('\u2039', T('\u4e0a\u4e00\u6761\u4e16\u754c\u7ebf', 'Previous worldline'), go(prev), busy || typeof prev !== 'number'),
      Object.assign(document.createElement('span'), { className: 'gah-wl-count', textContent: `${info.current}/${info.count}` }),
      button('\u203a', T('\u4e0b\u4e00\u6761\u4e16\u754c\u7ebf', 'Next worldline'), go(next), busy || typeof next !== 'number'),
    );
    box.append(nav);
  }
  return box;
}

const BRANCH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/></svg>';

function branchButton(api: PluginAPI, sid: string, index: number, busy: boolean) {
  const label = T('\u5728\u65b0\u5bf9\u8bdd\u4e2d\u5206\u652f', 'Branch in new chat');
  const b = button('', label, () => act(api, 'branch', { session_id: sid, index }), busy);
  b.className = 'output-copy gah-wl-branch';
  b.setAttribute('aria-label', label);
  b.innerHTML = BRANCH_SVG;
  return b;
}

function textOf(message: unknown) {
  const m = message as { content?: unknown; text?: unknown } | undefined;
  const content = typeof m?.text === 'string' ? m.text : m?.content;
  return typeof content === 'string' ? content : '';
}

function Worldline({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const variants = ((state as unknown as { worldline?: Variants }).worldline || {});
  const wlKey = [
    state.session_id || '',
    state.running ? '1' : '0',
    state.messages.length,
    state.messages.map((m, i) => m?.role === 'user' ? `${i}:u:${textOf(m)}` : `${i}:${m?.role || ''}`).join('\u0001'),
    JSON.stringify(variants),
  ].join('\u0002');
  useEffect(() => {
    const thread = document.getElementById('thread');
    const sid = state.session_id;
    if (!thread || !sid) return;
    const paint = () => {
      observer.disconnect();
      // The host only renders the latest window of messages, so DOM position != message index.
      const nodes = Array.from(thread.children).filter(node => node.classList.contains('msg'));
      const offset = Math.max(0, state.messages.length - nodes.length);
      // The turn an assistant reply belongs to may start above the rendered window.
      let lastUser = -1;
      for (let i = offset - 1; i >= 0; i--) if (state.messages[i]?.role === 'user') { lastUser = i; break; }
      nodes.forEach((node, position) => {
        const index = offset + position;
        node.querySelector(':scope > .gah-wl-bar')?.remove();
        node.querySelector('.gah-wl-branch')?.remove();
        const message = state.messages[index];
        const mine = !!editing && editing.sid === sid && editing.index === index && message?.role === 'user';
        const open = node.querySelector(':scope > .gah-wl-edit') as (HTMLElement & { gahSync?: (running: boolean) => void }) | null;
        if (!mine && open) open.remove();
        node.classList.toggle('gah-wl-editing', mine);
        if (mine && editing) {
          if (open) open.gahSync?.(state.running);
          else node.append(editor(api, editing, state.running));
        }
        if (message?.role === 'assistant' && lastUser >= 0 && !state.running) {
          const actions = node.querySelector('.message-actions');
          if (actions) actions.append(branchButton(api, sid, lastUser, state.running));
          return;
        }
        if (message?.role !== 'user') return;
        // A conductor wake-up is a user message drawn as a notice: it starts a turn but gets no bar.
        lastUser = index;
        if (!node.classList.contains('user')) return;
        node.classList.add(MARK);
        node.append(bar(api, sid, index, textOf(message), variants[String(index)], state.running));
      });
      observer.observe(thread, { childList: true, subtree: !state.running });
    };
    const observer = new MutationObserver(paint);
    repaint = paint;
    paint();
    return () => { observer.disconnect(); if (repaint === paint) repaint = () => {}; };
  }, [api, wlKey]);
  return null;
}

defineReact('worldline', Worldline);
