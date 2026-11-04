import { MAX_FILES, pendingOf, upload, type Pending } from './components/Attachments';
import { T } from './i18n';
import { host } from './store';

type Item = Pending & { source: File };
type Snapshot = { items: Item[]; loading: boolean };
const EMPTY: Snapshot = { items: [], loading: true };

// IndexedDB retains the actual files (including pasted images), not ephemeral blob URLs.
class AttachmentDrafts {
  private sessions = new Map<string, Snapshot>();
  private listeners = new Set<() => void>();
  private database?: Promise<IDBDatabase>;
  private writes = new Map<string, Promise<void>>();
  private warned = false;
  private stored?: Set<string>;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Sessions with attachment drafts, from the database keys, so unopened sessions count too. */
  ids = (): ReadonlySet<string> => {
    if (!this.stored) {
      const stored = this.stored = new Set<string>();
      void this.db().then(db => new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = db.transaction('sessions').objectStore('sessions').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })).then(keys => {
        for (const key of keys) if (typeof key === 'string' && !this.sessions.has(key)) stored.add(key);
        this.listeners.forEach(listener => listener());
      }, () => { /* No database: only this page's drafts are known. */ });
    }
    return this.stored;
  };
  get = (id?: string): Snapshot => id ? this.sessions.get(id) ?? EMPTY : EMPTY;
  private publish(id: string, snapshot: Snapshot) {
    this.sessions.set(id, snapshot);
    // While loading, keep the stored flag; afterwards the loaded items are authoritative.
    if (!snapshot.loading) { this.ids(); if (snapshot.items.length) this.stored!.add(id); else this.stored!.delete(id); }
    this.listeners.forEach(listener => listener());
  }
  private db() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gah-attachment-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Draft database blocked'));
    });
  }
  private warn() {
    if (this.warned) return;
    this.warned = true;
    host.notice(T('附件草稿无法保存到本地，刷新前请先发送或备份附件。', 'Attachment drafts cannot be saved locally. Send or back up files before refreshing.'));
  }
  private persist(id: string) {
    const items = this.get(id).items.map(({ preview: _preview, ...item }) => item);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        if (items.length) store.put(items, id); else store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }).catch(() => this.warn());
    this.writes.set(id, next);
    void next.then(() => { if (this.writes.get(id) === next) this.writes.delete(id); });
  }
  async load(id?: string) {
    if (!id || this.sessions.has(id)) return;
    this.publish(id, EMPTY);
    let items: Item[] = [];
    try {
      const db = await this.db();
      const stored = await new Promise<Item[] | undefined>((resolve, reject) => {
        const request = db.transaction('sessions').objectStore('sessions').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // Reupload from local originals: server-side temporary uploads may have expired.
      items = (stored ?? []).map(item => ({ ...pendingOf(item.source), key: item.key, source: item.source }));
    } catch { this.warn(); }
    this.publish(id, { items, loading: false });
    for (const item of items) if (!item.error) this.startUpload(id, item);
  }
  add(id: string | undefined, sources: File[]) {
    if (!id || this.get(id).loading) {
      host.notice(T('正在恢复会话草稿，请稍后添加附件。', 'Restoring session drafts; please add files shortly.'));
      return;
    }
    const current = this.get(id).items;
    const room = MAX_FILES - current.length;
    if (sources.length > room) host.notice(T(`每条消息最多 ${MAX_FILES} 个附件`, `At most ${MAX_FILES} attachments per message`));
    const items = sources.slice(0, Math.max(0, room)).map(source => ({ ...pendingOf(source), source }));
    this.publish(id, { items: [...current, ...items], loading: false });
    this.persist(id);
    for (const item of items) if (!item.error) this.startUpload(id, item);
  }
  private startUpload(id: string, item: Item) {
    void upload(item.source).then(
      file => this.update(id, item.key, { file }),
      error => this.update(id, item.key, { error: String(error?.message || error) }));
  }
  private update(id: string, key: string, patch: Partial<Pending>) {
    const snapshot = this.get(id);
    if (!snapshot.items.some(item => item.key === key)) return;
    this.publish(id, { ...snapshot, items: snapshot.items.map(item => item.key === key ? { ...item, ...patch } : item) });
    this.persist(id);
  }
  remove(id: string | undefined, keys: string[]) {
    if (!id) return;
    const snapshot = this.get(id);
    for (const item of snapshot.items) if (keys.includes(item.key) && item.preview) URL.revokeObjectURL(item.preview);
    this.publish(id, { ...snapshot, items: snapshot.items.filter(item => !keys.includes(item.key)) });
    this.persist(id);
  }
}
export const attachmentDrafts = new AttachmentDrafts();
