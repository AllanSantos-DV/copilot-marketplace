# VXK — Visual Explainer Kit

Kit para gerar **explicações visuais animadas e interativas** (HTML autocontido, offline,
otimizado) a partir de uma **spec declarativa (JSON)**. O agente escreve só a spec; o **builder**
monta o HTML inlinando o motor escolhido. Design system que **cresce** a cada componente novo.

## Fluxo (mecanizado)

```
spec.json  ──►  node build-artifact.mjs spec.json  ──►  <Desktop>\visual-explanations\<slug>.html  ──►  abrir
```

O agente **não escreve HTML/canvas na mão**. Escreve a spec, escolhe o motor, roda o builder, abre.

## Dois motores (o agente escolhe pelo contexto)

| Motor | Quando usar | Como |
|---|---|---|
| **`vxk`** (próprio, leve) | ciclo, timeline, física simples, órbitas, data-structure simples, fluxo curto | `spec.nodes[]` usando componentes do design system (`kit/components/`) |
| **`konva`** (vendorizado) | grafos, muitos nós, arrastar/reordenar, rede/dependências, interação pesada | `spec.nodes[]` + `spec.edges[]` (cena de grafo declarativa) |

Ambos produzem **1 arquivo self-contained** (o builder inlina tudo) com a performance embutida
(30 FPS, DPR ≤ 1.5, pausa em aba oculta).

## Anatomia da spec

```jsonc
{
  "engine": "vxk",              // "vxk" (default) | "konva"
  "title": "...",              // título no cabeçalho
  "slug": "orbitas",           // nome do arquivo de saída
  "accent": "#5b8cff",         // cor de destaque
  "intro": "...",              // texto inicial do painel
  "narrate": true,             // OPCIONAL: liga a narração assada (voz) no build
  "voice": "vits-piper-pt_BR-faber-medium", // OPCIONAL: voz do motor (default: a do motor)
  "nodes": [ /* vxk: {type, ...params, label, info, narration?} | konva: {id,label,x?,y?,r?,color,info,narration?} */ ],
  "edges": [ /* só konva: {from, to, label?} */ ]
}
```

## Narração por voz (assada/offline)

Se a spec tiver `"narrate": true` (ou um `"voice"`), o builder sintetiza a fala no **motor único
de voz (vox-engine)** durante o build e **embute o áudio (opus, base64)** no próprio HTML — continua
sendo **1 arquivo self-contained e offline**, que narra em qualquer lugar sem daemon.

- **O que é falado:** o `intro` + a narração de cada nó, na ordem. Por nó, usa `node.narration` se
  existir, senão cai para `node.info`.
- **Voz:** o motor **já expõe o catálogo** (`info().tts_voices` + `default_voice`). Sem `voice`, usa a
  padrão do motor. Se a `voice` pedida não estiver instalada, o builder avisa e usa a padrão.
- **No HTML:** aparece o botão **🔊 Narrar** — um *tour guiado* que fala o intro e percorre cada nó
  **destacando** e mostrando a info enquanto narra (avança sozinho ao fim de cada trecho). **Clicar**
  num nó toca a narração dele.
- **Sem daemon no build:** o builder **avisa e gera o HTML sem áudio** (o visual continua). Suba o
  daemon `vox` e rebuilde para assar a narração.

Requer o daemon vox no ar **no momento do build** (o `build-artifact.mjs` conecta no named pipe e
chama `tts`). Ex.: `node build-artifact.mjs specs/orbitas-narrado.json`.

## Controles no HTML

- **Atalhos:** `Espaço` pausa/toca · `←`/`→` passo (ou seção, no board) · `Home`/`End` primeiro/último
  passo · `[`/`]` velocidade · `C` legenda.
- **Legenda (CC):** mostra o texto da narração junto com o áudio (nos passos sem áudio ele já aparece).
- **Link para um passo:** `arquivo.html#passo=4` abre direto no passo 4; o endereço acompanha a navegação.
- **Preferências:** velocidade e legenda ficam lembradas entre explicações (localStorage do navegador).
- **Barra lateral:** acompanha o passo (título + texto narrado); clicar num nó/mensagem vai ao passo dele e toca o áudio.
- **Konva:** com narração, o botão **🔊 Narrar** faz o tour (intro + cada nó) e clicar num nó toca a dele. Cada nó mostra o
  papel (ícone + subtítulo), as arestas o que trafega, e a seleção acende os vizinhos e lista as conexões na lateral.
  O konva não tem coreografia de passos: spec konva com `scenes` é recusada no build.
- **Board:** ícones Lucide nos cards, seções entram ao rolar, números contam e a narração põe holofote na seção ativa.

## Rodar

```sh
node build-artifact.mjs specs/orbitas.json          # -> Desktop\visual-explanations\orbitas.html
node build-artifact.mjs specs/grafo.json            # motor konva
node build-artifact.mjs specs/orbitas.json out.html # saída explícita
```

## Validar e publicar (release)

Este repositório é a **origem** do plugin `visual-explainer`; o `copilot-marketplace` só recebe a
cópia empacotada. O release é um comando:

```sh
npm run smoke                      # create/draw/hit de todas as specs (offline, sem navegador)
node tools/vend.mjs 0.3.2          # empacota e vende no ../copilot-marketplace (--marketplace <dir>, --dry-run)
```

O `vend` empacota o builder com esbuild (standalone), espelha `kit/`, `templates/`, este README e
`agent/visual-explainer.agent.md` no payload, sobe a versão nos 3 lugares (`plugin.json`,
`VXK_VERSION` do `boot.mjs`, `marketplace.json`), builda uma spec com o pacote vendado, regenera a
vitrine e roda o `gate.mjs check`. **Não commita nem dá push**: depois dele, revise a página
(agente `vitrine`), rode `node docs/gate.mjs mark visual-explainer` e commite no marketplace — o
commit em `main` é a publicação.

## Crescer o design system (componentes VXK)

Faltou um componente para o `vxk`? Crie `kit/components/<tipo>.js` com este contrato e registre
em `kit/registry.json`. Aí toda spec futura pode usar `{"type":"<tipo>", ...}`.

```js
// kit/components/<tipo>.js
VXK.register('<tipo>', {
  create(n){ return {}; },                 // estado por nó (opcional)
  draw(ctx, inst, n, e, selected){ /* desenha em coords de mundo; e.t=tempo, e.zoom, e.lite */ },
  hit(inst, n, wx, wy, e){ return false; } // true se (wx,wy) acerta o nó -> abre info
});
```

### Regras de performance (obrigatórias em componente novo)
- **Sem `shadowBlur`** dentro do `draw` (loop). Brilho = `radialGradient` translúcido.
- **Não crie gradiente/`Path2D` por frame**: cacheie no `create`/no primeiro `draw` e reutilize.
- Respeite `e.lite` (máquina fraca): menos enfeite, sem brilho.
- Espessura de linha em coords de mundo: use `1/e.zoom` para manter constante na tela.

## Estrutura

```
kit/
  vxk-core.css / vxk-core.js     # engine próprio (shell+loop+hit-test+zoom/pan+perf)
  components/<tipo>.js           # DESIGN SYSTEM (cresce)
  konva/konva.min.js             # Konva vendorizado (offline)
  konva/konva-adapter.js         # motor de grafo declarativo
  registry.json                  # catálogo de componentes/motores
specs/<nome>.json                # specs (entrada)
templates/                       # exemplos por visual_type
build-artifact.mjs               # builder: spec -> HTML autocontido
```
