'use strict';
// Mesa de som da janela Gravar: uma linha por fonte (placa, microfone, cada programa),
// com o nível do que vai para a gravação, o volume e o botão de silenciar.
// Os valores vivem na janela principal (def.mistura); aqui só se pede e mostra.

const somJanela = window.som || null;

const ICONES = {
  placa: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h4v2H7zM15 12h2"/></svg>',
  micro: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  sistema: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  programa: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/></svg>',
};
const SOM_LIGADO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>';
const SOM_MUDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

const mesaUi = {
  fixos: $('canaisFixos'),
  programas: $('canaisProgramas'),
  vazio: $('programasVazio'),
  conta: $('contaProgramas'),
  optNovos: $('optNovos'),
  linhas: new Map(), // chave -> { raiz, ... }
  niveis: { placa: 0, micro: 0, sistema: 0, programas: [] },
  icones: new Map(), // id do programa -> dataURL
  ultimoEstado: null,
  nativo: { disponivel: false, motivo: '' },
  listaMic: null,
};

// Nível em dB (de -60 a 0) para a largura do medidor
function fracaoNivel(pico) {
  if (!(pico > 0.001)) return 0;
  const db = 20 * Math.log10(pico);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function canalDe(chave) {
  const m = (estado && estado.mistura) || {};
  if (chave.startsWith('p:')) {
    const c = (m.programas || {})[chave.slice(2)];
    return c || { vol: 100, mudo: m.novos === false };
  }
  return m[chave] || { vol: 100, mudo: false };
}

function criarLinha(chave, nome, tipoIcone) {
  const raiz = document.createElement('div');
  raiz.className = 'canal';
  raiz.dataset.chave = chave;
  raiz.innerHTML = `
    <span class="canal-icone">${ICONES[tipoIcone]}</span>
    <div class="canal-topo">
      <span class="canal-nome"></span>
      <span class="canal-estado"></span>
    </div>
    <output class="canal-valor"></output>
    <button type="button" class="canal-mudo"></button>
    <div class="canal-faixa">
      <div class="medidor" aria-hidden="true"><span class="medidor-tapa"></span><span class="medidor-pico"></span></div>
      <input type="range" class="canal-volume" min="0" max="200" step="5">
    </div>`;
  const l = {
    raiz,
    chave,
    nome,
    icone: raiz.querySelector('.canal-icone'),
    nomeEl: raiz.querySelector('.canal-nome'),
    estadoEl: raiz.querySelector('.canal-estado'),
    valor: raiz.querySelector('.canal-valor'),
    mudo: raiz.querySelector('.canal-mudo'),
    volume: raiz.querySelector('.canal-volume'),
    tapa: raiz.querySelector('.medidor-tapa'),
    pico: raiz.querySelector('.medidor-pico'),
    mostrado: 0,
    picoMostrado: 0,
    picoQuando: 0,
    alvo: 0,
    arrastar: false,
  };
  l.nomeEl.textContent = nome;
  l.volume.setAttribute('aria-label', `Volume de ${nome} na gravação`);

  l.volume.addEventListener('pointerdown', () => { l.arrastar = true; });
  l.volume.addEventListener('pointerup', () => { l.arrastar = false; });
  l.volume.addEventListener('input', () => {
    const vol = Number(l.volume.value);
    mostrarVolume(l, vol);
    const pedido = { acao: 'mistura', chave, vol };
    // Mexer no volume de uma linha silenciada volta a pô-la na gravação
    if (canalDe(chave).mudo && vol > 0) pedido.mudo = false;
    if (chave.startsWith('p:')) pedido.nome = l.nome;
    g.comando(pedido);
  });
  l.volume.addEventListener('dblclick', () => {
    l.volume.value = '100';
    l.volume.dispatchEvent(new Event('input'));
  });
  l.mudo.addEventListener('click', () => {
    const pedido = { acao: 'mistura', chave, mudo: !canalDe(chave).mudo };
    if (chave.startsWith('p:')) pedido.nome = l.nome;
    g.comando(pedido);
  });
  mesaUi.linhas.set(chave, l);
  return l;
}

function mostrarVolume(l, vol) {
  l.valor.textContent = `${vol}%`;
  l.volume.style.setProperty('--p', `${vol / 2}%`);
}

function atualizarLinha(l, texto, classeEstado, desligada) {
  const c = canalDe(l.chave);
  const mudo = !!c.mudo || !!desligada;
  l.raiz.classList.toggle('mudo', mudo);
  l.raiz.classList.toggle('desligada', !!desligada);
  if (!l.arrastar && document.activeElement !== l.volume) l.volume.value = String(c.vol);
  mostrarVolume(l, l.arrastar || document.activeElement === l.volume ? Number(l.volume.value) : c.vol);
  l.volume.disabled = !!desligada;
  l.mudo.disabled = false;
  l.mudo.innerHTML = c.mudo ? SOM_MUDO : SOM_LIGADO;
  l.mudo.setAttribute('aria-pressed', String(!!c.mudo));
  const rotulo = c.mudo ? `Pôr ${l.nome} na gravação` : `Tirar ${l.nome} da gravação`;
  l.mudo.setAttribute('aria-label', rotulo);
  l.mudo.title = rotulo;
  l.estadoEl.textContent = c.mudo ? 'Não entra na gravação' : texto;
  l.estadoEl.className = `canal-estado${c.mudo ? '' : classeEstado ? ` ${classeEstado}` : ''}`;
}

// ---------------------------------------------------------------------
// Linhas fixas: placa, microfone, som do PC
// ---------------------------------------------------------------------
const linhaPlaca = criarLinha('placa', 'Placa de captura', 'placa');
const linhaMic = criarLinha('micro', 'Microfone', 'micro');
const linhaSistema = criarLinha('sistema', 'Som do PC', 'sistema');
mesaUi.fixos.append(linhaPlaca.raiz, linhaMic.raiz, linhaSistema.raiz);

// O microfone tem lista de dispositivos no lugar do estado
const selMic = document.createElement('select');
selMic.className = 'lista-nativa';
selMic.setAttribute('aria-label', 'Microfone a usar');
linhaMic.raiz.querySelector('.canal-topo').append(selMic);
mesaUi.listaMic = criarListaTema(selMic, 'Microfone');
mesaUi.listaMic.botao.classList.add('canal-lista');
selMic.addEventListener('change', () => g.comando({ acao: 'mistura', microId: selMic.value }));

function desenharMicrofones(e) {
  const lista = [{ id: '', nome: 'Predefinido do Windows' }, ...(e.microfones || [])];
  const atual = (e.mistura && e.mistura.micro && e.mistura.micro.id) || '';
  if (atual && !lista.some((m) => m.id === atual)) lista.push({ id: atual, nome: 'Microfone desligado' });
  const assinatura = lista.map((m) => `${m.id}|${m.nome}`).join('\n');
  if (selMic.dataset.assinatura !== assinatura) {
    selMic.dataset.assinatura = assinatura;
    selMic.replaceChildren(...lista.map((m) => new Option(m.nome, m.id)));
  }
  if (selMic.value !== atual) selMic.value = atual;
  selMic.disabled = !!(e.aGravar || e.aPreparar || e.aGuardar);
  selMic.title = selMic.disabled ? 'Para a gravação para mudar de microfone' : '';
}

// ---------------------------------------------------------------------
// Programas
// ---------------------------------------------------------------------
function desenharProgramas() {
  const progs = (mesaUi.niveis.programas || []).slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt', { sensitivity: 'base' }));
  for (const p of progs) if (p.icone) mesaUi.icones.set(p.id, p.icone);
  const vistos = new Set();
  const ordem = [];
  for (const p of progs) {
    const chave = `p:${p.id}`;
    vistos.add(chave);
    let l = mesaUi.linhas.get(chave);
    if (!l) l = criarLinha(chave, p.nome, 'programa');
    l.nivelFonte = p.nivel;
    const icone = mesaUi.icones.get(p.id);
    if (icone && !l.temIcone) {
      l.temIcone = true;
      const img = document.createElement('img');
      img.src = icone;
      img.alt = '';
      l.icone.replaceChildren(img);
    }
    atualizarLinha(l, p.nivel > 0.003 ? 'A tocar' : 'Em silêncio', p.nivel > 0.003 ? 'vivo' : '');
    ordem.push(l.raiz);
  }
  // Programas que fecharam saem da lista (exceto se estiveres a mexer neles)
  for (const [chave, l] of mesaUi.linhas) {
    if (chave.startsWith('p:') && !vistos.has(chave) && !l.arrastar) {
      l.raiz.remove();
      mesaUi.linhas.delete(chave);
    }
  }
  const atuais = [...mesaUi.programas.children];
  if (ordem.length !== atuais.length || ordem.some((r, i) => r !== atuais[i])) mesaUi.programas.replaceChildren(...ordem);

  const n = progs.length;
  mesaUi.conta.textContent = mesaUi.nativo.disponivel && n ? String(n) : '';
  mesaUi.vazio.hidden = n > 0;
  mesaUi.vazio.textContent = !mesaUi.nativo.disponivel
    ? (mesaUi.nativo.motivo || 'O som de cada programa não está disponível neste PC.')
    : 'Nenhum programa com som aberto. Quando um programa tocar, aparece aqui.';
  mesaUi.optNovos.closest('label').hidden = !mesaUi.nativo.disponivel;
}

// ---------------------------------------------------------------------
// Desenho a partir do estado da janela principal
// ---------------------------------------------------------------------
function desenharMesa(e) {
  mesaUi.ultimoEstado = e;
  if (e.somNativo) mesaUi.nativo = { ...mesaUi.nativo, ...e.somNativo };

  const semPlaca = !e.temSomPlaca;
  atualizarLinha(linhaPlaca, semPlaca ? 'Sem som da placa' : 'Som do jogo ou da consola', '', semPlaca);
  linhaPlaca.mudo.disabled = semPlaca && !canalDe('placa').mudo;

  desenharMicrofones(e);
  const mic = (e.mistura && e.mistura.micro) || { mudo: true };
  atualizarLinha(linhaMic, e.micErro || '', e.micErro ? 'atencao' : '');
  linhaMic.estadoEl.hidden = !e.micErro && !mic.mudo;
  linhaMic.raiz.classList.toggle('com-lista', true);
  if (mic.mudo) {
    linhaMic.estadoEl.textContent = 'Desligado: não entra na gravação';
    linhaMic.estadoEl.hidden = false;
  }
  const rotuloMic = mic.mudo ? 'Ligar o microfone na gravação' : 'Desligar o microfone da gravação';
  linhaMic.mudo.setAttribute('aria-label', rotuloMic);
  linhaMic.mudo.title = rotuloMic;

  linhaSistema.raiz.hidden = !e.temSistema;
  atualizarLinha(linhaSistema, 'Tudo o que se ouve no PC', '');

  mesaUi.optNovos.checked = !(e.mistura && e.mistura.novos === false);
  desenharProgramas();
}

mesaUi.optNovos.addEventListener('change', () => g.comando({ acao: 'mistura', novos: mesaUi.optNovos.checked }));

// ---------------------------------------------------------------------
// Medidores: o nível que entra na gravação (depois do volume), suave e com pico
// ---------------------------------------------------------------------
function alvoDe(l, pico) {
  const c = canalDe(l.chave);
  const ganho = c.mudo ? 1 : (c.vol / 100); // silenciada: mostra o som da fonte, a cinzento
  return fracaoNivel(pico * ganho);
}

if (somJanela) {
  somJanela.onNiveis((n) => {
    mesaUi.niveis = n || mesaUi.niveis;
    mesaUi.nativo = { disponivel: !!n.disponivel, motivo: n.motivo || '' };
    linhaPlaca.alvo = alvoDe(linhaPlaca, n.placa);
    linhaMic.alvo = (mesaUi.ultimoEstado && mesaUi.ultimoEstado.micAberto) ? alvoDe(linhaMic, n.micro) : 0;
    linhaSistema.alvo = 0;
    desenharProgramas();
    for (const p of n.programas || []) {
      const l = mesaUi.linhas.get(`p:${p.id}`);
      if (l) l.alvo = alvoDe(l, p.nivel);
    }
  });
  somJanela.janelaPronta();
}

let ultimoQuadro = performance.now();
function animarMedidores(agora) {
  requestAnimationFrame(animarMedidores);
  const dt = Math.min(0.1, (agora - ultimoQuadro) / 1000);
  ultimoQuadro = agora;
  if (document.hidden) return;
  for (const l of mesaUi.linhas.values()) {
    // Sobe logo, desce devagar (como um medidor de estúdio)
    l.mostrado = l.alvo > l.mostrado ? l.alvo : Math.max(l.alvo, l.mostrado - dt * 0.9);
    if (l.mostrado >= l.picoMostrado || agora - l.picoQuando > 1200) {
      l.picoMostrado = l.mostrado;
      l.picoQuando = agora;
    }
    l.tapa.style.transform = `scaleX(${(1 - l.mostrado).toFixed(3)})`;
    l.pico.style.left = `${(l.picoMostrado * 100).toFixed(1)}%`;
    l.pico.style.opacity = l.picoMostrado > 0.02 ? '1' : '0';
  }
}
requestAnimationFrame(animarMedidores);
