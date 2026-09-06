'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'login', 'cancel-login', 'logout', 'choose-folder', 'list-folders', 'open-share', 'save-job',
  'toggle-job', 'remove-job', 'check-job', 'set-interval', 'pause', 'notifications', 'autostart', 'open-destination', 'quit', 'hide']);
contextBridge.exposeInMainWorld('archive', {
  async call(method, ...args) {
    if (!allowed.has(method)) throw new Error('不支持的操作');
    const result = await ipcRenderer.invoke('archive:' + method, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onState(callback) { const listener = (_event, state) => callback(state); ipcRenderer.on('archive:state', listener); return () => ipcRenderer.removeListener('archive:state', listener); }
});
