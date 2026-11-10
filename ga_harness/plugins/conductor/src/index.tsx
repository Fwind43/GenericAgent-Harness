import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useHost, T, defineReact, pages, type HostState, type PluginAPI } from '@gah/sdk';

type Task = {
  id: string; title: string; status: string; review?: string | null; basis?: string | null;
  resolved?: boolean; child: string; run_id?: string | null; objective: string;
  result?: string; error?: string; runs?: number; model?: string | null; effort?: string | null;
  created?: number; stage?: number;
  result_complete?: boolean; result_truncated?: boolean; result_source?: string;
  partial?: boolean;  // the snapshot holds previews of the long text fields
};
type Reflection = {
  id: string; parent: string; title: string; status: string; triggers: number;
  expires?: number | null; error?: string; interval: number; once?: boolean; created?: number;
  instruction?: string;
};
const REFLECT_TERMINAL = new Set(['done', 'stopped', 'error', 'interrupted']);
const REFLECT_STATUS: Record<string, [string, string]> = {
  starting: ['\u542f\u52a8\u4e2d', 'Starting'], sleeping: ['\u76d1\u542c\u4e2d', 'Watching'],
  pending: ['\u7b49\u5f85\u5524\u9192', 'Pending'], submitting: ['\u5524\u9192\u4e2d', 'Submitting'],
  waiting: ['\u7b49\u5f85\u56de\u6267', 'Waiting for result'], callback: ['\u56de\u8c03\u4e2d', 'Callback'],
  stopped: ['\u5df2\u505c\u6b62', 'Stopped'], done: ['\u5df2\u5b8c\u6210', 'Done'],
  error: ['\u51fa\u9519', 'Error'], interrupted: ['\u5df2\u4e2d\u65ad', 'Interrupted'],
};
type Progress = {
  stage: number; goal?: string; next_step?: string; status: string; reason?: string;
};
const PROGRESS_STATUS: Record<string, [string, string]> = {
  active: ['\u63a8\u8fdb\u4e2d', 'Active'],
  waiting_children: ['\u7b49\u5f85\u5b50\u4efb\u52a1', 'Waiting for tasks'],
  waiting_external: ['\u7b49\u5f85\u5916\u90e8\u4e8b\u4ef6', 'Waiting for event'],
  paused: ['\u5df2\u6682\u505c', 'Paused'],
  blocked: ['\u9700\u8981\u7528\u6237\u5904\u7406', 'Blocked'],
  done: ['\u5df2\u5b8c\u6210', 'Done'],
};
type Conductor = {
  enabled: string[]; tasks: Task[]; current?: string | null;
  active?: string[];  // conductor sessions in active mode
  reflections?: Reflection[];
  progress?: Progress;
  children: Record<string, { task_id: string; parent: string }>;
  limits: { running: number; open: number; total: number };
};

const STATUS: Record<string, [string, string]> = {
  running: ['\u8fd0\u884c\u4e2d', 'Running'],
  done: ['\u5df2\u5b8c\u6210', 'Done'],
  error: ['\u51fa\u9519', 'Error'],
  aborted: ['\u5df2\u53d6\u6d88', 'Cancelled'],
  interrupted: ['\u5df2\u4e2d\u65ad', 'Interrupted'],
  failed: ['\u5931\u8d25', 'Failed'],
  cancelled: ['\u5df2\u53d6\u6d88', 'Cancelled'],
};
const REVIEW: Record<string, [string, string]> = {
  pending: ['\u5f85\u9a8c\u6536', 'Awaiting review'],
  verified: ['\u5df2\u9a8c\u6536', 'Verified'],
  needs_work: ['\u9700\u8fd4\u5de5', 'Needs work'],
};
const label = (map: Record<string, [string, string]>, key?: string | null) =>
  key ? (map[key] ? T(map[key][0], map[key][1]) : key) : '';

function formatRemaining(expires?: number | null): [string, string] | null {
  if (expires == null) return ['\u6c38\u4e45', 'Permanent'];
  if (!expires) return null;
  const sec = Math.max(0, Math.round(expires - Date.now() / 1000));
  if (sec <= 0) return ['\u5df2\u5230\u671f', 'Expired'];
  if (sec < 60) return [`\u5269\u4f59 ${sec}s`, `${sec}s left`];
  const mins = Math.floor(sec / 60);
  if (mins < 60) return [`\u5269\u4f59 ${mins}m`, `${mins}m left`];
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 48) return [remMins ? `\u5269\u4f59 ${hours}h ${remMins}m` : `\u5269\u4f59 ${hours}h`, remMins ? `${hours}h ${remMins}m left` : `${hours}h left`];
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return [remHours ? `\u5269\u4f59 ${days}d ${remHours}h` : `\u5269\u4f59 ${days}d`, remHours ? `${days}d ${remHours}h left` : `${days}d left`];
}

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
  // Full text of one task: the snapshot only carries previews (see `partial`).
  const load = async (task: Task): Promise<Partial<Task> | null> => {
    if (!sid) return null;
    try { return (await api.post<{ task?: Partial<Task> }>('task', { session_id: sid, task_id: task.id })).task || null; }
    catch { return null; }
  };
  return { data, sid, busy, run, load };
}

function TaskRow({ task, busy, act, enter, load }: {
  task: Task; busy: boolean; act: (path: string, task: Task) => void; enter: (task: Task) => void;
  load: (task: Task) => Promise<Partial<Task> | null>;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Partial<Task> | null>(null);
  // Refetch when anything that changes the text fields changes.
  const stamp = [task.id, task.status, task.review || '', task.runs || 0, task.result?.length || 0, task.basis?.length || 0, task.result_complete, task.result_source].join('|');
  useEffect(() => {
    if (!open || !task.partial) { setFull(null); return; }
    let live = true;
    setFull(null);
    load(task).then(value => { if (live) setFull(value); });
    return () => { live = false; };
  }, [open, task.partial, stamp]);
  const text = { ...task, ...(full || {}) };
  const terminal = task.status !== 'running';
  const canResolve = terminal && !task.resolved && (task.status !== 'done' || task.review === 'verified');
  return (
    <div className={`gah-cd-task ${task.status}${task.resolved ? ' resolved' : ''}`}>
      <div className="gah-cd-row">
      <button type="button" className="gah-cd-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`gah-cd-dot ${task.status}`} />
        <span className="gah-cd-title" title={task.objective}>{task.title || task.id}</span>
        <span className="gah-cd-tag">{label(STATUS, task.status)}</span>
        {task.review && task.status === 'done' ? <span className={`gah-cd-tag review ${task.review}`}>{label(REVIEW, task.review)}</span> : null}
        {task.model || task.effort ? (
          <span className="gah-cd-tag model" title={T('\u5b50\u4efb\u52a1\u6a21\u578b / \u63a8\u7406\u5f3a\u5ea6', 'Task model / reasoning effort')}>
            {[task.model, task.effort].filter(Boolean).join(' \u00b7 ')}
          </span>
        ) : null}
        {task.resolved ? <span className="gah-cd-tag">{T('\u5df2\u7ed3\u6848', 'Resolved')}</span> : null}
      </button>
      <button type="button" className="gah-cd-enter" disabled={busy} onClick={() => enter(task)}
        title={T('\u8fdb\u5165\u8be5\u5b50\u4efb\u52a1\u7684\u4f1a\u8bdd', 'Open this task\'s chat')} aria-label={T('\u8fdb\u5165\u4f1a\u8bdd', 'Open chat')}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 3h7v7M13 3L4 12" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      </div>
      {open ? (
        <div className="gah-cd-body">
          <div className="gah-cd-field"><b>{T('\u76ee\u6807', 'Objective')}</b><p>{text.objective}</p></div>
          {text.result ? <div className="gah-cd-field"><b>{T('\u7ed3\u679c', 'Result')}</b><p>{text.result}</p></div> : null}
          {terminal && text.result_complete === false ? (
            <div className="gah-cd-field error"><p>{T('\u672a\u6536\u5230\u5b8c\u6574\u6700\u7ec8\u4ea4\u4ed8\uff1b\u8bf7\u8865\u5145\u62a5\u544a\u6216\u72ec\u7acb\u6838\u5bf9\u4ea7\u7269\u540e\u518d\u9a8c\u6536\u3002', 'No complete final delivery. Request a report or independently inspect artifacts before verifying.')}</p></div>
          ) : null}
          {text.result_truncated || (task.partial && !full) ? (
            <div className="gah-cd-hint">{T('\u5f53\u524d\u4e3a\u6458\u8981\uff1b\u5b8c\u6574\u5185\u5bb9\u53ef\u5728\u5b50\u4efb\u52a1\u4f1a\u8bdd\u4e2d\u67e5\u770b\u3002', 'Preview only; open the task chat for full details.')}</div>
          ) : null}
          {task.stage ? <div className="gah-cd-meta">{T(`\u9636\u6bb5 ${task.stage}`, `Stage ${task.stage}`)}</div> : null}
          {text.error ? <div className="gah-cd-field error"><b>{T('\u9519\u8bef', 'Error')}</b><p>{text.error}</p></div> : null}
          {text.basis ? <div className="gah-cd-field"><b>{T('\u9a8c\u6536\u4f9d\u636e', 'Review basis')}</b><p>{text.basis}</p></div> : null}
          <div className="gah-cd-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => enter(task)}
              title={T('\u8fdb\u5165\u8be5\u5b50\u4efb\u52a1\u7684\u4f1a\u8bdd', 'Open this task\'s chat')}>{T('\u8fdb\u5165\u4f1a\u8bdd', 'Open chat')}</button>
            {!terminal ? <button type="button" className="danger" disabled={busy} onClick={() => act('cancel', task)}>{T('\u53d6\u6d88', 'Cancel')}</button> : null}
            {canResolve ? <button type="button" disabled={busy} onClick={() => act('resolve', task)}>{T('\u7ed3\u6848', 'Resolve')}</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReflectRow({ item, busy, stop }: { item: Reflection; busy: boolean; stop: (r: Reflection) => void }) {
  const [open, setOpen] = useState(item.status === 'error' || item.status === 'interrupted');
  const active = !REFLECT_TERMINAL.has(item.status);
  const dotClass = active ? 'running' : item.status;
  const cadence = item.once ? T('\u5355\u6b21', 'Once') : `${item.interval ?? 5}s`;
  const rem = active ? formatRemaining(item.expires) : null;
  const expText = item.expires ? new Date(item.expires * 1000).toLocaleString() : '';
  return (
    <div className={`gah-cd-task${ active ? '' : ' resolved'}`}>
      <div className="gah-cd-row">
        <button type="button" className="gah-cd-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`gah-cd-dot ${dotClass}`} />
          <span className="gah-cd-title">{item.title || item.id}</span>
          <span className="gah-cd-tag model" title={T('\u68c0\u67e5\u5468\u671f / \u5df2\u89e6\u53d1\u6b21\u6570', 'Poll interval / trigger count')}>
            {cadence}{(item.triggers ?? 0) > 0 ? ` \u00b7 #${item.triggers}` : ''}
          </span>
          <span className="gah-cd-tag">{label(REFLECT_STATUS, item.status)}</span>
        </button>
        {active ? (
          <button type="button" className="gah-cd-enter stop" disabled={busy} onClick={() => stop(item)}
            title={T('\u505c\u6b62\u76d1\u542c', 'Stop source')} aria-label={T('\u505c\u6b62\u76d1\u542c', 'Stop source')}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="gah-cd-body">
          <div className="gah-cd-meta">
            <span>{item.once ? T('\u5355\u6b21\u89e6\u53d1', 'One-shot') : T(`\u6bcf ${item.interval ?? 5}s \u68c0\u67e5`, `Every ${item.interval ?? 5}s`)}</span>
            <span>{T(`\u5df2\u89e6\u53d1 ${item.triggers ?? 0} \u6b21`, `Triggered ${item.triggers ?? 0}x`)}</span>
            {rem ? <span title={expText ? `${T('\u622a\u6b62', 'Expires')} ${expText}` : undefined}>{T(rem[0], rem[1])}</span> : null}
            <code className="gah-cd-id">{item.id}</code>
          </div>
          {item.instruction ? <div className="gah-cd-field"><b>{T('\u89e6\u53d1\u52a8\u4f5c', 'Action')}</b><p>{item.instruction}</p></div> : null}
          {item.error ? <div className="gah-cd-field error"><b>{T('\u5f02\u5e38', 'Error')}</b><p>{item.error}</p></div> : null}
          {active ? (
            <div className="gah-cd-actions">
              <button type="button" className="danger" disabled={busy} onClick={() => stop(item)}>{T('\u505c\u6b62\u76d1\u542c', 'Stop source')}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Panel({ api }: { api: PluginAPI }) {
  const { data, sid, busy, run, load } = useConductor(api);
  const [open, setOpen] = useState<'tasks' | 'reflect' | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    // Keep the popover inside the viewport: it is anchored to the chip's right edge,
    // which on narrow (mobile) top bars pushes its left side off-screen.
    const fit = () => {
      const el = pop.current;
      if (!el) return;
      el.style.transform = '';
      const rect = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const pad = 12;
      let dx = 0;
      if (rect.left < pad) dx = pad - rect.left;
      else if (rect.right > vw - pad) dx = vw - pad - rect.right;
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', down);
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('touchstart', down); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { setOpen(null); }, [sid]);
  if (!data || !sid) return null;
  if (data.children?.[sid]) {
    return (
      <span className="gah-cd-chip child" title={T('\u672c\u4f1a\u8bdd\u7531\u6307\u6325\u5bb6\u6d3e\u53d1\uff0c\u7ed3\u679c\u4f1a\u81ea\u52a8\u56de\u62a5\u7236\u4f1a\u8bdd', 'Dispatched by a conductor; the result is reported back to the parent session')}>
        <Icon /><span>{T('\u5b50\u4efb\u52a1', 'Subtask')}</span>
      </span>
    );
  }
  const on = data.enabled.includes(sid);
  // Newest task first, so the latest dispatch is at the top of the panel.
  const tasks = data.tasks.filter(t => data.children?.[t.child]?.parent === sid)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const reflections = (data.reflections || []).filter(r => r.parent === sid).sort(
    (a, b) => Number(REFLECT_TERMINAL.has(a.status)) - Number(REFLECT_TERMINAL.has(b.status)) || (b.created ?? 0) - (a.created ?? 0),
  );
  const watching = reflections.filter(r => !REFLECT_TERMINAL.has(r.status)).length;
  if (!on && !tasks.length && !reflections.length) return null;
  const running = tasks.filter(t => t.status === 'running').length;
  const done = tasks.filter(t => t.status !== 'running').length;
  const progress = data.progress;
  const stageTotal = tasks.filter(t => (t.stage ?? 1) === (progress?.stage ?? 1)).length;
  const showReflect = on || reflections.length > 0;
  const showTasks = on || tasks.length > 0;
  // Task chats are hidden from the sidebar; this is their entry point.
  const enter = async (task: Task) => {
    setOpen(null);
    try { api.setState(await api.host.post<HostState>('/api/sessions', { action: 'select', id: task.child }), true); pages.home(); }
    catch (error) { api.notice(String((error as Error)?.message || error)); }
  };
  return (
    <div className="gah-cd-group" ref={box}>
      {showReflect ? (
        <div className="gah-cd-anchor">
          <button
            type="button"
            className={`gah-cd-chip${watching ? ' on' : ''}${open === 'reflect' ? ' open' : ''}`}
            aria-expanded={open === 'reflect'}
            aria-haspopup="dialog"
            onClick={() => setOpen(open === 'reflect' ? null : 'reflect')}
            title={T('\u53cd\u5c04\u4e8b\u4ef6\u6e90', 'Reflect event sources')}
          >
            {watching ? <span className="gah-cd-dot running" /> : <ReflectIcon />}
            <span>{reflections.length ? T(`\u4e8b\u4ef6\u6e90 ${watching}/${reflections.length}`, `Sources ${watching}/${reflections.length}`) : T('\u4e8b\u4ef6\u6e90', 'Sources')}</span>
            <Caret />
          </button>
          {open === 'reflect' ? (
            <div className="gah-cd" ref={pop} role="dialog" aria-label={T('\u53cd\u5c04\u4e8b\u4ef6\u6e90', 'Reflect event sources')}>
              <div className="gah-cd-bar">
                <span className="gah-cd-badge"><ReflectIcon />{T('\u53cd\u5c04\u4e8b\u4ef6\u6e90', 'Event sources')}</span>
                <span className="gah-cd-hint">
                  {reflections.length
                    ? T(`\u76d1\u542c\u4e2d ${watching} \u00b7 \u5171 ${reflections.length} \u4e2a`, `${watching} watching \u00b7 ${reflections.length} total`)
                    : T('\u5faa\u73af\u76d1\u542c\u5916\u90e8\u6761\u4ef6\uff0c\u89e6\u53d1\u65f6\u5524\u9192\u6307\u6325\u5bb6', 'Watches conditions in a loop and wakes the conductor')}
                </span>
              </div>
              {reflections.length ? (
                <div className="gah-cd-list">
                  {reflections.map(r => (
                    <ReflectRow key={r.id} item={r} busy={busy} stop={item => run('reflect', { action: 'stop', reflect_id: item.id })} />
                  ))}
                </div>
              ) : (
                <div className="gah-cd-empty">{T('\u8fd8\u6ca1\u6709\u4e8b\u4ef6\u6e90', 'No event sources yet')}</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {showTasks ? (
        <div className="gah-cd-anchor">
          <button
            type="button"
            className={`gah-cd-chip${on ? ' on' : ''}${open === 'tasks' ? ' open' : ''}`}
            aria-expanded={open === 'tasks'}
            aria-haspopup="dialog"
            onClick={() => setOpen(open === 'tasks' ? null : 'tasks')}
            title={T('\u6307\u6325\u5bb6\u5b50\u4efb\u52a1', 'Conductor subtasks')}
          >
            {running ? <span className="gah-cd-dot running" /> : <Icon />}
            <span>{tasks.length ? `${done}/${tasks.length}` : T('\u6307\u6325\u5bb6', 'Conductor')}</span>
            {on && progress ? <span className="gah-cd-tag">{label(PROGRESS_STATUS, progress.status)}</span> : null}
            <Caret />
          </button>
          {open === 'tasks' ? (
            <div className="gah-cd" ref={pop} role="dialog" aria-label={T('\u6307\u6325\u5bb6', 'Conductor')}>
              <div className="gah-cd-bar">
                <span className="gah-cd-badge"><Icon />{T('\u6307\u6325\u5bb6\u6a21\u5f0f', 'Conductor mode')}</span>
                <span className="gah-cd-hint">
                  {tasks.length
                    ? T(`\u4efb\u52a1 ${tasks.length} \u00b7 \u8fd0\u884c\u4e2d ${running}/${data.limits.running}`, `${tasks.length} tasks \u00b7 ${running}/${data.limits.running} running`)
                    : T('\u53ea\u62c6\u5206\u3001\u5206\u6d3e\u3001\u9a8c\u6536\uff0c\u4e0d\u4eb2\u81ea\u6267\u884c', 'Splits, dispatches and reviews; does not execute itself')}
                </span>
                {on ? <button type="button" className="gah-cd-off" disabled={busy} onClick={() => run('toggle', { enabled: false })}>{T('\u5173\u95ed', 'Turn off')}</button> : null}
              </div>
              {progress ? (
                <div className="gah-cd-body">
                  <div className="gah-cd-meta">{T(`\u9636\u6bb5 ${progress.stage} \u00b7 \u989d\u5ea6 ${stageTotal}/${data.limits.total}`, `Stage ${progress.stage} \u00b7 quota ${stageTotal}/${data.limits.total}`)} {'\u00b7'} {label(PROGRESS_STATUS, progress.status)}</div>
                  {progress.goal ? <div className="gah-cd-field"><b>{T('\u603b\u76ee\u6807', 'Goal')}</b><p>{progress.goal}</p></div> : null}
                  {progress.next_step ? <div className="gah-cd-field"><b>{T('\u4e0b\u4e00\u6b65', 'Next step')}</b><p>{progress.next_step}</p></div> : null}
                  {progress.reason ? <div className="gah-cd-field"><b>{T('\u72b6\u6001\u539f\u56e0', 'Reason')}</b><p>{progress.reason}</p></div> : null}
                </div>
              ) : null}
              {tasks.length ? (
                <div className="gah-cd-list">
                  {tasks.map(task => (
                    <TaskRow key={task.id} task={task} busy={busy} act={(path, t) => run(path, { task_id: t.id })} enter={enter} load={load} />
                  ))}
                </div>
              ) : (
                <div className="gah-cd-empty">{T('\u8fd8\u6ca1\u6709\u5b50\u4efb\u52a1', 'No tasks yet')}</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const Caret = () => (
  <svg className="gah-cd-caret" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  </svg>
);

const ReflectIcon = () => (
  <svg className="gah-cd-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <path d="M8 5v3.2l2.2 1.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

const Icon = () => (
  <svg className="gah-cd-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3 3.5h4M3 8h10M3 12.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    <circle cx="11" cy="3.5" r="1.6" fill="currentColor" /><circle cx="12" cy="12.5" r="1.6" fill="currentColor" />
  </svg>
);

const Check = () => (
  <svg className="gah-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function Toggle({ api }: { api: PluginAPI }) {
  const { data, sid, busy, run } = useConductor(api);
  if (!data || !sid || data.children?.[sid]) return null;
  const on = data.enabled.includes(sid);
  const active = on && !!data.active?.includes(sid);
  return (
    <>
      <button type="button" role="menuitemcheckbox" className="gah-menu-item" aria-checked={on} disabled={busy}
        onClick={() => run('toggle', { enabled: !on })}
        title={T('\u6307\u6325\u5bb6\u6a21\u5f0f\uff1a\u672c\u4f1a\u8bdd\u53ea\u62c6\u5206\u5e76\u5206\u6d3e\u5b50\u4efb\u52a1\uff0c\u6bcf\u4e2a\u5b50\u4efb\u52a1\u5728\u72ec\u7acb\u4f1a\u8bdd\u4e2d\u6267\u884c', 'Conductor mode: this session only splits and dispatches tasks; each task runs in its own session')}>
        <Icon /><span>{T('\u6307\u6325\u5bb6\u6a21\u5f0f', 'Conductor mode')}</span>
        {on ? <Check /> : null}
      </button>
      {on ? (
        <button type="button" role="menuitemcheckbox" className="gah-menu-item" aria-checked={active} disabled={busy}
          onClick={() => run('active', { active: !active })}
          title={T('\u4e3b\u52a8\u6a21\u5f0f\uff1a\u4efb\u52a1\u672a\u5b8c\u6210\u65f6\u81ea\u52a8\u7eed\u8dd1\uff0c\u76f4\u5230\u6307\u6325\u5bb6\u58f0\u660e\u5b8c\u6210\u6216\u53d7\u963b', 'Active mode: keep the conductor going until it declares the work done or blocked')}>
          <Icon /><span>{T('\u6307\u6325\u5bb6\u4e3b\u52a8\u6a21\u5f0f', 'Conductor active mode')}</span>
          {active ? <Check /> : null}
        </button>
      ) : null}
    </>
  );
}

function ConductorPlugin({ api }: { api: PluginAPI }) {
  useEffect(() => api.mount('composer-menu', <Toggle api={api} />), [api]);
  useEffect(() => api.mount('header', <Panel api={api} />), [api]);
  return null;
}

defineReact('conductor', ConductorPlugin);
