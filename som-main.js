// Som por programa (processo principal).
// - lista os programas que têm som no Windows e o nível de cada um (para a mesa de som);
// - durante a gravação, capta o som de cada programa à parte e entrega-o à janela principal,
//   que o mistura no ficheiro com o volume e o silenciar escolhidos na janela Gravar.
// O trabalho com o Windows é feito pelo módulo nativo native/som_programas.node
// (código em native/som-programas). Sem ele (Windows antigo, outros sistemas), a mesa
// mostra só a placa e o microfone.
const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

function carregarNativo() {
  if (process.env.CAPTURA_SOM_FALSO) {
    return { modulo: require('./scripts/som-falso.js'), motivo: '' };
  }
  if (process.platform !== 'win32') {
    return { modulo: null, motivo: 'O som de cada programa só pode ser separado no Windows.' };
  }
  const caminhos = [
    path.join(__dirname, 'native', 'som_programas.node'),
    path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'native', 'som_programas.node'),
  ];
  for (const c of caminhos) {
    try {
      if (!fs.existsSync(c)) continue;
      return { modulo: require(c), motivo: '' };
    } catch (e) {
      console.error('Som por programa indisponível:', e);
      return { modulo: null, motivo: 'Não foi possível carregar o som por programa neste PC.' };
    }
  }
  return { modulo: null, motivo: 'Esta versão não traz o som por programa.' };
}

function ligarSom({ obterJanelaPrincipal, obterJanelaGravar }) {
  const { modulo: nativo, motivo } = carregarNativo();
  let niveisJanela = { placa: 0, micro: 0, sistema: 0 };
  let aGravar = false;
  const capturas = new Map(); // pid -> { id, programa }
  const icones = new Map(); // caminho -> dataURL ('' enquanto carrega)
  let iconesEnviados = new Set();
  let ultimaLista = [];
  let erroLista = '';

  const viva = (w) => (w && !w.isDestroyed() ? w : null);
  const principal = () => viva(obterJanelaPrincipal());
  const gravar = () => viva(obterJanelaGravar());

  // Os processos desta app ficam de fora (o som da placa que ela toca entra pela "Placa de captura")
  const nossosPids = () => app.getAppMetrics().map((m) => m.pid);

  function listar() {
    if (!nativo) return [];
    try {
      ultimaLista = nativo.listar(nossosPids());
      erroLista = '';
    } catch (e) {
      erroLista = e.message || String(e);
      ultimaLista = [];
    }
    return ultimaLista;
  }

  function pedirIcone(caminho) {
    if (icones.has(caminho) || nativo?.falso) return;
    icones.set(caminho, '');
    app.getFileIcon(caminho, { size: 'normal' })
      .then((img) => icones.set(caminho, img.isEmpty() ? '' : img.toDataURL()))
      .catch(() => {});
  }

  // ---------- Captação durante a gravação ----------
  function captarNovos(lista) {
    if (!aGravar || !nativo) return;
    for (const p of lista) {
      for (const pid of p.pids) {
        if (capturas.has(pid)) continue;
        const programa = p.id;
        let id;
        try {
          id = nativo.capturar(pid, (dados, tempo, erro) => {
            const w = principal();
            if (!w || !aGravar) return;
            if (erro) { w.webContents.send('som:erro', programa, p.nome, erro); return; }
            w.webContents.send('som:dados', programa, pid, dados, tempo);
          });
        } catch (e) {
          const w = principal();
          if (w) w.webContents.send('som:erro', programa, p.nome, e.message || String(e));
          continue;
        }
        capturas.set(pid, { id, programa });
      }
    }
  }

  function pararCapturas() {
    for (const c of capturas.values()) {
      try { nativo.parar(c.id); } catch { /* */ }
    }
    capturas.clear();
  }

  // ---------- Ciclo: 10 vezes por segundo, com a janela Gravar aberta ou a gravar ----------
  let ciclo = null;
  function tique() {
    const jg = gravar();
    if (!jg && !aGravar) return;
    const lista = listar();
    captarNovos(lista);
    if (!jg) return;
    const programas = lista.map((p) => {
      pedirIcone(p.caminho);
      const icone = icones.get(p.caminho);
      const enviar = icone && !iconesEnviados.has(p.id);
      if (enviar) iconesEnviados.add(p.id);
      return { id: p.id, nome: p.nome, nivel: p.nivel, ativo: p.ativo, icone: enviar ? icone : undefined };
    });
    jg.webContents.send('som:niveis', {
      disponivel: !!nativo,
      motivo: nativo ? erroLista : motivo,
      programas,
      ...niveisJanela,
    });
  }

  function vigiar() {
    const precisa = !!gravar() || aGravar;
    const w = principal();
    if (w) w.webContents.send('som:vigiar', !!gravar());
    if (precisa && !ciclo) ciclo = setInterval(tique, 100);
    if (!precisa && ciclo) { clearInterval(ciclo); ciclo = null; }
  }

  // ---------- Mensagens ----------
  ipcMain.on('som:niveisJanela', (_e, n) => {
    if (n && typeof n === 'object') niveisJanela = { placa: +n.placa || 0, micro: +n.micro || 0, sistema: +n.sistema || 0 };
  });
  ipcMain.handle('som:info', () => ({ disponivel: !!nativo, motivo: nativo ? '' : motivo }));
  ipcMain.handle('som:gravar', (_e, ativo) => {
    aGravar = !!ativo;
    if (aGravar) captarNovos(listar());
    else pararCapturas();
    vigiar();
    return { disponivel: !!nativo };
  });
  // Quando a janela Gravar é aberta de novo, os ícones voltam a ser enviados
  ipcMain.on('som:janelaPronta', () => { iconesEnviados = new Set(); vigiar(); });

  return {
    aoAbrirGravar: vigiar,
    aoFecharGravar: () => { iconesEnviados = new Set(); vigiar(); },
    parar: () => { aGravar = false; pararCapturas(); vigiar(); },
  };
}

module.exports = { ligarSom };
