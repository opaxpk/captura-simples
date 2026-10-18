// Teste automático: abre a app com uma câmara e um microfone falsos do Chromium
// e confirma que a imagem, o som e os controlos funcionam.
// Uso: npm test   (no Linux sem ecrã: xvfb-run -a npm test)
// Com CAPTURA_CAPTURAS=pasta, guarda capturas de ecrã nessa pasta.
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-gpu');
// CAPTURA_ESCALA=1.5 simula o Windows com dimensionamento a 150%
if (process.env.CAPTURA_ESCALA) app.commandLine.appendSwitch('force-device-scale-factor', process.env.CAPTURA_ESCALA);
// Programas falsos com som (scripts/som-falso.js), para testar a mesa de som
process.env.CAPTURA_SOM_FALSO = process.env.CAPTURA_SOM_FALSO || '1';
const pastaDados = fs.mkdtempSync(path.join(os.tmpdir(), 'captura-teste-'));
app.setPath('userData', pastaDados);
const pastaGravacoes = path.join(pastaDados, 'gravacoes');
fs.mkdirSync(pastaGravacoes);
fs.writeFileSync(path.join(pastaDados, 'opcoes.json'), JSON.stringify({ pastaGravacoes }));

const inicio = Date.now();
let paginaPronta = 0;
const falhas = [];
const errosConsola = [];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const pastaCapturas = process.env.CAPTURA_CAPTURAS;

function verificar(nome, ok, detalhe) {
  console.log(`${ok ? 'OK     ' : 'FALHOU '} ${nome}${detalhe !== undefined ? `  (${detalhe})` : ''}`);
  if (!ok) falhas.push(nome);
  // No GitHub, cada falha aparece como anotação (o registo completo nem sempre se consegue ler)
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error::${nome}${detalhe !== undefined ? ` (${String(detalhe).slice(0, 300)})` : ''}`);
}

async function capturar(win, nome) {
  if (!pastaCapturas) return;
  fs.mkdirSync(pastaCapturas, { recursive: true });
  await esperar(500); // deixar a página desenhar
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(pastaCapturas, `${nome}.png`), img.toPNG());
}

// Volume médio (dB) à volta de 3 kHz (o tom do programa falso), num pedaço do ficheiro gravado.
// Sem o tom fica perto de -40 dB (os bipes do microfone falso do Chromium); com ele, ~-15 dB.
function volumeDoPrograma(caminho, inicio = 0, duracao = 0) {
  const corte = duracao ? `atrim=start=${inicio}:duration=${duracao},` : '';
  const r = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', caminho, '-vn',
    '-af', `${corte}bandpass=f=3000:width_type=q:w=8,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || '');
  return m ? (m[1] === '-inf' ? -200 : parseFloat(m[1])) : NaN;
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
    window._streamOriginal = streamVideo;
    streamVideo = c.captureStream(10);
    el.video.srcObject = streamVideo;
  })()`);
  await esperar(7000);
  verificar('Avisa quando a imagem fica toda preta', await js('semImagem && !el.semImagem.hidden'));
  verificar('Luz de sinal diz "Sem imagem"', await js('el.sinalTexto.textContent') === 'Sem imagem');
  await capturar(win, '4-sem-imagem');
  // Repor a imagem da câmara falsa para os testes seguintes
  await js(`(() => { streamVideo.getTracks().forEach((t) => t.stop()); streamVideo = window._streamOriginal; el.video.srcObject = streamVideo; segundosPretos = 0; definirSemImagem(false); })()`);
  await esperar(500);

  // Listas com o tema da app (o menu nativo do Windows não segue o tema)
  const lista = await js(`(() => {
    const b = el.selAudio.previousElementSibling;
    const nativoEscondido = getComputedStyle(el.selAudio).opacity === '0' && el.selAudio.tabIndex === -1;
    b.click();
    const m = document.querySelector('.lista-menu[aria-label="Entrada de áudio"]');
    return { botao: b.classList.contains('lista-botao'), nativoEscondido, aberto: !m.hidden,
      expandido: b.getAttribute('aria-expanded'), opcoes: m.querySelectorAll('[role=option]').length,
      nativas: el.selAudio.options.length, focoNoMenu: document.activeElement === m };
  })()`);
  verificar('Lista de áudio abre um menu com o tema da app', lista.botao && lista.nativoEscondido && lista.aberto && lista.expandido === 'true' && lista.focoNoMenu);
  verificar('O menu mostra todas as opções', lista.opcoes === lista.nativas, `${lista.opcoes} de ${lista.nativas}`);
  // Escolher com o teclado: seta para cima até "Sem áudio" e Enter
  const antes = await js('el.selAudio.value');
  await js(`(() => { const m = document.querySelector('.lista-menu[aria-label="Entrada de áudio"]');
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await esperar(800);
  const depois = await js(`({ valor: el.selAudio.value, def: def.audioId, som: !!streamAudio,
    texto: el.selAudio.previousElementSibling.textContent.trim(), fechado: document.querySelector('.lista-menu[aria-label="Entrada de áudio"]').hidden })`);
  verificar('Escolher no menu muda o áudio a sério', antes !== 'none' && depois.valor === 'none' && depois.def === 'none' && !depois.som && depois.texto === 'Sem áudio' && depois.fechado, JSON.stringify(depois));
  // Voltar a pôr o áudio, também pelo menu (com o rato)
  await js(`el.selAudio.previousElementSibling.click()`);
  await js(`document.querySelector('.lista-menu[aria-label="Entrada de áudio"] [role=option]:nth-child(2)').click()`);
  await esperar(1200);
  verificar('Escolher com o rato volta a ligar o som', await js('!!streamAudio && el.selAudio.value !== "none"'));
  // Esc fecha sem mudar nada, e as teclas não disparam atalhos da app
  await js(`el.selVideo.previousElementSibling.click()`);
  const volAntes = await js('def.volume');
  await js(`(() => { const m = document.querySelector('.lista-menu[aria-label="Fonte de vídeo"]');
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  verificar('Teclas no menu não mexem no volume nem silenciam', await js('def.volume') === volAntes && await js('def.mute') === false);
  verificar('Esc fecha o menu e devolve o foco ao botão', await js(`document.querySelector('.lista-menu[aria-label="Fonte de vídeo"]').hidden && document.activeElement === el.selVideo.previousElementSibling`));

  // Janela estreita: a barra encolhe e os botões da direita continuam visíveis
  await js(`el.selVideo.options[0].text = 'USB3 Video (345f:2131)'; ajustarBarra();`);
  for (const largura of [1137, 800, 640]) {
    win.setContentSize(largura, 600);
    await esperar(400);
    const r = await js(`({ cabe: el.barra.scrollWidth <= el.barra.clientWidth + 1,
      fim: el.btnEcra.getBoundingClientRect().right, largura: innerWidth, nivel: nivelCompacto })`);
    verificar(`Barra cabe numa janela de ${largura}px`, r.cabe && r.fim <= r.largura, `nível ${r.nivel}`);
  }
  win.setContentSize(1400, 760);
  await esperar(400);
  const volta = await js(`({ nivel: nivelCompacto, formato: el.segRes.parentElement === el.grupoFormato, volume: el.caixaVolume.parentElement === el.grupoSom })`);
  verificar('Ao alargar, tudo volta para a barra', volta.formato && volta.volume && volta.nivel <= 1, `nível ${volta.nivel}`);
  win.setContentSize(1280, 760);

  // Luz de sinal: o aviso distingue-se pela forma e pelo texto, não só pela cor
  const luz = await js(`(() => { const ant = el.sinal.dataset.estado; el.sinal.dataset.estado = 'aviso';
    const fundo = getComputedStyle(el.sinal.querySelector('.luz')).backgroundColor; el.sinal.dataset.estado = ant; return fundo; })()`);
  verificar('Aviso da luz de sinal é um anel (não só cor)', luz === 'rgba(0, 0, 0, 0)', luz);

  verificar('Imagem estável ligada por defeito', app.commandLine.hasSwitch('disable-direct-composition-video-overlays'));
  const barra = await js(`(() => { document.body.classList.add('flutuante','inativo');
    const c = getComputedStyle(el.barra); const r = { filtro: c.backdropFilter, vis: c.visibility };
    document.body.classList.remove('flutuante','inativo'); return r; })()`);
  verificar('Barra sem desfoque por cima do vídeo', barra.filtro === 'none', barra.filtro);
  await js(`el.btnDefinicoes.click()`);
  await esperar(300);
  verificar('Interruptor "Imagem estável" nas definições', await js('!el.linhaEstavel.hidden && el.optEstavel.checked'));
  await tecla('Escape');

  // ---------- Gravação ----------
  await js('el.btnGravar.click()');
  let jg = null;
  for (let i = 0; i < 40 && !jg; i++) {
    jg = BrowserWindow.getAllWindows().find((w) => w !== win && w.getTitle() === 'Gravar');
    if (!jg) await esperar(150);
  }
  verificar('O botão Gravar abre a janela "Gravar"', !!jg);
  if (jg) {
    const jjs = async (c) => {
      const r = await jg.webContents.executeJavaScript(`(async () => { try { return { ok: await (${c}) }; } catch (e) { return { erro: String(e && e.stack || e) }; } })()`);
      if (r.erro) throw new Error(`Janela Gravar: ${r.erro}`);
      return r.ok;
    };
    jg.webContents.on('console-message', (e) => { if (e.level === 'error') errosConsola.push(`Gravar: ${e.message}`); });
    if (jg.webContents.isLoading()) await new Promise((r) => jg.webContents.once('did-finish-load', r));
    await esperar(800);
    const pronto = await jjs(`({ botao: document.getElementById('btnPrincipal').textContent, ativo: !document.getElementById('btnPrincipal').disabled,
      pasta: document.getElementById('dPasta').textContent, estado: document.getElementById('relogio').dataset.estado })`);
    verificar('Janela "Gravar" pronta, com a pasta das gravações', pronto.ativo && pronto.botao === 'Começar a gravar' && pronto.pasta === pastaGravacoes && pronto.estado === 'pronto', JSON.stringify(pronto));
    await capturar(jg, '5-gravar-pronto');

    // ---------- Mesa de som ----------
    let mesa = null;
    for (let i = 0; i < 30; i++) {
      mesa = await jjs(`({ linhas: [...document.querySelectorAll('#canaisProgramas .canal-nome')].map((x) => x.textContent),
        placa: !document.querySelector('.canal[data-chave="placa"]').classList.contains('desligada'),
        outroLigado: !document.querySelector('.canal[data-chave="p:teste-outro"]')?.classList.contains('mudo'),
        nivel: (mesaUi.linhas.get('p:teste-programa') || {}).mostrado || 0,
        estado: (document.querySelector('.canal[data-chave="p:teste-programa"] .canal-estado') || {}).textContent })`);
      if (mesa.linhas.length === 2 && mesa.nivel > 0) break;
      await esperar(150);
    }
    verificar('A mesa de som mostra a placa e cada programa com som', mesa.placa && mesa.outroLigado && mesa.linhas.join(',') === 'Outro programa,Programa de teste', JSON.stringify(mesa));
    verificar('O medidor de cada programa mexe', mesa.nivel > 0.3 && mesa.estado === 'A tocar', `${mesa.nivel.toFixed(2)}, ${mesa.estado}`);

    // Microfone: desligado por defeito; ligar abre-o (e o medidor mexe), desligar fecha-o
    const btnMic = `document.querySelector('.canal[data-chave="micro"] .canal-mudo')`;
    const micAntes = await js('!!mesaSom.micStream');
    await jjs(`${btnMic}.click()`);
    let micAberto = false;
    for (let i = 0; i < 30 && !micAberto; i++) { micAberto = await js('!!mesaSom.micStream'); if (!micAberto) await esperar(100); }
    let micNivel = 0;
    // O microfone falso do Chromium só dá bipes de vez em quando: espera por um
    for (let i = 0; i < 80 && !(micNivel > 0); i++) { await esperar(100); micNivel = await jjs(`Math.max(mesaUi.linhas.get('micro').mostrado, mesaUi.linhas.get('micro').alvo)`); }
    await jg.webContents.executeJavaScript(`document.getElementById('mesa').scrollIntoView()`);
    await capturar(jg, '5b-gravar-mesa');
    await jg.webContents.executeJavaScript(`window.scrollTo(0, 0)`);
    await jjs(`${btnMic}.click()`);
    await esperar(500);
    const micDepois = await js('!!mesaSom.micStream');
    // O nível depende de o microfone falso dar um bipe (o Chromium reparte-os entre a placa e o
    // microfone): mostra-se, mas não conta para o resultado
    verificar('Ligar e desligar o microfone na mesa', !micAntes && micAberto && !micDepois, `nível ${micNivel.toFixed(2)}`);

    // Começar pela janela "Gravar"
    await jjs(`document.getElementById('btnPrincipal').click()`);
    await esperar(4500);
    const aGravar = await js(`({ a: grav.aGravar, rec: !el.rec.hidden, bytes: grav.bytes, formato: grav.formato, som: grav.comSom, relogios: grav.relogiosSom })`);
    verificar('Cada fonte de som usa o relógio das imagens', (aGravar.relogios || []).length >= 2 && aGravar.relogios.every((r) => r.endsWith(':direto')), (aGravar.relogios || []).join(', '));
    const naJanela = await jjs(`({ tempo: document.getElementById('tempo').textContent, botao: document.getElementById('btnPrincipal').textContent,
      bloqueado: document.querySelector('#segQualidade button').disabled })`);
    verificar('Grava e escreve no disco enquanto grava', aGravar.a && aGravar.rec && aGravar.bytes > 0, `${aGravar.bytes} bytes, ${aGravar.formato}`);
    verificar('Janela "Gravar" mostra o tempo e o botão de parar', /^00:0[2-6]$/.test(naJanela.tempo) && naJanela.botao === 'Parar e guardar' && naJanela.bloqueado, JSON.stringify(naJanela));
    await capturar(jg, '6-gravar-a-gravar');
    await capturar(win, '7-janela-a-gravar');

    // Mudar o formato a meio é bloqueado
    const resAntes = await js('def.res');
    await js(`el.segRes.querySelector('[data-valor="854x480"]').click()`);
    verificar('Não deixa mudar o formato a meio da gravação', await js('def.res') === resAntes);

    // Parar com a tecla R na janela principal
    await tecla('r');
    for (let i = 0; i < 40 && await js('grav.aGravar || grav.aGuardar'); i++) await esperar(150);
    const ultima = await js('grav.ultima');
    verificar('R para e guarda a gravação', !!ultima && fs.existsSync(ultima.caminho) && ultima.bytes > 10000, ultima && ultima.nome);
    if (ultima && fs.existsSync(ultima.caminho)) {
      try {
        const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', ultima.caminho]).toString());
        const tipos = info.streams.map((x) => x.codec_type).sort().join('+');
        const dur = parseFloat(info.format.duration || '0');
        verificar('O ficheiro tem imagem e som e abre noutro programa', tipos === 'audio+video', `${info.streams.map((x) => x.codec_name).join(', ')}`);
        verificar('A duração bate certo com o tempo gravado', dur >= 3 && dur <= 8, `${dur.toFixed(1)} s`);
        const tom = volumeDoPrograma(ultima.caminho);
        verificar('O som de um programa entra na gravação', tom > -25, `${tom} dB a 3 kHz`);
      } catch (e) {
        console.log('       (ffprobe não está disponível: não verifiquei o conteúdo do ficheiro)');
      }
    }
    await esperar(600);
    const depois = await jjs(`({ ultima: !document.getElementById('ultima').hidden, nome: document.getElementById('uNome').textContent })`);
    verificar('Janela "Gravar" mostra a última gravação', depois.ultima && depois.nome === (ultima && ultima.nome));
    await capturar(jg, '8-gravar-guardada');

    // Silenciar um programa na janela Gravar
    await jjs(`document.querySelector('.canal[data-chave="p:teste-programa"] .canal-mudo').click()`);
    await esperar(400);
    const silenciado = await js(`!!(def.mistura.programas['teste-programa'] || {}).mudo`);
    const linhaMuda = await jjs(`document.querySelector('.canal[data-chave="p:teste-programa"]').classList.contains('mudo')`);
    verificar('Silenciar um programa na mesa', silenciado && linhaMuda);

    // ---------- Ritmo constante com a janela principal ocupada ----------
    await js(`(() => { window._ocupar = setInterval(() => { const f = performance.now() + 250; while (performance.now() < f); }, 400); })()`);
    await js('iniciarGravacao()');
    for (let i = 0; i < 40 && !(await js('grav.aGravar')); i++) await esperar(150);
    await esperar(6000);
    const ritmo = await js('({ fps: grav.fps, chegada: grav.fpsChegada, saltadas: grav.perdidas })');
    await js('clearInterval(window._ocupar); pararGravacao()');
    for (let i = 0; i < 60 && await js('grav.aGravar || grav.aGuardar'); i++) await esperar(150);
    const ultRitmo = await js('grav.ultima');
    try {
      // Pacotes (o que está no ficheiro), não imagens descodificadas: o descodificador do ffprobe
      // às vezes falha uma imagem do codificador de software usado neste teste
      const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', ultRitmo.caminho])
        .toString().trim().split('\n').map(Number).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
      const difs = pts.slice(1).map((t, i) => t - pts[i]);
      const esperado = 1 / ritmo.fps;
      const irregulares = difs.filter((d) => Math.abs(d - esperado) > 0.002).length;
      const fpsFicheiro = (pts.length - 1) / (pts[pts.length - 1] - pts[0]);
      verificar('Com a janela ocupada, o ficheiro mantém o ritmo certo', Math.abs(fpsFicheiro - ritmo.fps) < 0.5, `${fpsFicheiro.toFixed(2)} fps no ficheiro, pedido ${ritmo.fps}, ${ritmo.chegada} a chegar, ${ritmo.saltadas} saltadas`);
      verificar('Intervalos entre imagens todos iguais (ritmo constante)', irregulares === 0, `${irregulares} irregulares em ${difs.length}`);
      const tomMudo = volumeDoPrograma(ultRitmo.caminho);
      verificar('Um programa silenciado não entra na gravação', tomMudo < -30, `${tomMudo} dB a 3 kHz`);
    } catch (e) {
      console.log('       (ffprobe não está disponível: não verifiquei o ritmo)', e.message);
    }

    // ---------- Gravar o ecrã do PC ----------
    await jjs(`document.querySelector('#segFonte [data-valor="ecra"]').click()`);
    await esperar(1500);
    const fonteEcra = await js('def.gravFonte');
    verificar('Escolher "Ecrã do PC" na janela Gravar', fonteEcra === 'ecra');
    await jjs(`document.getElementById('btnPrincipal').click()`);
    await esperar(2500);
    // A meio da gravação, o programa volta a entrar
    await jjs(`document.querySelector('.canal[data-chave="p:teste-programa"] .canal-mudo').click()`);
    await esperar(2500);
    const ecraGrav = await js(`({ a: grav.aGravar, fonte: grav.fonte, bytes: grav.bytes, res: grav.resolucao })`);
    verificar('Grava o ecrã do PC', ecraGrav.a && ecraGrav.fonte === 'ecra' && ecraGrav.bytes > 0, `${ecraGrav.res}, ${ecraGrav.bytes} bytes`);
    await capturar(jg, '9-gravar-ecra');
    // A gravar o ecrã, a placa pode mudar
    await js(`el.segRes.querySelector('[data-valor="1280x720"]').click()`);
    await esperar(1500);
    verificar('A gravar o ecrã, a placa pode mudar de formato', await js('def.res') === '1280x720' && await js('grav.aGravar'));
    await jjs(`document.getElementById('btnPrincipal').click()`);
    for (let i = 0; i < 40 && await js('grav.aGravar || grav.aGuardar'); i++) await esperar(150);
    const ultEcra = await js('grav.ultima');
    if (ultEcra && fs.existsSync(ultEcra.caminho)) {
      try {
        const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', ultEcra.caminho]).toString());
        const v = info.streams.find((x) => x.codec_type === 'video');
        verificar('O ficheiro do ecrã abre e tem imagem', !!v && parseFloat(info.format.duration) >= 2, `${v && v.codec_name} ${v && v.width}x${v && v.height}, ${parseFloat(info.format.duration).toFixed(1)} s`);
        const d = parseFloat(info.format.duration);
        const antes = volumeDoPrograma(ultEcra.caminho, 0.3, 1.2);
        const depois = volumeDoPrograma(ultEcra.caminho, d - 1.5, 1.2);
        verificar('Voltar a pôr um programa a meio da gravação', antes < -30 && depois > -25, `${antes} dB antes, ${depois} dB depois`);
      } catch (e) {
        console.log('       (ffprobe não está disponível: não verifiquei o ficheiro do ecrã)');
      }
    } else {
      verificar('O ficheiro do ecrã foi guardado', false);
    }
    await jjs(`document.querySelector('#segFonte [data-valor="placa"]').click()`);
    await js(`el.segRes.querySelector('[data-valor="1920x1080"]').click()`);
    await esperar(1500);
    jg.close();
  }

  // Memória estável: a app não pode ir acumulando imagens (houve uma fuga de ~8 MB/s)
  const memoria = async () => Math.round(app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((t, m) => t + m.memory.workingSetSize, 0) / 1024);
  const m0 = await memoria();
  await esperar(10000);
  const m1 = await memoria();
  verificar('Memória estável com a imagem a correr', (m1 - m0) / 10 < 2, `${m0} MB -> ${m1} MB em 10 s`);

  verificar('Sem erros na consola', errosConsola.length === 0, errosConsola.join(' | '));
}

let janelaPrincipalVista = false;
app.on('browser-window-created', (_e, win) => {
  // Só a janela principal; a janela "Gravar" é testada por dentro do teste
  if (janelaPrincipalVista) return;
  janelaPrincipalVista = true;
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
