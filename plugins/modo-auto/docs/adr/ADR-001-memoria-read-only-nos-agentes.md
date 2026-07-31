# ADR-001 — Memória nos agentes da mesa: leitura escopada, nunca escrita

- **Status:** aceito
- **Data:** 2026-07-31
- **Versões que implementam:** v0.4.1, v0.4.2, v0.4.6, v0.4.8, v0.4.9, v0.5.1
- **Onde este arquivo vive:** no repositório e **dentro do pacote publicado** (`package.json > files` inclui
  `docs`), de propósito: uma decisão de produto que só existe no `session-state` de uma máquina volta a ser
  "oral" para qualquer outra sessão, runtime ou pessoa. Foi essa exata crítica que motivou promovê-la para cá.

## Contexto

Os papéis da mesa (ADR, dev, mesa viva, escopo, autônomo, sombra) rodam como **processos separados** — workers
com `configDirectory` isolado em `~/.modo-auto/worker-config`, sem nenhum plugin instalado. Medição: o diretório
`installed-plugins/` está vazio, um worker vivo responde `SEM-MEMORIA`, e a inspeção do manifesto real de 8
papéis (`selftest/tool-manifest-live-smoke.mjs`) confirma que nenhuma tool de acesso a memória chega a eles.

Hoje quem fala com a memória é **só o processo pai** (a extensão, dentro da sessão), que faz o `recall` e injeta
o texto no prompt do worker.

**Erro de enquadramento que este ADR corrige:** essa ausência de memória foi medida e apresentada como se fosse
a decisão certa ("não há risco porque não há capacidade"). Não é. É apenas o **estado atual**. Medir o presente
e vendê-lo como decisão é um jeito sutil de não fazer o que foi pedido.

## Decisão

O alvo é **memória escopada de LEITURA**, não cegueira.

1. **Adaptador, não dependência.** A memória vem do plugin `copilot-memory`, que é outro produto. Sem ele, o
   modo-auto funciona igual. Nada no fluxo pode exigir memória para operar.
2. **Leitura sob demanda.** Quando o plugin/daemon existir, os papéis que investigam ganham busca semântica
   durante o próprio raciocínio — não só o que o pai adiantou no prompt.
3. **Escrita NUNCA.** O worker não salva, não edita, não apaga. Isso é garantido por **ausência de capacidade**
   (a tool não existe no manifesto dele), não por instrução no prompt.
4. **Memória é material contestável, não contexto passivo.** Um auditor read-only julga cada item recuperado
   (`aplica` / `desatualizado` / `nao_se_aplica`), com `razao` obrigatória e citando o `doc_id`. Citação que não
   corresponde a um item realmente injetado é descartada — senão "citar a fonte" seria teatro.
5. **O `project_id` é CRAVADO PELO PAI** na injeção da tool. O filho não resolve escopo e não olha o próprio
   `cwd`. Desenho do dono, textual: *"dá pra injetar a ferramenta já com o project_id cravado; e aí o agente que
   for usar a leitura de memória não vai precisar passar o dele, ou pegar o CWD dele — isso não existe"*.

## Contrato de escopo (`project_id`)

Fiel a `copilot-memory/lib/projectId.mjs` — o plugin é o **dono** do contrato; aqui só se reusa a mesma regra.
Duas rungs e um erro:

1. marcador `.memory/project.json` achado subindo até a raiz do projeto (âncoras: o próprio dir → git toplevel →
   repo base). Worktree e subpasta convergem no MESMO id;
2. `git remote origin` normalizado (`host/owner/repo`), portável entre máquinas;
3. nada disso → **lança**, com o conserto na mensagem.

Os fallbacks de caminho absoluto / nome-de-pasta / `git-common-dir` como id foram **removidos de propósito**:
eram a fonte do escopo-lixo (`C:\`, `Temp`, `AppData` virando "projeto"). Existe ainda um piso
(`assertSafeProjectId`) que recusa qualquer id com cara de caminho.

### Validação medida (não é suposição) — `selftest/memory-validator-smoke.mjs`

| cenário                                | resultado                             | rung       |
|----------------------------------------|---------------------------------------|------------|
| monorepo com remote, raiz              | `github.com/acme/mono`                | git-remote |
| monorepo com remote, subpasta funda    | `github.com/acme/mono` (converge)     | git-remote |
| repo local sem remote e sem marcador   | **lança**, com o conserto na mensagem | none       |
| sem remote, com marcador, raiz         | `acme/monorepo`                       | declared   |
| sem remote, com marcador, subpasta     | `acme/monorepo` (converge)            | declared   |
| worktree de repo com remote            | `github.com/acme/mono` (= repo base)  | git-remote |

Ou seja: o fail-loud **não** bloqueia monorepo, subpasta funda nem worktree — todos convergem. O único caso que
lança é repo sem remote **e** sem marcador.

## Público-alvo (decidido, não é questão aberta)

**Público.** O modo-auto é distribuído na vitrine, junto com os outros plugins do autor — qualquer pessoa com o
GitHub Copilot instala. O projeto do usuário pode ser Java, Rust, Go, Python, ou nem ter stack definida.

**Isso NÃO muda nada aqui, e supor que mudava foi erro meu.** A regra é a mesma para todo mundo, e é simples:

| tem o plugin de memória? | a sessão mãe tem `project_id`? | resultado |
|---|---|---|
| não | — | sem memória. O modo-auto funciona igual (adaptador, não dependência) |
| sim | não resolve | sem memória, com a mensagem que diz como resolver |
| sim | resolve | usa esse id, ponto |

Quem resolve o `project_id` é o **plugin de memória**, que já tem a estrutura pronta (marcador declarado ou git
remote). Se o usuário tem o plugin, ele tem essa estrutura. O modo-auto não tem opinião sobre isso e não inventa
caminho alternativo: só consome.

E a mesa — ADR, dev, sombra, o que for — **não procura saber disso**. Na hora de montar as tools do worker, a
definição da tool já vai com o `project_id` cravado. O agente não resolve escopo, não olha `cwd`, não recebe
"projeto" como parâmetro que ele possa errar.

## Quem recebe busca, e quem não recebe (decisão, com o histórico da mudança)

A regra é **por declaração do chamador**, não por categoria fixa de papel:

| quem | recebe busca? | por quê |
|---|---|---|
| mesa viva (técnico, negócio, advogado-do-diabo, revisor, pesquisador) | **sim** | o trabalho deles é trazer o que NÃO está no prompt |
| dev e revisor do `modo_dev` | **sim** | quem revisa pode reprovar algo já decidido no acervo sem saber |
| perfis de análise (`modo_reuso`, `modo_seguranca`) | **sim** | deliberam sobre o código-base; sem acervo, repetem conclusão antiga |
| papel com allowlist que **não nomeia** memória | **não** | o chamador declarou que aquele papel só conclui a partir do material dado |
| papel com allowlist que **nomeia** `memory_search` | **sim** | ex.: o auditor de memória — ver abaixo |

**Como isso mudou, e por quê (registro da decisão):** a primeira versão proibia memória em QUALQUER papel
fail-closed, de forma cega — "ele só consolida, não precisa buscar". Três famílias de modelo, em rodadas
independentes, contestaram com o mesmo argumento: *um juiz precisa de MAIS contexto, não menos*. Estavam
certas, e o caso concreto prova: o auditor de memória diz "desatualizado" sobre um item — e, sem busca, ele não
tem como **achar** o que superou aquele item. Aquele veredito era um **julgamento apresentado como
verificação**.

**Decisão:** a allowlist passou a ser a declaração de intenção do chamador. Quem não nomeia, não recebe; quem
nomeia, recebe — e isso fica explícito no código de quem chama, visível em revisão. O auditor nomeia
`memory_search` quando há escopo cravado, e o prompt dele diz por quê: *"sem conferir, 'desatualizado' é
palpite; com isso, é verificação"*. Sem escopo, ele volta a ser text-only puro.

**Critério de reversão:** se o auditor passar a gastar buscas sem melhorar a qualidade dos vereditos (medível
pelo ledger `#MEM`: buscas por auditoria vs. vereditos "desatualizado" que citam o documento superador),
o teto cai para 1 ou a busca sai. A decisão é reversível de propósito — ela mora numa linha (`availableTools`).

**Positivas:** escrita impossível por construção; escopo nunca derivado de caminho; memória auditável (id
citável + veredito justificado); o produto continua funcionando sem o plugin.

## MODELO DE AMEAÇA (declarado, porque sem ele metade deste ADR resolve risco de laboratório)

Quem sofre a dor, hoje: **o próprio dono, numa máquina só, com múltiplos projetos**. A falha real e medida é
**contaminação por engano** — a mesa de um projeto lendo/citando o acervo de outro, o que produz plano errado com
cara de plano informado. Foi isso que aconteceu de verdade nesta sessão, duas vezes.

**O que este ADR NÃO resolve, e é preciso dizer alto:**

**NÃO HÁ AUTORIZAÇÃO SERVER-SIDE.** O daemon confia no `project_id` que o cliente manda. **Medido** (não
suposto): um cliente qualquer, apontando para o daemon local, que peça explicitamente o `project_id` de outro
projeto **recebe o dado** — e também **consegue apagá-lo**. Não existe token→projetos-permitidos.

Portanto, corrigindo uma afirmação minha anterior que estava **ERRADA**: o que os testes provam é **filtro por
igualdade** (o daemon corta por `project_id`, não é sorte do ranqueador) e **higiene interna** (o agente não
escolhe escopo, não resolve pelo próprio cwd, não aceita escopo não-assinado). Isso é **prevenção de engano**,
não **fronteira de segurança**. Chamei isso de "isolamento cross-project provado" e a palavra estava grande
demais.

Consequência prática do modelo de ameaça: as camadas de assinatura/env deste ADR só importam contra um chamador
**interno** confuso — se um atacante já controla o processo pai, ele já controla tudo, inclusive o segredo. Elas
NÃO viram defesa multi-tenant, e o produto **não deve ser usado como se fossem**. Um cenário multi-tenant real
exige authz no daemon (outro produto, `copilot-memory`), e está fora do alcance do modo-auto.


**Isolamento MEDIDO (leia junto com o modelo de ameaça acima — isto é filtro, não autorização)** —
`selftest/memory-cross-project-leak-smoke.mjs`, contra o daemon real: dois projetos distintos no MESMO store,
textos quase idênticos e uma query que casa com ambos.

| asserção | resultado |
|---|---|
| A enxerga o documento de A (presença antes da ausência) | ok |
| B enxerga o documento de B | ok |
| busca de A **não** devolve o documento de B | ok |
| busca de B **não** devolve o documento de A | ok |
| sem filtro o daemon devolve **os dois**; com filtro, só o do escopo | ok — o corte é **server-side** |
| escopo inexistente devolve **vazio** (não "o mais parecido") | ok |
| o documento certo vem **à frente** do distrator (relevância) | ok |
| cliente que PEDE explicitamente outro `project_id` | **RECEBE O DADO** — não há authz (medido) |

A quinta linha responde "o filtro é do servidor ou é sorte do ranqueador?": se fosse só ranqueamento, o
documento do vizinho — semanticamente ótimo para a query — apareceria. Não aparece.
A **última** linha é a que corrige o exagero: o corte existe e funciona **para quem pede o próprio escopo**.
Quem pede o alheio recebe. Filtro ≠ fronteira.

**Negativas / limites conhecidos, registrados sem maquiar:**

- `project_id` **errado** não é `project_id` **vazio**: fork, mirror, submodule, `origin` vs `upstream`, ou um
  marcador desatualizado produzem escopo divergente em **silêncio**. O fail-loud só cobre o vazio.
  **Mitigações entregues:** (a) ledger de acesso no stderr do worker (`#MEM papel leu N trecho(s) do escopo Z`);
  (b) `detectarEscopoSuspeito()` reconhece **submodule** por sinal NATIVO do git
  (`--show-superproject-working-tree`, o próprio git afirmando a relação) e **espelho/artefato aninhado**
  (o diretório não tem nada rastreado, mas o repo que responde por ele tem — é a causa-raiz do falso positivo
  "o código está numa versão antiga" que se repetiu ~6 vezes); (c) o status curto viaja no RESULTADO das tools;
  (d) o **caller não consegue mais apontar o agente para outro projeto**: `memoryScope` deixou de ser parâmetro
  de `factory.run()` e passou a vir do provider injetado na criação da factory. Não é regra a respeitar, é
  argumento que não existe — validar FORMA nunca resolveria, porque `outro/projeto` tem forma perfeita.

  **O que continua SEM cobertura, dito sem maquiar:**
  - **FORK: LIMITAÇÃO CONHECIDA, decidida — não é item aberto.** A detecção depende de existir um remote
    `upstream` diferente do `origin` (convenção do `gh repo fork`), reforçada por `remote.upstream.gh-resolved`
    quando presente. **Git não tem sinal nativo de fork** — fork é conceito de forja, não de git; não existe
    `--show-fork-of`. Quem clona um fork direto, sem adicionar `upstream`, **passa batido**.
    **Decisão: won't-fix por ora**, e o motivo é que a alternativa seria consultar a API do GitHub — o que
    (a) tornaria o resolver dependente de rede e de credencial, num caminho que hoje é local e determinístico,
    e (b) só cobriria GitHub, quebrando para GitLab/Bitbucket/self-hosted.
    **O que existe no lugar:** o dono vê o escopo e a origem no status de toda deliberação, e um marcador
    `.memory/project.json` declarado RESOLVE o caso — o marcador vence o remote. É conserto de uma linha para
    quem sabe que está num fork.
    **Gatilho para reabrir:** se aparecer um sinal local e agnóstico de forja, ou se alguém for mordido na
    prática (memória do fork poluindo o projeto original).
  - **Mirror remoto e marcador desatualizado**: sem sinal. Não há fato medível que os distinga de uso legítimo.
  - **Escopo válido-porém-errado vindo do próprio ambiente** (o dono abriu a sessão na pasta errada): o produto
    avisa qual escopo resolveu e de onde, mas não pode saber que é o errado. Só o humano sabe.

- **Onde o aviso aparece.** O aviso longo vai por `logHost`, que escreve no log da sessão do host — e esse log é
  **invisível numa sessão por voz ou daemon**, que é como o produto costuma ser usado. Por isso existe também um
  status de UMA linha que viaja no **resultado** das tools da mesa. Log é para depurar; resultado é o que o dono
  recebe.
- Monorepo colapsa todos os subprojetos num id só. "Converge" é verdade, mas pode ser escopo **grosso demais**
  quando pacotes internos são produtos distintos.
- Falta observabilidade de acesso ("worker X leu doc Y do projeto Z") e limites operacionais (timeout, teto de
  chunks/tokens, rate limit).
- Falta mitigação de **prompt injection** vinda do TEXTO recuperado, que entra no contexto do modelo.

## Estado de implementação

| item                                                    | versão      | prova                                        |
|---------------------------------------------------------|-------------|----------------------------------------------|
| memória citável (`doc_id` normalizado no port)          | v0.4.1      | `memory-namespace-smoke`                     |
| auditor read-only + anti-citação-inventada              | v0.4.2      | `memory-validator-smoke`, live-smoke com isca|
| resolver `project_id` fail-loud fiel ao plugin          | v0.4.6      | tabela de cenários acima                     |
| inspeção viva do manifesto (8 papéis reais)             | v0.4.8      | `tool-manifest-live-smoke`                   |
| contrato validado fora dos repos do dono                | v0.4.9      | `memory-validator-smoke`                     |
| **tool de leitura no worker com `project_id` cravado**  | **v0.5.1**  | `memory-pinned-scope-e2e-smoke` (one-shot)   |
| **cravação também na mesa viva (o caminho que roda)**   | **v0.5.2**  | `tool-manifest-live-smoke` (liveWorker real) |
| **escopo deixa de ser parâmetro do caller**             | **v0.6.2**  | gate que varre `src/` e quebra o build       |
| **assinatura do escopo (fecha o TRANSPORTE, não só a API)** | **v0.6.4** | `memory-pinned-scope-e2e-smoke` 4/4          |

**Fase 2 ENTREGUE.** O que restava dela (a tool no worker com escopo cravado) está em produção e provado ponta a
ponta nos DOIS binários de worker, em cwd hostil, com o caso negativo de escopo forjado.

### Como a porta foi fechada, em três camadas (cada uma cobrindo o furo da anterior)

1. **API** (v0.6.2): `memoryScope` deixou de ser parâmetro de `factory.run()`. Um caller não pode mais *pedir*
   outro projeto — o argumento não existe. **Furo que sobrou:** o transporte.
2. **TRANSPORTE** (v0.6.4): o job viaja por stdin (one-shot) e por env (mesa viva), e ambos são escrivíveis por
   quem spawna o binário. Agora o escopo vai **assinado** (HMAC com segredo do processo pai, gerado no boot,
   só em memória) e o filho **verifica**. Sem assinatura válida: recusa registrada e worker sem memória.
   Descoberto porque a assinatura derrubou o meu próprio teste E2E — que injetava escopo direto pelo stdin e
   funcionava.
3. **AMBIENTE**: `MODO_AUTO_WORKER_MEMORY_SCOPE` é apagado do env antes de cada spawn, nos dois caminhos — um
   valor velho herdado (de um teste, de um shell, de outra sessão) não vira memória real.

**Limite honesto da camada 2:** um processo que controle o ambiente inteiro pode gerar o próprio par
segredo+assinatura. Essa não é a fronteira de confiança aqui — quem controla o processo já controla tudo. O que
a assinatura fecha é o caso REAL: um chamador interno (outro perfil, outro agente, um teste) injetando escopo
por engano ou por confusão. Aconteceu duas vezes nesta sessão.
