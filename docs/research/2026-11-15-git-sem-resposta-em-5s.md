# Sinal "git state unreadable (git did not answer in 5 s)" no copilot-marketplace (15/11/2026)

Investigação só de leitura. Pergunta: o repositório tem algo que faz o git demorar mais de 5 s?

## Medição

Os comandos que o `runGit` do orchestrador (`src/project-state.mjs:41`, timeout `GIT_TIMEOUT_MS` = 5000 ms) roda por projeto, executados aqui com `timeout 5`:

| Comando | rc | ms |
|---|---|---|
| `for-each-ref --format=%(refname:short)\|%(committerdate:unix) refs/heads` | 0 | 120 |
| `status --porcelain --untracked-files=normal` | 0 | 172 |
| `tag --list` | 0 | 181 |
| `tag --merged main` | 0 | 296 |
| `rev-list --count main..develop` | 0 | 104 |
| `for-each-ref --sort=-creatordate --count=5 refs/tags` | 0 | 153 |
| `log --all --format=%ct` | 0 | 174 |
| `-c core.quotePath=false diff --name-only <última tag>..main` | 0 | 122 |

- Com o daemon do fsmonitor parado, o `git status` frio levou 148 ms. Sem fsmonitor, 88 ms. O daemon não é a causa.
- Não havia `*.lock` em `.git/`. A working tree estava limpa, e `main`, `develop` e os remotos estavam no mesmo commit, com tag.
- O repositório é pequeno: 354 arquivos rastreados e `.git` com 26 MB.
- Em 17/11/2026 o sinal voltou. Uma nova medição deu de 85 a 153 ms (`for-each-ref` heads, `status --porcelain`, `tag --list`, `tag --merged`, `log --all`, todos com rc 0). Continuava sem `*.lock`, com a working tree limpa e `main`, `develop` e os remotos em 870b14c.

## Conclusão

Nada no repositório explica a demora, e o timeout não se reproduz. A causa provável é a carga da máquina no momento da varredura. Pela medição do próprio orchestrador, uma varredura completa dispara cerca de 415 processos git nos 76 repositórios, num pool concorrente (`../orchestrador/docs/research/processos-git-das-varreduras-2026-11-15.md`). Sob essa carga, um git comum pode passar de 5 s. Nenhuma mudança foi feita aqui.

Fontes: `git-scm.com/docs/git-fsmonitor--daemon` e `git-scm.com/docs/git-for-each-ref`, acessadas em 15/11/2026.
