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
  // Island preferences for the settings page; null when this shell has no island.
  islandPrefs: Object.freeze({
    get: () => ipcRenderer.invoke('gah:island-prefs-get'),
    set: (patch) => ipcRenderer.invoke('gah:island-prefs-set', patch || {}),
  }),
  // Used by the web-island page inside the floating island window.
  island: Object.freeze({
    layout: (box) => ipcRenderer.send('gah:island-layout', box || {}),
    drag: (phase, x, y) => ipcRenderer.send('gah:island-drag', String(phase), Number(x) || 0, Number(y) || 0),
    openMain: () => ipcRenderer.send('gah:island-open-main'),
    onState: (fn) => {
      const h = (_e, s) => fn(s || {});
      ipcRenderer.on('gah:island-state', h);
      return () => ipcRenderer.removeListener('gah:island-state', h);
    },
  }),
}));
