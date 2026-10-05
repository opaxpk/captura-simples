'use strict';
// Interface: ecrã de estado, aviso no ecrã (OSD), painéis, barra flutuante e ecrã inteiro.

// =====================================================================
// Ecrã de estado (a ligar / erros)
// =====================================================================
function mensagemErro(e) {
  switch (e && e.name) {
    case 'NotFoundError':
    case 'OverconstrainedError':
      return ['Placa de captura não encontrada',
        'Confirma que a placa está ligada à porta USB e escolhe-a na lista Vídeo. Se acabaste de a ligar, espera uns segundos.'];
    case 'NotReadableError':
    case 'AbortError':
      return ['A placa está a ser usada por outro programa',
        'Fecha o OBS, o Discord ou outra aplicação que esteja a usar a placa. Se continuar, desliga e volta a ligar o cabo USB.'];
    case 'NotAllowedError':
    case 'SecurityError':
      return ['O Windows está a bloquear a câmara',
        'Abre Definições, Privacidade e segurança, Câmara, e ativa "Permitir que as aplicações de ambiente de trabalho acedam à câmara".'];
    case 'SemDispositivos':
      return ['Nenhuma placa de captura ligada',
        'Liga a placa a uma porta USB. A imagem aparece sozinha assim que o Windows a reconhecer.'];
    case 'Desligada':
      return ['A placa foi desligada',
        'Volta a ligá-la à porta USB. A imagem volta sozinha assim que o Windows a reconhecer.'];
    default:
      return ['Não foi possível mostrar a imagem', (e && e.message) || String(e)];
  }
}

function mostrarEstado(modo, titulo, texto) {
  el.estado.dataset.modo = modo;
  el.estadoTitulo.textContent = titulo;
  el.estadoTexto.textContent = texto;
}

function esconderEstado() {
  el.estado.dataset.modo = 'oculto';
}

function mostrarAviso(e) {
  const [titulo, texto] = mensagemErro(e);
  mostrarEstado('erro', titulo, texto);
  definirSinal(e && e.name === 'Desligada' ? 'erro' : 'sem', 'Sem sinal');
  mostrarControlos();
}

// =====================================================================
// Aviso rápido no ecrã (volume, atraso, etc.)
// =====================================================================
let tOsd = null;
function mostrarOsd(texto, duracao = 1100) {
  el.osd.textContent = texto;
  el.osd.classList.add('visivel');
  clearTimeout(tOsd);
  tOsd = setTimeout(() => el.osd.classList.remove('visivel'), duracao);
}

// =====================================================================
// Painéis (definições, atualizações, atalhos): só um aberto de cada vez
// =====================================================================
const PAINEIS = () => [el.painelDefinicoes, el.painelAtualizacao, el.ajuda];

function painelAberto(p) {
  return p ? !p.hidden : PAINEIS().some((x) => !x.hidden);
}

function abrirPainel(p) {
  for (const outro of PAINEIS()) if (outro !== p) outro.hidden = true;
  p.hidden = false;
  mostrarControlos();
}

function fecharPainel(p) {
  if (p) p.hidden = true;
  else for (const x of PAINEIS()) x.hidden = true;
}

// =====================================================================
// Barra flutuante (ecrã inteiro ou "esconder a barra") e cursor
// =====================================================================
let temporizadorInativo = null;

function barraFlutuante() {
  return emEcraInteiro || def.barraEscondida;
}

function aplicarModoBarra() {
  document.body.classList.toggle('flutuante', barraFlutuante());
  ajustarBarraDepois();
  mostrarControlos();
}

function mostrarControlos() {
  document.body.classList.remove('inativo');
  clearTimeout(temporizadorInativo);
  if (!barraFlutuante()) return;
  temporizadorInativo = setTimeout(() => {
    const ocupado = el.barra.matches(':hover') || el.estado.dataset.modo !== 'oculto' || painelAberto();
    if (ocupado) { mostrarControlos(); return; }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    document.body.classList.add('inativo');
  }, 2500);
}

function aplicarEcraInteiro(estado) {
  emEcraInteiro = estado;
  document.body.classList.toggle('ecra-inteiro', estado);
  const rotulo = estado ? 'Sair do ecrã inteiro' : 'Ecrã inteiro';
  el.btnEcra.setAttribute('aria-label', rotulo);
  el.btnEcra.title = estado ? `${rotulo} (Esc)` : `${rotulo} (F11 ou duplo clique)`;
  aplicarModoBarra();
}

// =====================================================================
// Botões segmentados
// =====================================================================
function marcarSegmento(grupo, valor) {
  for (const b of grupo.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.valor === String(valor)));
  }
}

function aoEscolherSegmento(grupo, callback) {
  grupo.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (e.detail) b.blur();
    callback(b.dataset.valor);
  });
}

// =====================================================================
// Barra que se adapta à largura da janela
// ---------------------------------------------------------------------
// Vai encolhendo por passos, só os que forem precisos para caber tudo:
//  1. tira os rótulos "Vídeo" e "Áudio"
//  2. encolhe o volume e tira a percentagem
//  3. encolhe as listas
//  4. passa a resolução e os FPS para o painel de Definições
//  5. passa também o volume para o painel (o botão de silenciar fica)
// A luz de sinal e os botões da direita ficam sempre visíveis.
// =====================================================================
const NIVEIS_COMPACTOS = 5;
let nivelCompacto = 0;

function aplicarNivelCompacto(n) {
  nivelCompacto = n;
  for (let k = 1; k <= NIVEIS_COMPACTOS; k++) {
    document.body.classList.toggle(`compacto-${k}`, n >= k);
  }

  const formatoNoPainel = n >= 4;
  const volumeNoPainel = n >= 5;
  const pai = (no) => no.parentElement;

  if (formatoNoPainel && pai(el.segRes) !== el.destinoFormato) el.destinoFormato.append(el.segRes, el.segFps);
  if (!formatoNoPainel && pai(el.segRes) !== el.grupoFormato) el.grupoFormato.append(el.segRes, el.segFps);
  if (volumeNoPainel && pai(el.caixaVolume) !== el.destinoVolume) el.destinoVolume.append(el.caixaVolume, el.volumeValor);
  if (!volumeNoPainel && pai(el.caixaVolume) !== el.grupoSom) el.grupoSom.append(el.caixaVolume, el.volumeValor);

  el.linhaFormato.hidden = !formatoNoPainel;
  el.linhaVolume.hidden = !volumeNoPainel;
  el.secaoBarra.hidden = !formatoNoPainel;
}

function barraTransborda() {
  return el.barra.scrollWidth > el.barra.clientWidth + 1;
}

function ajustarBarra() {
  aplicarNivelCompacto(0);
  let n = 0;
  while (n < NIVEIS_COMPACTOS && barraTransborda()) aplicarNivelCompacto(++n);
}

let pedidoAjuste = 0;
function ajustarBarraDepois() {
  cancelAnimationFrame(pedidoAjuste);
  pedidoAjuste = requestAnimationFrame(ajustarBarra);
}
