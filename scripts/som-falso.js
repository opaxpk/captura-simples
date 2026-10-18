// Módulo falso de "som por programa", só para os testes (CAPTURA_SOM_FALSO=1).
// Imita a interface do módulo nativo do Windows (native/som-programas):
//  - dois programas: "Programa de teste" toca um tom de 3 kHz; "Outro programa" está calado;
//  - os tempos vêm do relógio monótono (o mesmo do Chromium no Linux), em µs.
const TAXA = 48000;
const BLOCO = 480; // 10 ms

const programas = [
  { id: 'teste-programa', nome: 'Programa de teste', caminho: '/teste/programa', pids: [910001], freq: 3000 },
  { id: 'teste-outro', nome: 'Outro programa', caminho: '/teste/outro', pids: [910002], freq: 0 },
];

let proximoId = 1;
const capturas = new Map();
const agoraUs = () => Number(process.hrtime.bigint() / 1000n);

function listar() {
  const t = Date.now() / 1000;
  return programas.map((p) => ({
    id: p.id, nome: p.nome, caminho: p.caminho, pids: p.pids.slice(),
    ativo: p.freq > 0, nivel: p.freq > 0 ? 0.3 + 0.1 * Math.sin(t * 3) : 0,
  }));
}

function capturar(pid, callback) {
  const p = programas.find((x) => x.pids.includes(pid));
  const id = proximoId++;
  let fase = 0;
  let proximo = agoraUs();
  const relogio = setInterval(() => {
    // Entrega os blocos de 10 ms que já "tocaram", com o tempo de cada um
    while (agoraUs() - proximo >= BLOCO * 1e6 / TAXA) {
      const dados = new Float32Array(BLOCO * 2);
      if (p && p.freq) {
        for (let i = 0; i < BLOCO; i++) {
          const v = 0.25 * Math.sin(fase);
          fase += (2 * Math.PI * p.freq) / TAXA;
          dados[i * 2] = v;
          dados[i * 2 + 1] = v;
        }
      }
      // CAPTURA_SOM_FALSO=sem-relogio imita um Windows que não dá o tempo de cada pacote
      callback(dados, process.env.CAPTURA_SOM_FALSO === 'sem-relogio' ? 0 : proximo);
      proximo += BLOCO * 1e6 / TAXA;
    }
  }, 10);
  capturas.set(id, relogio);
  return id;
}

function parar(id) {
  clearInterval(capturas.get(id));
  capturas.delete(id);
}

module.exports = { listar, capturar, parar, taxa: TAXA, canais: 2, falso: true };
