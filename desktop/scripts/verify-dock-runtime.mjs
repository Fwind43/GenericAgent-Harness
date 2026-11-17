// Run only on a disposable macOS VM. Each scenario gets a fresh application process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const appPath = process.argv[2];
const out = path.resolve(process.argv[3] || 'runtime-evidence');
const expectedVersion = process.argv[4] || '0.0.46-dockfix.2';
const smokeOnly = process.argv[5] === 'smoke';
const nodeReadyExpr = "typeof process !== 'undefined' && Number.isInteger(process.pid) && process.pid > 0";
fs.mkdirSync(out, { recursive: true });
const report = { appPath, environment: {}, cases: [], limitations: [
  'No real logout/login or reboot: --hidden exercises the hidden-start path only.',
  'Native all-workspaces calls test the Dock downgrade; the reported login restart-loop cause is not established.',
  'Fullscreen/Spaces visual placement is not verified; preserving Dock identity may affect fullscreen overlay behavior.',
  'Activation events exercise the Dock/tray common handler, not a physical tray-menu click or Cmd-Tab keystroke.',
  'Read-only event listeners and forwarding method wrappers record diagnostics after inspector attachment; pre-attachment events are not captured.',
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

// Injected into the real main process. Never remove listeners, suppress events or change results.
function installTrace(filename) {
  const { app, BrowserWindow } = globalThis.__docktest;
  const fs = process.mainModule.require('node:fs');
  const started = process.hrtime.bigint();
  let seq = 0;
  function state() {
    try {
      return { ready: app.isReady(), dockVisible: app.isReady() ? app.dock.isVisible() : null,
        windows: BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => ({
          id: w.id, visible: w.isVisible(), focused: w.isFocused(),
          url: w.webContents.getURL().split('?')[0],
        })) };
    } catch (e) { return { snapshotError: String(e) }; }
  }
  function record(kind, data = {}) {
    fs.appendFileSync(filename, JSON.stringify({ seq: ++seq, at: new Date().toISOString(),
      ms: Number(process.hrtime.bigint() - started) / 1e6, pid: process.pid,
      kind, ...data, state: state() }) + '\n');
  }
  const hooked = new WeakSet();
  function hookWindow(w) {
    if (hooked.has(w)) return;
    hooked.add(w);
    const windowId = w.id; // Native properties can throw after the closed event.
    for (const event of ['ready-to-show', 'show', 'hide', 'focus', 'blur', 'close', 'closed', 'restore', 'minimize']) {
      w.prependListener(event, () => record(`window:${event}`, { windowId }));
    }
    record('window:attached', { windowId });
  }
  for (const event of ['ready', 'activate', 'second-instance', 'browser-window-focus', 'browser-window-blur', 'before-quit', 'will-quit', 'quit']) {
    app.prependListener(event, () => record(`app:${event}`));
  }
  app.prependListener('browser-window-created', (_event, w) => hookWindow(w));
  BrowserWindow.getAllWindows().forEach(hookWindow);
  function wrap(obj, name, prefix) {
    const original = obj[name];
    if (typeof original !== 'function') throw new Error(`Cannot trace ${prefix}.${name}`);
    const wrapped = function (...args) {
      record(`call:${prefix}.${name}`, { windowId: this instanceof BrowserWindow ? this.id : undefined,
        args, stack: new Error().stack.split('\n').slice(2, 9) });
      try {
        const result = Reflect.apply(original, this, args);
        record(`return:${prefix}.${name}`);
        return result;
      } catch (error) { record(`throw:${prefix}.${name}`, { error: String(error) }); throw error; }
    };
    obj[name] = wrapped;
    if (obj[name] !== wrapped) throw new Error(`Cannot install trace ${prefix}.${name}`);
  }
  wrap(app, 'setActivationPolicy', 'app');
  for (const name of ['show', 'hide']) wrap(app.dock, name, 'dock');
  for (const name of ['show', 'hide', 'close', 'focus', 'setVisibleOnAllWorkspaces']) wrap(BrowserWindow.prototype, name, 'window');
  globalThis.__docktrace = { record };
  record('trace:installed');
  return true;
}

const stateExpr = `(() => { const {app,BrowserWindow}=globalThis.__docktest; return {
  pid:process.pid, packaged:app.isPackaged, version:app.getVersion(), ready:app.isReady(),
  dockVisible:app.dock.isVisible(), login:app.getLoginItemSettings(),
  windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),title:w.getTitle(),
    url:w.webContents.getURL().split('?')[0],loading:w.webContents.isLoading(),destroyed:w.isDestroyed()}))
}; })()`;
const mainState = s => s.windows.find(w => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(w.url));
const islandState = s => s.windows.find(w => w.url.includes('/web/desktop-island/island.html'));
const scenarios = smokeOnly ? [{ hidden: false, action: 'smoke' }] : [false, true].flatMap(hidden => ['identity', 'activate', 'second-instance', 'window-show'].map(action => ({ hidden, action })));
const seenPids = new Set();
let failed = false;
for (const [index, { hidden, action }] of scenarios.entries()) {
  const result = { name: `${hidden ? 'hidden' : 'normal'}-${action}`, hidden, action, checks: [], status: 'running' };
  report.cases.push(result);
  const traceFile = path.join(out, `${result.name}-events.jsonl`);
  const port = 9229 + index;
  let c, appPid, launcher, log, cleanupOK = true;
  try {
    log = fs.openSync(path.join(out, `${result.name}.log`), 'w');
    launcher = spawn('/usr/bin/open', ['-n', '-W', appPath, '--args', `--inspect=127.0.0.1:${port}`, ...(hidden ? ['--hidden'] : [])], { stdio: ['ignore', log, log] });
    const target = await wait(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      const a = await r.json(); return a[0];
    });
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    c = new Inspector(ws);
    const bootstrapStarted = Date.now();
    await c.call('Runtime.enable', {});
    await c.call('Runtime.runIfWaitingForDebugger', {});
    appPid = await wait(() => c.eval(`(${nodeReadyExpr}) && process.pid`));
    result.bootstrapWaitMs = Date.now() - bootstrapStarted;
    result.pid = appPid;
    assert.ok(!seenPids.has(appPid), 'A scenario reused a previous main process');
    seenPids.add(appPid);
    await wait(() => c.eval(`typeof process !== 'undefined' && typeof process.mainModule?.require === 'function'`));
    await c.eval(`globalThis.__docktest=process.mainModule.require('electron'); true`);
    await c.eval(`(${installTrace.toString()})(${JSON.stringify(traceFile)})`);
    async function mark(label) { await c.eval(`globalThis.__docktrace.record('test:marker',{label:${JSON.stringify(label)}}); true`); }
    await wait(() => c.eval('globalThis.__docktest.app.isReady()'));
    assert.equal(await c.eval('process.arch'), 'arm64');
    await wait(async () => {
      const s = await c.eval(stateExpr);
      return s.ready && mainState(s) && !mainState(s).loading && islandState(s) && !islandState(s).loading;
    }, 120000);
    await sleep(2000);
    const initial = await c.eval(stateExpr);
    await c.eval(`globalThis.__main=globalThis.__docktest.BrowserWindow.fromId(${mainState(initial).id}); globalThis.__island=globalThis.__docktest.BrowserWindow.fromId(${islandState(initial).id}); true`);
    result.initial = initial;
    assert.equal(initial.packaged, true);
    assert.equal(initial.version, expectedVersion);
    assert.equal(initial.dockVisible, true);
    assert.equal(mainState(initial).visible, !hidden);
    async function osType(label, expected, visible) {
      await mark(`check:${label}`);
      const found = cmd('/usr/bin/lsappinfo', ['find', `pid=${appPid}`]);
      assert.equal(found.status, 0, JSON.stringify(found));
      const asn = found.stdout.trim().split(/\s+/)[0];
      assert.ok(asn.startsWith('ASN:'), JSON.stringify(found));
      const info = cmd('/usr/bin/lsappinfo', ['info', '-only', 'ApplicationType', asn]);
      const state = await c.eval(stateExpr);
      result.checks.push({ label, expected, asn, info, state });
      save();
      assert.equal(info.status, 0, JSON.stringify(info));
      assert.ok(info.stdout.includes(`"ApplicationType"="${expected}"`), `${label}: expected ${expected}, got ${info.stdout}`);
      assert.equal(state.dockVisible, expected === 'Foreground', `${label}: Dock visibility`);
      assert.equal(mainState(state).visible, visible, `${label}: main window visibility`);
    }
    await osType('initial-system-identity', 'Foreground', !hidden);
    result.page = await c.eval(`globalThis.__main.webContents.executeJavaScript('({title:document.title,bodyLength:document.body.innerText.length})')`);
    assert.ok(result.page.bodyLength > 30, JSON.stringify(result.page));
    if (action === 'smoke') {
      result.status = 'passed';
      continue; // The finally block must prove clean exit before CI starts the matrix.
    }
    if (action === 'identity' && !hidden) {
      await mark('toggle-login-registration');
      result.autostart = await c.eval(`(() => {
        const a=process.mainModule.require(process.mainModule.require('node:path').join(globalThis.__docktest.app.getAppPath(),'src/autostart.js'));
        try { const enabled=a.setEnabled(true); return {supported:a.supported(),enabled,settings:globalThis.__docktest.app.getLoginItemSettings()}; }
        finally { a.setEnabled(false); }
      })()`);
      assert.equal(result.autostart.supported, true);
      assert.equal(result.autostart.enabled, true);
      assert.equal(await c.eval('globalThis.__docktest.app.getLoginItemSettings().openAtLogin'), false);
    }
    await mark('close-main');
    await c.eval('globalThis.__main.close(); true');
    await wait(async () => !mainState(await c.eval(stateExpr)).visible);
    await sleep(2000); // Settle close and Electron's 1s DockShow suppression interval.
    await osType('close-to-tray-retains-identity', 'Foreground', false);
    if (action === 'identity') {
      for (let repeat = 1; repeat <= 2; repeat++) {
        await mark(`patched-workspaces-${repeat}`);
        await c.eval('globalThis.__island.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true}); true');
        await sleep(2000);
        await osType(`patched-workspaces-retains-identity-${repeat}`, 'Foreground', false);
      }
    } else {
      // Exactly one downgrade per cold process. Keep the negative control strict.
      await mark('unpatched-workspaces-negative-control');
      await c.eval('globalThis.__island.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); true');
      result.immediateAfterDowngrade = await c.eval(stateExpr);
      await sleep(2000);
      await osType(`${action}-negative-control`, 'UIElement', false);
      await mark(`trigger:${action}`);
      if (action === 'second-instance') {
        result.secondOpen = cmd('/usr/bin/open', ['-n', appPath]);
        assert.equal(result.secondOpen.status, 0, JSON.stringify(result.secondOpen));
      } else if (action === 'activate') {
        await c.eval("globalThis.__docktest.app.emit('activate'); true");
      } else {
        await c.eval('globalThis.__main.show(); true');
      }
      await wait(async () => { const s=await c.eval(stateExpr); return s.dockVisible && mainState(s).visible; });
      await sleep(2000);
      await osType(`${action}-recovers-accessory`, 'Foreground', true);
      const events = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const marker = events.findLast(e => e.kind === 'test:marker' && e.label === `trigger:${action}`);
      const expectedEvent = action === 'window-show' ? 'window:show' : `app:${action}`;
      assert.ok(events.some(e => e.seq > marker.seq && e.kind === expectedEvent && (action !== 'window-show' || e.windowId === mainState(initial).id)), `Missing event ${expectedEvent}`);
      const image = path.join(out, `${result.name}-window.png`);
      await c.eval(`globalThis.__main.webContents.capturePage().then(i=>{process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(image)},i.toPNG());return true;})`);
    }
    result.status = 'passed';
  } catch (e) {
    failed = true; result.status = 'failed'; result.error = e.stack || String(e); console.error(result.name, result.error);
  } finally {
    if (c) {
      try { result.finalState = await c.eval(stateExpr); } catch (e) { result.finalStateError = String(e); }
      try {
        await c.eval(`globalThis.__docktrace?.record('test:cleanup'); globalThis.__docktest.app.setLoginItemSettings({openAtLogin:false}); setTimeout(()=>globalThis.__docktest.app.quit(),100); true`);
      } catch (e) { result.quitError = String(e); }
      c.close();
    }
    if (appPid) {
      try { await wait(() => cmd('ps', ['-p', String(appPid), '-o', 'pid=']).status === 1, 30000); }
      catch (e) {
        cleanupOK = false; failed = true; result.status = 'failed'; result.cleanupError = String(e);
        // Only the exact PID launched by this test; never kill a pre-existing application.
        try { process.kill(appPid, 'SIGTERM'); } catch {}
      }
    } else {
      cleanupOK = false; failed = true; result.cleanupError = 'No main PID established; refusing to launch another scenario.';
    }
    if (launcher && launcher.exitCode === null) launcher.kill('SIGTERM');
    if (log !== undefined) fs.closeSync(log);
    if (fs.existsSync(traceFile)) {
      const events = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      result.trace = { file: path.basename(traceFile), count: events.length, tail: events.slice(-30) };
    }
    result.cleanupOK = cleanupOK;
    save();
    await sleep(1500);
  }
  if (!cleanupOK) break; // Failed isolation must not contaminate another case.
}
report.expectedCases = scenarios.length;
report.status = failed || report.cases.length !== scenarios.length ? 'failed' : 'passed';
save();
console.log(JSON.stringify({ status: report.status, expectedCases: report.expectedCases,
  cases: report.cases.map(({ name, status, error, cleanupOK }) => ({ name, status, error, cleanupOK })) }, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
