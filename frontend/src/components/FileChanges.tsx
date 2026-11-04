import { useMemo } from 'react';
import { T } from '../i18n';
import { CopyButton, Disclosure } from './Output';

/** One file of a ``ga-file-changes`` note's ``data`` (built by that plugin's ``detail``). */
interface FileChange {
  path: string; display?: string; action?: string; count?: number; added?: number; removed?: number;
  /** Unified hunks with their ``@@`` lines and no file headers. */
  diff?: string; truncated?: boolean; skipped?: string;
}
export interface FilesData { base?: string | null; files: FileChange[]; more?: number }
type Row = { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'; old?: number; new?: number; text: string };

/** The note's structured payload, or null for older notes that only carry ``text``. */
export function filesData(data: unknown): FilesData | null {
  const d = data as FilesData | null;
  return d && typeof d === 'object' && Array.isArray(d.files) && d.files.length ? d : null;
}
const SKIPPED: Record<string, () => string> = {
  binary: () => T('二进制文件，不显示差异', 'Binary file; no diff shown'),
  large: () => T('文件太大，不显示差异', 'File too large to diff'),
  unreadable: () => T('无法读取改动前后的内容', 'Contents before or after the change are unavailable'),
};
/** Number the unified-diff lines like a gutter: old line, new line. */
function parse(diff: string): Row[] {
  const rows: Row[] = [];
  let a = 0, b = 0;
  for (const line of diff ? diff.replace(/\n$/, '').split('\n') : []) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { a = +hunk[1]; b = +hunk[2]; rows.push({ kind: 'hunk', text: line }); }
    else if (line[0] === '+') rows.push({ kind: 'add', new: b++, text: line.slice(1) });
    else if (line[0] === '-') rows.push({ kind: 'del', old: a++, text: line.slice(1) });
    else if (line[0] === '\\') rows.push({ kind: 'meta', text: line });
    else rows.push({ kind: 'ctx', old: a++, new: b++, text: line.slice(1) });
  }
  return rows;
}
const Stat = ({ added = 0, removed = 0 }: { added?: number; removed?: number }) =>
  <span className="fc-stat"><span className="fc-add">+{added}</span><span className="fc-del">-{removed}</span></span>;

function FileDiff({ f, open }: { f: FileChange; open: boolean }) {
  const rows = useMemo(() => parse(f.diff || ''), [f.diff]);
  const width = String(rows.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0)).length + 1 + 'ch';
  const created = f.action === 'created', count = f.count ?? 0;
  const title = <span className="fc-head">
    <span className={'fc-action' + (created ? ' created' : '')}>{created ? T('新建', 'New') : T('修改', 'Edit')}</span>
    <span className="fc-path" title={f.path}>{f.display || f.path}</span>
    {count > 1 && <span className="fc-count" title={T(`本次运行写入 ${count} 次`, `Written ${count} times in this run`)}>{'\u00d7' + count}</span>}
    {!f.skipped && <Stat added={f.added} removed={f.removed} />}
  </span>;
  const message = f.skipped ? SKIPPED[f.skipped]?.() ?? f.skipped : rows.length ? '' : T('内容没有变化', 'No content change');
  return <Disclosure className="fc-file" chevron="start" title={title} initial={open && rows.length > 0 && rows.length <= 60}>
    {message ? <div className="fc-msg">{message}</div> : <div className="fc-body">
      <div className="fc-tools"><CopyButton text={f.diff || ''} label={T('复制差异', 'Copy diff')} /></div>
      <div className="fc-diff">{rows.map((r, i) => <div key={i} className={'fc-row ' + r.kind}>
        {r.kind === 'hunk' || r.kind === 'meta' ? <span className="fc-code">{r.text}</span> : <>
          <span className="fc-ln" style={{ width }}>{r.old ?? ''}</span>
          <span className="fc-ln" style={{ width }}>{r.new ?? ''}</span>
          <span className="fc-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
          <span className="fc-code">{r.text}</span>
        </>}
      </div>)}</div>
      {f.truncated && <div className="fc-msg">{T('差异过长，其余部分已省略', 'Diff truncated')}</div>}
    </div>}
  </Disclosure>;
}

/** ``files`` note with data: one disclosure per file holding its numbered unified diff. */
export function FileChanges({ data, label }: { data: FilesData; label: string }) {
  const { files, more = 0 } = data, total = files.length + more;
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0), removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  return <div className="msg-note files fc">
    <span className="note-kind">{label} {'\u00b7'} {T(`${total} 个文件`, `${total} file(s)`)} <Stat added={added} removed={removed} /></span>
    <div className="note-body fc-list">
      {files.map(f => <FileDiff key={f.path} f={f} open={files.length <= 3} />)}
      {more > 0 && <div className="fc-msg">{T(`还有 ${more} 个文件未列出`, `${more} more file(s) not listed`)}</div>}
    </div>
  </div>;
}
