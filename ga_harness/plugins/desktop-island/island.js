// desktop-island: the floating pill shown by the desktop shell. Follows /api/events like the main page
// and asks the shell (window.gahDesktop.plugin, the generic plugin-window bridge) to size, show
// and move its window. The window itself is declared in main.py; `pinned` arrives as state.data.
// One row per chat: chats waiting for an ask_user reply first, then chats with a live (or just
// finished) run, then unread chats. With the
// "always show" preference an idle pill stays on screen when there is nothing else to show.
'use strict';
(() => {
  const bridge = window.gahDesktop && window.gahDesktop.plugin;
  const root = document.getElementById('island');
  let pref = null;
  try { pref = localStorage.getItem('gah-lang'); } catch { /* storage unavailable */ }
  const zh = pref === 'zh' || (pref !== 'en' && navigator.language.toLowerCase().startsWith('zh'));
  const T = (a, b) => (zh ? a : b);

  const ACTIVE = new Set(['running', 'cancelling']);
  const FLASH_MS = 4000;
  const MAX_ROWS = 4;
  const runs = new Map();       // run_id -> {id, session_id, status, started, ended, step, tool, error}
  const sessions = new Map();   // session_id -> {id, title, updated, unread, running, parent_id}
  let currentSession = null;
  let mainFocused = false;
  let pinned = false;
  let hovered = false;
  let lastLayout = '';

  // GA ends a run when the agent calls ask_user, so the question would look like a finished run.
  // Remember chats whose run ended on ask_user until the user opens them or a new run starts there.
  const WAIT_KEY = 'gah-island-waiting';
  const waiting = new Map();    // session_id -> {question, at}
  try {
    for (const [sid, w] of Object.entries(JSON.parse(localStorage.getItem(WAIT_KEY) || '{}'))) {
      if (w && typeof w === 'object') waiting.set(sid, { question: String(w.question || ''), at: Number(w.at) || 0 });
    }
  } catch { /* storage unavailable or corrupt */ }
  function saveWaiting() {
    try { localStorage.setItem(WAIT_KEY, JSON.stringify(Object.fromEntries(waiting))); } catch { /* ignore */ }
  }
  function clearWaiting(sid) {
    if (sid && waiting.delete(sid)) saveWaiting();
  }

  function track(record) {
    if (!record || !record.id) return null;
    const prev = runs.get(record.id) || { step: 0, tool: '' };
    const run = Object.assign(prev, {
      id: record.id,
      session_id: record.session_id || prev.session_id,
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
    if (Array.isArray(snap.sessions)) {
      sessions.clear();
      for (const s of snap.sessions) if (s && s.id) sessions.set(s.id, s);
      let dropped = false;
      for (const sid of waiting.keys()) if (!sessions.has(sid)) { waiting.delete(sid); dropped = true; }
      if (dropped) saveWaiting();
    }
    if (Array.isArray(snap.runs)) {
      const seen = new Set();
      for (const r of snap.runs) {
        seen.add(r.id);
        const known = runs.has(r.id);
        const run = track(r);
        // Runs that already ended before we connected must not flash.
        if (!known && run && !ACTIVE.has(run.status)) run.ended = 0;
      }
      for (const [id, run] of runs) if (!seen.has(id) && !ACTIVE.has(run.status)) runs.delete(id);
    }
    render();
  }

  // Unread flags change when a run writes its transcript; re-read the state once it settles.
  let refreshTimer = 0;
  function refreshSoon(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        if (res.ok) onSnapshot(await res.json());
      } catch { /* backend restarting */ }
    }, delay);
  }

  function onRunEvent(env) {
    const run = runs.get(env.run_id);
    if (!run) return;
    const data = env.data || {};
    // Step title = the turn's <summary>: streamed by assistant.delta, final in assistant.text,
    // and carried by durable events' turn patch (covers joining mid-run).
    const turn = env.patch && env.patch.turn;
    if (turn && Number(turn.turn) >= run.step && typeof turn.summary === 'string') {
      run.step = Number(turn.turn) || run.step;
      run.summary = turn.summary;
    }
    if (env.name === 'turn.start') {
      run.step = Number(data.turn) || run.step + 1;
      run.tool = '';
      run.asked = null;
      run.summary = '';
    } else if (env.name === 'assistant.delta') {
      if (data.part !== 'summary' || typeof data.text !== 'string' || !data.text) return;
      if (Number(data.turn) && Number(data.turn) !== run.step) { run.step = Number(data.turn); run.summary = ''; }
      run.summary = (run.summary || '') + data.text;
    } else if (env.name === 'assistant.text') {
      if (typeof data.summary === 'string' && data.summary) run.summary = data.summary;
    } else if (env.name === 'tool.call') {
      run.tool = String(data.name || data.tool || '');
      const args = data.args && typeof data.args === 'object' ? data.args : {};
      run.asked = run.tool === 'ask_user' ? String(args.question || '') : null;
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
        if (run && run.session_id && kind === 'run.started') clearWaiting(run.session_id);
        if (run && run.session_id && kind === 'run.finished' && run.status === 'done' && run.asked != null) {
          waiting.set(run.session_id, { question: run.asked, at: Date.now() });
          saveWaiting();
        }
        if (kind === 'run.finished') { setTimeout(render, FLASH_MS + 50); refreshSoon(600); }
        render();
      });
    }
    es.addEventListener('run.event', (e) => { const env = parse(e.data); if (env) onRunEvent(env); });
    es.addEventListener('open', () => refreshSoon(0));
  }

  function parse(text) { try { return JSON.parse(text); } catch { return null; } }

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function ago(sec) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    if (s < 60) return T('\u521a\u521a', 'now');
    const m = Math.floor(s / 60);
    if (m < 60) return T(`${m} \u5206\u949f\u524d`, `${m}m ago`);
    const h = Math.floor(m / 60);
    if (h < 24) return T(`${h} \u5c0f\u65f6\u524d`, `${h}h ago`);
    return T(`${Math.floor(h / 24)} \u5929\u524d`, `${Math.floor(h / 24)}d ago`);
  }

  function title(sid) {
    const s = sessions.get(sid);
    return (s && s.title) || T('\u65b0\u4f1a\u8bdd', 'New session');
  }

  function runDetail(run, count) {
    let text;
    switch (run.status) {
      case 'done': text = T('\u5df2\u5b8c\u6210', 'Done'); break;
      case 'error': text = T('\u51fa\u9519', 'Failed'); break;
      case 'aborted': text = T('\u5df2\u4e2d\u6b62', 'Stopped'); break;
      case 'interrupted': text = T('\u5df2\u4e2d\u65ad', 'Interrupted'); break;
      case 'cancelling': text = T('\u6b63\u5728\u4e2d\u6b62\u2026', 'Stopping\u2026'); break;
      default: {
        const parts = [];
        if (run.step) parts.push(T(`\u7b2c ${run.step} \u6b65`, `Step ${run.step}`));
        const summary = (run.summary || '').replace(/\s+/g, ' ').trim();
        if (summary) parts.push(summary);
        else if (run.tool) parts.push(run.tool);
        text = parts.join(' \u00b7 ') || T('\u601d\u8003\u4e2d\u2026', 'Thinking\u2026');
      }
    }
    return count > 1 ? `${text} \u00b7 ${T(`${count} \u4e2a\u4efb\u52a1`, `${count} runs`)}` : text;
  }

  // Rows to show: one per chat with a live or just-finished run, then unread chats.
  function items() {
    const now = Date.now();
    const bySession = new Map();
    for (const run of runs.values()) {
      const live = ACTIVE.has(run.status);
      if (!live && !(run.ended && now - run.ended < FLASH_MS)) continue;
      const key = run.session_id || run.id;
      const cur = bySession.get(key);
      if (!cur) { bySession.set(key, { kind: 'run', sid: run.session_id, run, count: live ? 1 : 0 }); continue; }
      if (live) cur.count += 1;
      // Prefer a live run, then the newest one.
      const better = (ACTIVE.has(run.status) - ACTIVE.has(cur.run.status)) || (run.started - cur.run.started);
      if (better > 0) cur.run = run;
    }
    // Opening the chat in the focused main window counts as having seen the question.
    if (mainFocused && currentSession && waiting.has(currentSession)) clearWaiting(currentSession);
    const asks = [];
    for (const [sid, w] of waiting) {
      const cur = bySession.get(sid);
      if (cur && ACTIVE.has(cur.run.status)) continue;
      bySession.delete(sid);
      asks.push({ kind: 'waiting', sid, question: w.question, at: w.at });
    }
    asks.sort((a, b) => b.at - a.at);
    const list = [...bySession.values()];
    list.sort((a, b) => (ACTIVE.has(b.run.status) - ACTIVE.has(a.run.status)) || (b.run.started - a.run.started));
    const unread = [];
    for (const s of sessions.values()) {
      if (!s.unread || s.running || bySession.has(s.id) || waiting.has(s.id)) continue;
      if (mainFocused && s.id === currentSession) continue;
      unread.push({ kind: 'unread', sid: s.id, updated: Number(s.updated) || 0 });
    }
    unread.sort((a, b) => b.updated - a.updated);
    return asks.concat(list, unread);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function row(item, compact, badges) {
    const run = item.run;
    const status = item.kind === 'run' ? run.status : item.kind;
    const node = el('div', `row status-${status}`);
    node.dataset.session = item.sid || '';
    node.appendChild(el('span', 'dot'));
    const text = el('div', 'text');
    let detail;
    let time;
    if (item.kind === 'run') {
      detail = runDetail(run, item.count);
      time = clock((ACTIVE.has(run.status) ? Date.now() : (run.ended || Date.now())) - run.started);
    } else if (item.kind === 'waiting') {
      const q = item.question.replace(/\s+/g, ' ').trim();
      detail = q ? `${T('\u7b49\u4f60\u56de\u590d', 'Needs your reply')}: ${q}` : T('\u7b49\u4f60\u56de\u590d', 'Needs your reply');
      time = item.at ? ago(item.at / 1000) : '';
    } else if (item.kind === 'unread') {
      detail = T('\u6709\u65b0\u6d88\u606f', 'New messages');
      time = item.updated ? ago(item.updated) : '';
    } else {
      detail = T('\u7a7a\u95f2', 'Idle');
      time = '';
    }
    text.appendChild(el('div', 'title', item.kind === 'idle' ? 'GenericAgent' : title(item.sid)));
    if (!compact) text.appendChild(el('div', 'detail', detail));
    node.appendChild(text);
    const meta = el('div', 'meta');
    if (compact) meta.appendChild(el('span', 'detail', detail));
    if (time) meta.appendChild(el('span', 'time', time));
    if (badges) {
      if (badges.waiting) meta.appendChild(el('span', 'badge badge-waiting', `${badges.waiting}`));
      if (badges.running) meta.appendChild(el('span', 'badge badge-running', `${badges.running}`));
      if (badges.unread) meta.appendChild(el('span', 'badge badge-unread', `${badges.unread}`));
    }
    if (!compact && item.kind === 'run' && run.status === 'running') {
      const stop = el('button', 'stop');
      stop.type = 'button';
      stop.title = T('\u4e2d\u6b62', 'Stop');
      stop.setAttribute('aria-label', stop.title);
      stop.dataset.run = run.id;
      meta.appendChild(stop);
    }
    node.appendChild(meta);
    return node;
  }

  function render() {
    const list = items();
    const now = Date.now();
    const flashing = list.some((i) => (i.kind === 'run' && !ACTIVE.has(i.run.status)) || (i.kind === 'waiting' && now - i.at < FLASH_MS));
    // The main window already shows the chat being worked on and the unread markers.
    const covered = mainFocused && list.every((i) => i.kind === 'unread' || i.sid === currentSession);
    const busy = list.length > 0 && !covered;
    const show = busy || pinned;
    root.replaceChildren();
    root.hidden = !show;
    if (show) {
      const shown = busy ? list : [];
      const expanded = shown.length > 0 && (hovered || flashing);
      root.classList.toggle('expanded', expanded);
      root.classList.toggle('idle', !shown.length);
      if (!shown.length) {
        root.appendChild(row({ kind: 'idle' }, true, null));
      } else if (expanded) {
        for (const item of shown.slice(0, MAX_ROWS)) root.appendChild(row(item, false, null));
        if (shown.length > MAX_ROWS) root.appendChild(el('div', 'overflow', T(`\u8fd8\u6709 ${shown.length - MAX_ROWS} \u4e2a\u4f1a\u8bdd`, `${shown.length - MAX_ROWS} more`)));
      } else {
        // Collapsed: the top row plus counters for everything else.
        const rest = shown.slice(1);
        const running = rest.filter((i) => i.kind === 'run' && ACTIVE.has(i.run.status)).length;
        const unread = rest.filter((i) => i.kind === 'unread').length;
        const waits = rest.filter((i) => i.kind === 'waiting').length;
        root.appendChild(row(shown[0], true, { waiting: waits, running, unread }));
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
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.ok;
    } catch { return false; /* backend restarting */ }
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
  root.addEventListener('pointerup', async (e) => {
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
    // Switching chats can be refused while a run is busy; the main window still opens.
    if (sid && sid !== currentSession) await post('/api/sessions', { action: 'select', id: sid });
    if (bridge) bridge.openMain();
  });
  root.addEventListener('pointercancel', () => { if (drag && bridge) bridge.drag('end', 0, 0); drag = null; });
  // Rendering replaces the rows under the cursor, which makes Chromium fire mouseenter again;
  // only re-render when the hover state actually changes or the pill loops and drops clicks.
  root.addEventListener('mouseenter', () => { if (!hovered) { hovered = true; render(); } });
  root.addEventListener('mouseleave', () => { if (!drag && hovered) { hovered = false; render(); } });

  if (bridge) {
    bridge.onState((state) => {
      mainFocused = !!(state && state.mainFocused);
      pinned = !!(state && state.data && state.data.pinned);
      render();
    });
  }
  setInterval(() => { if (!root.hidden) render(); }, 1000);
  connect();
  render();
})();
