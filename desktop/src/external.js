// Open http(s) links in the system browser. On macOS shell.openExternal can resolve without
// doing anything (or reject) for ad-hoc signed / translocated builds, so /usr/bin/open goes
// first there and shell.openExternal is only the fallback; elsewhere it is the other way round.
'use strict';

const { shell } = require('electron');
const { spawn } = require('node:child_process');

function isWebUrl(url) { return /^https?:\/\//i.test(String(url || '')); }

function macOpen(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited ${code}`))));
  });
}

async function openExternal(url) {
  const target = String(url || '');
  if (!isWebUrl(target)) throw new Error('forbidden');
  if (process.platform === 'darwin') {
    try { await macOpen(target); return true; } catch (err) { console.error('open failed:', err); }
  }
  await shell.openExternal(target);
  return true;
}

// Fire-and-forget variant for event handlers: never leaves an unhandled rejection behind.
function openExternalQuiet(url) {
  if (!isWebUrl(url)) return;
  openExternal(url).catch((err) => console.error('openExternal failed:', url, err));
}

module.exports = { isWebUrl, openExternal, openExternalQuiet };
