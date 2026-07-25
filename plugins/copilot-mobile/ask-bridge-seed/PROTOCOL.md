# ask-bridge — protocolo COMPARTILHADO de ask_user entre plugins do dono

## Por quê
O SDK do Copilot permite **1 override de `ask_user` por sessão** (tool com `overridesBuiltInTool:true`). Vários
plugins do dono (modo-auto, copilot-mobile, …) querem interceptar o `ask_user`. Sem coordenação, o 2º a registrar
recebe `External tool name clash: ask_user already registered by another connection` (derruba/degrada). O
ask-bridge coordena: **o 1º plugin vira DONO da rota e registra o override; os outros conectam como RESPONDEDORES**
(sem clash). Na hora de uma pergunta, o dono **despacha a todos os respondedores** e vence o **primeiro a
responder** (first-to-answer) — celular (copilot-mobile) OU mesa (modo-auto) OU o que for.

## Coordenação — lockfile ATÔMICO por sessão
Diretório: `~/.ask-bridge/sessions/<sessionId-sanitizado>/`
- `claim.lock` — criado com `openSync(path, 'wx')` (ATÔMICO: só um processo vence; os outros recebem `EEXIST`).
- `owner.json` — escrito pelo VENCEDOR imediatamente após pegar o lock:
  ```json
  { "pid": 1234, "extensionId": "modo-auto", "sessionId": "<sid>", "bootId": "abc123",
    "acquiredAt": "ISO-8601", "loopbackPort": 51234, "token": "<hex>" }
  ```
  (`loopbackPort`/`token` presentes a partir da Fase 2 — o dono sobe o servidor de dispatch ANTES do `joinSession`.)

### acquireOrConnect(sessionId) — algoritmo (ref: modo-auto `src/adapters/session/askBridgeClaim.mjs`)
1. `mkdir -p` o dir; tenta `openSync(claim.lock, 'wx')`.
2. Venceu → escreve `owner.json` → **isOwner=true** (registra o override).
3. `EEXIST` → lê `owner.json` (poll curto p/ a janela lock→write). Dono com `pid` VIVO (`process.kill(pid,0)`) e ≠ meu → **isOwner=false** (conecta como respondedor). Dono MORTO → `unlink` do lock+owner e 1 retry.
4. **FAIL LOUD**: erro inesperado SOBE (nunca degrada calado). Erro no acquire → sinaliza VISÍVEL.
- `releaseClaim(sessionId)`: só apaga `claim.lock`/`owner.json` se `owner.pid === meu pid`. Chamar em re-join,
  `disconnect()`, `process.on('exit'|'SIGTERM'|'SIGINT')`.

## Dispatch (Fase 2) — endpoints loopback (127.0.0.1, porta efêmera `listen(0)`, autenticado por `token`)
O **DONO** sobe um servidor com:
- `POST /register` `{responderId, priority, url, answerTimeoutMs, token}` → registra um respondedor remoto (o dono
  chama a `url` dele no dispatch). `GET /health`. `DELETE /register/:id`.
O **RESPONDEDOR** (não-dono) sobe um servidor com:
- `POST /ask` `{requestId, question, choices, allowFreeform}` → entrega a pergunta ao seu destino (celular/mesa) e
  responde `{answer}` (ou `{decline:true}` p/ passar a vez). Depois faz `POST <owner.loopbackPort>/register` com a
  sua `url`.
Handler do override (no DONO): fan-out a TODOS os respondedores (o local dele + os remotos via `POST /ask`),
`dispatchTimeoutMs=2000` p/ confirmar vivo, vence o 1º `{answer}`; nenhum responde no `answerTimeoutMs` do
respondedor eleito → **throw com contexto** (FAIL LOUD, nunca resposta fabricada, nunca fallback silencioso).

Timeouts (distintos): `dispatchTimeoutMs=2000` (RTT p/ confirmar respondedor vivo) × `answerTimeoutMs` por
respondedor (mesa≈30000 p/ LLM; celular≈300000 p/ humano). Misturar = fail-loud prematuro.

## Prioridade / decline (Fase 3)
`~/.ask-bridge/config.json` = `{ "respondents": [{ "id", "priority", "answerTimeoutMs" }] }`. Um respondedor pode
retornar `{decline:true}` em <500ms p/ passar ao próximo por prioridade descendente.

## Limitações conhecidas (documentadas)
- PID-recycle (Windows): `process.kill(pid,0)` pode dar falso-positivo p/ pid reciclado → lock órfão. Mitigação
  Fase 2+: heartbeat (mtime de `owner.json`) p/ decidir stale por IDADE além do pid.
- Reeleição mid-session é impossível (o SDK amarra o override ao connection do `joinSession`). Se o dono cai, o
  override some até um novo `joinSession` (re-arme) de um sobrevivente que re-adquira o lock.
