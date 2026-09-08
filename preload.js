const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pochi', {
  onState: (callback) => {
    ipcRenderer.on('pochi:state', (_event, data) => callback(data));
  },
  // Chapter 23: pushed once at startup and whenever Do Not Disturb or the
  // tray's sound level changes — audioPlayer.js is the sole subscriber.
  onAudioSettings: (callback) => {
    ipcRenderer.on('pochi:audio-settings', (_event, data) => callback(data));
  },
  // Synchronous on purpose: mousemove uses this to flip the OS-level
  // click-through state before the user's click can arrive. An async
  // send() left a real gap — a click physically occurring before the IPC
  // round-trip completed would pass straight through the window with
  // nothing on the renderer side able to see or log it. sendSync blocks
  // this handler until the main process has actually applied the change.
  setIgnoreMouse: (ignore) => ipcRenderer.sendSync('pochi:set-ignore-mouse', ignore),
  resolveNag: (type) => ipcRenderer.send('pochi:resolve-nag', type),
  gameClick: () => ipcRenderer.send('pochi:game-click'),
  togglePomodoro: () => ipcRenderer.send('pochi:toggle-pomodoro'),
  dragStart: () => ipcRenderer.send('pochi:drag-start'),
  dragEnd: (pos) => ipcRenderer.send('pochi:drag-end', pos),
  settled: (info) => ipcRenderer.send('pochi:settled', info)
});
