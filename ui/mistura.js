'use strict';
// Mesa de som da gravação (lado da janela principal).
//
// Fontes: a placa de captura, o microfone e cada programa do PC (Discord, Spotify, o jogo…).
// Cada uma tem volume e silenciar próprios, guardados em def.mistura, e pode ser mudada a meio
// da gravação. A mistura em si é feita no Worker da gravação (gravacao-worker.js); aqui:
//  - abre o microfone escolhido;
//  - mede o nível da placa e do microfone para a janela Gravar;
//  - passa ao Worker o som de cada programa, que chega do Windows pelo processo principal.

const somPonte = window.som || null;

const mesaSom = {
  vigiar: false, // janela Gravar aberta: medir níveis
  nativo: { disponivel: false, motivo: '' },
  microfones: [],
  micStream: null,
  micFonte: null,
  micAnalisador: null,
  micErro: '',
  micAbrindo: 0,
  trabalhador: null, // Worker da gravação em curso
  avisos: new Map(), // erros por programa
};
let amostrasMic = null;

const MISTURA_PADRAO = () => ({
  placa: { vol: 100, mudo: false },
  micro: { vol: 100, mudo: true, id: '' },
  sistema: { vol: 100, mudo: false },
  programas: {},
  novos: true,
});

function normalizarCanal(c, padrao) {
  const r = { ...padrao };
  if (c && typeof c === 'object') {
    r.vol = limitar(c.vol, 0, 200, padrao.vol);
    r.mudo = typeof c.mudo === 'boolean' ? c.mudo : padrao.mudo;
    if ('id' in padrao) r.id = typeof c.id === 'string' ? c.id : '';
    if (typeof c.nome === 'string') r.nome = c.nome.slice(0, 80);
  }
  return r;
}

function normalizarMistura(m) {
  const p = MISTURA_PADRAO();
  const r = {
    placa: normalizarCanal(m && m.placa, p.placa),
    micro: normalizarCanal(m && m.micro, p.micro),
    sistema: normalizarCanal(m && m.sistema, p.sistema),
    programas: {},
    novos: !(m && m.novos === false),
  };
  const progs = (m && m.programas && typeof m.programas === 'object') ? Object.entries(m.programas) : [];
  for (const [id, c] of progs.slice(-200)) r.programas[id] = normalizarCanal(c, { vol: 100, mudo: !r.novos });
  return r;
}

def.mistura = normalizarMistura(def.mistura);

// O que o Worker precisa para misturar
function ganhosMistura() {
  const m = def.mistura;
  return {
    ganhos: { placa: m.placa, micro: m.micro, sistema: m.sistema, programas: m.programas },
    novos: m.novos,
  };
}

function enviarMisturaAoTrabalhador() {
  if (mesaSom.trabalhador) mesaSom.trabalhador.postMessage({ tipo: 'mistura', ...ganhosMistura() });
}

// ---------------------------------------------------------------------
// Microfone
// ---------------------------------------------------------------------
function precisaMicrofone() {
  const aGravarAgora = grav.aGravar || grav.aPreparar;
  if (aGravarAgora && mesaSom.micStream) return true; // a meio da gravação não fecha
  return !def.mistura.micro.mudo && (mesaSom.vigiar || aGravarAgora);
}

function fecharMicrofone() {
  if (mesaSom.micFonte) { try { mesaSom.micFonte.disconnect(); } catch { /* */ } }
  mesaSom.micFonte = null;
  if (mesaSom.micStream) mesaSom.micStream.getTracks().forEach((t) => t.stop());
  mesaSom.micStream = null;
}

async function atualizarMicrofone(forcar = false) {
  const precisa = precisaMicrofone();
  if (!precisa) { if (mesaSom.micStream) { fecharMicrofone(); publicarEstadoGravacao(); } return; }
  if (mesaSom.micStream && !forcar) return;
  const meu = ++mesaSom.micAbrindo;
  fecharMicrofone();
  const id = def.mistura.micro.id;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    if (meu !== mesaSom.micAbrindo || !precisaMicrofone()) { s.getTracks().forEach((t) => t.stop()); return; }
    mesaSom.micStream = s;
    mesaSom.micErro = '';
    prepararContexto();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!mesaSom.micAnalisador) {
      mesaSom.micAnalisador = ctx.createAnalyser();
      mesaSom.micAnalisador.fftSize = 512;
      amostrasMic = new Float32Array(mesaSom.micAnalisador.fftSize);
    }
    mesaSom.micFonte = ctx.createMediaStreamSource(s);
    mesaSom.micFonte.connect(mesaSom.micAnalisador); // só para medir: não vai para as colunas
    const faixa = s.getAudioTracks()[0];
    faixa.onended = () => {
      if (mesaSom.micStream !== s) return;
      fecharMicrofone();
      mesaSom.micErro = 'O microfone foi desligado.';
      publicarEstadoGravacao();
    };
    // A gravar: o microfone entra na mistura a partir de agora
    if (grav.aGravar && typeof juntarFonteGravacao === 'function') juntarFonteGravacao('micro', 'micro', faixa);
  } catch (e) {
    if (meu !== mesaSom.micAbrindo) return;
    mesaSom.micErro = e && e.name === 'NotReadableError' ? 'O microfone está ocupado por outro programa.'
      : e && e.name === 'NotFoundError' ? 'Não foi encontrado nenhum microfone.'
        : e && e.name === 'OverconstrainedError' ? 'O microfone escolhido não está ligado.'
          : 'Não foi possível abrir o microfone.';
  }
  publicarEstadoGravacao();
}

async function listarMicrofones() {
  try {
    const todos = await navigator.mediaDevices.enumerateDevices();
    mesaSom.microfones = todos
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications' && d.deviceId !== 'default' && d.deviceId !== def.audioId)
      .map((d, i) => ({ id: d.deviceId, nome: (d.label || `Microfone ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') }));
  } catch {
    mesaSom.microfones = [];
  }
}

// ---------------------------------------------------------------------
// Níveis para a janela Gravar (10 vezes por segundo, só com ela aberta)
// ---------------------------------------------------------------------
function picoDe(analisadorX, amostras) {
  if (!analisadorX || !amostras) return 0;
  analisadorX.getFloatTimeDomainData(amostras);
  let pico = 0;
  for (let i = 0; i < amostras.length; i++) {
    const a = Math.abs(amostras[i]);
    if (a > pico) pico = a;
  }
  return pico;
}

setInterval(() => {
  if (!somPonte || !mesaSom.vigiar) return;
  somPonte.publicarNiveis({
    placa: typeof picoPlaca === 'function' ? picoPlaca() : 0,
    micro: mesaSom.micStream ? picoDe(mesaSom.micAnalisador, amostrasMic) : 0,
    sistema: 0,
  });
}, 100);

// ---------------------------------------------------------------------
// Comandos da janela Gravar
// ---------------------------------------------------------------------
function mudarMistura(c) {
  const m = def.mistura;
  if (typeof c.novos === 'boolean') m.novos = c.novos;
  if (typeof c.microId === 'string' && !(grav.aGravar || grav.aPreparar)) {
    m.micro.id = c.microId;
    if (mesaSom.micStream) atualizarMicrofone(true);
  }
  if (typeof c.chave === 'string') {
    let canal = null;
    if (c.chave === 'placa' || c.chave === 'micro' || c.chave === 'sistema') canal = m[c.chave];
    else if (c.chave.startsWith('p:')) {
      const id = c.chave.slice(2).slice(0, 400);
      canal = m.programas[id] || (m.programas[id] = { vol: 100, mudo: !m.novos });
      if (typeof c.nome === 'string') canal.nome = c.nome.slice(0, 80);
      // Lembra no máximo 200 programas (os mais recentes)
      const ids = Object.keys(m.programas);
      if (ids.length > 200) delete m.programas[ids[0]];
    }
    if (canal) {
      if (Number.isFinite(c.vol)) canal.vol = Math.round(Math.min(200, Math.max(0, c.vol)));
      if (typeof c.mudo === 'boolean') canal.mudo = c.mudo;
    }
    if (c.chave === 'micro') atualizarMicrofone();
  }
  guardar();
  enviarMisturaAoTrabalhador();
  publicarEstadoGravacao();
}

// O que a janela Gravar precisa de saber da mesa
function estadoMesa() {
  return {
    mistura: def.mistura,
    microfones: mesaSom.microfones,
    micErro: mesaSom.micErro,
    micAberto: !!mesaSom.micStream,
    somNativo: mesaSom.nativo,
    temSomPlaca: !!(streamAudio && streamAudio.getAudioTracks()[0] && streamAudio.getAudioTracks()[0].readyState === 'live'),
    temSistema: def.gravFonte === 'ecra' && !mesaSom.nativo.disponivel,
    avisosProgramas: [...mesaSom.avisos.values()],
  };
}

// ---------------------------------------------------------------------
// Gravação: som dos programas, do Windows para o Worker
// ---------------------------------------------------------------------
async function comecarSomProgramas(trabalhador) {
  mesaSom.trabalhador = trabalhador;
  mesaSom.avisos.clear();
  if (somPonte && mesaSom.nativo.disponivel) await somPonte.gravar(true).catch(() => {});
}

function pararSomProgramas() {
  mesaSom.trabalhador = null;
  if (somPonte && mesaSom.nativo.disponivel) somPonte.gravar(false).catch(() => {});
  atualizarMicrofone();
}

function ligarMesaSom() {
  if (!somPonte) return;
  somPonte.info().then((i) => { mesaSom.nativo = i || mesaSom.nativo; publicarEstadoGravacao(); }).catch(() => {});
  somPonte.onVigiar((ativo) => {
    mesaSom.vigiar = !!ativo;
    if (ativo) listarMicrofones().then(() => publicarEstadoGravacao());
    atualizarMicrofone();
  });
  somPonte.onDados((programa, pid, dados, tempo) => {
    const t = mesaSom.trabalhador;
    if (!t || !(dados instanceof Float32Array)) return;
    t.postMessage({ tipo: 'pcm', chave: `p:${programa}#${pid}`, grupo: `p:${programa}`, dados, tempo }, [dados.buffer]);
  });
  somPonte.onErro((programa, nome, erro) => {
    mesaSom.avisos.set(programa, `${nome}: ${erro}`);
    publicarEstadoGravacao();
  });
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    listarMicrofones().then(() => publicarEstadoGravacao());
  });
}
