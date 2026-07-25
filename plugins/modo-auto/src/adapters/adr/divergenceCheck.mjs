// VALIDAÇÃO DE DIVERGÊNCIA (otf-5) — o mini-LRM (embedder/drift determinístico, já existe) confere se o ADR
// MONTADO derrapou da DELIBERAÇÃO da mesa. Reusa embeddingDrift (distância de cosseno). Se divergiu, SINALIZA
// re-fill e aponta QUAIS seções de prosa divergiram mais (pro caller re-preencher só o que derrapou). Embedder
// ausente → método "none" SINALIZADO (segue sem o gate, como o resto do sistema). Determinístico dado o embedder.

import { embeddingDrift } from "../embed/driftSignal.mjs";

const RANK = { low: 0, medium: 1, high: 2 };

/**
 * @param {object} embedder  { embed(text)->vetor } (mini-LRM dedicado); ausente → método "none"
 * @param {{ adrText:string, deliberation:string, slots?:object, template?:object, threshold?:"medium"|"high" }} args
 * @returns {Promise<{ ok:true, method:"embedding"|"none", drift:string|null, distance:number|null, diverged:boolean, signal:string, sections:{id,drift,distance}[] }>}
 */
export async function checkDivergence(embedder, { adrText, deliberation, slots = null, template = null, threshold = "high" } = {}) {
  const ed = await embeddingDrift(embedder, deliberation, String(adrText || ""));
  if (!ed) return { ok: true, method: "none", drift: null, distance: null, diverged: false, signal: "embedder-off", sections: [] };
  const diverged = RANK[ed.drift] >= RANK[threshold];

  // Per-seção (opcional): quais slots de PROSA divergem mais da deliberação → o que re-preencher.
  const sections = [];
  if (slots && template && Array.isArray(template.sections)) {
    for (const s of template.sections) {
      if (s.kind === "phases") continue;
      const v = slots[s.id];
      if (typeof v !== "string" || !v.trim()) continue;
      const d = await embeddingDrift(embedder, deliberation, v);
      if (d && RANK[d.drift] >= RANK[threshold]) sections.push({ id: s.id, drift: d.drift, distance: d.distance });
    }
  }
  return { ok: true, method: "embedding", drift: ed.drift, distance: ed.distance, diverged, signal: diverged ? "re-fill" : "ok", sections };
}
