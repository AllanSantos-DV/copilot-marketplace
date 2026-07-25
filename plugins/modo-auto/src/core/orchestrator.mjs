// NÚCLEO (core) — orquestra a mesa. É AGNÓSTICO: não conhece SDK, UI nem o tipo de perfil.
// Recebe um adapter de PERFIL (ProfilePort) e as capacidades (ports) e apenas roteia os gatilhos
// (pergunta / parada) para o perfil, devolvendo o contrato esperado pelo InterceptPort.
//
// Regra do dono: CORE ESTÁVEL, comportamento nos ADAPTERS. Trocar o "tipo de mesa" = trocar o perfil.

/**
 * @param {object} deps
 * @param {import("./ports.mjs").ProfilePort} deps.profile  O adapter de perfil (comportamento).
 * @param {object} [deps.caps]  Capacidades a repassar ao perfil (plan, memory, factory, gates, inject…).
 * @param {(m:string)=>void} [deps.log]
 */
export function createOrchestrator({ profile, caps = {}, log = () => {} }) {
  if (!profile || typeof profile.onQuestion !== "function" || typeof profile.onStop !== "function") {
    throw new Error("orchestrator: profile invalido (precisa de id + onQuestion + onStop)");
  }
  const id = profile.id || "?";

  return {
    profileId: id,

    /** Gatilho de ask_user: delega ao perfil. FAIL LOUD — não mascara: se o perfil não devolver
     *  { answer:string }, LANÇA (o erro real sobe em vez de virar uma resposta vazia/fake). */
    async handleQuestion(request, extra = {}) {
      log(`[core] question -> perfil "${id}": ${request?.question ?? ""}`);
      const out = await profile.onQuestion(request, { ...caps, ...extra });
      if (!out || typeof out.answer !== "string") {
        throw new Error(`orchestrator.handleQuestion: perfil "${id}" nao devolveu { answer:string } — devolveu ${JSON.stringify(out)}`);
      }
      return { answer: out.answer, wasFreeform: out.wasFreeform !== false };
    },

    /** Gatilho de parada. FAIL LOUD — se o perfil não devolver { done:boolean }, LANÇA (não finge "done"). */
    async handleStop(extra = {}) {
      log(`[core] stop -> perfil "${id}"`);
      const v = await profile.onStop({ ...caps, ...extra });
      if (!v || typeof v.done !== "boolean") {
        throw new Error(`orchestrator.handleStop: perfil "${id}" nao devolveu { done:boolean } — devolveu ${JSON.stringify(v)}`);
      }
      return { done: v.done, continuation: v.done ? null : (v.continuation || null) };
    },
  };
}
