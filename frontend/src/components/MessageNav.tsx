import { useCallback, useEffect, useState, type RefObject } from 'react';
import { T } from '../i18n';
import type { Message } from '../types';

// Right-hand rail of message nodes: one tick per user message, hover shows the question
// and the start of its answer, click scrolls the thread to that message.
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
  const [active, setActive] = useState(-1), [hover, setHover] = useState<{ i: number; top: number } | null>(null);
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
  const shown = hover && nodes[hover.i];
  return <nav className="gah-msg-nav" aria-label={T('消息导航', 'Message navigation')}
    style={{ top: box.top + box.height / 2 }} onMouseLeave={() => setHover(null)}>
    <div className="gah-msg-nav-rail">
      {nodes.map((n, i) => <button key={n.index} type="button" className={'gah-msg-nav-node' + (n.index === active ? ' active' : '')}
        aria-label={T('跳到第 ', 'Jump to message ') + (i + 1) + T(' 条：', ': ') + n.question}
        aria-current={n.index === active ? 'true' : undefined}
        onMouseEnter={e => { const r = e.currentTarget, p = r.closest('.gah-msg-nav') as HTMLElement; setHover({ i, top: r.getBoundingClientRect().top - p.getBoundingClientRect().top + r.offsetHeight / 2 }); }}
        onFocus={e => { const r = e.currentTarget, p = r.closest('.gah-msg-nav') as HTMLElement; setHover({ i, top: r.getBoundingClientRect().top - p.getBoundingClientRect().top + r.offsetHeight / 2 }); }}
        onBlur={() => setHover(null)}
        onClick={() => jump(n.index)}><span /></button>)}
    </div>
    {shown && <div className="gah-msg-nav-card" style={{ top: hover!.top }} role="tooltip">
      <div className="q">{shown.question}</div>
      {shown.answer && <div className="a">{shown.answer}</div>}
    </div>}
  </nav>;
}
