import type { Attachment } from '../types';
import { T } from '../i18n';

export const MAX_FILE = 50 << 20;
export const MAX_FILES = 20;
export interface Pending { key: string; name: string; size: number; image: boolean; preview?: string; file?: Attachment; error?: string }

export function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

/** Raw-body upload; the server returns the descriptor a run later references. */
export async function upload(file: File): Promise<Attachment> {
  const response = await fetch('/api/upload', {
    method: 'POST', body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'file') },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.file) throw new Error(data.error || `HTTP ${response.status}`);
  return data.file as Attachment;
}

const VISION = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export function pendingOf(file: File): Pending {
  const image = VISION.has(file.type);
  return { key: Math.random().toString(36).slice(2), name: file.name || 'file', size: file.size, image,
    preview: image ? URL.createObjectURL(file) : undefined,
    error: file.size > MAX_FILE ? T('超过 50 MB', 'Over 50 MB') : file.size ? undefined : T('空文件', 'Empty file') };
}

export function PendingStrip({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return <div className="gah-attach-strip">{items.map(p => <div key={p.key}
      className={'gah-attach' + (p.image ? ' image' : '') + (p.error ? ' error' : !p.file ? ' uploading' : '')}
      title={p.error ? `${p.name} · ${p.error}` : `${p.name} · ${size(p.size)}`}>
    {p.preview ? <img src={p.preview} alt="" /> : <span className="gah-attach-ico">📄</span>}
    {!p.image && <span className="gah-attach-name">{p.name}<small>{p.error || (p.file ? size(p.size) : T('上传中…', 'Uploading…'))}</small></span>}
    <button type="button" className="gah-attach-x" aria-label={T('移除附件', 'Remove attachment')} onClick={() => onRemove(p.key)}>×</button>
  </div>)}</div>;
}

export function MessageAttachments({ items }: { items?: Attachment[] }) {
  if (!items?.length) return null;
  return <div className="gah-msg-attach">{items.map((a, i) => a.image
    ? <a key={i} href={a.url} target="_blank" rel="noreferrer" className="gah-msg-img" title={a.name}><img src={a.url} alt={a.name} loading="lazy" /></a>
    : <a key={i} href={a.url} download={a.name} className="gah-msg-file" title={a.name}><span>📄</span><span className="gah-attach-name">{a.name}<small>{size(a.size)}</small></span></a>)}</div>;
}
