# canvas-sync

Infra da vitrine. Faz a ponte entre **plugins do Copilot CLI** (instalados em
`~/.copilot/installed-plugins/`) e os **canvases do app** (carregados só de
`~/.copilot/extensions/`).

## Por quê

O app GUI descobre canvases apenas em `~/.copilot/extensions/`. Instalar um plugin
pelo marketplace cai em `installed-plugins/` e **não** roda como canvas. O `canvas-sync`
espelha automaticamente os plugins marcados como canvas (campo oficial `extensions` no
`plugin.json`) para `extensions/`.

## Como funciona

- Roda como **hook de `SessionStart`** (`node sync.mjs`).
- Lê `settings.json → enabledPlugins`, filtra os que têm o marcador `extensions`, e
  espelha `installed-plugins/<mp>/<plugin>/` → `extensions/<plugin>/`.
- **Idempotente** (stamp `.canvas-sync.json`) e **seguro**: nunca sobrescreve uma pasta
  sem stamp (cópia de desenvolvimento fica intocada).
- Cada plugin da vitrine traz um `boot.mjs` que **baixa** o `canvas-sync` desta vitrine
  quando ele ainda não existe na máquina — então o usuário só escolhe o plugin.

> Após instalar/atualizar plugins, **reinicie o app** uma vez: o hook popula `extensions/`
> no início da sessão e o app descobre os canvases no próximo boot.
