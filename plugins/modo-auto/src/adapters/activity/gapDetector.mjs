// DETECÇÃO DE GAPS (tel-2) — regras DETERMINÍSTICAS sobre os spans de telemetria (tel-1). Princípio 11: a
// detecção é TOOL (sem LLM). Lê os spans (telemetrySink.read) e aponta onde a mesa "trava": falha, timeout,
// latência e churn (mesmo papel repetido demais numa run = re-tentativas/re-fills sem convergir). Agrupa por
// traceId (a run inteira). O agente de auto-melhoria (tel-3) consome esse relatório. Puro/testável.

const DEFAULTS = { latencyMs: 150000, churnCount: 3, efficacyRounds: 3 };

function countByType(gaps) { const c = {}; for (const g of gaps) c[g.type] = (c[g.type] || 0) + 1; return c; }

/**
 * @param {object[]} spans  spans persistidos (telemetrySink.read)
 * @param {{ latencyMs?:number, churnCount?:number }} [opts]
 * @returns {{ gaps:object[], byTrace:Record<string,object[]>, counts:Record<string,number> }}
 */
export function detectGaps(spans, opts = {}) {
  const { latencyMs, churnCount, efficacyRounds } = { ...DEFAULTS, ...opts };
  const list = Array.isArray(spans) ? spans : [];
  const gaps = [];
  const perTraceRole = new Map(); // `${traceId}|${role}` → nº de execuções (churn)

  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const traceId = s.traceId || null;
    // EFICÁCIA (GAP 2): só spans v2 (spanVersion >= 2) COM `verdict` (o veredito de uma fase do modo-dev). O
    // discriminante é o spanVersion declarado (contrato do plano: "avalia apenas spans v2+"), e o verdict é o dado.
    // Determinístico (aritmética). ESGOTOU sem passar OU escalou = a mesa NÃO resolveu sozinha; muitas rodadas =
    // convergiu com dificuldade. Spans v1 legados (sem spanVersion) NÃO entram nesta regra.
    if (s.spanVersion >= 2 && s.verdict && typeof s.verdict === "object") {
      const v = s.verdict;
      if (v.escalate) gaps.push({ type: "escalation", traceId, role: s.role || "tech-lead", stage: s.stage || "dev", detail: String(v.escalate).slice(0, 160) });
      if (v.exhausted || (typeof v.rounds === "number" && v.rounds > efficacyRounds)) gaps.push({ type: "low-efficacy", traceId, role: s.role || "tech-lead", stage: s.stage || "dev", detail: `${v.rounds} rodada(s)${v.exhausted ? " (ESGOTOU sem passar)" : ""}${v.mustFixCount ? ", " + v.mustFixCount + " mustFix" : ""}` });
    }
    if (s.status === "fail") {
      // ESTRUTURADO-PRIMEIRO (Princípio 11): o campo `endReason` (idle|hung|hardcap|error) foi criado
      // EXATAMENTE p/ classificar sem depender de string. hung/hardcap = classe timeout; error = fail.
      // A regex do snippet é só FALLBACK p/ spans ANTIGOS sem endReason (back-compat) — assim mudar o
      // WORDING do erro NÃO quebra a detecção silenciosamente (era o acoplamento por string apontado).
      let type;
      if (s.endReason === "hung" || s.endReason === "hardcap") type = "timeout";
      else if (s.endReason === "error") type = "fail";
      else type = /timeout|timed out|Timeout after|session\.idle|hung|sem atividade/i.test(s.snippet || "") ? "timeout" : "fail";
      gaps.push({ type, traceId, role: s.role || "?", stage: s.stage || null, detail: String(s.snippet || "").slice(0, 160) });
    }
    if (typeof s.durationMs === "number" && s.durationMs > latencyMs) {
      gaps.push({ type: "latency", traceId, role: s.role || "?", stage: s.stage || null, detail: `${s.durationMs}ms > ${latencyMs}ms` });
    }
    const k = `${traceId || "?"}|${s.role || "?"}`;
    perTraceRole.set(k, (perTraceRole.get(k) || 0) + 1);
  }

  for (const [k, n] of perTraceRole) {
    const i = k.indexOf("|");
    const traceId = k.slice(0, i);
    if (traceId === "?") continue; // sem traceId → não dá pra afirmar "mesma run"; não conta churn (evita falso positivo entre runs distintas)
    if (n >= churnCount) gaps.push({ type: "churn", traceId, role: k.slice(i + 1), detail: `${n} execuções do mesmo papel na run (re-tentativas/re-fills)` });
  }

  const byTrace = {};
  for (const g of gaps) (byTrace[g.traceId || "?"] ||= []).push(g);
  return { gaps, byTrace, counts: countByType(gaps) };
}

/** Lê os spans persistidos e detecta os gaps. `limit` limita a janela (últimos N spans). */
export function gapsFromSink(sink, { limit = 0, ...opts } = {}) {
  if (!sink || typeof sink.read !== "function") throw new Error("gapsFromSink: sink inválido");
  return detectGaps(sink.read({ limit }), opts);
}
