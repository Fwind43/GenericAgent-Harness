import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { T } from '../i18n';

export function Chevron() {
  return <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export const Markdown = memo(function Markdown({ text, className = 'body' }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) window.GAHOutput.setMarkdown(ref.current, text); }, [text]);
  return <div ref={ref} className={className} />;
});
export function Disclosure({ title, children, initial = false, className = '', state }: {
  title: ReactNode; children: ReactNode; initial?: boolean; className?: string; state?: string;
}) {
  const [open, setOpen] = useState(initial);
  return <details className={className} data-state={state} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{title}<Chevron /></summary>{children}
  </details>;
}
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="copy-btn" aria-label={T('复制', 'Copy')} onClick={async () => {
    try {
      try { await navigator.clipboard.writeText(text); }
      catch {
        // Clipboard API requires HTTPS; retain copying on local HTTP hosts.
        const field = document.createElement('textarea');
        const previous = document.activeElement;
        field.value = text; field.readOnly = true;
        Object.assign(field.style, { position: 'fixed', top: '-9999px', left: '-9999px' });
        document.body.append(field);
        try { field.select(); if (!document.execCommand('copy')) throw new Error('Copy failed'); }
        finally { field.remove(); if (previous instanceof HTMLElement) previous.focus(); }
      }
      setCopied(true);
    } catch { setCopied(false); }
  }}>{copied ? T('已复制', 'Copied') : T('复制', 'Copy')}</button>;
}
export const format = (value: unknown) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
