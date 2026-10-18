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

async function configurarAudio(canais, taxa) {
  for (const [codec, muxer] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: taxa, numberOfChannels: canais, bitrate: 192000 };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxer };
    } catch { /* tenta a seguinte */ }
  }
  return null;
}

async function primeiraAmostra(leitor, ms) {
  const tempo = new Promise((r) => setTimeout(() => r({ value: null, done: true }), ms));
  return Promise.race([leitor.read(), tempo]);
}

async function gravar(p) {
  const { leituraVideo, leituraSom, configVideo, largura, altura, fps, somCanais, somTaxa } = p;
  const leitorVideo = leituraVideo.getReader();
  const leitorSom = leituraSom ? leituraSom.getReader() : null;
  ativo = true;

  // ---------- Som: configurar a partir da primeira amostra (ou das definições da faixa) ----------
  let primeiroSom = null;
  let audio = null;
  if (leitorSom) {
    const r = await primeiraAmostra(leitorSom, 1500);
    primeiroSom = r.value || null;
    const canais = primeiroSom ? primeiroSom.numberOfChannels : (somCanais || 2);
    const taxa = primeiroSom ? primeiroSom.sampleRate : (somTaxa || 48000);
    audio = await configurarAudio(canais, taxa);
    if (!audio) {
      if (primeiroSom) primeiroSom.close();
      primeiroSom = null;
      leitorSom.cancel().catch(() => {});
    }
  }

  // ---------- Ficheiro MP4 fragmentado, enviado à janela principal à medida que sai ----------
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.StreamTarget({
      onData: (dados, posicao) => {
        const copia = dados.slice(); // o mp4-muxer pode reutilizar o buffer
        enviar({ tipo: 'dados', dados: copia.buffer, posicao }, [copia.buffer]);
      },
    }),
    video: { codec: 'avc', width: largura, height: altura, frameRate: fps },
    audio: audio ? { codec: audio.muxer, numberOfChannels: audio.config.numberOfChannels, sampleRate: audio.config.sampleRate } : undefined,
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
  let avisarT0;
  const t0Definido = new Promise((r) => { avisarT0 = r; });
  let proximaVaga = 0;
  let ultima = null; // cópia da última imagem, para repetir
  let desvioRelogio = null; // relógio das imagens menos performance.now() deste Worker (µs)
  let ultimaChegada = 0;
  const contas = { recebidas: 0, repetidas: 0, saltadas: 0, porSegundo: 0 };
  let recebidasNoSegundo = 0;

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
      if (t0 === null) { t0 = imagem.timestamp; avisarT0(t0); }

      const vaga = Math.round((imagem.timestamp - t0) / vagaUs);
      if (vaga < proximaVaga) { imagem.close(); continue; } // já há imagem para esta vaga
      repetirAte(vaga);
      if (codVideo.encodeQueueSize > FILA_MAXIMA) {
        contas.saltadas++;
      } else {
        codificarVaga(imagem, vaga);
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

  // ---------- Som, alinhado com a primeira imagem e com silêncio onde não chegar nada ----------
  // O som começa exatamente no instante da primeira imagem (t0): o que chegou antes é
  // descartado e, se o som começar depois, preenche-se com silêncio. Assim as duas faixas
  // começam juntas e o MP4 só tem de as pôr a zero.
  const taxaSom = audio ? audio.config.sampleRate : 48000;
  const canaisSom = audio ? audio.config.numberOfChannels : 2;
  let proximoSomUs = null; // onde acaba o último som codificado (relógio das imagens)

  function silencioAte(fimUs) {
    while (fimUs - proximoSomUs > 1000) {
      const frames = Math.max(1, Math.min(Math.round(taxaSom / 10), Math.round(((fimUs - proximoSomUs) / 1e6) * taxaSom)));
      const silencio = new AudioData({
        format: 'f32-planar', sampleRate: taxaSom, numberOfChannels: canaisSom, numberOfFrames: frames,
        timestamp: Math.round(proximoSomUs), data: new Float32Array(frames * canaisSom),
      });
      codSom.encode(silencio);
      silencio.close();
      proximoSomUs += (frames / taxaSom) * 1e6;
    }
  }

  function codificarSom(amostra) {
    const inicio = amostra.timestamp;
    const fim = inicio + (amostra.numberOfFrames / amostra.sampleRate) * 1e6;
    if (inicio < proximoSomUs - 20000) return; // antes da primeira imagem, ou já coberto por silêncio
    if (inicio > proximoSomUs + 20000) silencioAte(inicio); // falha: silêncio até este som
    codSom.encode(amostra);
    proximoSomUs = fim;
  }

  // Se não chegar som (nada a tocar), continua com silêncio
  function preencherSilencio() {
    if (!ativo || !codSom || erroMotor || desvioRelogio === null || proximoSomUs === null) return;
    const agora = performance.now() * 1000 + desvioRelogio;
    if (agora - proximoSomUs > 300000) silencioAte(agora - 100000);
  }

  const cicloSom = codSom ? (async () => {
    const inicio = await t0Definido;
    if (inicio === null) { if (primeiroSom) primeiroSom.close(); return; }
    proximoSomUs = inicio;
    if (primeiroSom) { if (ativo) codificarSom(primeiroSom); primeiroSom.close(); }
    for (;;) {
      const { value: amostra, done } = await leitorSom.read();
      if (done || !amostra) break;
      if (ativo && !erroMotor) codificarSom(amostra);
      amostra.close();
    }
  })() : Promise.resolve();

  const relogio = setInterval(() => {
    preencherImagens();
    preencherSilencio();
  }, 100);
  const contador = setInterval(() => {
    contas.porSegundo = recebidasNoSegundo;
    recebidasNoSegundo = 0;
    enviar({ tipo: 'contas', ...contas, erro: erroMotor ? String(erroMotor.message || erroMotor) : '' });
  }, 1000);

  // ---------- Parar ----------
  await new Promise((resolver) => { if (aParar) resolver(); else self.pararAgora = resolver; });
  ativo = false;
  avisarT0(null); // se nunca chegou nenhuma imagem, o som também acaba
  clearInterval(relogio);
  clearInterval(contador);
  leitorVideo.cancel().catch(() => {});
  if (leitorSom) leitorSom.cancel().catch(() => {});
  await Promise.allSettled([cicloVideo, cicloSom]);
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
  if (m.tipo === 'iniciar') {
    gravar(m).catch((err) => enviar({ tipo: 'falhou', erro: String(err && err.message || err) }));
  } else if (m.tipo === 'parar' && !aParar) {
    aParar = true;
    if (self.pararAgora) self.pararAgora();
  }
};
