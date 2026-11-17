// Run only on a disposable macOS VM. Exercises the delivered app via its main-process inspector.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const appPath = process.argv[2];
const out = path.resolve(process.argv[3] || 'runtime-evidence');
fs.mkdirSync(out, { recursive: true });
const report = { appPath, environment: {}, cases: [], limitations: [
  'No real logout/login or reboot: --hidden exercises the hidden-start path only.',
  'Accessory mode is deliberately injected; this does not identify the original downgrade or restart-loop cause.',
  'Activation events exercise the Dock/tray common handler, not a physical tray-menu click or Cmd-Tab keystroke.',
] };
function cmd(exe, args = []) {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
report.environment.swVers = cmd('sw_vers');
report.environment.arch = cmd('uname', ['-m']);
report.environment.console = cmd('stat', ['-f', '%Su', '/dev/console']);
report.environment.gui = cmd('launchctl', ['print', `gui/${process.getuid()}`]).status;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, ms = 45000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(400);
  }
  throw new Error(`wait timed out: ${last?.message || 'condition remained false'}`);
}
function save() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
class Inspector {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data); const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const stateExpr = `(() => { const {app,BrowserWindow}=globalThis.__docktest; return {
  pid:process.pid, packaged:app.isPackaged, version:app.getVersion(), ready:app.isReady(),
  dockVisible:app.dock.isVisible(), login:app.getLoginItemSettings(),
  windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),title:w.getTitle(),
    url:w.webContents.getURL().split('?')[0],loading:w.webContents.isLoading(),destroyed:w.isDestroyed()}))
}; })()`;
let failed = false;
for (const hidden of [false, true]) {
  const result = { name: hidden ? 'hidden-argument-launch' : 'normal-launch', checks: [] };
  report.cases.push(result);
  let c, appPid, launcher, log;
  try {
    log = fs.openSync(path.join(out, `${result.name}.log`), 'w');
    launcher = spawn('/usr/bin/open', ['-n', '-W', appPath, '--args', '--inspect=127.0.0.1:9229', ...(hidden ? ['--hidden'] : [])], { stdio: ['ignore', log, log] });
    const target = await wait(async () => {
      const r = await fetch('http://127.0.0.1:9229/json/list'); const a = await r.json(); return a[0];
    });
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    c = new Inspector(ws);
    await c.eval(`globalThis.__docktest=process.mainModule.require('electron'); true`);
    appPid = await c.eval('process.pid');
    assert.equal(await c.eval('process.arch'), 'arm64');
    const initial = await wait(async () => {
      const s = await c.eval(stateExpr);
      return s.ready && s.windows.some(w => w.url.startsWith('http://127.0.0.1:') && !w.loading) && s;
    }, 120000);
    result.initial = initial;
    assert.equal(initial.packaged, true);
    assert.equal(initial.version, '0.0.46-dockfix.1');
    assert.equal(initial.dockVisible, true);
    assert.equal(initial.windows[0].visible, !hidden);
    async function osType(label, expected) {
      const found = cmd('/usr/bin/lsappinfo', ['find', `pid=${appPid}`]);
      assert.equal(found.status, 0, JSON.stringify(found));
      const asn = found.stdout.trim().split(/\s+/)[0];
      assert.ok(asn.startsWith('ASN:'), JSON.stringify(found));
      const info = cmd('/usr/bin/lsappinfo', ['info', '-only', 'ApplicationType', asn]);
      result.checks.push({ label, expected, asn, info, state: await c.eval(stateExpr) });
      assert.equal(info.status, 0, JSON.stringify(info));
      assert.ok(info.stdout.includes(expected), `${label}: expected ${expected}, got ${info.stdout}`);
    }
    await osType('initial-system-identity', 'Foreground');
    const content = await c.eval(`globalThis.__docktest.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('({title:document.title,bodyLength:document.body.innerText.length})')`);
    result.page = content;
    assert.ok(content.bodyLength > 30, JSON.stringify(content));
    if (!hidden) {
      result.autostart = await c.eval(`(() => {
        const a=process.mainModule.require(process.mainModule.require('node:path').join(globalThis.__docktest.app.getAppPath(),'src/autostart.js'));
        try { const enabled=a.setEnabled(true); return {supported:a.supported(),enabled,settings:globalThis.__docktest.app.getLoginItemSettings()}; }
        finally { a.setEnabled(false); }
      })()`);
      assert.equal(result.autostart.supported, true);
      assert.equal(result.autostart.enabled, true);
      assert.equal(await c.eval('globalThis.__docktest.app.getLoginItemSettings().openAtLogin'), false);
    }
    await c.eval(`globalThis.__docktest.BrowserWindow.getAllWindows()[0].close(); true`);
    await wait(async () => !(await c.eval(stateExpr)).windows[0].visible);
    await osType('close-to-tray-retains-identity', 'Foreground');
    // Create the exact bad app identity, not a JavaScript stub.
    await c.eval(`globalThis.__docktest.app.setActivationPolicy('accessory'); globalThis.__docktest.app.dock.hide(); true`);
    await sleep(1500);
    await osType('injected-accessory-negative-control', 'UIElement');
    assert.equal((await c.eval(stateExpr)).dockVisible, false);
    // A second OS-launched instance must route through the existing single-instance showWindow handler.
    const second = cmd('/usr/bin/open', ['-n', appPath]);
    assert.equal(second.status, 0, JSON.stringify(second));
    await wait(async () => { const s=await c.eval(stateExpr); return s.dockVisible && s.windows[0].visible; });
    await sleep(1000);
    await osType('second-instance-recovers-accessory', 'Foreground');
    // Exercise the activate event used by a Dock click and the shared showWindow path.
    await c.eval(`globalThis.__docktest.BrowserWindow.getAllWindows()[0].hide(); globalThis.__docktest.app.setActivationPolicy('accessory'); globalThis.__docktest.app.dock.hide(); true`);
    await sleep(800);
    await osType('second-accessory-negative-control', 'UIElement');
    await c.eval(`globalThis.__docktest.app.emit('activate'); true`);
    await wait(async () => { const s=await c.eval(stateExpr); return s.dockVisible && s.windows[0].visible; });
    await sleep(1000);
    await osType('activate-handler-recovers-accessory', 'Foreground');
    // Direct BrowserWindow.show must trigger the new 'show' event guard too.
    await c.eval(`globalThis.__docktest.BrowserWindow.getAllWindows()[0].hide(); globalThis.__docktest.app.setActivationPolicy('accessory'); globalThis.__docktest.app.dock.hide(); true`);
    await sleep(800);
    await c.eval(`globalThis.__docktest.BrowserWindow.getAllWindows()[0].show(); true`);
    await wait(async () => (await c.eval(stateExpr)).dockVisible);
    await sleep(1000);
    await osType('window-show-event-recovers-accessory', 'Foreground');
    const image = path.join(out, `${result.name}-window.png`);
    await c.eval(`globalThis.__docktest.BrowserWindow.getAllWindows()[0].webContents.capturePage().then(i=>{process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(image)},i.toPNG());return true;})`);
    result.status = 'passed';
  } catch (e) {
    failed = true; result.status = 'failed'; result.error = e.stack || String(e); console.error(result.error);
  } finally {
    if (c) {
      try { await c.eval(`globalThis.__docktest.app.setLoginItemSettings({openAtLogin:false}); setTimeout(()=>globalThis.__docktest.app.quit(),100); true`); } catch {}
      c.close();
    }
    if (appPid) {
      try { await wait(() => cmd('ps', ['-p', String(appPid), '-o', 'pid=']).status !== 0, 20000); }
      catch { try { process.kill(appPid, 'SIGTERM'); } catch {} }
    }
    if (launcher && launcher.exitCode === null) launcher.kill('SIGTERM');
    if (log !== undefined) fs.closeSync(log);
    save();
    await sleep(1500);
  }
}
report.status = failed ? 'failed' : 'passed';
save();
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
