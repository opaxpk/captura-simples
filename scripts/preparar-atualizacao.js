// Prepara os ficheiros da atualização pequena (só o conteúdo) na pasta "atualizacao/".
// Corre no GitHub Actions ao publicar uma versão; também podes correr à mão: node scripts/preparar-atualizacao.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const raiz = path.join(__dirname, '..');
const pkg = require(path.join(raiz, 'package.json'));
const FICHEIROS = ['index.html', 'renderer.js', 'styles.css'];
const saida = path.join(raiz, 'atualizacao');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(saida);

const ficheiros = {};
for (const nome of FICHEIROS) {
  const dados = fs.readFileSync(path.join(raiz, nome));
  fs.writeFileSync(path.join(saida, nome), dados);
  ficheiros[nome] = crypto.createHash('sha256').update(dados).digest('hex');
}

const manifesto = { versao: pkg.version, versaoBase: pkg.versaoBase, ficheiros };
fs.writeFileSync(path.join(saida, 'atualizacao.json'), JSON.stringify(manifesto, null, 2));
console.log(`Atualização ${pkg.version} (base ${pkg.versaoBase}) preparada em atualizacao/`);
