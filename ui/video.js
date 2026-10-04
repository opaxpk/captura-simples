'use strict';
// Vídeo: abrir a placa, luz de sinal (formato e FPS reais) e deteção de falta de imagem HDMI.

function pararStream(s) {
  if (!s) return;
  s.getTracks().forEach((t) => { t.onended = null; t.stop(); });
}

function pararVideo() {
  pararStream(streamVideo);
  streamVideo = null;
  el.video.srcObject = null;
  definirSemImagem(false);
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
// Luz de sinal
// =====================================================================
let framesContados = 0;
let inicioContagem = performance.now();
let fpsRecebidos = 0;

function contarFrame() {
  framesContados++;
  el.video.requestVideoFrameCallback(contarFrame);
}

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
  if (semImagem) dica += '\n\nA placa está ligada mas a imagem está toda preta.';
  if (notaAudio) dica += `\n\nÁudio: ${notaAudio}.`;

  definirSinal(
    formatoCerto && !perdeImagens && !semImagem ? 'ok' : 'aviso',
    semImagem ? 'Sem imagem' : `${s.height}p${fps}`,
    perdeImagens && !semImagem ? `chegam ${recebidos}` : '',
    dica,
  );
}

// =====================================================================
// Falta de imagem HDMI: a placa envia imagem toda preta.
// Uma vez por segundo vê uma miniatura de 32×18 (custo desprezável).
// =====================================================================
const SEGUNDOS_PARA_AVISAR = 5;
const amostra = document.createElement('canvas');
amostra.width = 32;
amostra.height = 18;
const ctxAmostra = amostra.getContext('2d', { willReadFrequently: true });
let segundosPretos = 0;
let semImagem = false;

function definirSemImagem(estado) {
  if (estado === semImagem) return;
  semImagem = estado;
  el.semImagem.hidden = !estado;
  atualizarIndicador();
}

function verificarImagemPreta() {
  if (!streamVideo || el.video.readyState < 2 || document.hidden) { segundosPretos = 0; return; }
  try {
    ctxAmostra.drawImage(el.video, 0, 0, amostra.width, amostra.height);
    const d = ctxAmostra.getImageData(0, 0, amostra.width, amostra.height).data;
    let maximo = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = Math.max(d[i], d[i + 1], d[i + 2]);
      if (l > maximo) maximo = l;
    }
    // Em "gama limitada" o preto chega a 16, por isso a margem
    segundosPretos = maximo <= 24 ? segundosPretos + 1 : 0;
    definirSemImagem(segundosPretos >= SEGUNDOS_PARA_AVISAR);
  } catch {
    segundosPretos = 0;
  }
}

function porSegundo() {
  const agora = performance.now();
  fpsRecebidos = (framesContados * 1000) / (agora - inicioContagem);
  framesContados = 0;
  inicioContagem = agora;
  verificarImagemPreta();
  atualizarIndicador();
}
