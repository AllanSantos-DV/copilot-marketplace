// DETECÇÃO DE GAPS (tel-2) — regras DETERMINÍSTICAS sobre os spans de telemetria (tel-1). Princípio 11: a
// detecção é TOOL (sem LLM). Lê os spans (telemetrySink.read) e aponta onde a mesa "trava": falha, timeout,
// latência e churn (mesmo papel repetido demais numa run = re-tentativas/re-fills sem convergir). Agrupa por
// traceId (a run inteira). O agente de auto-melhoria (tel-3) consome esse relatório. Puro/testável.

const DEFAULTS = { latencyMs: 150000, churnCount: 3, efficacyRounds: 3, loopLatencyMs: 300000, qualityDropPct: 30, minBaseline: 50, compareN: 50, baselineWindowMs: 30 * 24 * 3600 * 1000, f5EscalationPct: 1, f5MinSample: 200 };

function countByType(gaps) { const c = {}; for (const g of gaps) c[g.type] = (c[g.type] || 0) + 1; return c; }

/**
 * @param {object[]} spans  spans persistidos (telemetrySink.read)
 * @param {{ latencyMs?:number, churnCount?:number }} [opts]
 * @returns {{ gaps:object[], byTrace:Record<string,object[]>, counts:Record<string,number> }}
 */
export function detectGaps(spans, opts = {}) {
  const { latencyMs, churnCount, efficacyRounds, loopLatencyMs, qualityDropPct, minBaseline, compareN, baselineWindowMs, f5EscalationPct, f5MinSample } = { ...DEFAULTS, ...opts };
  const now = Number(opts.now) || Date.now();
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
      // LOOP-LATENCY (E1): o CICLO de remediation (todos os rounds) estourou — o LOOP é o multiplicador, não a chamada
      // única. elapsedCycleMs vem do reviewUntilClean via recordVerdict. Surfaça o gargalo que o totalMs sozinho não cobre.
      if (typeof v.elapsedCycleMs === "number" && v.elapsedCycleMs > loopLatencyMs) gaps.push({ type: "loop-latency", traceId, role: s.role || "tech-lead", stage: s.stage || "dev", detail: `ciclo de remediation ${v.elapsedCycleMs}ms > ${loopLatencyMs}ms em ${v.rounds ?? "?"} rodada(s) — o LOOP é o multiplicador (E1)` });
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

  // QUALITY-REGRESSION (Fase 0, E2): canário de queda catastrófica de findingsCount (proxy de regressão de qualidade
  // quando otimizamos latência) — SEM os furos do painel deep: (a) cold-start (baseline < minBaseline → null); (b)
  // threshold ÚNICO qualityDropPct (aceite==alerta, sem dead-zone); (c) anticontaminação POR CONTAGEM.
  const qr = detectQualityRegression(list, { qualityDropPct, minBaseline, compareN, baselineWindowMs, now });
  if (qr) gaps.push(qr);

  // F5 — o disjuntor do revisor está CONSTRUÍDO e ATIVO por default (modoDev L106: `createCircuitBreaker({ log })`).
  // Este gatilho nasceu na época em que o F5 estava ADIADO por ROI (escalações em 0,07% dos spans) e servia para
  // avisar "a premissa mudou, hora de CONSTRUIR". Isso já aconteceu — manter o texto antigo criava divergência
  // entre plano e código e fazia a auditoria pedir, em loop, uma decisão já tomada.
  // O gatilho continua ÚTIL, com outro significado: com o disjuntor ligado, escalação alta não é mais "falta o
  // disjuntor" e sim "o disjuntor está abrindo demais (limiar sensível) OU há um problema real de qualidade que
  // ele está apenas revelando". Os dois exigem olhar humano — por isso o sinal fica.
  const escalations = gaps.filter((g) => g.type === "escalation").length;
  if (list.length >= f5MinSample) {
    const pct = (escalations / list.length) * 100;
    if (pct >= f5EscalationPct) gaps.push({ type: "tune-circuit-breaker", traceId: null, role: "mesa", stage: "dev", detail: `escalações em ${pct.toFixed(2)}% (${escalations}/${list.length}) >= ${f5EscalationPct}% — o disjuntor do revisor (F5, ATIVO por default) está escalando muito: revisar o limiar (failThreshold/halfOpenAfterMs) ou investigar a causa real das falhas do revisor` });
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

// CANÁRIO de regressão de qualidade (puro). Retorna o gap ou null (incl. null SINALIZADO em cold-start). Endereça os 3
// furos do painel deep: (a) COLD-START — sem baseline suficiente NÃO emite; (b) THRESHOLD ÚNICO — aceite==alerta, sem
// dead-zone; (c) ANTICONTAMINAÇÃO POR CONTAGEM — recent = últimos compareN; baseline = os ANTERIORES a esses, dentro
// de baselineWindowMs → NUNCA se sobrepõem (independe de quantos dias passaram).
export function detectQualityRegression(spans, { qualityDropPct = 30, minBaseline = 50, compareN = 50, baselineWindowMs = 30 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const v3 = (Array.isArray(spans) ? spans : [])
    .filter((s) => s && Number(s.spanVersion) >= 3 && typeof s.findingsCount === "number")
    .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
  if (v3.length <= compareN) return null; // sem histórico além da janela de comparação → cold-start
  const recent = v3.slice(-compareN);
  const floor = now - baselineWindowMs;
  const baseline = v3.slice(0, v3.length - compareN).filter((s) => (Number(s.startedAt) || 0) >= floor);
  if (baseline.length < minBaseline) return null; // COLD-START: baseline insuficiente → sem gap (não é ruído)
  const avg = (arr) => arr.reduce((m, s) => m + Number(s.findingsCount || 0), 0) / arr.length;
  const base = avg(baseline), rec = avg(recent);
  if (base <= 0) return null; // sem sinal no baseline → não dá pra afirmar queda
  const dropPct = ((base - rec) / base) * 100;
  if (dropPct <= qualityDropPct) return null;
  return { type: "quality-regression", traceId: null, role: "mesa", stage: "quality", detail: `findingsCount caiu ${dropPct.toFixed(1)}% (baseline ${base.toFixed(1)} → recente ${rec.toFixed(1)}; > ${qualityDropPct}%, ${baseline.length} spans de baseline)` };
}
