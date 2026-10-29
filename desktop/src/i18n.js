// Main-process strings (tray menu, native dialogs) follow the web UI language. The renderer
// reports its language (localStorage "gah-lang", else the browser locale) on every load; it is
// remembered in desktop.json ("lang") so the tray and startup dialogs use it on the next launch
// before any window exists. Until then the OS locale decides.
'use strict';

const { app } = require('electron');
const { editSettingsFile, readSettingsFile } = require('./backend');

let lang = null;
let file = null;

const valid = (l) => l === 'zh' || l === 'en';

function osLanguage() {
  try { return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'; } catch { return 'en'; }
}

// Call once after app is ready, with the desktop.json path.
function initLanguage(settingsFile) {
  file = settingsFile;
  let saved = null;
  try { saved = readSettingsFile(settingsFile).lang; } catch { /* unreadable settings: use the OS locale */ }
  lang = valid(saved) ? saved : osLanguage();
}

function language() {
  return lang || osLanguage();
}

// Returns true when the language changed (the caller rebuilds the tray menu).
function setLanguage(next) {
  if (!valid(next) || next === lang) return false;
  lang = next;
  if (file) { try { editSettingsFile(file, (data) => { data.lang = next; }); } catch { /* best effort */ } }
  return true;
}

const t = (zh, en) => (language() === 'zh' ? zh : en);

module.exports = { t, language, setLanguage, initLanguage };
