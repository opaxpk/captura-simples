// Gravação: lado do programa (processo principal).
// - abre a janela "Gravar" (ui/gravar.html);
// - passa mensagens entre essa janela e a janela principal, que é quem grava
//   (é lá que a imagem e o som da placa já estão abertos);
// - escreve o ficheiro no disco aos bocados, à medida que chega;
// - pasta das gravações, espaço livre e uso do processador.
const { BrowserWindow, ipcMain, dialog, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

function ligarGravacao({ obterJanelaPrincipal, obterPastaUi, preload, icone, lerOpcoes, gravarOpcoes }) {
  let janelaGravar = null;
  let ultimoEstado = { aGravar: false };
  const ficheiros = new Map(); // id -> { fh, fila, caminho, bytes, erro }
  let proximoId = 1;
  let aSairDepoisDeParar = false;

  const principal = () => {
    const w = obterJanelaPrincipal();
    return w && !w.isDestroyed() ? w : null;
  };

  // ---------- Pasta ----------
  function pastaGravacoes() {
    const escolhida = lerOpcoes().pastaGravacoes;
    const pasta = escolhida || path.join(app.getPath('videos'), 'Captura Simples');
    fs.mkdirSync(pasta, { recursive: true });
    return pasta;
  }

  function espacoLivre(pasta) {
    try {
      const s = fs.statfsSync(pasta);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  function nomeFicheiro(extensao) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const base = `Captura ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    return `${base}.${extensao}`;
  }

  // ---------- Uso do processador pela app (todos os processos), em % do PC inteiro ----------
  function usoProcessador() {
    const total = app.getAppMetrics().reduce((soma, m) => soma + (m.cpu ? m.cpu.percentCPUUsage : 0), 0);
    return Math.round((total / Math.max(1, os.cpus().length)) * 10) / 10;
  }

  // ---------- Janela "Gravar" ----------
  function abrirJanela() {
    if (janelaGravar && !janelaGravar.isDestroyed()) {
      if (janelaGravar.isMinimized()) janelaGravar.restore();
      janelaGravar.focus();
      return;
    }
    const p = principal();
    let posicao = {};
    if (p) {
      // Ao lado direito da janela principal, se couber
      const b = p.getBounds();
      posicao = { x: b.x + b.width - 380 - 24, y: b.y + 72 };
    }
    janelaGravar = new BrowserWindow({
      width: 380,
      height: 620,
      minWidth: 340,
      minHeight: 480,
      ...posicao,
      title: 'Gravar',
      backgroundColor: '#1b1d21',
      icon: icone,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    janelaGravar.removeMenu();
    janelaGravar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    janelaGravar.webContents.on('will-navigate', (e) => e.preventDefault());
    janelaGravar.once('ready-to-show', () => janelaGravar.show());
    janelaGravar.on('closed', () => { janelaGravar = null; });
    janelaGravar.loadFile(path.join(obterPastaUi(), 'gravar.html'));
  }

  // ---------- Mensagens ----------
  ipcMain.handle('grav:janela', () => { abrirJanela(); return true; });

  // Da janela "Gravar" para a janela principal
  ipcMain.on('grav:comando', (_e, comando) => {
    const p = principal();
    if (p && comando && typeof comando.acao === 'string') p.webContents.send('grav:comando', comando);
  });

  // Da janela principal para a janela "Gravar"
  ipcMain.on('grav:estado', (_e, estado) => {
    ultimoEstado = estado || { aGravar: false };
    if (janelaGravar && !janelaGravar.isDestroyed()) janelaGravar.webContents.send('grav:estado', ultimoEstado);
    if (aSairDepoisDeParar && !ultimoEstado.aGravar && !ultimoEstado.aGuardar) {
      aSairDepoisDeParar = false;
      const p = principal();
      if (p) p.destroy();
    }
  });
  ipcMain.handle('grav:estadoAtual', () => ultimoEstado);

  ipcMain.handle('grav:info', () => {
    const pasta = pastaGravacoes();
    return { pasta, livre: espacoLivre(pasta), cpu: usoProcessador() };
  });

  ipcMain.handle('grav:escolherPasta', async (e) => {
    const dono = BrowserWindow.fromWebContents(e.sender) || undefined;
    const r = await dialog.showOpenDialog(dono, {
      title: 'Escolher a pasta das gravações',
      defaultPath: pastaGravacoes(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    gravarOpcoes({ pastaGravacoes: r.filePaths[0] });
    return pastaGravacoes();
  });

  ipcMain.handle('grav:abrirPasta', () => shell.openPath(pastaGravacoes()));
  ipcMain.handle('grav:mostrarFicheiro', (_e, caminho) => {
    // Só ficheiros que esta sessão gravou ou que estão na pasta das gravações
    if (typeof caminho === 'string' && path.dirname(caminho) === pastaGravacoes() && fs.existsSync(caminho)) {
      shell.showItemInFolder(caminho);
    }
  });

  // ---------- Ficheiro: abrir, escrever aos bocados, fechar ----------
  ipcMain.handle('grav:abrirFicheiro', async (_e, extensao) => {
    if (!/^(mp4|webm)$/.test(extensao)) throw new Error('Formato de ficheiro inválido.');
    const pasta = pastaGravacoes();
    const livre = espacoLivre(pasta);
    if (livre !== null && livre < 500 * 1024 * 1024) {
      throw new Error('Há menos de 500 MB livres na pasta das gravações. Liberta espaço ou escolhe outra pasta.');
    }
    const caminho = path.join(pasta, nomeFicheiro(extensao));
    const fh = await fs.promises.open(caminho, 'wx');
    const id = proximoId++;
    ficheiros.set(id, { fh, fila: Promise.resolve(), caminho, bytes: 0, fim: 0, erro: null });
    return { id, caminho, nome: path.basename(caminho), pasta };
  });

  // Cada bocado é escrito pela ordem de chegada, na posição indicada (ou no fim, se não vier posição)
  ipcMain.on('grav:dados', (_e, id, dados, posicao) => {
    const f = ficheiros.get(id);
    if (!f || f.erro || !dados) return;
    const buf = Buffer.from(dados.buffer ? new Uint8Array(dados.buffer, dados.byteOffset, dados.byteLength) : dados);
    const pos = Number.isFinite(posicao) ? posicao : f.fim;
    f.fim = Math.max(f.fim, pos + buf.length);
    f.bytes = f.fim;
    f.fila = f.fila
      .then(() => (f.erro ? null : f.fh.write(buf, 0, buf.length, pos)))
      .catch((err) => { f.erro = err; });
  });

  ipcMain.handle('grav:fecharFicheiro', async (_e, id) => {
    const f = ficheiros.get(id);
    if (!f) return null;
    ficheiros.delete(id);
    await f.fila;
    await f.fh.close().catch(() => {});
    if (f.erro) throw new Error(`Não foi possível gravar no disco: ${f.erro.message}`);
    return { caminho: f.caminho, nome: path.basename(f.caminho), bytes: f.bytes };
  });

  ipcMain.handle('grav:erroEscrita', (_e, id) => {
    const f = ficheiros.get(id);
    return f && f.erro ? f.erro.message : null;
  });

  // ---------- Fechar a app a meio de uma gravação: parar e guardar primeiro ----------
  function aoFecharPrincipal(e) {
    if (!ultimoEstado.aGravar && !ultimoEstado.aGuardar && !ultimoEstado.aPreparar) {
      if (janelaGravar && !janelaGravar.isDestroyed()) janelaGravar.close();
      return;
    }
    e.preventDefault();
    if (aSairDepoisDeParar) return;
    aSairDepoisDeParar = true;
    const p = principal();
    if (p) p.webContents.send('grav:comando', { acao: 'parar', motivo: 'A app foi fechada' });
    // Se o renderer não responder, fecha na mesma ao fim de 8 s (o ficheiro fica com o que já foi escrito)
    setTimeout(() => {
      if (!aSairDepoisDeParar) return;
      for (const f of ficheiros.values()) f.fila.then(() => f.fh.close()).catch(() => {});
      const q = principal();
      if (q) q.destroy();
    }, 8000);
  }

  return { abrirJanela, aoFecharPrincipal, janela: () => janelaGravar };
}

module.exports = { ligarGravacao };
