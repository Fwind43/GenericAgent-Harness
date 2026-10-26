import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { PluginAPI, SlotName } from './sdk';
import { host, useHost } from './store';
import { T, errorText } from './i18n';

export const matches = (query: string, ...values: (string | undefined)[]) => query.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word => values.join(' ').toLowerCase().includes(word));
export function PluginSlot({ api, name, children }: { api: PluginAPI; name: SlotName; children: ReactNode }) {
  const [container] = useState(() => document.createElement('div'));
  useLayoutEffect(() => { api.slot(name, container); return () => container.remove(); }, [api, name, container]);
  return createPortal(children, container);
}
export function Icon({ name }: { name: string }) { return <span className="gah-ico" data-i={name} aria-hidden="true" />; }
export function Modal({ className, label, busy = false, onClose, children }: {
  className: string; label: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { const node = ref.current; node?.showModal(); return () => { node?.close(); }; }, []);
  return createPortal(<dialog ref={ref} className={'gah-dialog ' + className} aria-label={label} onCancel={event => {
    event.preventDefault(); if (!busy) onClose();
  }}>{children}</dialog>, document.body);
}
// A local ref closes the same-tick double-submit window; the host lock coordinates plugins.
export function useOperation(api: PluginAPI, allowRunning = false) {
  const { state, changing } = useHost();
  const pending = useRef(false), alive = useRef(true);
  const [working, setWorking] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(work: () => Promise<void>, failed: (message: string) => void = api.notice, allowWhenRunning = allowRunning) {
    const snapshot = host.getSnapshot();
    if (pending.current || api.signal.aborted || (!allowWhenRunning && snapshot.state.running) || snapshot.changing) return false;
    pending.current = true; setWorking(true); api.lock(true); api.notice('');
    try { await work(); return !api.signal.aborted; }
    catch (error) { if (!api.signal.aborted) failed(errorText(error)); return false; }
    finally { pending.current = false; api.lock(false); if (alive.current) setWorking(false); }
  }
  return { busy: (!allowRunning && state.running) || changing || working, working, run };
}

// Promise-based replacements for window.alert/confirm/prompt, sharing the .gah-dialog look.
export type AskOptions = { title: string; message?: string; confirm?: string; cancel?: string; danger?: boolean; placeholder?: string };
type AskMode = 'alert' | 'confirm' | 'prompt';
function AskDialog({ mode, options, initial, done }: { mode: AskMode; options: AskOptions; initial: string; done: (value: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(initial);
  useLayoutEffect(() => { ref.current?.showModal(); }, []);
  const ok = options.confirm ?? T('\u786e\u5b9a', 'OK');
  return <dialog ref={ref} className="gah-dialog gah-ask" aria-label={options.title} onCancel={event => { event.preventDefault(); done(mode === 'alert' ? '' : null); }}>
    <form onSubmit={event => { event.preventDefault(); if (mode === 'prompt' && !value.trim()) return; done(mode === 'prompt' ? value : ''); }}>
      <div className="dialog-head"><h2>{options.title}</h2></div>
      <div className="dialog-content">
        {options.message && <p className="gah-ask-msg">{options.message}</p>}
        {mode === 'prompt' && <input className="gah-ask-input" autoFocus value={value} placeholder={options.placeholder} aria-label={options.title} onFocus={event => event.currentTarget.select()} onChange={event => setValue(event.target.value)} />}
        <div className="gah-ask-actions">
          {mode !== 'alert' && <button type="button" className="secondary" onClick={() => done(null)}>{options.cancel ?? T('\u53d6\u6d88', 'Cancel')}</button>}
          <button type="submit" className={options.danger ? 'danger' : undefined} autoFocus={mode !== 'prompt'} disabled={mode === 'prompt' && !value.trim()}>{ok}</button>
        </div>
      </div>
    </form>
  </dialog>;
}
function ask(mode: AskMode, options: AskOptions, initial = ''): Promise<string | null> {
  return new Promise(resolve => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true; resolve(value);
      setTimeout(() => { root.unmount(); container.remove(); });
    };
    root.render(<AskDialog mode={mode} options={options} initial={initial} done={done} />);
  });
}
export const alertDialog = (options: AskOptions) => ask('alert', options).then(() => undefined);
export const confirmDialog = (options: AskOptions) => ask('confirm', options).then(value => value !== null);
export const promptDialog = (options: AskOptions & { value?: string }) => ask('prompt', options, options.value ?? '');
