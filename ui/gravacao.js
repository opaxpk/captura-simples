'use strict';
// Gravação: lado da janela principal.
//
// A imagem e o som da placa já estão abertos aqui para a pré-visualização, por isso a
// gravação usa essas mesmas faixas (uma cópia leve de cada): não há nova leitura da placa.
//
// Motor principal: WebCodecs + mp4-muxer, num Worker (gravacao-worker.js), a ritmo constante.
//  - H.264 pelo codificador da placa gráfica quando existe (NVENC, Quick Sync, AMF),
//    o que deixa o processador quase livre. O Chromium diz se esse codificador existe.
//  - Som AAC (o que o DaVinci Resolve e o CapCut esperam); se o PC não o tiver, Opus.
//  - MP4 fragmentado, escrito no disco a cada segundo: uma gravação longa não enche a
//    memória e, se algo falhar a meio, o que já foi gravado fica no ficheiro.
// Reserva: MediaRecorder em WebM (também escrito a cada segundo), se o WebCodecs não servir.

const gravador = window.gravacao || null;

// Débito (Mb/s) para 1080p a 60 fps; outros formatos ajustam-se ao número de píxeis por segundo
const QUALIDADES = {
  alta: { mbps: 24, nome: 'Alta' },
  equilibrada: { mbps: 14, nome: 'Equilibrada' },
  leve: { mbps: 8, nome: 'Leve' },
};

const grav = {
  aGravar: false,
  aPreparar: false,
  aGuardar: false,
  inicio: 0,
  bytes: 0,
  nome: '',
  formato: '',
  debito: 0,
  resolucao: '',
  codificador: '',
  comSom: false,
  perdidas: 0,
  repetidas: 0,
  fpsChegada: 0,
  fps: 0,
  fonte: 'placa',
  aviso: '',
  erro: '',
  ultima: null,
};
let sessao = null; // a gravação em curso: { parar(motivo) }
let capturaEcra = null; // stream do ecrã do PC durante a gravação

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
function debitoPara(w, h, fps) {
  const base = (QUALIDADES[def.gravQualidade] || QUALIDADES.equilibrada).mbps;
  const escala = (w * h * fps) / (1920 * 1080 * 60);
  return Math.round(Math.max(3, base * escala) * 1e6);
}

// Nível H.264 que chega para o formato (High profile)
function codecAvc(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const porSegundo = mbs * fps;
  if (mbs <= 3600 && porSegundo <= 108000) return 'avc1.64001F'; // 3.1
  if (mbs <= 5120 && porSegundo <= 216000) return 'avc1.640020'; // 3.2
  if (mbs <= 8192 && porSegundo <= 245760) return 'avc1.640028'; // 4.0
  if (mbs <= 8704 && porSegundo <= 522240) return 'avc1.64002A'; // 4.2
  return 'avc1.640033'; // 5.1
}

function duracaoAtual() {
  return grav.aGravar ? Math.floor((performance.now() - grav.inicio) / 1000) : 0;
}

function temImagemDaPlaca() {
  const t = streamVideo && streamVideo.getVideoTracks()[0];
  return !!t && t.readyState === 'live';
}

function temImagemParaGravar() {
  return def.gravFonte === 'ecra' ? !!navigator.mediaDevices.getDisplayMedia : temImagemDaPlaca();
}

function formatarDuracao(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

function suportaWebCodecs() {
  return 'VideoEncoder' in window && 'MediaStreamTrackProcessor' in window && typeof Mp4Muxer !== 'undefined';
}

// ---------------------------------------------------------------------
// Estado para a janela "Gravar" e para a barra
// ---------------------------------------------------------------------
function publicarEstadoGravacao() {
  atualizarIndicadorGravacao();
  if (!gravador) return;
  gravador.publicarEstado({
    aGravar: grav.aGravar,
    aPreparar: grav.aPreparar,
    aGuardar: grav.aGuardar,
    duracao: duracaoAtual(),
    bytes: grav.bytes,
    nome: grav.nome,
    formato: grav.formato || (suportaWebCodecs() ? 'MP4 (H.264)' : 'WebM'),
    debito: grav.debito,
    resolucao: grav.resolucao,
    codificador: grav.codificador,
    comSom: grav.comSom,
    perdidas: grav.perdidas,
    repetidas: grav.repetidas,
    fpsChegada: grav.fpsChegada,
    fps: grav.fps,
    fonteAGravar: grav.fonte,
    fonte: def.gravFonte,
    aviso: grav.aviso,
    erro: grav.erro,
    ultima: grav.ultima,
    temImagem: temImagemParaGravar(),
    temSom: def.gravFonte === 'ecra' ? true : !!(streamAudio && streamAudio.getAudioTracks()[0]),
    qualidade: def.gravQualidade,
    som: def.gravSom,
  });
}

function atualizarIndicadorGravacao() {
  const ativo = grav.aGravar || grav.aGuardar || grav.aPreparar;
  el.rec.hidden = !ativo;
  el.recTempo.textContent = grav.aGuardar ? 'A guardar' : grav.aPreparar ? 'A preparar' : formatarDuracao(duracaoAtual());
  el.btnGravar.classList.toggle('a-gravar', ativo);
  const rotulo = ativo ? 'Gravação em curso' : 'Gravar';
  el.btnGravar.setAttribute('aria-label', rotulo);
  el.btnGravar.title = `${rotulo} (R começa e para)`;
  document.body.classList.toggle('a-gravar', ativo);
}

function falhaGravacao(texto) {
  grav.erro = texto;
  publicarEstadoGravacao();
  mostrarOsd(texto, 4000);
}

// ---------------------------------------------------------------------
// Motor WebCodecs (MP4)
// ---------------------------------------------------------------------
async function configurarVideo(w, h, fps, bps) {
  const base = {
    codec: codecAvc(w, h, fps),
    width: w,
    height: h,
    bitrate: bps,
    framerate: fps,
    bitrateMode: 'variable',
    latencyMode: 'quality',
    avc: { format: 'avc' },
  };
  // 'prefer-hardware' só é aceite se o PC tiver codificador na placa gráfica
  for (const [hardwareAcceleration, quem] of [['prefer-hardware', 'placa'], ['prefer-software', 'processador']]) {
    const config = { ...base, hardwareAcceleration };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, quem };
    } catch { /* tenta a seguinte */ }
  }
  return null;
}

// A leitura das imagens, a codificação e o MP4 correm em gravacao-worker.js, numa linha de
// execução própria: aqui, com a imagem em direto a ser desenhada, perdiam-se imagens.
async function iniciarWebCodecs(faixaVideo, faixaSom, w, h, fps, bps) {
  const video = await configurarVideo(w, h, fps, bps);
  if (!video) return false; // passa para o MediaRecorder

  // Cópias leves das faixas: parar a gravação não mexe na pré-visualização
  const copiaVideo = faixaVideo.clone();
  const copiaSom = faixaSom ? faixaSom.clone() : null;
  const largarCopias = () => { copiaVideo.stop(); if (copiaSom) copiaSom.stop(); };

  let ficheiro;
  try {
    ficheiro = await gravador.abrirFicheiro('mp4');
  } catch (e) {
    largarCopias();
    throw e;
  }

  // Os fluxos de imagens e de som passam para o Worker; quem os lê é ele
  const leituraVideo = new MediaStreamTrackProcessor({ track: copiaVideo, maxBufferSize: 8 }).readable;
  const leituraSom = copiaSom ? new MediaStreamTrackProcessor({ track: copiaSom, maxBufferSize: 64 }).readable : null;
  const definicoesSom = copiaSom ? copiaSom.getSettings() : {};
  const trabalhador = new Worker('gravacao-worker.js');

  let ativo = false;
  let aoComecar;
  let aoFalhar;
  let aoTerminar;
  const comecou = new Promise((res, rej) => { aoComecar = res; aoFalhar = rej; });
  const terminou = new Promise((res) => { aoTerminar = res; });

  trabalhador.onmessage = (e) => {
    const m = e.data;
    switch (m.tipo) {
      case 'dados':
        gravador.enviarDados(ficheiro.id, m.dados, m.posicao);
        grav.bytes = Math.max(grav.bytes, m.posicao + m.dados.byteLength);
        break;
      case 'comecou': aoComecar(m); break;
      case 'falhou': aoFalhar(new Error(m.erro)); aoTerminar({ motivo: m.erro }); break;
      case 'contas':
        grav.perdidas = m.saltadas;
        grav.repetidas = m.repetidas;
        grav.fpsChegada = m.porSegundo;
        if (m.erro && ativo) parar(`O codificador parou (${m.erro})`);
        break;
      case 'fim': aoTerminar(m); break;
      default: break;
    }
  };
  trabalhador.onerror = (e) => {
    const erro = new Error(`O motor de gravação falhou (${e.message || 'erro desconhecido'})`);
    aoFalhar(erro);
    aoTerminar({ motivo: erro.message });
  };

  const transferir = leituraSom ? [leituraVideo, leituraSom] : [leituraVideo];
  trabalhador.postMessage({
    tipo: 'iniciar',
    leituraVideo,
    leituraSom,
    configVideo: video.config,
    largura: w,
    altura: h,
    fps,
    somCanais: definicoesSom.channelCount,
    somTaxa: definicoesSom.sampleRate,
  }, transferir);

  let info;
  try {
    info = await Promise.race([
      comecou,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('O motor de gravação não arrancou.')), 8000)),
    ]);
  } catch (e) {
    trabalhador.terminate();
    largarCopias();
    await gravador.fecharFicheiro(ficheiro.id).catch(() => {});
    throw e;
  }
  ativo = true;

  const vigia = setInterval(async () => {
    const erro = await gravador.erroEscrita(ficheiro.id);
    if (erro && ativo) parar(`Não foi possível escrever no disco (${erro})`);
  }, 1000);

  async function parar(qual = '') {
    if (!ativo) return;
    ativo = false;
    clearInterval(vigia);
    const duracao = duracaoAtual();
    grav.aGravar = false;
    grav.aGuardar = true;
    publicarEstadoGravacao();
    trabalhador.postMessage({ tipo: 'parar' });
    const fim = await Promise.race([terminou, new Promise((r) => setTimeout(() => r({ motivo: 'O motor demorou a terminar' }), 20000))]);
    largarCopias();
    trabalhador.terminate();
    await terminarFicheiro(ficheiro.id, duracao, qual || fim.motivo || '');
  }

  sessao = { parar };
  grav.formato = info.formato;
  grav.codificador = video.quem;
  grav.comSom = info.comSom;
  grav.aviso = faixaSom && info.somMuxer === 'opus'
    ? 'Este PC não tem codificador AAC: o som foi gravado em Opus, que o DaVinci Resolve pode não ler.'
    : faixaSom && !info.comSom ? 'Não foi possível gravar o som.' : '';
  grav.nome = ficheiro.nome;
  return true;
}

// ---------------------------------------------------------------------
// Reserva: MediaRecorder (WebM, entregue a cada segundo)
// ---------------------------------------------------------------------
async function iniciarMediaRecorder(faixaVideo, faixaSom, bps) {
  const formatos = [
    { mime: 'video/webm;codecs=h264,opus', nome: 'WebM (H.264 e Opus)', h264: true },
    { mime: 'video/webm;codecs=vp9,opus', nome: 'WebM (VP9 e Opus)', h264: false },
    { mime: 'video/webm;codecs=vp8,opus', nome: 'WebM (VP8 e Opus)', h264: false },
  ];
  const formato = formatos.find((f) => MediaRecorder.isTypeSupported(f.mime));
  if (!formato) throw new Error('Este sistema não consegue gravar vídeo.');

  const faixas = [faixaVideo.clone()];
  if (faixaSom) faixas.push(faixaSom.clone());
  const ficheiro = await gravador.abrirFicheiro('webm');
  const rec = new MediaRecorder(new MediaStream(faixas), { mimeType: formato.mime, videoBitsPerSecond: bps, audioBitsPerSecond: 192000 });

  let fila = Promise.resolve();
  let motivo = '';
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    fila = fila.then(async () => {
      const dados = await e.data.arrayBuffer();
      gravador.enviarDados(ficheiro.id, dados);
      grav.bytes += dados.byteLength;
    });
  };
  rec.onerror = (e) => { motivo = `A gravação parou por um erro (${(e.error && e.error.message) || 'desconhecido'})`; parar(motivo); };
  const vigia = setInterval(async () => {
    const erro = await gravador.erroEscrita(ficheiro.id);
    if (erro) parar(`Não foi possível escrever no disco (${erro})`);
  }, 1000);

  let terminou = false;
  rec.onstop = async () => {
    if (terminou) return;
    terminou = true;
    clearInterval(vigia);
    const duracao = duracaoAtual();
    grav.aGravar = false;
    grav.aGuardar = true;
    publicarEstadoGravacao();
    faixas.forEach((t) => t.stop());
    await fila;
    await terminarFicheiro(ficheiro.id, duracao, motivo);
  };

  function parar(qual = '') {
    if (rec.state === 'inactive') return;
    motivo = motivo || qual;
    rec.stop();
  }

  rec.start(1000);
  sessao = { parar };
  grav.formato = formato.nome;
  grav.codificador = 'processador';
  grav.comSom = faixas.length > 1;
  grav.aviso = 'Gravado em WebM: o DaVinci Resolve pode não abrir este formato.';
  grav.nome = ficheiro.nome;
}

// ---------------------------------------------------------------------
// Começar, parar, terminar
// ---------------------------------------------------------------------
async function terminarFicheiro(id, duracao, motivo) {
  if (capturaEcra) {
    capturaEcra.getTracks().forEach((t) => t.stop());
    capturaEcra = null;
  }
  try {
    const r = await gravador.fecharFicheiro(id);
    if (r) grav.ultima = { nome: r.nome, caminho: r.caminho, bytes: r.bytes, duracao };
    if (motivo) grav.erro = `${motivo}. A gravação até aí foi guardada.`;
    mostrarOsd(motivo ? 'Gravação parada e guardada' : 'Gravação guardada', 2500);
  } catch (e) {
    grav.erro = limparErro(e);
    mostrarOsd('A gravação falhou ao guardar', 3000);
  }
  grav.aGuardar = false;
  sessao = null;
  publicarEstadoGravacao();
}

let temporizadorEstado = null;

async function iniciarGravacao() {
  if (!gravador || grav.aGravar || grav.aGuardar || grav.aPreparar) return;
  grav.erro = '';
  grav.aviso = '';
  grav.fonte = def.gravFonte;
  if (grav.fonte === 'placa' && !temImagemDaPlaca()) {
    falhaGravacao('Não há imagem da placa para gravar.');
    return;
  }

  // A preparar: o botão fica ocupado até começar
  grav.aPreparar = true;
  publicarEstadoGravacao();

  let faixaVideo;
  let faixaSom = null;
  if (grav.fonte === 'ecra') {
    // O programa entrega o ecrã escolhido na janela Gravar (e, no Windows, o som do PC)
    try {
      capturaEcra = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: def.gravSom,
      });
    } catch (e) {
      grav.aPreparar = false;
      falhaGravacao(`Não foi possível capturar o ecrã (${e.message}).`);
      return;
    }
    faixaVideo = capturaEcra.getVideoTracks()[0];
    faixaSom = capturaEcra.getAudioTracks()[0] || null;
    // Se o ecrã deixar de estar disponível (monitor desligado), para e guarda
    faixaVideo.addEventListener('ended', () => pararGravacao('O ecrã deixou de estar disponível'));
  } else {
    faixaVideo = streamVideo.getVideoTracks()[0];
    const somVivo = streamAudio && streamAudio.getAudioTracks()[0];
    faixaSom = def.gravSom && somVivo && somVivo.readyState === 'live' ? somVivo : null;
  }

  const s = faixaVideo.getSettings();
  const w = s.width || 1920;
  const h = s.height || 1080;
  const fps = Math.round(s.frameRate || (grav.fonte === 'ecra' ? 30 : 60));
  const bps = debitoPara(w, h, fps);
  grav.bytes = 0;
  grav.perdidas = 0;
  grav.repetidas = 0;
  grav.fpsChegada = 0;
  grav.fps = fps;
  grav.debito = bps;
  grav.resolucao = `${h}p${fps}`;
  try {
    const ok = suportaWebCodecs() && await iniciarWebCodecs(faixaVideo, faixaSom, w, h, fps, bps);
    if (!ok) await iniciarMediaRecorder(faixaVideo, faixaSom, bps);
  } catch (e) {
    grav.aPreparar = false;
    if (capturaEcra) { capturaEcra.getTracks().forEach((t) => t.stop()); capturaEcra = null; }
    falhaGravacao(limparErro(e));
    return;
  }
  if (grav.fonte === 'ecra' && def.gravSom && !faixaSom) {
    grav.aviso = 'O som do PC não ficou disponível: esta gravação do ecrã não tem som.';
  }
  grav.aPreparar = false;
  grav.aGravar = true;
  grav.inicio = performance.now();
  mostrarOsd('A gravar', 1500);
  publicarEstadoGravacao();
  clearInterval(temporizadorEstado);
  temporizadorEstado = setInterval(() => {
    if (!grav.aGravar && !grav.aGuardar && !grav.aPreparar) { clearInterval(temporizadorEstado); return; }
    publicarEstadoGravacao();
  }, 1000);
}

function pararGravacao(motivo = '') {
  if (sessao && grav.aGravar) sessao.parar(motivo);
}

// A placa parou: só interessa se for a placa que está a ser gravada
function pararGravacaoDaPlaca(motivo) {
  if (grav.fonte === 'placa') pararGravacao(motivo);
}

function alternarGravacao() {
  if (grav.aGravar) pararGravacao();
  else if (!grav.aGuardar && !grav.aPreparar) iniciarGravacao();
}

// Mudar a placa, o formato ou o áudio a meio estragaria o ficheiro
function bloqueadoPorGravacao() {
  if (!grav.aGravar && !grav.aGuardar && !grav.aPreparar) return false;
  if (grav.fonte === 'ecra') return false; // a gravar o ecrã, a placa pode mudar à vontade
  mostrarOsd('Para a gravação antes de mudar a placa, o formato ou o áudio', 2500);
  return true;
}

function ligarGravacao() {
  if (!gravador) {
    el.btnGravar.hidden = true;
    return;
  }
  el.btnGravar.addEventListener('click', (e) => { if (e.detail) el.btnGravar.blur(); gravador.abrirJanela(); });
  el.rec.addEventListener('click', () => gravador.abrirJanela());

  gravador.onComando((c) => {
    switch (c.acao) {
      case 'iniciar': iniciarGravacao(); break;
      case 'parar': if (grav.aGravar) pararGravacao(c.motivo || ''); else publicarEstadoGravacao(); break;
      case 'definir':
        if (grav.aGravar || grav.aGuardar || grav.aPreparar) break;
        if (c.qualidade in QUALIDADES) def.gravQualidade = c.qualidade;
        if (typeof c.som === 'boolean') def.gravSom = c.som;
        if (c.fonte === 'placa' || c.fonte === 'ecra') def.gravFonte = c.fonte;
        grav.erro = '';
        guardar();
        publicarEstadoGravacao();
        break;
      case 'estado': publicarEstadoGravacao(); break;
      default: break;
    }
  });
  atualizarIndicadorGravacao();
  setInterval(() => { if (!grav.aGravar) publicarEstadoGravacao(); }, 3000);
}
