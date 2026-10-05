// Teste automático: abre a app com uma câmara e um microfone falsos do Chromium
// e confirma que a imagem, o som e os controlos funcionam.
// Uso: npm test   (no Linux sem ecrã: xvfb-run -a npm test)
// Com CAPTURA_CAPTURAS=pasta, guarda capturas de ecrã nessa pasta.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'captura-teste-')));

const inicio = Date.now();
let paginaPronta = 0;
const falhas = [];
const errosConsola = [];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const pastaCapturas = process.env.CAPTURA_CAPTURAS;

function verificar(nome, ok, detalhe) {
  console.log(`${ok ? 'OK     ' : 'FALHOU '} ${nome}${detalhe !== undefined ? `  (${detalhe})` : ''}`);
  if (!ok) falhas.push(nome);
}

async function capturar(win, nome) {
  if (!pastaCapturas) return;
  fs.mkdirSync(pastaCapturas, { recursive: true });
  await esperar(500); // deixar a página desenhar
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(pastaCapturas, `${nome}.png`), img.toPNG());
}

async function testar(win) {
  const js = (codigo) => win.webContents.executeJavaScript(codigo);
  const tecla = (key) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)} }))`);

  // Tempo até a imagem aparecer
  let imagem = 0;
  for (let i = 0; i < 200 && !imagem; i++) {
    if (await js(`!!streamVideo && el.video.videoWidth > 0`)) imagem = Date.now() - inicio;
    else await esperar(25);
  }
  console.log(`Arranque: página pronta em ${paginaPronta} ms, imagem em ${imagem} ms`);
  verificar('A imagem aparece em menos de 5 s', imagem > 0 && imagem < 5000, `${imagem} ms`);
  await esperar(4000);

  const v = await js(`({
    vivo: !!streamVideo && streamVideo.getVideoTracks()[0].readyState === 'live',
    largura: el.video.videoWidth,
    sinal: el.sinalTexto.textContent,
    estado: el.estado.dataset.modo,
  })`);
  verificar('A imagem aparece', v.vivo && v.largura > 0, `${v.largura}px`);
  verificar('Luz de sinal mostra o formato', /^\d+p\d+$/.test(v.sinal), v.sinal);
  verificar('Sem mensagem de erro', v.estado === 'oculto', v.estado);

  const a = await js(`({
    vivo: !!streamAudio && streamAudio.getAudioTracks()[0].readyState === 'live',
    escolhido: el.selAudio.value !== 'none',
    contexto: ctx && ctx.state,
    nivel: nivelSuave,
  })`);
  verificar('O som está ligado', a.vivo && a.escolhido, a.contexto);
  verificar('O som toca pelo Web Audio', a.contexto === 'running');
  await capturar(win, '1-janela');

  // Resolução
  await js(`el.segRes.querySelector('[data-valor="1280x720"]').click()`);
  await esperar(2500);
  const r = await js(`streamVideo && streamVideo.getVideoTracks()[0].getSettings().height`);
  verificar('Mudar para 720p', r === 720, r);
  await js(`el.segRes.querySelector('[data-valor="1920x1080"]').click()`);
  await esperar(2000);

  // Volume e silenciar
  await tecla('ArrowDown');
  const vol = await js('def.volume');
  verificar('Seta para baixo baixa o volume', vol === 95, vol);
  await tecla('m');
  verificar('M silencia', await js('def.mute') === true);
  await tecla('m');

  // Atraso do som
  await tecla(']');
  await tecla(']');
  await esperar(300);
  const at = await js(`({ def: def.atrasoSom, no: Math.round(atraso.delayTime.value * 1000) })`);
  verificar('Teclas [ ] mudam o atraso do som', at.def === 20 && Math.abs(at.no - 20) <= 2, `${at.def} ms, nó ${at.no} ms`);
  await tecla('[');
  await tecla('[');

  // Cores
  await tecla('c');
  const filtro = await js('el.video.style.filter');
  verificar('C liga a correção de cores', /contrast\(1\.16/.test(filtro), filtro);
  await tecla('c');
  verificar('C desliga a correção de cores', await js('el.video.style.filter') === 'none');

  // Painel de definições
  await js('el.btnDefinicoes.click()');
  await esperar(300);
  verificar('Abre as definições', await js('!el.painelDefinicoes.hidden'));
  await js(`el.segEscala.querySelector('[data-valor="esticar"]').click()`);
  verificar('Modo esticar', await js('el.video.style.objectFit') === 'fill');
  await capturar(win, '2-definicoes');
  await js(`el.segEscala.querySelector('[data-valor="ajustar"]').click()`);
  await tecla('Escape');
  verificar('Esc fecha as definições', await js('el.painelDefinicoes.hidden'));

  // Barra escondida
  await tecla('h');
  verificar('H esconde a barra', await js(`document.body.classList.contains('flutuante')`));
  await tecla('h');
  verificar('H volta a mostrar a barra', await js(`!document.body.classList.contains('flutuante')`));

  // Ajuda
  await tecla('?');
  verificar('? abre a ajuda', await js('!el.ajuda.hidden'));
  await capturar(win, '3-ajuda');
  await tecla('Escape');

  // Imagem do teste não é preta: não deve avisar falta de HDMI
  verificar('Não avisa falta de imagem', await js('!semImagem'));

  // Placa sem HDMI: imagem toda preta (com o preto a 16, como em "gama limitada")
  await js(`(() => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d');
    setInterval(() => { g.fillStyle = 'rgb(16,16,16)'; g.fillRect(0, 0, 320, 180); }, 100);
    el.video.srcObject = c.captureStream(10);
  })()`);
  await esperar(7000);
  verificar('Avisa quando a imagem fica toda preta', await js('semImagem && !el.semImagem.hidden'));
  verificar('Luz de sinal diz "Sem imagem"', await js('el.sinalTexto.textContent') === 'Sem imagem');
  await capturar(win, '4-sem-imagem');

  verificar('Imagem estável ligada por defeito', app.commandLine.hasSwitch('disable-direct-composition-video-overlays'));
  const barra = await js(`(() => { document.body.classList.add('flutuante','inativo');
    const c = getComputedStyle(el.barra); const r = { filtro: c.backdropFilter, vis: c.visibility };
    document.body.classList.remove('flutuante','inativo'); return r; })()`);
  verificar('Barra sem desfoque por cima do vídeo', barra.filtro === 'none', barra.filtro);
  await js(`el.btnDefinicoes.click()`);
  await esperar(300);
  verificar('Interruptor "Imagem estável" nas definições', await js('!el.linhaEstavel.hidden && el.optEstavel.checked'));
  await tecla('Escape');

  verificar('Sem erros na consola', errosConsola.length === 0, errosConsola.join(' | '));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errosConsola.push(e.message);
  });
  win.webContents.once('did-finish-load', async () => {
    paginaPronta = Date.now() - inicio;
    try {
      await testar(win);
    } catch (e) {
      verificar('O teste correu até ao fim', false, e.message);
    }
    console.log(falhas.length ? `\n${falhas.length} verificação(ões) falharam.` : '\nTudo certo.');
    app.exit(falhas.length ? 1 : 0);
  });
});

setTimeout(() => {
  console.error('O teste demorou demasiado.');
  app.exit(2);
}, 90000);

require('../main.js');
