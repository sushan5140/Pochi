const { contextBridge, ipcRenderer } = require('electron');

// Deliberately narrow surface — list/delete/export only. There is no
// write/create call exposed here: the only writers are the read-only
// integration points in main.js (productivityMode's onPomodoroPhaseChange
// callback, resolveNag()), never this window.
contextBridge.exposeInMainWorld('pochiMemory', {
  list: () => ipcRenderer.invoke('pochi:memory-list'),
  deleteEntry: (id) => ipcRenderer.invoke('pochi:memory-delete', id),
  deleteAll: () => ipcRenderer.invoke('pochi:memory-delete-all'),
  exportToFile: () => ipcRenderer.invoke('pochi:memory-export'),
  // Chapter 22: read-only, same narrow-surface reasoning as everything
  // else exposed here — no write path added.
  transparencyList: () => ipcRenderer.invoke('pochi:transparency-list')
});
