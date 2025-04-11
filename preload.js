// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startScanning: (subtaskId) => ipcRenderer.invoke('startScanning', subtaskId),
  stopScanning: () => ipcRenderer.invoke('stopScanning')
});
