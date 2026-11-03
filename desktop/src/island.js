// Dynamic island: a small transparent always-on-top window that loads the web-island plugin page
// (/web/web-island/island.html). The page decides what to show and reports its size; the shell
// only sizes, positions and shows the window. Preferences live in <userData>/island.json.
'use strict';

const { BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = '/web/web-island/island.html';

function supported() {
  // Transparent, click-through-free frameless windows are unreliable on Linux compositors.
  return process.platform === 'win32' || process.platform === 'darwin';
}

class Island {
  constructor({ dataDir, preload, icon }) {
    this.file = path.join(dataDir, 'island.json');
    this.preload = preload;
    this.icon = icon;
    this.win = null;
    this.url = null;
    this.box = { visible: false, width: 0, height: 0 };
    this.drag = null;
    this.state = { mainFocused: false };
    // pinned: keep an idle pill on screen instead of showing only while something needs attention.
    this.prefs = { enabled: true, pinned: false, x: null, y: null };
    try { Object.assign(this.prefs, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* defaults */ }
  }

  get enabled() { return supported() && this.prefs.enabled !== false; }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.prefs, null, 2));
    } catch (err) { console.error('island prefs:', err); }
  }

  setEnabled(on) {
    this.prefs.enabled = !!on;
    this.save();
    if (this.enabled) this.open(this.url); else this.close();
  }

  // Settings page view of the preferences.
  getPrefs() { return { supported: supported(), enabled: this.enabled, pinned: !!this.prefs.pinned }; }

  setPrefs(patch) {
    if (typeof patch.pinned === 'boolean' && patch.pinned !== !!this.prefs.pinned) {
      this.prefs.pinned = patch.pinned;
      this.save();
      this.sendState();
    }
    if (typeof patch.enabled === 'boolean' && patch.enabled !== this.enabled) this.setEnabled(patch.enabled);
    return this.getPrefs();
  }

  // `origin` is the backend origin; the page authenticates with the session cookie the main
  // window already obtained, so call this after the main page has loaded once.
  open(origin) {
    if (origin) this.url = origin;
    if (!this.enabled || !this.url || this.win) return;
    const win = new BrowserWindow({
      width: 240, height: 48, show: false, frame: false, transparent: true, resizable: false,
      movable: true, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, focusable: false, alwaysOnTop: true,
      title: 'GenericAgent-Harness Island', icon: this.icon, backgroundColor: '#00000000',
      // The page renders while the window is hidden; throttling would show a blank pill at first.
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('closed', () => { if (this.win === win) this.win = null; });
    win.webContents.on('did-finish-load', () => this.sendState());
    this.win = win;
    this.box = { visible: false, width: 0, height: 0 };
    win.loadURL(this.url + PAGE).catch((err) => console.error('island load:', err));
  }

  close() {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  // Top-centre anchor: (x, y) is the centre of the pill's top edge, so it grows symmetrically.
  anchor() {
    const area = screen.getPrimaryDisplay().workArea;
    let { x, y } = this.prefs;
    if (typeof x !== 'number' || typeof y !== 'number') { x = area.x + area.width / 2; y = area.y + 4; }
    // Keep it reachable when the saved spot is on a display that is gone.
    const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
    x = Math.min(Math.max(x, d.x + 40), d.x + d.width - 40);
    y = Math.min(Math.max(y, d.y), d.y + d.height - 40);
    return { x, y };
  }

  layout(box) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const width = Math.max(40, Math.min(600, Math.round(Number(box.width) || 0)));
    const height = Math.max(24, Math.min(400, Math.round(Number(box.height) || 0)));
    this.box = { visible: !!box.visible, width, height };
    if (!this.box.visible) { if (win.isVisible()) win.hide(); return; }
    if (this.drag) return;
    const { x, y } = this.anchor();
    win.setBounds({ x: Math.round(x - width / 2), y: Math.round(y), width, height });
    if (!win.isVisible()) win.showInactive();
  }

  dragEvent(phase, sx, sy) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (phase === 'start') {
      const b = win.getBounds();
      this.drag = { sx, sy, x: b.x, y: b.y, w: b.width };
    } else if (phase === 'move' && this.drag) {
      const d = this.drag;
      win.setPosition(Math.round(d.x + sx - d.sx), Math.round(d.y + sy - d.sy));
    } else if (phase === 'end' && this.drag) {
      const b = win.getBounds();
      if (b.x !== this.drag.x || b.y !== this.drag.y) {
        this.prefs.x = b.x + b.width / 2;
        this.prefs.y = b.y;
        this.save();
      }
      this.drag = null;
      this.layout(this.box);
    }
  }

  // `state` is merged into the last known shell state; the page also gets the pinned preference.
  sendState(state) {
    if (state) Object.assign(this.state, state);
    const win = this.win;
    if (win && !win.isDestroyed()) win.webContents.send('gah:island-state', { ...this.state, pinned: !!this.prefs.pinned });
  }
}

module.exports = { Island, supported };
