// The profile picker window's bridge: three calls, nothing else of the
// app's IPC surface (this window never shows app content).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profilePicker', {
  list: () => ipcRenderer.invoke('profiles:list'),
  create: (name) => ipcRenderer.invoke('profiles:create', name),
  choose: (name, remember) => ipcRenderer.invoke('profiles:choose', name, remember === true),
});
