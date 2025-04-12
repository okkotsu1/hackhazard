// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startScanning: (taskId, subtaskId, criteria) =>
    ipcRenderer.invoke('startScanning', taskId, subtaskId, criteria),
  stopScanning: () => ipcRenderer.invoke('stopScanning')
});
