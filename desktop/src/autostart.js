// Launch at login. Windows/macOS use Electron's login items; Linux writes an XDG autostart
// entry. The login launch passes --hidden so the app starts in the tray without a window.
// Only packaged builds register (a dev run would register the bare electron binary).
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HIDDEN_ARG = '--hidden';
// Windows: fixed HKCU\...\Run value name (the NSIS uninstaller deletes it, see installer.nsh).
const WIN_NAME = 'GenericAgent-Harness';

function supported() {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') return Boolean(linuxExec());
  return process.platform === 'win32' || process.platform === 'darwin';
}

// AppImage runs from a temp mount; the stable path is $APPIMAGE.
function linuxExec() {
  return process.env.APPIMAGE || process.execPath || null;
}

function linuxFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'genericagent-harness.desktop');
}

function isEnabled() {
  if (!supported()) return false;
  try {
    if (process.platform === 'linux') return fs.existsSync(linuxFile());
    if (process.platform === 'win32') return app.getLoginItemSettings({ name: WIN_NAME, path: process.execPath, args: [HIDDEN_ARG] }).openAtLogin;
    return app.getLoginItemSettings().openAtLogin;
  } catch { return false; }
}

function setEnabled(on) {
  if (!supported()) throw new Error('launch at login is not supported here');
  on = Boolean(on);
  if (process.platform === 'linux') {
    const file = linuxFile();
    if (on) {
      const exec = linuxExec().replace(/(["\\`$])/g, '\\$1');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        '[Desktop Entry]', 'Type=Application', 'Name=GenericAgent-Harness',
        `Exec="${exec}" ${HIDDEN_ARG}`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', '',
      ].join('\n'));
    } else {
      try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  } else if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: on, name: WIN_NAME, path: process.execPath, args: [HIDDEN_ARG] });
  } else {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  }
  return isEnabled();
}

// True when this process was started by the login item (start in the tray).
function launchedHidden() {
  if (process.argv.includes(HIDDEN_ARG)) return true;
  if (process.platform === 'darwin') {
    try {
      const s = app.getLoginItemSettings();
      return Boolean(s.wasOpenedAtLogin || s.wasOpenedAsHidden);
    } catch { return false; }
  }
  return false;
}

module.exports = { supported, isEnabled, setEnabled, launchedHidden };
