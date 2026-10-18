'use strict';
// Listas com o tema da app.
// O menu nativo do Windows ignora o tema escuro. Cada <select> continua a guardar
// as opções e o valor (o resto do código usa-o como sempre), mas fica escondido:
// o que se vê é um botão e um menu desenhados aqui, que se mantêm em sincronia com ele.

const listasTema = [];
let listaAbertaAgora = null;

function listaAberta() {
  return !!listaAbertaAgora;
}

function criarListaTema(select, rotulo) {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'lista-botao';
  botao.setAttribute('aria-haspopup', 'listbox');
  botao.setAttribute('aria-expanded', 'false');
  botao.innerHTML = '<span class="lista-texto"></span>'
    + '<svg class="lista-seta" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>';
  const texto = botao.querySelector('.lista-texto');

  const menu = document.createElement('div');
  menu.className = 'lista-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', rotulo);
  menu.tabIndex = -1;
  menu.hidden = true;
  document.body.append(menu);

  // O select fica no mesmo sítio (guarda o valor), mas invisível e fora do Tab
  select.classList.add('lista-nativa');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.before(botao); // o <label> passa a apontar para o botão

  let realce = -1;
  const lista = { select, botao, menu };

  function sincronizar() {
    const opcao = select.selectedOptions[0];
    texto.textContent = opcao ? opcao.text : '';
    botao.disabled = select.disabled;
    botao.classList.toggle('problema', select.classList.contains('problema'));
    botao.title = select.title || (opcao ? opcao.text : '');
    botao.setAttribute('aria-label', `${rotulo}: ${opcao ? opcao.text : 'nenhum'}`);
    if (!menu.hidden) desenharOpcoes();
    if (typeof ajustarBarraDepois === 'function') ajustarBarraDepois();
  }

  function desenharOpcoes() {
    menu.replaceChildren();
    [...select.options].forEach((o, i) => {
      const item = document.createElement('div');
      item.className = 'lista-opcao';
      item.id = `${select.id}-opcao-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(o.selected));
      item.dataset.indice = String(i);
      item.innerHTML = '<svg class="lista-visto" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg><span></span>';
      item.querySelector('span').textContent = o.text;
      if (i === realce) item.classList.add('realce');
      menu.append(item);
    });
    if (realce >= 0) menu.setAttribute('aria-activedescendant', `${select.id}-opcao-${realce}`);
    else menu.removeAttribute('aria-activedescendant');
  }

  function posicionar() {
    const r = botao.getBoundingClientRect();
    const largura = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
    const esquerda = Math.max(8, Math.min(r.left, window.innerWidth - largura - 8));
    menu.style.left = `${esquerda}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.width = `${largura}px`;
    menu.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 18)}px`;
  }

  function mostrarRealce(i, rolar = true) {
    const n = select.options.length;
    if (!n) return;
    realce = (i + n) % n;
    for (const item of menu.children) item.classList.toggle('realce', Number(item.dataset.indice) === realce);
    menu.setAttribute('aria-activedescendant', `${select.id}-opcao-${realce}`);
    if (rolar) menu.children[realce]?.scrollIntoView({ block: 'nearest' });
  }

  function abrir() {
    if (botao.disabled || select.options.length === 0) return;
    if (listaAbertaAgora && listaAbertaAgora !== lista) listaAbertaAgora.fechar(false);
    realce = Math.max(0, select.selectedIndex);
    desenharOpcoes();
    menu.hidden = false;
    posicionar();
    mostrarRealce(realce);
    botao.setAttribute('aria-expanded', 'true');
    listaAbertaAgora = lista;
    menu.focus({ preventScroll: true });
    if (typeof mostrarControlos === 'function') mostrarControlos();
  }

  function fechar(devolverFoco = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    botao.setAttribute('aria-expanded', 'false');
    if (listaAbertaAgora === lista) listaAbertaAgora = null;
    if (devolverFoco) botao.focus({ preventScroll: true });
  }

  function escolher(i) {
    const o = select.options[i];
    fechar();
    if (!o || o.selected) return;
    select.value = o.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Abrir: clique ou setas, Enter, Espaço
  botao.addEventListener('click', () => (menu.hidden ? abrir() : fechar()));
  botao.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      abrir();
    }
  });

  // Escolher com o rato
  menu.addEventListener('mousemove', (e) => {
    const item = e.target.closest('.lista-opcao');
    if (item) mostrarRealce(Number(item.dataset.indice), false);
  });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.lista-opcao');
    if (item) escolher(Number(item.dataset.indice));
  });

  // Escolher com o teclado (as teclas não chegam aos atalhos da app)
  let procura = '';
  let tProcura = 0;
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); mostrarRealce(realce + 1); return;
      case 'ArrowUp': e.preventDefault(); mostrarRealce(realce - 1); return;
      case 'Home': e.preventDefault(); mostrarRealce(0); return;
      case 'End': e.preventDefault(); mostrarRealce(select.options.length - 1); return;
      case 'Enter':
      case ' ': e.preventDefault(); escolher(realce); return;
      case 'Escape': e.preventDefault(); fechar(); return;
      case 'Tab': fechar(); return;
      default:
        // Escrever as primeiras letras salta para a opção
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          clearTimeout(tProcura);
          procura += e.key.toLowerCase();
          tProcura = setTimeout(() => { procura = ''; }, 700);
          const i = [...select.options].findIndex((o) => o.text.toLowerCase().startsWith(procura));
          if (i >= 0) mostrarRealce(i);
        }
    }
  });

  // Manter em sincronia quando o código muda o select
  const descritor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return descritor.get.call(this); },
    set(v) { descritor.set.call(this, v); sincronizar(); },
  });
  new MutationObserver(sincronizar).observe(select, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['disabled', 'class', 'title'],
  });
  select.addEventListener('change', sincronizar);

  lista.fechar = fechar;
  lista.abrir = abrir;
  lista.sincronizar = sincronizar;
  listasTema.push(lista);
  sincronizar();
  return lista;
}

function fecharListas() {
  if (listaAbertaAgora) listaAbertaAgora.fechar(false);
}

// Clicar fora, mudar o tamanho da janela ou sair dela fecha a lista
document.addEventListener('mousedown', (e) => {
  if (!listaAbertaAgora) return;
  if (!listaAbertaAgora.menu.contains(e.target) && !listaAbertaAgora.botao.contains(e.target)) fecharListas();
});
window.addEventListener('resize', fecharListas);
window.addEventListener('blur', fecharListas);

// Na janela principal; a janela Gravar cria as suas
if (typeof el !== 'undefined' && el.selVideo) {
  criarListaTema(el.selVideo, 'Fonte de vídeo');
  criarListaTema(el.selAudio, 'Entrada de áudio');
}
