'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    const e = new Error(r.error);
    e.code = r.code;
    throw e;
  }
  return r.value;
}

const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  call,
  onJob: on('job'),
  onJobEvent: on('job-event'),
  onScanStep: on('scan-step'),
  onServersChanged: on('servers-changed'),
  onAccessesChanged: on('accesses-changed'),
});
