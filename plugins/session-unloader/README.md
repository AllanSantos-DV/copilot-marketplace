# session-unloader

Descarrega da memória as **sessões ociosas** do Copilot que continuam com o processo-servidor vivo depois
de você parar (o app não libera a RAM ao parar — as sessões se acumulam consumindo memória e processos).
Mata a **árvore do processo** sem apagar a sessão do disco: o **lazy-load** do app reabre com chat e
histórico intactos (as extensões voltam com um `reload extension`).

## Como decide o que é "ocioso" (sinal duplo — o coração da segurança)
Uma sessão só é descarregada quando **AMBOS** confirmam ociosidade, validados empiricamente:
1. **`events.jsonl` sem escrita há > 10 min** — nenhum turno/subagente recente; e
2. **CPU zerada desde o último snapshot** — nada (agente, subagente **ou mesa de deliberação**) queimou CPU.

Se **qualquer** sinal indica vida, a sessão é **preservada**. Assim ficam protegidos automaticamente: a
sessão ativa, um **subagente** em execução (mantém o `events` quente) e uma **mesa de ADR** (queima CPU).
**Cold-start:** sem snapshot anterior a sessão **nunca** é morta — a primeira passada só grava a linha de
base (protege contra PID reciclado).

## Guardas antes de qualquer kill
- **Auto-preservação:** nunca a própria sessão/scan nem seus ancestrais.
- **Anti-TOCTOU:** revalida que o PID ainda é um servidor `--server --stdio` (senão foi reciclado → aborta).
- **Daemon singleton:** nunca derruba `Action-mcp` / `embed-house` / memória / bolão (servem todas as sessões).
- **Lock anti-race:** dois hooks simultâneos não colidem.

## Como usar
- **Automático:** hooks `SessionStart` (ao abrir uma sessão) e `UserPromptSubmit` (throttle de 1 h, cobre
  quem trabalha horas numa sessão só). Roda em processo separado, fire-and-forget, nunca bloqueia o chat.
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

**Ações no painel (v0.4):** três botões dão controle sem depender do automático — **Descarregar ociosas agora**
(faz um *dry-run* que lista o que seria afetado, com o aviso "o estado pode mudar entre a prévia e a execução",
e só descarrega após confirmação), **Reescanear** (re-varre na hora) e um interruptor **Automático ON/OFF** que
liga/desliga o descarregamento pelos hooks de sessão. Com o automático **desligado** o painel exibe um **banner
vermelho** persistente. As ações são `POST` autenticadas por header `X-Token` (o `GET` continua por query), com
mutex anti-duplo-clique no daemon e desabilite-no-clique no botão. A flag fica em
`~/.copilot/session-state/.unloader-config.json` (global do daemon único); em qualquer erro de leitura ela é
**fail-closed** (automático desligado — melhor não descarregar do que matar por acidente com config quebrada).


## Reversibilidade
Descarregar **não apaga** a sessão. Reabra-a no app: o lazy-load restaura chat e histórico; rode
`reload extension` para as extensões. Estado de runtime não persistido (shells, conexões MCP, contexto em
memória) **não** volta — aceitável após 10 min de inatividade total.

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
- `lib/` — `scan` (CIM), `snapshot`+`isIdle` (sinal duplo), `guards`, `lock`, `throttle`, `unload` (orquestra), `procmap`, `deps`, `log`, `home`.
- Reúso: `~/.copilot/pkg/universal/process-utils.mjs` (`treeKill` de modo-auto, `pidAlive` de voice-chat).
- Testes (sem framework): `test.mjs`, `test-unload.mjs`, `test-integration.mjs`.
