import { useEffect, useState } from 'react';
import { type PluginAPI, useHost, T, SettingsPanel, useOperation, confirmDialog, defineReact, QrCode, copyText } from '@gah/sdk';

// Tailscale/Headscale remote access panel backed by main.py (TCP forwarder on tailnet IPs).
type TsInfo = { installed: boolean; running: boolean; backend?: string; ips: string[]; dns?: string; hostname?: string; error?: string };
type Status = {
  active: boolean; enabled: boolean; urls: string[]; entries: string[]; error: string;
  token_required: boolean; web_port?: number; port?: number; tailscale: TsInfo;
  reconnecting?: boolean; retry_in?: number; restarts?: number;
};

export function TailscalePanel({ api }: { api: PluginAPI }) {
  const { changing } = useHost();
  const { working, run } = useOperation(api, true);
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(0);
  const busy = working || changing;
  const load = () => run(async () => { setError(''); setData(await api.get<Status>('')); }, setError, true);
  const act = (action: string) => run(async () => { setError(''); setData(await api.post<Status>('', { action })); }, setError, true);
  const reconnecting = !!data?.reconnecting;
  const resetToken = async () => {
    if (!(await confirmDialog({ title: T('重置访问 token', 'Reset access token'), danger: true,
      message: T('旧链接和所有已登录的设备都会失效，需要用新链接重新打开。继续？',
        'Old links and every signed-in device will stop working until reopened with the new link. Continue?') }))) return;
    void act('reset_token');
  };
  const ts = data?.tailscale;
  const entries = data?.entries || [], urls = data?.urls || [];
  const index = Math.min(pick, Math.max(entries.length - 1, 0));
  const entry = entries[index] || '';
  const state = !data ? T('加载中…', 'Loading…')
    : data.active ? T('转发中', 'Forwarding')
    : data.reconnecting ? T(`正在自动重连${data.retry_in ? `（${data.retry_in} 秒后重试）` : '…'}`,
      `Reconnecting automatically${data.retry_in ? ` (retry in ${data.retry_in}s)` : '…'}`)
    : !ts?.installed ? T('未找到 tailscale', 'tailscale not found')
    : !ts.running ? T(`Tailscale 未连接（${ts.backend || '未知'}）`, `Tailscale not connected (${ts.backend || 'unknown'})`)
    : T('未开启', 'Off');
  return <SettingsPanel api={api} label={T('远程访问', 'Remote access')} icon="globe" order={40} className="ts-dialog" onOpen={load}>
    <Poll api={api} fast={reconnecting} onData={setData} />
    <div className="dialog-head ts-head"><div>
      <h2>Tailscale</h2>
      <p>{T('通过 tailnet 从手机或其他电脑访问本机网页界面；只监听 tailnet IP，强制 token。',
        'Open this web UI from phones or other computers on your tailnet. Listens on tailnet IPs only; a token is always required.')}</p>
    </div><button type="button" className="btn" disabled={busy} onClick={() => void load()}>{T('刷新', 'Refresh')}</button></div>
    <div className="ts-body">
      <section className="ts-card">
        <div className="ts-row"><span className={`ts-dot${data?.active ? ' on' : reconnecting ? ' wait' : ''}`} /><b>{state}</b>
          <span className="ts-spacer" />
          {data?.active || reconnecting
            ? <button type="button" className="btn" disabled={busy} onClick={() => void act('stop')}>{reconnecting ? T('停止重试', 'Stop retrying') : T('停止', 'Stop')}</button>
            : <button type="button" className="btn primary" disabled={busy || !ts?.running} onClick={() => void act('start')}>{T('开启远程访问', 'Enable remote access')}</button>}
        </div>
        {ts && <dl className="ts-meta">
          {ts.hostname && <><dt>{T('设备', 'Device')}</dt><dd>{ts.hostname}</dd></>}
          {ts.dns && <><dt>MagicDNS</dt><dd>{ts.dns}</dd></>}
          {ts.ips.length > 0 && <><dt>Tailnet IP</dt><dd>{ts.ips.join(' · ')}</dd></>}
          {!!data?.restarts && <><dt>{T('自动恢复', 'Auto-recovered')}</dt><dd>{T(`${data.restarts} 次`, `${data.restarts}×`)}</dd></>}
          {data?.port && <><dt>{T('端口', 'Port')}</dt><dd>{data.port}{data.web_port && data.port !== data.web_port ? ` → 127.0.0.1:${data.web_port}` : ''}</dd></>}
        </dl>}
        {(error || data?.error) && <p className="ts-error">{error || data?.error}</p>}
      </section>
      {data?.active && entry && <section className="ts-card ts-entry">
        <QrCode value={entry} className="ts-qr" label={T('入口二维码', 'Entry QR code')} />
        <div className="ts-links">
          {urls.length > 1 && <div className="ts-tabs">{urls.map((u, i) =>
            <button type="button" key={u} className={`btn${i === index ? ' primary' : ''}`} onClick={() => setPick(i)}>{u.replace(/^http:\/\/|\/$/g, '')}</button>)}</div>}
          <code className="ts-url">{entry}</code>
          <div className="ts-actions">
            <button type="button" className="btn" onClick={() => void copyText(entry).then(ok => api.notice(ok ? T('已复制入口链接', 'Entry link copied') : T('复制失败', 'Copy failed')))}>{T('复制链接', 'Copy link')}</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void resetToken()}>{T('重置 token', 'Reset token')}</button>
          </div>
          <small>{T('用同一 tailnet 内的设备扫码或打开链接；链接含 token，请勿外传。',
            'Scan or open from a device on the same tailnet. The link contains the token; do not share it.')}</small>
        </div>
      </section>}
    </div>
  </SettingsPanel>;
}

// Rendered only while the panel is visible: poll quietly so self-healing (reconnect / rebind)
// shows up without pressing Refresh.
function Poll({ api, fast, onData }: { api: PluginAPI; fast: boolean; onData: (s: Status) => void }) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') api.get<Status>('').then(onData, () => undefined);
    }, fast ? 3000 : 15000);
    return () => window.clearInterval(timer);
  }, [api, fast, onData]);
  return null;
}

defineReact('web-tailscale', TailscalePanel);
