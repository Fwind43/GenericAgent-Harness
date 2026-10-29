import { useState } from 'react';
import { type PluginAPI, useHost, T, SettingsPanel, useOperation, confirmDialog, defineReact } from '@gah/sdk';
import qrcode from 'qrcode-generator';

// LAN access panel backed by main.py (TCP forwarder on a LAN IPv4, private peers only).
type LanInfo = { ips: string[]; binds: string[]; fixed: boolean; hostname?: string; error?: string };
type Status = {
  active: boolean; enabled: boolean; urls: string[]; entries: string[]; error: string;
  token_required: boolean; web_port?: number; port?: number; lan: LanInfo;
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

export function LanPanel({ api }: { api: PluginAPI }) {
  const { changing } = useHost();
  const { working, run } = useOperation(api, true);
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(0);
  const [bind, setBind] = useState('');
  const busy = working || changing;
  const load = () => run(async () => { setError(''); setData(await api.get<Status>('')); }, setError, true);
  const act = (action: string, extra: Record<string, unknown> = {}) => run(async () => { setError(''); setData(await api.post<Status>('', { action, ...extra })); }, setError, true);
  const resetToken = async () => {
    if (!(await confirmDialog({ title: T('重置访问 token', 'Reset access token'), danger: true,
      message: T('旧链接和所有已登录的设备都会失效，需要用新链接重新打开。继续？',
        'Old links and every signed-in device will stop working until reopened with the new link. Continue?') }))) return;
    void act('reset_token');
  };
  const lan = data?.lan;
  const chosen = lan?.fixed ? lan.binds[0] || '' : (bind && lan?.ips.includes(bind) ? bind : lan?.binds[0] || '');
  const entries = data?.entries || [], urls = data?.urls || [];
  const index = Math.min(pick, Math.max(entries.length - 1, 0));
  const entry = entries[index] || '';
  const state = !data ? T('加载中…', 'Loading…')
    : data.active ? T('转发中', 'Forwarding')
    : !chosen ? T('未找到局域网地址', 'No LAN address')
    : T('未开启', 'Off');
  return <SettingsPanel api={api} label={T('局域网访问', 'LAN access')} icon="globe" order={41} className="ts-dialog" onOpen={load}>
    <div className="dialog-head ts-head"><div>
      <h2>{T('局域网', 'LAN')}</h2>
      <p>{T('让同一 Wi-Fi / 局域网内的手机或电脑访问本机网页界面；只监听所选局域网 IP，仅放行内网地址，强制 token。',
        'Open this web UI from phones or computers on the same Wi-Fi/LAN. Listens on the chosen LAN IP, admits private addresses only; a token is always required.')}</p>
    </div><button type="button" className="btn" disabled={busy} onClick={() => void load()}>{T('刷新', 'Refresh')}</button></div>
    <div className="ts-body">
      <section className="ts-card">
        <div className="ts-row"><span className={`ts-dot${data?.active ? ' on' : ''}`} /><b>{state}</b>
          <span className="ts-spacer" />
          {data?.active
            ? <button type="button" className="btn" disabled={busy} onClick={() => void act('stop')}>{T('停止', 'Stop')}</button>
            : <button type="button" className="btn primary" disabled={busy || !chosen} onClick={() => void act('start', lan?.fixed ? {} : { bind: chosen })}>{T('开启局域网访问', 'Enable LAN access')}</button>}
        </div>
        {lan && <dl className="ts-meta">
          {lan.hostname && <><dt>{T('设备', 'Device')}</dt><dd>{lan.hostname}</dd></>}
          {lan.ips.length > 0 && <><dt>{T('局域网 IP', 'LAN IP')}</dt><dd>
            {data?.active || lan.fixed || lan.ips.length < 2 ? (data?.active ? urls.map(u => u.replace(/^http:\/\/|:\d+\/?$/g, '')).join(' · ') : chosen || lan.ips.join(' · '))
              : <select className="ts-select" value={chosen} disabled={busy} onChange={e => setBind(e.target.value)}>
                {lan.ips.map(ip => <option key={ip} value={ip}>{ip}</option>)}</select>}
          </dd></>}
          {data?.port && <><dt>{T('端口', 'Port')}</dt><dd>{data.port}{data.web_port && data.port !== data.web_port ? ` → 127.0.0.1:${data.web_port}` : ''}</dd></>}
        </dl>}
        {(error || data?.error || lan?.error) && <p className="ts-error">{error || data?.error || lan?.error}</p>}
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
          <small>{T('用同一局域网内的设备扫码或打开链接；链接含 token，请勿外传。若打不开，检查系统防火墙是否放行该端口。',
            'Scan or open from a device on the same LAN. The link contains the token; do not share it. If it does not load, allow the port in the OS firewall.')}</small>
        </div>
      </section>}
    </div>
  </SettingsPanel>;
}

defineReact('web-lan', LanPanel);
