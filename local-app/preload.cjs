const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mosaicLocal', {
  listServices: () => ipcRenderer.invoke('services:list'),
  onStatus: (listener) => {
    const handler = (_event, statuses) => listener(statuses);
    ipcRenderer.on('services:status', handler);
    return () => ipcRenderer.removeListener('services:status', handler);
  },
});
