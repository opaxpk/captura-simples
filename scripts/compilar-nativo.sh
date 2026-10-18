#!/usr/bin/env bash
# Compila o módulo do som por programa (native/som-programas) para a versão do Electron da app
# e verifica que carrega. Corre no Windows do GitHub (precisa do Visual Studio e do Python).
# Os erros do compilador aparecem como anotações, porque o registo completo nem sempre se lê.
set -uo pipefail
EV=$(node -p "require('electron/package.json').version")
echo "Electron $EV"
if ! npx --yes node-gyp@latest rebuild --directory native/som-programas --target="$EV" --arch=x64 \
    --dist-url=https://electronjs.org/headers > gyp.log 2>&1; then
  cat gyp.log
  grep -iE " error |error C|error LNK|fatal error|gyp ERR" gyp.log | head -40 | sed 's/^/::error::/'
  exit 1
fi
tail -5 gyp.log
cp native/som-programas/build/Release/som_programas.node native/som_programas.node
if ! ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/verificar-nativo.js > verificar.log 2>&1; then
  cat verificar.log
  head -20 verificar.log | sed 's/^/::error::/'
  exit 1
fi
cat verificar.log
sed 's/^/::notice::/' verificar.log
