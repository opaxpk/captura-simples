// Prepara os ficheiros de uma versão na pasta "atualizacao/":
//  - todos os ficheiros da pasta ui (a atualização pequena);
//  - atualizacao.json, com a versão, a base e a impressão digital (sha256) de cada ficheiro;
//  - se já existir dist/CapturaSimples.exe, também a impressão digital do programa completo.
// Corre no GitHub Actions ao publicar; também podes correr à mão: node scripts/preparar-atualizacao.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const raiz = path.join(__dirname, '..');
const pkg = require(path.join(raiz, 'package.json'));
const pastaUi = path.join(raiz, 'ui');
const saida = path.join(raiz, 'atualizacao');
const sha256 = (dados) => crypto.createHash('sha256').update(dados).digest('hex');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(saida);

const ficheiros = {};
for (const nome of fs.readdirSync(pastaUi).sort()) {
  const origem = path.join(pastaUi, nome);
  if (!fs.statSync(origem).isFile()) continue;
  if (!/^[\w.-]+$/.test(nome)) throw new Error(`Nome não permitido na pasta ui: ${nome}`);
  if (nome === 'atualizacao.json') throw new Error('A pasta ui não pode ter um ficheiro atualizacao.json');
  const dados = fs.readFileSync(origem);
  fs.writeFileSync(path.join(saida, nome), dados);
  ficheiros[nome] = sha256(dados);
}
if (!ficheiros['index.html']) throw new Error('Falta ui/index.html');

const manifesto = { versao: pkg.version, versaoBase: pkg.versaoBase, ficheiros };

const exe = path.join(raiz, 'dist', pkg.build.portable.artifactName);
if (fs.existsSync(exe)) {
  const dados = fs.readFileSync(exe);
  manifesto.exe = { nome: path.basename(exe), tamanho: dados.length, sha256: sha256(dados) };
}

fs.writeFileSync(path.join(saida, 'atualizacao.json'), JSON.stringify(manifesto, null, 2));
console.log(`Versão ${pkg.version} (base ${pkg.versaoBase}) preparada em atualizacao/ com ${Object.keys(ficheiros).length} ficheiros${manifesto.exe ? ' e o .exe' : ''}.`);
