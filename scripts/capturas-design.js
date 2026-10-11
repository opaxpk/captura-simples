// Tira capturas de todos os estados da app (para rever o design).
// Uso (Linux sem ecrã): PASTA=capturas xvfb-run -a ./node_modules/.bin/electron --no-sandbox scripts/capturas-design.js
const { app } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-gpu');
if (process.env.CAPTURA_ESCALA) app.commandLine.appendSwitch('force-device-scale-factor', process.env.CAPTURA_ESCALA);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'captura-crit-')));
const pasta = path.resolve(process.env.PASTA || 'capturas');
fs.mkdirSync(pasta, { recursive: true });
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (c) => win.webContents.executeJavaScript(c);
    const foto = async (n) => { await esperar(450); fs.writeFileSync(path.join(pasta, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
    win.setContentSize(1280, 760);
    await esperar(3500);
    // Imagem de jogo simulada: barras de cor como na captura do Hugo
    await js(`(() => { const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d');
      const cores = ['#fff','#ff0','#0ff','#0f0','#f0f','#f00','#00f'];
      setInterval(() => { cores.forEach((k,i) => { g.fillStyle = k; g.fillRect(i*1920/7, 0, 1920/7+1, 1080); }); }, 33);
      el.video.srcObject = c.captureStream(30);
      el.selVideo.options[0].text = 'USB3 Video (345f:2131)'; el.selAudio.options[1].text = 'Entrada Digital (USB3 Digital Audio)'; ajustarBarra(); })()`);
    await foto('1-janela');
    await js(`el.selAudio.previousElementSibling.click()`); await foto('1b-lista-aberta');
    await js('fecharListas()');
    await js('el.btnDefinicoes.click()'); await foto('2-definicoes');
    await js('fecharPainel()');
    await js(`mostrarPainelAtualizacao('disponivel','Versão 1.5.0 disponível','Atualização pequena: instala-se em segundos, sem fechar a app.',{notas:'- Novidade um\\n- Novidade dois',acao:'Atualizar agora',aoClicar:()=>{}})`); await foto('3-atualizacao');
    await js('fecharPainel()');
    await js(`abrirPainel(el.ajuda)`); await foto('4-atalhos');
    await js('fecharPainel()');
    await js(`mostrarAviso({name:'NotFoundError'})`); await foto('5-erro');
    await js(`esconderEstado(); mostrarEstado('a-ligar','A ligar à placa…','')`); await foto('6-a-ligar');
    await js(`esconderEstado(); definirSemImagem(true)`); await foto('7-sem-imagem');
    await js(`definirSemImagem(false); def.barraEscondida = true; aplicarModoBarra(); mostrarControlos();`); await foto('8-flutuante');
    await js(`mostrarOsd('Volume 105%', 5000)`); await foto('9-osd');
    await js(`def.barraEscondida = false; aplicarModoBarra();`);
    win.setContentSize(760, 560); await foto('10-estreita');
    app.exit(0);
  });
});
setTimeout(() => app.exit(2), 60000);
require('../main.js');
