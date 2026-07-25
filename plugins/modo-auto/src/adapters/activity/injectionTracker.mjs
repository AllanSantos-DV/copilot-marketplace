// INJECTION TRACKER (F3) — mede se as INJEÇÕES do modo-sombra ACERTARAM, por sinal DETERMINÍSTICO (trajetória
// de drift), não palpite de LLM (Princípio 11). Lê os spans stage:"sombra-consolidation" (F2), agrupa por
// SESSÃO, ordena por tempo, e para cada consolidação que INJETOU (injected:true, drift high) compara a
// distância de drift ANTES × a da consolidação SEGUINTE da MESMA sessão: se caiu além de `epsilon`, a sessão
// corrigiu na direção do sombra → accepted=true; se ficou igual/subiu → false (ruído/ignorada).
// GUARDS SINALIZADOS (accepted:null + reason, nunca fake): low-baseline (drift não-high), no-embedding
// (distance ausente), no-followup (sem consolidação seguinte na sessão). A PRECISÃO acumula ao longo do tempo
// (em sessão curta a maioria é null — honesto). Puro/testável.
//
// NÃO É DEAD CODE nem duplicata: `injectionPrecision` daqui é USADO em extension.mjs (`modo_melhoria`, loop F4 de
// auto-melhoria) e mede algo DIFERENTE de `findingsTracker.metrics().precision`. Colisão de nome resolvida por escopo:
//   • injectionPrecision (AQUI)  = aceitação INFERIDA de TODA injeção do sombra, por trajetória de drift (telemetria,
//     sinal fraco/indireto) → alimenta o selfImprove a elevar o threshold.
//   • findingsTracker.precision  = decisão EXPLÍCITA da sessão (resolved/rejected) sobre findings VERIFICADOS (sinal
//     forte/direto) → eficácia da reforma do sombra. As duas coexistem DE PROPÓSITO (medidas distintas, consumidores
//     distintos); a de decisão explícita é a canônica de eficácia, a inferida é telemetria de calibragem.

export const INJECTION_EPSILON = 0.08; // calibrar com ≥20 injeções reais; faixa observada de distance ~0.4–0.8.

/**
 * @param {object[]} spans  spans da telemetria (inclui os stage:"sombra-consolidation")
 * @returns {{ sessionId, flagId, at, drift, distancePre, accepted:boolean|null, reason, distancePost?, delta? }[]}
 */
export function trackInjections(spans, { epsilon = INJECTION_EPSILON } = {}) {
  const cons = (Array.isArray(spans) ? spans : []).filter((s) => s && s.stage === "sombra-consolidation");
  const bySession = new Map();
  for (const s of cons) {
    const k = s.sessionId || "?";
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(s);
  }
  for (const arr of bySession.values()) arr.sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0));

  const results = [];
  for (const [sid, arr] of bySession) {
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (!c.injected) continue; // só as consolidações que INJETARAM um flag são medidas
      const base = { sessionId: sid, flagId: c.flagId || null, at: c.startedAt || null, drift: c.drift || null, distancePre: c.distance ?? null };
      if (c.drift !== "high") { results.push({ ...base, accepted: null, reason: "low-baseline" }); continue; }
      const next = arr[i + 1]; // a PRÓXIMA consolidação da mesma sessão (o "depois")
      if (!next) { results.push({ ...base, accepted: null, reason: "no-followup" }); continue; }
      if (c.distance == null || next.distance == null) { results.push({ ...base, accepted: null, reason: "no-embedding" }); continue; }
      const delta = Number(next.distance) - Number(c.distance);
      results.push({ ...base, accepted: delta < -epsilon, reason: "measured", distancePost: Number(next.distance), delta });
    }
  }
  // ORDENA GLOBAL por tempo: trackInjections agrupa por sessão (ordem só DENTRO da sessão) → o array final NÃO
  // era cronológico global. injectionPrecision faz slice(-N) assumindo ordem global; com sessões interleaved
  // (o sink é 1 arquivo por usuário) a janela pegaria injeções erradas. Ordenar por `at` conserta na fonte.
  results.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  return results;
}

/**
 * Precisão do sombra na janela das últimas `windowSize` injeções: accepted / medidas (accepted não-null).
 * precision=null quando não há injeção MEDÍVEL na janela (honesto — não inventa número).
 */
export function injectionPrecision(spans, { windowSize = 10, epsilon = INJECTION_EPSILON } = {}) {
  const all = trackInjections(spans, { epsilon });
  const window = all.slice(-windowSize);
  const measured = window.filter((r) => r.accepted !== null);
  const accepted = measured.filter((r) => r.accepted === true).length;
  return {
    injections: window.length,
    measured: measured.length,
    accepted,
    precision: measured.length ? accepted / measured.length : null,
    unmeasured: window.length - measured.length,
  };
}

// F4 (loop de aprendizado): se a PRECISÃO na janela é baixa COM amostra suficiente, produz o gap sintético
// 'low-precision' (senão null) → o selfImprove propõe (gate humano) elevar o threshold do sombra. Pura/testável.
export function lowPrecisionGap(prec, { minMeasured = 5, target = 0.5 } = {}) {
  if (!prec || prec.measured < minMeasured || prec.precision == null || prec.precision >= target) return null;
  return { type: "low-precision", traceId: "sombra", role: "modo-sombra", detail: `precisão das injeções ${(prec.precision * 100).toFixed(0)}% (${prec.accepted}/${prec.measured}) < ${target * 100}% — considerar elevar o threshold do sombra` };
}
