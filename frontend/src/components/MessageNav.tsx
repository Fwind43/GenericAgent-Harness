import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { T } from '../i18n';
import type { Message } from '../types';

// Right-hand rail of message nodes: one tick per user message. Hovering expands it into a
// list of every question (current one bold with an accent tick); click scrolls the thread.
const plain = (text: string, max: number) => {
  const s = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|~\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
};
// Element position in the scroller's content coordinates (independent of offsetParent).
const posOf = (node: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
const replyOf = (m?: Message) => {
  if (!m || m.role !== 'assistant') return '';
  const turns = (m.turns ?? []).filter(Boolean);
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].reply) return turns[i].reply as string;
  return m.text || '';
};

export function MessageNav({ messages, scroll }: { messages: Message[]; scroll: RefObject<HTMLElement | null> }) {
  const nodes = messages.flatMap((m, index) => m.role === 'user' ? [{
    index,
    question: plain(m.text || (m.attachments?.length ? m.attachments.map(a => a.name).join(', ') : ''), 80) || T('(空消息)', '(empty message)'),
    answer: plain(replyOf(messages[index + 1]), 120),
  }] : []);
  const [active, setActive] = useState(-1), [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null), closer = useRef<number | undefined>(undefined);
  const show = () => { window.clearTimeout(closer.current); setOpen(true); };
  const hide = (delay = 120) => { window.clearTimeout(closer.current); closer.current = window.setTimeout(() => setOpen(false), delay); };
  useEffect(() => () => window.clearTimeout(closer.current), []);
  // Opening the list keeps the current message in view inside a long, scrolling panel.
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('.gah-msg-nav-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const measure = useCallback(() => {
    const node = scroll.current;
    if (!node) return;
    setBox({ top: node.offsetTop, height: node.clientHeight });
    const items = node.querySelector('#thread')?.children;
    if (!items) return;
    const line = node.scrollTop + node.clientHeight / 3;
    let current = -1;
    for (const n of nodes) {
      const el = items[n.index] as HTMLElement | undefined;
      if (el && posOf(node, el) <= line) current = n.index; else if (el) break;
    }
    setActive(current < 0 && nodes.length ? nodes[0].index : current);
  }, [scroll, nodes.length, messages.length]);
  useEffect(() => {
    const node = scroll.current;
    measure();
    if (!node) return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    node.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); node.removeEventListener('scroll', measure); };
  }, [measure]);
  if (nodes.length < 2 || !box) return null;
  const jump = (index: number) => {
    const node = scroll.current, el = node?.querySelector('#thread')?.children[index] as HTMLElement | undefined;
    if (node && el) node.scrollTo({ top: posOf(node, el) - 16, behavior: 'smooth' });
  };
  const label = (i: number, q: string) => T('跳到第 ', 'Jump to message ') + (i + 1) + T(' 条：', ': ') + q;
  return <nav className={'gah-msg-nav' + (open ? ' open' : '')} aria-label={T('消息导航', 'Message navigation')}
    style={{ top: box.top + box.height / 2 }} onMouseEnter={show} onMouseLeave={() => hide()}
    onFocus={show} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hide(0); }}
    onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); (document.activeElement as HTMLElement | null)?.blur(); } }}>
    <div className="gah-msg-nav-rail" aria-hidden={open || undefined}>
      {nodes.map((n, i) => <button key={n.index} type="button" tabIndex={open ? -1 : 0}
        className={'gah-msg-nav-node' + (n.index === active ? ' active' : '')}
        aria-label={label(i, n.question)} aria-current={n.index === active ? 'true' : undefined}
        onClick={() => jump(n.index)}><span /></button>)}
    </div>
    {open && <div className="gah-msg-nav-panel" ref={panel}>
      {nodes.map((n, i) => <button key={n.index} type="button"
        className={'gah-msg-nav-item' + (n.index === active ? ' active' : '')}
        aria-label={label(i, n.question)} aria-current={n.index === active ? 'true' : undefined}
        title={n.answer ? n.question + '\n\n' + n.answer : n.question}
        onClick={() => { jump(n.index); }}>
        <span className="t">{n.question}</span><span className="tick" />
      </button>)}
    </div>}
  </nav>;
}
