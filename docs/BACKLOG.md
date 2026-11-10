# Backlog — copilot-marketplace

- [x] **Gate não detecta vitrine velha.** `docs/gate.mjs check` agora confere que o card do
  `docs/index.html` e a linha da tabela do README mostram a versão e a description do manifesto
  (além de `docs/p/<nome>/`). Só versão/description são comparadas: o HTML inteiro varia por fim de
  linha no Windows. Teste: `tests/gate-showcase.test.mjs`.
- [x] **Gate compara manifesto e `plugin.json`** (name, version, description) no `check` e no
  `prepush`. Divergência conhecida fica em `KNOWN_MANIFEST_DIVERGENCES`, com o motivo; o gate pede
  para tirá-la quando some. Teste: `tests/gate-contract.test.mjs`.
- [x] **Gate recusa `hooks` apontando para arquivo inexistente.** O campo ficou para trás quando os
  hooks passaram ao neural-link; os plugins de outros repos estão em `KNOWN_DANGLING_HOOKS` até a
  origem tirar o campo. Teste: `tests/gate-contract.test.mjs`.
- [x] **Gate exige versão maior** quando `plugins/<nome>/` muda no push. Teste:
  `tests/gate-contract.test.mjs`.
- [x] **`tools/sync-boot.mjs` confere o motor (`sync.mjs`) do mcp-bridge** contra o do canvas-sync;
  as duas cópias têm de ser idênticas. Teste: `tests/sync-boot.test.mjs`.
- [x] **`docs/build.mjs` emite `docs/catalog.json`** e o `check` recusa catálogo com versão velha.
  Teste: `tests/catalog.test.mjs`.

**Item de negócio, nada técnico aberto:** busca e filtro por keyword/categoria na vitrine
(`docs/assets/app.js` + `data-*` no `card()`). Muda como o usuário descobre plugins: decisão do dono.

## Fora deste repositório

`copilot-voice/publish.ps1` não roda `docs/build.mjs` antes do `gate mark` (linha ~123). A correção
é no repo `copilot-voice`; repassada ao orquestrador. Com o `check` acima, rodá-lo antes do push pega a vitrine velha; o `pre-push` confere só o marcador.

O campo `hooks` morto sai do `plugin.json` na origem de action-bridge (Action), copilot-mobile,
session-unloader e visual-explainer; depois, a entrada correspondente sai de `KNOWN_DANGLING_HOOKS`.
A description do `plugin.json` do copilot-mobile precisa bater com a do manifesto.
