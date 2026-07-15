# copilot-memory

Memória por **projeto** para o GitHub Copilot (app/CLI). O plugin é um **cliente puro** do
servidor de memória **`native-java`**: descobre o daemon local, deriva o `project_id` do
projeto aberto (a mesma escada que o servidor usa) e **consome** o recall. Toda a inteligência
de escopo/hierarquia e a composição do recall são do **servidor** — o plugin nunca decide isso.

## Como funciona

- **Discovery cliente-puro** (`lib/daemon.mjs`): lê `~/.mcp-memory/run/daemon.json`
  (respeita `MCP_RUN_DIR`), faz `GET /health` (200/503 = vivo) e reusa a URL. Daemon offline ⇒ degrada
  com aviso. O plugin **não gerencia** o servidor (singleton, update, auto-anúncio são do native-java).
- **Auto-provisionamento** (`lib/provision.mjs`): se **não houver daemon vivo e o servidor não estiver
  instalado**, o plugin faz o **bootstrap inicial** — baixa a release pública mais nova
  (`AllanSantos-DV/mcp-memory-server-releases`, tag `vX.Y.Z`, asset `mcp-memory-server-*.jar`),
  **verifica o sha256**, sobe `java -jar … --daemon` (destacado) e aguarda o auto-anúncio. Depois disso
  o próprio daemon assume (singleton + updates). É o mesmo padrão do `boot.mjs`/canvas-sync
  (baixa-se-falta, reusa-se-existe). Disparado em background no início da sessão e sob demanda via
  `memory_setup`. Requer **Java 21** no PATH; **fail-open** (sem Java/rede ⇒ degrada, nunca trava).
- **project_id worktree-safe** (`lib/projectId.mjs` + `lib/projectConfig.mjs`): escada determinística —
  **(0) `.memory/project.json` → `metadata.defaults.project_id`** (a intenção declarada, portável entre
  máquinas/pessoas), (1) git remote normalizado, (2) repo base via `git-common-dir` (fecha o furo das
  worktrees), (3) caminho absoluto, (4) nome da pasta. O plugin **honra o `.memory/project.json`** e
  aplica `metadata.defaults` + branch em toda escrita (paridade REST com o servidor). É o que faz o
  plugin ler/escrever no **mesmo escopo** que o servidor entende.
- **Guia de escopo (scaffold asked-once)**: quando o escopo é **frágil** (só caminho/nome, sem
  `.memory/project.json` nem git remote), o plugin sugere **uma única vez** (por workspace) que o agente
  analise a estrutura e crie o `.memory/project.json` (tool `memory_init_project`). Se recusar ou se a
  pasta não for um projeto, ele **não insiste** (marca global em `~/.copilot-memory/`, não suja a pasta).
- **Migração de escopo aprovada** (`lib/migrate.mjs`, tool `memory_migrate_scope`): declarar um
  `project_id` novo muda o escopo **daqui pra frente** — a memória antiga fica carimbada com o id anterior.
  O plugin **detecta** isso (no `memory_init_project` e no painel) e oferece migrar via `PATCH` metadata-only
  (não re-embeda). **Nunca migra sozinho**: previsualiza e só aplica com `confirm:true`. Move só os docs do
  escopo antigo (lições globais ficam), e avisa quando o escopo antigo é **git** (migrar pode deixar a
  memória órfã para quem não tem o `.memory/project.json`).
- **Cliente REST** (`lib/client.mjs`): contratos lidos do código do servidor —
  `search`, `context`, `compose`, `documents` (CRUD), `recent`, `feedback`/`PATCH` (lifecycle),
  `health`. O escopo vai sempre como `metadata.project_id`.
- **Recall passivo two-tier** (`lib/recall.mjs`, hooks): a cada abertura de sessão e a cada prompt,
  chama `compose_recall` do servidor e injeta `additionalContext` **escopado**. Dois níveis
  (validado por pesquisa): **skills = ponteiro** (name+description+id → o agente carrega o corpo sob
  demanda com `memory_get`, progressive disclosure); **conhecimento/fatos = inline** (o chunk direto,
  grounding sem round-trip). Se o `compose` falhar/estourar, cai para `context` escopado (nunca busca
  aberta — não vaza entre projetos).
- **Destilador de aprendizado por AGENTE** (`memory_distill` + `lib/curation.mjs` / `curator.mjs` /
  `transcript.mjs` / `checkpoints.mjs` / `curationLedger.mjs`): fecha o loop de autoaprendizado, em
  **background** no `SessionStart`. Um **agente curador (LLM)** lê a CONVERSA — os checkpoints do Copilot
  (saída já curada) e os turnos vivos, limpos para só `user`+`assistant` (sem ruído de tool/hooks) — e
  extrai lições **de forma SEMÂNTICA** (entende ironia, xingamento, frustração; nada de regex). Captura
  **dois tipos**: técnicas E **comportamentais** (anti-padrões do próprio assistente que o usuário
  criticou). Incremental e idempotente: marca cada checkpoint/bloco por id determinístico (ledger) e
  nunca recura. O curador roda num **node subprocess limpo** (o resolver hook do fork quebraria o SDK).
  Skills de projeto **auto-promovem** (o curador é o gate); segredos são redigidos antes de curar.

## Escopo e isolamento

Toda leitura/escrita carrega `project_id`. A memória de um projeto **nunca** vaza para outro
(isolamento provado E2E). Skills globais estão **desligadas no MVP** (apenas projeto). A hierarquia,
a composição do recall e o reforço/poda (telemetria, Sweeper, Dreaming) são do **servidor** — o
plugin não recria nada disso.

## Tools

| Tool | O que faz |
|------|-----------|
| `memory_status` | Daemon vivo? URL/versão + `project_id` do projeto aberto. Não altera nada. |
| `memory_dashboard` | Abre o **painel (canvas)** lateral: saúde do daemon, escopo (com a escada do `project_id`), documentos recentes, skills e telemetria de recall. Só leitura. |
| `memory_setup` | Provisiona o servidor se ele não existir: baixa a release (verificada por sha256), sobe e aguarda anunciar; se já existir, reusa. Bootstrap inicial. Requer Java 21. |
| `memory_init_project` | Cria o `.memory/project.json` (project_id estável e portável) analisando a estrutura do projeto. `skip:true` registra "não sugerir aqui". Não sobrescreve. Ao criar, **sinaliza** se há memória sob o escopo antigo (para migrar). |
| `memory_migrate_scope` | Reatribui documentos de um `project_id` antigo para o novo via PATCH metadata-only (não re-embeda). **Sem `confirm:true` só previsualiza**; nunca move lições globais; avisa quando o escopo antigo é git (risco de órfão). |
| `memory_search` | Busca semântica **escopada** na memória do projeto. |
| `memory_recent` | Lista os documentos mais recentes do projeto (escopado). |
| `memory_get` | Recupera o conteúdo completo de um documento por id (drill-down do ponteiro). |
| `memory_save` | Salva conhecimento/decisão/nota carimbando `project_id`. |
| `memory_distill` | **Destilador (curadoria por agente):** força AGORA a curadoria dos checkpoints/turnos não processados. Um curador LLM lê a conversa e extrai lições técnicas E comportamentais, semanticamente. Já roda em background no SessionStart. |
| `memory_skill_guide` | Retorna o guia de autoria de skill (formato PT+EN, What/When/Do/Don't, regras da description, pitfalls). |
| `memory_save_skill` | Salva uma skill (name/description PT + corpo EN) como **candidate**; aceita `evidence[]`; dedup prévio + ledger anti-duplicação. |
| `memory_promote_skill` | Promove candidate → **active** (só então entra no recall). Gate de qualidade. |
| `memory_invalidate_skill` | Caminho de saída para skill errada/desatualizada: `feedback(wrong)` (lifecycle ADR-016) — sai do recall **preservando os bytes** (auditável). Protege conteúdo humano. |
| `memory_list_skills` | Lista skills (candidate + ativas) do projeto — revisar/promover/invalidar sem duplicar. |

**Hooks** (`onSessionStart`, `onUserPromptSubmitted`): injetam o recall two-tier escopado.
`COPILOT_MEMORY_DISABLE=1` desliga o recall passivo sem desinstalar.

## O formato de skill

Uma skill é **um documento de memória** (`type:"skill"`), não uma pasta `SKILL.md`. O servidor só
embeda o `content`, então o `content` = **PT (name+description) no topo + corpo EN**. Assim o gatilho
em PT casa com a busca em PT e o corpo EN é o payload reusável. Seções fixas do corpo:
`## What` · `## When to use` · `## Do` · `## Don't` (+ `## Example` opcional). A **description é o
gatilho do recall** (a skill volta como ponteiro), então ela precisa carregar o "quando usar" — e o
"quando **não** usar" (anti-disparo). Ciclo: `candidate → promote → (invalidate)`.

## Arquivos

```
plugin.json        metadados + "extensions":["."] + hooks
hooks.json         SessionStart → node boot.mjs (espelha o plugin p/ ~/.copilot/extensions via canvas-sync)
boot.mjs           bootstrap do canvas-sync (padrão da vitrine)
extension.mjs      entrypoint: joinSession({ tools, canvases, hooks }) — 15 tools + painel + 2 hooks
lib/daemon.mjs     discovery + health (cliente-puro)
lib/provision.mjs  auto-provisionamento do server (bootstrap: baixa+verifica+sobe; fail-open)
lib/projectId.mjs  resolver worktree-safe (.memory/project.json → git → path; força do escopo)
lib/projectConfig.mjs  lê o .memory/project.json (project_id declarado + defaults/branches)
lib/scaffold.mjs   guia de escopo asked-once (nudge 1×, marca global, template do project.json)
lib/client.mjs     cliente REST do daemon
lib/recall.mjs     compose_recall two-tier + fallback context escopado
lib/skill.mjs      formato/validação de skill (PT header + EN body)
lib/skillGuide.mjs guia de autoria (memory_skill_guide)
lib/transcript.mjs limpeza estrutural (só user+assistant) + agrupamento em blocos
lib/checkpoints.mjs leitura dos checkpoints do Copilot (saída já curada)
lib/curationLedger.mjs rastreio incremental por id (não recura)
lib/curator.mjs    curador LLM num node subprocess limpo (+ curatorWorker.mjs)
lib/curation.mjs   orquestra a curadoria (checkpoints + turnos vivos)
lib/redact.mjs     redação de segredos/PII antes de curar
lib/ledger.mjs     ledger anti-duplicação (skill manual)
lib/consumption.mjs telemetria client-side ponteiro→fetch
lib/dashboard.mjs  painel (canvas): server local SDK-free + snapshot (health/escopo/docs/skills/telemetria/escopo obsoleto)
lib/migrate.mjs    migração de escopo aprovada (previewMigration + migrateScope: list→PATCH, idempotente)
```

## Painel (canvas)

`memory_dashboard` abre um painel lateral (canvas) — ou abra "Memory" na seção de canvas do app. Ele
mostra, ao vivo (auto-refresh) e escopado ao projeto aberto: **saúde do daemon** (online/versão/status),
o **escopo** com a *escada de resolução* do `project_id` (declared → git-remote → git-base → path → name,
destacando qual venceu e alertando quando é frágil), **documentos recentes**, **skills** (ativas/candidatas),
**telemetria de recall** (recalls, ponteiros injetados, fetches e hit-rate ponteiro→fetch) e busca escopada.
Quando o daemon está offline, oferece **Provisionar servidor** (mesmo caminho consentido do `memory_setup`).
É **cliente-puro e só leitura** — nunca sobe o server sozinho. O painel só aparece após **reiniciar o app
uma vez** (o hook `SessionStart` espelha o plugin para `~/.copilot/extensions/` via canvas-sync).

## Requisitos

- Node 18+ (usa `fetch` global e `AbortController`).
- **Java 21** no PATH (o servidor `native-java` roda sobre a JVM; usado pelo auto-provisionamento).
- Servidor `native-java` como daemon (auto-anunciado em `~/.mcp-memory/run/daemon.json`). Se não
  estiver instalado, o plugin baixa e sobe automaticamente (ver Consentimento). `promote`/`invalidate`
  usam o lifecycle REST (ADR-016) e requerem o servidor **2.19.0+**.

## Consentimento

Ao **instalar este plugin**, você autoriza que, na ausência de um servidor de memória já rodando, ele
**baixe a release pública do `mcp-memory-server`** (repositório `AllanSantos-DV/mcp-memory-server-releases`,
verificada por sha256) e a **execute localmente** para prover a memória. Sem o servidor o plugin não tem
função — por isso o download é parte esperada da instalação. Para **desativar** o auto-provisionamento,
defina `COPILOT_MEMORY_AUTOPROVISION=0` (o plugin então apenas reusa um daemon já existente e degrada se
não houver). O download é sempre do repositório oficial acima, por HTTPS, com verificação de integridade.

## Licença

MIT — Allan Santos.
