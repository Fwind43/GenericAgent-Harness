// GenericAgent-Harness desktop shell. The window only shows the ui-web page served by the
// Python backend; plugins, sessions and settings all stay in the backend (same as the browser).
'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const { Backend, isGaRoot } = require('./backend');
const { Updater } = require('./updater');
const { t, setLanguage, initLanguage } = require('./i18n');

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
  // The page reports its UI language on every load; tray and dialogs follow it.
  ipcMain.on('gah:set-lang', (event, lang) => {
    if (fromBackend(event) && setLanguage(lang)) refreshTrayMenu();
  });
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
  ipcMain.handle('gah:update-state', (event) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    return updater.snapshot();
  });
  ipcMain.handle('gah:update-check', (event) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    return updater.check({ ui: true });
  });
  ipcMain.handle('gah:update-install', (event) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    return updater.install();
  });
  ipcMain.handle('gah:update-restart', (event) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    return updater.restart();
  });
  ipcMain.handle('gah:update-config', (event, patch = {}) => {
    if (!fromBackend(event) || !updater) throw new Error('forbidden');
    const clean = {};
    if (typeof patch.mirror === 'string') clean.mirror = patch.mirror;
    if (typeof patch.autoCheck === 'boolean') clean.autoCheck = patch.autoCheck;
    updater.setConfig(clean);
    refreshTrayMenu();
    return updater.snapshot();
  });
  // Settings > GenericAgent: inspect / change the GA checkout. Changes apply on restart.
  ipcMain.handle('gah:ga-root-info', (event) => {
    if (!fromBackend(event) || !backend) throw new Error('forbidden');
    return backend.gaRootInfo();
  });
  ipcMain.handle('gah:ga-root-choose', async (event) => {
    if (!fromBackend(event) || !backend) throw new Error('forbidden');
    if (backend.gaRootInfo().locked) throw new Error('--ga-root is set in desktop.json args');
    const res = await dialog.showOpenDialog(win, {
      title: t('选择 GenericAgent 目录（包含 agentmain.py）', 'Choose the GenericAgent folder (contains agentmain.py)'),
      defaultPath: backend.gaRoot().value || undefined,
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true, info: backend.gaRootInfo() };
    const dir = res.filePaths[0];
    if (!isGaRoot(dir)) return { error: t(`${dir} 中没有 agentmain.py`, `${dir} does not contain agentmain.py`), info: backend.gaRootInfo() };
    backend.setGaRoot(dir);
    return { info: backend.gaRootInfo() };
  });
  ipcMain.handle('gah:ga-root-set', (event, mode) => {
    if (!fromBackend(event) || !backend) throw new Error('forbidden');
    if (mode !== 'bundled' && mode !== 'auto') throw new Error('bad mode');
    if (backend.gaRootInfo().locked) throw new Error('--ga-root is set in desktop.json args');
    backend.setGaRoot(mode === 'bundled' ? 'bundled' : null);
    return { info: backend.gaRootInfo() };
  });
  ipcMain.handle('gah:ga-root-restart', async (event, force) => {
    if (!fromBackend(event) || !backend) throw new Error('forbidden');
    if (!force && updater && await updater.runningTasks()) return { busy: true };
    await prepareQuit();
    relaunch();
    return { ok: true };
  });
}

// Tray "GenericAgent folder...": pick a checkout and offer a restart (same as Settings).
async function changeGaRootFromTray() {
  if (backend.gaRootInfo().locked) {
    await dialog.showMessageBox({ type: 'info', title: 'GenericAgent-Harness', noLink: true, buttons: [t('确定', 'OK')],
      message: t('GenericAgent 目录已由 --ga-root 固定', 'The GenericAgent folder is fixed by --ga-root'),
      detail: t(`请修改此文件中的 "args"：\n${backend.settings.file}`, `Edit "args" in:\n${backend.settings.file}`) });
    return;
  }
  const current = backend.gaRoot();
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'GenericAgent-Harness', noLink: true,
    message: t('GenericAgent 目录', 'GenericAgent folder'),
    detail: t(`当前：${current.value || '（未设置）'}\n来源：${current.source || '-'}\n\n可以使用已有的 GenericAgent 目录（包含 agentmain.py），或使用应用内置的副本。`,
      `Current: ${current.value || '(none)'}\nSource: ${current.source || '-'}\n\nUse an existing GenericAgent checkout (contains agentmain.py), or the copy shipped with the app.`),
    buttons: [t('选择目录…', 'Choose folder...'), t('使用内置副本', 'Use bundled copy'), t('取消', 'Cancel')], defaultId: 0, cancelId: 2,
  });
  if (response === 2) return;
  if (response === 0) {
    const res = await dialog.showOpenDialog({ title: t('选择 GenericAgent 目录（包含 agentmain.py）', 'Choose the GenericAgent folder (contains agentmain.py)'),
      defaultPath: current.value || undefined, properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return;
    if (!isGaRoot(res.filePaths[0])) {
      dialog.showErrorBox('GenericAgent-Harness', t(`${res.filePaths[0]} 中没有 agentmain.py。`, `${res.filePaths[0]} does not contain agentmain.py.`));
      return;
    }
    backend.setGaRoot(res.filePaths[0]);
  } else {
    backend.setGaRoot('bundled');
  }
  const busy = updater ? await updater.runningTasks() : false;
  const ask = await dialog.showMessageBox({
    type: 'question', title: 'GenericAgent-Harness', noLink: true,
    message: t('重启以使用新的 GenericAgent 目录？', 'Restart to use the new GenericAgent folder?'),
    detail: busy ? t('仍有任务在运行，重启会中断它们。', 'Tasks are still running; restarting stops them.')
      : t('更改将在重启后生效。', 'The change takes effect after a restart.'),
    buttons: [t('立即重启', 'Restart now'), t('稍后', 'Later')], defaultId: busy ? 1 : 0, cancelId: 1,
  });
  if (ask.response === 0) { await prepareQuit(); relaunch(); }
}

// Push updater progress to the page (Settings > Updates listens for it).
function sendUpdateState(snapshot) {
  if (win && !win.isDestroyed()) win.webContents.send('gah:update-state', snapshot);
}

// Tray "Check for updates": show Settings > Updates, where the progress is visible.
function openUpdateSettings() {
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('gah:update-open');
  updater.check({ ui: true }).catch(() => {});
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
  const items = [{ label: t('显示 GenericAgent-Harness', 'Show GenericAgent-Harness'), click: () => showWindow() }, { type: 'separator' }];
  if (updater) {
    const st = updater.status();
    items.push({
      label: t('更新', 'Updates'),
      submenu: [
        { label: t(`版本 ${st.codeVersion || '?'}（应用 ${st.shellVersion}）`, `Version ${st.codeVersion || '?'} (app ${st.shellVersion})`), enabled: false },
        { label: t('检查更新…', 'Check for updates...'), click: () => openUpdateSettings() },
        { label: t('自动检查', 'Check automatically'), type: 'checkbox', checked: st.autoCheck,
          click: (item) => { updater.setConfig({ autoCheck: item.checked }); refreshTrayMenu(); } },
        { label: t(`下载镜像：${st.mirror || 'GitHub（直连）'}…`, `Download mirror: ${st.mirror || 'GitHub (direct)'}...`),
          click: () => updater.chooseMirror().then(refreshTrayMenu) },
      ],
    }, { type: 'separator' });
  }
  if (backend) items.push({ label: t('GenericAgent 目录…', 'GenericAgent folder...'), click: () => { changeGaRootFromTray().catch(() => {}); } }, { type: 'separator' });
  items.push({ label: t('退出', 'Quit'), click: () => app.quit() });
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
      message: t('需要 GenericAgent 目录', 'GenericAgent folder needed'),
      detail: t(`${reason}\n\nGenericAgent-Harness 运行在 GenericAgent 目录（包含 agentmain.py 的文件夹）之上。请选择它以继续，选择会保存在：\n${backend.settings.file}`,
        `${reason}\n\nGenericAgent-Harness runs on top of a GenericAgent checkout (the folder that contains agentmain.py). Choose it to continue; the choice is saved in:\n${backend.settings.file}`),
      buttons: [t('选择目录…', 'Choose folder...'), t('退出', 'Quit')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    const res = await dialog.showOpenDialog({
      title: t('选择 GenericAgent 目录（包含 agentmain.py）', 'Choose the GenericAgent folder (contains agentmain.py)'),
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) continue;
    const dir = res.filePaths[0];
    if (!isGaRoot(dir)) {
      reason = t(`${dir} 中没有 agentmain.py。`, `${dir} does not contain agentmain.py.`);
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
  const cfg = path.join(backend.dataDir().path, 'config.toml');
  const reason = value
    ? t(`配置的 GenericAgent 目录不可用：\n${value}\n（来自 ${source}；未找到 agentmain.py）`,
      `The configured GenericAgent folder is not usable:\n${value}\n(from ${source}; agentmain.py not found)`)
    : t(`尚未配置 GenericAgent 目录（没有 GA_ROOT，${cfg} 中也没有 ga_root）${
      backend.bundledGaError ? `，且内置副本无法准备：\n${backend.bundledGaError}` : '。'}`,
    `No GenericAgent folder is configured (no GA_ROOT, no ga_root in ${cfg})${
      backend.bundledGaError ? `, and the bundled copy could not be prepared:\n${backend.bundledGaError}` : '.'}`);
  return pickGaRoot(reason, value);
}

async function boot() {
  try {
    backend = new Backend(app.getPath('userData'), app.isPackaged ? process.resourcesPath : null, app.getVersion());
    initLanguage(backend.settings.file);
    if (!(await ensureGaRoot())) {
      app.exit(1);
      return;
    }
    backend.start();
    const url = await backend.waitReady();
    origin = new URL(url).origin;
    updater = new Updater({ getBackend: () => backend, getWindow: () => win, relaunch, prepareQuit, onState: sendUpdateState });
    registerBridge();
    createTray();
    createWindow(url);
    updater.schedule();
    backend.exited.then((code) => {
      if (quitting) return;
      dialog.showErrorBox('GenericAgent-Harness', t(`后端已停止（代码 ${code}）。\n\n${backend.tail.slice(-15).join('\n')}\n\n日志：${backend.logFile}`,
        `The backend stopped (code ${code}).\n\n${backend.tail.slice(-15).join('\n')}\n\nLog: ${backend.logFile}`));
      app.quit();
    });
  } catch (err) {
    const tail = backend ? backend.tail.slice(-15).join('\n') : '';
    const where = backend ? t(`\n\n日志：${backend.logFile}\n设置：${backend.settings.file}`, `\n\nLog: ${backend.logFile}\nSettings: ${backend.settings.file}`) : '';
    if (backend) await backend.stop(1000);
    // Downloaded code that does not start: blacklist it and fall back to the previous/built-in code.
    if (backend && backend.code.source === 'update' && backend.rejectUpdatedCode()) {
      await dialog.showMessageBox({
        type: 'warning', title: 'GenericAgent-Harness',
        message: t(`更新后的版本 ${backend.code.version} 启动失败`, `Updated version ${backend.code.version} failed to start`),
        detail: t(`将回退到上一个版本。\n\n${err.message}\n\n${tail}${where}`, `Falling back to the previous version.\n\n${err.message}\n\n${tail}${where}`),
        buttons: [t('确定', 'OK')], noLink: true,
      });
      app.relaunch();
      app.exit(1);
      return;
    }
    // A wrong-but-plausible GA folder only shows up once the backend runs: let the user re-pick.
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'GenericAgent-Harness',
      message: t('GenericAgent-Harness 启动失败', 'GenericAgent-Harness failed to start'),
      detail: `${err.message}\n\n${tail}${where}`,
      buttons: backend ? [t('退出', 'Quit'), t('选择 GenericAgent 目录…', 'Choose GenericAgent folder...')] : [t('退出', 'Quit')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1 && await pickGaRoot(t('请选择另一个 GenericAgent 目录。', 'Choose a different GenericAgent folder.'), backend.gaRoot().value)) {
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
