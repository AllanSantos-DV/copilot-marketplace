// MOTOR DA MESA VIVA — orquestra o ciclo completo do debate real, amarrando as peças das fases 1–5:
// abre os agentes vivos (open) → gira a roda até convergir/cap (runDebate) → fecho com a deliberação
// inteira (finalize) → snapshot dos sessionIds (pra reabrir). É o que o `modo_adr` (e depois dev/sombra)
// usam no lugar do fan-out/fan-in. SEMPRE fecha a mesa (try/finally) — não deixa processos órfãos.

import { createLiveTable } from "./liveTable.mjs";

/**
 * @param {(agent)=>object} makeWorker  fábrica de worker vivo (createLiveWorker)
 * @param {{ order?:string[], log?:(m:string)=>void }} [opts]
 */
export function createLiveMesa(makeWorker, { order = [], log = () => {} } = {}) {
  return {
    /**
     * Roda um debate COMPLETO e devolve o documento consolidado + o material pra persistir/reabrir.
     * @param {string} subject
     * @param {{ agents:{role,system,model?}[], writeDoc:Function, minRounds?:number, maxRounds?:number,
     *          facilitatorRole?:string, timeoutMs?:number, extra?:Function }} opts
     * @returns {Promise<{document:string, synthesis:string, transcript:object[], rendered:string,
     *          snapshot:{role,sessionId}[], converged:boolean, rounds:number}>}
     */
    async run(subject, { agents, writeDoc, minRounds = 2, maxRounds = 4, facilitatorRole = "facilitador", timeoutMs = 150000, extra, embedder = null, order: orderOverride = null } = {}) {
      const s = String(subject || "").trim();
      if (!s) throw new Error("liveMesa.run: assunto vazio");
      if (typeof writeDoc !== "function") throw new Error("liveMesa.run: writeDoc ausente");
      const table = createLiveTable(makeWorker, { order: orderOverride || order, log }); // ordem por-chamada (ex.: modo_reuso tem papéis próprios)
      try {
        await table.open(agents); // FAIL LOUD se nenhum agente sobe
        const deb = await table.runDebate(s, { minRounds, maxRounds, judgeRole: facilitatorRole, timeoutMs, extra, embedder });
        const fin = await table.finalize(s, { writeDoc, facilitatorRole, timeoutMs });
        const snapshot = table.snapshot();
        log(`[mesa-viva] debate: ${deb.rounds} voltas, convergiu=${deb.converged} → documento ${fin.document.length} chars`);
        return {
          document: fin.document, synthesis: fin.synthesis,
          transcript: table.transcript, rendered: fin.transcript,
          snapshot, converged: deb.converged, rounds: deb.rounds,
        };
      } finally {
        table.close(); // sempre encerra as sessões vivas (sem processos órfãos)
      }
    },

    /**
     * CONTESTAÇÃO viva (SEM facilitador/writeDoc): abre a mesa, gira `rounds` voltas turno-a-turno e devolve
     * o texto do ÚLTIMO turno de `targetRole` (o consolidador). É o que o modo-sombra usa no handoff — seu
     * fecho é o ancora-realidade retornando JSON estruturado, não um facilitador. SEMPRE fecha a mesa.
     * @param {string} subject
     * @param {{ agents:{role,system,model?}[], targetRole:string, order?:string[], rounds?:number, extra?:Function, timeoutMs?:number }} opts
     * @returns {Promise<{ targetText:string, rendered:string, transcript:object[], snapshot:{role,sessionId}[], rounds:number }>}
     */
    async runContest(subject, { agents, targetRole, order: contestOrder, rounds = 2, extra, timeoutMs = 120000 } = {}) {
      const s = String(subject || "").trim();
      if (!s) throw new Error("liveMesa.runContest: assunto vazio");
      if (!targetRole) throw new Error("liveMesa.runContest: targetRole ausente");
      const table = createLiveTable(makeWorker, { order: contestOrder || order, log });
      try {
        const roles = await table.open(agents); // FAIL LOUD se nenhum sobe
        if (!roles.includes(targetRole)) throw new Error(`liveMesa.runContest: alvo '${targetRole}' não subiu na mesa (${roles.join(", ")})`);
        const n = Math.max(1, rounds);
        for (let i = 0; i < n; i++) await table.runRound(s, { timeoutMs, extra }); // gira a roda (contestação)
        const target = [...table.transcript].reverse().find((t) => t.role === targetRole && t.ok && t.text);
        if (!target) throw new Error(`liveMesa.runContest: alvo '${targetRole}' não produziu texto em ${n} volta(s)`);
        log(`[mesa-viva] contestação: ${n} volta(s) → alvo ${targetRole} (${target.text.length} chars)`);
        return { targetText: target.text, rendered: table.render(), transcript: table.transcript, snapshot: table.snapshot(), rounds: table.rounds };
      } finally {
        table.close(); // sempre encerra as sessões vivas
      }
    },
  };
}
