# session-unloader

Descarrega da memória as **sessões ociosas** do Copilot que continuam com o processo-servidor vivo depois
de você parar (o app não libera a RAM ao parar — as sessões se acumulam consumindo memória e processos).
Mata a **árvore do processo** sem apagar a sessão do disco: o **lazy-load** do app reabre com chat e
histórico intactos (as extensões voltam com um `reload extension`).

## Como decide o que é "ocioso"
Uma sessão só é candidata depois de **inatividade contínua da árvore inteira** pelo tempo configurado
(padrão seguro: 60 min):

1. soma o delta de CPU do servidor e de todos os descendentes por PID;
2. normaliza a CPU por tempo de parede e núcleos lógicos;
3. reinicia o relógio se houver CPU, evento novo, PID novo/reciclado ou processo allowlisted;
4. mantém `liveWorker.mjs` e `voice_worker.py` como proteções obrigatórias;
5. trata snapshot ausente/legado, árvore incompleta ou CPU indisponível como **preservar**.

`events.jsonl` agora é apenas um sinal de atividade que reinicia a janela — nunca é usado sozinho para
autorizar um kill. O snapshot guarda CPU por PID e `idleSince`; scans rápidos não apagam a janela real.

## Guardas antes de qualquer kill
- **Auto-preservação:** nunca a própria sessão/scan nem seus ancestrais.
- **Anti-TOCTOU:** revalida que o PID ainda é um servidor `--server --stdio` (senão foi reciclado → aborta).
- **Daemon singleton:** nunca derruba `Action-mcp` / `embed-house` / memória / bolão (servem todas as sessões).
- **Lock anti-race:** dois hooks simultâneos não colidem.

## Como usar
- **Automático:** desligado por padrão. Quando habilitado conscientemente no canvas, hooks `SessionStart`
  e `UserPromptSubmit` avaliam a política; evento ausente/desconhecido falha fechado sem varrer.
- **Sob demanda:** a tool **`unload_idle`** — `dryRun` por padrão (só lista as candidatas); passe
  `force: true` para descarregar. Opcional `sessionId` para uma sessão específica.
- **Log:** `~/.copilot/logs/unloader.log` (JSON-line: `killed` / `skipped` / `dry-run` + motivo).

## Painel (canvas)
Um **daemon único** (singleton por porta — `server-daemon.mjs`) é o dono de TUDO: scan de processos,
avaliação de ociosidade, snapshot, telemetria, configuração, descarga manual e o agendamento automático
quando habilitado. O canvas de **cada sessão é um cliente fino** (`extension.mjs`) que só acha/sobe o
daemon e aponta pra URL dele — **1 leitura de processos para N sessões**, o próprio preceito do plugin.
`extension.mjs` não importa scan/guardas/telemetria/dashboard, direta ou transitivamente; se o daemon não
subir, o erro aparece explícito (sem fallback local, sem porta efêmera — falha do daemon nunca é mascarada
por um segundo servidor).

O daemon não faz mais o scan caro dentro do request: um **sampler singleton** (`lib/sampler.mjs`) escaneia
em segundo plano com *coalescing* (nunca dois scans em voo; N pedidos concorrentes viram no máximo 1 scan
em execução + 1 enfileirado). `/data` sempre responde com o último snapshot na hora (a quente, p95 ≤100ms)
e um estado explícito — `fresh` / `scanning` / `stale` / `error` — junto com idade, duração do último scan,
próximo scan e o último erro. Um snapshot "frio" (`data:null`, nenhum scan terminou ainda) é distinto de um
sistema realmente vazio (`sessions:[]`).

A telemetria (`lib/telemetry-store.mjs`) faz *tail* incremental do log NDJSON — nunca relê o arquivo
inteiro a cada leitura — com cursor persistido, contadores cumulativos e uma série curta e limitada.
Trunca/rotação e linhas corrompidas são detectadas e sinalizadas, nunca silenciadas. Os cards vivos
(carregadas/ativas/protegidas/candidatas agora + RAM carregada/liberável) vêm do snapshot ATUAL, não só do
histórico de kills — por isso continuam mudando mesmo com o automático desligado.

Mostra status, freshness (estado/idade/duração do scan/uptime do daemon), telemetria (descargas + RAM
liberada + contadores operacionais) e as sessões carregadas agora (🟢 esta sessão/ativa · 🔴 candidata ·
🔒 protegida · ⚪ casca). Token loopback; o daemon só se auto-encerra por idle quando o automático está
**desligado**, sem painel/cliente ativo (lease/heartbeat) e sem scan em voo — se o automático estiver
ligado, o daemon nunca sai sozinho (o scheduler tem que sobreviver independente de prompt).

**Ações no painel:** três botões dão controle sem depender do automático — **Descarregar ociosas agora**
(faz um *dry-run* que lista o que seria afetado, com o aviso "o estado pode mudar entre a prévia e a execução",
e só descarrega após confirmação), **Reescanear** (nudge no sampler — coalescido, nunca dois scans em
paralelo) e um interruptor **Automático ON/OFF**. Com o automático **ligado**, o próprio daemon mantém um
**scheduler único** que avalia em cadência própria — a janela de inatividade é atingida mesmo sem nenhum
prompt novo do usuário; os command hooks (`scan-hook.mjs`) viraram nudges finos ao daemon (não escaneiam
nem matam localmente). Com o automático **desligado** o painel exibe um **banner vermelho** persistente. A
seção **Política de segurança** permite escolher o timeout (15 min–24 h), calibrar a razão de CPU/janela
mínima e manter uma allowlist adicional literal. As proteções de voz e `liveWorker` não podem ser
removidas. As ações são `POST` autenticadas por header `X-Token` (o `GET` continua por query), com mutex
anti-duplo-clique no daemon, `sessionId` validado (rejeita path traversal/caracteres não-literais) e
`callerPid` que só ADICIONA proteção — nunca autoriza um kill, mesmo forjado. A flag fica em
`~/.copilot/session-state/.unloader-config.json` (global do daemon único); entrada inválida é rejeitada com
erro visível e arquivo inválido desliga o automático com defaults seguros.


## Reversibilidade
Descarregar **não apaga** a sessão. Reabra-a no app: o lazy-load restaura chat e histórico; rode
`reload extension` para as extensões. Estado de runtime não persistido (shells, conexões MCP, contexto em memória) não volta; por isso o automático
só age depois da janela contínua configurada e das proteções de árvore.

## Backlog (fora da v1 — não implementado)
- **Limpeza de locks órfãos** (`inuse.<pid>.lock` de PID morto): higiene de disco, zero impacto de memória.
- **Proteção de ponte cross-session:** se a sessão-ponte está ociosa, é descarregada (trade-off aceito no ADR).
- **CIM recursivo com skip granular de filhos:** desnecessário — empiricamente daemons não são filhos de servidores.
- **Backends mac/Linux:** hoje Windows (WMI/CIM). A interface `{ scan, procMap, treeKill }` já isola o SO.

## Estrutura
- `boot.mjs` — bootstrap do canvas-sync (garante o espelhamento do plugin para `~/.copilot/extensions/`).
- `scan-hook.mjs` — cliente FINO dos command hooks (SessionStart + UserPromptSubmit): nunca escaneia
  localmente, só faz nudge no daemon quando o automático está ligado (fail-closed barato quando desligado).
- `extension.mjs` — a tool `unload_idle` + o canvas (cliente fino → encaminha tudo ao daemon via
  `lib/daemon-client.mjs`; não importa scan/guardas/telemetria/dashboard, direta ou transitivamente).
- `server-daemon.mjs` — o DAEMON ÚNICO (singleton por porta): dono do sampler, telemetria, scheduler e
  do painel; idle-exit só quando desligado, sem lease ativa e sem scan em voo (`lib/daemon-lifecycle.mjs`).
- `ensure-daemon.mjs` + `lib/daemon-lock.mjs` — find-or-start do daemon e o lockfile de descoberta.
- `lib/` — `scan`/`procmap` (CIM), `snapshot`+`idle-decision` (núcleo puro por árvore), `guards`,
  `config`, `lock`, `throttle`, `unload` (orquestra), `log`, `home`, `canvas-meta` (identidade do canvas,
  zero deps), `daemon-client` (cliente HTTP fino), `sampler` (scan singleton com coalescing),
  `telemetry-store` (tail incremental do NDJSON + contadores), `telemetry` (parser puro legado, ainda
  usado por quem só tem as linhas em mãos), `scheduler` (cadência do automático), `dashboard` (HTML/API).
- Reúso: `~/.copilot/pkg/universal/process-utils.mjs` (`treeKill` de modo-auto, `pidAlive` de voice-chat).
- Testes (sem framework): `test.mjs`, `test-unload.mjs`, `test-integration.mjs`, `test-client.mjs`
  (fronteira do cliente fino), `test-sampler.mjs`, `test-telemetry-store.mjs`, `test-scheduler.mjs`,
  `test-lifecycle.mjs`, `test-daemon-security.mjs`, `test-benchmark.mjs` (p95 do `/data` quente).
