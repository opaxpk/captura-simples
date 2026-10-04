'use strict';

// Ponte do Electron (preload.js). Se não existir (ex.: index.html aberto num browser),
// usa a API de ecrã inteiro normal, para a app nunca ficar parada.
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
  sinal: $('sinal'),
  sinalTexto: $('sinalTexto'),
  sinalExtra: $('sinalExtra'),
  estado: $('estado'),
  estadoTitulo: $('estadoTitulo'),
  estadoTexto: $('estadoTexto'),
  btnRetry: $('btnRetry'),
  osd: $('osd'),
  btnAtualizar: $('btnAtualizar'),
  painel: $('painelAtualizacao'),
  atTitulo: $('atTitulo'),
  atTexto: $('atTexto'),
  atNotas: $('atNotas'),
  atAcao: $('atAcao'),
  atFechar: $('atFechar'),
  atVersao: $('atVersao'),
};

// Atualizações (só existe dentro da app)
const atualizador = window.atualizacao || null;

// Qualquer erro inesperado aparece no ecrã em vez de ficar tudo preto
window.addEventListener('error', (e) => mostrarAviso({ message: 'Erro interno: ' + (e.message || e.error) }));
window.addEventListener('unhandledrejection', (e) => mostrarAviso({ message: 'Erro interno: ' + ((e.reason && e.reason.message) || e.reason) }));

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
};

function carregarDefinicoes() {
  try {
    const d = { ...PADRAO, ...JSON.parse(localStorage.getItem(CHAVE) || '{}') };
    if (!RESOLUCOES.includes(d.res)) d.res = PADRAO.res;
    d.fps = [30, 60].includes(Number(d.fps)) ? Number(d.fps) : PADRAO.fps;
    const v = Number(d.volume);
    d.volume = Number.isFinite(v) ? Math.min(200, Math.max(0, v)) : PADRAO.volume;
    d.mute = !!d.mute;
    return d;
  } catch {
    return { ...PADRAO };
  }
}

const def = carregarDefinicoes();

function guardar() {
  try { localStorage.setItem(CHAVE, JSON.stringify(def)); } catch { /* ignorar */ }
}

// =====================================================================
// Estado
// =====================================================================
let streamVideo = null;
let streamAudio = null;
let ctx = null;
let fonteAudio = null;
let ganho = null;
let analisador = null;
let amostras = null;
let tokVideo = 0;
let tokAudio = 0;
let notaAudio = '';
let emEcraInteiro = false;
const dispositivos = { video: [], audio: [] };

const PARECE_CAPTURA_VIDEO = /usb video|captur|hdmi|ms21\d\d|534d:|345f:|macrosilicon|cam link/i;
const PARECE_CAPTURA_AUDIO = /digital audio interface|usb digital audio|captur|hdmi|ms21\d\d|534d:|345f:|macrosilicon|cam link/i;

// =====================================================================
// Dispositivos
// =====================================================================
async function pedirPermissaoUmaVez() {
  // Abre e fecha logo, só para o Chromium revelar os nomes dos dispositivos
  const tentativas = [{ video: true, audio: true }, { video: true }, { audio: true }];
  for (const c of tentativas) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(c);
      s.getTracks().forEach((t) => t.stop());
      return;
    } catch { /* tenta a seguinte */ }
  }
}

async function atualizarListas() {
  let todos = await navigator.mediaDevices.enumerateDevices();
  const semNomes = todos.some((d) => (d.kind === 'videoinput' || d.kind === 'audioinput') && !d.label);
  if (semNomes) {
    await pedirPermissaoUmaVez();
    todos = await navigator.mediaDevices.enumerateDevices();
  }

  dispositivos.video = todos.filter((d) => d.kind === 'videoinput' && d.deviceId);
  // "default" e "communications" são cópias de outras entradas no Windows
  dispositivos.audio = todos.filter((d) => d.kind === 'audioinput' && d.deviceId
    && d.deviceId !== 'default' && d.deviceId !== 'communications');

  const videoAtual = el.selVideo.value;
  const audioAtual = el.selAudio.value;

  el.selVideo.replaceChildren();
  if (dispositivos.video.length === 0) {
    el.selVideo.add(new Option('Nenhuma placa', ''));
    el.selVideo.disabled = true;
  } else {
    el.selVideo.disabled = false;
    dispositivos.video.forEach((d, i) => el.selVideo.add(new Option(d.label || `Câmara ${i + 1}`, d.deviceId)));
    if (dispositivos.video.some((d) => d.deviceId === videoAtual)) el.selVideo.value = videoAtual;
  }

  el.selAudio.replaceChildren();
  el.selAudio.add(new Option('Sem áudio', 'none'));
  dispositivos.audio.forEach((d, i) => el.selAudio.add(new Option(d.label || `Entrada de áudio ${i + 1}`, d.deviceId)));
  if (audioAtual && [...el.selAudio.options].some((o) => o.value === audioAtual)) el.selAudio.value = audioAtual;

  el.selVideo.title = el.selVideo.selectedOptions[0]?.text || '';
  el.selAudio.title = el.selAudio.selectedOptions[0]?.text || '';
}

function encontrar(lista, id, nome) {
  return lista.find((d) => id && d.deviceId === id)
    || lista.find((d) => nome && d.label === nome)
    || null;
}

function videoSelecionado() {
  return dispositivos.video.find((d) => d.deviceId === el.selVideo.value) || null;
}

// Áudio do mesmo dispositivo USB: mesmo groupId; senão VID:PID igual; senão nome parecido
function audioParaVideo(v) {
  if (!v) return null;

  const mesmoGrupo = dispositivos.audio.find((a) => a.groupId && a.groupId === v.groupId);
  if (mesmoGrupo) return mesmoGrupo;

  const vidPid = (s) => ((s || '').match(/([0-9a-f]{4}:[0-9a-f]{4})/i) || [])[1]?.toLowerCase();
  const idV = vidPid(v.label);
  if (idV) {
    const a = dispositivos.audio.find((x) => vidPid(x.label) === idV);
    if (a) return a;
  }

  const genericas = new Set(['usb', 'video', 'vídeo', 'audio', 'áudio', 'device', 'camera', 'câmara', 'webcam',
    'microfone', 'microphone', 'mic', 'input', 'entrada', 'digital', 'interface', 'the', 'and', 'de', 'do', 'da']);
  const palavras = (s) => new Set((s || '').toLowerCase()
    .replace(/[0-9a-f]{4}:[0-9a-f]{4}/g, ' ')
    .split(/[^a-z0-9à-ú]+/)
    .filter((p) => p.length > 2 && !genericas.has(p)));
  const pv = palavras(v.label);
  let melhor = null;
  let pontos = 0;
  for (const a of dispositivos.audio) {
    let p = 0;
    for (const w of palavras(a.label)) if (pv.has(w)) p++;
    if (p > pontos) { pontos = p; melhor = a; }
  }
  if (melhor) return melhor;

  // Placas MS2109/MS2130: vídeo "USB Video", áudio "Digital Audio Interface"
  if (PARECE_CAPTURA_VIDEO.test(v.label)) {
    return dispositivos.audio.find((a) => PARECE_CAPTURA_AUDIO.test(a.label)) || null;
  }
  return null;
}

function escolherVideoInicial() {
  const v = encontrar(dispositivos.video, def.videoId, def.videoNome)
    || dispositivos.video.find((d) => PARECE_CAPTURA_VIDEO.test(d.label))
    || dispositivos.video[0];
  el.selVideo.value = v ? v.deviceId : '';
  el.selVideo.title = v ? v.label : '';
}

function escolherAudioInicial() {
  if (def.audioId === 'none') { el.selAudio.value = 'none'; return; }
  const a = encontrar(dispositivos.audio, def.audioId, def.audioNome) || audioParaVideo(videoSelecionado());
  // Sem correspondência fica sem áudio, para não abrir o microfone do PC por engano
  el.selAudio.value = a ? a.deviceId : 'none';
  el.selAudio.title = a ? a.label : '';
}

// =====================================================================
// Vídeo
// =====================================================================
function pararStream(s) {
  if (!s) return;
  s.getTracks().forEach((t) => { t.onended = null; t.stop(); });
}

function pararVideo() {
  pararStream(streamVideo);
  streamVideo = null;
  el.video.srcObject = null;
}

async function ligarVideo() {
  const meu = ++tokVideo;
  pararVideo(); // fechar sempre antes de abrir outra vez

  const id = el.selVideo.value;
  if (!id) { mostrarAviso({ name: 'SemDispositivos' }); return; }

  const [w, h] = def.res.split('x').map(Number);
  definirSinal('a-ligar', 'A ligar…');
  // Só mostra o ecrã "a ligar" se demorar, para não piscar
  const tEcra = setTimeout(() => { if (meu === tokVideo && !streamVideo) mostrarEstado('a-ligar', 'A ligar à placa…', ''); }, 400);

  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: id },
        width: { ideal: w },
        height: { ideal: h },
        frameRate: { ideal: def.fps },
      },
    });
    if (meu !== tokVideo) { pararStream(s); return; }

    streamVideo = s;
    const track = s.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.onended = () => {
      if (streamVideo !== s) return;
      pararVideo();
      pararAudio();
      mostrarAviso({ name: 'Desligada' });
    };

    el.video.srcObject = s;
    try { await el.video.play(); } catch { /* troca de fonte a meio: ignorar */ }
    esconderEstado();

    if (!def.videoId) {
      const v = videoSelecionado();
      def.videoId = id;
      def.videoNome = v ? v.label : '';
      guardar();
    }
    atualizarIndicador();
  } catch (e) {
    if (meu !== tokVideo) return;
    console.error('Erro no vídeo:', e);
    mostrarAviso(e);
  } finally {
    clearTimeout(tEcra);
  }
}

// =====================================================================
// Áudio (Web Audio, nunca pelo <video>)
// =====================================================================
function pararAudio() {
  if (fonteAudio) { try { fonteAudio.disconnect(); } catch { /* */ } fonteAudio = null; }
  pararStream(streamAudio);
  streamAudio = null;
}

function marcarProblemaAudio(texto) {
  notaAudio = texto;
  el.selAudio.classList.toggle('problema', !!texto);
  el.selAudio.title = texto ? `Atenção: ${texto}` : (el.selAudio.selectedOptions[0]?.text || '');
}

async function ligarAudio() {
  const meu = ++tokAudio;
  pararAudio();
  marcarProblemaAudio('');

  const id = el.selAudio.value;
  if (!id || id === 'none') { atualizarIndicador(); return; }

  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: { exact: id },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        latency: 0,
      },
    });
    if (meu !== tokAudio) { pararStream(s); return; }

    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      ganho = ctx.createGain();
      ganho.connect(ctx.destination);
      // O medidor lê o sinal à parte; não fica no caminho do som
      analisador = ctx.createAnalyser();
      analisador.fftSize = 512;
      amostras = new Float32Array(analisador.fftSize);
    }
    if (ctx.state === 'suspended') await ctx.resume();

    streamAudio = s;
    fonteAudio = ctx.createMediaStreamSource(s);
    fonteAudio.connect(ganho);
    fonteAudio.connect(analisador);
    aplicarVolume();

    s.getAudioTracks()[0].onended = () => {
      if (streamAudio !== s) return;
      pararAudio();
      marcarProblemaAudio('áudio desligado');
      atualizarIndicador();
    };
  } catch (e) {
    if (meu !== tokAudio) return;
    console.error('Erro no áudio:', e);
    marcarProblemaAudio(e && e.name === 'NotReadableError' ? 'áudio ocupado por outro programa' : 'áudio indisponível');
  }
  atualizarIndicador();
}

// Medidor de nível: mostra o som que chega, mesmo com o volume em 0 ou em silêncio
let nivelSuave = 0;
function desenharNivel() {
  requestAnimationFrame(desenharNivel);
  if (document.body.classList.contains('inativo')) return;
  let alvo = 0;
  if (analisador && fonteAudio) {
    analisador.getFloatTimeDomainData(amostras);
    let pico = 0;
    for (let i = 0; i < amostras.length; i++) {
      const a = Math.abs(amostras[i]);
      if (a > pico) pico = a;
    }
    const db = 20 * Math.log10(pico || 1e-6);
    alvo = Math.min(1, Math.max(0, (db + 54) / 54));
  }
  nivelSuave = alvo > nivelSuave ? alvo : nivelSuave * 0.9 + alvo * 0.1;
  if (nivelSuave < 0.005) nivelSuave = 0;
  el.nivel.style.transform = `scaleX(${nivelSuave.toFixed(3)})`;
}
requestAnimationFrame(desenharNivel);

// =====================================================================
// Volume
// =====================================================================
function aplicarVolume() {
  const alvo = def.mute ? 0 : def.volume / 100;
  if (ganho && ctx) ganho.gain.setTargetAtTime(alvo, ctx.currentTime, 0.015);
  el.volume.value = String(def.volume);
  el.volume.style.setProperty('--p', `${def.volume / 2}%`);
  el.volumeValor.textContent = `${def.volume}%`;
  el.btnMute.classList.toggle('mudo', def.mute);
  const rotulo = def.mute ? 'Ativar som' : 'Silenciar';
  el.btnMute.setAttribute('aria-label', rotulo);
  el.btnMute.title = `${rotulo} (M)`;
}

function mudarVolume(delta) {
  def.volume = Math.min(200, Math.max(0, def.volume + delta));
  if (delta > 0) def.mute = false;
  aplicarVolume();
  guardar();
}

function alternarMute() {
  def.mute = !def.mute;
  aplicarVolume();
  guardar();
}

let tOsd = null;
function mostrarOsd(texto) {
  el.osd.textContent = texto;
  el.osd.classList.add('visivel');
  clearTimeout(tOsd);
  tOsd = setTimeout(() => el.osd.classList.remove('visivel'), 1100);
}

function osdVolume() {
  mostrarOsd(def.mute ? 'Som desligado' : `Volume ${def.volume}%`);
}

// =====================================================================
// Luz de sinal (resolução e FPS reais)
// =====================================================================
let framesContados = 0;
let inicioContagem = performance.now();
let fpsRecebidos = 0;

function contarFrame() {
  framesContados++;
  el.video.requestVideoFrameCallback(contarFrame);
}
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  el.video.requestVideoFrameCallback(contarFrame);
}

setInterval(() => {
  const agora = performance.now();
  fpsRecebidos = (framesContados * 1000) / (agora - inicioContagem);
  framesContados = 0;
  inicioContagem = agora;
  atualizarIndicador();
}, 1000);

function definirSinal(estado, texto, extra = '', dica = '') {
  el.sinal.dataset.estado = estado;
  el.sinalTexto.textContent = texto;
  el.sinalExtra.textContent = extra;
  el.sinal.title = dica;
}

function atualizarIndicador() {
  const track = streamVideo && streamVideo.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return;

  const s = track.getSettings();
  const fps = Math.round(s.frameRate || 0);
  const recebidos = Math.round(fpsRecebidos);
  const [w, h] = def.res.split('x').map(Number);
  const formatoCerto = s.width === w && s.height === h && fps >= def.fps - 1;
  const perdeImagens = recebidos > 0 && recebidos < fps - 4;

  let dica = `A placa está a enviar ${s.width}×${s.height} a ${fps} fps.\nChegam ${recebidos} imagens por segundo.`;
  if (!formatoCerto) {
    dica += `\n\nPediste ${w}×${h} a ${def.fps} fps, mas a placa não entrega este formato. `
      + 'Pode ser limite da placa (a MS2109 só faz 1080p a 30 fps) ou da porta USB: experimenta uma porta USB 3.';
  }
  if (notaAudio) dica += `\n\nÁudio: ${notaAudio}.`;

  definirSinal(
    formatoCerto && !perdeImagens ? 'ok' : 'aviso',
    `${s.height}p${fps}`,
    perdeImagens ? `chegam ${recebidos}` : '',
    dica,
  );
}

// =====================================================================
// Ecrã de estado (a ligar / erros)
// =====================================================================
function mensagemErro(e) {
  switch (e && e.name) {
    case 'NotFoundError':
    case 'OverconstrainedError':
      return ['Placa de captura não encontrada',
        'Confirma que a placa está ligada à porta USB e escolhe-a na lista Vídeo. Se acabaste de a ligar, espera uns segundos.'];
    case 'NotReadableError':
    case 'AbortError':
      return ['A placa está a ser usada por outro programa',
        'Fecha o OBS, o Discord ou outra aplicação que esteja a usar a placa. Se continuar, desliga e volta a ligar o cabo USB.'];
    case 'NotAllowedError':
    case 'SecurityError':
      return ['O Windows está a bloquear a câmara',
        'Abre Definições, Privacidade e segurança, Câmara, e ativa "Permitir que as aplicações de ambiente de trabalho acedam à câmara".'];
    case 'SemDispositivos':
      return ['Nenhuma placa de captura ligada',
        'Liga a placa a uma porta USB. A imagem aparece sozinha assim que o Windows a reconhecer.'];
    case 'Desligada':
      return ['A placa foi desligada',
        'Volta a ligá-la à porta USB. A imagem volta sozinha assim que o Windows a reconhecer.'];
    default:
      return ['Não foi possível mostrar a imagem', (e && e.message) || String(e)];
  }
}

function mostrarEstado(modo, titulo, texto) {
  el.estado.dataset.modo = modo;
  el.estadoTitulo.textContent = titulo;
  el.estadoTexto.textContent = texto;
}

function esconderEstado() {
  el.estado.dataset.modo = 'oculto';
}

function mostrarAviso(e) {
  const [titulo, texto] = mensagemErro(e);
  mostrarEstado('erro', titulo, texto);
  definirSinal(e && e.name === 'Desligada' ? 'erro' : 'sem', 'Sem sinal');
  mostrarControlos();
}

// =====================================================================
// Arranque / tentar outra vez / ligar-desligar USB
// =====================================================================
async function iniciarTudo() {
  try {
    await atualizarListas();
  } catch (e) {
    mostrarAviso(e);
    return;
  }
  escolherVideoInicial();
  escolherAudioInicial();
  await ligarVideo();
  await ligarAudio();
}

let temporizadorDisp = null;
navigator.mediaDevices.addEventListener('devicechange', () => {
  clearTimeout(temporizadorDisp);
  temporizadorDisp = setTimeout(aoMudarDispositivos, 800);
});

async function aoMudarDispositivos() {
  try { await atualizarListas(); } catch { return; }

  const videoVivo = streamVideo && streamVideo.getVideoTracks()[0]?.readyState === 'live';
  if (!videoVivo) {
    // Só volta a ligar sozinho se for a placa guardada (não troca para a webcam por engano)
    const guardada = encontrar(dispositivos.video, def.videoId, def.videoNome);
    const semEscolha = !def.videoId && dispositivos.video.length > 0;
    if (guardada || semEscolha) {
      escolherVideoInicial();
      escolherAudioInicial();
      await ligarVideo();
      await ligarAudio();
    }
    return;
  }

  const audioVivo = streamAudio && streamAudio.getAudioTracks()[0]?.readyState === 'live';
  if (!audioVivo && def.audioId !== 'none') {
    const a = encontrar(dispositivos.audio, def.audioId, def.audioNome);
    if (a) { el.selAudio.value = a.deviceId; await ligarAudio(); }
  }
}

// =====================================================================
// Ecrã inteiro + esconder controlos
// =====================================================================
let temporizadorInativo = null;

function mostrarControlos() {
  document.body.classList.remove('inativo');
  clearTimeout(temporizadorInativo);
  if (!emEcraInteiro) return;
  temporizadorInativo = setTimeout(() => {
    if (el.barra.matches(':hover') || el.estado.dataset.modo !== 'oculto' || painelAberto()) { mostrarControlos(); return; }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    document.body.classList.add('inativo');
  }, 2500);
}

function aplicarEcraInteiro(estado) {
  emEcraInteiro = estado;
  document.body.classList.toggle('ecra-inteiro', estado);
  const rotulo = estado ? 'Sair do ecrã inteiro' : 'Ecrã inteiro';
  el.btnEcra.setAttribute('aria-label', rotulo);
  el.btnEcra.title = estado ? `${rotulo} (Esc)` : `${rotulo} (F11 ou duplo clique)`;
  mostrarControlos();
}

ponte.onFullscreenChange(aplicarEcraInteiro);

document.addEventListener('mousemove', mostrarControlos);
el.video.addEventListener('dblclick', () => ponte.toggleFullscreen());
el.estado.addEventListener('dblclick', (e) => { if (e.target === el.estado) ponte.toggleFullscreen(); });
el.btnEcra.addEventListener('click', (e) => { if (e.detail) el.btnEcra.blur(); ponte.toggleFullscreen(); });

// =====================================================================
// Controlos
// =====================================================================
function marcarSegmento(grupo, valor) {
  for (const b of grupo.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.valor === String(valor)));
  }
}

el.segRes.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (e.detail) b.blur();
  if (b.dataset.valor === def.res) return;
  def.res = b.dataset.valor;
  marcarSegmento(el.segRes, def.res);
  guardar();
  ligarVideo();
});

el.segFps.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (e.detail) b.blur();
  if (Number(b.dataset.valor) === def.fps) return;
  def.fps = Number(b.dataset.valor);
  marcarSegmento(el.segFps, def.fps);
  guardar();
  ligarVideo();
});

el.selVideo.addEventListener('change', async () => {
  el.selVideo.blur();
  const v = videoSelecionado();
  def.videoId = v ? v.deviceId : '';
  def.videoNome = v ? v.label : '';
  el.selVideo.title = v ? v.label : '';

  // Seleciona automaticamente o áudio do mesmo dispositivo USB
  const a = audioParaVideo(v);
  let mudarAudio = false;
  if (a && a.deviceId !== el.selAudio.value) {
    el.selAudio.value = a.deviceId;
    def.audioId = a.deviceId;
    def.audioNome = a.label;
    mudarAudio = true;
  }
  guardar();
  await ligarVideo();
  if (mudarAudio) await ligarAudio();
});

el.selAudio.addEventListener('change', () => {
  el.selAudio.blur();
  const id = el.selAudio.value;
  const a = dispositivos.audio.find((d) => d.deviceId === id);
  def.audioId = id;
  def.audioNome = a ? a.label : '';
  guardar();
  ligarAudio();
});

el.volume.addEventListener('input', () => {
  def.volume = Number(el.volume.value);
  if (def.volume > 0) def.mute = false;
  aplicarVolume();
  guardar();
});

el.btnMute.addEventListener('click', (e) => { if (e.detail) el.btnMute.blur(); alternarMute(); });
el.btnRetry.addEventListener('click', () => iniciarTudo());

// =====================================================================
// Atalhos de teclado
// =====================================================================
document.addEventListener('keydown', (e) => {
  const emSelect = e.target instanceof HTMLSelectElement;

  if (e.key === 'F11') {
    e.preventDefault();
    ponte.toggleFullscreen();
    return;
  }
  if (e.key === 'Escape') {
    if (painelAberto()) { e.preventDefault(); fecharPainel(); return; }
    if (emEcraInteiro) { e.preventDefault(); ponte.setFullscreen(false); }
    return;
  }
  if (emSelect) return; // nas listas as setas servem para escolher

  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    alternarMute();
    osdVolume();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    mudarVolume(5);
    osdVolume();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    mudarVolume(-5);
    osdVolume();
  }
});

window.addEventListener('beforeunload', () => {
  pararVideo();
  pararAudio();
});

// =====================================================================
// Atualizações
// =====================================================================
const CHAVE_ATUALIZOU = 'capturaSimples.acabouDeAtualizar';
let resultadoAtualizacao = null;
let acaoPainel = null;
let versaoAtual = '';

function limparErro(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function painelAberto() {
  return el.painel.dataset.modo !== 'oculto';
}

function abrirPainel(modo, titulo, texto = '', { notas = '', acao = '', aoClicar = null } = {}) {
  el.painel.dataset.modo = modo;
  el.atTitulo.textContent = titulo;
  el.atTexto.textContent = texto;
  el.atNotas.textContent = notas;
  el.atAcao.textContent = acao;
  el.atVersao.textContent = versaoAtual ? `Versão instalada: ${versaoAtual}` : '';
  acaoPainel = aoClicar;
  mostrarControlos();
}

function fecharPainel() {
  el.painel.dataset.modo = 'oculto';
  acaoPainel = null;
}

function marcarDisponivel(r) {
  const ha = r && r.estado !== 'atualizado';
  el.btnAtualizar.classList.toggle('disponivel', !!ha);
  const rotulo = ha ? `Versão ${r.nova} disponível` : 'Procurar atualizações';
  el.btnAtualizar.title = rotulo;
  el.btnAtualizar.setAttribute('aria-label', rotulo);
}

function mostrarResultado(r) {
  if (r.estado === 'atualizado') {
    abrirPainel('atualizado', 'Tens a versão mais recente', `A versão ${r.atual} é a última publicada.`);
  } else if (r.estado === 'conteudo') {
    abrirPainel('disponivel', `Versão ${r.nova} disponível`,
      'Atualização pequena: instala-se em segundos, sem fechar a app.',
      { notas: r.notas, acao: 'Atualizar agora', aoClicar: instalarAtualizacao });
  } else {
    abrirPainel('disponivel', `Versão ${r.nova} disponível`,
      'Esta versão precisa do programa novo. Descarrega o .exe na página da versão e substitui o que tens.',
      { notas: r.notas, acao: 'Abrir página de download', aoClicar: () => { atualizador.abrirPagina(); fecharPainel(); } });
  }
}

async function procurarAtualizacoes(silencioso) {
  if (!atualizador) return;
  if (!silencioso) {
    abrirPainel('a-verificar', 'A procurar atualizações…');
    el.btnAtualizar.classList.add('a-rodar');
  }
  try {
    const r = await atualizador.verificar();
    resultadoAtualizacao = r;
    marcarDisponivel(r);
    if (!silencioso && painelAberto()) mostrarResultado(r);
  } catch (e) {
    if (!silencioso && painelAberto()) {
      abrirPainel('erro', 'Não foi possível procurar atualizações', limparErro(e),
        { acao: 'Tentar outra vez', aoClicar: () => procurarAtualizacoes(false) });
    }
  } finally {
    el.btnAtualizar.classList.remove('a-rodar');
  }
}

async function instalarAtualizacao() {
  const nova = resultadoAtualizacao && resultadoAtualizacao.nova;
  abrirPainel('a-instalar', `A instalar a versão ${nova}…`, 'A imagem volta em poucos segundos.');
  try {
    const r = await atualizador.aplicar();
    try { localStorage.setItem(CHAVE_ATUALIZOU, r.versao); } catch { /* */ }
    // A app recarrega sozinha com a versão nova
  } catch (e) {
    abrirPainel('erro', 'A atualização falhou', `${limparErro(e)} A versão atual continua a funcionar.`,
      { acao: 'Tentar outra vez', aoClicar: instalarAtualizacao });
  }
}

el.btnAtualizar.addEventListener('click', (e) => {
  if (e.detail) el.btnAtualizar.blur();
  if (painelAberto()) { fecharPainel(); return; }
  procurarAtualizacoes(false);
});
el.atFechar.addEventListener('click', fecharPainel);
el.atAcao.addEventListener('click', () => { if (acaoPainel) acaoPainel(); });
document.addEventListener('mousedown', (e) => {
  if (painelAberto() && !el.painel.contains(e.target) && !el.btnAtualizar.contains(e.target)) fecharPainel();
});

if (atualizador) {
  el.btnAtualizar.hidden = false;
  atualizador.info().then((i) => { versaoAtual = i.versao; });
  try {
    const v = localStorage.getItem(CHAVE_ATUALIZOU);
    if (v) {
      localStorage.removeItem(CHAVE_ATUALIZOU);
      setTimeout(() => mostrarOsd(`Atualizado para a versão ${v}`), 800);
    }
  } catch { /* */ }
  // Procura em silêncio ao abrir: se houver versão nova, aparece um ponto no botão
  setTimeout(() => procurarAtualizacoes(true), 4000);
}

// =====================================================================
// Início
// =====================================================================
marcarSegmento(el.segRes, def.res);
marcarSegmento(el.segFps, def.fps);
aplicarVolume();
ponte.isFullscreen().then(aplicarEcraInteiro);

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  mostrarAviso({ message: 'Este sistema não suporta captura de vídeo.' });
} else {
  iniciarTudo();
}

// Avisa o programa de que esta versão arrancou bem
if (atualizador) atualizador.pronto();
