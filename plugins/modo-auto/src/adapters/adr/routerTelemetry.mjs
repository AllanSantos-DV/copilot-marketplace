// routerTelemetry.mjs — AGREGA as decisões do roteador de complexidade do ADR (Princípio 11: coleta determinística).
// Reusa o telemetrySink (spans stage="adr-route"): cada buildPlan persiste { tier, path, ambiguous, source }. Aqui
// só a AGREGAÇÃO pura (contadores) — o safety-net do express deixa de operar às cegas: dá pra ver quanto vai por
// express|mini|full, quanto cai na zona cinzenta (ambíguo) e quanto exigiu desempate LLM. Puro/testável, sem I/O.

export const ADR_ROUTE_STAGE = "adr-route";

// Monta o span de uma decisão de rota (o extension persiste no telemetry sink). Forma estável p/ o agregador.
export function routeSpan(decision = {}) {
  return {
    stage: ADR_ROUTE_STAGE,
    status: "done",
    tier: String(decision.tier || "?"),
    path: String(decision.path || "?"),
    ambiguous: !!decision.ambiguous,
    source: String(decision.source || "?"),
    startedAt: Date.now(),
  };
}

const PATHS = ["express", "mini", "full"];
const TIERS = ["trivial", "simples", "medio", "complexo"];
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // 1 casa decimal

/**
 * Agrega os spans de rota. Ignora spans de outros stages. Devolve contadores + percentuais.
 * @param {Array<object>} spans
 * @param {{windowMs?:number, now?:number}} [opts]  windowMs>0 → só spans com startedAt dentro da janela (anti-congelamento).
 * @returns {{ total:number, byPath:Record<string,number>, byTier:Record<string,number>,
 *             ambiguousPct:number, llmTiebreakPct:number, overridePct:number, byPathPct:Record<string,number> }}
 */
export function aggregateRoutes(spans = [], { windowMs = 0, now = Date.now() } = {}) {
  let rows = (Array.isArray(spans) ? spans : []).filter((s) => s && s.stage === ADR_ROUTE_STAGE);
  // JANELA DESLIZANTE (anti-congelamento): com windowMs, considera só os spans dentro da janela temporal — senão o
  // agregado acumula desde sempre e os % congelam (a amostra fica enorme e dilui as mudanças recentes; alerta vira
  // permanente ou nunca dispara). Sem windowMs → tudo (retrocompat).
  if (windowMs > 0) { const floor = (Number(now) || 0) - windowMs; rows = rows.filter((s) => (Number(s.startedAt) || 0) >= floor); }
  const byPath = Object.fromEntries(PATHS.map((p) => [p, 0]));
  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let ambiguous = 0, llmTiebreak = 0, override = 0;
  for (const s of rows) {
    if (byPath[s.path] === undefined) byPath[s.path] = 0;
    byPath[s.path]++;
    if (byTier[s.tier] !== undefined) byTier[s.tier]++;
    if (s.ambiguous) ambiguous++;
    if (s.source === "llm-tiebreak") llmTiebreak++;
    if (s.source === "override") override++;
  }
  const total = rows.length;
  const byPathPct = Object.fromEntries(Object.entries(byPath).map(([k, v]) => [k, pct(v, total)]));
  return {
    total,
    byPath, byPathPct, byTier,
    ambiguousPct: pct(ambiguous, total),
    llmTiebreakPct: pct(llmTiebreak, total),
    overridePct: pct(override, total),
  };
}

// Linha legível p/ o status/tool. Ex.: "ADR rotas (12): express 25% · mini 41.7% · full 33.3% · zona-cinza 16.7% · LLM-desempate 8.3%".
export function formatRouteLine(agg) {
  if (!agg || !agg.total) return "ADR rotas: nenhuma decisão registrada ainda";
  const p = agg.byPathPct;
  return `ADR rotas (${agg.total}): express ${p.express}% · mini ${p.mini}% · full ${p.full}% · zona-cinza ${agg.ambiguousPct}% · LLM-desempate ${agg.llmTiebreakPct}%` +
    (agg.overridePct ? ` · override ${agg.overridePct}%` : "");
}

// MONITOR + ALERTA (humano no loop) — NÃO é closed-loop: detecta o desvio e AVISA; quem recalibra os thresholds é o
// HUMANO (detect→notify→humano decide/edita/redeploy). A telemetria deixa de ser passiva, mas o loop se fecha no dev.
// Só dispara com amostra mínima (senão % é ruído). Sinais: (a) zona-cinza alta → thresholds do classify indecisos;
// (b) LLM-desempate alto → gastando modelo pra decidir; (c) full dominante → o roteador quase nunca economiza. null=saudável.
export const ROUTE_ALERT_DEFAULTS = Object.freeze({ minSample: 8, grayZoneMaxPct: 45, llmTiebreakMaxPct: 30, fullMaxPct: 85 });
export const ROUTE_ALERT_THROTTLE_MS = 24 * 3600 * 1000; // cooldown do alerta automático (anti alert-fatigue)
export const ROUTE_WINDOW_MS = 14 * 24 * 3600 * 1000;    // janela deslizante padrão do alerta automático (14d)

// Condições disparadas com CHAVE estável — base do texto E da assinatura de cooldown (a chave NÃO muda com flutuação
// de 1% no valor; só muda quando um sinal entra/sai da faixa). Amostra insuficiente → [] (sem alerta, não é ruído).
function alertIssues(agg, opts = {}) {
  const { minSample, grayZoneMaxPct, llmTiebreakMaxPct, fullMaxPct } = { ...ROUTE_ALERT_DEFAULTS, ...opts };
  if (!agg || agg.total < minSample) return [];
  const out = [];
  if (agg.ambiguousPct > grayZoneMaxPct) out.push({ key: "zona-cinza", msg: `zona-cinza ${agg.ambiguousPct}% (> ${grayZoneMaxPct}%) — os thresholds do classify estão indecisos; recalibre THRESHOLDS/pesos em complexityRouter.mjs` });
  if (agg.llmTiebreakPct > llmTiebreakMaxPct) out.push({ key: "llm-desempate", msg: `LLM-desempate ${agg.llmTiebreakPct}% (> ${llmTiebreakMaxPct}%) — muito gasto de modelo pra decidir a rota; aperte os thresholds pra resolver mais no determinístico` });
  if (agg.byPathPct.full > fullMaxPct) out.push({ key: "full", msg: `full ${agg.byPathPct.full}% (> ${fullMaxPct}%) — o roteador quase nunca economiza a mesa; o classify pode estar subestimando trivial/simples` });
  return out;
}

export function routeAlert(agg, opts = {}) {
  const issues = alertIssues(agg, opts);
  if (!issues.length) return null;
  return `⚠️ ADR roteador (amostra ${agg.total}): ${issues.map((i) => i.msg).join(" · ")}.`;
}

// Assinatura ESTÁVEL do alerta = as chaves dos sinais disparados (ordenadas). Deixa o cooldown re-emitir só quando o
// CONJUNTO de sinais muda (não a cada 1% de flutuação). null quando não há alerta.
export function routeAlertSig(agg, opts = {}) {
  const keys = alertIssues(agg, opts).map((i) => i.key).sort();
  return keys.length ? keys.join("+") : null;
}

// COOLDOWN/SNOOZE do alerta AUTOMÁTICO (anti alert-fatigue): re-emite só se a assinatura MUDOU ou se passou throttleMs
// desde a última emissão. Pura/testável — o estado (lastSig/lastTs) é persistido pelo caller (cursor do proposalStore).
// O modo_rotas (consulta MANUAL) NÃO usa isto — mostra o alerta sempre que o humano pergunta.
export function routeAlertThrottled(agg, { lastSig = null, lastTs = 0 } = {}, opts = {}) {
  const { throttleMs = ROUTE_ALERT_THROTTLE_MS, now = Date.now(), ...alertOpts } = opts;
  const alert = routeAlert(agg, alertOpts);
  if (!alert) return { emit: null, sig: null };
  const sig = routeAlertSig(agg, alertOpts);
  const changed = sig !== lastSig;
  const elapsed = (Number(now) || 0) - (Number(lastTs) || 0) >= throttleMs;
  return { emit: (changed || elapsed) ? alert : null, sig };
}
