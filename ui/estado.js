'use strict';
// Estado partilhado: ponte com o programa, elementos da página e definições guardadas.
// Os ficheiros carregam por ordem (ver index.html) e partilham as declarações de topo.

// Ponte do Electron (preload.js). Fora da app (browser) usa a API de ecrã inteiro normal.
const ponte = window.janela || {
  setFullscreen: async (estado) => {
    try {
      if (estado && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!estado && document.fullscreenElement) await document.exitFullscreen();
    } catch { /* ignorar */ }
    return estado;
  },
  toggleFullscreen: async () => ponte.setFullscreen(!document.fullscreenElement),
  isFullscreen: async () => !!document.fullscreenElement,
  onFullscreenChange: (cb) => document.addEventListener('fullscreenchange', () => cb(!!document.fullscreenElement)),
};

// Atualizações (só existe dentro da app)
const atualizador = window.atualizacao || null;

const $ = (id) => document.getElementById(id);
const el = {
  barra: $('barra'),
  video: $('video'),
  selVideo: $('selVideo'),
  selAudio: $('selAudio'),
  segRes: $('segRes'),
  segFps: $('segFps'),
  volume: $('volume'),
  volumeValor: $('volumeValor'),
  nivel: $('nivel'),
  btnMute: $('btnMute'),
  btnEcra: $('btnEcra'),
  btnDefinicoes: $('btnDefinicoes'),
  btnAtualizar: $('btnAtualizar'),
  sinal: $('sinal'),
  sinalTexto: $('sinalTexto'),
  sinalExtra: $('sinalExtra'),
  estado: $('estado'),
  estadoTitulo: $('estadoTitulo'),
  estadoTexto: $('estadoTexto'),
  btnRetry: $('btnRetry'),
  semImagem: $('semImagem'),
  osd: $('osd'),
  // Definições
  painelDefinicoes: $('painelDefinicoes'),
  segEscala: $('segEscala'),
  optNitido: $('optNitido'),
  optCores: $('optCores'),
  optBrilho: $('optBrilho'),
  optContraste: $('optContraste'),
  optSaturacao: $('optSaturacao'),
  valBrilho: $('valBrilho'),
  valContraste: $('valContraste'),
  valSaturacao: $('valSaturacao'),
  btnReporImagem: $('btnReporImagem'),
  linhaEstavel: $('linhaEstavel'),
  optEstavel: $('optEstavel'),
  notaEstavel: $('notaEstavel'),
  optAtraso: $('optAtraso'),
  valAtraso: $('valAtraso'),
  linhaCima: $('linhaCima'),
  optCima: $('optCima'),
  optAbrirEcra: $('optAbrirEcra'),
  optBarra: $('optBarra'),
  btnAtalhos: $('btnAtalhos'),
  defVersao: $('defVersao'),
  // Atualizações
  painelAtualizacao: $('painelAtualizacao'),
  atTitulo: $('atTitulo'),
  atTexto: $('atTexto'),
  atProgresso: $('atProgresso'),
  atBarra: $('atBarra'),
  atNotas: $('atNotas'),
  atAcao: $('atAcao'),
  atFechar: $('atFechar'),
  atVersao: $('atVersao'),
  // Atalhos
  ajuda: $('ajuda'),
  ajFechar: $('ajFechar'),
};

// =====================================================================
// Definições guardadas (localStorage fica na pasta de dados da app)
// =====================================================================
const CHAVE = 'capturaSimples.definicoes.v1';
const RESOLUCOES = ['1920x1080', '1280x720', '854x480'];
const PADRAO = {
  videoId: '', videoNome: '',
  audioId: '', audioNome: '',
  res: '1920x1080', fps: 60,
  volume: 100, mute: false,
  // Imagem
  escala: 'ajustar', nitido: false, corrigirCores: false,
  brilho: 100, contraste: 100, saturacao: 100,
  // Som
  atrasoSom: 0,
  // Janela
  sempreCima: false, abrirEcraInteiro: false, barraEscondida: false,
};

const limitar = (v, min, max, padrao) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
};

function carregarDefinicoes() {
  let d;
  try {
    d = { ...PADRAO, ...JSON.parse(localStorage.getItem(CHAVE) || '{}') };
  } catch {
    d = { ...PADRAO };
  }
  if (!RESOLUCOES.includes(d.res)) d.res = PADRAO.res;
  d.fps = [30, 60].includes(Number(d.fps)) ? Number(d.fps) : PADRAO.fps;
  d.volume = limitar(d.volume, 0, 200, PADRAO.volume);
  d.escala = d.escala === 'esticar' ? 'esticar' : 'ajustar';
  d.brilho = limitar(d.brilho, 50, 150, 100);
  d.contraste = limitar(d.contraste, 50, 150, 100);
  d.saturacao = limitar(d.saturacao, 0, 200, 100);
  d.atrasoSom = limitar(d.atrasoSom, 0, 250, 0);
  for (const k of ['mute', 'nitido', 'corrigirCores', 'sempreCima', 'abrirEcraInteiro', 'barraEscondida']) d[k] = !!d[k];
  return d;
}

const def = carregarDefinicoes();

function guardar() {
  try { localStorage.setItem(CHAVE, JSON.stringify(def)); } catch { /* ignorar */ }
}

// =====================================================================
// Estado da captura
// =====================================================================
let streamVideo = null;
let streamAudio = null;
let tokVideo = 0;
let tokAudio = 0;
let notaAudio = '';
let emEcraInteiro = false;
const dispositivos = { video: [], audio: [] };

const PARECE_CAPTURA_VIDEO = /usb video|captur|hdmi|ms21\d\d|534d:|345f:|macrosilicon|cam link/i;
const PARECE_CAPTURA_AUDIO = /digital audio interface|usb digital audio|captur|hdmi|ms21\d\d|534d:|345f:|macrosilicon|cam link/i;

// Qualquer erro inesperado aparece no ecrã em vez de ficar tudo preto
window.addEventListener('error', (e) => mostrarAviso({ message: 'Erro interno: ' + (e.message || e.error) }));
window.addEventListener('unhandledrejection', (e) => mostrarAviso({ message: 'Erro interno: ' + ((e.reason && e.reason.message) || e.reason) }));
