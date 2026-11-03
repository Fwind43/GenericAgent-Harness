// web-island: the floating pill shown by the desktop shell. Follows /api/events like the main page
// and asks the shell (window.gahDesktop.island) to size, show and move its window.
'use strict';
(() => {
  const bridge = window.gahDesktop && window.gahDesktop.island;
  const root = document.getElementById('island');
  let pref = null;
  try { pref = localStorage.getItem('gah-lang'); } catch { /* storage unavailable */ }
  const zh = pref === 'zh' || (pref !== 'en' && navigator.language.toLowerCase().startsWith('zh'));
  const T = (a, b) => (zh ? a : b);

  const ACTIVE = new Set(['running', 'cancelling']);
  const FLASH_MS = 4000;
  const runs = new Map();       // run_id -> {id, session_id, status, started, ended, step, tool, error}
  const titles = new Map();     // session_id -> title
  let currentSession = null;
  let mainFocused = false;
  let hovered = false;
  let lastLayout = '';

  function track(record) {
    if (!record || !record.id) return null;
    const prev = runs.get(record.id) || { step: 0, tool: '' };
    const run = Object.assign(prev, {
      id: record.id,
      session_id: record.session_id,
      status: record.status || prev.status,
      started: record.created ? record.created * 1000 : (prev.started || Date.now()),
      error: record.error || prev.error || '',
    });
    if (!ACTIVE.has(run.status) && !run.ended) run.ended = record.ended ? record.ended * 1000 : Date.now();
    runs.set(run.id, run);
    return run;
  }

  function onSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if ('session_id' in snap) currentSession = snap.session_id;
    for (const s of snap.sessions || []) titles.set(s.id, s.title || '');
    const seen = new Set();
    for (const r of snap.runs || []) {
      seen.add(r.id);
      const known = runs.has(r.id);
      const run = track(r);
      // Runs that already ended before we connected must not flash.
      if (!known && run && !ACTIVE.has(run.status)) run.ended = 0;
    }
    for (const [id, run] of runs) if (!seen.has(id) && !ACTIVE.has(run.status)) runs.delete(id);
    render();
  }

  function onRunEvent(env) {
    const run = runs.get(env.run_id);
    if (!run) return;
    const data = env.data || {};
    if (env.name === 'turn.start') {
      run.step = Number(data.turn) || run.step + 1;
      run.tool = '';
    } else if (env.name === 'tool.call') {
      run.tool = String(data.name || data.tool || '');
    }
    render();
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (e) => onSnapshot(parse(e.data)));
    for (const kind of ['run.started', 'run.cancelling', 'run.finished']) {
      es.addEventListener(kind, (e) => {
        const env = parse(e.data);
        if (!env) return;
        const run = track(env.run || { id: env.run_id, session_id: env.session_id, status: kind === 'run.started' ? 'running' : undefined });
        if (run && kind === 'run.finished' && ACTIVE.has(run.status)) { run.status = 'done'; run.ended = Date.now(); }
        if (run && kind === 'run.finished') setTimeout(render, FLASH_MS + 50);
        render();
      });
    }
    es.addEventListener('run.event', (e) => { const env = parse(e.data); if (env) onRunEvent(env); });
  }

  function parse(text) { try { return JSON.parse(text); } catch { return null; } }

  function elapsed(run) {
    const end = ACTIVE.has(run.status) ? Date.now() : (run.ended || Date.now());
    const s = Math.max(0, Math.floor((end - run.started) / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function label(run) {
    return titles.get(run.session_id) || T('新会话', 'New session');
  }

  function detail(run) {
    switch (run.status) {
      case 'done': return T('已完成', 'Done');
      case 'error': return T('出错', 'Failed');
      case 'aborted': return T('已中止', 'Stopped');
      case 'interrupted': return T('已中断', 'Interrupted');
      case 'cancelling': return T('正在中止…', 'Stopping…');
      default: {
        const parts = [];
        if (run.step) parts.push(T(`第 ${run.step} 步`, `Step ${run.step}`));
        if (run.tool) parts.push(run.tool);
        return parts.join(' · ') || T('思考中…', 'Thinking…');
      }
    }
  }

  function visibleRuns() {
    const now = Date.now();
    const list = [];
    for (const run of runs.values()) {
      if (ACTIVE.has(run.status) || (run.ended && now - run.ended < FLASH_MS)) list.push(run);
    }
    // Active first, newest first.
    list.sort((a, b) => (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || (b.started - a.started));
    return list;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function row(run, compact, extra) {
    const item = el('div', `row status-${run.status}`);
    item.dataset.session = run.session_id || '';
    item.appendChild(el('span', 'dot'));
    const text = el('div', 'text');
    text.appendChild(el('div', 'title', label(run)));
    if (!compact) text.appendChild(el('div', 'detail', detail(run)));
    item.appendChild(text);
    const meta = el('div', 'meta');
    if (compact) meta.appendChild(el('span', 'detail', detail(run)));
    meta.appendChild(el('span', 'time', elapsed(run)));
    if (extra) meta.appendChild(el('span', 'more', `+${extra}`));
    if (!compact && run.status === 'running') {
      const stop = el('button', 'stop');
      stop.type = 'button';
      stop.title = T('中止', 'Stop');
      stop.setAttribute('aria-label', stop.title);
      stop.dataset.run = run.id;
      meta.appendChild(stop);
    }
    item.appendChild(meta);
    return item;
  }

  function render() {
    const list = visibleRuns();
    const flashing = list.some((r) => !ACTIVE.has(r.status));
    // The main window already shows the session being worked on.
    const covered = mainFocused && list.length > 0 && list.every((r) => r.session_id === currentSession);
    const show = list.length > 0 && !covered;
    root.replaceChildren();
    root.hidden = !show;
    if (show) {
      const expanded = hovered || flashing;
      root.classList.toggle('expanded', expanded);
      if (expanded) {
        for (const run of list.slice(0, 3)) root.appendChild(row(run, false, 0));
        if (list.length > 3) root.appendChild(el('div', 'overflow', T(`还有 ${list.length - 3} 个任务`, `${list.length - 3} more`)));
      } else {
        root.appendChild(row(list[0], true, list.length - 1));
      }
    }
    layout(show);
  }

  function layout(show) {
    if (!bridge) return;
    const rect = root.getBoundingClientRect();
    const w = show ? Math.ceil(rect.width) + 16 : 0;
    const h = show ? Math.ceil(rect.height) + 16 : 0;
    const key = `${show}:${w}:${h}`;
    if (key === lastLayout) return;
    lastLayout = key;
    bridge.layout({ visible: show, width: w, height: h });
  }

  async function post(path, body) {
    try {
      await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { /* backend restarting */ }
  }

  // Drag anywhere on the pill; a press that barely moves is a click.
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.screenX, y: e.screenY, moved: false, target: e.target };
    root.setPointerCapture(e.pointerId);
    if (bridge) bridge.drag('start', e.screenX, e.screenY);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.screenX - drag.x) + Math.abs(e.screenY - drag.y) > 4) drag.moved = true;
    if (drag.moved && bridge) bridge.drag('move', e.screenX, e.screenY);
  });
  root.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (bridge) bridge.drag('end', e.screenX, e.screenY);
    if (d.moved) return;
    const stop = d.target.closest && d.target.closest('button.stop');
    if (stop) {
      const run = runs.get(stop.dataset.run);
      if (run) post('/api/abort', { run_id: run.id, session_id: run.session_id });
      return;
    }
    const item = d.target.closest && d.target.closest('.row');
    const sid = item && item.dataset.session;
    if (sid && sid !== currentSession) post('/api/sessions', { action: 'select', id: sid });
    if (bridge) bridge.openMain();
  });
  root.addEventListener('pointercancel', () => { if (drag && bridge) bridge.drag('end', 0, 0); drag = null; });
  root.addEventListener('mouseenter', () => { hovered = true; render(); });
  root.addEventListener('mouseleave', () => { if (!drag) { hovered = false; render(); } });

  if (bridge) bridge.onState((state) => { mainFocused = !!(state && state.mainFocused); render(); });
  setInterval(() => { if (!root.hidden) render(); }, 1000);
  connect();
})();
