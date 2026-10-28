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
    check: () => ipcRenderer.invoke('gah:update-check'),
    configure: (patch) => ipcRenderer.invoke('gah:update-config', patch || {}),
  }),
}));
