import { Component, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import type { Message, ToolCall } from './types';

// Typed extension slots. Unlike the DOM slots in sdk.ts (`api.slot` / `api.mount`), the host
// renders these inside its own React tree and passes props, so a plugin can replace, wrap or
// conditionally take over existing UI. Plugins may define their own slots for other plugins.
//   list   - every entry renders after the default content
//   single - one plugin replaces the default content
//   chain  - the first entry whose `select(props)` is truthy renders instead of the default
//   hoc    - every entry wraps the default content (lowest order outermost)
export type SlotKind = 'list' | 'single' | 'chain' | 'hoc';
const KINDS: readonly SlotKind[] = ['list', 'single', 'chain', 'hoc'];
const METHOD: Record<SlotKind, string> = { list: 'add', single: 'replace', chain: 'claim', hoc: 'wrap' };

/** Slot name -> kind and props. Plugins that define slots extend it by declaration merging. */
export interface SlotMap {
  /** Wraps one chat message (user or assistant). */
  'message': { kind: 'hoc'; props: { message: Message; last: boolean } };
  /** Extra controls in the action row under an assistant message. */
  'message.actions': { kind: 'list'; props: { message: Message } };
  /** Content appended at the end of a message. */
  'message.footer': { kind: 'list'; props: { message: Message } };
  /** Rendering of one tool call. */
  'tool': { kind: 'chain'; props: { tool: ToolCall; awaiting: boolean } };
  /** The empty-chat landing. */
  'empty': { kind: 'single'; props: Record<string, never> };
}
const HOST_SLOTS: { [N in keyof SlotMap]: SlotMap[N]['kind'] } = {
  'message': 'hoc', 'message.actions': 'list', 'message.footer': 'list', 'tool': 'chain', 'empty': 'single',
};
export type SlotProps<N extends string> = N extends keyof SlotMap ? SlotMap[N]['props'] : Record<string, unknown>;
/** Known names must have kind K; `<plugin>/<slot>` names without a SlotMap entry are checked at activation. */
export type SlotOf<N extends string, K extends SlotKind> =
  N extends keyof SlotMap ? (SlotMap[N]['kind'] extends K ? N : never) : N extends `${string}/${string}` ? N : never;
/** `children` is the default content (single, chain) or the wrapped content (hoc). */
export type SlotComponent<N extends string> = ComponentType<SlotProps<N> & { children?: ReactNode }>;
export interface SlotsAPI {
  /** Declare a slot owned by this plugin. The name must be `<this plugin>/<slot>`; call it synchronously in setup. */
  define(name: string, kind: SlotKind): () => void;
  add<N extends string>(name: SlotOf<N, 'list'>, component: SlotComponent<N>, options?: { order?: number }): () => void;
  replace<N extends string>(name: SlotOf<N, 'single'>, component: SlotComponent<N>): () => void;
  claim<N extends string>(name: SlotOf<N, 'chain'>, select: (props: SlotProps<N>) => unknown, component: SlotComponent<N>, options?: { order?: number }): () => void;
  wrap<N extends string>(name: SlotOf<N, 'hoc'>, component: SlotComponent<N>, options?: { order?: number }): () => void;
  /** Outlet: renders a slot's entries around `children` (the default content). */
  readonly Slot: typeof Slot;
}

interface Def { kind: SlotKind; owner: string }
export interface SlotEntry {
  id: number; name: string; kind: SlotKind; plugin: string; order: number;
  component: ComponentType<Record<string, unknown>>; select?: (props: Record<string, unknown>) => unknown;
}
const EMPTY: readonly SlotEntry[] = [];
const HOST = 'host';
const isComponent = (value: unknown) => typeof value === 'function' || (!!value && typeof value === 'object' && '$$typeof' in value);
const mismatch = (name: string, actual: SlotKind, used: SlotKind) =>
  `Slot "${name}" is a ${actual} slot: use slots.${METHOD[actual]}(), not slots.${METHOD[used]}()`;

export class SlotRegistry {
  private defs = new Map<string, Def>();
  private entries = new Map<string, readonly SlotEntry[]>();
  private listeners = new Set<() => void>();
  private reported = new Set<number>();
  private settled = new Set<string>();
  private seq = 0;
  /** Whether a plugin is enabled in this page; set by the plugin runtime. */
  known: (plugin: string) => boolean = () => false;
  /** Report a slot failure against the plugin that caused it; set by the plugin runtime. */
  report: (plugin: string, error: unknown) => void = (plugin, error) => console.error(`[gah ${plugin} slot]`, error);

  constructor() {
    for (const [name, kind] of Object.entries(HOST_SLOTS)) this.defs.set(name, { kind: kind as SlotKind, owner: HOST });
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit() { for (const fn of [...this.listeners]) fn(); }
  /** Entries of a defined slot; a stable array until the slot changes. */
  read = (name: string): readonly SlotEntry[] => this.defs.has(name) ? this.entries.get(name) ?? EMPTY : EMPTY;
  kind(name: string) { return this.defs.get(name)?.kind; }
  private drop(name: string, keep: (entry: SlotEntry) => boolean) {
    const list = this.entries.get(name);
    if (!list) return;
    const next = list.filter(keep);
    if (next.length) this.entries.set(name, next); else this.entries.delete(name);
  }

  define(owner: string, name: string, kind: SlotKind) {
    if (typeof name !== 'string' || !name.startsWith(owner + '/') || name.length === owner.length + 1)
      throw new Error(`Slot "${String(name)}" must be named "${owner}/<slot>"`);
    if (!KINDS.includes(kind)) throw new Error(`Slot "${name}": unknown kind "${String(kind)}" (expected ${KINDS.join(', ')})`);
    if (this.defs.has(name)) throw new Error(`Slot "${name}" is already defined`);
    this.defs.set(name, { kind, owner });
    // Entries registered before the owner loaded could not be checked until now.
    for (const entry of this.entries.get(name) ?? []) if (entry.kind !== kind) this.report(entry.plugin, new Error(mismatch(name, kind, entry.kind)));
    this.drop(name, entry => entry.kind === kind);
    this.emit();
    return () => { if (this.defs.get(name)?.owner === owner) { this.defs.delete(name); this.emit(); } };
  }
  /** A plugin's setup is about to run: its slots may be defined (again). */
  open(owner: string) { this.settled.delete(owner); }
  /** A plugin's setup has finished: entries still waiting for a slot it never defined are errors. */
  settle(owner: string) {
    this.settled.add(owner);
    for (const [name, list] of [...this.entries]) {
      if (!name.startsWith(owner + '/') || this.defs.has(name)) continue;
      for (const entry of list) this.report(entry.plugin, new Error(`Unknown slot: ${name} (plugin "${owner}" does not define it)`));
      this.entries.delete(name);
    }
  }
  register(plugin: string, kind: SlotKind, name: string, component: unknown, select?: unknown, order: unknown = 0) {
    const method = `slots.${METHOD[kind]}("${String(name)}")`;
    const def = this.defs.get(name);
    if (def) {
      if (def.kind !== kind) throw new Error(mismatch(name, def.kind, kind));
    } else {
      // A slot owned by another enabled plugin that has not run yet is checked in define()/settle().
      const owner = typeof name === 'string' && name.includes('/') ? name.slice(0, name.indexOf('/')) : '';
      if (!owner || owner === plugin || !this.known(owner) || this.settled.has(owner))
        throw new Error(`Unknown slot: ${String(name)}. Defined slots: ${[...this.defs.keys()].join(', ')}`);
    }
    if (!isComponent(component)) throw new Error(`${method}: component must be a React component`);
    if (kind === 'chain' && typeof select !== 'function') throw new Error(`${method}: select must be a function`);
    if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error(`${method}: order must be a finite number`);
    const list = this.entries.get(name) ?? EMPTY;
    const taken = kind === 'single' ? list.find(entry => entry.kind === 'single') : undefined;
    if (taken) throw new Error(`Slot "${name}" is already replaced by plugin "${taken.plugin}"`);
    const entry: SlotEntry = {
      id: ++this.seq, name, kind, plugin, order, component: component as SlotEntry['component'],
      select: kind === 'chain' ? select as SlotEntry['select'] : undefined,
    };
    this.entries.set(name, [...list, entry].sort((a, b) => a.order - b.order || a.id - b.id));
    this.emit();
    return () => { this.drop(name, item => item.id !== entry.id); this.reported.delete(entry.id); this.emit(); };
  }
  /** Report a failing entry once, not on every render. */
  failed(entry: SlotEntry, error: unknown) {
    if (this.reported.has(entry.id)) return;
    this.reported.add(entry.id); this.report(entry.plugin, error);
  }
}
export const slots = new SlotRegistry();

// One boundary per entry: a failing plugin component falls back to the content it replaced or
// wrapped (nothing for a list entry) and is reported once against its plugin.
class Boundary extends Component<{ entry: SlotEntry; fallback?: ReactNode; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { slots.failed(this.props.entry, error); }
  render() { return this.state.failed ? this.props.fallback ?? null : this.props.children; }
}
const render = (entry: SlotEntry, props: Record<string, unknown>, children: ReactNode) =>
  <Boundary key={entry.id} entry={entry} fallback={children}>{createElement(entry.component, props, children)}</Boundary>;

/** Outlet for a slot. `children` is the default content; with no entries it renders unchanged. */
export function Slot<N extends string>({ name, props, children }: { name: N; props?: SlotProps<N>; children?: ReactNode }) {
  const entries = useSyncExternalStore(slots.subscribe, () => slots.read(name));
  if (!entries.length) return <>{children}</>;
  const data = (props ?? {}) as Record<string, unknown>;
  const kind = entries[0].kind;
  if (kind === 'list') return <>{children}{entries.map(entry => render(entry, data, undefined))}</>;
  if (kind === 'hoc') return <>{entries.reduceRight<ReactNode>((inner, entry) => render(entry, data, inner), children)}</>;
  const entry = kind === 'single' ? entries[0] : entries.find(item => {
    // A throwing selector must not break the host render; report it after this render and skip the entry.
    try { return !!item.select!(data); } catch (error) { queueMicrotask(() => slots.failed(item, error)); return false; }
  });
  return entry ? render(entry, data, children) : <>{children}</>;
}

/** The `api.slots` object of one plugin; `own` ties each registration to the plugin's lifetime. */
export function bindSlots(plugin: string, own: (fn: () => void) => () => void): SlotsAPI {
  const order = (options?: { order?: number }) => options?.order ?? 0;
  return {
    define: (name, kind) => own(slots.define(plugin, name, kind)),
    add: (name, component, options) => own(slots.register(plugin, 'list', name, component, undefined, order(options))),
    replace: (name, component) => own(slots.register(plugin, 'single', name, component)),
    claim: (name, select, component, options) => own(slots.register(plugin, 'chain', name, component, select, order(options))),
    wrap: (name, component, options) => own(slots.register(plugin, 'hoc', name, component, undefined, order(options))),
    Slot,
  };
}