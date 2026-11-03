// Plugin windows: desktop windows declared by web plugins (web.host.register(desktop=[...])).
// The main page forwards the declarations from /api/state; the shell opens, reloads and closes
// the windows to match, so a new desktop plugin needs no shell change. Pages are always served
// by the backend under /web/<plugin>/ and get the same sandboxed preload as the main window.
//
//   overlay: frameless, transparent, always-on-top, not focusable; hidden until the page calls
//            gahDesktop.plugin.layout({ visible, width, height }); draggable via plugin.drag().
//   window:  an ordinary window opened on demand (tray item or gahDesktop.plugin.open()).
//
// Positions the user dragged overlays to live in <userData>/plugin-windows.json.
'use strict';

const { BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ANCHORS = new Set(['top', 'top-left', 'top-right', 'bottom', 'bottom-left', 'bottom-right', 'center']);
const MARGIN = 4;

function overlaysSupported() {
  // Transparent frameless always-on-top windows are unreliable on Linux compositors.
  return process.platform === 'win32' || process.platform === 'darwin';
}

const clamp = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

// Re-validate what the renderer sent: never trust it to pick URLs or window options.
function sanitize(name, raw) {
  if (!raw || typeof raw !== 'object' || !NAME.test(name) || !ID.test(String(raw.id || ''))) return null;
  const url = String(raw.url || '');
  const prefix = `/web/${name}/`;
  if (!url.startsWith(prefix) || url.includes('..') || url.includes('\\') || url.includes('//')
      || !/^[^?#]+\.html(\?[^#]*)?$/.test(url)) return null;
  const kind = raw.kind === 'window' ? 'window' : 'overlay';
  if (kind === 'overlay' && !overlaysSupported()) return null;
  let data = null;
  try { if (raw.data !== undefined) data = JSON.parse(JSON.stringify(raw.data)); } catch { data = null; }
  return {
    key: `${name}/${raw.id}`, name, id: String(raw.id), url, kind,
    anchor: ANCHORS.has(raw.anchor) ? raw.anchor : 'top',
    title: String(raw.title || name).slice(0, 80),
    width: clamp(raw.width, 40, 1600, kind === 'overlay' ? 240 : 480),
    height: clamp(raw.height, 24, 1200, kind === 'overlay' ? 48 : 640),
    focusable: kind === 'window' ? raw.focusable !== false : !!raw.focusable,
    tray: raw.tray ? String(raw.tray).slice(0, 40) : '',
    data,
  };
}

class PluginWindows {
  constructor({ dataDir, preload, icon, onChange }) {
    this.file = path.join(dataDir, 'plugin-windows.json');
    this.preload = preload;
    this.icon = icon;
    this.onChange = onChange || (() => {});
    this.origin = null;
    this.specs = new Map();     // key -> sanitized declaration
    this.wins = new Map();      // key -> { win, spec, box, drag }
    this.state = { mainFocused: false };
    this.prefs = {};
    try { this.prefs = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.prefs = {}; }
    // One-time carry-over of the position from the shell's former built-in island.
    if (!this.prefs['web-island/island']) {
      try {
        const old = JSON.parse(fs.readFileSync(path.join(dataDir, 'island.json'), 'utf8'));
        if (typeof old.x === 'number' && typeof old.y === 'number') this.prefs['web-island/island'] = { x: old.x, y: old.y };
      } catch { /* none */ }
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.prefs, null, 2));
    } catch (err) { console.error('plugin windows prefs:', err); }
  }

  // Backend origin; plugin pages authenticate with the session cookie the main window got,
  // so call this once the main page has loaded.
  setOrigin(origin) {
    if (!origin || origin === this.origin) return;
    this.origin = origin;
    for (const entry of [...this.wins.values()]) this.closeKey(entry.spec.key);
    this.reconcile();
  }

  // `plugins` is [{ name, desktop: [...] }] from the main page (only active web plugins).
  sync(plugins) {
    const next = new Map();
    for (const p of Array.isArray(plugins) ? plugins : []) {
      const name = String((p && p.name) || '');
      for (const raw of Array.isArray(p && p.desktop) ? p.desktop.slice(0, 8) : []) {
        const spec = sanitize(name, raw);
        if (spec && !next.has(spec.key)) next.set(spec.key, spec);
      }
    }
    this.specs = next;
    this.reconcile();
    this.onChange();
  }

  reconcile() {
    for (const [key, entry] of [...this.wins]) {
      const spec = this.specs.get(key);
      if (!spec || spec.url !== entry.spec.url || spec.kind !== entry.spec.kind || spec.focusable !== entry.spec.focusable) {
        this.closeKey(key);
      } else {
        const dataChanged = JSON.stringify(spec.data) !== JSON.stringify(entry.spec.data);
        entry.spec = spec;
        if (dataChanged) this.sendState(null, key);
      }
    }
    if (!this.origin) return;
    // Overlays are always present; ordinary windows only open on demand.
    for (const spec of this.specs.values()) if (spec.kind === 'overlay' && !this.wins.has(spec.key)) this.create(spec);
  }

  // Tray entries: [{ key, label }] for declarations that ask for one.
  trayItems() {
    return [...this.specs.values()].filter((s) => s.tray).map((s) => ({ key: s.key, label: s.tray }));
  }

  // Show (creating if needed) a declared window, e.g. from the tray.
  open(key) {
    const spec = this.specs.get(key);
    if (!spec || !this.origin) return false;
    const entry = this.wins.get(key) || this.create(spec);
    if (entry && spec.kind === 'window') {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.show();
      entry.win.focus();
    }
    return !!entry;
  }

  create(spec) {
    const overlay = spec.kind === 'overlay';
    const win = new BrowserWindow({
      width: spec.width, height: spec.height, show: false, title: spec.title, icon: this.icon,
      ...(overlay ? {
        frame: false, transparent: true, resizable: false, movable: true, minimizable: false,
        maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
        focusable: spec.focusable, alwaysOnTop: true, backgroundColor: '#00000000',
      } : { autoHideMenuBar: true }),
      // Overlays render while hidden; throttling would show a blank window at first.
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: !overlay },
    });
    if (overlay) {
      win.setAlwaysOnTop(true, 'floating');
      if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      win.setMenu(null);
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const entry = { win, spec, box: { visible: false, width: spec.width, height: spec.height }, drag: null };
    win.on('closed', () => { if (this.wins.get(spec.key) === entry) this.wins.delete(spec.key); });
    win.webContents.on('did-finish-load', () => this.sendState(null, spec.key));
    this.wins.set(spec.key, entry);
    win.loadURL(this.origin + spec.url).catch((err) => console.error(`plugin window ${spec.key}:`, err));
    return entry;
  }

  closeKey(key) {
    const entry = this.wins.get(key);
    this.wins.delete(key);
    if (entry && !entry.win.isDestroyed()) entry.win.destroy();
  }

  closeAll() { for (const key of [...this.wins.keys()]) this.closeKey(key); }

  // The plugin window whose page sent an IPC message, or null (main window, other pages).
  entryFor(sender) {
    for (const entry of this.wins.values()) if (!entry.win.isDestroyed() && entry.win.webContents === sender) return entry;
    return null;
  }

  // Anchor point of an overlay: the spot that stays put while the page resizes it.
  point(entry) {
    const area = screen.getPrimaryDisplay().workArea;
    const a = entry.spec.anchor;
    const saved = this.prefs[entry.spec.key];
    let x;
    let y;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') ({ x, y } = saved);
    else {
      x = a.endsWith('left') ? area.x + MARGIN : a.endsWith('right') ? area.x + area.width - MARGIN : area.x + area.width / 2;
      y = a.startsWith('top') ? area.y + MARGIN : a.startsWith('bottom') ? area.y + area.height - MARGIN : area.y + area.height / 2;
    }
    // Keep it reachable when the saved spot is on a display that is gone.
    const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
    x = Math.min(Math.max(x, d.x), d.x + d.width);
    y = Math.min(Math.max(y, d.y), d.y + d.height);
    return { x, y };
  }

  // Window origin for an anchor point and size.
  static place(anchor, x, y, w, h) {
    const left = anchor.endsWith('left') ? x : anchor.endsWith('right') ? x - w : x - w / 2;
    const top = anchor.startsWith('top') ? y : anchor.startsWith('bottom') ? y - h : y - h / 2;
    return { x: Math.round(left), y: Math.round(top), width: w, height: h };
  }

  layout(sender, box) {
    const entry = this.entryFor(sender);
    if (!entry || !box || typeof box !== 'object') return;
    const { win, spec } = entry;
    const width = clamp(box.width, 40, 1600, entry.box.width);
    const height = clamp(box.height, 24, 1200, entry.box.height);
    entry.box = { visible: box.visible !== false, width, height };
    if (spec.kind !== 'overlay') {
      // Ordinary windows: size only; the user opens and closes them.
      const [w, h] = win.getContentSize();
      if (w !== width || h !== height) win.setContentSize(width, height);
      return;
    }
    if (!entry.box.visible) { if (win.isVisible()) win.hide(); return; }
    if (entry.drag) return;
    const { x, y } = this.point(entry);
    win.setBounds(PluginWindows.place(spec.anchor, x, y, width, height));
    if (!win.isVisible()) win.showInactive();
  }

  dragEvent(sender, phase, sx, sy) {
    const entry = this.entryFor(sender);
    if (!entry || entry.spec.kind !== 'overlay') return;
    const { win, spec } = entry;
    if (phase === 'start') {
      const b = win.getBounds();
      entry.drag = { sx, sy, x: b.x, y: b.y };
    } else if (phase === 'move' && entry.drag) {
      const d = entry.drag;
      win.setPosition(Math.round(d.x + sx - d.sx), Math.round(d.y + sy - d.sy));
    } else if (phase === 'end' && entry.drag) {
      const b = win.getBounds();
      if (b.x !== entry.drag.x || b.y !== entry.drag.y) {
        const a = spec.anchor;
        this.prefs[spec.key] = {
          x: a.endsWith('left') ? b.x : a.endsWith('right') ? b.x + b.width : b.x + b.width / 2,
          y: a.startsWith('top') ? b.y : a.startsWith('bottom') ? b.y + b.height : b.y + b.height / 2,
        };
        this.save();
      }
      entry.drag = null;
      this.layout(win.webContents, entry.box);
    }
  }

  // `state` (shell facts such as mainFocused) is merged and pushed to every plugin window, or
  // only to `onlyKey`; each page also gets its own declaration's data.
  sendState(state, onlyKey) {
    if (state) Object.assign(this.state, state);
    for (const [key, entry] of this.wins) {
      if (onlyKey && key !== onlyKey) continue;
      if (entry.win.isDestroyed()) continue;
      entry.win.webContents.send('gah:plugin-state', {
        ...this.state, plugin: entry.spec.name, window: entry.spec.id, kind: entry.spec.kind, data: entry.spec.data,
      });
    }
  }
}

module.exports = { PluginWindows, overlaysSupported };
