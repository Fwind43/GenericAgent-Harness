import { useSyncExternalStore } from 'react';

type Section = { id: string; label: string; icon: string; order?: number };
type Snapshot = { open: boolean; active: string; sections: readonly Section[] };

class SettingsStore {
  private snapshot: Snapshot = { open: false, active: '', sections: [] };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: Snapshot) {
    this.snapshot = next;
    this.listeners.forEach(listener => listener());
  }
  register(section: Section) {
    const sections = [...this.snapshot.sections.filter(item => item.id !== section.id), section]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    this.publish({ ...this.snapshot, sections, active: this.snapshot.open ? this.snapshot.active || sections[0].id : sections[0].id });
    return () => {
      if (!this.snapshot.sections.includes(section)) return;
      const remaining = this.snapshot.sections.filter(item => item !== section);
      this.publish({ ...this.snapshot, sections: remaining, open: this.snapshot.open && remaining.length > 0,
        active: this.snapshot.active === section.id ? remaining[0]?.id ?? '' : this.snapshot.active });
    };
  }
  show = () => { if (this.snapshot.sections.length) this.publish({ ...this.snapshot, open: true }); };
  close = () => { if (this.snapshot.open) this.publish({ ...this.snapshot, open: false }); };
  select = (id: string) => {
    if (id !== this.snapshot.active && this.snapshot.sections.some(item => item.id === id)) this.publish({ ...this.snapshot, active: id });
  };
}

export const settings = new SettingsStore();
export const useSettings = () => useSyncExternalStore(settings.subscribe, settings.getSnapshot);
