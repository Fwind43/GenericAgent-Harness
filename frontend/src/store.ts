import { useSyncExternalStore } from 'react';
import { request } from './api';
import { T, errorText } from './i18n';
import type { HostSnapshot, HostState, Message, Turn, Usage, WebManifest, RunEvent } from './types';

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
    const state = this.snapshot.state;
    if (!state.parallel_runs || event.seq <= (this.runSeq.get(event.run_id) ?? 0)) return;
    this.runSeq.set(event.run_id, event.seq);
    ++this.refreshVersion;
    const previous = state.runs?.find(run => run.id === event.run_id);
    const record = event.run ?? (previous ? { ...previous, seq: event.seq } : undefined);
    const runs = record ? [record, ...(state.runs ?? []).filter(run => run.id !== record.id)] : state.runs;
    let next: HostState = { ...state, runs };
    if (event.session_id === state.session_id) {
      if (event.messages) next = { ...next, messages: event.messages };
      else if (event.message) {
        const message = event.message;
        const index = state.messages.findLastIndex(item => item.role === 'assistant' && item.run_id === event.run_id);
        // If the initial event was missed, recover from the authoritative snapshot.
        if (index < 0) { void this.refresh().catch(error => this.report(error)); return; }
        next.messages = state.messages.map((item, i) => i === index ? message : item);
      }
      if (kind === 'run.started' || kind === 'run.cancelling') next = { ...next, running: true, run_id: event.run_id };
      if (kind === 'run.finished' && state.run_id === event.run_id) next = { ...next, running: false, run_id: null };
    }
    this.update({ state: next }, kind === 'run.event');
    this.emit(kind, event);
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
    listen<HostState>('snapshot', state => { this.setState(state); this.emit('snapshot', state); });
    for (const kind of ['run.started', 'run.event', 'run.cancelling', 'run.finished']) listen<RunEvent>(kind, event => this.acceptRun(kind, event));
    listen<WebManifest[]>('web.plugins', list => this.setState({ ...this.snapshot.state, web_plugins: list }));
    listen<unknown>('plugin', data => this.emit('plugin', data));
    listen<{ task: string; model?: string; reasoning_effort?: string }>('start', data => {
      const state = this.snapshot.state;
      this.setState({ ...state, running: true, messages: [...state.messages,
        { role: 'user', text: data.task, status: 'done' },
        { role: 'assistant', text: '', status: 'running', model: data.model, reasoning_effort: data.reasoning_effort },
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
