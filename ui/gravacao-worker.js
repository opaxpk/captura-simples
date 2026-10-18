'use strict';
// Motor da gravação, numa linha de execução própria (Worker).
// A janela principal está ocupada a desenhar a imagem em direto; se as imagens para gravar
// fossem lidas lá, o Chromium deitava fora as que não fossem lidas a tempo (com 1080p60 no
// ecrã perdiam-se cerca de 15 por segundo). Aqui ninguém atrasa a leitura.
//
// Ritmo constante: o ficheiro sai com o número exato de imagens por segundo (por exemplo 60).
// A placa e o ecrã entregam imagens com pequenas variações; cada imagem é posta na sua "vaga"
// de 1/60 s. Se faltar uma imagem, repete-se a anterior; se vierem duas para a mesma vaga, fica
// a primeira. É o que o OBS faz, e o DaVinci Resolve lida mal com ficheiros de ritmo variável.

importScripts('mp4-muxer.js');

const INTERVALO_CHAVE_S = 2; // uma imagem completa a cada 2 s
const FILA_MAXIMA = 12; // codificador atrasado: salta vagas em vez de encher a memória
const MAX_REPETIDAS_SEGUIDAS = 240; // não preencher pausas enormes de uma vez

let ativo = false;
let aParar = false;

function enviar(msg, transferir) {
  self.postMessage(msg, transferir || []);
}

const TAXA = 48000; // o som gravado é sempre 48 kHz estéreo
const LATENCIA_MISTURA_US = 300000; // espera pelo som que chega atrasado antes de o misturar
const TOLERANCIA_FRAMES = 960; // 20 ms: pequenas diferenças de tempo não partem o som
const LATENCIA_CHEGADA_US = 30000; // atraso típico entre o som tocar e chegar aqui

async function configurarAudio() {
  for (const [codec, muxer] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: TAXA, numberOfChannels: 2, bitrate: 192000 };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxer };
    } catch { /* tenta a seguinte */ }
  }
  return null;
}

// Converte uma amostra do Chromium (qualquer formato, taxa e número de canais) em
// dois canais a 48 kHz
function reamostrar(x, taxa) {
  if (taxa === TAXA) return x;
  const n = Math.max(1, Math.round((x.length * TAXA) / taxa));
  const y = new Float32Array(n);
  const passo = taxa / TAXA;
  for (let i = 0; i < n; i++) {
    const pos = i * passo;
    const a = Math.floor(pos);
    const f = pos - a;
    const v0 = x[Math.min(a, x.length - 1)];
    const v1 = x[Math.min(a + 1, x.length - 1)];
    y[i] = v0 + (v1 - v0) * f;
  }
  return y;
}

function deAudioData(a) {
  const n = a.numberOfFrames;
  let esq = new Float32Array(n);
  a.copyTo(esq, { planeIndex: 0, format: 'f32-planar' });
  let dir = esq;
  if (a.numberOfChannels > 1) {
    dir = new Float32Array(n);
    a.copyTo(dir, { planeIndex: 1, format: 'f32-planar' });
  }
  if (a.sampleRate !== TAXA) {
    esq = reamostrar(esq, a.sampleRate);
    dir = a.numberOfChannels > 1 ? reamostrar(dir, a.sampleRate) : esq;
  }
  return [esq, dir];
}

// ---------------------------------------------------------------------
// Mesa de som: junta a placa, o microfone e cada programa num só som estéreo.
// Cada fonte é posta no sítio certo pelo seu tempo (o mesmo relógio das imagens), com o
// volume da sua linha; silenciada, não entra. O que sai está sempre ~300 ms atrás do
// presente, para dar tempo a que todas as fontes cheguem.
// ---------------------------------------------------------------------
class Mesa {
  constructor() {
    this.capacidade = TAXA * 4; // 4 s
    this.buf = new Float32Array(this.capacidade * 2);
    this.t0 = null;
    this.saida = 0; // próximo frame a sair (frames desde t0)
    this.fontes = new Map(); // chave -> { proximo, ganho, modo, desvio }
    this.ganhos = {};
    this.novos = true;
    this.descartadas = 0;
  }

  // Volume de uma fonte: placa, micro, sistema ou p:<programa>
  ganhoAlvo(grupo) {
    const g = grupo.startsWith('p:') ? (this.ganhos.programas || {})[grupo.slice(2)] : this.ganhos[grupo];
    if (!g) return grupo.startsWith('p:') ? (this.novos ? 1 : 0) : 1;
    return g.mudo ? 0 : Math.max(0, Math.min(2, (Number(g.vol) || 0) / 100));
  }

  // tempo: µs no relógio da fonte; agora: µs no relógio das imagens (estimado), ou null
  adicionar(chave, grupo, esq, dir, tempo, agora) {
    if (this.t0 === null) return;
    const n = esq.length;
    let st = this.fontes.get(chave);
    if (!st) {
      st = { proximo: null, ganho: this.ganhoAlvo(grupo), modo: null, desvio: 0 };
      this.fontes.set(chave, st);
    }
    // Relógio: se a fonte usa o mesmo relógio das imagens, usa-se o tempo dela; se não
    // (diferença de mais de 0,5 s), usa-se a hora de chegada menos o atraso mais pequeno visto
    if (agora !== null) {
      const durUs = (n / TAXA) * 1e6;
      if (st.modo === null) st.modo = Math.abs(agora - durUs - tempo) < 500000 ? 'direto' : 'chegada';
      if (st.modo === 'chegada') {
        const d = agora - durUs - tempo;
        st.desvio = st.proximo === null ? d : Math.min(st.desvio, d);
      }
    }
    const t = st.modo === 'chegada' ? tempo + st.desvio : tempo;
    let f = Math.round(((t - this.t0) * TAXA) / 1e6);
    if (st.modo === 'chegada' && st.proximo !== null && agora !== null) {
      // Relógio da fonte não serve: o som segue seguido e só se acerta pela hora de chegada
      // se fugir mais de 150 ms (por exemplo depois de uma pausa)
      const pelaChegada = Math.round(((agora - (n / TAXA) * 1e6 - LATENCIA_CHEGADA_US - this.t0) * TAXA) / 1e6);
      f = Math.abs(pelaChegada - st.proximo) > TAXA * 0.15 ? pelaChegada : st.proximo;
    } else if (st.proximo !== null && Math.abs(f - st.proximo) <= TOLERANCIA_FRAMES) {
      f = st.proximo; // contínuo
    }
    st.proximo = f + n;

    const g0 = st.ganho;
    const g1 = this.ganhoAlvo(grupo);
    st.ganho = g1;
    if (g0 === 0 && g1 === 0) return;
    const cap = this.capacidade;
    for (let i = 0; i < n; i++) {
      const idx = f + i;
      if (idx < this.saida) { this.descartadas++; continue; } // chegou tarde de mais
      if (idx >= this.saida + cap) break; // demasiado à frente (não devia acontecer)
      const g = g0 + ((g1 - g0) * i) / n; // muda o volume suavemente, sem estalos
      const pos = (idx % cap) * 2;
      this.buf[pos] += esq[i] * g;
      this.buf[pos + 1] += dir[i] * g;
    }
  }

  // Entrega o som misturado até ao frame indicado (exclusive), em blocos de até 100 ms
  emitir(ate, codificar) {
    const cap = this.capacidade;
    while (this.saida < ate) {
      const ini = this.saida % cap;
      const n = Math.min(ate - this.saida, TAXA / 10, cap - ini);
      const bloco = this.buf.slice(ini * 2, (ini + n) * 2);
      this.buf.fill(0, ini * 2, (ini + n) * 2);
      for (let i = 0; i < bloco.length; i++) {
        const v = bloco[i];
        bloco[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      codificar(bloco, n, this.t0 + (this.saida * 1e6) / TAXA);
      this.saida += n;
    }
  }
}

let mesa = null;
let aceitarSom = false;
const leitoresSom = [];

// Fonte de som do Chromium (placa, microfone, som do PC): lê no Worker e põe na mesa
function lerFonte(chave, grupo, leitura, agoraVideo) {
  const leitor = leitura.getReader();
  leitoresSom.push(leitor);
  return (async () => {
    for (;;) {
      const { value: amostra, done } = await leitor.read();
      if (done || !amostra) break;
      try {
        if (aceitarSom && mesa) {
          const [esq, dir] = deAudioData(amostra);
          mesa.adicionar(chave, grupo, esq, dir, amostra.timestamp, agoraVideo());
        }
      } finally {
        amostra.close();
      }
    }
  })();
}

async function gravar(p) {
  const { leituraVideo, fontesSom, comSom, mistura, configVideo, largura, altura, fps } = p;
  const leitorVideo = leituraVideo.getReader();
  ativo = true;

  const audio = comSom ? await configurarAudio() : null;

  // ---------- Ficheiro MP4 fragmentado, enviado à janela principal à medida que sai ----------
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.StreamTarget({
      onData: (dados, posicao) => {
        const copia = dados.slice(); // o mp4-muxer pode reutilizar o buffer
        enviar({ tipo: 'dados', dados: copia.buffer, posicao }, [copia.buffer]);
      },
    }),
    video: { codec: 'avc', width: largura, height: altura, frameRate: fps },
    audio: audio ? { codec: audio.muxer, numberOfChannels: 2, sampleRate: TAXA } : undefined,
    fastStart: 'fragmented',
    minFragmentDuration: 1,
    // Cada faixa começa em zero; o alinhamento entre imagem e som é feito aqui (ver "Som")
    firstTimestampBehavior: 'offset',
  });

  let erroMotor = null;
  const codVideo = new VideoEncoder({
    output: (pedaco, meta) => muxer.addVideoChunk(pedaco, meta),
    error: (e) => { erroMotor = e; },
  });
  codVideo.configure(configVideo);
  const codSom = audio ? new AudioEncoder({
    output: (pedaco, meta) => muxer.addAudioChunk(pedaco, meta),
    error: (e) => { erroMotor = e; },
  }) : null;
  if (codSom) codSom.configure(audio.config);

  enviar({
    tipo: 'comecou',
    formato: audio ? `MP4 (H.264 e ${audio.muxer === 'aac' ? 'AAC' : 'Opus'})` : 'MP4 (H.264, sem som)',
    somMuxer: audio ? audio.muxer : null,
    comSom: !!audio,
  });

  // ---------- Imagem a ritmo constante ----------
  const vagaUs = 1e6 / fps;
  const vagasPorChave = Math.max(1, Math.round(fps * INTERVALO_CHAVE_S));
  let t0 = null; // tempo da primeira imagem (relógio das imagens, µs)
  let proximaVaga = 0;
  let ultima = null; // cópia da última imagem, para repetir
  let desvioRelogio = null; // relógio das imagens menos performance.now() deste Worker (µs)
  let ultimaChegada = 0;
  const contas = { recebidas: 0, repetidas: 0, saltadas: 0, porSegundo: 0 };
  let recebidasNoSegundo = 0;
  const agoraVideo = () => (desvioRelogio === null ? null : performance.now() * 1000 + desvioRelogio);

  function codificarVaga(imagem, vaga) {
    const ts = Math.round(t0 + vaga * vagaUs);
    const copia = new VideoFrame(imagem, { timestamp: ts, duration: Math.round(vagaUs) });
    codVideo.encode(copia, { keyFrame: vaga % vagasPorChave === 0 });
    copia.close();
  }

  // Preenche vagas em falta repetindo a última imagem, até à vaga indicada (exclusive)
  function repetirAte(vaga) {
    let n = 0;
    while (ultima && proximaVaga < vaga && n < MAX_REPETIDAS_SEGUIDAS) {
      if (codVideo.encodeQueueSize > FILA_MAXIMA) { contas.saltadas += vaga - proximaVaga; proximaVaga = vaga; break; }
      codificarVaga(ultima, proximaVaga);
      contas.repetidas++;
      proximaVaga++;
      n++;
    }
    if (proximaVaga < vaga) { contas.saltadas += vaga - proximaVaga; proximaVaga = vaga; }
  }

  const cicloVideo = (async () => {
    for (;;) {
      const { value: imagem, done } = await leitorVideo.read();
      if (done || !imagem) break;
      if (!ativo || erroMotor) { imagem.close(); continue; }
      contas.recebidas++;
      recebidasNoSegundo++;
      ultimaChegada = performance.now();
      desvioRelogio = imagem.timestamp - performance.now() * 1000;
      if (t0 === null) {
        t0 = imagem.timestamp;
        if (mesa) mesa.t0 = t0; // o som começa exatamente na primeira imagem
      }

      const vaga = Math.round((imagem.timestamp - t0) / vagaUs);
      if (vaga < proximaVaga) { imagem.close(); continue; } // já há imagem para esta vaga
      try {
        repetirAte(vaga);
        if (codVideo.encodeQueueSize > FILA_MAXIMA) {
          contas.saltadas++;
        } else {
          codificarVaga(imagem, vaga);
        }
      } catch (e) {
        // Codificador fechado por um erro: a imagem não pode ficar por fechar
        erroMotor = erroMotor || e;
        imagem.close();
        continue;
      }
      proximaVaga = vaga + 1;
      if (ultima) ultima.close();
      ultima = imagem; // fica para repetir, se faltar a próxima
    }
  })();

  // Ecrã parado (o Windows só envia imagens quando algo muda): continua a preencher
  function preencherImagens() {
    if (!ativo || erroMotor || t0 === null || desvioRelogio === null) return;
    if (performance.now() - ultimaChegada < 2 * (vagaUs / 1000)) return;
    const agora = performance.now() * 1000 + desvioRelogio;
    const vaga = Math.floor((agora - t0) / vagaUs) - 1; // deixa uma vaga de folga para a imagem real
    if (vaga > proximaVaga) repetirAte(vaga);
  }

  // ---------- Som: mesa de som alinhada com a primeira imagem ----------
  // O som começa exatamente no instante da primeira imagem (t0); onde nenhuma fonte tiver
  // som, fica silêncio. Assim as duas faixas começam juntas e o MP4 só as põe a zero.
  function codificarBloco(bloco, n, ts) {
    if (!codSom || erroMotor) return;
    const ad = new AudioData({ format: 'f32', sampleRate: TAXA, numberOfChannels: 2, numberOfFrames: n, timestamp: Math.round(ts), data: bloco });
    codSom.encode(ad);
    ad.close();
  }
  function misturarAte(us) {
    if (!mesa || mesa.t0 === null) return;
    const ate = Math.floor(((us - mesa.t0) * TAXA) / 1e6);
    if (ate > mesa.saida) mesa.emitir(ate, codificarBloco);
  }

  let ciclosSom = [];
  if (codSom) {
    mesa = new Mesa();
    if (t0 !== null) mesa.t0 = t0;
    if (mistura) { mesa.ganhos = mistura.ganhos || {}; mesa.novos = mistura.novos !== false; }
    aceitarSom = true;
    ciclosSom = (fontesSom || []).map((f) => lerFonte(f.chave, f.grupo, f.leitura, agoraVideo));
    self.agoraVideo = agoraVideo;
  } else {
    for (const f of fontesSom || []) f.leitura.cancel().catch(() => {});
  }

  const relogio = setInterval(() => {
    preencherImagens();
    const agora = agoraVideo();
    if (ativo && !erroMotor && agora !== null) misturarAte(agora - LATENCIA_MISTURA_US);
  }, 50);
  const contador = setInterval(() => {
    contas.porSegundo = recebidasNoSegundo;
    recebidasNoSegundo = 0;
    enviar({ tipo: 'contas', ...contas, somTarde: mesa ? mesa.descartadas : 0,
      relogiosSom: mesa ? [...mesa.fontes].map(([k, v]) => `${k}:${v.modo}`) : [], erro: erroMotor ? String(erroMotor.message || erroMotor) : '' });
  }, 1000);

  // ---------- Parar ----------
  await new Promise((resolver) => { if (aParar) resolver(); else self.pararAgora = resolver; });
  ativo = false; // não entram mais imagens
  clearInterval(relogio);
  clearInterval(contador);
  // A janela principal já parou as faixas: os fluxos acabam sozinhos depois de entregarem o que
  // têm (cada imagem é fechada). Cancelar com imagens na fila deixava-as por fechar.
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.race([cicloVideo.catch(() => {}), esperar(2000)]);
  leitorVideo.cancel().catch(() => {});
  await cicloVideo.catch(() => {});
  // O som dos últimos instantes ainda está a chegar: espera por ele antes de fechar a mesa
  if (codSom && t0 !== null) await esperar(LATENCIA_MISTURA_US / 1000 + 100);
  aceitarSom = false;
  await Promise.race([Promise.allSettled(ciclosSom), esperar(1000)]);
  for (const l of leitoresSom) l.cancel().catch(() => {});
  await Promise.allSettled(ciclosSom);
  if (codSom && t0 !== null && !erroMotor) misturarAte(t0 + proximaVaga * vagaUs);
  if (ultima) { ultima.close(); ultima = null; }
  let motivo = '';
  try {
    if (codVideo.state === 'configured') await codVideo.flush();
    if (codSom && codSom.state === 'configured') await codSom.flush();
    muxer.finalize();
  } catch (e) {
    motivo = `A gravação não terminou bem (${e.message})`;
  }
  try { codVideo.close(); } catch { /* */ }
  try { if (codSom) codSom.close(); } catch { /* */ }
  enviar({ tipo: 'fim', motivo, ...contas });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'pcm') {
    // Som de um programa (estéreo intercalado, 48 kHz), vindo do Windows
    if (!aceitarSom || !mesa || !(m.dados instanceof Float32Array)) return;
    const n = m.dados.length / 2;
    const esq = new Float32Array(n);
    const dir = new Float32Array(n);
    for (let i = 0; i < n; i++) { esq[i] = m.dados[i * 2]; dir[i] = m.dados[i * 2 + 1]; }
    mesa.adicionar(m.chave, m.grupo, esq, dir, m.tempo, self.agoraVideo ? self.agoraVideo() : null);
  } else if (m.tipo === 'fonte') {
    // Fonte nova a meio (por exemplo o microfone, ligado depois de começar)
    if (aceitarSom && mesa && self.agoraVideo) lerFonte(m.chave, m.grupo, m.leitura, self.agoraVideo);
    else m.leitura.cancel().catch(() => {});
  } else if (m.tipo === 'mistura') {
    if (mesa) { mesa.ganhos = m.ganhos || {}; mesa.novos = m.novos !== false; }
  } else if (m.tipo === 'iniciar') {
    gravar(m).catch((err) => enviar({ tipo: 'falhou', erro: String(err && err.message || err) }));
  } else if (m.tipo === 'parar' && !aParar) {
    aParar = true;
    if (self.pararAgora) self.pararAgora();
  }
};
