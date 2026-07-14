# visual-explainer

Explicações visuais **animadas e interativas** direto do agente. Você pede um assunto (“explica o
ciclo da água”, “o motor 4 tempos”, “bubble sort”, “um grafo de dependências”) e um **agente
desenhista** gera uma **página HTML autocontida** (Canvas/SVG) com **play/pause, velocidade, zoom,
arrastar e peças clicáveis** — aberta no seu navegador.

## Como funciona

Nada de desenhar na mão. O agente escreve uma **spec declarativa (JSON)** e um **builder** monta o
HTML otimizado, inlinando o motor escolhido:

- **Motor `vxk`** (leve, próprio): explicações comuns — órbitas, física, fluxo, algoritmos, timeline.
- **Motor `konva`** (vendorizado): grafos/redes com nós arrastáveis e interação pesada.

Um **design system** de componentes reutilizáveis cresce a cada arte — o agente raramente desenha do zero.
Performance embutida: ~30 FPS, DPR ≤ 1.5, pausa em aba oculta, tudo offline e self-contained.

## Instalação

```sh
copilot plugin marketplace add AllanSantos-DV/copilot-marketplace
copilot plugin install visual-explainer@copilot-marketplace
```

No **SessionStart**, o `boot.mjs` instala o kit em `~/.copilot/vxk` e o agente `visual-explainer`
em `~/.copilot/agents` (idempotente, por versão). **Reinicie o app uma vez** para o agente aparecer
no seletor. Os artefatos são gerados em `Desktop\visual-explanations\`.

## Uso

Peça a uma explicação visual (ou selecione o agente `visual-explainer`):

> “Explica visualmente como funciona o modelo atômico de Bohr.”

O agente escolhe o motor, escreve a spec, roda o builder e abre a página.

## Estrutura

```
visual-explainer/
  plugin.json          # metadados + hooks
  hooks.json           # SessionStart -> node boot.mjs
  boot.mjs             # instala kit + agente em ~/.copilot (idempotente)
  payload/
    kit/               # motores + design system (componentes)
    build-artifact.mjs # builder: spec -> HTML autocontido
    templates/         # exemplos por tipo de visual
    visual-explainer.agent.md  # o agente desenhista (instalado em ~/.copilot/agents)
    README.md          # guia do kit
```
