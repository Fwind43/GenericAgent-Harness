import { useSyncExternalStore } from 'react';
import { request } from './api';
import { T, errorText } from './i18n';
import type { HostSnapshot, HostState, Message, Turn, Usage, WebManifest, RunEvent } from './types';

const PARTS = ['summary', 'reply', 'thinking'] as const;
type Part = typeof PARTS[number];
/** Mirror of ``ga_harness.run_output.apply_event`` for streamed fragments, plus turn patches. */
function fold(message: Message, event: RunEvent): Message {
  const { patch, name, data } = event;
  if (patch) {
    const next: Message = { ...message, ...(patch.head ?? {}) };
    const turn = patch.turn;
    if (turn) {
      const turns = message.turns ?? [], at = turns.findLastIndex(item => item.turn === turn.turn);
      next.turns = at < 0 ? [...turns, turn] : turns.map((item, i) => i === at ? turn : item);
    }
    return next;
  }
  if (message.status !== 'running') return message;
  if (name === 'agent.chunk') return { ...message, text: (message.text ?? '') + String(data ?? '') };
  if (name !== 'assistant.delta' || !data || typeof data !== 'object' || Array.isArray(data)) return message;
  const { turn: number = 0, part, text } = data as { turn?: number; part?: string; text?: unknown };
  if (!PARTS.includes(part as Part) || typeof text !== 'string' || !text) return message;
  const key = part as Part, turns = message.turns ?? [], at = turns.findLastIndex(item => item.turn === number);
  const turn: Turn = at < 0 ? { turn: number, summary: '', reply: '', thinking: '', status: 'running', tools: [] } : turns[at];
  const updated = { ...turn, [key]: (turn[key] ?? '') + text };
  return { ...message, turns: at < 0 ? [...turns, updated] : turns.map((item, i) => i === at ? updated : item) };
}

type Listener = () => void;
type HostListener = (data: unknown) => void;
export class HostStore {
  private snapshot: HostSnapshot = { state: { running: false, messages: [] }, connected: false, changing: false, notice: '' };
  private listeners = new Set<Listener>();
  private events = new Map<string, Set<HostListener>>();
  private locks = new Set<symbol>();
  private source: EventSource | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private publishedState = this.snapshot.state;
  private runSeq = new Map<string, number>();
  private refreshVersion = 0;
  private resyncing = false;
  private pending: [string, RunEvent][] = [];
  getSnapshot = () => this.snapshot;
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  on(type: string, listener: HostListener) {
    const group = this.events.get(type) ?? new Set<HostListener>();
    this.events.set(type, group); group.add(listener);
    return () => { group.delete(listener); };
  }
  emit(type: string, data: unknown) {
    this.events.get(type)?.forEach(fn => { try { fn(data); } catch (e) { console.error('[gah host event]', e); } });
  }
  private flush = () => {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    this.listeners.forEach(fn => fn());
    if (this.publishedState !== this.snapshot.state) {
      this.publishedState = this.snapshot.state; this.emit('state', this.snapshot.state);
    }
    this.emit('sync', { running: this.snapshot.state.running, changing: this.snapshot.changing });
  };
  private update(change: Partial<HostSnapshot>, batch = false) {
    this.snapshot = { ...this.snapshot, ...change };
    // Coalesce streamed events, without rAF starvation in a hidden tab.
    if (!batch) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(this.flush, 50);
  }
  setState = (state: HostState) => {
    ++this.refreshVersion;
    this.runSeq = new Map((state.runs ?? []).map(run => [run.id, run.seq]));
    this.update({ state });
  };
  notice = (notice = '') => this.update({ notice });
  lock() {
    const token = Symbol(); this.locks.add(token); this.update({ changing: true });
    return () => { if (this.locks.delete(token)) this.update({ changing: this.locks.size > 0 }); };
  }
  async action<T>(fn: () => Promise<T>): Promise<T> {
    const unlock = this.lock(); this.notice();
    try { return await fn(); } finally { unlock(); }
  }
  private last(update: (message: Message) => Message, batch = false) {
    const state = this.snapshot.state, messages = state.messages;
    const old = messages.at(-1);
    if (!old || old.role !== 'assistant') return;
    this.update({ state: { ...state, messages: [...messages.slice(0, -1), update(old)] } }, batch);
  }
  private acceptRun(kind: string, event: RunEvent) {
    if (this.resyncing) { this.pending.push([kind, event]); return; }
    const state = this.snapshot.state;
    const last = this.runSeq.get(event.run_id);
    if (!state.parallel_runs || event.seq <= (last ?? 0)) return;
    const current = event.session_id === state.session_id;
    // Run events carry a delta (stream fragment) or a one-turn patch, not the
    // whole message; fold them into the local copy so unchanged turns keep
    // their identity and memoized rendering.
    const folds = current && !event.messages && (kind === 'run.event' || !!event.message);
    const index = folds ? state.messages.findLastIndex(item => item.role === 'assistant' && item.run_id === event.run_id) : -1;
    // A missed initial event or fragment cannot be folded: reload the live transcript.
    if (folds && (index < 0 || (kind === 'run.event' && last !== undefined && event.seq !== last + 1))) {
      this.resync(kind, event); return;
    }
    this.runSeq.set(event.run_id, event.seq);
    ++this.refreshVersion;
    const previous = state.runs?.find(run => run.id === event.run_id);
    const record = event.run ?? (previous ? { ...previous, seq: event.seq } : undefined);
    const runs = record ? [record, ...(state.runs ?? []).filter(run => run.id !== record.id)] : state.runs;
    let next: HostState = { ...state, runs };
    if (current) {
      if (event.messages) next = { ...next, messages: event.messages };
      else if (folds) {
        const old = state.messages[index], message = event.message ?? fold(old, event);
        if (message !== old) next.messages = state.messages.map((item, i) => i === index ? message : item);
      }
      if (kind === 'run.started' || kind === 'run.cancelling') next = { ...next, running: true, run_id: event.run_id };
      if (kind === 'run.finished' && state.run_id === event.run_id) next = { ...next, running: false, run_id: null };
    }
    this.update({ state: next }, kind === 'run.event');
    this.emit(kind, event);
  }
  /** Replace state with the server snapshot, then replay events received meanwhile. */
  private resync(kind: string, event: RunEvent) {
    this.resyncing = true; this.pending.push([kind, event]);
    const done = (state?: HostState) => {
      this.resyncing = false;
      const pending = this.pending; this.pending = [];
      if (!state) return;
      this.setState(state);
      for (const [k, e] of pending) this.acceptRun(k, e);
    };
    request<HostState>('/api/state').then(done, error => { done(); this.report(error); });
  }
  connect() {
    if (this.source) return () => {};
    const es = this.source = new EventSource('/api/events');
    const listen = <D,>(name: string, fn: (data: D) => void) => es.addEventListener(name, event => {
      try { fn(JSON.parse((event as MessageEvent<string>).data) as D); }
      catch (e) { console.error(`[gah ${name}]`, e); this.notice(T('同步数据失败，请刷新页面。', 'Unable to sync data. Please reload.')); }
    });
    es.onopen = () => this.update({ connected: true });
    es.onerror = () => this.update({ connected: false });
    listen<HostState>('snapshot', state => { this.update({ connected: true }); this.setState(state); this.emit('snapshot', state); });
    for (const kind of ['run.started', 'run.event', 'run.cancelling', 'run.finished']) listen<RunEvent>(kind, event => this.acceptRun(kind, event));
    listen<WebManifest[]>('web.plugins', list => this.setState({ ...this.snapshot.state, web_plugins: list }));
    listen<unknown>('plugin', data => this.emit('plugin', data));
    listen<{ task: string; model?: string; reasoning_effort?: string; created_at?: number }>('start', data => {
      const state = this.snapshot.state;
      this.setState({ ...state, running: true, messages: [...state.messages,
        { role: 'user', text: data.task, status: 'done', created_at: data.created_at },
        { role: 'assistant', text: '', status: 'running', model: data.model, reasoning_effort: data.reasoning_effort, created_at: data.created_at },
      ] });
    });
    listen<{ text: string }>('chunk', data => this.last(m => ({ ...m, text: (m.text ?? '') + data.text }), true));
    listen<{ index: number; turn: Turn }>('turn', data => this.last(m => {
      const turns = [...(m.turns ?? [])]; turns[data.index] = data.turn; return { ...m, turns };
    }));
    listen<{ index: number; turn: number; part: 'reply' | 'summary' | 'thinking'; text: string }>('delta', data => {
      if (!['reply', 'summary', 'thinking'].includes(data.part)) return;
      this.last(m => {
        const turns = [...(m.turns ?? [])];
        const turn = turns[data.index] ?? { turn: data.turn, status: 'running', tools: [] };
        turns[data.index] = { ...turn, [data.part]: (turn[data.part] ?? '') + data.text };
        return { ...m, turns };
      }, true);
    });
    listen<Usage>('usage', usage => this.last(m => ({ ...m, usage }), true));
    listen<{ status: Message['status']; error?: string }>('done', data => {
      this.last(m => ({ ...m, status: data.status, error: data.error }), true);
      this.setState({ ...this.snapshot.state, running: false }); this.emit('done', data);
    });
    return () => { es.close(); if (this.source === es) this.source = null; clearTimeout(this.flushTimer); this.flushTimer = undefined; };
  }
  async refresh() {
    const version = this.refreshVersion;
    const state = await request<HostState>('/api/state');
    if (version === this.refreshVersion) this.setState(state);
  }
  report(error: unknown) { this.notice(errorText(error)); }
}
export const host = new HostStore();
export const useHost = () => useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
