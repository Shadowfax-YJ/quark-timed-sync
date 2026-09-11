'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'login', 'cancel-login', 'logout', 'choose-folder', 'list-folders', 'open-share', 'save-job',
  'configure-plugin', 'disable-plugins', 'retry-plugins',
  'toggle-job', 'remove-job', 'check-job', 'set-interval', 'pause', 'notifications', 'autostart', 'open-destination', 'quit', 'hide',
  'auto-updates', 'check-update', 'install-update', 'release-page',
  'logs-query', 'logs-settings', 'logs-clear', 'logs-copy', 'logs-export', 'logs-open']);
contextBridge.exposeInMainWorld('archive', {
  async call(method, ...args) {
    if (!allowed.has(method)) throw new Error('不支持的操作');
    const result = await ipcRenderer.invoke('archive:' + method, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onState(callback) { const listener = (_event, state) => callback(state); ipcRenderer.on('archive:state', listener); return () => ipcRenderer.removeListener('archive:state', listener); },
  onLogsChanged(callback) { const listener = () => callback(); ipcRenderer.on('archive:logs-changed', listener); return () => ipcRenderer.removeListener('archive:logs-changed', listener); }
});
