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
| [`voice-chat`](./plugins/voice-chat) | Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (Whisper local para transcrição + voz local pt-BR). | 1.1.5 |

## Manutenção

Cada plugin é **vendado** em `plugins/<nome>/` (os arquivos de runtime já empacotados). O `voice-chat` é
publicado a partir do repositório de origem **privado** por um passo de publish **local** (`publish.ps1`)
que copia o runtime, sobe a versão e dá push aqui. Não há GitHub Actions nem dependência de releases
públicas — o commit nesta vitrine **é** a publicação, e o `copilot plugin update` detecta pela versão.
Não edite os arquivos em `plugins/voice-chat/` à mão.
