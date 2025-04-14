// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    startScanning: async (taskId, subtaskId, criteria) => {
        try {
            return await ipcRenderer.invoke('startScanning', taskId, subtaskId, criteria);
        } catch (error) {
            console.error('Error in startScanning:', error);
            return { success: false, message: error.message || 'Unknown error occurred' };
        }
    },
    stopScanning: async () => {
        try {
            return await ipcRenderer.invoke('stopScanning');
        } catch (error) {
            console.error('Error in stopScanning:', error);
            return { success: false, message: error.message || 'Unknown error occurred' };
        }
    }
});
