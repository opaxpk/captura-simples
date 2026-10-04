'use strict';
// Imagem: tamanho (ajustar/esticar), píxeis nítidos e cores.
// Tudo é feito pela placa gráfica no momento de desenhar: não acrescenta atraso.

// Placas baratas enviam "gama limitada" (preto = 16, branco = 235).
// Esticar para 0–255 é multiplicar o contraste por 255/219.
const CORRECAO_GAMA = 255 / 219;

function aplicarImagem() {
  const v = el.video.style;
  v.objectFit = def.escala === 'esticar' ? 'fill' : 'contain';
  v.imageRendering = def.nitido ? 'pixelated' : 'auto';

  let contraste = def.contraste / 100;
  if (def.corrigirCores) contraste *= CORRECAO_GAMA;
  const brilho = def.brilho / 100;
  const saturacao = def.saturacao / 100;

  const partes = [];
  if (Math.abs(contraste - 1) > 0.001) partes.push(`contrast(${contraste.toFixed(3)})`);
  if (brilho !== 1) partes.push(`brightness(${brilho})`);
  if (saturacao !== 1) partes.push(`saturate(${saturacao})`);
  v.filter = partes.length ? partes.join(' ') : 'none';
}

function alternarCorrecaoCores() {
  def.corrigirCores = !def.corrigirCores;
  aplicarImagem();
  atualizarControlosDefinicoes();
  guardar();
  mostrarOsd(def.corrigirCores ? 'Corrigir cores ligado' : 'Corrigir cores desligado');
}
