import type { ComponentType, ReactNode } from 'react';
import type { HostState } from './types';

export type SlotName = 'sidebar' | 'sidebar-foot' | 'header' | 'toolbar' | 'composer-top' | 'composer' | 'overlay' | 'settings' | 'view';
export type Cleanup = () => void;
export type Interceptor = (text: string) => boolean | Promise<boolean>;
export type DomChild = Node | string | number | boolean | null | undefined | DomChild[];
export interface PluginAPI {
  readonly name: string;
  readonly signal: AbortSignal;
  slot<T extends HTMLElement>(name: SlotName, node: T): T;
  mount(name: SlotName, content: ReactNode): Cleanup;
  get<T = unknown>(path?: string): Promise<T>;
  post<T = unknown>(path?: string, body?: unknown): Promise<T>;
  on<T = unknown>(kind: string, fn: (data: T) => void): Cleanup;
  onHost<T = unknown>(kind: string, fn: (data: T) => void): Cleanup;
  intercept(fn: Interceptor): Cleanup;
  state(): HostState;
  setState(state: HostState, reset?: boolean): void;
  notice(text?: string): void;
  lock(on: boolean): void;
  cleanup(fn: Cleanup): Cleanup;
  listen(target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions | boolean): Cleanup;
  every(ms: number, fn: () => void): Cleanup;
  el(tag: string, className?: string, text?: string): HTMLElement;
  h(tag: string, props?: Record<string, unknown> | null, ...children: DomChild[]): HTMLElement;
  host: { get<T = unknown>(path: string): Promise<T>; post<T = unknown>(path: string, body?: unknown): Promise<T> };
}
export type PluginSetup = (api: PluginAPI) => void | Cleanup;
export type ReactPlugin = ComponentType<{ api: PluginAPI }>;
export interface BrowserSDK {
  readonly React: typeof import('react');
  readonly useHost: typeof import('./store').useHost;
  define(name: string, setup: PluginSetup): void;
  defineReact(name: string, component: ReactPlugin): void;
}

export function el(tag: string, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
export function h(tag: string, props: Record<string, unknown> | null = {}, ...children: DomChild[]) {
  const node = el(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  const append = (child: DomChild) => {
    if (Array.isArray(child)) child.forEach(append);
    else if (child != null && child !== false && child !== true) node.append(child instanceof Node ? child : String(child));
  };
  children.forEach(append);
  return node;
}
