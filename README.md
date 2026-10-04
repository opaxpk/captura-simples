# Captura Simples

Ver e ouvir em direto a imagem de uma placa de captura USB no Windows 11, com a menor latência possível. Não grava, não faz stream e não tira screenshots.

## Descarregar

Vai a **[Releases](../../releases/latest)**, descarrega o `CapturaSimples-Setup.exe` e abre-o. Instala-se sozinho em poucos segundos, sem perguntas nem administrador, e cria um atalho no ambiente de trabalho e no menu Iniciar. A partir daí abre logo.

Depois disso não precisas de voltar aqui: o botão de atualizar (setas, ao lado do ecrã inteiro) instala as versões novas sozinho.

Para desinstalar: Definições do Windows, Aplicações, Aplicações instaladas, Captura Simples.

## Atalhos

| Tecla | Ação |
|---|---|
| F11 ou duplo clique | Ecrã inteiro |
| Esc | Sair do ecrã inteiro ou fechar um painel |
| M | Silenciar / ativar som |
| Seta cima / baixo | Volume |
| [ e ] | Atraso do som (para acertar com a imagem) |
| C | Corrigir cores |
| H | Esconder / mostrar a barra |
| ? | Ajuda dos atalhos |

## Publicar uma versão nova

1. Faz as alterações.
2. No `package.json`, aumenta `"version"` (por exemplo de `1.2.0` para `1.3.0`).
3. Escreve o que mudou no `NOVIDADES.md`. É isto que aparece no botão de atualizar.
4. Envia para o GitHub (commit + push).
5. No GitHub, abre o separador **Actions**, escolhe **Publicar versão** e carrega em **Run workflow**.

O GitHub testa a app e, se o teste passar, gera o instalador e a atualização em 5 a 8 minutos e cria a versão em Releases.

### Atualização pequena ou completa?

- **Pequena:** se só mudaste ficheiros da pasta `ui/`, quem tem o programa clica em **Atualizar** e recebe a versão nova em segundos, sem fechar a app.
- **Completa:** se mudaste `main.js`, `preload.js`, o Electron ou outra dependência, aumenta também `"versaoBase"` no `package.json`. O botão descarrega o instalador novo, instala em silêncio e volta a abrir a app.

## Estrutura

```
main.js, preload.js   base do programa (janela, permissões, atualizações)
ui/                   tudo o que se vê, atualizável pelo botão
  index.html, styles.css
  estado.js           definições guardadas e estado partilhado
  interface.js        painéis, avisos, barra e ecrã inteiro
  dispositivos.js     listas de vídeo/áudio e escolha automática
  video.js            imagem, luz de sinal e aviso de falta de HDMI
  audio.js            som, volume, atraso e medidor
  imagem.js           ajustar/esticar, píxeis nítidos e cores
  definicoes.js       painel de definições
  atualizacoes.js     botão de atualizar
  arranque.js         liga tudo e trata dos atalhos
scripts/teste.js      teste automático com câmara e microfone falsos
```

## Desenvolver

```
npm install
npm start
npm test
```

Para gerar o instalador no teu PC: `npm run dist` (fica em `dist\CapturaSimples-Setup.exe`).
