# Backlog técnico zerado: contrato do plugin, bump, motor e catálogo (2026-11-10)

## Decisões com evidência

**Manifesto ≠ `plugin.json`.** Medido no repo: só o copilot-mobile diverge, na description. O gate compara
name/version/description no `check` e no `prepush`; a divergência do copilot-mobile entra em
`KNOWN_MANIFEST_DIVERGENCES` com o motivo, e o gate pede para tirá-la quando o repo de origem alinhar.

**`hooks` apontando para arquivo apagado.** O commit 3044425 (2026-07-28) apagou os `hooks.json` ao passar a
calibragem para o neural-link (`<hook>.neural-link.json`) e deixou o campo `"hooks": "hooks.json"` em cinco
plugins. O neural-link não lê esse campo: só varre `*.neural-link.json` (neural-link `src/discovery.js:88-98`).
A CLI lê hooks da pasta do plugin instalado (o voice-chat é o único com `hooks.json` real), e a referência não
diz o que acontece com o arquivo ausente (https://docs.github.com/en/copilot/reference/cli-plugin-reference,
acesso em 2026-11-10); na prática a CLI aceita o plugin, porque o action-bridge 1.3.1 instala e lista com o
ponteiro morto. O canvas-sync é deste repo e perdeu o campo (0.6.2); action-bridge, copilot-mobile,
session-unloader e visual-explainer ficam em `KNOWN_DANGLING_HOOKS` até a origem tirar o campo.

**Motor do canvas-sync no mcp-bridge.** As duas cópias de `sync.mjs` são idênticas depois de normalizar
CRLF; a diferença de hash vista antes era só fim de linha. Devem ser idênticas: é o mesmo motor rodando o
bootstrap sem rede, e cópias divergentes do motor já causaram o incidente registrado no próprio `sync.mjs`.
`tools/sync-boot.mjs` passou a verificar e propagar a cópia (`MOTOR_COPIAS`).

Achado lateral: `engineFingerprint()` do motor faz hash dos bytes crus. A cópia instalada do mcp-bridge é
CRLF, então o log do canvas-sync mostra o hash 80f0e15936c1 para o mesmo motor que a fonte marca como
58693dce5efa. É falso sinal de divergência; a correção (normalizar antes do hash) mexe no motor e na cópia
do mcp-bridge.

**Bump obrigatório.** O `prepush` recusa push em que `plugins/<nome>/` mudou sem versão maior (base: o sha
remoto da ref, ou `origin/main` para ref nova). Plugin novo ou removido no range não é comparado.

**`docs/catalog.json`.** Sai do mesmo `load()` do build, sem carimbo de data (build determinístico), e o
`check` recusa catálogo com versão diferente do `plugin.json`.

## Verificação

`node --test tests/*.test.mjs`: 29 testes, 29 passam (13 anteriores + 16 novos em `gate-contract`,
`sync-boot` e `catalog`). `node docs/gate.mjs check`: ok. Ambiente real: canvas-sync 0.6.2 aplicado em
`installed-plugins` (backup em `%LOCALAPPDATA%\copilot-plugin-backups`), e uma sessão nova do `copilot -p`
rodou o motor no SessionStart (linha nova no `last-run.log` às 21:29:48Z).
