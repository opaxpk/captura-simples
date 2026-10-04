'use strict';
// Atualizações: pequenas (só a pasta ui, poucos KB, sem fechar a app)
// ou completas (programa novo, descarregado e trocado sozinho).

const CHAVE_ATUALIZOU = 'capturaSimples.acabouDeAtualizar';
let resultadoAtualizacao = null;
let acaoPainelAtualizacao = null;
let versaoAtual = '';

function limparErro(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function mostrarPainelAtualizacao(modo, titulo, texto = '', { notas = '', acao = '', aoClicar = null, progresso = null } = {}) {
  const p = el.painelAtualizacao;
  p.dataset.modo = modo;
  el.atTitulo.textContent = titulo;
  el.atTexto.textContent = texto;
  el.atNotas.textContent = notas;
  el.atAcao.textContent = acao;
  el.atProgresso.hidden = progresso === null;
  if (progresso !== null) el.atBarra.style.transform = `scaleX(${progresso})`;
  el.atVersao.textContent = versaoAtual ? `Versão instalada: ${versaoAtual}` : '';
  acaoPainelAtualizacao = aoClicar;
  abrirPainel(p);
}

function marcarDisponivel(r) {
  const ha = r && r.estado !== 'atualizado';
  el.btnAtualizar.classList.toggle('disponivel', !!ha);
  const rotulo = ha ? `Versão ${r.nova} disponível` : 'Procurar atualizações';
  el.btnAtualizar.title = rotulo;
  el.btnAtualizar.setAttribute('aria-label', rotulo);
}

function mostrarResultado(r) {
  if (r.estado === 'atualizado') {
    mostrarPainelAtualizacao('atualizado', 'Tens a versão mais recente', `A versão ${r.atual} é a última publicada.`);
  } else if (r.estado === 'conteudo') {
    mostrarPainelAtualizacao('disponivel', `Versão ${r.nova} disponível`,
      'Atualização pequena: instala-se em segundos, sem fechar a app.',
      { notas: r.notas, acao: 'Atualizar agora', aoClicar: instalarPequena });
  } else if (r.podeAuto) {
    const mb = r.tamanhoMB ? ` (${r.tamanhoMB} MB)` : '';
    mostrarPainelAtualizacao('disponivel', `Versão ${r.nova} disponível`,
      `Esta versão traz o programa novo${mb}. Descarrega e reinicia sozinha, no mesmo sítio.`,
      { notas: r.notas, acao: 'Atualizar agora', aoClicar: instalarCompleta });
  } else {
    mostrarPainelAtualizacao('disponivel', `Versão ${r.nova} disponível`,
      'Esta versão precisa do programa novo. Descarrega o .exe na página da versão e substitui o que tens.',
      { notas: r.notas, acao: 'Abrir página de download', aoClicar: () => { atualizador.abrirPagina(); fecharPainel(el.painelAtualizacao); } });
  }
}

async function procurarAtualizacoes(silencioso) {
  if (!atualizador) return;
  if (!silencioso) {
    mostrarPainelAtualizacao('a-verificar', 'A procurar atualizações…');
    el.btnAtualizar.classList.add('a-rodar');
  }
  try {
    const r = await atualizador.verificar();
    resultadoAtualizacao = r;
    marcarDisponivel(r);
    if (!silencioso && painelAberto(el.painelAtualizacao)) mostrarResultado(r);
  } catch (e) {
    if (!silencioso && painelAberto(el.painelAtualizacao)) {
      mostrarPainelAtualizacao('erro', 'Não foi possível procurar atualizações', limparErro(e),
        { acao: 'Tentar outra vez', aoClicar: () => procurarAtualizacoes(false) });
    }
  } finally {
    el.btnAtualizar.classList.remove('a-rodar');
  }
}

async function instalarPequena() {
  const nova = resultadoAtualizacao && resultadoAtualizacao.nova;
  mostrarPainelAtualizacao('a-instalar', `A instalar a versão ${nova}…`, 'A imagem volta em poucos segundos.');
  try {
    const r = await atualizador.aplicar();
    try { localStorage.setItem(CHAVE_ATUALIZOU, r.versao); } catch { /* */ }
    // A app recarrega sozinha com a versão nova
  } catch (e) {
    mostrarPainelAtualizacao('erro', 'A atualização falhou', `${limparErro(e)} A versão atual continua a funcionar.`,
      { acao: 'Tentar outra vez', aoClicar: instalarPequena });
  }
}

async function instalarCompleta() {
  const nova = resultadoAtualizacao && resultadoAtualizacao.nova;
  mostrarPainelAtualizacao('a-instalar', `A descarregar a versão ${nova}…`, '0%', { progresso: 0 });
  try {
    await atualizador.aplicarCompleta();
    try { localStorage.setItem(CHAVE_ATUALIZOU, nova); } catch { /* */ }
    mostrarPainelAtualizacao('a-instalar', 'A reiniciar…', 'A app fecha e volta a abrir já atualizada.', { progresso: 1 });
  } catch (e) {
    mostrarPainelAtualizacao('erro', 'A atualização falhou', `${limparErro(e)} A versão atual continua a funcionar.`,
      { acao: 'Tentar outra vez', aoClicar: instalarCompleta });
  }
}

function ligarAtualizacoes() {
  if (!atualizador) return;
  el.btnAtualizar.hidden = false;

  el.btnAtualizar.addEventListener('click', (e) => {
    if (e.detail) el.btnAtualizar.blur();
    if (painelAberto(el.painelAtualizacao)) { fecharPainel(el.painelAtualizacao); return; }
    procurarAtualizacoes(false);
  });
  el.atFechar.addEventListener('click', () => fecharPainel(el.painelAtualizacao));
  el.atAcao.addEventListener('click', () => { if (acaoPainelAtualizacao) acaoPainelAtualizacao(); });

  if (atualizador.onProgresso) {
    atualizador.onProgresso((p) => {
      if (el.painelAtualizacao.dataset.modo !== 'a-instalar') return;
      el.atBarra.style.transform = `scaleX(${p})`;
      el.atTexto.textContent = `${Math.round(p * 100)}%`;
    });
  }

  atualizador.info().then((i) => {
    versaoAtual = i.versao;
    el.defVersao.textContent = `Versão ${i.versao}`;
  });

  try {
    const v = localStorage.getItem(CHAVE_ATUALIZOU);
    if (v) {
      localStorage.removeItem(CHAVE_ATUALIZOU);
      setTimeout(() => mostrarOsd(`Atualizado para a versão ${v}`, 2500), 800);
    }
  } catch { /* */ }

  // Procura em silêncio ao abrir: se houver versão nova, aparece um ponto no botão
  setTimeout(() => procurarAtualizacoes(true), 4000);
}
