const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  let active = true;
  const receive = (_event, state) => { if (active) callback(state); };
  ipcRenderer.on(channel, receive);
  // Catch events that arrived while the island was loading.
  ipcRenderer.invoke(channel).then(state => receive(undefined, state)).catch(() => {});
  return () => {
    active = false;
    ipcRenderer.removeListener(channel, receive);
  };
}

contextBridge.exposeInMainWorld('coconuts', {
  onAgentState: callback => subscribe('agent-state', callback),
  setup: {
    state: () => ipcRenderer.invoke('hook-setup-state'),
    subscribe: callback => subscribe('hook-setup-state', callback),
    install: selected => ipcRenderer.invoke('hook-setup-install', selected),
    dismiss: () => ipcRenderer.invoke('hook-setup-dismiss'),
    openAgent: provider => ipcRenderer.invoke('hook-setup-open', provider),
    showConfig: provider => ipcRenderer.invoke('hook-setup-config', provider),
  },
  markRead: id => ipcRenderer.invoke('agent-read', id),
  answer: (id, answers) => ipcRenderer.invoke('agent-answer', id, answers),
  copyReply: (id, answers) => ipcRenderer.invoke('agent-copy-reply', id, answers),
  openAgent: id => ipcRenderer.invoke('open-agent', id),
  // A user activation lets the island lock the mouse when the window gains focus, without a click.
  activate: () => ipcRenderer.invoke('activate'),
});
