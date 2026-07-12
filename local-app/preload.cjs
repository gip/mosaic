const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mosaicLocal', {
  listServices: () => ipcRenderer.invoke('services:list'),
  startGuardian: (args) => ipcRenderer.invoke('services:start-guardian', args),
  startAgent: (args) => ipcRenderer.invoke('services:start-agent', args),
  stopService: (name) => ipcRenderer.invoke('services:stop', name),
  onStatus: (listener) => {
    const handler = (_event, statuses) => listener(statuses);
    ipcRenderer.on('services:status', handler);
    return () => ipcRenderer.removeListener('services:status', handler);
  },
});
