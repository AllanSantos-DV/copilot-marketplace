# Catálogo VXK — design system vivo

**Regra REUSE-FIRST:** antes de criar qualquer forma, reutilize estes componentes paramétricos. Quando um novo primitivo geral for necessário, implemente-o como componente FLAT reutilizável e **APENDA aqui** para a próxima geração reusar. O conteúdo de cada tópico deve ficar no `specs/<slug>.json`; o shell (`kit/vxk-core.*`) não é reautorado.

## Componentes atuais

| Componente | Propósito | Props lidas (`n.<prop>`) | `parts()` | Opções/notas |
|---|---|---|---|---|
| `orbit` | Corpo em órbita circular/centro astronômico. | `x`, `y`, `orbitR`, `ang0`, `speed`, `r`, `color`, `label` | Não | `orbitR=0` vira corpo central; `pos()` retorna a posição para câmera/anotação; `speed` anima pelo relógio. |
| `box` | Caixa/**card** rotulado para estado, etapa, ator, serviço ou bloco de fluxo. | `x`, `y`, `w`, `h`, `label`, `sublabel`, `icon`, `iconColor`, `subColor`, `color`, `stroke`, `textColor`, `flat`, `scale` | Não | `x/y` são centro; `flat:true` = visual chapado. **Com `icon`** (nome Lucide, ex.: `server`, `database`, `lock`, `globe`) vira um **CARD RICO**: glifo semântico à esquerda + título + `sublabel` + barra de accent — em vez de retângulo vazio (mata a "vacuidade semântica"). `scale` = pop de entrada (animável). O story define `icon`/`sublabel` → cards ricos de graça. |
| `wave` | Onda senoidal animada para sinal, som, vibração ou física ondulatória. | `amp`, `wavelength`, `speed`, `x0`, `x1`, `y`, `color`, `label` | Não | `y(n,e,x)` calcula a curva; hit segue a senoide; `speed` move a fase. |
| `arrow` | Seta decorativa de direção/fluxo entre pontos. | `x0`, `y0`, `x1`, `y1`, `color`, `label`, `dashed`, `flow`, `flowColor`, `flowCount`, `flowSpeed`, `prog` | Não | Hit é sempre falso; `flow:true` corre um pulso FLAT animado na direção (auto-layout liga por padrão); `prog` (0..1) = **write-on**: desenha só até a fração, com a ponta na frente — anime `prog` 0→1 num passo p/ a seta "se desenhar" (causalidade visível); animar `x0/y0/x1/y1` desenha progressão. |
| `callout` | Rótulo anotado que APONTA uma peça com linha-cotovelo (leader), estilo Ciechanowski/d3-annotation. | `x`, `y` (ponto a anotar), `dir` (`NE`/`NW`/`SE`/`SW`), `label`, `body`, `color`, `len`, `tone` | `pos()` | Ponto na peça + cotovelo (diagonal+horizontal) + caixa com título e `body` opcional. Coloque em `x,y` = ponto exato; a caixa flutua no quadrante `dir`. FLAT. |
| `gauge` | Medidor em arco (nível/percentual/score) — indicador de valor FLAT. | `x`, `y`, `r`, `value`, `min`, `max`, `unit`, `label`, `color`, `track`, `showValue` | — | Arco de trilho + arco preenchido na fração `(value-min)/(max-min)` + valor no centro + `label`. `value` animável (o step engine tweena → o medidor sobe). |
| `barMini` | Mini gráfico de barras (comparação/distribuição/antes-depois). | `x`, `y`, `w`, `h`, `values`, `max`, `color`, `colors`, `highlight`, `labels`, `gap`, `baseline` | — | Barras crescem da base; `highlight` (índice) destaca uma; `colors[]` por barra. `values` animável. |
| `metric` | Número grande animado (KPI/stat/number-ticker). | `x`, `y`, `value`, `label`, `prefix`, `suffix`, `decimals`, `color`, `accent`, `size`, `sublabel` | — | Formata `prefix+value+suffix`; `value` animável → conta subindo quando o step engine tweena; underline de accent + `label` mudo. Conecta mudança quantitativa a número visível. |
| `deviceCard` | Card rico de sistema/serviço p/ arquitetura (ícone + título + subtítulo + badge + portas). | `x`, `y`, `w`, `h`, `icon`, `label`, `sublabel`, `color`, `accent`, `badge`, `badgeColor`, `ports`, `scale` | `parts()`: `center/left/right/top` | Faixa de accent no topo; badge-pílula no canto; `ports` = pontos de conexão nas bordas p/ ligar setas/callouts. `scale` = pop. |
| `flowPipe` | Conector "cano" curvo com TOKENS fluindo (mais rico que arrow). | `x0`, `y0`, `x1`, `y1`, `curve`, `width`, `color`, `trackColor`, `flow`, `flowCount`, `flowSpeed`, `tokenColor`, `arrow`, `dashed`, `prog`, `label` | Não | `curve` = arco (bezier quadrática); tokens correm x0→x1 pelo relógio; `prog` = write-on. Banda arredondada FLAT. |
| `dimensionLine` | Cota de medição técnica (linha + ticks/arrows nas pontas + valor). | `x0`, `y0`, `x1`, `y1`, `label`, `color`, `offset`, `ticks`, `arrows`, `boxLabel` | Não | Linha (opcionalmente deslocada por `offset`) + caps nas pontas + chip com o valor no meio. Eleva diagramas ao padrão de ilustração técnica. |
| `legend` | Painel de legenda (swatch→rótulo) p/ tornar um diagrama colorido legível. | `x`, `y`, `title`, `items:[{color,label,shape?}]`, `cols`, `swatch`, `gap`, `pad`, `tone` | `hit` → info | Auto-dimensiona; `shape` = `dot`/`square`/`line`; `cols>1` = grade. |
| `comparisonSplit` | Painel dividido antes/depois (ou A vs B) com divisor deslizante. | `x`, `y`, `w`, `h`, `split`, `leftLabel`, `rightLabel`, `leftSub`, `rightSub`, `leftColor`, `rightColor`, `dividerColor`, `title` | `hit` → info | `split` (0..1) animável → o divisor desliza revelando; knob no divisor. |
| `crossSection` | Corte/cutaway: região com HACHURA diagonal (convenção "você vê por dentro"). | `x`, `y`, `w`, `h`, `shape`(`rect`/`circle`), `color`, `fill`, `angle`, `gap`, `label`, `lineWidth` | `hit` → info | Hachura paralela clipada à forma + borda + chip de rótulo. Ciechanowski. |
| `ghost` | Contorno GHOST (posição anterior/alvo) tracejado e translúcido — mostra mudança. | `x`, `y`, `w`, `h`, `shape`(`rect`/`circle`/`roundRect`), `color`, `alpha`, `label`, `dashed` | Não | Onion-skin: silhueta do "antes/depois". Sem fill sólido. |
| `pathTrace` | Marcador que percorre uma ROTA (polilinha) deixando rastro — jornada/caminho. | `points:[[x,y]]`, `color`, `routeColor`, `width`, `marker`, `speed`, `prog`, `trail`, `loop`, `showRoute` | Não | Interpola u∈[0,1] ao longo da polilinha (relógio ou `prog`); rota faint + rastro + marcador. GPS/rota. |
| `pulse` | Ping de ÊNFASE: anéis concêntricos que expandem e somem num ponto ("olhe aqui"). | `x`, `y`, `color`, `r`, `count`, `speed`, `dot`, `ringWidth` | Não | Ambiente (relógio); alpha some ao expandir. Manim Indicate/Flash, radar ping. |
| `frame` | Moldura de agrupamento com aba de rótulo (planos, colunas, faixas, **regiões/zonas**). | `x`, `y`, `w`, `h`, `label`, `color`, `dashed`, `fillAlpha`, `labelAlign` | `pos()` (topo-centro) | **Decorativa — `hit()` sempre falso** (não intercepta cliques do conteúdo interno). Contorno translúcido + preenchimento chapado sutil (`fillAlpha`); `labelAlign:'center'` centra a aba. É a "regionPlate": agrupe cards numa zona nomeada para o diagrama parecer **desenhado**. |
| `barArray` | Vetor de barras para ordenação, comparação e distribuição discreta. | `values`, `n`, `x0`, `y0`, `barW`, `gap`, `maxH`, `maxValue`, `color`, `colors`, `highlight`, `highlightColor`, `sort`, `controlled`, `stepEvery`, `showValues`, `labelColor` | Não | Sem `values`, cria vetor embaralhado; por padrão executa bubble sort pelo tempo; `sort:false`/`controlled:true` usa valores controlados; `colors[]`, `highlight` e valores visuais via `showValues`. |
| `pendulum` | Pêndulo simples oscilando. | `pivotX`, `pivotY`, `length`, `amp`, `speed`, `phase`, `r`, `color`, `label` | Não | `bob()` dá a posição da massa; `amp` em radianos; `phase` desloca a oscilação. |
| `particleStream` | Partículas fluindo de um ponto a outro. | `x0`, `y0`, `x1`, `y1`, `count`, `speed`, `r`, `color`, `label` | Não | Offsets fixos no `create()`; útil para fótons, moléculas, fluxo de dados, corrente elétrica. |
| `timeline` | Linha do tempo com eventos clicáveis e playhead animado. | `x0`, `x1`, `y`, `duration`, `color`, `events` | Não | `events[]` aceita `{t?, label, info, color?}`; `t>1` é segundo dentro de `duration`, `0..1` é fração; sem `t`, distribui igualmente. |
| `engine` | Motor 4 tempos FLAT com pistão, biela, virabrequim, válvulas e vela. | `x`, `y`, `scale`, `cycle`, `spin`, `label`, `info` | Sim: `piston`, `rod`, `crank`, `intake`, `exhaust`, `spark`, `chamber`, `cylinder` | Phase-driven: `cycle` 0..1 representa 720°; `spin>0` gira continuamente. Use `parts()` para anotações de subpeças. |
| `watercycle` | Paisagem FLAT do ciclo da água. | `x`, `y`, `scale`, `cycle` | Sim: `sea`, `sun`, `cloud`, `vapor`, `rain`, `river`, `mountains`, `groundwater` | Phase-driven por `cycle` 0..1: evaporação, condensação, precipitação, coleta/escoamento. |
| `leaf` | Folha/planta paramétrica para fotossíntese e trocas com o ambiente. | `x`, `y`, `scale`, `w`, `h`, `color`, `intensity`, `tilt`, `root`, `rootColor`, `stomataOpen`, `stroke`, `veinColor`, `stomataColor`, `textColor`, `label`, `info` | Sim: `leaf`, `chloroplast`, `stomata`, `root` | `root:false` oculta raiz; `intensity` altera cor interna; `stomataOpen` abre/fecha estômatos; `tilt` rotaciona folha. |
| `figure` | Silhueta humana FLAT paramétrica para temas narrativos/históricos/bíblicos/mitológicos (duas figuras próximas leem como luta). | `x`, `y`, `scale`, `color`, `stroke`, `lean`, `pose`, `flip`, `aura`, `auraColor`, `wound`, `alpha`, `label`, `textColor`, `info` | Sim: `head`, `hip`, `center`, `hand` **+ id-escopadas** `<id>.head`/`<id>.hip`/`<id>.center`/`<id>.hand` | `x,y`=centro; `lean` (rad) inclina em torno dos pés; `pose:"grapple"`(padrão) braços à frente/`"stand"` ao lado; `flip` espelha; `aura` 0..1 anel fino chapado (anjo/Deus); `wound` 0..1 marca no quadril; `alpha` 0..1 esmaece (sonho/visão). Anote o quadril de UMA figura via `<id>.hip` (sem ambiguidade entre duas figuras). Anima cor/`aura`/`wound`/`alpha`/`lean` por passo. |
| `graphNode` | Nó de grafo com glow (disco emissivo): o motivo recorrente de rede/DAG. | `x`, `y`, `r`, `color`, `label`, `kind`, `pulse`, `ring`, `info` | Não | `kind` = etiqueta curta DENTRO (escala com o mundo, aparece se `r≥15`); `label` = nome ABAIXO (tamanho de tela constante); `pulse` = anel expansivo; `ring` = 2º aro (ênfase). Glow/núcleo são gradientes CACHEADOS; sem shadowBlur. hit boolean → usa `n.label`+`n.info`. |
| `edge` | Aresta de grafo com glow e pulsos de fluxo entre dois pontos. | `x0`, `y0`, `x1`, `y1`, `color`, `label`, `flow`, `count`, `curve`, `width`, `dashed`, `arrow`, `dot`, `info` | Não | Reta ou quadrática (`curve` = empeno em px de mundo); `flow`/`count` correm pulsos; `arrow` põe ponta; **clicável só se tiver `info`** (conectores omitem `info`). Largura em coords de mundo (`width/zoom`); sem gradiente por frame. |
| `card` | Cartão de texto rico (kicker + título + corpo + badge/ícone). | `x`, `y`, `w`, `h`, `kicker`, `title`, `body`, `color`, `badge`, `icon`, `tone`, `label`, `info` | Não | `x/y`=centro; `body` aceita `\n` (bullets), quebra CACHEADA; `tone:'solid'` = painel tingido. Glow de seleção cacheado; sem shadowBlur. hit boolean → usa `n.label`+`n.info`. |
| `banner` | Título de seção/herói (kicker + título + subtítulo + régua de acento), sem caixa. | `x`, `y`, `kicker`, `title`, `subtitle`, `accent`, `align`, `size`, `w`, `info` | `pos()` (centro) | Tipografia em tamanho de tela constante (`px/zoom`); `align:'left'`; `size` escala a tipografia. Clicável só se tiver `info` → devolve objeto `{label,info,color}`. Ideal como cabeçalho de cena numa timeline de cenas. |
| `toggle` | Interruptor (kill-switch) OFF/ON — `on` numérico 0..1 (o step engine ANIMA o knob). | `x`, `y`, `key`, `on`, `offText`, `onText`, `offInfo`, `onInfo`, `onColor`, `offColor` | `pos()` (centro) | Clicar INVERTE de verdade (`hit()` muta `n.on`) e devolve a info do estado atual (`onInfo`/`offInfo`). `key` = rótulo mono acima; legenda de estado abaixo. Tamanho de tela constante; sem shadowBlur. |
| `lever` | Mostrador de config: valor numérico sobre trilho min..max com knob e alvo. | `x`, `y`, `w`, `label`, `value`, `min`, `max`, `unit`, `target`, `targetLabel`, `color`, `info` | `pos()` (centro) | Trilho em largura de MUNDO (`w`); rótulos/knob em tamanho de tela; `target` marca o valor recomendado (tracejado). Clicável → objeto `{label,info,color}`. |
| `chip` | Pílula compacta (item de lista, fato, invariante) com ponto/marca colorida. | `x`, `y`, `label`, `color`, `tone`, `danger`, `icon`, `w`, `info` | `pos()` (centro) | Largura automática pelo texto (cacheada em `inst.hw`) ou fixa (`w`); `danger:true` = linha vermelha (borda/tinta de alerta). Tamanho de tela constante. Clicável → objeto `{label,info,color}`. |
| `shape` | Primitivo declarativo multi-forma: o autor lista formas (círculo, elipse, retângulo, linha, polilinha, polígono, texto e **path SVG**) desenhadas no canvas via `Path2D` cacheado. Autoria rápida sem sair do motor. | `x`, `y`, `scale`, `rotate`, `opacity`, `tint`, `label`, `info`, `shapes` | Sim: `center` + cada forma com `name` | `x,y`=origem do grupo; formas em coords locais; props de NÓ animáveis (`x/y/scale/rotate/opacity/tint`); `fill:"tint"` puxa `n.tint`; `path` precisa de `bbox` p/ entrar em bounds/hit/anotação. Detalhe completo abaixo. |
| `browserIcon` | Navegador em monitor FLAT para fluxos web e cliente-servidor. | `x`, `y`, `scale`, `color`, `screenColor`, `stroke`, `textColor`, `label`, `info` | `screen`, `stand` | Desenho Canvas 2D imperativo; `x/y` são o centro da tela. |
| `serverIcon` | Rack de servidor FLAT com três unidades e indicadores de estado. | `x`, `y`, `scale`, `color`, `panelColor`, `stroke`, `textColor`, `label`, `info` | `rack`, `status` | Desenho Canvas 2D imperativo; apropriado para infraestrutura e APIs. |
| `dbIcon` | Banco de dados em cilindro FLAT para persistência e consultas. | `x`, `y`, `scale`, `color`, `topColor`, `stroke`, `textColor`, `label`, `info` | `storage`, `table` | Desenho Canvas 2D imperativo; sem gradiente, sombra ou profundidade. |
| `httpMsg` | Cartão de ANATOMIA de uma mensagem HTTP (requisição/resposta) em formato-de-fio monoespaçado; 1ª linha (request/status-line) destacada. Cada linha é clicável → painel. | `x`, `y` (centro), `w`, `kind` (`request`/`response`), `title`, `accent`, `lines:[{text,label,info,family?}]`, `shown` | `parts()`: `center/top/bottom/left/right` | `shown` (nº de linhas) = revelação progressiva (animável). `lines[i].family` (#hex) tinge a linha (use na status-line). `hit` devolve `{label,info,color}` da linha clicada. `inst.rows` recomputado por frame — hit usa o último draw. FLAT. |
| `codeGrid` | QUADRO de referência de códigos em colunas por família (ex.: 1xx..5xx); cada coluna = cabeçalho colorido + pilha de chips; cada chip clicável → painel. O "board de tela cheia" do final. | `x`, `y` (centro), `w`, `title`, `colGap`, `shown`, `families:[{tag,name,color,codes:[{n,name,info}]}]` | Não | `shown` (nº de colunas, fracionário = fade por coluna) = revelação progressiva (animável). `hit` devolve `{label:"n · name",info,color}` da célula. `ctx.globalAlpha` MULTIPLICA a opacidade-pai (reveal/hide). Genérico: serve qualquer taxonomia código→significado. FLAT. |
| `layer` | Uma CAMADA/placa de um aparelho, para VISTA EXPLODIDA. Renderiza FLAT (barra vista de frente) ou ISO (placa isométrica flat-shaded: topo + 2 faces sólidas, sem sombra). Centro interpola montado→explodido por `lift`. | `asmX,asmY`, `expX,expY`, `lift` (0..1 animável), `w`, `h`, `thickness`, `iso`, `label`, `sublabel`, `icon`, `color`, `accent`, `info` | `pos()` (centro atual via `VXK.liftCenter`), `bounds()` | Rótulo-pílula à direita aparece ao explodir (leader ancorado na aresta). hit POLIGONAL no iso. Para conceitos ABSTRATOS (camadas). Não posicione à mão — use o perfil `explode`. FLAT. |
| `part` | Uma PEÇA FÍSICA de um aparelho, para VISTA EXPLODIDA de objetos com FORMA (não abstratos). Renderiza uma SILHUETA 2D flat (lista de `shapes`) em coords locais ao centro; mesmo deslocamento/rótulo/clique da `layer`. | `asmX,asmY`, `expX,expY`, `lift`, `shapes:[{kind,...,fill,stroke,strokeWidth,opacity}]`, `artScale`, `label`, `sublabel`, `color`, `accent`, `info` | `pos()` (via `VXK.liftCenter`), `bounds()` (bbox das formas) | `shapes`: rect/polygon/polyline/circle/ellipse/line/path SVG; `fill/stroke` = cor \| `"body"` (cor da peça) \| `"tint"` (accent) \| `"none"`. Para OBJETOS FÍSICOS (keycap, switch, PCB) — o usuário reconhece "o que é o quê". FLAT. |

## `shape` — formas declarativas (detalhe)

**Por quê:** autoria rápida — o autor descreve formas num array em vez de escrever um componente novo; renderiza no canvas existente (câmera pan/zoom/rot, focus-dim, tweens, hit-test, anotações e harness Node continuam valendo). `path` aceita **dados de path SVG** (`M/L/H/V/C/S/Q/T/A/Z`) via `Path2D` **cacheado por string `d`** (constrói uma vez, reusa todo frame).

**Props do NÓ** (`n.<prop>`): `x`, `y` (origem do grupo, em mundo), `scale`, `rotate` (rad), `opacity` (0..1), `tint` (cor `#hex` que preenche formas com `fill:"tint"`), `label`, `info`, `shapes` (array). Todas as 6 primeiras são **animáveis** pelo step engine (`animate`).

**Formas** (`shapes[]`) — campos comuns opcionais em qualquer kind: `fill`, `stroke`, `strokeWidth`, `opacity`, `name`, `info`. `fill`/`stroke` aceitam `"tint"` (usa `n.tint`) ou `"none"`/`null` (sem preenchimento/borda). Coordenadas são **locais** ao nó.

| kind | campos | notas |
|---|---|---|
| `circle` | `cx`, `cy`, `r` | disco. |
| `ellipse` | `cx`, `cy`, `rx`, `ry` | elipse alinhada aos eixos. |
| `rect` | `x`, `y`, `w`, `h`, `rx`? | `rx` = raio de canto (cantos arredondados). |
| `line` | `x1`, `y1`, `x2`, `y2` | só traço (sem fill). |
| `polyline` | `points:[[x,y],…]` | aberta; só traço. |
| `polygon` | `points:[[x,y],…]` | fechada; preenchível. |
| `path` | `d:"M…"`, `bbox:[x,y,w,h]`? | **path SVG** via `Path2D` cacheado. Sem `bbox` a forma **não** entra em bounds/hit/anotação (Path2D não expõe bounding-box). |
| `text` | `x`, `y`, `text`, `size`?, `font`? (família), `align`?, `baseline`? | fonte escala com o nó (`size/zoom`); default `size:14`, família `Segoe UI`. |

**Traços/tipografia:** `strokeWidth` fica em tamanho de tela via `1/(zoom·scale)`; a fonte do `text` escala com o nó via `size/zoom`. FLAT: fills sólidos + traços finos (sem sombra/glow/3D).

**`parts()`** (âncoras de anotação, em mundo): `center` (centro do bounding-box do grupo) + uma âncora por forma que tenha `name`. Ex.: `annotate:[{target:"casa", …}]`. Sub-formas nomeadas também respondem ao clique (hit) devolvendo seu próprio `{label:name, info}`; fora de uma sub-forma nomeada, o grupo inteiro devolve `{label:n.label, info:n.info}`.

**Animação (limites):** anime pelo **transform/opacity/tint do nó** (`animate:{ demo:{ x, y, scale, rotate, opacity, tint } }`) ou revelando/ocultando nós de forma entre passos (`reveal`/`hide`). **Não há morphing interno** de path — a forma é forma; movimento fino é feito por transform de nó ou por troca de nós.

## Auto-layout (dagre no build) — declare relações, não coordenadas

Para **grafos/fluxos** (o maior custo de autoria: posicionar dezenas de nós à mão), o autor **não escreve `x/y` nem `x0/y0/x1/y1`**. Declara os nós e as **relações**, e o build (`kit/lib/layout.mjs`, via `@dagrejs/dagre`) calcula as posições e **gera as setas**. É **build-time e offline**: o dagre roda no Node e **não vai um byte para o HTML**.

```jsonc
{
  "layout": { "rankdir": "LR", "nodesep": 60, "ranksep": 110 },  // opt-in; LR|TB|RL|BT
  "nodes": [
    { "type":"box", "id":"a", "label":"A", "flat":true },        // SEM x/y
    { "type":"box", "id":"b", "label":"B", "flat":true }
  ],
  "relations": [
    { "from":"a", "to":"b", "label":"opcional", "dashed":true }   // vira uma seta assada
  ]
}
```

| Regra | Detalhe |
|---|---|
| **Opt-in** | Só age se existir `spec.layout`. Sem ele, o spec fica **intocado** (backward-compat). |
| **Posições** | `dagre` devolve o centro de cada nó (= convenção VXK `x/y`), centralizado em `(0,0)`. |
| **Fit** | `fit-scaling` encolhe posições **e** tamanhos p/ caber em zoom 1 (opt-out `layout.fit:false`). Padrão cabe em ~900×520 de mundo. |
| **Arestas geradas** | Uma por `relations[]`. Nascem **sem `id`** → sempre visíveis (não são ocultadas pelo `reveal` por-passo). Tipo padrão `arrow` (use `layout.edgeType:"edge"` p/ grafo com glow). Campos: `label`, `dashed`, `color`, `info`. |
| **Dimensões** | Default por tipo (box 150×70, graphNode 2r, card 230×130, ícones 150×120). Sobrescreva com `n.w/n.h` p/ o dagre reservar espaço certo. |
| **Setas explícitas** | Um nó `arrow`/`edge` com `from`/`to` (e `id`) também é resolvido — útil quando você quer revelar a aresta progressivamente. |
| **`fixed:true` / `pin`** | Nó marcado assim é **ignorado** pelo layout (fica onde você pôs). Decoração (`banner`, `frame`) é ignorada por padrão. |

**Quando usar:** grafos, DAGs, pipelines, fluxos cliente-servidor, árvores. **Quando NÃO:** cenas com geometria física precisa (motor, órbitas, folha) onde a posição É o conteúdo — aí `x/y` explícito manda.

**Verificação:** o harness lê o spec cru (sem rodar o layout). Para verificar um spec de auto-layout, **asse as coordenadas primeiro** (`applyAutoLayout` → grava um `_baked.json`) e rode o `verify.js` nele. E confirme o desenho por **pixel real** — o harness não pega bug de visibilidade de aresta.

## Story mode (auto-coreografia) — declare o fluxo, o build anima

Para **explicar um processo/fluxo passo a passo**, o autor **não escreve `scenes`/`steps`/`camera`/`reveal`/`focus`**. Declara `story:true` + os nós + `relations` + **uma frase (`say`) por nó**; o build (`kit/lib/story.mjs`) gera a coreografia inteira: walk topológico, revelação **cumulativa** (build-up), câmera focando cada nó, spotlight no atual, e um passo final de recap. `story` **auto-liga o auto-layout** (posiciona os nós). É build-time e offline.

```jsonc
{
  "story": { "rankdir": "LR", "focusZoom": 1.7 },   // opt-in; auto-liga o layout
  "narrate": true, "voice": "vits-piper-pt_BR-faber-medium",
  "intro": "Overview falado no início.",
  "outro": "Recap falado no passo final.",
  "nodes": [
    { "type":"box", "id":"a", "label":"A", "flat":true, "say":"Frase narrada quando o passo do A entra." },
    { "type":"box", "id":"b", "label":"B", "flat":true, "say":"Frase do B." }
  ],
  "relations": [ { "from":"a", "to":"b" } ]
}
```

| Campo | Efeito |
|---|---|
| `story:true` \| `{...}` | Liga a auto-coreografia. Opções: `rankdir`, `focusZoom` (padrão 1.8), `fitZoom` (recap; padrão = zoom de **preenchimento** calculado do bbox), `wrap` (true/nº de colunas — serpentina 2D; auto p/ cadeias lineares ≥7 nós, preenche a tela em vez de virar fila fina), `pop` (entrada dos nós, padrão on), `cicloTitle`, `annotSide`. |
| `nodes[].say` | Narração daquele passo (assada pelo motor). Sem `say`, o passo entra mudo. |
| `nodes[].tag` | (Opcional) rótulo curto anotado no nó naquele passo (`tagSide`, `tagColor`). Padrão: sem anotação. |
| `intro` / `outro` | `intro` = áudio de abertura; `outro` = narração do passo de recap. |
| Ordem dos passos | Topológica (Kahn) a partir de `relations`; ciclos/sobras caem na ordem declarada. |
| Arestas | Reveladas junto do nó-alvo (quando as duas pontas já apareceram) — no story mode a aresta ganha `id`. |

**Quando usar:** processos, fluxos, pipelines, protocolos — qualquer "explique X passo a passo". **Quando NÃO:** cena com geometria física/instrumentada (motor, órbitas, folha) ou coreografia não-linear (ex.: lentes do jaco-peniel) — aí escreva `scenes` à mão. Se o spec já tiver `scenes`, o story mode não age.

**Verificação:** asse layout+story num `_baked.json` e rode o harness. Para ver os passos por **pixel real** em CDP, force o foco (`Emulation.setFocusEmulationEnabled{enabled:true}` + `Page.bringToFront`), senão `document.hidden` congela o canvas no passo 0.

## Tema (marca do cliente) — importe do PowerPoint/HTML/tokens

Uma apresentação pode nascer **na identidade visual do cliente**. O autor aponta um arquivo-modelo e o build extrai o tema (cores + fontes) e restila a saída (canvas **e** board). É build-time e offline.

```jsonc
{ "themeFrom": "./marca-cliente.pptx" }   // OU um objeto direto:
{ "theme": { "accent": "#E94560", "bg": "#0F1020", "text": "#eef3ff", "fontHead": "Montserrat", "fontBody": "Open Sans", "accents": ["#E94560","#0F3460", "..."] } }
```

| Fonte | Como extrai | Precisão |
|---|---|---|
| **`.pptx`** (recomendado) | descompacta o OOXML e lê `ppt/theme/theme1.xml`: `clrScheme` (accent1-6, fundo, texto) + `fontScheme` (título/corpo) | **Exata** (legível por máquina, sem chutar) |
| `.html`/`.htm` | variáveis `:root` (`--accent`/`--primary`/`--bg`…) + `font-family`; fallback = cores hex mais citadas | Boa |
| `.json` (design tokens) | mapeia `accent`/`bg`/`text`/`fonts.*` | Exata |

`kit/lib/theme-import.mjs` (dep build-time `fflate`) faz a extração; `build-artifact.mjs` injeta um `<style>` de override (`--vxk-accent`, `--vxk-bg`, `--vxk-panel`, fontes). **Catálogo com preview:** `node build-catalog.mjs [pasta-com-modelos] [saida.html]` gera uma galeria offline com 6 presets FLAT + os temas importados da pasta (`.pptx/.html/.json`), cada card com prévia fiel do shell VXK + paleta + fontes + botão "Usar este tema" (copia o bloco `theme`). **Cobertura:** rebranda **accent, fundo, fontes E a cor default dos `box`** (nós sem `color` recebem a superfície do tema + borda no accent). **Fontes embutidas no `.pptx`** (`ppt/fonts/*.fntdata`) são extraídas e viram `@font-face` base64 — a marca renderiza **offline** mesmo sem a fonte instalada; se o deck não embarcar a fonte, cai no nome + fallback de sistema (limite físico: não dá pra embutir bytes que o arquivo não tem). Sem `themeFrom`/`theme`, nada muda (backward-compat).

## Design system compartilhado (`mat`) — tokens, tipografia, card, easing

Aplicado da **pesquisa de design** (Ciechanowski, Nicky Case, Red Blob, Distill / Vercel, Stripe, Linear, Primer / M3, IBM Carbon, Apple HIG, Kurzgesagt). Relatórios completos em `files/design-research-{explorables,product-docs,motion}.md`. Todos os helpers vivem em `VXK.mat` (env `e.mat`) e são reusados pelos átomos — **não reescreva tint/hairline/tracking à mão**:

| Helper | O que faz | Use em |
|---|---|---|
| `mat.ds` | Tokens: `text.{primary,secondary,muted}`, `hairline`, `cardIdle/cardSel`, `radius`, `roles{stepTitle,cardTitle,cardBody,sublabel,chip,micro,value}` (`[px de tela, weight, letter-spacing, UPPER?]`). | Cores/roles em qualquer componente. |
| `mat.type(ctx,role,zoom)` | Seta `ctx.font` **+ `ctx.letterSpacing`** do papel, em px de tela (÷zoom). Títulos com tracking negativo; micro-labels UPPERCASE com tracking positivo — **o maior “tell” premium**. | Todo texto de componente. |
| `mat.label(s,role)` | UPPERCASE se o papel pede (ex.: `micro`). | Badges/micro-labels. |
| `mat.card(ctx,L,T,w,h,{zoom,fill,stroke,selected,accent,accentBar,accentTop,radius})` | Superfície canônica FLAT: **tint 1 passo acima do fundo + hairline 1px + radius**; barra/faixa de accent (inset, sem `clip`); estado selecionado (borda branca). | `box`, `deviceCard`, cards novos. |
| `mat.iconChip(ctx,cx,cy,size,icon,accent,zoom)` | Ícone Lucide dentro de **container arredondado tintado** + stroke consistente (~1.5px de tela). | Cabeçalho de card. |
| `mat.ease` / `mat.bez(x1,y1,x2,y2)` | Presets de easing por PROPÓSITO: `ENTER (.2,0,0,1)`, `MOVE (.4,0,.2,1)`, `POP (.2,0,.38,.9)`, `EXIT`. **Nunca `linear` em UI.** | Animações próprias. |

**Defaults de movimento do step engine (grátis, sem tocar no spec):** câmera com ease-in-out (`MOVE`); reveal/dim com `ENTER`; **foco/dim a ~20% visível** (inativos escurecem forte — spotlight); **scale-pop de entrada** (0.9 → ~1.03 → 1.0) com **stagger de 45ms** por nó revelado (respeita `prefers-reduced-motion`; conectores x0/x1 não “pulam” — sem centro, sem pop). **Faixa de accent 3px no topo do stage** (por `spec.accent`, ou por passo via `step.accent`). **Painel** com divisor sob o título e corpo em cor secundária. **Guarda:** o core zera `ctx.letterSpacing` antes de cada nó — se um componente setar tracking, **resete no fim** (`ctx.letterSpacing='0px'`).

**Auto-enquadramento (`spec.autoframe:true`) — preenche a tela, aproveita o zoom.** Liga por spec: cada passo calcula a câmera para **encaixar o conteúdo que o passo revela/foca** na tela (margens: topo 13,5% p/ o título, laterais 5,5%, base 11%; zoom clampado 0.4–1.75). **Ignora `camera` autorada** (não precisa mais escolher zoom/cx/cy à mão) e **exclui conectores** (flowPipe/arrow, sem centro) do bbox — senão eles esticam o enquadramento. Escape por passo: `step.fit:false` (mantém a `camera` explícita). Para medir bem componentes grandes, exponha `bounds(n,e)` → `[x0,y0,x1,y1]` (ex.: `httpMsg`, `codeGrid`); os demais são estimados por `x/y/w/h` ou `x0/y0/x1/y1`. **Use em fluxos que trocam conteúdo por passo com `hide`** (o enquadramento segue o passo). **Não** combine com story mode (que já tem câmera por nó) nem com física de câmera precisa.

## Geometria compartilhada (`VXK.geom`) — reuse, não reimplemente

`kit/lib/geom.mjs` é a **fonte única** de geometria pura (sem canvas/IO), inlinada pelo builder como `window.VXK.geom` (após o core, antes dos componentes) **e** importada no Node pelo builder (ex.: `explode.mjs`). Antes havia 3 cópias (bbox em `part.js`+`explode.mjs`, ray-cast em `shape.js`+`layer.js`) — agora **um lugar só**:

| Helper | O que faz | Use em |
|---|---|---|
| `VXK.geom.pointInPoly(pts,x,y)` | Ray-cast even-odd (contenção em polígono). | Qualquer hit-test de forma poligonal. |
| `VXK.geom.shapeBounds(sh)` | Bounds locais `[x0,y0,x1,y1]` de UMA forma (circle/ellipse/rect/line/poly/text/path) ou `null`. | bounds/âncora por forma. |
| `VXK.geom.shapesBBox(shapes,{minExtent,empty})` | bbox agregada; `minExtent` dá corpo mínimo a peça fina; `empty` = fallback quando nada contribui. | enquadrar peças (`part`, `explode`). |

**Nunca reescreva bbox/point-in-poly à mão** num componente novo — chame `VXK.geom` (equivalência das 3 cópias antigas provada: 22/22 bbox, 882/882 pontos).

## Ícones (Lucide) — glifos semânticos no canvas

`kit/lib/icons.js` (inlinado pelo builder, **offline**) traz `VXK.drawIcon(ctx, nome, cx, cy, size, cor, strokeWidth)` + `VXK.hasIcon(nome)`, com ~60 ícones **Lucide (ISC)** desenhados via `Path2D` (stroke FLAT 24×24, sem preenchimento). Regenerar/ampliar o conjunto: um gerador build-time baixa os SVGs do Lucide e emite o dict inlinado (rede só no build; saída offline). Nomes disponíveis incluem: `server database cpu cloud globe wifi network monitor smartphone code terminal lock lock-open key shield link mail send download upload folder file-text users user credit-card package git-branch git-merge git-pull-request workflow layers box search eye zap activity clock settings refresh-cw repeat circle-check circle-x triangle-alert info bell rocket bug` (e mais). Use em `box.icon` (card rico) ou em qualquer componente novo via `VXK.drawIcon`. **Por que importa:** a pesquisa de explainers (Ciechanowski, Stripe, Distill) mostrou que o que separa "rico" de "rústico" é **semântica**, não polish — um glifo de banco num cilindro **não é uma caixa**.

## Vista explodida (`spec.explode`) — perfil "desmontar em camadas"

Como o *story mode*, o autor declara **só o conteúdo** e o build gera a coreografia. Ideal para "como funciona um aparelho/pilha em camadas" (teclado mecânico, pilha de rede, bateria, motor por camadas). Opt-in via `spec.explode` (bool ou objeto de config). **Flag `iso` por explicação** (decisão do dono: os dois modos):

```jsonc
{
  "engine":"vxk", "narrate":true, "voice":"...", "accent":"#5b8cff",
  "device":"Teclado montado",          // título do 1º passo (montado)
  "intro":"...", "outro":"...",          // narração do montado e do remonta
  "explode": { "iso": true },            // true|false OU {iso,w,h,thickness,asmGap,expGap,...}
  "layers": [                            // ORDEM = topo → base
    { "id":"keycaps", "label":"Keycaps", "sublabel":"as teclas", "icon":"box",
      "color":"#4a6f7a", "tag":"você toca aqui", "say":"frase narrada desta camada" },
    { "id":"switches", "label":"Switches", "icon":"zap", "say":"..." }
    // ...
  ]
}
```

O build (`kit/lib/explode.mjs`) gera os nós `layer` (empilhados no eixo vertical) e os passos: **montado** (reveal, `lift`=0) → **desmontar** (anima `lift` 0→1 de todas) → **uma etapa por camada** (câmera navega + `focus` + `annotate` + narra; as demais seguem explodidas e esmaecidas) → **remontar** (`lift`→1→0). **Câmera calculada no build** (viewport nominal) + `fit:false` — não usa `autoframe`. Camadas **clicáveis** (painel). **Não** combine com `story` (ambos geram `scenes`; explode tem precedência). `iso:false` = barras planas empilhadas (corte); `iso:true` = placas isométricas flat-shaded (mais parecido com os sites de exploded-view), sem 3D/sombra. Defaults por camada: cor de uma paleta, `w/h/thickness/gaps` do modo (override em `explode.{...}`).

**Abstrato vs FÍSICO (regra dura):** o modelo em **placas** (`layer`, com ícone) é ótimo para **conceitos abstratos** (TCP, HTTPS, pilha de rede) — não há forma física a trair. Para **objetos com FORMA** (teclado, tecla, motor), placa abstrata fica ruim: o usuário não liga "o que é o quê". Aí dê a cada camada uma **silhueta 2D real** via `shapes` (vira um nó `part`): o build usa `part` no lugar de `layer` e enquadra pela forma. Não precisa ser 100% fiel — precisa ter a **semântica do corpo** (keycap parecendo keycap, mola parecendo mola). Fonte das formas: **vetor desenhado** (offline, sem licença, estilo consistente, explode limpo) — **não** imagem raster. Exemplo:

```jsonc
"explode": { "asmGap": 72, "expGap": 152 },   // físico: peças desenhadas centradas; asmGap empilha, expGap separa
"layers": [
  { "id":"keycap", "label":"Keycap", "sublabel":"a tecla", "color":"#5b7fa6", "say":"...", "tag":"seu dedo aqui",
    "shapes":[ { "kind":"polygon", "points":[[-58,-30],[0,-22],[58,-30],[78,30],[-78,30]], "fill":"body" } ] },
  // ... haste (cruz), corpo (housing), mola (polyline coil), pcb (rect + pads)
]
```

Demos: `specs/teclado-mecanico.json` (iso, placas), `specs/camadas-rede.json` (flat, placas — pilha TCP/IP), `specs/tecla-mecanica.json` (**físico, shapes** — keycap/haste/corpo/mola/PCB).

## Como manter vivo

1. Consulte este catálogo antes de escrever o spec.
2. Prefira combinar componentes existentes com `camera`, `reveal`, `focus`, `annotate` e `animate`.
3. Se faltar uma forma, crie **um** componente novo, geral e paramétrico em `kit/components/<type>.js`, mantendo fills sólidos e traços finos.
4. Documente o novo componente nesta página no mesmo formato: propósito, props, `parts()` e opções.
5. **Reuso-primeiro:** antes de criar QUALQUER coisa, procure em `VXK.mat` (tint/card/type/ease), `VXK.geom` (bbox/hit) e `VXK.drawIcon` (glifos). Componente novo **só** quando nenhuma combinação serve — e então geral/paramétrico.
6. **O build garante a voz:** a narração é assada com **cache** (`kit/lib/tts_cache.mjs`, chave `sha256(motor+voz+formato+texto)` em `~/.cache/vxk-tts`) — rebuild idêntico é ~instantâneo; trocar voz/motor invalida sozinho (`VXK_NO_CACHE=1` desliga). Um **gate de áudio** falha o build se a spec quer narração mas o HTML sai sem clipe real (escape: `VXK_ALLOW_SILENT=1`). O engine `konva` ainda **não** reproduz narração — use `vxk` (padrão) para explicações faladas.
