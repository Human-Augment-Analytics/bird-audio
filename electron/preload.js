const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  runFiles: (files) => ipcRenderer.invoke('run-files', files),
  onProgress: (cb) => ipcRenderer.on('progress', (e, d) => cb(d)),
  onResult: (cb) => ipcRenderer.on('result', (e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (e, d) => cb(d))
})
