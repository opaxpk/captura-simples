'use strict';
// Gravação: lado da janela principal.
//
// A imagem e o som da placa já estão abertos aqui para a pré-visualização, por isso a
// gravação usa essas mesmas faixas (uma cópia leve de cada): não há nova leitura da placa.
//
// Motor principal: WebCodecs + mp4-muxer.
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
const INTERVALO_CHAVE_US = 2e6; // uma imagem completa a cada 2 s (bom para editar e para o YouTube)
const FILA_MAXIMA = 8; // se o codificador atrasar mais do que isto, salta imagens em vez de encher a memória

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

async function configurarAudio(canais, taxa) {
  for (const [codec, muxer] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: taxa, numberOfChannels: canais, bitrate: 192000 };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxer };
    } catch { /* tenta a seguinte */ }
  }
  return null;
}

// Lê a primeira amostra para saber canais e frequência (com limite de tempo)
async function primeiraAmostra(leitor, ms) {
  const tempo = new Promise((r) => setTimeout(() => r({ value: null, done: true, esgotou: true }), ms));
  return Promise.race([leitor.read(), tempo]);
}

async function iniciarWebCodecs(faixaVideo, faixaSom, w, h, fps, bps) {
  const video = await configurarVideo(w, h, fps, bps);
  if (!video) return false; // passa para o MediaRecorder

  // Cópias leves das faixas: parar a gravação não mexe na pré-visualização
  const copiaVideo = faixaVideo.clone();
  const copiaSom = faixaSom ? faixaSom.clone() : null;
  const leitorVideo = new MediaStreamTrackProcessor({ track: copiaVideo }).readable.getReader();
  const leitorSom = copiaSom ? new MediaStreamTrackProcessor({ track: copiaSom }).readable.getReader() : null;

  let primeiroSom = null;
  let audio = null;
  if (leitorSom) {
    const r = await primeiraAmostra(leitorSom, 1500);
    primeiroSom = r.value || null;
    // Sem som a chegar (ex.: nada a tocar no PC): usa as definições da faixa e preenche com silêncio
    const ss = copiaSom.getSettings();
    const canais = primeiroSom ? primeiroSom.numberOfChannels : (ss.channelCount || 2);
    const taxa = primeiroSom ? primeiroSom.sampleRate : (ss.sampleRate || 48000);
    if (copiaSom.readyState === 'live') audio = await configurarAudio(canais, taxa);
    if (!audio) {
      if (primeiroSom) primeiroSom.close();
      primeiroSom = null;
      leitorSom.cancel().catch(() => {});
      copiaSom.stop();
    }
  }

  let ficheiro;
  try {
    ficheiro = await gravador.abrirFicheiro('mp4');
  } catch (e) {
    copiaVideo.stop();
    if (copiaSom) copiaSom.stop();
    throw e;
  }

  let erroMotor = null;
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.StreamTarget({
      onData: (dados, posicao) => {
        gravador.enviarDados(ficheiro.id, dados, posicao);
        grav.bytes = Math.max(grav.bytes, posicao + dados.byteLength);
      },
    }),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    audio: audio ? { codec: audio.muxer, numberOfChannels: audio.config.numberOfChannels, sampleRate: audio.config.sampleRate } : undefined,
    fastStart: 'fragmented',
    minFragmentDuration: 1,
    // Imagem e som usam o mesmo relógio: o mesmo desvio para os dois mantém-nos alinhados
    firstTimestampBehavior: 'cross-track-offset',
  });

  const codVideo = new VideoEncoder({
    output: (pedaco, meta) => muxer.addVideoChunk(pedaco, meta),
    error: (e) => { erroMotor = e; },
  });
  codVideo.configure(video.config);

  const codSom = audio ? new AudioEncoder({
    output: (pedaco, meta) => muxer.addAudioChunk(pedaco, meta),
    error: (e) => { erroMotor = e; },
  }) : null;
  if (codSom) codSom.configure(audio.config);

  let ativo = true;
  let motivo = '';
  let ultimaChave = -Infinity;
  let desvioRelogio = null; // relógio das imagens (µs) menos o relógio da página (µs)
  let proximoSomUs = null; // onde acaba o último som codificado

  const cicloVideo = (async () => {
    for (;;) {
      const { value: imagem, done } = await leitorVideo.read();
      if (done || !imagem) break;
      if (!ativo || erroMotor) { imagem.close(); continue; }
      desvioRelogio = imagem.timestamp - performance.now() * 1000;
      if (codVideo.encodeQueueSize > FILA_MAXIMA) {
        grav.perdidas++;
        imagem.close();
        continue;
      }
      const chave = imagem.timestamp - ultimaChave >= INTERVALO_CHAVE_US;
      if (chave) ultimaChave = imagem.timestamp;
      codVideo.encode(imagem, { keyFrame: chave });
      imagem.close();
    }
  })();

  const taxaSom = audio ? audio.config.sampleRate : 48000;
  const canaisSom = audio ? audio.config.numberOfChannels : 2;
  function codificarSom(amostra) {
    const fim = amostra.timestamp + (amostra.numberOfFrames / amostra.sampleRate) * 1e6;
    // Som que se sobrepõe a silêncio já inserido é descartado (os tempos têm de ir sempre para a frente)
    if (proximoSomUs !== null && amostra.timestamp < proximoSomUs - 20000) return;
    codSom.encode(amostra);
    proximoSomUs = fim;
  }
  // Se não chegar som (nada a tocar), insere silêncio para o ficheiro continuar a ter som
  function preencherSilencio() {
    if (!ativo || !codSom || erroMotor || desvioRelogio === null) return;
    const agora = performance.now() * 1000 + desvioRelogio;
    if (proximoSomUs === null) proximoSomUs = agora - 100000;
    while (agora - proximoSomUs > 300000) {
      const frames = Math.round(taxaSom / 10); // 100 ms
      const silencio = new AudioData({
        format: 'f32-planar', sampleRate: taxaSom, numberOfChannels: canaisSom, numberOfFrames: frames,
        timestamp: Math.round(proximoSomUs), data: new Float32Array(frames * canaisSom),
      });
      codSom.encode(silencio);
      silencio.close();
      proximoSomUs += (frames / taxaSom) * 1e6;
    }
  }
  const tempoSilencio = codSom ? setInterval(preencherSilencio, 250) : null;

  const cicloSom = codSom ? (async () => {
    if (primeiroSom) { codificarSom(primeiroSom); primeiroSom.close(); }
    for (;;) {
      const { value: amostra, done } = await leitorSom.read();
      if (done || !amostra) break;
      if (ativo && !erroMotor) codificarSom(amostra);
      amostra.close();
    }
  })() : Promise.resolve();

  const vigia = setInterval(async () => {
    if (erroMotor && ativo) parar(`O codificador parou (${erroMotor.message || erroMotor})`);
    const erro = await gravador.erroEscrita(ficheiro.id);
    if (erro && ativo) parar(`Não foi possível escrever no disco (${erro})`);
  }, 1000);

  async function parar(qual = '') {
    if (!ativo) return;
    ativo = false;
    motivo = qual;
    clearInterval(vigia);
    if (tempoSilencio) clearInterval(tempoSilencio);
    const duracao = duracaoAtual();
    grav.aGravar = false;
    grav.aGuardar = true;
    publicarEstadoGravacao();

    copiaVideo.stop();
    if (copiaSom) copiaSom.stop();
    await Promise.allSettled([cicloVideo, cicloSom]);
    try {
      if (codVideo.state === 'configured') await codVideo.flush();
      if (codSom && codSom.state === 'configured') await codSom.flush();
      muxer.finalize();
    } catch (e) {
      motivo = motivo || `A gravação não terminou bem (${e.message})`;
    }
    try { codVideo.close(); } catch { /* */ }
    try { if (codSom) codSom.close(); } catch { /* */ }
    await terminarFicheiro(ficheiro.id, duracao, motivo);
  }

  sessao = { parar };
  grav.formato = audio ? `MP4 (H.264 e ${audio.muxer === 'aac' ? 'AAC' : 'Opus'})` : 'MP4 (H.264, sem som)';
  grav.codificador = video.quem;
  grav.comSom = !!audio;
  grav.aviso = faixaSom && audio && audio.muxer === 'opus'
    ? 'Este PC não tem codificador AAC: o som foi gravado em Opus, que o DaVinci Resolve pode não ler.'
    : faixaSom && !audio ? 'Não foi possível gravar o som.' : '';
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
