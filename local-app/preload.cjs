const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mosaicLocal', {
  listServices: () => ipcRenderer.invoke('services:list'),
  startGuardian: (args) => ipcRenderer.invoke('services:start-guardian', args),
  startAgent: (args) => ipcRenderer.invoke('services:start-agent', args),
  startSupervisor: (args) => ipcRenderer.invoke('supervisor:start', args),
  agentStart: (args) => ipcRenderer.invoke('agent:start', args),
  agentStop: (agentId) => ipcRenderer.invoke('agent:stop', agentId),
  agentList: () => ipcRenderer.invoke('agent:list'),
  agentStatus: (agentId) => ipcRenderer.invoke('agent:status', agentId),
  stopService: (name) => ipcRenderer.invoke('services:stop', name),
  onStatus: (listener) => {
    const handler = (_event, statuses) => listener(statuses);
    ipcRenderer.on('services:status', handler);
    return () => ipcRenderer.removeListener('services:status', handler);
  },
});
