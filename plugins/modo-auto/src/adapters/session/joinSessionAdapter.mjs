// Helpers do InterceptPort — modelo RE-JOIN. Provado em `probes/probe-toggle-semantics.mjs`:
// registrar `onUserInputRequest` DINAMICAMENTE (após o join) NÃO habilita a interceptação — o
// `ask_user` só é interceptável quando o handler é passado NO `joinSession`. Então o toggle é:
//   • join SEM handler  → inerte (ask_user nativo, humano responde);
//   • re-join COM handler → armado (a mesa responde).
// Estes helpers são puros (sem SDK): o ciclo de (re)join fica no extension.mjs (que tem o SDK).

// Handler de ask_user a partir do orquestrador (a mesa responde no lugar do humano). FAIL LOUD:
// em erro NÃO devolve uma resposta plausível-fake — devolve um MARCADOR DE ERRO VISÍVEL (pra quem lê
// o ask_user perceber na hora que a mesa quebrou) e loga o erro real.
export function buildAskHandler(orch, { log = () => {} } = {}) {
  return async (request /*, { sessionId } */) => {
    try {
      return await orch.handleQuestion(request);
    } catch (e) {
      const detail = e?.stack || e?.message || String(e);
      log("[modo-auto] ERRO no onQuestion (NÃO mascarado): " + detail);
      return { answer: "[modo-auto ERRO] a mesa falhou ao responder — isto NÃO é uma resposta válida, corrija o modo-auto: " + detail, wasFreeform: true };
    }
  };
}

// OVERRIDE do tool ask_user — PADRÃO REUSADO do copilot-mobile/askUserBridge.mjs. Descoberta-chave: o
// `onUserInputRequest` de quem só se JUNTA (joinSession) NÃO intercepta o ask_user do agente HOST (o app roteia
// pro modal nativo). O que INTERCEPTA é registrar um TOOL chamado "ask_user" com `overridesBuiltInTool:true` em
// joinSession({tools:[...]}): o SDK passa o ask_user do host pra ESTE handler, suprimindo o nativo. Aqui o handler
// manda a pergunta pra MESA (orch.handleQuestion) e devolve a resposta como resultado do tool. FAIL LOUD: erro
// vira marcador VISÍVEL (nunca finge resposta).
export function buildAskUserOverrideTool(orch, { log = () => {} } = {}) {
  return {
    name: "ask_user",
    overridesBuiltInTool: true,
    description: "Ask the user a question and wait for their response.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user." },
        choices: { type: "array", items: { type: "string" }, description: "Optional multiple-choice options." },
        allowFreeform: { type: "boolean", description: "Allow freeform text in addition to choices (default true)." },
      },
      required: ["question"],
    },
    handler: async (args) => {
      try {
        const out = await orch.handleQuestion({
          question: String(args?.question || ""),
          choices: Array.isArray(args?.choices) ? args.choices.filter((c) => typeof c === "string") : [],
          allowFreeform: args?.allowFreeform !== false,
        });
        const text = String(out?.answer ?? "").trim();
        return { resultType: "success", textResultForLlm: text || "[modo-auto: a mesa não produziu resposta — corrija o modo-auto]" };
      } catch (e) {
        const detail = e?.stack || e?.message || String(e);
        log("[modo-auto] ERRO no ask_user override (NÃO mascarado): " + detail);
        return { resultType: "success", textResultForLlm: "[modo-auto ERRO] a mesa falhou ao responder — isto NÃO é uma resposta válida, corrija o modo-auto: " + (e?.message || e) };
      }
    },
  };
}

// Liga o gatilho de PARADA. FAIL LOUD: se a revisão quebra, loga o erro real em nível ERROR e NÃO
// injeta nada nem finge "done" — o erro fica VISÍVEL, não mascarado por um "concluído" silencioso.
export function wireIdle(session, orch, { log = () => {} } = {}) {
  return session.on("session.idle", async () => {
    try {
      const v = await orch.handleStop({ planDir: session.workspacePath });
      if (v && v.done === false && v.continuation) {
        log("stop incompleto → injetando continuação");
        await session.send({ prompt: v.continuation });
      }
    } catch (e) {
      const detail = e?.stack || e?.message || String(e);
      try { session.log?.("[modo-auto] ERRO no stop review (NÃO mascarado — corrija): " + detail, { level: "error" }); } catch { /* sem canal de log */ }
      log("ERRO no stop review: " + detail);
    }
  });
}
