import { useSyncExternalStore } from 'react';

// Plugin pages: full main-area routes listed under "New chat" in the sidebar.
// The active page lives in the URL hash (#/p/<id>) so reload and back/forward work;
// an empty hash (or an unregistered id) shows the chat.
export type Page = { id: string; label: string; icon: string; order?: number };
type Snapshot = { active: string; pages: readonly Page[]; navs: number };
const PREFIX = '#/p/';
const fromHash = () => {
  if (!location.hash.startsWith(PREFIX)) return '';
  try { return decodeURIComponent(location.hash.slice(PREFIX.length)); } catch { return ''; }
};

class PageStore {
  private snapshot: Snapshot = { active: fromHash(), pages: [], navs: 0 };
  private listeners = new Set<() => void>();
  constructor() { window.addEventListener('hashchange', this.sync); window.addEventListener('popstate', this.sync); }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Snapshot) { this.snapshot = next; this.listeners.forEach(listener => listener()); }
  private sync = () => { const active = fromHash(); if (active !== this.snapshot.active) this.publish({ ...this.snapshot, active }); };
  // The route survives unregistering so a plugin reload returns to the same page.
  register(page: Page) {
    const pages = [...this.snapshot.pages.filter(item => item.id !== page.id), page]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    this.publish({ ...this.snapshot, pages });
    return () => {
      if (!this.snapshot.pages.includes(page)) return;
      this.publish({ ...this.snapshot, pages: this.snapshot.pages.filter(item => item !== page) });
    };
  }
  /** Registered page currently shown, or undefined for the chat. */
  current = (snapshot = this.snapshot) => snapshot.pages.find(item => item.id === snapshot.active);
  open = (id: string) => {
    if (fromHash() === id) return;
    location.hash = PREFIX + encodeURIComponent(id);
    this.sync();
  };
  /** Back to the chat; a no-op when no page route is active. */
  home = () => {
    if (!fromHash()) return;
    history.pushState(history.state, '', location.pathname + location.search);
    this.sync();
  };
  // A plugin-placed PageNav (e.g. under "New chat") suppresses the host fallback list.
  claimNav() {
    this.publish({ ...this.snapshot, navs: this.snapshot.navs + 1 });
    return () => this.publish({ ...this.snapshot, navs: this.snapshot.navs - 1 });
  }
}

export const pages = new PageStore();
export const usePages = () => useSyncExternalStore(pages.subscribe, pages.getSnapshot);
