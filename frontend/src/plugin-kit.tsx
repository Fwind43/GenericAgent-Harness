import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PluginAPI, SlotName } from './sdk';
import { host, useHost } from './store';
import { errorText } from './i18n';

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
