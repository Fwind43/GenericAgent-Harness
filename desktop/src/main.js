// GenericAgent-Harness desktop shell. The window only shows the ui-web page served by the
// Python backend; plugins, sessions and settings all stay in the backend (same as the browser).
'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { Backend, isGaRoot } = require('./backend');

let backend = null;
let win = null;
let origin = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
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
    : 'No GenericAgent folder is configured (no GA_ROOT, no ~/.ga-harness/config.toml ga_root).';
  return pickGaRoot(reason, value);
}

async function boot() {
  try {
    backend = new Backend(app.getPath('userData'), app.isPackaged ? process.resourcesPath : null);
    if (!(await ensureGaRoot())) {
      app.exit(1);
      return;
    }
    backend.start();
    const url = await backend.waitReady();
    origin = new URL(url).origin;
    registerBridge();
    createWindow(url);
    backend.exited.then((code) => {
      if (quitting) return;
      dialog.showErrorBox('GenericAgent-Harness', `The backend stopped (code ${code}).\n\n${backend.tail.slice(-15).join('\n')}\n\nLog: ${backend.logFile}`);
      app.quit();
    });
  } catch (err) {
    const tail = backend ? backend.tail.slice(-15).join('\n') : '';
    const where = backend ? `\n\nLog: ${backend.logFile}\nSettings: ${backend.settings.file}` : '';
    if (backend) await backend.stop(1000);
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

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (quitting || !backend) return;
  quitting = true;
  event.preventDefault();
  backend.stop().finally(() => app.exit(0));
});
