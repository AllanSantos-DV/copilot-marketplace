// provenanceSchema.mjs — contrato COMPARTILHADO da proveniência dos findings do sombra (Fase 2). FONTE ÚNICA
// (DRY) dos enums + normalizadores usados pelo shadowConsolidator (produz) e pelo findingsTracker (persiste).
// AXIOMA: a LLM âncora JULGA target/sources (é o trabalho dela); estes normalizadores só VALIDAM a FORMA de modo
// determinístico e com TRAÇO auditável do que foi descartado — nada some em silêncio (fail-loud).

// 'verified' NÃO é emitido pela LLM (é enrichment do verificador na Fase 4); por isso não entra no ANCHOR_SCHEMA.
export const PROVENANCE_TARGETS = Object.freeze(["plan", "execution", "premise", "unknown"]);
export const PROVENANCE_SOURCE_TYPES = Object.freeze(["local", "research", "plan", "conversation", "verified"]);

// target fora do enum → 'unknown' + sinaliza (o honesto: não sei classificar). Nunca crash, nunca fake.
export function normalizeProvenanceTarget(target, { log = () => {}, context = "provenance" } = {}) {
  const t = typeof target === "string" ? target.trim().toLowerCase() : "";
  if (PROVENANCE_TARGETS.includes(t)) return t;
  if (t) log(`[${context}] target inválido '${target}' → 'unknown' (sinalizado)`);
  return "unknown";
}

// sources[]: mantém só os BEM-FORMADOS (type no enum + path não-vazio p/ local/plan/verified). Inválidos são
// descartados COM TRAÇO (retorna dropped:N + loga) — jamais somem calados (fail-loud). snippet opcional (≤500ch).
export function normalizeProvenanceSources(sources, { log = () => {}, context = "provenance" } = {}) {
  const arr = Array.isArray(sources) ? sources : [];
  const valid = [];
  let dropped = 0;
  for (const s of arr) {
    const type = s && typeof s.type === "string" ? s.type.trim().toLowerCase() : "";
    const path = s && typeof s.path === "string" ? s.path.trim() : "";
    const okType = PROVENANCE_SOURCE_TYPES.includes(type);
    const okPath = type === "research" || type === "conversation" || type === "verified" ? true : path.length > 0; // research/conversation/verified não exigem path (evidência/snippet é a prova)
    if (!okType || !okPath) { dropped++; continue; }
    const snippet = s && typeof s.snippet === "string" ? s.snippet.slice(0, 500) : "";
    valid.push({ type, path: path || null, ...(snippet ? { snippet } : {}) });
  }
  if (dropped) log(`[${context}] ${dropped} source(s) malformada(s) descartada(s) — traço: sourcesDropped=${dropped} (fail-loud, não silencioso)`);
  return { sources: valid, dropped };
}

// citationComplete DETERMINÍSTICO (pós-julgamento da LLM, não é julgamento) — regra POR TARGET (contrato do
// plano vivo, F2 aceite (d)): 'premise' é uma alegação MAIOR (a base do pedido estaria errada) → exige ≥2
// sources NÃO-conversation COM snippet; os demais (plan/execution/unknown) exigem ≥1. sources vazio / só
// 'conversation' / sem snippet → false. NUNCA infla (C2/C3 do painel).
export function computeCitationComplete(sources, target = "unknown") {
  const cited = (Array.isArray(sources) ? sources : []).filter((s) => s && s.type !== "conversation" && typeof s.snippet === "string" && s.snippet.trim().length > 0);
  const need = target === "premise" ? 2 : 1; // premise carrega mais ônus de prova
  return cited.length >= need;
}
