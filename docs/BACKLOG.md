# Backlog — copilot-marketplace

- [ ] **Gate não detecta vitrine velha.** `docs/gate.mjs check` valida o hash de `plugin.json` +
  content, mas não confere se `docs/index.html`, `docs/p/<nome>/` e o README batem com a saída do
  `docs/build.mjs`. Um sync que pula o build passa no gate (voice-chat v2.3.18, 2026-10-11).
  Ideia: no `check`, gerar em memória e comparar só versão/description (o build no Windows varia
  os tamanhos da árvore por fim de linha, então comparar o HTML inteiro daria falso positivo).
- [ ] **`copilot-voice/publish.ps1` não roda `docs/build.mjs`** antes do `gate mark` (linha ~123).
  Corrigir no repo `copilot-voice`.
