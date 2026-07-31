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
Um **daemon único** (singleton por porta — `server-daemon.mjs`) faz o scan e a telemetria e serve o painel; o
canvas de **cada sessão é um cliente fino** que só aponta pra URL do daemon — **1 leitura de processos para N
sessões**, o próprio preceito do plugin. Mostra status, telemetria (descargas + RAM liberada) e as sessões
carregadas agora (🟢 esta sessão/ativa · 🔴 candidata · 🔒 protegida · ⚪ casca). Token loopback; o
daemon **se auto-encerra após 10 min ocioso** (não vira o processo órfão que o plugin combate). Se o daemon
não subir, o canvas cai para um servidor in-process (fallback, zero painel bloqueado).

**Ações no painel:** três botões dão controle sem depender do automático — **Descarregar ociosas agora**
(faz um *dry-run* que lista o que seria afetado, com o aviso "o estado pode mudar entre a prévia e a execução",
e só descarrega após confirmação), **Reescanear** (re-varre na hora) e um interruptor **Automático ON/OFF** que
liga/desliga o descarregamento pelos hooks de sessão. Com o automático **desligado** o painel exibe um **banner
vermelho** persistente. A seção **Política de segurança** permite escolher o timeout (15 min–24 h), calibrar
a razão de CPU/janela mínima e manter uma allowlist adicional literal. As proteções de voz e `liveWorker`
não podem ser removidas. As ações são `POST` autenticadas por header `X-Token` (o `GET` continua por query), com
mutex anti-duplo-clique no daemon e desabilite-no-clique no botão. A flag fica em
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
- `scan-hook.mjs` — runner do scan/descarga nos command hooks (SessionStart + UserPromptSubmit).
- `extension.mjs` — a tool `unload_idle` + o canvas (cliente fino → aponta pro daemon do painel).
- `server-daemon.mjs` — o DAEMON ÚNICO do painel (singleton por porta): scan/telemetria + serve o painel; idle-timeout 10 min.
- `ensure-daemon.mjs` + `lib/daemon-lock.mjs` — find-or-start do daemon e o lockfile de descoberta.
- `lib/` — `scan`/`procmap` (CIM), `snapshot`+`idle-decision` (núcleo puro por árvore), `guards`,
  `config`, `lock`, `throttle`, `unload` (orquestra), `telemetry`, `log`, `home`.
- Reúso: `~/.copilot/pkg/universal/process-utils.mjs` (`treeKill` de modo-auto, `pidAlive` de voice-chat).
- Testes (sem framework): `test.mjs`, `test-unload.mjs`, `test-integration.mjs`.
