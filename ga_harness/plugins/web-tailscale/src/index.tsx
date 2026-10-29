import { useState } from 'react';
import { type PluginAPI, useHost, T, SettingsPanel, useOperation, confirmDialog, defineReact } from '@gah/sdk';
import qrcode from 'qrcode-generator';

// Tailscale/Headscale remote access panel backed by main.py (TCP forwarder on tailnet IPs).
type TsInfo = { installed: boolean; running: boolean; backend?: string; ips: string[]; dns?: string; hostname?: string; error?: string };
type Status = {
  active: boolean; enabled: boolean; urls: string[]; entries: string[]; error: string;
  token_required: boolean; web_port?: number; port?: number; tailscale: TsInfo;
};

function QrCode({ value }: { value: string }) {
  const code = qrcode(0, 'M');
  code.addData(value); code.make();
  const n = code.getModuleCount(), cells: string[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (code.isDark(y, x)) cells.push(`M${x + 2} ${y + 2}h1v1h-1z`);
  return <svg className="ts-qr" viewBox={`0 0 ${n + 4} ${n + 4}`} role="img" aria-label={T('入口二维码', 'Entry QR code')} shapeRendering="crispEdges">
    <rect width={n + 4} height={n + 4} fill="#fff" /><path d={cells.join('')} fill="#000" />
  </svg>;
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context */ }
  const area = document.createElement('textarea');
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select();
  const ok = document.execCommand('copy'); area.remove();
  return ok;
}

export function TailscalePanel({ api }: { api: PluginAPI }) {
  const { changing } = useHost();
  const { working, run } = useOperation(api, true);
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(0);
  const busy = working || changing;
  const load = () => run(async () => { setError(''); setData(await api.get<Status>('')); }, setError, true);
  const act = (action: string) => run(async () => { setError(''); setData(await api.post<Status>('', { action })); }, setError, true);
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
    : !ts?.installed ? T('未找到 tailscale', 'tailscale not found')
    : !ts.running ? T(`Tailscale 未连接（${ts.backend || '未知'}）`, `Tailscale not connected (${ts.backend || 'unknown'})`)
    : T('未开启', 'Off');
  return <SettingsPanel api={api} label={T('远程访问', 'Remote access')} icon="globe" order={40} className="ts-dialog" onOpen={load}>
    <div className="dialog-head ts-head"><div>
      <h2>Tailscale</h2>
      <p>{T('通过 tailnet 从手机或其他电脑访问本机网页界面；只监听 tailnet IP，强制 token。',
        'Open this web UI from phones or other computers on your tailnet. Listens on tailnet IPs only; a token is always required.')}</p>
    </div><button type="button" className="btn" disabled={busy} onClick={() => void load()}>{T('刷新', 'Refresh')}</button></div>
    <div className="ts-body">
      <section className="ts-card">
        <div className="ts-row"><span className={`ts-dot${data?.active ? ' on' : ''}`} /><b>{state}</b>
          <span className="ts-spacer" />
          {data?.active
            ? <button type="button" className="btn" disabled={busy} onClick={() => void act('stop')}>{T('停止', 'Stop')}</button>
            : <button type="button" className="btn primary" disabled={busy || !ts?.running} onClick={() => void act('start')}>{T('开启远程访问', 'Enable remote access')}</button>}
        </div>
        {ts && <dl className="ts-meta">
          {ts.hostname && <><dt>{T('设备', 'Device')}</dt><dd>{ts.hostname}</dd></>}
          {ts.dns && <><dt>MagicDNS</dt><dd>{ts.dns}</dd></>}
          {ts.ips.length > 0 && <><dt>Tailnet IP</dt><dd>{ts.ips.join(' · ')}</dd></>}
          {data?.port && <><dt>{T('端口', 'Port')}</dt><dd>{data.port}{data.web_port && data.port !== data.web_port ? ` → 127.0.0.1:${data.web_port}` : ''}</dd></>}
        </dl>}
        {(error || data?.error) && <p className="ts-error">{error || data?.error}</p>}
      </section>
      {data?.active && entry && <section className="ts-card ts-entry">
        <QrCode value={entry} />
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

defineReact('web-tailscale', TailscalePanel);
