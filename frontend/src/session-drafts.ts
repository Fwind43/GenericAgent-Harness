// Text drafts are local to this browser and keyed by session, not by the selected view.
export class SessionDrafts {
  private values = new Map<string, string>();
  private listeners = new Set<() => void>();
  constructor(private storage: () => Storage = () => localStorage) {}
  private key(id: string) { return `gah-session-draft:${encodeURIComponent(id)}`; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get = (id: string | undefined): string => {
    if (!id) return '';
    if (!this.values.has(id)) {
      let value = '';
      try { value = this.storage().getItem(this.key(id)) ?? ''; } catch { /* Private mode / blocked storage. */ }
      this.values.set(id, value);
    }
    return this.values.get(id)!;
  };
  set = (id: string | undefined, value: string) => {
    if (!id || this.get(id) === value) return;
    this.values.set(id, value);
    try {
      if (value) this.storage().setItem(this.key(id), value);
      else this.storage().removeItem(this.key(id));
    } catch { /* Keep the in-memory draft if storage is unavailable or full. */ }
    this.listeners.forEach(listener => listener());
  };
  // A slow send must neither clear another session nor overwrite text typed meanwhile.
  sent(id: string | undefined, original: string) {
    if (this.get(id) === original) this.set(id, '');
  }
}
export const sessionDrafts = new SessionDrafts();
