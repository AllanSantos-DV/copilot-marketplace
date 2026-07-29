// spanSchema.mjs — 8º EIXO do plano de melhoria: "investigar se há MAIS sinais que valem capturar". O entregável
// é ESTE artefato: a TAXONOMIA dos spans (o que cada tipo DEVE carregar) + uma AUDITORIA que mede a cobertura real.
// Sem isto, decidir "o que instrumentar a seguir" é palpite; com isto, o modo_melhoria mostra os buracos medidos.
//
// Por que nem todo span é v3: os campos obrigatórios de v3 (inputTokens/outputTokens/inputLines) descrevem uma
// CHAMADA DE MODELO. Um span de ORQUESTRAÇÃO (marcador de consolidação/rota) não tem tokens — forçar v3 nele seria
// inventar dado. Cada KIND tem, então, seus próprios campos esperados. Puro/determinístico (Princípio 11).

export const SPAN_KINDS = Object.freeze([
  {
    kind: "worker-call",
    describe: "chamada real de modelo (um papel da mesa rodando)",
    match: (s) => !!s.role && s.stage !== "dev-verdict" && s.stage !== "sombra-consolidation" && s.stage !== "adr-route",
    required: ["role", "durationMs", "status"],
    v3: ["inputTokens", "outputTokens", "inputLines"], // promovem o span a v3 (auto-gate no activityRegistry)
    optional: ["usage", "model", "taskType", "endReason", "findingsCount"],
  },
  {
    kind: "dev-verdict",
    describe: "veredito de uma fase do modo-dev (eficácia do ciclo)",
    match: (s) => s.stage === "dev-verdict",
    required: ["verdict"],
    v3: [],
    optional: ["verdict.rounds", "verdict.elapsedCycleMs", "verdict.escalate", "verdict.exhausted", "verdict.budgetExhausted", "verdict.f1Arm"],
  },
  {
    kind: "shadow-consolidation",
    describe: "consolidação do modo-sombra (drift + custo da consolidação)",
    match: (s) => s.stage === "sombra-consolidation",
    required: ["role", "durationMs", "drift"],
    v3: [],
    optional: ["distance", "method", "injected", "vivo", "deep", "threshold"],
  },
  {
    kind: "adr-route",
    describe: "decisão do roteador de complexidade do ADR",
    match: (s) => s.stage === "adr-route",
    required: ["path", "tier", "source"],
    v3: [],
    optional: ["ambiguous"],
  },
]);

const dig = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * AUDITORIA de cobertura dos sinais. Para cada KIND: quantos spans existem e qual % traz cada campo esperado.
 * Devolve também `gaps` = os campos com cobertura abaixo de `minCoveragePct` (o que instrumentar a seguir).
 * @returns {{ total:number, kinds:object[], gaps:{kind:string, field:string, coveragePct:number, required:boolean}[] }}
 */
export function auditSpans(spans, { minCoveragePct = 90 } = {}) {
  const list = (Array.isArray(spans) ? spans : []).filter((s) => s && typeof s === "object");
  const kinds = [];
  const gaps = [];
  for (const k of SPAN_KINDS) {
    const rows = list.filter((s) => { try { return k.match(s); } catch { return false; } });
    const fields = {};
    const check = (field, required) => {
      const have = rows.filter((s) => dig(s, field) !== undefined && dig(s, field) !== null).length;
      const coveragePct = pct(have, rows.length);
      fields[field] = { have, coveragePct, required };
      if (rows.length && coveragePct < minCoveragePct) gaps.push({ kind: k.kind, field, coveragePct, required });
    };
    for (const f of k.required) check(f, true);
    for (const f of k.v3) check(f, false);
    for (const f of k.optional) check(f, false);
    kinds.push({ kind: k.kind, describe: k.describe, count: rows.length, v3Count: rows.filter((s) => Number(s.spanVersion) >= 3).length, fields });
  }
  return { total: list.length, kinds, gaps };
}

// Linha legível p/ tool/painel: o que já medimos e o que falta (o 8º eixo em uma tela).
export function formatSpanAudit(audit) {
  if (!audit || !audit.total) return "cobertura de sinais: nenhuma telemetria ainda";
  const linhas = audit.kinds.filter((k) => k.count).map((k) => `  ${k.kind} (${k.count}${k.v3Count ? `, ${k.v3Count} em v3` : ""}): ${k.describe}`);
  const buracos = audit.gaps.length
    ? audit.gaps.slice(0, 8).map((g) => `  ${g.required ? "⛔" : "•"} ${g.kind}.${g.field} — só ${g.coveragePct}% dos spans trazem${g.required ? " (OBRIGATÓRIO)" : ""}`)
    : ["  (nenhum buraco acima do limiar — a coleta cobre os campos esperados)"];
  return `cobertura de sinais (${audit.total} spans):\n${linhas.join("\n")}\nSINAIS FALTANDO (o que instrumentar a seguir):\n${buracos.join("\n")}`;
}
