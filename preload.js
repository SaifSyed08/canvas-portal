const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = channel => fn => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('portal', {
  state: () => ipcRenderer.invoke('state:get'),
  setBase: base => ipcRenderer.invoke('canvas:setBase', base),
  login: () => ipcRenderer.invoke('canvas:login'),
  signOut: () => ipcRenderer.invoke('canvas:signout'),
  saveLogin: (user, pass) => ipcRenderer.invoke('login:save', { user, pass }),
  forgetLogin: () => ipcRenderer.invoke('login:forget'),
  upcoming: () => ipcRenderer.invoke('canvas:upcoming'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  addFiles: files => ipcRenderer.invoke('files:add', [...files].map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  send: (text, files) => ipcRenderer.invoke('chat:send', { text, files }),
  stop: () => ipcRenderer.invoke('chat:stop'),
  newChat: () => ipcRenderer.invoke('chat:new'),
  proposalAlive: id => ipcRenderer.invoke('proposal:alive', id),
  confirm: id => ipcRenderer.invoke('proposal:confirm', id),
  dismiss: id => ipcRenderer.invoke('proposal:dismiss', id),
  open: url => ipcRenderer.invoke('open:external', url),
  onChat: on('chat:event'),
  onState: on('state:changed'),
  onLoginStatus: on('login:status')
});
