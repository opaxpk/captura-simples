'use strict';
// Painel de definições: imagem, som e janela.

function atualizarControlosDefinicoes() {
  marcarSegmento(el.segEscala, def.escala);
  el.optNitido.checked = def.nitido;
  el.optCores.checked = def.corrigirCores;
  el.optBrilho.value = def.brilho;
  el.optContraste.value = def.contraste;
  el.optSaturacao.value = def.saturacao;
  el.valBrilho.textContent = `${def.brilho}%`;
  el.valContraste.textContent = `${def.contraste}%`;
  el.valSaturacao.textContent = `${def.saturacao}%`;
  el.optAtraso.value = def.atrasoSom;
  el.valAtraso.textContent = `${def.atrasoSom} ms`;
  el.optCima.checked = def.sempreCima;
  el.optAbrirEcra.checked = def.abrirEcraInteiro;
  el.optBarra.checked = def.barraEscondida;
  for (const r of [el.optBrilho, el.optContraste, el.optSaturacao, el.optAtraso]) {
    const p = ((r.value - r.min) / (r.max - r.min)) * 100;
    r.style.setProperty('--p', `${p}%`);
  }
}

function aplicarSempreCima() {
  if (ponte.setSempreCima) ponte.setSempreCima(def.sempreCima);
}

function alternarBarra() {
  def.barraEscondida = !def.barraEscondida;
  aplicarModoBarra();
  atualizarControlosDefinicoes();
  guardar();
  if (!emEcraInteiro) mostrarOsd(def.barraEscondida ? 'Barra escondida: aparece ao mexer o rato' : 'Barra sempre visível', 1600);
}

function ligarDefinicoes() {
  // Sempre por cima só existe dentro da app
  if (!ponte.setSempreCima) el.linhaCima.hidden = true;

  el.btnDefinicoes.addEventListener('click', (e) => {
    if (e.detail) el.btnDefinicoes.blur();
    if (painelAberto(el.painelDefinicoes)) fecharPainel(el.painelDefinicoes);
    else { atualizarControlosDefinicoes(); abrirPainel(el.painelDefinicoes); }
  });

  aoEscolherSegmento(el.segEscala, (valor) => {
    def.escala = valor;
    aplicarImagem();
    atualizarControlosDefinicoes();
    guardar();
  });

  const caixa = (input, chave, depois) => input.addEventListener('change', () => {
    def[chave] = input.checked;
    depois();
    guardar();
  });
  caixa(el.optNitido, 'nitido', aplicarImagem);
  caixa(el.optCores, 'corrigirCores', aplicarImagem);
  caixa(el.optCima, 'sempreCima', aplicarSempreCima);
  caixa(el.optAbrirEcra, 'abrirEcraInteiro', () => {});
  caixa(el.optBarra, 'barraEscondida', aplicarModoBarra);

  const deslizador = (input, chave, depois) => input.addEventListener('input', () => {
    def[chave] = Number(input.value);
    depois();
    atualizarControlosDefinicoes();
    guardar();
  });
  deslizador(el.optBrilho, 'brilho', aplicarImagem);
  deslizador(el.optContraste, 'contraste', aplicarImagem);
  deslizador(el.optSaturacao, 'saturacao', aplicarImagem);
  deslizador(el.optAtraso, 'atrasoSom', aplicarAtraso);

  el.btnReporImagem.addEventListener('click', () => {
    Object.assign(def, { escala: 'ajustar', nitido: false, corrigirCores: false, brilho: 100, contraste: 100, saturacao: 100 });
    aplicarImagem();
    atualizarControlosDefinicoes();
    guardar();
  });

  // Imagem estável: lida pelo programa ao arrancar, por isso só muda ao reabrir
  if (ponte.lerOpcoes) {
    const notaBase = 'Evita uma piscadela quando a barra desaparece';
    const mostrar = ({ guardadas, emUso }) => {
      el.optEstavel.checked = guardadas.imagemEstavel;
      el.notaEstavel.textContent = guardadas.imagemEstavel === emUso.imagemEstavel
        ? notaBase
        : 'Fecha e volta a abrir a app para aplicar';
    };
    ponte.lerOpcoes().then((o) => { el.linhaEstavel.hidden = false; mostrar(o); });
    el.optEstavel.addEventListener('change', async () => {
      await ponte.gravarOpcoes({ imagemEstavel: el.optEstavel.checked });
      mostrar(await ponte.lerOpcoes());
    });
  }

  el.btnAtalhos.addEventListener('click', () => abrirPainel(el.ajuda));
  el.ajFechar.addEventListener('click', () => fecharPainel(el.ajuda));
}
