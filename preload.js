const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('janela', {
  setFullscreen: (estado) => ipcRenderer.invoke('fullscreen:set', estado),
  toggleFullscreen: () => ipcRenderer.invoke('fullscreen:toggle'),
  isFullscreen: () => ipcRenderer.invoke('fullscreen:get'),
  onFullscreenChange: (callback) => {
    ipcRenderer.on('fullscreen-changed', (_e, estado) => callback(estado));
  },
  setSempreCima: (estado) => ipcRenderer.invoke('janela:sempreCima', estado),
  lerOpcoes: () => ipcRenderer.invoke('opcoes:ler'),
  gravarOpcoes: (opcoes) => ipcRenderer.invoke('opcoes:gravar', opcoes),
});

contextBridge.exposeInMainWorld('atualizacao', {
  info: () => ipcRenderer.invoke('atualizacao:info'),
  verificar: () => ipcRenderer.invoke('atualizacao:verificar'),
  aplicar: () => ipcRenderer.invoke('atualizacao:aplicar'),
  aplicarCompleta: () => ipcRenderer.invoke('atualizacao:aplicarCompleta'),
  onProgresso: (callback) => {
    ipcRenderer.on('atualizacao:progresso', (_e, p) => callback(p));
  },
  abrirPagina: () => ipcRenderer.invoke('atualizacao:pagina'),
  pronto: () => ipcRenderer.send('atualizacao:pronto'),
});

contextBridge.exposeInMainWorld('gravacao', {
  // Janela principal (é quem grava)
  abrirJanela: () => ipcRenderer.invoke('grav:janela'),
  abrirFicheiro: (extensao) => ipcRenderer.invoke('grav:abrirFicheiro', extensao),
  enviarDados: (id, dados, posicao) => ipcRenderer.send('grav:dados', id, dados, posicao),
  fecharFicheiro: (id) => ipcRenderer.invoke('grav:fecharFicheiro', id),
  erroEscrita: (id) => ipcRenderer.invoke('grav:erroEscrita', id),
  publicarEstado: (estado) => ipcRenderer.send('grav:estado', estado),
  onComando: (callback) => ipcRenderer.on('grav:comando', (_e, comando) => callback(comando)),
  // Janela "Gravar" (os botões)
  comando: (comando) => ipcRenderer.send('grav:comando', comando),
  onEstado: (callback) => ipcRenderer.on('grav:estado', (_e, estado) => callback(estado)),
  estadoAtual: () => ipcRenderer.invoke('grav:estadoAtual'),
  info: () => ipcRenderer.invoke('grav:info'),
  escolherPasta: () => ipcRenderer.invoke('grav:escolherPasta'),
  abrirPasta: () => ipcRenderer.invoke('grav:abrirPasta'),
  mostrarFicheiro: (caminho) => ipcRenderer.invoke('grav:mostrarFicheiro', caminho),
  ecras: () => ipcRenderer.invoke('grav:ecras'),
  escolherEcra: (id) => ipcRenderer.invoke('grav:escolherEcra', id),
});

// Som de cada programa e mesa de som
contextBridge.exposeInMainWorld('som', {
  // Janela principal
  info: () => ipcRenderer.invoke('som:info'),
  gravar: (ativo) => ipcRenderer.invoke('som:gravar', ativo),
  publicarNiveis: (niveis) => ipcRenderer.send('som:niveisJanela', niveis),
  onVigiar: (callback) => ipcRenderer.on('som:vigiar', (_e, ativo) => callback(ativo)),
  onDados: (callback) => ipcRenderer.on('som:dados', (_e, programa, pid, dados, tempo) => callback(programa, pid, dados, tempo)),
  onErro: (callback) => ipcRenderer.on('som:erro', (_e, programa, nome, erro) => callback(programa, nome, erro)),
  // Janela "Gravar"
  onNiveis: (callback) => ipcRenderer.on('som:niveis', (_e, niveis) => callback(niveis)),
  janelaPronta: () => ipcRenderer.send('som:janelaPronta'),
});
