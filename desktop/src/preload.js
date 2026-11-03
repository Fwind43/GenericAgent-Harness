// Minimal, capability-shaped bridge. Web plugins feature-detect `window.gahDesktop` and fall
// back to browser behaviour when it is absent; no Node or Electron object is exposed.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gahDesktop', Object.freeze({
  version: 1,
  platform: process.platform,
  pickDirectory: (opts) => ipcRenderer.invoke('gah:pick-directory', opts || {}),
  openPath: (target) => ipcRenderer.invoke('gah:open-path', target),
  openExternal: (url) => ipcRenderer.invoke('gah:open-external', url),
  gaRoot: Object.freeze({
    info: () => ipcRenderer.invoke('gah:ga-root-info'),
    choose: () => ipcRenderer.invoke('gah:ga-root-choose'),
    set: (mode) => ipcRenderer.invoke('gah:ga-root-set', mode),
    restart: (force) => ipcRenderer.invoke('gah:ga-root-restart', !!force),
  }),
  setLanguage: (lang) => ipcRenderer.send('gah:set-lang', lang),
  autostart: Object.freeze({
    get: () => ipcRenderer.invoke('gah:autostart-get'),
    set: (on) => ipcRenderer.invoke('gah:autostart-set', !!on),
  }),
  updates: Object.freeze({
    status: () => ipcRenderer.invoke('gah:update-status'),
    state: () => ipcRenderer.invoke('gah:update-state'),
    check: () => ipcRenderer.invoke('gah:update-check'),
    install: () => ipcRenderer.invoke('gah:update-install'),
    installShell: () => ipcRenderer.invoke('gah:update-install-shell'),
    cancel: () => ipcRenderer.invoke('gah:update-cancel'),
    restart: () => ipcRenderer.invoke('gah:update-restart'),
    configure: (patch) => ipcRenderer.invoke('gah:update-config', patch || {}),
    // Subscriptions return an unsubscribe function.
    onState: (fn) => {
      const h = (_e, s) => fn(s);
      ipcRenderer.on('gah:update-state', h);
      return () => ipcRenderer.removeListener('gah:update-state', h);
    },
    onOpen: (fn) => {
      const h = (_e, opts) => fn(opts || {});
      ipcRenderer.on('gah:update-open', h);
      return () => ipcRenderer.removeListener('gah:update-open', h);
    },
  }),
  // Main page: hand the shell the desktop windows that active web plugins declare
  // (web_plugins[].desktop from /api/state); the shell opens/closes windows to match.
  setPluginWindows: (plugins) => ipcRenderer.send('gah:plugin-windows', Array.isArray(plugins) ? plugins : []),
  openPluginWindow: (key) => ipcRenderer.send('gah:plugin-open', String(key || '')),
  // Plugin pages inside shell windows (also usable from the main page: notify/flashFrame).
  plugin: Object.freeze({
    layout: (box) => ipcRenderer.send('gah:plugin-layout', box || {}),
    drag: (phase, x, y) => ipcRenderer.send('gah:plugin-drag', String(phase), Number(x) || 0, Number(y) || 0),
    openMain: () => ipcRenderer.send('gah:plugin-open-main'),
    notify: (opts) => ipcRenderer.send('gah:plugin-notify', opts && typeof opts === 'object' ? { title: String(opts.title || ''), body: String(opts.body || ''), silent: !!opts.silent } : {}),
    flashFrame: (on) => ipcRenderer.send('gah:plugin-flash', on !== false),
    // State: { mainFocused, plugin, window, kind, data } where data is the declaration's data.
    onState: (fn) => {
      const h = (_e, s) => fn(s || {});
      ipcRenderer.on('gah:plugin-state', h);
      return () => ipcRenderer.removeListener('gah:plugin-state', h);
    },
  }),
}));
