import { useEffect, useState } from 'react';
import { useHost, T, defineReact, type PluginAPI } from '@gah/sdk';

const Icon = () => (
  <svg className="gah-tr-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 2.5v3h-3" />
  </svg>
);

function RefreshButton({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const [busy, setBusy] = useState(false);
  const sid = state.session_id;
  if (!sid) return null;
  const running = !!state.running;
  const send = async () => {
    if (busy || !running) return;
    setBusy(true); api.notice();
    try { await api.post('refresh', { session_id: sid }); }
    catch (error) { api.notice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <button type="button" role="menuitem" className="gah-menu-item" disabled={busy || !running} onClick={send}
      title={running
        ? T('\u8ba9\u6b63\u5728\u8fd0\u884c\u7684\u4efb\u52a1\u4e0b\u4e00\u6b21\u6a21\u578b\u8c03\u7528\u91cd\u65b0\u5b8c\u6574\u6ce8\u5165\u5de5\u5177\u5b9a\u4e49\uff0c\u4e0d\u53d1\u9001\u6d88\u606f\uff08\u6a21\u578b\u628a\u5de5\u5177\u8c03\u7528\u5199\u8fdb\u6b63\u6587\u65f6\u4f7f\u7528\uff09',
          'The running task\'s next model call resends the full tool definitions; no message is sent (use when the model writes tool calls as text)')
        : T('\u4ec5\u5728\u4efb\u52a1\u8fd0\u884c\u4e2d\u53ef\u7528\uff1b\u6bcf\u6b21\u65b0\u4efb\u52a1\u5f00\u59cb\u65f6\u672c\u6765\u5c31\u4f1a\u5b8c\u6574\u6ce8\u5165',
          'Only while a task is running; every new task already starts with the full definitions')}>
      <Icon /><span>{T('\u5237\u65b0\u5de5\u5177\u5b9a\u4e49', 'Refresh tool definitions')}</span>
    </button>
  );
}

function ToolsRefreshPlugin({ api }: { api: PluginAPI }) {
  useEffect(() => api.mount('composer-menu', <RefreshButton api={api} />), [api]);
  return null;
}

defineReact('web-tools-refresh', ToolsRefreshPlugin);
