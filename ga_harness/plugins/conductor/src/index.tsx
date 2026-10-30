import { useEffect, useRef, useState } from 'react';
import { useHost, T, defineReact, type PluginAPI } from '@gah/sdk';

type Task = {
  id: string; title: string; status: string; review?: string | null; basis?: string | null;
  resolved?: boolean; child: string; run_id?: string | null; objective: string;
  result?: string; error?: string; runs?: number;
};
type Conductor = {
  enabled: string[]; tasks: Task[]; current?: string | null;
  children: Record<string, { task_id: string; parent: string }>;
  limits: { running: number; open: number; total: number };
};

const STATUS: Record<string, [string, string]> = {
  running: ['\u8fd0\u884c\u4e2d', 'Running'],
  done: ['\u5df2\u5b8c\u6210', 'Done'],
  failed: ['\u5931\u8d25', 'Failed'],
  cancelled: ['\u5df2\u53d6\u6d88', 'Cancelled'],
};
const REVIEW: Record<string, [string, string]> = {
  verified: ['\u5df2\u9a8c\u6536', 'Verified'],
  needs_work: ['\u9700\u8fd4\u5de5', 'Needs work'],
};
const label = (map: Record<string, [string, string]>, key?: string | null) =>
  key ? (map[key] ? T(map[key][0], map[key][1]) : key) : '';

function useConductor(api: PluginAPI) {
  const { state } = useHost();
  const [busy, setBusy] = useState(false);
  const data = (state as unknown as { conductor?: Conductor }).conductor;
  const sid = state.session_id as string | undefined;
  const run = async (path: string, body: Record<string, unknown>) => {
    if (!sid) return;
    setBusy(true);
    try { await api.post(path, { session_id: sid, ...body }); }
    catch (error) { api.notice(String((error as Error)?.message || error)); }
    finally { setBusy(false); }
  };
  return { data, sid, busy, run };
}

function TaskRow({ task, busy, act }: { task: Task; busy: boolean; act: (path: string, task: Task) => void }) {
  const [open, setOpen] = useState(false);
  const terminal = task.status !== 'running';
  const canResolve = terminal && !task.resolved && (task.status !== 'done' || task.review === 'verified');
  return (
    <div className={`gah-cd-task ${task.status}${task.resolved ? ' resolved' : ''}`}>
      <button type="button" className="gah-cd-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`gah-cd-dot ${task.status}`} />
        <span className="gah-cd-title" title={task.objective}>{task.title || task.id}</span>
        <span className="gah-cd-tag">{label(STATUS, task.status)}</span>
        {task.review ? <span className={`gah-cd-tag review ${task.review}`}>{label(REVIEW, task.review)}</span> : null}
        {task.resolved ? <span className="gah-cd-tag">{T('\u5df2\u7ed3\u6848', 'Resolved')}</span> : null}
      </button>
      {open ? (
        <div className="gah-cd-body">
          <div className="gah-cd-field"><b>{T('\u76ee\u6807', 'Objective')}</b><p>{task.objective}</p></div>
          {task.result ? <div className="gah-cd-field"><b>{T('\u7ed3\u679c', 'Result')}</b><p>{task.result}</p></div> : null}
          {task.error ? <div className="gah-cd-field error"><b>{T('\u9519\u8bef', 'Error')}</b><p>{task.error}</p></div> : null}
          {task.basis ? <div className="gah-cd-field"><b>{T('\u9a8c\u6536\u4f9d\u636e', 'Review basis')}</b><p>{task.basis}</p></div> : null}
          {!terminal || canResolve ? (
            <div className="gah-cd-actions">
              {!terminal ? <button type="button" className="danger" disabled={busy} onClick={() => act('cancel', task)}>{T('\u53d6\u6d88', 'Cancel')}</button> : null}
              {canResolve ? <button type="button" disabled={busy} onClick={() => act('resolve', task)}>{T('\u7ed3\u6848', 'Resolve')}</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Panel({ api }: { api: PluginAPI }) {
  const { data, sid, busy, run } = useConductor(api);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [sid]);
  if (!data || !sid) return null;
  if (data.children?.[sid]) {
    return (
      <span className="gah-cd-chip child" title={T('\u672c\u4f1a\u8bdd\u7531\u6307\u6325\u5bb6\u6d3e\u53d1\uff0c\u7ed3\u679c\u4f1a\u81ea\u52a8\u56de\u62a5\u7236\u4f1a\u8bdd', 'Dispatched by a conductor; the result is reported back to the parent session')}>
        <Icon /><span>{T('\u5b50\u4efb\u52a1', 'Subtask')}</span>
      </span>
    );
  }
  const on = data.enabled.includes(sid);
  const tasks = data.tasks.filter(t => data.children?.[t.child]?.parent === sid);
  if (!on && !tasks.length) return null;
  const running = tasks.filter(t => t.status === 'running').length;
  const done = tasks.filter(t => t.status !== 'running').length;
  return (
    <div className="gah-cd-anchor" ref={box}>
      <button type="button" className={`gah-cd-chip${on ? ' on' : ''}${open ? ' open' : ''}`} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen(!open)} title={T('\u6307\u6325\u5bb6\u4efb\u52a1', 'Conductor tasks')}>
        {running ? <span className="gah-cd-dot running" /> : <Icon />}
        <span>{tasks.length ? `${done}/${tasks.length}` : T('\u6307\u6325\u5bb6', 'Conductor')}</span>
        <svg className="gah-cd-caret" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" /></svg>
      </button>
      {open ? (
        <div className="gah-cd" role="dialog" aria-label={T('\u6307\u6325\u5bb6', 'Conductor')}>
          <div className="gah-cd-bar">
            <span className="gah-cd-badge"><Icon />{T('\u6307\u6325\u5bb6\u6a21\u5f0f', 'Conductor mode')}</span>
            <span className="gah-cd-hint">
              {tasks.length
                ? T(`\u4efb\u52a1 ${tasks.length} \u00b7 \u8fd0\u884c\u4e2d ${running}/${data.limits.running}`, `${tasks.length} tasks \u00b7 ${running}/${data.limits.running} running`)
                : T('\u53ea\u62c6\u5206\u3001\u5206\u6d3e\u3001\u9a8c\u6536\uff0c\u4e0d\u4eb2\u81ea\u6267\u884c', 'Splits, dispatches and reviews; does not execute itself')}
            </span>
            {on ? <button type="button" className="gah-cd-off" disabled={busy} onClick={() => run('toggle', { enabled: false })}>{T('\u5173\u95ed', 'Turn off')}</button> : null}
          </div>
          {tasks.length ? <div className="gah-cd-list">{tasks.map(task => (
            <TaskRow key={task.id} task={task} busy={busy} act={(path, t) => run(path, { task_id: t.id })} />
          ))}</div> : <div className="gah-cd-empty">{T('\u8fd8\u6ca1\u6709\u5b50\u4efb\u52a1', 'No tasks yet')}</div>}
        </div>
      ) : null}
    </div>
  );
}

const Icon = () => (
  <svg className="gah-cd-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3 3.5h4M3 8h10M3 12.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    <circle cx="11" cy="3.5" r="1.6" fill="currentColor" /><circle cx="12" cy="12.5" r="1.6" fill="currentColor" />
  </svg>
);

function Toggle({ api }: { api: PluginAPI }) {
  const { data, sid, busy, run } = useConductor(api);
  if (!data || !sid || data.children?.[sid]) return null;
  const on = data.enabled.includes(sid);
  return (
    <button type="button" className={`gah-cd-pill${on ? ' on' : ''}`} aria-pressed={on} disabled={busy}
      onClick={() => run('toggle', { enabled: !on })}
      title={T('\u6307\u6325\u5bb6\u6a21\u5f0f\uff1a\u672c\u4f1a\u8bdd\u53ea\u62c6\u5206\u5e76\u5206\u6d3e\u5b50\u4efb\u52a1\uff0c\u6bcf\u4e2a\u5b50\u4efb\u52a1\u5728\u72ec\u7acb\u4f1a\u8bdd\u4e2d\u6267\u884c', 'Conductor mode: this session only splits and dispatches tasks; each task runs in its own session')}>
      <Icon /><span>{T('\u6307\u6325\u5bb6', 'Conductor')}</span>
    </button>
  );
}

function ConductorPlugin({ api }: { api: PluginAPI }) {
  useEffect(() => api.mount('composer', <Toggle api={api} />), [api]);
  useEffect(() => api.mount('header', <Panel api={api} />), [api]);
  return null;
}

defineReact('conductor', ConductorPlugin);
