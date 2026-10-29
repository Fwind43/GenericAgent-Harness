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
  updates: Object.freeze({
    status: () => ipcRenderer.invoke('gah:update-status'),
    state: () => ipcRenderer.invoke('gah:update-state'),
    check: () => ipcRenderer.invoke('gah:update-check'),
    install: () => ipcRenderer.invoke('gah:update-install'),
    restart: () => ipcRenderer.invoke('gah:update-restart'),
    configure: (patch) => ipcRenderer.invoke('gah:update-config', patch || {}),
    // Subscriptions return an unsubscribe function.
    onState: (fn) => {
      const h = (_e, s) => fn(s);
      ipcRenderer.on('gah:update-state', h);
      return () => ipcRenderer.removeListener('gah:update-state', h);
    },
    onOpen: (fn) => {
      const h = () => fn();
      ipcRenderer.on('gah:update-open', h);
      return () => ipcRenderer.removeListener('gah:update-open', h);
    },
  }),
}));
