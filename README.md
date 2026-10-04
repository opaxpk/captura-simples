# Captura Simples

Ver e ouvir em direto a imagem de uma placa de captura USB no Windows 11, com a menor latência possível. Não grava, não faz stream e não tira screenshots.

## Descarregar

Vai a **[Releases](../../releases/latest)** e descarrega o `CapturaSimples-x.y.z.exe`. Abre com duplo clique, sem instalação.

## Atalhos

| Tecla | Ação |
|---|---|
| F11 ou duplo clique | Ecrã inteiro |
| Esc | Sair do ecrã inteiro |
| M | Silenciar / ativar som |
| Seta cima / baixo | Volume |

## Publicar uma versão nova

1. Faz as alterações.
2. No `package.json`, aumenta `"version"` (por exemplo de `1.1.0` para `1.2.0`).
3. Escreve o que mudou no `NOVIDADES.md`. É isto que aparece no botão de atualizar.
4. Envia para o GitHub (commit + push).
5. No GitHub, abre o separador **Actions**, escolhe **Publicar versão** e carrega em **Run workflow**.

O GitHub gera o `.exe` e a atualização em 3 a 5 minutos e cria a versão em Releases.

### Atualização pequena ou completa?

- Se só mudaste `index.html`, `renderer.js` ou `styles.css`, quem já tem o programa clica em **Atualizar** e recebe a versão nova em segundos (poucos KB).
- Se mudaste `main.js`, `preload.js`, o Electron ou outra dependência, aumenta também `"versaoBase"` no `package.json`. Assim o botão manda descarregar o `.exe` novo.

## Desenvolver

```
npm install
npm start
```

Para gerar o `.exe` no teu PC: `npm run dist` (fica em `dist\`).
