import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { T } from '../i18n';

export function Chevron() {
  return <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
/** Reveal speed: the backlog drains in about this many ms, never slower than MIN_CPS. */
const CATCH_UP_MS = 260, MIN_CPS = 40;
/** A frame gap longer than this means rendering was paused (background tab, occluded window). */
const STALL_MS = 250;
/**
 * Streamed text arrives in network-sized bursts. While ``stream`` is set, the
 * rendered prefix advances every frame at a rate proportional to the backlog, so
 * bursts read as steady typing yet never fall more than a fraction of a second
 * behind. Text already present on mount, non-append rewrites and the end of the
 * text that never streamed are shown at once; a backlog left when the stream
 * ends keeps draining.
 */
export const Markdown = memo(function Markdown({ text, className = 'body', stream = false }: { text: string; className?: string; stream?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(text.length);
  const target = useRef(text);
  const frame = useRef(0);
  const last = useRef(0);
  const paint = (n: number) => {
    const t = target.current;
    // Do not split a surrogate pair.
    if (n > 0 && n < t.length && t.charCodeAt(n - 1) >= 0xd800 && t.charCodeAt(n - 1) <= 0xdbff) n++;
    shown.current = n;
    if (ref.current) window.GAHOutput.setMarkdown(ref.current, n >= t.length ? t : t.slice(0, n));
  };
  useLayoutEffect(() => {
    const prev = target.current;
    target.current = text;
    const appended = text.startsWith(prev.slice(0, shown.current));
    // A stream that ends mid-animation finishes its reveal instead of jumping.
    if ((!stream && !frame.current) || !appended || document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(frame.current); frame.current = 0;
      paint(text.length);
      return;
    }
    if (!ref.current?.firstChild && !ref.current?.textContent) paint(shown.current);
    // Frames stopped while the page was away: restore everything instead of replaying it.
    if (frame.current && performance.now() - last.current > STALL_MS) {
      cancelAnimationFrame(frame.current); frame.current = 0;
      paint(text.length);
      return;
    }
    if (frame.current || shown.current >= text.length) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const gap = now - last.current;
      last.current = now;
      if (gap > STALL_MS) { frame.current = 0; paint(target.current.length); return; }
      const dt = Math.min(gap, 100);
      const backlog = target.current.length - shown.current;
      if (backlog <= 0) { frame.current = 0; return; }
      const step = Math.max(1, Math.round(Math.max(backlog * dt / CATCH_UP_MS, MIN_CPS * dt / 1000)));
      paint(Math.min(target.current.length, shown.current + step));
      frame.current = shown.current < target.current.length ? requestAnimationFrame(tick) : 0;
    };
    frame.current = requestAnimationFrame(tick);
  }, [text, stream]);
  useEffect(() => {
    // Coming back to the page shows the whole backlog at once.
    const restore = () => {
      if (document.hidden || shown.current >= target.current.length) return;
      cancelAnimationFrame(frame.current); frame.current = 0;
      paint(target.current.length);
    };
    document.addEventListener('visibilitychange', restore);
    window.addEventListener('focus', restore);
    window.addEventListener('pageshow', restore);
    return () => {
      cancelAnimationFrame(frame.current);
      document.removeEventListener('visibilitychange', restore);
      window.removeEventListener('focus', restore);
      window.removeEventListener('pageshow', restore);
    };
  }, []);
  return <div ref={ref} className={className} />;
});
/** Native details whose summary mirrors the legacy DOM: the chevron leads or trails per element kind. */
export function Disclosure({ title, children, initial = false, className = '', state, chevron = 'end', label }: {
  title: ReactNode; children: ReactNode; initial?: boolean; className?: string; state?: string;
  chevron?: 'start' | 'end'; label?: string;
}) {
  const [open, setOpen] = useState(initial);
  // Follow later changes of ``initial`` too: a live step or group opens while it runs
  // and collapses once it is done; manual toggles are kept until the next change.
  const seen = useRef(initial);
  useEffect(() => {
    if (seen.current === initial) return;
    seen.current = initial;
    setOpen(initial);
  }, [initial]);
  return <details className={className} data-state={state} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary aria-label={label}>{chevron === 'start' && <Chevron />}{title}{chevron === 'end' && <Chevron />}</summary>{children}
  </details>;
}
/** Shared output copy button (icon, feedback, HTTP fallback) so styling matches output.css. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null), latest = useRef(text);
  latest.current = text;
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const button = window.GAHOutput.copyButton(() => latest.current, label ?? T('复制', 'Copy'));
    slot.append(button);
    return () => button.remove();
  }, [label]);
  return <span ref={ref} style={{ display: 'contents' }} />;
}
export const format = (value: unknown) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
