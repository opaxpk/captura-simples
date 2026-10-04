const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('janela', {
  setFullscreen: (estado) => ipcRenderer.invoke('fullscreen:set', estado),
  toggleFullscreen: () => ipcRenderer.invoke('fullscreen:toggle'),
  isFullscreen: () => ipcRenderer.invoke('fullscreen:get'),
  onFullscreenChange: (callback) => {
    ipcRenderer.on('fullscreen-changed', (_e, estado) => callback(estado));
  },
});

contextBridge.exposeInMainWorld('atualizacao', {
  info: () => ipcRenderer.invoke('atualizacao:info'),
  verificar: () => ipcRenderer.invoke('atualizacao:verificar'),
  aplicar: () => ipcRenderer.invoke('atualizacao:aplicar'),
  abrirPagina: () => ipcRenderer.invoke('atualizacao:pagina'),
  pronto: () => ipcRenderer.send('atualizacao:pronto'),
});
