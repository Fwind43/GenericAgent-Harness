// One-click updates for the desktop shell.
//
// Every "v*" release carries:
//   update.json                      {"version", "min_shell", "app": {"file", "sha256", "size"}}
//   ga-harness-app-<version>.zip     the ga_harness package (plugins, ui-web dist, ...) plus
//                                    genericagent/, the GA source pinned in desktop/GA_REF
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
const { t } = require('./i18n');

const REPO = 'Fwind43/GenericAgent-Harness';
const LATEST = `https://github.com/${REPO}/releases/latest/download`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MIRROR_PRESETS = [
  { label: 'GitHub', value: '' },
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


const LOG_MAX = 200;
const EMIT_EVERY = 120;   // ms between progress pushes to the renderer

// phase: idle | checking | latest | available | downloading | verifying | installing | ready | error | source
// kind:  code (app bundle) | shell (installer via electron-updater) | manual (open the release page)
class Updater {
  // opts: { getBackend: () => Backend, getWindow: () => BrowserWindow|null,
  //         relaunch: () => void (restart the whole app), prepareQuit: async () => void,
  //         onState?: (snapshot) => void (pushes progress to the settings page) }
  constructor(opts) {
    this.opts = opts;
    this.busy = false;
    this.timer = null;
    this.shellUpdater = undefined;   // lazily loaded electron-updater autoUpdater (or null)
    this.dismissed = null;           // version the user postponed during this session
    this.pending = null;             // { info, kind } found by the last check
    this.ready = null;               // { version, kind, restart } once installed / downloaded
    this.st = { phase: 'idle', kind: null, version: null, received: 0, total: 0, error: null, checkedAt: null };
    this.log = [];
    this.lastEmit = 0;
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
    const cfg = this.config();
    this.note(`Settings saved: mirror ${cfg.mirror || 'GitHub (direct)'}, auto check ${cfg.autoCheck ? 'on' : 'off'}`);
    this.emit(true);
    return cfg;
  }

  url(file) { return mirrored(this.config().mirror, `${LATEST}/${file}`); }

  // Public status for menus.
  status() {
    const code = this.backend.code;
    return {
      shellVersion: app.getVersion(),
      codeVersion: code.version,
      codeSource: code.source,
      packaged: app.isPackaged,
      releasesPage: RELEASES_PAGE,
      settingsFile: this.settingsFile,
      ...this.config(),
      presets: MIRROR_PRESETS,
    };
  }

  // Full state for the settings page: versions, config, current phase/progress and the log.
  snapshot() {
    return { ...this.status(), ...this.st, busy: this.busy, log: this.log.slice() };
  }

  note(msg, level = 'info') {
    this.log.push({ t: Date.now(), level, msg: String(msg) });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  set(patch, msg, level) {
    Object.assign(this.st, patch);
    if (msg) this.note(msg, level);
    this.emit(true);
  }

  emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < EMIT_EVERY) return;
    this.lastEmit = now;
    try { this.opts.onState?.(this.snapshot()); } catch { /* window gone */ }
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
  // ui: called from the settings page, which shows state itself, so no dialogs at all.
  async check({ silent = false, ui = false } = {}) {
    if (this.busy) return this.snapshot();
    this.busy = true;
    try {
      await this.checkInner(silent, ui);
    } catch (err) {
      this.set({ phase: 'error', error: err.message }, `Update failed: ${err.message}`, 'error');
      if (!silent && !ui) {
        await this.message({
          type: 'error', title: 'GenericAgent-Harness', message: t('更新失败', 'Update failed'),
          detail: t(`${err.message}\n\n镜像：${this.config().mirror || '（无，直连 GitHub）'}\n可在 设置 > 更新 中修改。`,
            `${err.message}\n\nMirror: ${this.config().mirror || '(none, direct GitHub)'}\nChange it in Settings > Updates.`),
        });
      }
    } finally {
      this.busy = false;
      this.emit(true);
    }
    return this.snapshot();
  }

  async checkInner(silent, ui) {
    const dialogs = !silent && !ui;
    if (!app.isPackaged) {
      this.set({ phase: 'source' }, 'Running from source: updates apply to packaged builds only.');
      if (dialogs) await this.message({ type: 'info', title: 'GenericAgent-Harness', message: t('正在从源码运行', 'Running from source'), detail: t('更新只适用于安装包版本；源码请使用 git pull。', 'Updates apply to packaged builds only; use git pull here.') });
      return;
    }
    if (this.ready) {   // already installed, only a restart is missing
      this.set({ phase: 'ready', version: this.ready.version, kind: this.ready.kind });
      if (dialogs) await this.offerRestart();
      return;
    }
    this.set({ phase: 'checking', error: null }, `Checking for updates (${silent ? 'background' : 'manual'}) via ${this.config().mirror || 'GitHub'}`);
    const info = await this.fetchInfo();
    const current = this.backend.code.version;
    this.st.checkedAt = Date.now();
    if (compareVersions(info.version, current) <= 0) {
      this.pending = null;
      this.set({ phase: 'latest', version: info.version, kind: null }, `Up to date: latest release is ${info.version}, running ${current}`);
      if (dialogs) await this.message({ type: 'info', title: 'GenericAgent-Harness', message: t('已是最新版本', 'You are up to date'), detail: t(`版本 ${current}`, `Version ${current}`) });
      return;
    }
    const shellOk = compareVersions(info.min_shell || '0.0.0', app.getVersion()) <= 0;
    const kind = shellOk ? 'code' : (this.loadShellUpdater() ? 'shell' : 'manual');
    this.pending = { info, kind };
    const what = { code: `code update, ${mb(info.app.size)}`, shell: `needs desktop app ${info.min_shell}+, installer update`, manual: `needs desktop app ${info.min_shell}+, download it from the release page` }[kind];
    this.set({ phase: 'available', version: info.version, kind, received: 0, total: kind === 'code' ? info.app.size || 0 : 0 },
      `Version ${info.version} is available (${what})`);
    if (ui || (silent && this.dismissed === info.version)) return;
    await this.offer(info, kind);
  }

  // Dialog flow (tray menu / background check). The settings page calls install() directly.
  async offer(info, kind) {
    const detail = kind === 'code'
      ? t(`当前版本：${this.backend.code.version}\n\n这是代码更新（${mb(info.app.size)}），桌面应用本身保持不变。`,
        `Current: ${this.backend.code.version}\n\nThis is a code update (${mb(info.app.size)}); the desktop app itself stays as is.`)
      : t(`当前应用：${app.getVersion()}；版本 ${info.version} 需要更新的桌面应用（${info.min_shell} 或更高）。`,
        `Current app: ${app.getVersion()}; version ${info.version} needs a newer desktop app (${info.min_shell} or later).`);
    const later = t('稍后', 'Later');
    const buttons = kind === 'manual' ? [t('打开发布页', 'Open release page'), later]
      : [kind === 'code' ? t('更新', 'Update') : t('下载', 'Download'), t('更新说明', 'Release notes'), later];
    const { response } = await this.message({
      type: 'info', title: 'GenericAgent-Harness', message: t(`版本 ${info.version} 可用`, `Version ${info.version} is available`),
      detail: t(`${detail}\n\n进度显示在 设置 > 更新 中。`, `${detail}\n\nProgress is shown in Settings > Updates.`),
      buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true,
    });
    if (kind === 'manual') {
      if (response === 0) shell.openExternal(RELEASES_PAGE);
      else this.dismissed = info.version;
      return;
    }
    if (response === 1) shell.openExternal(RELEASES_PAGE);
    if (response !== 0) { this.dismissed = info.version; this.note(`Postponed ${info.version}`); this.emit(true); return; }
    await this.installInner(this.pending);
    await this.offerRestart();
  }

  // Settings page: download + install what the last check found, reporting progress.
  async install() {
    if (this.busy) return this.snapshot();
    const p = this.pending;
    if (!p) throw new Error('no update available; check first');
    if (p.kind === 'manual') { shell.openExternal(RELEASES_PAGE); this.note('Opened the release page'); this.emit(true); return this.snapshot(); }
    this.busy = true;
    try {
      await this.installInner(p);
    } catch (err) {
      this.set({ phase: 'error', error: err.message }, `Install failed: ${err.message}`, 'error');
    } finally {
      this.busy = false;
      this.emit(true);
    }
    return this.snapshot();
  }

  async installInner(p) {
    if (p.kind === 'code') await this.installCode(p.info);
    else await this.downloadShell(p.info);
    this.pending = null;
  }

  async restart() {
    if (!this.ready) throw new Error('nothing to restart for');
    this.note(`Restarting to apply ${this.ready.version}`);
    this.emit(true);
    await this.ready.restart();
    return true;
  }

  // ---- code-only update -------------------------------------------------------------------

  async download(url, expectedSize) {
    this.set({ phase: 'downloading', received: 0, total: expectedSize || 0 }, `Downloading ${url}`);
    const res = await fetchOk(url, 10 * 60 * 1000);
    const total = Number(res.headers.get('content-length')) || expectedSize || 0;
    this.st.total = total;
    const chunks = [];
    let got = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        got += value.length;
        this.st.received = got;
        this.emit();
      }
    } else {
      chunks.push(Buffer.from(await res.arrayBuffer()));
      got = chunks[0].length;
    }
    this.st.received = got;
    return Buffer.concat(chunks, got);
  }

  async installCode(info) {
    const root = appDir(this.backend.userData);
    fs.mkdirSync(root, { recursive: true });
    const buf = await this.download(this.url(info.app.file), info.app.size);
    this.set({ phase: 'verifying' }, `Downloaded ${mb(buf.length)}; verifying SHA-256`);
    const digest = sha256(buf);
    if (digest !== info.app.sha256.toLowerCase()) throw new Error(`checksum mismatch for ${info.app.file} (got ${digest})`);

    this.set({ phase: 'installing' }, 'Checksum OK; extracting the app bundle');
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
    this.ready = { version: info.version, kind: 'code', restart: () => this.opts.relaunch() };
    this.set({ phase: 'ready', version: info.version, kind: 'code' }, `Version ${info.version} installed; restart to use it`);
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

  async offerRestart() {
    if (!this.ready) return;
    const { version } = this.ready;
    const running = await this.runningTasks();
    const { response } = await this.message({
      type: running ? 'warning' : 'info', title: 'GenericAgent-Harness', message: t(`版本 ${version} 已就绪`, `Version ${version} is ready`),
      detail: running
        ? t('仍有任务在运行，立即重启会中断它。也可以稍后在 设置 > 更新 中重启，或下次启动时自动生效。',
          'A task is still running. Restarting now stops it. You can also restart later from Settings > Updates or simply on next launch.')
        : t('重启 GenericAgent-Harness 以使用新版本。', 'Restart GenericAgent-Harness to use it.'),
      buttons: [t('立即重启', 'Restart now'), t('稍后', 'Later')], defaultId: running ? 1 : 0, cancelId: 1, noLink: true,
    });
    if (response === 0) { await this.restart(); return; }
    this.dismissed = version;
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

  async downloadShell(info) {
    const updater = this.loadShellUpdater();
    if (!updater) throw new Error('installer updates are not supported on this platform');
    // Generic feed = the same latest/download URL, so the mirror applies to the installer too.
    updater.setFeedURL({ provider: 'generic', url: this.url('').replace(/\/$/, '') });
    this.set({ phase: 'checking' }, 'Looking up the installer for this platform');
    const result = await updater.checkForUpdates();
    if (!result || !result.updateInfo || compareVersions(result.updateInfo.version, app.getVersion()) <= 0) {
      throw new Error('the release has no installer update for this platform');
    }
    const version = result.updateInfo.version;
    this.set({ phase: 'downloading', received: 0, total: 0 }, `Downloading installer ${version}`);
    const onProgress = (p) => { this.st.received = p.transferred || 0; this.st.total = p.total || 0; this.emit(); };
    updater.on('download-progress', onProgress);
    try {
      await updater.downloadUpdate();
    } finally {
      updater.removeListener('download-progress', onProgress);
    }
    this.ready = {
      version, kind: 'shell',
      restart: async () => { await this.opts.prepareQuit(); updater.quitAndInstall(false, true); },
    };
    this.set({ phase: 'ready', version, kind: 'shell' }, `Installer ${version} downloaded; restart to install it`);
  }

  // ---- mirror menu -----------------------------------------------------------------------

  async chooseMirror() {
    const current = this.config().mirror;
    const presets = MIRROR_PRESETS.map((p) => `${p.value === current ? '\u2713 ' : ''}${p.label}`);
    const custom = MIRROR_PRESETS.some((p) => p.value === current) ? t('自定义…', 'Custom...') : `\u2713 ${t('自定义', 'Custom')}: ${current}`;
    const { response } = await this.message({
      type: 'question', title: 'GenericAgent-Harness', message: t('更新下载镜像', 'Download mirror for updates'),
      detail: t(`更新文件来自 GitHub Releases。镜像是一个 URL 前缀（或含 {url} 的模板）。\n\n可在 设置 > 更新 中填写自定义镜像，或在以下文件中设置 "update": {"mirror": "..."}：\n${this.settingsFile}`, `Update files come from GitHub releases. A mirror is a URL prefix (or a template with {url}).\n\nA custom mirror can be entered in Settings > Updates, or set "update": {"mirror": "..."} in:\n${this.settingsFile}`),
      buttons: [...presets, custom, t('取消', 'Cancel')], cancelId: presets.length + 1, noLink: true,
    });
    if (response < presets.length) this.setConfig({ mirror: MIRROR_PRESETS[response].value });
    else if (response === presets.length) shell.openPath(this.settingsFile);
    return this.config();
  }
}

function mb(bytes) { return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : 'size unknown'; }

module.exports = { Updater, mirrored, MIRROR_PRESETS };
