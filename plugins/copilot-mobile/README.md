# copilot-mobile · bridge (mínima)

Extensão **in-app** do copilot-mobile. Faz só o que **exige** estar dentro da sessão viva do agente.
Todo o resto — transporte (off/lan/tailscale/public), pareamento, stream para o celular e a **tela de
configuração** — vive no **daemon apartado** (`../daemon`), aberto pelo **ícone da bandeja**.

## O que esta extensão faz (e só isso)
1. **🔊 resumo falado** — injeta, a cada turno, a instrução para o agente terminar a resposta com uma
   linha `🔊 …`. O daemon transforma essa linha no áudio do celular. Só injeta quando o daemon está
   **armado** (lê `~/.copilot-mobile-daemon/runtime.json`; em `off` não injeta).
2. **Aviso de drift celular→PC** — o daemon escreve os turnos do celular no disco por um runtime
   **separado** que a memória viva do app nunca vê. A extensão conta `user.message` no disco vs. o que
   o runtime do app processou; o excesso = turnos do celular que faltam neste chat, e ela pede ao
   agente para avisar o usuário a reiniciar o app e sincronizar. Lógica pura e testada em `drift.mjs`.

## Arquivos
- `extension.mjs` — `joinSession` + um único hook `onUserPromptSubmitted` (voz + drift). ~6 KB.
- `drift.mjs` — detecção pura de drift (sem I/O; o chamador passa as contagens). `drift.test.mjs` cobre 17 casos.
- `package.json` — manifest mínimo (sem canvas; o painel é servido pelo daemon).

## Por que mínima (era um daemon embutido)
Antes, esta extensão subia um HTTP server completo (transporte, pareamento, SSE, túnel) e um canvas de
configuração — duplicando o daemon e fazendo **cada sessão competir** pelo controle (mesmo motivo que
levou a apartar o motor do voice), além de exigir o app **aberto** para configurar. Agora o daemon é o
único plano de controle (sempre ligado, funciona com o app fechado) e serve o próprio HTML; a extensão
ficou só com os dois hooks que dependem da sessão viva.

## Testes
```sh
node drift.test.mjs   # 17/17 — detecção de drift (puro)
```
A fiação ponta-a-ponta (baseline via getEvents + incremento por `user.message`, leitura do disco no
hook, composição voz+aviso) é validada por `../daemon/scripts/probe-bridge-integration.mjs`.
