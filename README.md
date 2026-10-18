# Captura Simples

Ver e ouvir em direto a imagem de uma placa de captura USB no Windows 11, com a menor latência possível, e gravar o jogo sem pesar no PC.

## Descarregar

Vai a **[Releases](../../releases/latest)**, descarrega o `CapturaSimples-Setup.exe` e abre-o. Instala-se sozinho em poucos segundos, sem perguntas nem administrador, e cria um atalho no ambiente de trabalho e no menu Iniciar. A partir daí abre logo.

Depois disso não precisas de voltar aqui: o botão de atualizar (setas, ao lado do ecrã inteiro) instala as versões novas sozinho.

Para desinstalar: Definições do Windows, Aplicações, Aplicações instaladas, Captura Simples.

## Gravar

Carrega no botão de gravar (o círculo na barra) ou na tecla **R**. Abre-se a janela **Gravar**, à parte, com o tempo, o tamanho, o espaço livre e as escolhas de qualidade, som e pasta; a janela principal continua só com o jogo.

Na janela Gravar escolhes **o que gravar**: a **placa de captura** (a consola) ou o **ecrã do PC**. Se tiveres vários monitores, escolhes qual pela miniatura.

### Som na gravação

A janela Gravar tem uma mesa de som com uma linha para cada fonte: a **placa de captura**, o **microfone** (escolhes qual; vem desligado) e **cada programa do PC que tem som** (Discord, Spotify, o jogo, o browser…), com o ícone do programa. Cada linha mostra o nível do som que vai para a gravação (verde, âmbar acima de -6 dB, vermelho perto do máximo), tem volume de 0 a 200% e um botão para a tirar da gravação.

- Silenciar na mesa só tira da gravação: continuas a ouvir tudo no PC.
- Podes mudar volumes e silenciar a meio da gravação.
- A app lembra-se da escolha de cada programa (por exemplo, o Discord silenciado fica silenciado da próxima vez).
- **Gravar programas que comecem a tocar:** ligado, um programa novo entra logo na gravação; desligado, só entram os que puseres tu.
- O som de cada programa usa o Windows 10 versão 2004 ou mais recente (Windows 11 incluído). Sem isso, a mesa mostra a placa e o microfone e, a gravar o ecrã, o som do PC inteiro.

- **Formato:** MP4 com vídeo H.264 e som AAC, o que o DaVinci Resolve, o CapCut e o YouTube abrem diretamente.
- **Leve para o PC:** usa o codificador da placa gráfica (NVENC na NVIDIA, Quick Sync na Intel, AMF na AMD) quando existe; a janela Gravar diz qual está a ser usado e quanto processador a app gasta.
- **Seguro:** o ficheiro é escrito no disco a cada segundo (MP4 fragmentado, como no OBS). Se a app ou o PC falharem, o que já foi gravado fica.
- **Qualidade:** Alta 24 Mb/s, Equilibrada 14 Mb/s (por defeito), Leve 8 Mb/s, para 1080p a 60 fps.
- O volume e o silenciar da janela principal só mudam o que ouves, não o som gravado: o som gravado decide-se na mesa de som.
- Pasta: escolhe-se em **Guarda em**, logo por baixo do botão de gravar (por defeito Vídeos\Captura Simples). A app lembra-se dela.

## Atalhos

| Tecla | Ação |
|---|---|
| F11 ou duplo clique | Ecrã inteiro |
| Esc | Sair do ecrã inteiro ou fechar um painel |
| R | Começar ou parar a gravação |
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
- **Completa:** se mudaste `main.js`, `preload.js`, `gravacao-main.js`, `som-main.js`, o módulo `native/som-programas`, o Electron ou outra dependência, aumenta também `"versaoBase"` no `package.json`. O botão descarrega o instalador novo, instala em silêncio e volta a abrir a app.

## Estrutura

```
main.js, preload.js   base do programa (janela, permissões, atualizações)
gravacao-main.js      gravação: janela Gravar, escrita do ficheiro, pasta
som-main.js           som de cada programa: lista, níveis e captação durante a gravação
native/som-programas/ módulo em C++ (APIs de som do Windows), compilado pelo GitHub ao publicar
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
  gravacao.js         gravação na janela principal (fontes, ficheiro, estado)
  gravacao-worker.js  motor da gravação num Worker: ritmo constante, mesa de som, MP4
  mistura.js          mesa de som: microfone, níveis, volumes guardados
  gravar.html/.js/.css  janela Gravar
  gravar-mesa.js      mesa de som da janela Gravar
  listas.js           listas com o tema da app
  mp4-muxer.js        biblioteca mp4-muxer 5.2.2 (MIT), cópia do pacote npm
scripts/teste.js      teste automático com câmara e microfone falsos
scripts/som-falso.js  programas falsos com som, para o teste da mesa de som
```

## Desenvolver

```
npm install
npm start
npm test
```

Para gerar o instalador no teu PC: `npm run dist` (fica em `dist\CapturaSimples-Setup.exe`).
