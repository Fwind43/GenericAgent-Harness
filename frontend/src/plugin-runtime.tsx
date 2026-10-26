import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { request } from './api';
import { host, useHost } from './store';
import { T, errorText } from './i18n';
import { el, h, type BrowserSDK, type Cleanup, type Interceptor, type PluginAPI, type PluginSetup, type ReactPlugin, type SlotName } from './sdk';
import type { WebManifest } from './types';

class Boundary extends React.Component<{ name: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { host.notice(`${this.props.name}: ${error.message}`); }
  render() { return this.state.failed ? <div role="alert">{T('插件界面加载失败', 'Plugin UI failed')}: {this.props.name}</div> : this.props.children; }
}
interface Instance { manifest: WebManifest; controller: AbortController; cleanup: Cleanup[]; started: boolean }
export class PluginRuntime {
  private instances = new Map<string, Instance>();
  private definitions = new Map<string, PluginSetup>();
  private native = new Map<string, ReactPlugin>();
  private interceptors = new Set<Interceptor>();
  private syncing = false;
  private pending: WebManifest[] | null = null;
  readonly sdk: BrowserSDK = {
    define: (name, setup) => {
      // Ignore a script which finished loading after its revision was withdrawn.
      const script = document.currentScript as HTMLScriptElement | null;
      const instance = this.instances.get(name);
      if (script && script.dataset.gahRev !== String(instance?.manifest.rev)) return;
      if (!instance || this.native.has(name)) return;
      this.definitions.set(name, setup); this.start(instance);
    },
    defineReact: (name, component) => this.sdk.define(name, api => api.mount('overlay', React.createElement(component, { api }))),
    React, useHost,
  };
  register(name: string, component: ReactPlugin) { this.native.set(name, component); }
  private report(name: string, error: unknown) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) host.notice(`${name}: ${errorText(error)}`);
  }
  private start(instance: Instance) {
    const { manifest: m, controller, cleanup } = instance;
    const component = this.native.get(m.name);
    const setup: PluginSetup | undefined = component ? api => api.mount('overlay', React.createElement(component, { api })) : this.definitions.get(m.name);
    if (!setup || instance.started || controller.signal.aborted) return;
    instance.started = true;
    let unlock: Cleanup | undefined;
    const own = (fn: Cleanup): Cleanup => {
      let done = false;
      const once = () => { if (!done) { done = true; fn(); } };
      if (controller.signal.aborted) once(); else cleanup.push(once);
      return once;
    };
    const guard = <T,>(fn: (data: T) => void) => (data: unknown) => {
      if (controller.signal.aborted) return;
      try { fn(data as T); } catch (error) { this.report(m.name, error); }
    };
    const slot = <N extends HTMLElement,>(name: SlotName, node: N): N => {
      if (controller.signal.aborted) throw new DOMException('Plugin stopped', 'AbortError');
      const target = document.querySelector(`.gah-slot[data-slot="${name}"]`);
      if (!target) throw new Error(`Unknown slot: ${name}`);
      node.dataset.gahPlugin = m.name;
      target.append(node); own(() => node.remove()); return node;
    };
    const api: PluginAPI = {
      name: m.name, signal: controller.signal, slot,
      mount: (name, content) => {
        const container = slot(name, el('div', 'gah-plugin-root'));
        const root = createRoot(container);
        root.render(<Boundary name={m.name}>{content}</Boundary>);
        return own(() => { root.unmount(); container.remove(); });
      },
      get: (path = '') => request(`/api/p/${m.name}/${path.replace(/^\/+/, '')}`, undefined, controller.signal),
      post: (path = '', body = {}) => request(`/api/p/${m.name}/${path.replace(/^\/+/, '')}`, body, controller.signal),
      host: { get: path => request(path, undefined, controller.signal), post: (path, body = {}) => request(path, body, controller.signal) },
      on: (kind, fn) => own(host.on('plugin', guard<{ plugin: string; kind: string; data: unknown }>(event => {
        if (event.plugin === m.name && event.kind === kind) guard(fn)(event.data);
      }))),
      onHost: (kind, fn) => own(host.on(kind, guard(fn))),
      intercept: fn => { this.interceptors.add(fn); return own(() => { this.interceptors.delete(fn); }); },
      state: () => host.getSnapshot().state,
      setState: (state, reset) => { if (!controller.signal.aborted) { host.setState(state); if (reset) host.emit('reset', null); } },
      notice: text => { if (!controller.signal.aborted) host.notice(text); },
      lock: on => {
        if (controller.signal.aborted) return;
        if (on && !unlock) unlock = host.lock();
        else if (!on && unlock) { const release = unlock; unlock = undefined; release(); }
      },
      cleanup: own,
      listen: (target, type, fn, options) => {
        const listener: EventListener = event => { try { fn(event); } catch (error) { this.report(m.name, error); } };
        target.addEventListener(type, listener, options);
        return own(() => target.removeEventListener(type, listener, options));
      },
      every: (ms, fn) => { const id = window.setInterval(() => guard(fn)(undefined), ms); return own(() => clearInterval(id)); },
      el, h,
    };
    own(() => { unlock?.(); unlock = undefined; });
    try { const result = setup(api); if (typeof result === 'function') own(result); }
    catch (error) { this.report(m.name, error); this.stop(m.name); }
  }
  private stop(name: string) {
    const instance = this.instances.get(name);
    if (!instance) return;
    this.instances.delete(name); this.definitions.delete(name);
    instance.controller.abort();
    for (const fn of instance.cleanup.reverse()) { try { fn(); } catch (error) { console.error(`[gah ${name} cleanup]`, error); } }
  }
  private asset(instance: Instance, url: string, kind: 'style' | 'head' | 'script'): Promise<void> {
    const { manifest: m, controller, cleanup } = instance;
    const absolute = new URL(url, location.href);
    if (absolute.origin !== location.origin) return Promise.reject(new Error('Plugin assets must be same-origin'));
    const existing = [...document.head.querySelectorAll<HTMLLinkElement | HTMLScriptElement>('[data-gah-plugin]')]
      .find(node => node.dataset.gahPlugin === m.name && (node instanceof HTMLLinkElement ? node.href : node.src) === absolute.href);
    if (existing) { cleanup.push(() => existing.remove()); return Promise.resolve(); }
    const node = kind === 'style' ? document.createElement('link') : document.createElement('script');
    node.dataset.gahPlugin = m.name; node.dataset.gahRev = String(m.rev);
    if (node instanceof HTMLLinkElement) { node.rel = 'stylesheet'; node.href = url; }
    else { node.src = url; node.async = false; }
    cleanup.push(() => node.remove());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Plugin asset timed out: ${url}`)), 15000);
      const abort = () => finish(new DOMException('Plugin stopped', 'AbortError'));
      const finish = (error?: Error) => {
        clearTimeout(timer); node.onload = node.onerror = null;
        controller.signal.removeEventListener('abort', abort);
        if (error) { node.remove(); reject(error); } else resolve();
      };
      node.onload = () => finish(); node.onerror = () => finish(new Error(`Plugin asset failed: ${url}`));
      controller.signal.addEventListener('abort', abort, { once: true });
      document.head.append(node);
    });
  }
  private async load(instance: Instance) {
    const m = instance.manifest;
    try {
      if (m.style) await this.asset(instance, m.style, 'style');
      if (instance.controller.signal.aborted) return;
      if (m.head) await this.asset(instance, m.head, 'head');
      if (instance.controller.signal.aborted) return;
      if (this.native.has(m.name)) this.start(instance);
      else if (m.script) await this.asset(instance, m.script, 'script');
    } catch (error) { if (!instance.controller.signal.aborted) this.report(m.name, error); }
  }
  sync(list: WebManifest[]) {
    this.pending = list;
    if (this.syncing) return;
    this.syncing = true;
    try {
      while (this.pending) {
        const desired = this.pending; this.pending = null;
        for (const [name, instance] of this.instances) {
          const next = desired.find(m => m.name === name);
          if (!next || JSON.stringify(next) !== JSON.stringify(instance.manifest)) this.stop(name);
        }
        for (const manifest of desired) {
          if (this.instances.has(manifest.name)) continue;
          const instance: Instance = { manifest, controller: new AbortController(), cleanup: [], started: false };
          this.instances.set(manifest.name, instance); void this.load(instance);
        }
      }
    } finally { this.syncing = false; }
  }
  async claim(text: string) {
    for (const fn of [...this.interceptors]) {
      try { if (await fn(text)) return true; } catch (error) { host.report(error); return true; }
    }
    return false;
  }
  dispose() { this.sync([]); }
}
export const plugins = new PluginRuntime();
