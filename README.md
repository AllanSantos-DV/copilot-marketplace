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
```

Atualize quando quiser (ou todos de uma vez):

```sh
copilot plugin update voice-chat
copilot plugin update action-bridge
copilot plugin update --all
```

## Plugins

| Plugin | Descrição | Versão |
| ------ | --------- | ------ |
| [`voice-chat`](./plugins/voice-chat) | Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (Whisper local para transcrição + voz local pt-BR). | 1.1.12 |
| [`action-bridge`](./plugins/action-bridge) | Controla o app **Action** (captura e memória de reuniões, 100% local no Windows) pelo agente: reuniões, transcrição, memória semântica cruzada, curadoria e grafo — e instala o Action automaticamente quando ele ainda não existe. | 1.1.0 |

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
