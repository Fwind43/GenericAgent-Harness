import { useCallback, useEffect, useState, type MutableRefObject, type RefObject } from 'react';
import { T } from '../i18n';

// Floating "back to bottom" button over the chat thread. Appears once the reader has scrolled
// away from the latest message; clicking re-pins the thread so streaming output follows again.
const AWAY = 200;
export function ScrollBottom({ scroll, stick, deps }: { scroll: RefObject<HTMLElement | null>; stick: MutableRefObject<boolean>; deps: unknown[] }) {
  const [box, setBox] = useState<{ bottom: number } | null>(null), [away, setAway] = useState(false);
  const measure = useCallback(() => {
    const node = scroll.current;
    if (!node) return;
    setBox({ bottom: node.offsetTop + node.clientHeight });
    setAway(node.scrollHeight - node.scrollTop - node.clientHeight > AWAY);
  }, [scroll]);
  useEffect(() => {
    const node = scroll.current;
    measure();
    if (!node) return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    node.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); node.removeEventListener('scroll', measure); };
  }, [measure]);
  // New content changes scrollHeight without a scroll event.
  useEffect(measure, deps); // eslint-disable-line react-hooks/exhaustive-deps
  if (!box || !away) return null;
  const go = () => {
    const node = scroll.current;
    if (!node) return;
    stick.current = true;
    // Long jumps: skip most of the distance instantly, then glide the last couple of screens.
    const far = node.scrollHeight - node.clientHeight * 3;
    if (far > node.scrollTop) node.scrollTop = far;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  };
  const label = T('回到底部', 'Scroll to bottom');
  return <button type="button" className="gah-to-bottom" style={{ top: box.bottom - 52 }} title={label} aria-label={label} onClick={go}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>;
}
