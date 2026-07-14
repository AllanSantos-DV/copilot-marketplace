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
  "nodes": [ /* vxk: {type, ...params, label, info} | konva: {id,label,x?,y?,r?,color,info} */ ],
  "edges": [ /* só konva: {from, to, label?} */ ]
}
```

## Rodar

```sh
node build-artifact.mjs specs/orbitas.json          # -> Desktop\visual-explanations\orbitas.html
node build-artifact.mjs specs/grafo.json            # motor konva
node build-artifact.mjs specs/orbitas.json out.html # saída explícita
```

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
