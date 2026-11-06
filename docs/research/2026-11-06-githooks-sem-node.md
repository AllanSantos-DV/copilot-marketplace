# Git hooks globais sem node

Medição (repo scratch + remote bare, `node` falso no PATH contando inícios de processo, cadeia real
orchestrador → ~/.copilot/githooks):

| | antes | depois |
|---|---|---|
| `git commit` | 1 node | 0 |
| `git push` | 1 node | 0 |

Causa: `~/.copilot/githooks/{commit-msg,pre-push}` eram shims `exec node dispatch.mjs`, encadeados pelo hook
sh do orchestrador a cada commit e push.

Decisão: `docs/githooks/{pre-push,commit-msg}` em sh puro, mesma semântica (strip de atribuição de IA no
commit-msg, bloqueio no pre-push, hook local preservado, fail-open). O gate (`docs/gate.mjs`, node) só inicia
quando o push toca `plugins/`, `docs/content/*.json` ou `.github/plugin/marketplace.json`, ou quando o range
não resolve. A checagem de atribuição é pulada quando a cadeia do orchestrador já a fez (`ORQ_COAUTHOR_CHAIN`).
Resíduo: um push que publica plugin ainda inicia 1 node (o gate calcula hash/JSON).
