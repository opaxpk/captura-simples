'use strict';
// Dispositivos: listas de vídeo e áudio, e escolha automática do áudio da mesma placa.

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

// Placa ligada ou desligada: volta a ligar sozinho, mas só à placa guardada
async function aoMudarDispositivos() {
  try { await atualizarListas(); } catch { return; }

  const videoVivo = streamVideo && streamVideo.getVideoTracks()[0]?.readyState === 'live';
  if (!videoVivo) {
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
