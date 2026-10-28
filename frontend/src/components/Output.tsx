import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { T } from '../i18n';

export function Chevron() {
  return <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export const Markdown = memo(function Markdown({ text, className = 'body' }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) window.GAHOutput.setMarkdown(ref.current, text); }, [text]);
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
