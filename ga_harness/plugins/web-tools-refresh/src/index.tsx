import { useEffect, useState } from 'react';
import { useHost, T, defineReact, type PluginAPI } from '@gah/sdk';

const Icon = () => (
  <svg className="gah-tr-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 2.5v3h-3" />
  </svg>
);

function RefreshButton({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const [busy, setBusy] = useState(false);
  const sid = state.session_id;
  if (!sid) return null;
  const send = async () => {
    if (busy || state.running) return;
    setBusy(true); api.notice();
    try { await api.host.post('/api/run', { task: '/tools', session_id: sid, attachments: [] }); }
    catch (error) { api.notice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <button type="button" className="gah-tr-pill" disabled={busy || state.running} onClick={send}
      title={T('\u91cd\u65b0\u5b8c\u6574\u6ce8\u5165\u5de5\u5177\u5b9a\u4e49\u5e76\u7ee7\u7eed\u4efb\u52a1\uff08\u6a21\u578b\u628a\u5de5\u5177\u8c03\u7528\u5199\u8fdb\u6b63\u6587\u65f6\u4f7f\u7528\uff09',
        'Resend the full tool definitions and continue (use when the model writes tool calls as text)')}>
      <Icon /><span>{T('\u5de5\u5177', 'Tools')}</span>
    </button>
  );
}

function ToolsRefreshPlugin({ api }: { api: PluginAPI }) {
  useEffect(() => api.mount('composer', <RefreshButton api={api} />), [api]);
  return null;
}

defineReact('web-tools-refresh', ToolsRefreshPlugin);
