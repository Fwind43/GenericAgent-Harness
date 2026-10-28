// One-click updates for the desktop shell.
//
// Every "v*" release carries:
//   update.json                      {"version", "min_shell", "app": {"file", "sha256", "size"}}
//   ga-harness-app-<version>.zip     the ga_harness package only (plugins, ui-web dist, ...)
//   installers + latest.yml / latest-linux.yml + *.blockmap (electron-updater, generic feed)
//
// Most releases only change code: when this shell is new enough (min_shell <= shell version)
// we download the small app bundle into <userData>/app/<version> and restart; backend.js
// prefers it over the code the installer shipped (and falls back if it fails to start).
// Otherwise the shell itself needs updating: Windows/Linux(AppImage) use electron-updater,
// unsigned macOS builds just open the release page.
//
// Downloads go to GitHub "releases/latest/download/<file>", optionally through a mirror set in
// desktop.json: {"update": {"mirror": "https://ghfast.top/", "auto_check": true}}. A mirror is a
// prefix ("https://ghfast.top/" + github URL) or a template containing "{url}".
'use strict';

const { app, dialog, net, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  appDir, compareVersions, editSettingsFile, parseVersion, readAppState, readCodeVersion,
  readSettingsFile, writeAppState,
} = require('./backend');

const REPO = 'Fwind43/GenericAgent-Harness';
const LATEST = `https://github.com/${REPO}/releases/latest/download`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MIRROR_PRESETS = [
  { label: 'GitHub (direct)', value: '' },
  { label: 'ghfast.top', value: 'https://ghfast.top/' },
  { label: 'gh-proxy.com', value: 'https://gh-proxy.com/' },
];
const AUTO_CHECK_DELAY = 15 * 1000;
const AUTO_CHECK_EVERY = 6 * 60 * 60 * 1000;

function mirrored(mirror, url) {
  const m = String(mirror || '').trim();
  if (!m) return url;
  if (m.includes('{url}')) return m.replace('{url}', url);
  return `${m.replace(/\/+$/, '')}/${url}`;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function fetchOk(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timed out: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-400)}`))));
  });
}

class Updater {
  // opts: { getBackend: () => Backend, getWindow: () => BrowserWindow|null,
  //         relaunch: () => void (restart the whole app), prepareQuit: async () => void }
  constructor(opts) {
    this.opts = opts;
    this.busy = false;
    this.timer = null;
    this.shellUpdater = undefined;   // lazily loaded electron-updater autoUpdater (or null)
    this.dismissed = null;           // version the user postponed during this session
  }

  get backend() { return this.opts.getBackend(); }
  get settingsFile() { return this.backend.settings.file; }

  config() {
    const u = readSettingsFile(this.settingsFile).update;
    const data = u && typeof u === 'object' ? u : {};
    return {
      mirror: typeof data.mirror === 'string' ? data.mirror : '',
      autoCheck: data.auto_check !== false,
    };
  }

  setConfig(patch) {
    editSettingsFile(this.settingsFile, (data) => {
      const u = data.update && typeof data.update === 'object' ? data.update : {};
      if (typeof patch.mirror === 'string') u.mirror = patch.mirror.trim();
      if (typeof patch.autoCheck === 'boolean') u.auto_check = patch.autoCheck;
      data.update = u;
    });
    this.schedule();
    return this.config();
  }

  url(file) { return mirrored(this.config().mirror, `${LATEST}/${file}`); }

  // Public status for the renderer bridge / menus.
  status() {
    const code = this.backend.code;
    return {
      shellVersion: app.getVersion(),
      codeVersion: code.version,
      codeSource: code.source,
      ...this.config(),
      presets: MIRROR_PRESETS,
    };
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = null;
    if (!app.isPackaged || !this.config().autoCheck) return;
    setTimeout(() => this.check({ silent: true }).catch(() => {}), AUTO_CHECK_DELAY).unref?.();
    this.timer = setInterval(() => this.check({ silent: true }).catch(() => {}), AUTO_CHECK_EVERY);
    this.timer.unref?.();
  }

  async fetchInfo() {
    const res = await fetchOk(this.url('update.json'), 20000);
    const info = await res.json();
    if (!parseVersion(info.version) || !info.app || !info.app.file || !/^[0-9a-f]{64}$/i.test(info.app.sha256 || '')) {
      throw new Error('update.json is malformed');
    }
    if (!/^[\w.-]+$/.test(info.app.file)) throw new Error('update.json names an unsafe file');
    return info;
  }

  async message(opts) {
    const win = this.opts.getWindow();
    return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  }

  // silent: background check, only speaks up when something new is available.
  async check({ silent = false } = {}) {
    if (this.busy) return { state: 'busy' };
    this.busy = true;
    try {
      return await this.checkInner(silent);
    } catch (err) {
      if (!silent) {
        await this.message({
          type: 'error', title: 'GenericAgent-Harness', message: 'Update check failed',
          detail: `${err.message}\n\nMirror: ${this.config().mirror || '(none, direct GitHub)'}\nChange it in the tray menu: Updates > Download mirror.`,
        });
      }
      return { state: 'error', error: err.message };
    } finally {
      this.busy = false;
    }
  }

  async checkInner(silent) {
    if (!app.isPackaged) {
      if (!silent) await this.message({ type: 'info', title: 'GenericAgent-Harness', message: 'Running from source', detail: 'Updates apply to packaged builds only; use git pull here.' });
      return { state: 'source' };
    }
    const info = await this.fetchInfo();
    const current = this.backend.code.version;
    if (compareVersions(info.version, current) <= 0) {
      if (!silent) await this.message({ type: 'info', title: 'GenericAgent-Harness', message: 'You are up to date', detail: `Version ${current}` });
      return { state: 'latest', version: current };
    }
    if (silent && this.dismissed === info.version) return { state: 'postponed', version: info.version };
    const shellOk = compareVersions(info.min_shell || '0.0.0', app.getVersion()) <= 0;
    return shellOk ? this.offerCodeUpdate(info) : this.offerShellUpdate(info);
  }

  // ---- code-only update -------------------------------------------------------------------

  async offerCodeUpdate(info) {
    const mb = info.app.size ? ` (${(info.app.size / 1048576).toFixed(1)} MB)` : '';
    const { response } = await this.message({
      type: 'info', title: 'GenericAgent-Harness', message: `Version ${info.version} is available`,
      detail: `Current: ${this.backend.code.version}\n\nThis is a code update${mb}; the desktop app itself stays as is.`,
      buttons: ['Update', 'Release notes', 'Later'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 1) shell.openExternal(RELEASES_PAGE);
    if (response !== 0) { this.dismissed = info.version; return { state: 'postponed', version: info.version }; }
    await this.installCode(info);
    return this.offerRestart(info.version, () => this.opts.relaunch());
  }

  async installCode(info) {
    const root = appDir(this.backend.userData);
    fs.mkdirSync(root, { recursive: true });
    const res = await fetchOk(this.url(info.app.file), 10 * 60 * 1000);
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = sha256(buf);
    if (digest !== info.app.sha256.toLowerCase()) throw new Error(`checksum mismatch for ${info.app.file} (got ${digest})`);

    const zip = path.join(root, `${info.version}.zip`);
    const tmp = path.join(root, `.${info.version}.tmp`);
    const dest = path.join(root, info.version);
    fs.writeFileSync(zip, buf);
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      // The bundled CPython is always there; Node has no unzip of its own.
      await run(this.backend.settings.python, ['-m', 'zipfile', '-e', zip, tmp]);
      const got = readCodeVersion(tmp);
      if (got !== info.version) throw new Error(`bundle contains version ${got || '?'}, expected ${info.version}`);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }

    const state = readAppState(this.backend.userData);
    const code = this.backend.code;
    writeAppState(this.backend.userData, {
      current: info.version,
      previous: code.source === 'update' && code.version !== info.version ? code.version : null,
      bad: state.bad.filter((v) => v !== info.version),
    });
    this.prune(root, info.version, code.source === 'update' ? code.version : null);
  }

  // Keep only the new version and the one running now (the rollback target).
  prune(root, ...keep) {
    for (const name of fs.readdirSync(root)) {
      if (!parseVersion(name) || keep.includes(name)) continue;
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* in use */ }
    }
  }

  async runningTasks() {
    const b = this.backend;
    if (!b.url) return false;
    try {
      const res = await net.fetch(new URL('/api/state', b.url).href, { headers: { 'X-GAH-Token': b.token }, cache: 'no-store' });
      if (!res.ok) return false;
      return Boolean((await res.json()).running);
    } catch { return false; }
  }

  async offerRestart(version, restart) {
    const running = await this.runningTasks();
    const { response } = await this.message({
      type: running ? 'warning' : 'info', title: 'GenericAgent-Harness', message: `Version ${version} is ready`,
      detail: running
        ? 'A task is still running. Restarting now stops it. You can also restart later from the tray menu or simply on next launch.'
        : 'Restart GenericAgent-Harness to use it.',
      buttons: ['Restart now', 'Later'], defaultId: running ? 1 : 0, cancelId: 1, noLink: true,
    });
    if (response === 0) { await restart(); return { state: 'restarting', version }; }
    this.dismissed = version;
    return { state: 'installed', version };
  }

  // ---- shell (installer) update -----------------------------------------------------------

  loadShellUpdater() {
    if (this.shellUpdater !== undefined) return this.shellUpdater;
    this.shellUpdater = null;
    const supported = process.platform === 'win32' || (process.platform === 'linux' && process.env.APPIMAGE);
    if (!supported) return null;
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = Boolean(parseVersion(app.getVersion())?.pre);
      this.shellUpdater = autoUpdater;
    } catch (err) {
      console.error('electron-updater unavailable:', err);
    }
    return this.shellUpdater;
  }

  async offerShellUpdate(info) {
    const updater = this.loadShellUpdater();
    const detail = `Current app: ${app.getVersion()}; version ${info.version} needs a newer desktop app (${info.min_shell} or later).`;
    if (!updater) {
      const { response } = await this.message({
        type: 'info', title: 'GenericAgent-Harness', message: `Version ${info.version} is available`,
        detail: `${detail}\n\nDownload the installer from the release page.`,
        buttons: ['Open release page', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (response === 0) shell.openExternal(RELEASES_PAGE);
      else this.dismissed = info.version;
      return { state: 'manual', version: info.version };
    }
    const { response } = await this.message({
      type: 'info', title: 'GenericAgent-Harness', message: `Version ${info.version} is available`,
      detail: `${detail}\n\nThe new installer will be downloaded and installed.`,
      buttons: ['Download', 'Release notes', 'Later'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 1) shell.openExternal(RELEASES_PAGE);
    if (response !== 0) { this.dismissed = info.version; return { state: 'postponed', version: info.version }; }

    // Generic feed = the same latest/download URL, so the mirror applies to the installer too.
    updater.setFeedURL({ provider: 'generic', url: this.url('').replace(/\/$/, '') });
    const result = await updater.checkForUpdates();
    if (!result || !result.updateInfo || compareVersions(result.updateInfo.version, app.getVersion()) <= 0) {
      throw new Error('the release has no installer update for this platform');
    }
    await updater.downloadUpdate();
    return this.offerRestart(result.updateInfo.version, async () => {
      await this.opts.prepareQuit();
      updater.quitAndInstall(false, true);
    });
  }

  // ---- mirror menu -----------------------------------------------------------------------

  async chooseMirror() {
    const current = this.config().mirror;
    const presets = MIRROR_PRESETS.map((p) => `${p.value === current ? '\u2713 ' : ''}${p.label}`);
    const custom = MIRROR_PRESETS.some((p) => p.value === current) ? 'Custom...' : `\u2713 Custom: ${current}`;
    const { response } = await this.message({
      type: 'question', title: 'GenericAgent-Harness', message: 'Download mirror for updates',
      detail: `Update files come from GitHub releases. A mirror is a URL prefix (or a template with {url}).\n\nFor a custom mirror, set "update": {"mirror": "..."} in:\n${this.settingsFile}`,
      buttons: [...presets, custom, 'Cancel'], cancelId: presets.length + 1, noLink: true,
    });
    if (response < presets.length) this.setConfig({ mirror: MIRROR_PRESETS[response].value });
    else if (response === presets.length) shell.openPath(this.settingsFile);
    return this.config();
  }
}

module.exports = { Updater, mirrored, MIRROR_PRESETS };
