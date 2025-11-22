// preload.js - Context Bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getServerUrl: () => ipcRenderer.invoke('get-server-url')
});
