// preload.js - Context Bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  writePhotoFile: (filePath, buffer) => ipcRenderer.invoke('write-photo-file', filePath, buffer)
});
