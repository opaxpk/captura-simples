const { app, BrowserWindow, ipcMain, session, Menu, nativeTheme, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pkg = require('./package.json');

// O áudio arranca sem ser preciso clicar, e o Chromium não abranda a janela em segundo plano
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Só uma instância: duas janelas a disputar a mesma placa dava erro
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

// =====================================================================
// Atualizações
// ---------------------------------------------------------------------
// O programa tem duas partes:
//  - a base (Electron, main.js, preload.js), que só muda com um .exe novo;
//  - o conteúdo (index.html, renderer.js, styles.css), que se atualiza
//    descarregando só esses ficheiros (poucos KB) das versões no GitHub.
// "versaoBase" no package.json diz que base cada versão precisa. Se mudar,
// a atualização é completa e o utilizador descarrega o .exe novo.
// =====================================================================
const VERSAO_BASE = pkg.versaoBase;
const REPOSITORIO = (pkg.atualizacoes && pkg.atualizacoes.repositorio) || '';
const API_GITHUB = process.env.CAPTURA_API || 'https://api.github.com';
const FICHEIROS_CONTEUDO = ['index.html', 'renderer.js', 'styles.css'];

let versaoConteudo = app.getVersion();
let aUsarConteudoDescarregado = false;
let temporizadorPronto = null;
let ultimaVerificacao = null;

const pastaConteudo = () => path.join(app.getPath('userData'), 'conteudo');
const ficheiroAtual = () => path.join(pastaConteudo(), 'atual.json');

function compararVersoes(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// Conteúdo descarregado válido, compatível com esta base e mais recente que o que vem no .exe
function conteudoInstalado() {
  try {
    const info = JSON.parse(fs.readFileSync(ficheiroAtual(), 'utf8'));
    if (info.versaoBase !== VERSAO_BASE) return null;
    if (compararVersoes(info.versao, app.getVersion()) <= 0) return null;
    const pasta = path.join(pastaConteudo(), info.versao);
    if (!FICHEIROS_CONTEUDO.every((f) => fs.existsSync(path.join(pasta, f)))) return null;
    return { versao: info.versao, pasta };
  } catch {
    return null;
  }
}

function carregarConteudo() {
  if (!win) return;
  clearTimeout(temporizadorPronto);
  const instalado = conteudoInstalado();

  if (instalado) {
    versaoConteudo = instalado.versao;
    aUsarConteudoDescarregado = true;
    win.loadFile(path.join(instalado.pasta, 'index.html'));
    // Rede de segurança: se a versão descarregada não arrancar em 10 s, volta à que vem no .exe
    temporizadorPronto = setTimeout(() => desistirDoConteudo('não arrancou'), 10000);
  } else {
    versaoConteudo = app.getVersion();
    aUsarConteudoDescarregado = false;
    win.loadFile(path.join(__dirname, 'index.html'));
  }
}

function desistirDoConteudo(motivo) {
  if (!aUsarConteudoDescarregado) return;
  console.error(`Conteúdo descarregado ignorado (${motivo}); a usar o que vem no programa.`);
  try { fs.renameSync(ficheiroAtual(), path.join(pastaConteudo(), 'atual.falhou.json')); } catch { /* */ }
  carregarConteudo();
}

async function obterJson(url) {
  const r = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CapturaSimples' },
  });
  if (r.status === 404) throw new Error('Ainda não há nenhuma versão publicada no GitHub.');
  if (r.status === 403) throw new Error('O GitHub limitou os pedidos. Tenta outra vez daqui a uma hora.');
  if (!r.ok) throw new Error(`O GitHub respondeu com o erro ${r.status}.`);
  return r.json();
}

async function verificarAtualizacao() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPOSITORIO) || REPOSITORIO.startsWith('UTILIZADOR/')) {
    throw new Error('As atualizações ainda não estão configuradas (falta o repositório no package.json).');
  }
  let release;
  try {
    release = await obterJson(`${API_GITHUB}/repos/${REPOSITORIO}/releases/latest`);
  } catch (e) {
    if (/fetch|net::|ENOTFOUND|ERR_/i.test(e.message)) throw new Error('Sem ligação à internet.');
    throw e;
  }
  const ativo = (release.assets || []).find((a) => a.name === 'atualizacao.json');
  if (!ativo) throw new Error('A versão publicada não tem o ficheiro atualizacao.json.');
  const manifesto = await obterJson(ativo.browser_download_url);

  ultimaVerificacao = { release, manifesto };
  const base = {
    atual: versaoConteudo,
    nova: manifesto.versao,
    notas: (release.body || '').trim(),
    pagina: release.html_url,
  };
  if (compararVersoes(manifesto.versao, versaoConteudo) <= 0) return { ...base, estado: 'atualizado' };
  return { ...base, estado: manifesto.versaoBase === VERSAO_BASE ? 'conteudo' : 'completa' };
}

async function aplicarAtualizacao() {
  if (!ultimaVerificacao) throw new Error('Procura atualizações primeiro.');
  const { release, manifesto } = ultimaVerificacao;
  if (manifesto.versaoBase !== VERSAO_BASE) throw new Error('Esta versão precisa do programa novo (.exe).');
  if (!/^\d+\.\d+\.\d+$/.test(manifesto.versao)) throw new Error('Número de versão inválido.');

  const destino = path.join(pastaConteudo(), manifesto.versao);
  const temporaria = `${destino}.parcial`;
  fs.rmSync(temporaria, { recursive: true, force: true });
  fs.mkdirSync(temporaria, { recursive: true });

  try {
    for (const [nome, hashEsperado] of Object.entries(manifesto.ficheiros || {})) {
      if (!/^[\w.-]+$/.test(nome)) throw new Error(`Nome de ficheiro inválido: ${nome}`);
      const ativo = release.assets.find((a) => a.name === nome);
      if (!ativo) throw new Error(`Falta o ficheiro ${nome} na versão publicada.`);
      const r = await net.fetch(ativo.browser_download_url, { headers: { 'User-Agent': 'CapturaSimples' } });
      if (!r.ok) throw new Error(`Não foi possível descarregar ${nome} (erro ${r.status}).`);
      const dados = Buffer.from(await r.arrayBuffer());
      const hash = crypto.createHash('sha256').update(dados).digest('hex');
      if (hash !== hashEsperado) throw new Error(`O ficheiro ${nome} chegou corrompido. Tenta outra vez.`);
      fs.writeFileSync(path.join(temporaria, nome), dados);
    }
    if (!FICHEIROS_CONTEUDO.every((f) => fs.existsSync(path.join(temporaria, f)))) {
      throw new Error('A atualização está incompleta.');
    }
  } catch (e) {
    fs.rmSync(temporaria, { recursive: true, force: true });
    throw e;
  }

  fs.rmSync(destino, { recursive: true, force: true });
  fs.renameSync(temporaria, destino);
  fs.writeFileSync(ficheiroAtual(), JSON.stringify({ versao: manifesto.versao, versaoBase: VERSAO_BASE }));

  // Apagar versões antigas
  for (const nome of fs.readdirSync(pastaConteudo())) {
    if (nome !== 'atual.json' && nome !== manifesto.versao) {
      fs.rmSync(path.join(pastaConteudo(), nome), { recursive: true, force: true });
    }
  }

  setTimeout(carregarConteudo, 600);
  return { versao: manifesto.versao };
}

// =====================================================================
// Janela
// =====================================================================
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#000000',
    title: 'Captura Simples',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', () => desistirDoConteudo('falhou a carregar'));
  // Links externos abrem no browser, nunca dentro da app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  carregarConteudo();

  const avisar = (estado) => {
    if (win && !win.isDestroyed()) win.webContents.send('fullscreen-changed', estado);
  };
  win.on('enter-full-screen', () => avisar(true));
  win.on('leave-full-screen', () => avisar(false));
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark'; // barra de título escura no Windows 11

  // Aprovar automaticamente câmara/microfone
  const ses = session.defaultSession;
  const permitido = (p) => p === 'media' || p === 'fullscreen';
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permitido(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => permitido(permission));

  // Ecrã inteiro controlado por IPC
  ipcMain.handle('fullscreen:set', (_e, estado) => {
    if (!win) return false;
    win.setFullScreen(!!estado);
    return !!estado;
  });
  ipcMain.handle('fullscreen:toggle', () => {
    if (!win) return false;
    const novo = !win.isFullScreen();
    win.setFullScreen(novo);
    return novo;
  });
  ipcMain.handle('fullscreen:get', () => (win ? win.isFullScreen() : false));

  // Atualizações
  ipcMain.handle('atualizacao:info', () => ({ versao: versaoConteudo, versaoBase: VERSAO_BASE }));
  ipcMain.handle('atualizacao:verificar', () => verificarAtualizacao());
  ipcMain.handle('atualizacao:aplicar', () => aplicarAtualizacao());
  ipcMain.handle('atualizacao:pagina', () => {
    const url = ultimaVerificacao && ultimaVerificacao.release.html_url;
    if (url && url.startsWith('https://github.com/')) shell.openExternal(url);
  });
  ipcMain.on('atualizacao:pronto', () => clearTimeout(temporizadorPronto));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
