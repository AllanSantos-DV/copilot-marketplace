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
```

Atualize quando quiser (ou todos de uma vez):

```sh
copilot plugin update voice-chat
copilot plugin update --all
```

## Plugins

| Plugin | Descrição | Versão |
| ------ | --------- | ------ |
| [`voice-chat`](./plugins/voice-chat) | Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (Whisper local para transcrição + voz local pt-BR). | 1.1.4 |

## Manutenção

Cada plugin é **vendado** em `plugins/<nome>/` (os arquivos de runtime já empacotados). O `voice-chat` é
sincronizado automaticamente a partir das releases do repositório de origem
[`AllanSantos-DV/copilot-voice`](https://github.com/AllanSantos-DV/copilot-voice) pela Action
[`sync-voice-chat`](./.github/workflows/sync-voice-chat.yml) — não edite os arquivos em `plugins/voice-chat/`
à mão.
