import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { T } from '../i18n';

export function Chevron() {
  return <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
/**
 * Reveal speed: the backlog drains in about CATCH_UP_MS, never slower than MIN_CPS,
 * and is never allowed to trail the received text by more than MAX_LAG_MS.
 * Smoothing only spreads a burst over the next few frames; it must not slow output.
 */
const CATCH_UP_MS = 90, MIN_CPS = 900, MAX_LAG_MS = 150;
/** A frame gap longer than this means rendering was paused (background tab, occluded window). */
const STALL_MS = 250;
/**
 * Streamed text arrives in network-sized bursts. While ``stream`` is set, the
 * rendered prefix advances every frame at a rate proportional to the backlog, so
 * bursts read as steady typing yet never fall more than a fraction of a second
 * behind. Text already present on mount, non-append rewrites and the end of the
 * text that never streamed are shown at once, as is any backlog when the stream ends.
 */
export const Markdown = memo(function Markdown({ text, className = 'body', stream = false }: { text: string; className?: string; stream?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(text.length);
  const target = useRef(text);
  const frame = useRef(0);
  const last = useRef(0);
  const painted = useRef(0);
  const cost = useRef(0);
  /** When the oldest unrevealed text arrived; bounds the visible lag. */
  const arrived = useRef(0);
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
    // The end of a stream shows everything at once; there is nothing left to smooth.
    if (!stream || !appended || document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
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
    if (shown.current >= text.length) return;
    if (!frame.current) arrived.current = performance.now();
    if (frame.current) return;
    last.current = painted.current = performance.now();
    const tick = (now: number) => {
      const gap = now - last.current;
      last.current = now;
      if (gap > STALL_MS) { frame.current = 0; paint(target.current.length); return; }
      const backlog = target.current.length - shown.current;
      if (backlog <= 0) { frame.current = 0; return; }
      // A slow Markdown parse (long replies) must not cost frames: paint less often, bigger steps.
      const dt = now - painted.current;
      if (dt < cost.current * 2 && now - arrived.current < MAX_LAG_MS) { frame.current = requestAnimationFrame(tick); return; }
      const step = now - arrived.current >= MAX_LAG_MS ? backlog
        : Math.max(1, Math.round(Math.max(backlog * Math.min(dt, 100) / CATCH_UP_MS, MIN_CPS * Math.min(dt, 100) / 1000)));
      const t0 = performance.now();
      paint(Math.min(target.current.length, shown.current + step));
      painted.current = now; cost.current = performance.now() - t0;
      if (shown.current >= target.current.length) arrived.current = now;
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
  // ``md`` is part of the React class so a later className change (e.g. the streaming
  // cursor ending) does not strip the Markdown styles that setMarkdown added.
  return <div ref={ref} className={className + ' md'} />;
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
