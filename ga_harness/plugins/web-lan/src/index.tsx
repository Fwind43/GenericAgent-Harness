import { useEffect, useState } from 'react';
import { type PluginAPI, useHost, T, SettingsPanel, useOperation, confirmDialog, defineReact, QrCode, copyText } from '@gah/sdk';

// LAN access panel backed by main.py (TCP forwarder on a LAN IPv4, private peers only).
const ANY = '0.0.0.0';
type LanInfo = { ips: string[]; binds: string[]; hosts: string[]; fixed: boolean; hostname?: string; error?: string };
type Status = {
  active: boolean; enabled: boolean; urls: string[]; entries: string[]; error: string;
  token_required: boolean; web_port?: number; port?: number; lan: LanInfo;
  reconnecting?: boolean; retry_in?: number; restarts?: number;
};

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
  const reconnecting = !!data?.reconnecting;
  const resetToken = async () => {
    if (!(await confirmDialog({ title: T('重置访问 token', 'Reset access token'), danger: true,
      message: T('旧链接和所有已登录的设备都会失效，需要用新链接重新打开。继续？',
        'Old links and every signed-in device will stop working until reopened with the new link. Continue?') }))) return;
    void act('reset_token');
  };
  const lan = data?.lan;
  const chosen = lan?.fixed ? lan.binds[0] || '' : (bind && (bind === ANY || lan?.ips.includes(bind)) ? bind : lan?.binds[0] || '');
  const entries = data?.entries || [], urls = data?.urls || [];
  const index = Math.min(pick, Math.max(entries.length - 1, 0));
  const entry = entries[index] || '';
  const state = !data ? T('加载中…', 'Loading…')
    : data.active ? T('转发中', 'Forwarding')
    : data.reconnecting ? T(`正在自动重连${data.retry_in ? `（${data.retry_in} 秒后重试）` : '…'}`,
      `Reconnecting automatically${data.retry_in ? ` (retry in ${data.retry_in}s)` : '…'}`)
    : !chosen ? T('未找到局域网地址', 'No LAN address')
    : T('未开启', 'Off');
  return <SettingsPanel api={api} label={T('局域网访问', 'LAN access')} icon="globe" order={41} className="ts-dialog" onOpen={load}>
    <Poll api={api} fast={reconnecting} onData={setData} />
    <div className="dialog-head ts-head"><div>
      <h2>{T('局域网', 'LAN')}</h2>
      <p>{T('让同一 Wi-Fi / 局域网内的手机或电脑访问本机网页界面；只监听所选局域网 IP，仅放行内网地址，强制 token。',
        'Open this web UI from phones or computers on the same Wi-Fi/LAN. Listens on the chosen LAN IP, admits private addresses only; a token is always required.')}</p>
    </div><button type="button" className="btn" disabled={busy} onClick={() => void load()}>{T('刷新', 'Refresh')}</button></div>
    <div className="ts-body">
      <section className="ts-card">
        <div className="ts-row"><span className={`ts-dot${data?.active ? ' on' : reconnecting ? ' wait' : ''}`} /><b>{state}</b>
          <span className="ts-spacer" />
          {data?.active || reconnecting
            ? <button type="button" className="btn" disabled={busy} onClick={() => void act('stop')}>{reconnecting ? T('停止重试', 'Stop retrying') : T('停止', 'Stop')}</button>
            : <button type="button" className="btn primary" disabled={busy || !chosen} onClick={() => void act('start', lan?.fixed ? {} : { bind: chosen })}>{T('开启局域网访问', 'Enable LAN access')}</button>}
        </div>
        {lan && <dl className="ts-meta">
          {lan.hostname && <><dt>{T('设备', 'Device')}</dt><dd>{lan.hostname}</dd></>}
          {lan.ips.length > 0 && <><dt>{T('局域网 IP', 'LAN IP')}</dt><dd>
            {data?.active || lan.fixed ? <>{(data?.active ? urls.map(u => u.replace(/^http:\/\/|:\d+\/?$/g, '')) : lan.hosts).join(' · ')}
                {lan.binds[0] === ANY && <small className="ts-note">{T('（监听 0.0.0.0，所有网卡）', ' (listening on 0.0.0.0, all interfaces)')}</small>}</>
              : <select className="ts-select" value={chosen} disabled={busy} onChange={e => setBind(e.target.value)}>
                {lan.ips.map(ip => <option key={ip} value={ip}>{ip}</option>)}
                <option value={ANY}>{T('0.0.0.0（所有网卡）', '0.0.0.0 (all interfaces)')}</option></select>}
          </dd></>}
          {!!data?.restarts && <><dt>{T('自动恢复', 'Auto-recovered')}</dt><dd>{T(`${data.restarts} 次`, `${data.restarts}×`)}</dd></>}
          {data?.port && <><dt>{T('端口', 'Port')}</dt><dd>{data.port}{data.web_port && data.port !== data.web_port ? ` → 127.0.0.1:${data.web_port}` : ''}</dd></>}
        </dl>}
        {chosen === ANY && !data?.active && !lan?.fixed && <p className="ts-hint">{T('监听所有网卡（含虚拟网卡）；仍只放行内网来源。',
          'Listens on every interface (virtual ones included); only private peers are still admitted.')}</p>}
        {(error || data?.error || lan?.error) && <p className="ts-error">{error || data?.error || lan?.error}</p>}
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
          <small>{T('用同一局域网内的设备扫码或打开链接；链接含 token，请勿外传。若打不开，检查系统防火墙是否放行该端口。',
            'Scan or open from a device on the same LAN. The link contains the token; do not share it. If it does not load, allow the port in the OS firewall.')}</small>
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

defineReact('web-lan', LanPanel);
