import { useMemo, useState } from 'react';
import { T } from '../i18n';
import { Chevron, CopyButton, Disclosure } from './Output';

/** One file of a ``ga-file-changes`` note's ``data`` (built by that plugin's ``detail``). */
interface FileChange {
  path: string; display?: string; action?: string; count?: number; added?: number; removed?: number;
  /** Unified hunks with their ``@@`` lines and no file headers. */
  diff?: string; truncated?: boolean; skipped?: string;
}
export interface FilesData {
  base?: string | null; files: FileChange[]; more?: number;
  /** List height cap in px (0 = none) and the file count above which the note starts folded. */
  max_height?: number; collapse_after?: number;
}
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

function FileDiff({ f, force }: { f: FileChange; force?: boolean }) {
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
  return <Disclosure className="fc-file" chevron="start" title={title} initial={force ?? false}>
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

/** ``files`` note with data: a foldable list (height-capped) of per-file disclosures with
 * numbered unified diffs, plus an expand/collapse-all switch for the files. */
export function FileChanges({ data, label }: { data: FilesData; label: string }) {
  const { files, more = 0 } = data, total = files.length + more;
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0), removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const height = Math.max(0, Number(data.max_height ?? 420) || 0);
  const [open, setOpen] = useState(files.length <= Math.max(0, Number(data.collapse_after ?? 0) || 0));
  // Files start folded; ``all`` overrides that and ``gen`` remounts them so manual toggles reset too.
  // Folding the list only hides it, so each file keeps its own open state across folds.
  const [all, setAll] = useState<boolean | undefined>(undefined), [gen, setGen] = useState(0);
  const expanded = all ?? false;
  const toggleAll = () => { setAll(!expanded); setGen(g => g + 1); setOpen(true); };
  const style = height ? { maxHeight: height + 'px', ['--fc-max' as string]: height + 'px' } : undefined;
  return <div className={'msg-note files fc' + (open ? ' open' : '')}>
    <div className="note-kind fc-top">
      <button type="button" className="fc-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}
        title={open ? T('收起修改的文件', 'Collapse changed files') : T('展开修改的文件', 'Expand changed files')}>
        <Chevron /><span>{label} {'\u00b7'} {T(`${total} 个文件`, `${total} file(s)`)}</span> <Stat added={added} removed={removed} />
      </button>
      {files.length > 1 && <button type="button" className="fc-all" onClick={toggleAll}>
        {open && expanded ? T('全部收起', 'Collapse all') : T('全部展开', 'Expand all')}
      </button>}
    </div>
    <div className={'note-body fc-list' + (height ? ' capped' : '')} style={style} hidden={!open}>
      {files.map(f => <FileDiff key={f.path + ':' + gen} f={f} force={all} />)}
      {more > 0 && <div className="fc-msg">{T(`还有 ${more} 个文件未列出`, `${more} more file(s) not listed`)}</div>}
    </div>
  </div>;
}
