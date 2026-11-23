import { useEffect, useState } from 'react';
import { useHost, T, defineReact, type PluginAPI } from '@gah/sdk';

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const Icon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    <path d="M7 1.8 8.3 5.7 12.2 7 8.3 8.3 7 12.2 5.7 8.3 1.8 7 5.7 5.7Z" /><path d="M12.6 10.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z" />
  </svg>
);

// "AI title" entry in the composer's session menu; retitles the current session.
function MenuItem({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const sid = state.session_id as string | undefined;
  const [busy, setBusy] = useState(false);
  if (!sid) return null;
  const generate = async () => {
    setBusy(true);
    try { await api.post('generate', { session_id: sid }); }
    catch (error) { api.notice(errText(error)); }
    finally { setBusy(false); }
  };
  return (
    <button type="button" role="menuitem" className="gah-menu-item" disabled={busy} onClick={() => void generate()}
      title={T('\u7528 AI \u4e3a\u5f53\u524d\u4f1a\u8bdd\u91cd\u65b0\u751f\u6210\u6807\u9898', 'Regenerate this session\'s title with AI')}>
      <Icon /><span>{busy ? T('\u6b63\u5728\u751f\u6210\u6807\u9898\u2026', 'Generating title\u2026') : T('AI \u751f\u6210\u6807\u9898', 'AI title')}</span>
    </button>
  );
}

function SessionTitlePlugin({ api }: { api: PluginAPI }) {
  useEffect(() => api.mount('composer-menu', <MenuItem api={api} />), [api]);
  return null;
}

defineReact('session-title', SessionTitlePlugin);
