import { useSyncExternalStore } from 'react';

// Session views: the host owns the built-in "chat" view; plugins register more (e.g. trace).
// composer: false hides the host composer (input, attachments, send/stop) while the view is active.
export type View = { id: string; label: string; order?: number; composer?: boolean };
type Snapshot = { active: string; views: readonly View[] };
export const CHAT_VIEW = 'chat';

class ViewStore {
  private snapshot: Snapshot = { active: CHAT_VIEW, views: [] };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Snapshot) { this.snapshot = next; this.listeners.forEach(listener => listener()); }
  register(view: View) {
    const views = [...this.snapshot.views.filter(item => item.id !== view.id), view]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    this.publish({ ...this.snapshot, views });
    return () => {
      if (!this.snapshot.views.includes(view)) return;
      const views = this.snapshot.views.filter(item => item !== view);
      this.publish({ views, active: this.snapshot.active === view.id ? CHAT_VIEW : this.snapshot.active });
    };
  }
  select = (id: string) => {
    if (id !== this.snapshot.active && (id === CHAT_VIEW || this.snapshot.views.some(item => item.id === id))) this.publish({ ...this.snapshot, active: id });
  };
}

export const views = new ViewStore();
export const useViews = () => useSyncExternalStore(views.subscribe, views.getSnapshot);
// Whether the host composer is shown for the active view (always for chat; plugin views opt out).
export const showsComposer = (snapshot: Snapshot) => snapshot.active === CHAT_VIEW
  || snapshot.views.find(item => item.id === snapshot.active)?.composer !== false;
