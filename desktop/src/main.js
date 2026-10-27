// GenericAgent-Harness desktop shell. The window only shows the ui-web page served by the
// Python backend; plugins, sessions and settings all stay in the backend (same as the browser).
'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { Backend } = require('./backend');

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
    icon: path.join(__dirname, '..', '..', 'ga_harness', 'plugins', 'ui-web', 'ga-logo.png'),
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

async function boot() {
  try {
    backend = new Backend(app.getPath('userData'));
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
    dialog.showErrorBox('GenericAgent-Harness failed to start', `${err.message}\n\n${tail}${where}`);
    if (backend) await backend.stop(1000);
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
