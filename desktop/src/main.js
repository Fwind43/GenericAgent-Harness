// GenericAgent-Harness desktop shell. The window only shows the ui-web page served by the
// Python backend; plugins, sessions and settings all stay in the backend (same as the browser).
'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const { Backend, isGaRoot } = require('./backend');
const { Updater } = require('./updater');

let backend = null;
let win = null;
let origin = null;
let quitting = false;
let tray = null;
let updater = null;
const ICON = path.join(__dirname, '..', 'resources', 'icon.png');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  // macOS: clicking the Dock icon brings the hidden window back.
  app.on('activate', () => showWindow());
  app.whenReady().then(boot);
}

function fromBackend(event) {
  // Only the backend page may use the bridge; never a navigated-away or embedded origin.
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

function registerBridge() {
  ipcMain.handle('gah:pick-directory', async (event, opts = {}) => {
    if (!fromBackend(event)) throw new Error('forbidden');
    const res = await dialog.showOpenDialog(win, {
      title: typeof opts.title === 'string' ? opts.title : undefined,
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('gah:open-path', async (event, target) => {
    if (!fromBackend(event) || typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('forbidden');
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });
  ipcMain.handle('gah:open-external', async (event, url) => {
    if (!fromBackend(event) || !/^https?:\/\//i.test(String(url))) throw new Error('forbidden');
    await shell.openExternal(String(url));
    return true;
  });
  ipcMain.handle('gah:update-status', (event) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    return updater.status();
  });
  ipcMain.handle('gah:update-check', (event) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    return updater.check({ silent: false });
  });
  ipcMain.handle('gah:update-config', (event, patch = {}) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    const clean = {};
    if (typeof patch.mirror === 'string') clean.mirror = patch.mirror;
    if (typeof patch.autoCheck === 'boolean') clean.autoCheck = patch.autoCheck;
    updater.setConfig(clean);
    refreshTrayMenu();
    return updater.status();
  });
}

// Stop the backend and mark the app as quitting (used before installers take over).
async function prepareQuit() {
  quitting = true;
  if (tray) { tray.destroy(); tray = null; }
  if (backend) await backend.stop();
}

// Restart the whole app: the new Backend picks the freshly installed code.
function relaunch() {
  app.relaunch();
  app.quit();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Closing the window keeps the backend (and any running task) alive in the tray; only the
// tray menu "Quit" (or app quit on macOS: Cmd+Q / Dock menu) really stops it.
function createTray() {
  try {
    let img = nativeImage.createFromPath(ICON);
    img = img.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
    tray = new Tray(img);
  } catch (err) {
    // No tray available (e.g. some Linux desktops): fall back to quit-on-close.
    console.error('tray unavailable:', err);
    tray = null;
    return;
  }
  tray.setToolTip('GenericAgent-Harness');
  refreshTrayMenu();
  // Windows/Linux: left click toggles the window (macOS opens the menu on click by itself).
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible() && win.isFocused()) win.hide(); else showWindow();
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const items = [{ label: 'Show GenericAgent-Harness', click: () => showWindow() }, { type: 'separator' }];
  if (updater) {
    const st = updater.status();
    items.push({
      label: 'Updates',
      submenu: [
        { label: `Version ${st.codeVersion || '?'} (app ${st.shellVersion})`, enabled: false },
        { label: 'Check for updates...', click: () => updater.check({ silent: false }) },
        { label: 'Check automatically', type: 'checkbox', checked: st.autoCheck,
          click: (item) => { updater.setConfig({ autoCheck: item.checked }); refreshTrayMenu(); } },
        { label: `Download mirror: ${st.mirror || 'GitHub (direct)'}...`,
          click: () => updater.chooseMirror().then(refreshTrayMenu) },
      ],
    }, { type: 'separator' });
  }
  items.push({ label: 'Quit', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'GenericAgent-Harness',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Stay on the backend origin; everything else opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    let same = false;
    try { same = new URL(target).origin === origin; } catch { /* invalid */ }
    if (!same) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    }
  });
  win.on('close', (event) => {
    if (quitting || !tray) return;   // real quit, or no tray to come back from
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
  win.loadURL(`${url}?gah_token=${backend.token}`);
}

// Ask for a GenericAgent checkout until the user picks a valid one (saved to desktop.json)
// or gives up. `reason` explains why we are asking. Returns true when a folder was saved.
async function pickGaRoot(reason, defaultPath) {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'GenericAgent-Harness',
      message: 'GenericAgent folder needed',
      detail: `${reason}\n\nGenericAgent-Harness runs on top of a GenericAgent checkout (the folder that contains agentmain.py). Choose it to continue; the choice is saved in:\n${backend.settings.file}`,
      buttons: ['Choose folder...', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    const res = await dialog.showOpenDialog({
      title: 'Choose the GenericAgent folder (contains agentmain.py)',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) continue;
    const dir = res.filePaths[0];
    if (!isGaRoot(dir)) {
      reason = `${dir} does not contain agentmain.py.`;
      defaultPath = dir;
      continue;
    }
    backend.setGaRoot(dir);
    return true;
  }
}

// Make sure a usable GA folder is configured before the backend starts.
async function ensureGaRoot() {
  const { value, source } = backend.gaRoot();
  if (isGaRoot(value)) return true;
  const reason = value
    ? `The configured GenericAgent folder is not usable:\n${value}\n(from ${source}; agentmain.py not found)`
    : `No GenericAgent folder is configured (no GA_ROOT, no ~/.ga-harness/config.toml ga_root)${
      backend.bundledGaError ? `, and the bundled copy could not be prepared:\n${backend.bundledGaError}` : '.'}`;
  return pickGaRoot(reason, value);
}

async function boot() {
  try {
    backend = new Backend(app.getPath('userData'), app.isPackaged ? process.resourcesPath : null, app.getVersion());
    if (!(await ensureGaRoot())) {
      app.exit(1);
      return;
    }
    backend.start();
    const url = await backend.waitReady();
    origin = new URL(url).origin;
    updater = new Updater({ getBackend: () => backend, getWindow: () => win, relaunch, prepareQuit });
    registerBridge();
    createTray();
    createWindow(url);
    updater.schedule();
    backend.exited.then((code) => {
      if (quitting) return;
      dialog.showErrorBox('GenericAgent-Harness', `The backend stopped (code ${code}).\n\n${backend.tail.slice(-15).join('\n')}\n\nLog: ${backend.logFile}`);
      app.quit();
    });
  } catch (err) {
    const tail = backend ? backend.tail.slice(-15).join('\n') : '';
    const where = backend ? `\n\nLog: ${backend.logFile}\nSettings: ${backend.settings.file}` : '';
    if (backend) await backend.stop(1000);
    // Downloaded code that does not start: blacklist it and fall back to the previous/built-in code.
    if (backend && backend.code.source === 'update' && backend.rejectUpdatedCode()) {
      await dialog.showMessageBox({
        type: 'warning', title: 'GenericAgent-Harness',
        message: `Updated version ${backend.code.version} failed to start`,
        detail: `Falling back to the previous version.\n\n${err.message}\n\n${tail}${where}`,
        buttons: ['OK'], noLink: true,
      });
      app.relaunch();
      app.exit(1);
      return;
    }
    // A wrong-but-plausible GA folder only shows up once the backend runs: let the user re-pick.
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'GenericAgent-Harness',
      message: 'GenericAgent-Harness failed to start',
      detail: `${err.message}\n\n${tail}${where}`,
      buttons: backend ? ['Quit', 'Choose GenericAgent folder...'] : ['Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1 && await pickGaRoot('Choose a different GenericAgent folder.', backend.gaRoot().value)) {
      app.relaunch();
    }
    app.exit(1);
  }
}

// Windows logoff/shutdown: let the hidden window close instead of blocking the session end.
app.on('session-end', () => { quitting = true; });

// With a tray the window is only hidden, so this fires only without one (or during quit).
app.on('window-all-closed', () => { if (!tray) app.quit(); });

app.on('before-quit', (event) => {
  if (quitting || !backend) return;
  quitting = true;
  event.preventDefault();
  if (tray) { tray.destroy(); tray = null; }
  backend.stop().finally(() => app.exit(0));
});
