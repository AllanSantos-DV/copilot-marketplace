# Backlog — copilot-marketplace

- [x] **Gate não detecta vitrine velha.** `docs/gate.mjs check` agora confere que o card do
  `docs/index.html` e a linha da tabela do README mostram a versão e a description do manifesto
  (além de `docs/p/<nome>/`). Só versão/description são comparadas: o HTML inteiro varia por fim de
  linha no Windows. Teste: `tests/gate-showcase.test.mjs`.
- [ ] **Gate compara manifesto e `plugin.json`** (name, version, description). Reusa `manifestPlugin`,
  `versionOf` e o laço de `cmdCheck`. Bloqueia hoje: a description do `copilot-mobile` diverge entre os
  dois, e o conserto é no repo de origem. O `author` fica fora da comparação até os repos de origem
  publicarem o autor neutro.
- [ ] **Gate recusa `hooks` apontando para arquivo inexistente.** Cinco `plugin.json` declaram
  `hooks.json` sem o arquivo vendado. Antes, confirmar se a CLI lê hooks da pasta vendada.
- [ ] **Gate exige bump de versão** quando arquivos de `plugins/<nome>/` mudam no push. Reusa
  `touchedPlugins` e `gitShow`.
- [ ] **`tools/sync-boot.mjs` também confere o `sync.mjs`** do mcp-bridge contra o do canvas-sync
  (hashes diferentes hoje). Decidir antes se devem ser idênticos.
- [ ] **`docs/build.mjs` emite `docs/catalog.json`** a partir de `load()`, para agentes lerem o
  catálogo sem parsear HTML.
- [ ] **Busca e filtro por keyword/categoria na vitrine** (`docs/assets/app.js` + `data-*` no
  `card()`). Muda a descoberta de plugins na vitrine: decisão do dono.

## Fora deste repositório

`copilot-voice/publish.ps1` não roda `docs/build.mjs` antes do `gate mark` (linha ~123). A correção
é no repo `copilot-voice`; repassada ao orquestrador. Com o `check` acima, rodá-lo antes do push pega a vitrine velha; o `pre-push` confere só o marcador.
