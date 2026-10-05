'use strict';
// Arranque: liga os controlos, os atalhos e começa a captura.

// ---------- Controlos da barra ----------
aoEscolherSegmento(el.segRes, (valor) => {
  if (valor === def.res) return;
  def.res = valor;
  marcarSegmento(el.segRes, def.res);
  guardar();
  ligarVideo();
});

aoEscolherSegmento(el.segFps, (valor) => {
  if (Number(valor) === def.fps) return;
  def.fps = Number(valor);
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

// ---------- Barra adapta-se à largura ----------
window.addEventListener('resize', ajustarBarraDepois);
document.fonts?.ready.then(ajustarBarraDepois);

// ---------- Ecrã inteiro e rato ----------
ponte.onFullscreenChange(aplicarEcraInteiro);
document.addEventListener('mousemove', mostrarControlos);
el.video.addEventListener('dblclick', () => ponte.toggleFullscreen());
el.estado.addEventListener('dblclick', (e) => { if (e.target === el.estado) ponte.toggleFullscreen(); });
el.btnEcra.addEventListener('click', (e) => { if (e.detail) el.btnEcra.blur(); ponte.toggleFullscreen(); });

// Clicar fora de um painel fecha-o
document.addEventListener('mousedown', (e) => {
  if (!painelAberto()) return;
  const dentro = e.target.closest('.painel, #btnDefinicoes, #btnAtualizar');
  if (!dentro) fecharPainel();
});

// ---------- Placa ligada / desligada ----------
let temporizadorDisp = null;
navigator.mediaDevices?.addEventListener('devicechange', () => {
  clearTimeout(temporizadorDisp);
  temporizadorDisp = setTimeout(aoMudarDispositivos, 800);
});

// ---------- Atalhos de teclado ----------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const alvo = e.target;
  const emLista = alvo instanceof HTMLSelectElement;
  const emDeslizador = alvo instanceof HTMLInputElement && alvo.type === 'range';

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
  if (e.key === '?') {
    e.preventDefault();
    if (painelAberto(el.ajuda)) fecharPainel(el.ajuda);
    else abrirPainel(el.ajuda);
    return;
  }

  const tecla = e.key.toLowerCase();
  if (tecla === 'm') { e.preventDefault(); alternarMute(); osdVolume(); return; }
  if (tecla === 'h') { e.preventDefault(); alternarBarra(); return; }
  if (tecla === 'c') { e.preventDefault(); alternarCorrecaoCores(); return; }

  // Nas listas e deslizadores as setas servem para escolher
  if (emLista || emDeslizador) return;

  if (e.key === 'ArrowUp') { e.preventDefault(); mudarVolume(5); osdVolume(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); mudarVolume(-5); osdVolume(); }
  else if (e.key === ']') { e.preventDefault(); mudarAtraso(10); }
  else if (e.key === '[') { e.preventDefault(); mudarAtraso(-10); }
});

window.addEventListener('beforeunload', () => {
  pararVideo();
  pararAudio();
});

// ---------- Início ----------
ligarDefinicoes();
ligarAtualizacoes();

marcarSegmento(el.segRes, def.res);
marcarSegmento(el.segFps, def.fps);
aplicarVolume();
aplicarImagem();
aplicarSempreCima();
atualizarControlosDefinicoes();
aplicarModoBarra();
ajustarBarra();

ponte.isFullscreen().then((estado) => {
  aplicarEcraInteiro(estado);
  if (def.abrirEcraInteiro && !estado) ponte.setFullscreen(true);
});

if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  el.video.requestVideoFrameCallback(contarFrame);
}
setInterval(porSegundo, 1000);
requestAnimationFrame(desenharNivel);

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  mostrarAviso({ message: 'Este sistema não suporta captura de vídeo.' });
} else {
  iniciarTudo();
}

// Avisa o programa de que esta versão arrancou bem
if (atualizador) atualizador.pronto();
