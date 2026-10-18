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
// Tentar captar o próprio processo: na máquina do GitHub pode não haver serviço de som.
// Confirma também que o tempo de cada pacote está no relógio QPC (o mesmo do Chromium e do
// process.hrtime no Windows): a diferença para "agora" deve ser de poucos milissegundos.
const pacotes = [];
const id = m.capturar(process.pid, (dados, tempo, erro) => {
  if (erro) { console.log(`capturar: ${erro}`); return; }
  pacotes.push({ frames: dados.length / 2, tempo, agora: Number(process.hrtime.bigint() / 1000n) });
});
setTimeout(() => {
  m.parar(id);
  if (pacotes.length) {
    const p0 = pacotes[0];
    const pn = pacotes[pacotes.length - 1];
    const atraso = pacotes.map((p) => (p.agora - p.tempo) / 1000);
    console.log(`capturar: ${pacotes.length} pacotes, ${pacotes.reduce((t, p) => t + p.frames, 0)} frames`);
    console.log(`tempo do 1.º pacote ${(p0.tempo / 1e6).toFixed(3)} s, do último ${(pn.tempo / 1e6).toFixed(3)} s (avança ${((pn.tempo - p0.tempo) / 1000).toFixed(0)} ms)`);
    console.log(`chegada menos tempo do pacote: mín ${Math.min(...atraso).toFixed(1)} ms, máx ${Math.max(...atraso).toFixed(1)} ms`);
  }
  console.log('Módulo do som por programa: OK');
}, 1500);
