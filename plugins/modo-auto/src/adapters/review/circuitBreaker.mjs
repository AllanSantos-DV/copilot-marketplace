// circuitBreaker.mjs — F5 do plano de melhoria: DISJUNTOR do revisor. Fecha o gap "existia só o gatilho de
// reavaliação, sem nenhuma lógica que INTERROMPA o ciclo e roteie ao humano" — infra sem efeito.
//
// PROBLEMA REAL (proposta 7 da auto-melhoria): quando o revisor FALHA de verdade (worker morto, timeout, erro de
// infra), o laço tenta de novo, falha de novo, e o ciclo vira retry→timeout→retry→escalação — caro e lento, e o
// humano recebe a escalação SEM o contexto que já tinha sido coletado.
//
// MÁQUINA DE 3 ESTADOS (o painel deep exigiu o half-open — sem ele um pico transitório abriria o circuito PARA
// SEMPRE): closed → (N falhas consecutivas) → open → (após halfOpenAfterMs) → half-open → sucesso: closed |
// falha: open de novo. Puro/determinístico: relógio injetado, zero I/O (Princípio 11).

export const BREAKER_DEFAULTS = Object.freeze({ failThreshold: 2, halfOpenAfterMs: 60000 });

/**
 * @param {{ failThreshold?:number, halfOpenAfterMs?:number, now?:()=>number, log?:(m:string)=>void }} [opts]
 */
export function createCircuitBreaker({ failThreshold = BREAKER_DEFAULTS.failThreshold, halfOpenAfterMs = BREAKER_DEFAULTS.halfOpenAfterMs, now = () => Date.now(), log = () => {} } = {}) {
  if (!(Number.isInteger(failThreshold) && failThreshold >= 1)) throw new Error("createCircuitBreaker: failThreshold deve ser inteiro >= 1");
  if (!(Number.isFinite(halfOpenAfterMs) && halfOpenAfterMs >= 0)) throw new Error("createCircuitBreaker: halfOpenAfterMs deve ser >= 0");

  let consecutive = 0, openedAt = null, lastError = null;

  // Estado DERIVADO do relógio (não precisa de timer): open vira half-open sozinho depois da janela.
  const state = () => {
    if (openedAt == null) return "closed";
    return now() - openedAt >= halfOpenAfterMs ? "half-open" : "open";
  };

  return {
    state,
    get lastError() { return lastError; },
    get consecutiveFailures() { return consecutive; },

    // Pode tentar? closed e half-open SIM (half-open = 1 tentativa de sondagem); open NÃO (curto-circuito).
    canAttempt() { return state() !== "open"; },

    onSuccess() {
      if (state() === "half-open") log("[breaker] half-open → sucesso: FECHANDO o circuito");
      consecutive = 0; openedAt = null; lastError = null;
    },

    // Registra falha REAL (erro/timeout do revisor — NÃO reprovação, que é veredito legítimo).
    onFailure(err) {
      lastError = err ? String(err.message || err).slice(0, 200) : "erro desconhecido";
      if (state() === "half-open") { openedAt = now(); log(`[breaker] half-open → falhou de novo: REABRINDO (${lastError})`); return state(); }
      consecutive++;
      if (consecutive >= failThreshold && openedAt == null) { openedAt = now(); log(`[breaker] ${consecutive} falhas consecutivas do revisor → ABRINDO o circuito (${lastError})`); }
      return state();
    },

    // Mensagem de ESCALAÇÃO com o contexto PARCIAL já coletado (o ponto da proposta: não recomeçar do zero).
    escalationMessage(partial = {}) {
      const bits = [];
      if (partial.round != null) bits.push(`rodada ${partial.round}`);
      if (partial.gates?.length) bits.push(`gates: ${partial.gates.map((g) => `${g.gate}=${g.ok ? "ok" : "falhou"}`).join(", ")}`);
      if (partial.qa) bits.push(`QA (parcial): ${String(partial.qa).replace(/\s+/g, " ").slice(0, 300)}`);
      if (partial.findings?.length) bits.push(`achados até aqui: ${partial.findings.slice(0, 5).join("; ")}`);
      return `CIRCUITO ABERTO no revisor após ${consecutive} falha(s) consecutiva(s) (${lastError || "?"}). NÃO recomecei do zero — segue o contexto PARCIAL já coletado para decisão humana:\n${bits.length ? "- " + bits.join("\n- ") : "(nenhum contexto parcial disponível)"}`;
    },

    reset() { consecutive = 0; openedAt = null; lastError = null; },
  };
}
