// Rotação ANTI-VIÉS de revisores. Insight do dono: o MESMO revisor (papel+modelo) satura — após ~2 passadas
// ele ancora na própria leitura e o ganho decai (echo chamber). Então cada "identidade de revisor" é limitada
// a `cap` rodadas; ao estourar, TROCA. Prioridade de troca: (1) MODELO — família diferente = pontos-cegos
// diferentes, quebra mais viés; (2) PAPEL — lente diferente (consolidador → adversarial). Determinístico por
// rodada, puro/testável. FAIL LOUD: cap inválido ou sem papéis → LANÇA (não roda sem revisor definido).

/**
 * @param {{ models?: (string|null)[], roles?: string[], cap?: number }} opts
 *   models: modelos disponíveis em ordem de preferência (do router). [] = sem rotação de modelo.
 *   roles:  papéis-revisor em ordem (ex.: ["tech-lead","revisor"]). O 1º é o primário.
 *   cap:    máx. de rodadas por identidade antes de trocar (default 2 — a regra do dono).
 */
export function createReviewerRotation({ models = [], roles = ["tech-lead"], cap = 2 } = {}) {
  if (!(Number.isInteger(cap) && cap >= 1)) throw new Error("reviewerRotation: cap deve ser inteiro >= 1");
  if (!Array.isArray(roles) || !roles.length) throw new Error("reviewerRotation: roles vazio");
  const ms = models.length ? models : [null];

  // Pool ordenado de identidades: MODELO primeiro (papel primário em cada modelo), depois PAPÉIS alternativos
  // no melhor modelo. Assim as trocas iniciais mudam de família de modelo (maior quebra de viés).
  const pool = [];
  for (const m of ms) pool.push({ role: roles[0], model: m });
  for (let i = 1; i < roles.length; i++) pool.push({ role: roles[i], model: ms[0] });

  return {
    pool,
    size: pool.length,
    cap,
    // Identidade do revisor p/ a rodada (0-based). Satura no último quando as rodadas passam do pool.
    for(round) {
      const idx = Math.floor(Math.max(0, Number(round) || 0) / cap);
      const clamped = Math.min(idx, pool.length - 1);
      const v = pool[clamped];
      return { role: v.role, model: v.model, variant: clamped, rotated: clamped > 0, saturated: idx >= pool.length };
    },
  };
}
