'use strict';
// Som: Web Audio (nunca pelo <video>), volume, atraso do som e medidor de nível.
//   placa → [atraso, só se > 0] → volume → colunas
//   placa → medidor (à parte, não fica no caminho do som)

let ctx = null;
let fonteAudio = null;
let ganho = null;
let atraso = null;
let analisador = null;
let amostrasSom = null;

function prepararContexto() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  ganho = ctx.createGain();
  ganho.connect(ctx.destination);
  atraso = ctx.createDelay(1.0);
  atraso.delayTime.value = def.atrasoSom / 1000;
  atraso.connect(ganho);
  analisador = ctx.createAnalyser();
  analisador.fftSize = 512;
  amostrasSom = new Float32Array(analisador.fftSize);
}

// Com atraso 0 o som vai direto, sem passar pelo nó de atraso
function ligarCadeia() {
  if (!fonteAudio) return;
  try { fonteAudio.disconnect(); } catch { /* */ }
  fonteAudio.connect(analisador);
  fonteAudio.connect(def.atrasoSom > 0 ? atraso : ganho);
}

function aplicarAtraso() {
  if (atraso && ctx) atraso.delayTime.setTargetAtTime(def.atrasoSom / 1000, ctx.currentTime, 0.02);
  const precisaAtraso = def.atrasoSom > 0;
  if (fonteAudio && precisaAtraso !== aplicarAtraso.ultimo) ligarCadeia();
  aplicarAtraso.ultimo = precisaAtraso;
}

function mudarAtraso(delta) {
  def.atrasoSom = Math.min(250, Math.max(0, def.atrasoSom + delta));
  aplicarAtraso();
  atualizarControlosDefinicoes();
  guardar();
  mostrarOsd(def.atrasoSom ? `Atraso do som ${def.atrasoSom} ms` : 'Som sem atraso');
}

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

    prepararContexto();
    if (ctx.state === 'suspended') await ctx.resume();

    streamAudio = s;
    fonteAudio = ctx.createMediaStreamSource(s);
    ligarCadeia();
    aplicarAtraso.ultimo = def.atrasoSom > 0;
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

function osdVolume() {
  mostrarOsd(def.mute ? 'Som desligado' : `Volume ${def.volume}%`);
}

// =====================================================================
// Medidor: mostra o som que chega, mesmo com o volume em 0
// =====================================================================
let nivelSuave = 0;
function desenharNivel() {
  requestAnimationFrame(desenharNivel);
  if (document.body.classList.contains('inativo') || document.hidden) return;
  let alvo = 0;
  if (analisador && fonteAudio) {
    analisador.getFloatTimeDomainData(amostrasSom);
    let pico = 0;
    for (let i = 0; i < amostrasSom.length; i++) {
      const a = Math.abs(amostrasSom[i]);
      if (a > pico) pico = a;
    }
    const db = 20 * Math.log10(pico || 1e-6);
    alvo = Math.min(1, Math.max(0, (db + 54) / 54));
  }
  nivelSuave = alvo > nivelSuave ? alvo : nivelSuave * 0.9 + alvo * 0.1;
  if (nivelSuave < 0.005) nivelSuave = 0;
  el.nivel.style.transform = `scaleX(${nivelSuave.toFixed(3)})`;
}
