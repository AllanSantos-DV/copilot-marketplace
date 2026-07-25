// deliveryLedger.mjs — ACEITAÇÃO das entregas da mesa, medida POR AÇÃO (redesenho do GAP 3; o plano original usava
// um TIMER de 10min, que VIOLA a regra do dono "controle por atividade, nunca relógio"). Aqui o sinal é ESTRUTURAL
// e DETERMINÍSTICO (Princípio 11, sem inferência semântica): cada ENTREGA (plano do ADR, impl do dev) vira um
// finding hasheável; a PRÓXIMA entrega da sessão RESOLVE as anteriores ainda abertas = "aceita por PROSSEGUIR" (o
// dono seguiu em frente → aceitou o suficiente). Rejeição é EXPLÍCITA (reject(hash)). A entrega mais recente fica
// ABERTA (emitted) até a próxima ação — honesto (ainda não decidido, não inventa aceite). REUSA o findingsTracker
// (hash + lifecycle + metrics.precision) — zero sistema de persistência novo (restrição do plano).
import { createFindingsTracker } from "../shadow/findingsTracker.mjs";

export function createDeliveryLedger({ append, readAll, log = () => {} } = {}) {
  const t = createFindingsTracker({ append, readAll, log });
  let turn = 0;

  return {
    /**
     * Registra uma ENTREGA. AÇÃO: resolve as entregas anteriores ainda ATIVAS (aceitas por prosseguir) e emite a
     * nova como ABERTA. Determinístico: "houve uma nova entrega" é um evento concreto, não um relógio.
     * @returns {Promise<{hash, emitted, accepted:string[]}>} accepted = hashes que ESTA entrega resolveu (aceitou).
     */
    async deliver(artifact, { kind = "entrega" } = {}) {
      turn++;
      const accepted = [];
      for (const f of t.active()) { try { t.transition(f.hash, "resolved", { turn }); accepted.push(f.hash); } catch { /* já terminal */ } }
      const text = `[${kind}] ${String(artifact || "").replace(/\s+/g, " ").trim().slice(0, 400)}`;
      const r = await t.emit(text, { turn });
      if (accepted.length) log(`[entregas] ${accepted.length} entrega(s) anterior(es) aceita(s) por prosseguir`);
      return { hash: r.hash, emitted: r.emitted, accepted };
    },

    // Rejeição EXPLÍCITA de uma entrega pelo hash (o dono disse "não presta"). FAIL LOUD: hash desconhecido lança.
    reject(hash) { return t.transition(String(hash), "rejected", { turn }); },

    // Entregas ainda ABERTAS (aguardando a próxima ação ou rejeição). A última entrega sempre está aqui.
    open() { return t.active().map((f) => ({ hash: f.hash, text: f.text })); },

    // taxa de ACEITAÇÃO = resolved/(resolved+rejected) via a métrica JÁ EXISTENTE. null se nada decidido (honesto).
    metrics() { return t.metrics(); },
    // estado de uma entrega pelo hash (p/ correlacionar custo×aceitação no readout). null se desconhecida.
    stateOf(hash) { return t.stateOf(String(hash)); },
  };
}
