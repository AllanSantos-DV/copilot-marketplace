# copilot-marketplace

Marketplace de plugins do [Allan Santos](https://github.com/AllanSantos-DV) para o **GitHub Copilot CLI**.

## Como usar

Registre o marketplace uma vez:

```sh
copilot plugin marketplace add AllanSantos-DV/copilot-marketplace
```

Veja os plugins disponíveis e instale:

```sh
copilot plugin marketplace browse copilot-marketplace
copilot plugin install voice-chat@copilot-marketplace
copilot plugin install action-bridge@copilot-marketplace
copilot plugin install copilot-mobile@copilot-marketplace
```

Atualize quando quiser (ou todos de uma vez):

```sh
copilot plugin update voice-chat
copilot plugin update action-bridge
copilot plugin update copilot-mobile
copilot plugin update --all
```

## Plugins

| Plugin | Descrição | Versão |
| ------ | --------- | ------ |
| [`voice-chat`](./plugins/voice-chat) | Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (Whisper local para transcrição + voz local pt-BR). | 1.1.12 |
| [`action-bridge`](./plugins/action-bridge) | Controla o app **Action** (captura e memória de reuniões, 100% local no Windows) pelo agente: reuniões, transcrição, memória semântica cruzada, curadoria e grafo — e instala o Action automaticamente quando ele ainda não existe. | 1.1.0 |
| [`copilot-mobile`](./plugins/copilot-mobile) | Controle o agente pelo **celular**: chat em tempo real (SSE), perguntas (`ask_user`) e permissões respondidas no celular, envio de mídia e **resumo falado em áudio** (pt-BR). Exposição off/LAN/Tailscale/público decidida na máquina; o app Android se auto-atualiza pelos Releases. | 0.1.4 |

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
