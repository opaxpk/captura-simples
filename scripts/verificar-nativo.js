// Verifica, no Windows do GitHub, que o módulo do som por programa compilado carrega.
// Uso: ELECTRON_RUN_AS_NODE=1 electron.exe scripts/verificar-nativo.js
const path = require('path');

const m = require(path.join(__dirname, '..', 'native', 'som_programas.node'));
for (const f of ['listar', 'capturar', 'parar']) {
  if (typeof m[f] !== 'function') throw new Error(`Falta a função ${f}`);
}
let lista = [];
try {
  lista = m.listar([process.pid]);
  console.log(`listar: ${lista.length} programa(s) com som`);
} catch (e) {
  // A máquina do GitHub pode não ter som nenhum; carregar já prova que o módulo está bom
  console.log(`listar falhou (normal sem placa de som): ${e.message}`);
}
// Tentar captar o próprio processo: na máquina do GitHub pode não haver serviço de som
const id = m.capturar(process.pid, (dados, tempo, erro) => {
  if (erro) console.log(`capturar: ${erro}`);
  else console.log(`capturar: ${dados.length / 2} frames em ${tempo} µs`);
});
setTimeout(() => {
  m.parar(id);
  console.log('Módulo do som por programa: OK');
}, 1500);
