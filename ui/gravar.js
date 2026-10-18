'use strict';
// Janela "Gravar": só botões e números. Quem grava é a janela principal;
// esta janela pede ("iniciar", "parar", "definir") e mostra o estado que recebe.

const g = window.gravacao;
const $ = (id) => document.getElementById(id);
const ui = {
  relogio: $('relogio'),
  tempo: $('tempo'),
  estadoTexto: $('estadoTexto'),
  btnPrincipal: $('btnPrincipal'),
  erro: $('erro'),
  aviso: $('aviso'),
  dPerdidas: $('dPerdidas'),
  linhaPerdidas: $('linhaPerdidas'),
  dFicheiro: $('dFicheiro'),
  dTamanho: $('dTamanho'),
  dImagem: $('dImagem'),
  dFormato: $('dFormato'),
  dCodificador: $('dCodificador'),
  dCpu: $('dCpu'),
  dEspaco: $('dEspaco'),
  opcoes: $('opcoes'),
  segQualidade: $('segQualidade'),
  notaQualidade: $('notaQualidade'),
  optSom: $('optSom'),
  dPasta: $('dPasta'),
  btnMudarPasta: $('btnMudarPasta'),
  btnAbrirPasta: $('btnAbrirPasta'),
  ultima: $('ultima'),
  uNome: $('uNome'),
  uDetalhe: $('uDetalhe'),
  btnMostrar: $('btnMostrar'),
};

const NOTAS = {
  alta: 'Alta: 24 Mb/s a 1080p60, cerca de 10 GB por hora. Para editar depois sem perder detalhe.',
  equilibrada: 'Equilibrada: 14 Mb/s a 1080p60, cerca de 6 GB por hora. Boa para o YouTube.',
  leve: 'Leve: 8 Mb/s a 1080p60, cerca de 3,5 GB por hora. Ocupa menos espaço.',
};

let estado = { aGravar: false };
let info = { pasta: '', livre: null, cpu: null };

const p2 = (n) => String(n).padStart(2, '0');
function duracao(s) {
  const h = Math.floor(s / 3600);
  return h ? `${h}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}` : `${p2(Math.floor(s / 60))}:${p2(s % 60)}`;
}
function tamanho(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2).replace('.', ',')} GB`;
  if (bytes < 10e6) return `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
function horas(segundos) {
  if (segundos >= 3600) return `cerca de ${Math.floor(segundos / 3600)} h`;
  return `cerca de ${Math.max(1, Math.floor(segundos / 60))} min`;
}

function marcarSegmento(grupo, valor) {
  for (const b of grupo.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.valor === valor));
}

function desenhar() {
  const e = estado;
  const ocupado = e.aGravar || e.aGuardar || e.aPreparar;

  // Relógio e botão
  let modo = 'pronto';
  let texto = 'Pronto para gravar';
  if (e.aGravar) { modo = 'a-gravar'; texto = e.comSom ? 'A gravar imagem e som' : 'A gravar só a imagem'; }
  else if (e.aPreparar) { modo = 'a-guardar'; texto = 'A preparar a gravação…'; }
  else if (e.aGuardar) { modo = 'a-guardar'; texto = 'A guardar o ficheiro…'; }
  else if (!e.temImagem) { modo = 'sem-imagem'; texto = 'Sem imagem da placa. Liga a placa para poder gravar.'; }
  ui.relogio.dataset.estado = modo;
  ui.estadoTexto.textContent = texto;
  ui.tempo.textContent = duracao(e.aGravar ? e.duracao || 0 : 0);

  ui.btnPrincipal.textContent = e.aGravar ? 'Parar e guardar' : e.aPreparar ? 'A preparar…' : e.aGuardar ? 'A guardar…' : 'Começar a gravar';
  ui.btnPrincipal.classList.toggle('parar', !!e.aGravar);
  ui.btnPrincipal.disabled = !!e.aGuardar || !!e.aPreparar || (!e.aGravar && !e.temImagem);

  ui.erro.hidden = !e.erro;
  ui.erro.textContent = e.erro || '';
  ui.aviso.hidden = !e.aviso;
  ui.aviso.textContent = e.aviso || '';

  // Números
  ui.dFicheiro.textContent = ocupado ? e.nome : 'Ainda sem gravação';
  ui.dTamanho.textContent = ocupado ? tamanho(e.bytes) : '–';
  ui.dImagem.textContent = ocupado && e.resolucao ? `${e.resolucao}, ${(e.debito / 1e6).toFixed(0)} Mb/s` : '–';
  ui.dPerdidas.textContent = e.perdidas ? `${e.perdidas} (o PC não acompanhou)` : 'Nenhuma';
  ui.dPerdidas.className = e.perdidas ? 'atencao' : '';
  ui.linhaPerdidas.hidden = !e.aGravar;
  ui.dFormato.textContent = e.formato || '–';

  const cod = { placa: 'Placa gráfica (leve para o PC)', processador: 'Processador (mais pesado)', desconhecido: 'Não foi possível saber', 'a verificar': 'A verificar…' }[e.codificador];
  ui.dCodificador.textContent = ocupado && cod ? cod : '–';
  ui.dCodificador.className = !ocupado ? '' : e.codificador === 'placa' ? 'bom' : e.codificador === 'processador' ? 'atencao' : '';

  ui.dCpu.textContent = info.cpu === null ? '–' : `${String(info.cpu).replace('.', ',')}% do processador (toda a app)`;

  if (info.livre === null) ui.dEspaco.textContent = '–';
  else {
    const debito = e.aGravar ? e.debito : ({ alta: 24e6, equilibrada: 14e6, leve: 8e6 }[e.qualidade] || 14e6);
    const segundos = info.livre / ((debito + 192000) / 8);
    ui.dEspaco.textContent = `${tamanho(info.livre)}, dá para ${horas(segundos)}`;
    ui.dEspaco.className = segundos < 1800 ? 'atencao' : '';
  }

  // Opções (só antes de gravar)
  ui.opcoes.classList.toggle('bloqueadas', ocupado);
  for (const b of ui.segQualidade.querySelectorAll('button')) b.disabled = ocupado;
  marcarSegmento(ui.segQualidade, e.qualidade || 'equilibrada');
  ui.notaQualidade.textContent = NOTAS[e.qualidade || 'equilibrada'];
  ui.optSom.checked = e.som !== false;
  ui.optSom.disabled = ocupado;
  ui.btnMudarPasta.disabled = ocupado;
  ui.dPasta.textContent = info.pasta || '–';

  // Última gravação
  ui.ultima.hidden = !e.ultima;
  if (e.ultima) {
    ui.uNome.textContent = e.ultima.nome;
    ui.uDetalhe.textContent = `${duracao(e.ultima.duracao || 0)}, ${tamanho(e.ultima.bytes)}`;
  }
  document.title = e.aGravar ? `A gravar ${duracao(e.duracao || 0)}` : 'Gravar';
}

async function atualizarInfo() {
  try { info = await g.info(); } catch { /* */ }
  desenhar();
}

// ---------- Ações ----------
ui.btnPrincipal.addEventListener('click', () => {
  g.comando({ acao: estado.aGravar ? 'parar' : 'iniciar' });
});
ui.segQualidade.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled) g.comando({ acao: 'definir', qualidade: b.dataset.valor });
});
ui.optSom.addEventListener('change', () => g.comando({ acao: 'definir', som: ui.optSom.checked }));
ui.btnMudarPasta.addEventListener('click', async () => {
  const pasta = await g.escolherPasta();
  if (pasta) await atualizarInfo();
});
ui.btnAbrirPasta.addEventListener('click', () => g.abrirPasta());
ui.btnMostrar.addEventListener('click', () => { if (estado.ultima) g.mostrarFicheiro(estado.ultima.caminho); });

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key.toLowerCase() === 'r' && !ui.btnPrincipal.disabled) {
    e.preventDefault();
    ui.btnPrincipal.click();
  }
  if (e.key === 'Escape' && !estado.aGravar) window.close();
});

// ---------- Estado ----------
g.onEstado((novo) => { estado = novo || { aGravar: false }; desenhar(); });
g.estadoAtual().then((e) => { estado = e || estado; desenhar(); });
g.comando({ acao: 'estado' });
atualizarInfo();
setInterval(atualizarInfo, 2000);
