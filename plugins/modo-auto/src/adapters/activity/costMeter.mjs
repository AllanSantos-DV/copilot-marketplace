// costMeter.mjs — AGREGAÇÃO determinística (Princípio 11: aritmética PURA, zero LLM) do CUSTO da mesa a partir dos
// spans de telemetria. Responde "quanto custou": soma tokens (entrada/saída/cache) + nanoAiu por RUN (traceId), por
// MODELO e total. Shape dos campos PROVADO ao vivo (probes/probe-usage-shape.mjs): o evento assistant.usage do SDK
// traz data.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens} + data.copilotUsage.totalNanoAiu.
// FAIL-LOUD: span de worker SEM usage medido conta em `unmeasured` (visível) — NUNCA soma zero fake (zero seria
// mentira que contamina o custo). nanoAiu é a unidade de cobrança opaca; expõe também aiu (÷1e9) legível, mas mantém
// os TOKENS BRUTOS auditáveis (nanoAiu não tem rate card público). Puro/testável (recebe spans, não faz I/O).

const NANO_PER_AIU = 1e9;
const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "nanoAiu"];
const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0, spans: 0, measured: 0, unmeasured: 0, lastAt: 0 });

// um span "cobrável" = um turno de worker que rodou LLM. EXCLUI spans sintéticos de telemetria: o `dev-verdict`
// (marcador de eficácia, tem `verdict` e NÃO é uma chamada de LLM) e a `sombra-consolidation` (sem role). Sem esta
// exclusão, o span de veredito (role:"tech-lead", usage:null) inflaria o `unmeasured` com uma medição que nunca
// existiu. Heurística determinística: tem `role` (é worker) E NÃO é um span de veredito.
function isWorkerSpan(s) { return !!(s && s.role && s.role !== "?" && !s.verdict && s.stage !== "dev-verdict"); }

function addUsage(acc, u) {
  for (const f of FIELDS) if (typeof u[f] === "number" && Number.isFinite(u[f])) acc[f] += u[f];
}

/**
 * @param {object[]} spans  spans persistidos (telemetrySink.read)
 * @returns {{ total, byTrace:Record<string,object>, byModel:Record<string,object> }}
 *   cada bucket: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, nanoAiu, aiu, spans, measured, unmeasured }
 */
export function aggregateCost(spans) {
  const list = Array.isArray(spans) ? spans : [];
  const total = zero(); const byTrace = {}; const byModel = {};
  for (const s of list) {
    if (!isWorkerSpan(s)) continue; // spans não-worker (telemetria pura) não entram no custo
    const tid = s.traceId || "(sem-trace)";
    const model = s.model || "(sem-model)";
    const bt = (byTrace[tid] ||= zero());
    const bm = (byModel[model] ||= zero());
    total.spans++; bt.spans++; bm.spans++;
    const at = typeof s.startedAt === "number" ? s.startedAt : 0; // recência da run (p/ "a última deliberação")
    if (at > bt.lastAt) bt.lastAt = at; if (at > bm.lastAt) bm.lastAt = at; if (at > total.lastAt) total.lastAt = at;
    const u = s.usage;
    if (u && typeof u === "object") { total.measured++; bt.measured++; bm.measured++; addUsage(total, u); addUsage(bt, u); addUsage(bm, u); }
    else { total.unmeasured++; bt.unmeasured++; bm.unmeasured++; } // FAIL-LOUD: visível, nunca somado como 0
  }
  const withAiu = (b) => ({ ...b, aiu: b.nanoAiu / NANO_PER_AIU });
  const mapAiu = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withAiu(v)]));
  return { total: withAiu(total), byTrace: mapAiu(byTrace), byModel: mapAiu(byModel) };
}

// Formata UMA linha humana p/ o CLI (o DoD: "o dono roda e lê o custo em 1 linha"). `bucket` = total ou de 1 run.
export function formatCostLine(bucket, label = "total") {
  if (!bucket || !bucket.spans) return `custo (${label}): sem spans de worker ainda — rode a mesa (adr/dev/reuso…).`;
  const tk = (n) => n.toLocaleString("pt-BR");
  const miss = bucket.unmeasured ? ` · ⚠️ ${bucket.unmeasured} sem medição` : "";
  const cache = bucket.cacheReadTokens || bucket.cacheWriteTokens ? ` (cache r${tk(bucket.cacheReadTokens)}/w${tk(bucket.cacheWriteTokens)})` : "";
  return `custo (${label}): ${tk(bucket.inputTokens)} in + ${tk(bucket.outputTokens)} out${cache} · ${bucket.aiu.toFixed(3)} AIU · ${bucket.spans} spans${miss}`;
}

// Normaliza o `data` de um evento assistant.usage no shape do span (chamado no worker). Campo ausente = null
// SINALIZADO (nunca 0 fake). `model` vem de fora (o worker sabe; o evento nem sempre traz). `reasoningTokens`:
// o probe LIVE (probes/probe-usage-shape.mjs, SDK 1.0.71) NÃO o encontrou no assistant.usage — capturamos mesmo
// assim (null hoje, real se um SDK futuro emitir) p/ honrar "captura com null honesto" sem fabricar número.
export function usageFromEvent(data, model = null) {
  if (!data || typeof data !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    inputTokens: num(data.inputTokens),
    outputTokens: num(data.outputTokens),
    cacheReadTokens: num(data.cacheReadTokens),
    cacheWriteTokens: num(data.cacheWriteTokens),
    reasoningTokens: num(data.reasoningTokens), // ausente no SDK 1.0.71 (probe) → null; captura future-proof
    nanoAiu: num(data?.copilotUsage?.totalNanoAiu),
    model: model || data.model || null,
  };
}

// Soma dois usages (um turno pode emitir vários assistant.usage — ex.: multi-tool). null + x = x; ambos null = null.
export function mergeUsage(a, b) {
  if (!a) return b || null; if (!b) return a;
  const sum = (x, y) => (x == null && y == null ? null : (x || 0) + (y || 0));
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    nanoAiu: sum(a.nanoAiu, b.nanoAiu),
    model: a.model || b.model || null,
  };
}

// CORRELAÇÃO CUSTO × ACEITAÇÃO (responde "deep se paga?"). Junta o CUSTO das deliberações (spans de worker) com o
// DESFECHO da entrega que produziram (aceita/rejeitada) e com o flag DEEP. Atribuição por ORDEM TEMPORAL: os workers
// entre a entrega anterior e a entrega i são o custo da entrega i (heurística SINALIZADA — determinística por
// startedAt; robusta no caso comum de 1 sessão ativa; sessões interleaved podem misturar, por isso é sinal, não
// contrato). `stateOf(hash)` vem do deliveryLedger (resolved/rejected/emitted). Aritmética pura (Princípio 11).
export function correlateCostAcceptance(spans, stateOf = () => null) {
  const list = Array.isArray(spans) ? spans : [];
  const deliveries = list.filter((s) => s && s.stage === "delivery" && s.delivery && s.delivery.hash)
    .map((s) => ({ hash: s.delivery.hash, deep: !!s.delivery.deep, at: typeof s.startedAt === "number" ? s.startedAt : 0 }))
    .sort((a, b) => a.at - b.at);
  const workers = list.filter(isWorkerSpan).map((s) => ({ at: typeof s.startedAt === "number" ? s.startedAt : 0, u: s.usage })).sort((a, b) => a.at - b.at);
  const aiuOf = (u) => (u && typeof u.nanoAiu === "number" ? u.nanoAiu : 0);

  const per = [];
  let prevAt = -Infinity;
  for (const d of deliveries) {
    let nanoAiu = 0;
    for (const w of workers) if (w.at > prevAt && w.at <= d.at) nanoAiu += aiuOf(w.u);
    per.push({ hash: d.hash, deep: d.deep, nanoAiu, aiu: nanoAiu / NANO_PER_AIU, state: stateOf(d.hash) || "emitted" });
    prevAt = d.at;
  }

  const bucket = () => ({ count: 0, nanoAiu: 0, resolved: 0, rejected: 0 });
  const accepted = bucket(), rejected = bucket(), deep = bucket(), nonDeep = bucket();
  for (const p of per) {
    const tgt = p.deep ? deep : nonDeep;
    tgt.count++; tgt.nanoAiu += p.nanoAiu;
    if (p.state === "resolved") { tgt.resolved++; accepted.count++; accepted.nanoAiu += p.nanoAiu; }
    else if (p.state === "rejected") { tgt.rejected++; rejected.count++; rejected.nanoAiu += p.nanoAiu; }
  }
  const rate = (b) => { const dec = b.resolved + b.rejected; return dec ? b.resolved / dec : null; };
  const avgAiu = (b) => (b.count ? b.nanoAiu / b.count / NANO_PER_AIU : 0);
  return {
    per,
    accepted: { count: accepted.count, aiu: accepted.nanoAiu / NANO_PER_AIU },
    rejected: { count: rejected.count, aiu: rejected.nanoAiu / NANO_PER_AIU },
    deep: { count: deep.count, avgAiu: avgAiu(deep), acceptRate: rate(deep) },
    nonDeep: { count: nonDeep.count, avgAiu: avgAiu(nonDeep), acceptRate: rate(nonDeep) },
  };
}

// READOUT do modo_custo (a MESMA lógica que a tool roda — DRY + testável end-to-end sem o singleton). Recebe os
// spans e o stateOf do ledger; devolve o bloco de texto humano (custo total + por modelo + runs + custo×aceitação).
export function renderCostReport(spans, stateOf = () => null) {
  const agg = aggregateCost(spans);
  if (!agg.total.spans) return "modo-custo: sem spans de worker ainda — rode a mesa (adr/dev/reuso…) e volte.";
  const runs = Object.entries(agg.byTrace).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 5);
  const runLines = runs.map(([tid, b]) => "  • " + formatCostLine(b, tid.slice(0, 12))).join("\n");
  const modelLines = Object.entries(agg.byModel).sort((a, b) => b[1].nanoAiu - a[1].nanoAiu).map(([m, b]) => `  • ${m}: ${b.aiu.toFixed(3)} AIU (${b.spans} spans)`).join("\n");
  const c = correlateCostAcceptance(spans, stateOf);
  const pct = (r) => (r == null ? "s/ decisão" : (r * 100).toFixed(0) + "%");
  const corr = (c.deep.count || c.nonDeep.count)
    ? `\n\nCusto × aceitação (atribuição temporal — sinal, não contrato):\n` +
      `  • aceitas: ${c.accepted.count} (${c.accepted.aiu.toFixed(3)} AIU) · rejeitadas: ${c.rejected.count} (${c.rejected.aiu.toFixed(3)} AIU)\n` +
      `  • DEEP se paga? deep: ${c.deep.count} entrega(s), aceitação ${pct(c.deep.acceptRate)}, ${c.deep.avgAiu.toFixed(3)} AIU/entrega · normal: ${c.nonDeep.count}, aceitação ${pct(c.nonDeep.acceptRate)}, ${c.nonDeep.avgAiu.toFixed(3)} AIU/entrega`
    : "";
  return `${formatCostLine(agg.total, "TOTAL")}\n\nPor modelo:\n${modelLines}\n\nRuns recentes:\n${runLines}${corr}\n\n(AIU = unidade de cobrança do Copilot; tokens brutos auditáveis. Spans "sem medição" = usage não veio do SDK, sinalizado.)`;
}
