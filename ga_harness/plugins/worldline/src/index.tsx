import { useEffect } from 'react';
import { useHost, T, defineReact, promptDialog, host, type PluginAPI } from '@gah/sdk';

type Variant = { branches: number[]; count: number; current: number };
type Variants = Record<string, Variant>;

const MARK = 'gah-wl';

function button(label: string, title: string, onClick: () => void, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'gah-wl-btn'; b.textContent = label; b.title = title; b.disabled = disabled;
  b.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return b;
}

async function act(api: PluginAPI, path: string, body: Record<string, unknown>) {
  try { await api.post(path, body); } catch (error) { host.report(error); }
}

function bar(api: PluginAPI, sid: string, index: number, text: string, info: Variant | undefined, busy: boolean) {
  const box = document.createElement('div');
  box.className = 'gah-wl-bar';
  box.append(button('\u270e', T('\u7f16\u8f91\u5e76\u91cd\u53d1', 'Edit and resend'), async () => {
    const value = await promptDialog({ title: T('\u7f16\u8f91\u6d88\u606f', 'Edit message'), value: text, confirm: T('\u53d1\u9001', 'Send') });
    if (value !== null && value.trim()) await act(api, 'fork', { session_id: sid, index, text: value });
  }, busy));
  box.append(button('\u21bb', T('\u91cd\u65b0\u751f\u6210', 'Regenerate'), () => act(api, 'fork', { session_id: sid, index }), busy));
  if (info && info.branches.length) {
    const ids = info.branches;
    const nav = document.createElement('span');
    nav.className = 'gah-wl-nav';
    nav.append(
      button('\u2039', T('\u4e0a\u4e00\u6761\u4e16\u754c\u7ebf', 'Previous worldline'), () => act(api, 'switch', { session_id: sid, branch_id: ids[0] }), busy),
      Object.assign(document.createElement('span'), { className: 'gah-wl-count', textContent: `${info.current}/${info.count}` }),
      button('\u203a', T('\u4e0b\u4e00\u6761\u4e16\u754c\u7ebf', 'Next worldline'), () => act(api, 'switch', { session_id: sid, branch_id: ids[ids.length - 1] }), busy),
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
  useEffect(() => {
    const thread = document.getElementById('thread');
    const sid = state.session_id;
    if (!thread || !sid) return;
    const variants = ((state as unknown as { worldline?: Variants }).worldline || {});
    const paint = () => {
      observer.disconnect();
      let lastUser = -1;
      Array.from(thread.children).forEach((node, index) => {
        node.querySelector(':scope > .gah-wl-bar')?.remove();
        node.querySelector('.gah-wl-branch')?.remove();
        const message = state.messages[index];
        if (message?.role === 'assistant' && lastUser >= 0 && !state.running) {
          const actions = node.querySelector('.message-actions');
          if (actions) actions.append(branchButton(api, sid, lastUser, state.running));
          return;
        }
        if (!node.classList.contains('user') || message?.role !== 'user') return;
        lastUser = index;
        node.classList.add(MARK);
        node.append(bar(api, sid, index, textOf(message), variants[String(index)], state.running));
      });
      observer.observe(thread, { childList: true, subtree: !state.running });
    };
    const observer = new MutationObserver(paint);
    paint();
    return () => observer.disconnect();
  }, [api, state]);
  return null;
}

defineReact('worldline', Worldline);
