# Backlog — copilot-marketplace

- [x] **Gate não detecta vitrine velha.** `docs/gate.mjs check` agora confere que o card do
  `docs/index.html` e a linha da tabela do README mostram a versão e a description do manifesto
  (além de `docs/p/<nome>/`). Só versão/description são comparadas: o HTML inteiro varia por fim de
  linha no Windows. Teste: `tests/gate-showcase.test.mjs`.

## Fora deste repositório

`copilot-voice/publish.ps1` não roda `docs/build.mjs` antes do `gate mark` (linha ~123). A correção
é no repo `copilot-voice`; repassada ao orquestrador. Com o `check` acima, esse sync agora é barrado
no gate em vez de passar com a vitrine velha.
