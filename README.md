# copilot-marketplace

Marketplace de plugins do [Allan Santos](https://github.com/AllanSantos-DV) para o **GitHub Copilot CLI**.

🔎 **Vitrine:** <https://allansantos-dv.github.io/copilot-marketplace/>

## Como usar

Registre o marketplace uma vez:

```sh
copilot plugin marketplace add AllanSantos-DV/copilot-marketplace
```

Veja os plugins e instale (lista completa na [vitrine](https://allansantos-dv.github.io/copilot-marketplace/) ou na tabela abaixo):

```sh
copilot plugin marketplace browse copilot-marketplace
copilot plugin install <plugin>@copilot-marketplace
```

Atualize quando quiser (ou todos de uma vez):

```sh
copilot plugin update <plugin>
copilot plugin update --all
```

## Plugins

<!-- plugins:start -->
| Plugin | Descrição | Versão |
| ------ | --------- | ------ |
| [`voice-chat`](./plugins/voice-chat) | Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (Whisper local para transcrição + voz local pt-BR). | 1.2.1 |
| [`action-bridge`](./plugins/action-bridge) | Controla o app Action (captura e memória de reuniões, 100% local no Windows) pelo agente: reuniões, transcrição, memória semântica cruzada, curadoria e grafo — e instala o Action automaticamente quando ele ainda não existe. | 1.1.0 |
| [`copilot-mobile`](./plugins/copilot-mobile) | Bridge do copilot-mobile: provisiona o daemon apartado na 1ª execução (baixa a release buildada, sem build), injeta o resumo falado e detecta drift celular→PC. Pareamento, transporte e configuração ficam no daemon (ícone da bandeja). | 0.3.1 |
| [`copilot-remote`](./plugins/copilot-remote) | Controle remoto de sessões do Copilot em outras máquinas via o daemon do copilot-mobile: escolha a máquina, liste sessões, converse, mande áudio (reusa o motor de voz local) e arquivos — direto do desktop. | 0.1.0 |
| [`canvas-sync`](./plugins/canvas-sync) | Infra da vitrine: espelha canvas extensions (installed-plugins) para ~/.copilot/extensions via hook de SessionStart. Instale junto ou deixe um plugin baixar sozinho. | 0.3.0 |
| [`mcp-bridge`](./plugins/mcp-bridge) | Restaura o MCP no GitHub Copilot onde ele é bloqueado por política mas as extensões são permitidas: conecta a servidores MCP (stdio/http/sse, com login OAuth) e expõe tools, prompts e resources nativamente ao agente, com resiliência, auditoria e um painel de saúde. Devolve os braços e as pernas da IA. | 0.1.0 |
<!-- plugins:end -->

> A tabela acima é **gerada** a partir de `.github/plugin/marketplace.json` por `node docs/build.mjs`
> — não edite à mão entre os marcadores.

## Vitrine (GitHub Pages)

A vitrine em [`docs/`](./docs) é **estática e gerada** a partir de `.github/plugin/marketplace.json`
por `node docs/build.mjs` (Node, sem dependências, **sem GitHub Actions**). Publicada por GitHub
Pages a partir do branch `main`, pasta `/docs`. Cada plugin "publica seu conteúdo": ao subir a
versão no manifesto e reassar, o card e a tabela se atualizam sozinhos.

## Manutenção

Cada plugin é **vendado** em `plugins/<nome>/` (os arquivos de runtime já empacotados). O commit
nesta vitrine **é** a publicação — não há GitHub Actions nem dependência de releases públicas, e o
`copilot plugin update` detecta pela versão. Não edite os arquivos em `plugins/<nome>/` à mão.

- **`voice-chat`** é publicado a partir do repositório de origem por um passo de publish **local**
  (`publish.ps1`) que copia o runtime, sobe a versão e dá push aqui.
- **`action-bridge`** vem do repositório de código **privado** do Action (`integrations/copilot-extension/`):
  o `extension.mjs` é **empacotado com esbuild** (o MCP SDK é embutido; o `@github/copilot-sdk` fica
  external, resolvido pelo runtime) e vendado aqui junto do `plugin.json`. O app Action pesado é baixado
  sob demanda pelo próprio bootstrap do plugin a partir de
  [`action-releases`](https://github.com/AllanSantos-DV/action-releases).
- **`copilot-mobile`** vem do repositório de código **privado** [`copilot-mobile`](https://github.com/AllanSantos-DV/copilot-mobile) (`bridge/`):
  os arquivos de runtime (`extension.mjs`, `access.mjs`, `desktop.html`, `qrcode.min.js`) são vendados aqui
  junto do `plugin.json` — a extensão só usa `node:` builtins + `@github/copilot-sdk` (external), sem bundle. O
  **app Android** (APK) é distribuído por GitHub Releases (tag `copilot-mobile-v*`) e o próprio app se
  auto-atualiza a partir daí.
- **`copilot-remote`** vem do repositório de código **privado** [`copilot-remote`](https://github.com/AllanSantos-DV/copilot-remote):
  os arquivos de runtime (`extension.mjs`, `client.mjs`, `daemon.mjs`, `panel.html`, `hooks.json`) são
  vendados aqui. Reusa o daemon do `copilot-mobile` e o motor de voz local.
- **`canvas-sync`** é **infra da própria vitrine**: um hook de `SessionStart` que espelha as canvas
  extensions instaladas (`installed-plugins`) para `~/.copilot/extensions` — a única pasta que o app GUI
  carrega. Sem passos manuais.

> **Guia completo para agentes:** veja [`AGENTS.md`](./AGENTS.md) — como publicar, migrar ou criar
> um plugin/extensão do Copilot neste repositório.
