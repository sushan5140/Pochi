const { contextBridge, ipcRenderer } = require('electron');

// Deliberately narrow — this window can only submit a label string or
// cancel, nothing else. It has no access to memoryStore, no access to
// any other IPC channel.
contextBridge.exposeInMainWorld('pochiProjectPrompt', {
  submit: (label) => ipcRenderer.send('pochi:project-prompt-submit', label),
  cancel: () => ipcRenderer.send('pochi:project-prompt-cancel')
});
