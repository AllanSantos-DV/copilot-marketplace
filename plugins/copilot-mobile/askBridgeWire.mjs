// askBridgeWire.mjs — COORDENAÇÃO do ask_user compartilhado (Fase 1, lado copilot-mobile). Extraído do
// extension.mjs pra ser TESTÁVEL sem SDK/rede: recebe o askBridge (rota do celular) + a API do ask-bridge
// (semeada de ~/.ask-bridge/lib) e decide DONO × RESPONDEDOR por sessão.
//
//  • DONO (1º a pegar o lock): registra o override do ask_user cujo handler DESPACHA a todos os respondedores
//    (celular LOCAL via askOnce + mesa REMOTA via /ask), vencendo o 1º a responder. O celular é addLocalResponder.
//  • RESPONDEDOR (o dono é outro plugin, ex.: modo-auto): NÃO registra o override (evita o clash do SDK); sobe
//    um servidor /ask cujo askFn mostra o card no celular (askOnce withCanvas:false) e registerWithOwner.
//
// FAIL SOFT no boot: qualquer erro aqui SOBE pro caller, que cai no override LOCAL (comportamento anterior) —
// nunca trava a sessão. O dispatch em si é FAIL LOUD (throw se ninguém responde), traduzido no handler pra um
// "(o usuário não respondeu)" (mesma UX do nativo), sem fabricar resposta.

const PHONE_RESPONDER_ID = "copilot-mobile-phone";
const PHONE_ANSWER_TIMEOUT_MS = 300000; // humano

export async function planAskBridge({ sessionId, askBridge, api, extensionId = "copilot-mobile", home, log = () => {} }) {
  const claim = await api.acquireOrConnect(sessionId, home ? { extensionId, home } : { extensionId });

  if (claim.isOwner) {
    const claimOpts = home ? { home } : undefined;
    const owner = api.createAskBridgeOwner({ log });
    const { port, token } = await owner.start();
    api.updateOwnerInfo(sessionId, { loopbackPort: port, token }, claimOpts);
    // Heartbeat (protocol 1.1.0+): re-carimba heartbeatAt a cada 20s → um dono morto/travado (PID recycling no
    // Windows) é detectado como STALE e roubado no próximo join. Opt-in ADITIVO; guardado p/ compat com semente 1.0.0.
    const stopHeartbeat = typeof api.startHeartbeat === "function" ? api.startHeartbeat(sessionId, claimOpts) : null;
    // O CELULAR é um respondedor LOCAL do dono (com o canvas do PC): usa o requestId do dispatch pra a resposta casar.
    owner.addLocalResponder(PHONE_RESPONDER_ID, (payload) =>
      askBridge.askOnce({
        question: payload?.question,
        choices: payload?.choices,
        allowFreeform: payload?.allowFreeform,
        requestId: payload?.requestId,
        withCanvas: true,
      })
    );
    // Override do ask_user cujo handler DESPACHA (celular + mesa), first-to-answer. Ao settled, cancela o card
    // pendente do celular (abortAll) — se OUTRO respondedor venceu, o card do celular não pode ficar pendurado.
    const tool = {
      ...askBridge.tool(),
      handler: async (args) => {
        try {
          const answer = await owner.dispatch(String(args?.question || ""), {
            choices: Array.isArray(args?.choices) ? args.choices.filter((c) => typeof c === "string") : [],
            allowFreeform: args?.allowFreeform !== false,
          });
          return { resultType: "success", textResultForLlm: String(answer ?? "").trim() || "(o usuário não respondeu)" };
        } catch (e) {
          log(`ask-bridge dispatch: ${e?.message || e}`);
          return { resultType: "success", textResultForLlm: "(o usuário não respondeu)" };
        } finally {
          try { askBridge.abortAll(); } catch { /* ignore */ }
        }
      },
    };
    return {
      role: "owner",
      claim,
      owner,
      registered: null,
      tools: [tool],
      canvases: [askBridge.canvas()],
      teardown: () => { try { stopHeartbeat?.(); } catch { /* ignore */ } try { owner.close(); } catch { /* ignore */ } try { askBridge.close?.(); } catch { /* ignore */ } try { claim.release(); } catch { /* ignore */ } },
    };
  }

  // RESPONDEDOR: sem override; /ask → card no celular (sem canvas — o dono cuida do PC).
  const responder = api.createAskBridgeResponder(
    (payload) =>
      askBridge.askOnce({
        question: payload?.question,
        choices: payload?.choices,
        allowFreeform: payload?.allowFreeform,
        requestId: payload?.requestId,
        withCanvas: false,
      }),
    { log }
  );
  const { url } = await responder.start();
  let registered = false;
  const owner = claim.owner;
  if (owner?.loopbackPort && owner?.token) {
    try {
      await api.registerWithOwner(owner.loopbackPort, owner.token, {
        responderId: PHONE_RESPONDER_ID,
        url,
        priority: 0,
        answerTimeoutMs: PHONE_ANSWER_TIMEOUT_MS,
      });
      registered = true;
    } catch (e) {
      log(`ask-bridge registerWithOwner falhou: ${e?.message || e}`);
    }
  } else {
    log("ask-bridge: dono sem loopbackPort/token ainda — respondedor no ar mas não registrado");
  }
  return {
    role: "responder",
    claim,
    responder,
    registered,
    tools: [],
    canvases: [],
    teardown: () => { try { responder.close(); } catch { /* ignore */ } try { askBridge.close?.(); } catch { /* ignore */ } try { claim.release(); } catch { /* ignore */ } },
  };
}

export { PHONE_RESPONDER_ID, PHONE_ANSWER_TIMEOUT_MS };
