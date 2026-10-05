const { app, BrowserWindow, ipcMain, session, Menu, nativeTheme, net, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pkg = require('./package.json');

// O áudio arranca sem ser preciso clicar, e o Chromium não abranda a janela em segundo plano
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Opções que têm de ser lidas antes de o Chromium arrancar (guardadas em opcoes.json)
// imagemEstavel: não deixar a placa gráfica trocar o vídeo para "overlay" quando nada
// está por cima dele. Essa troca causa uma piscadela (às vezes verde) quando a barra desaparece.
const OPCOES_PADRAO = { imagemEstavel: true };
const ficheiroOpcoes = () => path.join(app.getPath('userData'), 'opcoes.json');
function lerOpcoes() {
  try {
    return { ...OPCOES_PADRAO, ...JSON.parse(fs.readFileSync(ficheiroOpcoes(), 'utf8')) };
  } catch {
    return { ...OPCOES_PADRAO };
  }
}
const opcoesArranque = lerOpcoes();
if (opcoesArranque.imagemEstavel) {
  app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
}

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
//  - o conteúdo (pasta ui/), que se atualiza descarregando só esses
//    ficheiros (poucos KB) das versões publicadas no GitHub.
// "versaoBase" no package.json diz que base cada versão precisa. Se mudar,
// a atualização é completa: o instalador novo é descarregado e corre em silêncio.
// =====================================================================
const VERSAO = pkg.version;
const VERSAO_BASE = pkg.versaoBase;
const REPOSITORIO = (pkg.atualizacoes && pkg.atualizacoes.repositorio) || '';
const API_GITHUB = process.env.CAPTURA_API || 'https://api.github.com';
const PASTA_UI = path.join(__dirname, 'ui');
const PASTA_PROGRAMA = path.dirname(process.execPath);
const NOME_SEGURO = /^[\w.-]+$/;

let versaoConteudo = VERSAO;
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
    if (compararVersoes(info.versao, VERSAO) <= 0) return null;
    const pasta = path.join(pastaConteudo(), info.versao);
    const lista = Array.isArray(info.ficheiros) ? info.ficheiros : ['index.html'];
    if (!lista.includes('index.html')) return null;
    if (!lista.every((f) => NOME_SEGURO.test(f) && fs.existsSync(path.join(pasta, f)))) return null;
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
    versaoConteudo = VERSAO;
    aUsarConteudoDescarregado = false;
    win.loadFile(path.join(PASTA_UI, 'index.html'));
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

// Instalado pelo instalador (tem o desinstalador ao lado do programa)
function estaInstalado() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  try {
    return fs.readdirSync(PASTA_PROGRAMA).some((f) => /^Uninstall .*\.exe$/i.test(f));
  } catch {
    return false;
  }
}

function podeInstalarSozinho(manifesto, release) {
  const inst = manifesto.instalador;
  return estaInstalado()
    && !!inst
    && NOME_SEGURO.test(inst.nome || '')
    && (release.assets || []).some((a) => a.name === inst.nome);
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
  if (manifesto.versaoBase === VERSAO_BASE) return { ...base, estado: 'conteudo' };
  return {
    ...base,
    estado: 'completa',
    podeAuto: podeInstalarSozinho(manifesto, release),
    tamanhoMB: manifesto.instalador && manifesto.instalador.tamanho ? Math.round(manifesto.instalador.tamanho / 1048576) : 0,
  };
}

// ---------- Atualização pequena: só a pasta ui ----------
async function aplicarAtualizacao() {
  if (!ultimaVerificacao) throw new Error('Procura atualizações primeiro.');
  const { release, manifesto } = ultimaVerificacao;
  if (manifesto.versaoBase !== VERSAO_BASE) throw new Error('Esta versão precisa do programa novo (.exe).');
  if (!/^\d+\.\d+\.\d+$/.test(manifesto.versao)) throw new Error('Número de versão inválido.');

  const nomes = Object.keys(manifesto.ficheiros || {});
  if (!nomes.includes('index.html')) throw new Error('A atualização está incompleta.');

  const destino = path.join(pastaConteudo(), manifesto.versao);
  const temporaria = `${destino}.parcial`;
  fs.rmSync(temporaria, { recursive: true, force: true });
  fs.mkdirSync(temporaria, { recursive: true });

  try {
    for (const nome of nomes) {
      if (!NOME_SEGURO.test(nome)) throw new Error(`Nome de ficheiro inválido: ${nome}`);
      const ativo = release.assets.find((a) => a.name === nome);
      if (!ativo) throw new Error(`Falta o ficheiro ${nome} na versão publicada.`);
      const r = await net.fetch(ativo.browser_download_url, { headers: { 'User-Agent': 'CapturaSimples' } });
      if (!r.ok) throw new Error(`Não foi possível descarregar ${nome} (erro ${r.status}).`);
      const dados = Buffer.from(await r.arrayBuffer());
      const hash = crypto.createHash('sha256').update(dados).digest('hex');
      if (hash !== manifesto.ficheiros[nome]) throw new Error(`O ficheiro ${nome} chegou corrompido. Tenta outra vez.`);
      fs.writeFileSync(path.join(temporaria, nome), dados);
    }
  } catch (e) {
    fs.rmSync(temporaria, { recursive: true, force: true });
    throw e;
  }

  fs.rmSync(destino, { recursive: true, force: true });
  fs.renameSync(temporaria, destino);
  fs.writeFileSync(ficheiroAtual(), JSON.stringify({ versao: manifesto.versao, versaoBase: VERSAO_BASE, ficheiros: nomes }));

  // Apagar versões antigas
  for (const nome of fs.readdirSync(pastaConteudo())) {
    if (nome !== 'atual.json' && nome !== manifesto.versao) {
      fs.rmSync(path.join(pastaConteudo(), nome), { recursive: true, force: true });
    }
  }

  setTimeout(carregarConteudo, 600);
  return { versao: manifesto.versao };
}

// ---------- Atualização completa: descarregar o instalador novo e correr em silêncio ----------
function enviarProgresso(p) {
  if (win && !win.isDestroyed()) win.webContents.send('atualizacao:progresso', Math.max(0, Math.min(1, p)));
}

async function aplicarAtualizacaoCompleta() {
  if (!ultimaVerificacao) throw new Error('Procura atualizações primeiro.');
  const { release, manifesto } = ultimaVerificacao;
  if (!podeInstalarSozinho(manifesto, release)) throw new Error('Esta cópia do programa não se pode atualizar sozinha.');

  const info = manifesto.instalador;
  const ativo = release.assets.find((a) => a.name === info.nome);
  const novo = path.join(app.getPath('temp'), `CapturaSimples-Setup-${manifesto.versao}-${process.pid}.exe`);
  const r = await net.fetch(ativo.browser_download_url, { headers: { 'User-Agent': 'CapturaSimples' } });
  if (!r.ok || !r.body) throw new Error(`Não foi possível descarregar o programa novo (erro ${r.status}).`);

  const total = info.tamanho || ativo.size || 0;
  const hash = crypto.createHash('sha256');
  const ficheiro = fs.createWriteStream(novo);
  let recebido = 0;
  let ultimoEnvio = 0;
  try {
    const leitor = r.body.getReader();
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      hash.update(value);
      recebido += value.length;
      if (!ficheiro.write(value)) await new Promise((res) => ficheiro.once('drain', res));
      const agora = Date.now();
      if (total && agora - ultimoEnvio > 150) {
        ultimoEnvio = agora;
        enviarProgresso(recebido / total);
      }
    }
  } catch {
    ficheiro.destroy();
    fs.rmSync(novo, { force: true });
    throw new Error('A ligação caiu a meio do download. Tenta outra vez.');
  }
  await new Promise((res) => ficheiro.end(res));

  if (hash.digest('hex') !== info.sha256) {
    fs.rmSync(novo, { force: true });
    throw new Error('O programa novo chegou corrompido. Tenta outra vez.');
  }
  enviarProgresso(1);

  // O instalador fecha esta app se ainda estiver aberta, instala em silêncio (/S)
  // e volta a abrir a app no fim (--force-run).
  spawn(novo, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 500);
  return { versao: manifesto.versao };
}

// =====================================================================
// Janela: lembrar tamanho e posição
// =====================================================================
const ficheiroJanela = () => path.join(app.getPath('userData'), 'janela.json');

function lerJanela() {
  try {
    const b = JSON.parse(fs.readFileSync(ficheiroJanela(), 'utf8'));
    if (!(b.width >= 640 && b.height >= 400)) return null;
    const area = screen.getDisplayMatching(b).workArea;
    const visivel = b.x + b.width > area.x + 100 && b.x < area.x + area.width - 100
      && b.y >= area.y - 20 && b.y < area.y + area.height - 100;
    return visivel ? b : { width: b.width, height: b.height, maximizada: b.maximizada };
  } catch {
    return null;
  }
}

let temporizadorJanela = null;
function guardarJanela() {
  if (!win || win.isDestroyed()) return;
  const b = { ...win.getNormalBounds(), maximizada: win.isMaximized() };
  try { fs.writeFileSync(ficheiroJanela(), JSON.stringify(b)); } catch { /* */ }
}
function guardarJanelaDepois() {
  clearTimeout(temporizadorJanela);
  temporizadorJanela = setTimeout(guardarJanela, 500);
}

function createWindow() {
  const guardada = lerJanela();
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    ...(guardada ? { width: guardada.width, height: guardada.height } : {}),
    ...(guardada && Number.isFinite(guardada.x) ? { x: guardada.x, y: guardada.y } : {}),
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
  // Mostrar logo a janela (preta) em vez de esperar pela página: parece instantâneo
  if (guardada && guardada.maximizada) win.maximize();
  win.show();
  win.webContents.on('did-fail-load', () => desistirDoConteudo('falhou a carregar'));
  // Links externos nunca abrem dentro da app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  carregarConteudo();

  const avisar = (estado) => {
    if (win && !win.isDestroyed()) win.webContents.send('fullscreen-changed', estado);
  };
  win.on('enter-full-screen', () => avisar(true));
  win.on('leave-full-screen', () => avisar(false));
  win.on('resize', guardarJanelaDepois);
  win.on('move', guardarJanelaDepois);
  win.on('close', guardarJanela);
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

  // Janela
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
  ipcMain.handle('opcoes:ler', () => ({ guardadas: lerOpcoes(), emUso: opcoesArranque }));
  ipcMain.handle('opcoes:gravar', (_e, novas) => {
    const atuais = lerOpcoes();
    for (const k of Object.keys(OPCOES_PADRAO)) {
      if (novas && typeof novas[k] === typeof OPCOES_PADRAO[k]) atuais[k] = novas[k];
    }
    fs.writeFileSync(ficheiroOpcoes(), JSON.stringify(atuais));
    return atuais;
  });
  ipcMain.handle('janela:sempreCima', (_e, estado) => {
    if (win) win.setAlwaysOnTop(!!estado, 'floating');
    return !!estado;
  });

  // Atualizações
  ipcMain.handle('atualizacao:info', () => ({ versao: versaoConteudo, versaoBase: VERSAO_BASE }));
  ipcMain.handle('atualizacao:verificar', () => verificarAtualizacao());
  ipcMain.handle('atualizacao:aplicar', () => aplicarAtualizacao());
  ipcMain.handle('atualizacao:aplicarCompleta', () => aplicarAtualizacaoCompleta());
  ipcMain.handle('atualizacao:pagina', () => {
    const url = ultimaVerificacao && ultimaVerificacao.release.html_url;
    if (url && url.startsWith('https://github.com/')) shell.openExternal(url);
  });
  ipcMain.on('atualizacao:pronto', () => clearTimeout(temporizadorPronto));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
