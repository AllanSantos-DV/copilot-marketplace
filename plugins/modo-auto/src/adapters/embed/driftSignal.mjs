// SINAL DETERMINÍSTICO DE DRIFT — distância de cosseno entre "direção correta" e "direção da sessão",
// via o embedder dedicado do modo-sombra. Diferente do drift heurístico (LLM diz low/medium/high), aqui o
// número vem de vetores → objetivo e reprodutível. Limiares TUNÁVEIS (medidos no probe: paráfrase alinhada
// ~0.48, tópico divergente ~0.76). FAIL LOUD em vetor inválido; embedder ausente → null (caller usa heurística).

export function cosineDistance(a, b) {
  if (!a || !b || a.length !== b.length) throw new Error("driftSignal.cosineDistance: vetores inválidos/incompatíveis");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot; // vetores já normalizados → cos = dot; distância = 1 - cos (0 = idêntico)
}

// distância → balde. Defaults calibrados no probe (MiniLM): <0.5 alinhado, 0.5–0.65 atenção, >=0.65 derrapou.
export function driftBucket(distance, { medium = 0.5, high = 0.65 } = {}) {
  if (!(typeof distance === "number") || Number.isNaN(distance)) throw new Error("driftSignal.driftBucket: distância inválida");
  if (distance >= high) return "high";
  if (distance >= medium) return "medium";
  return "low";
}

/**
 * Drift DETERMINÍSTICO entre a direção correta e a da sessão. null se o embedder não estiver disponível
 * (o caller cai no drift heurístico do LLM, sinalizado). Nunca lança por indisponibilidade — só por bug real.
 * @returns {Promise<{ distance:number, drift:"low"|"medium"|"high", method:"embedding" }|null>}
 */
export async function embeddingDrift(embedder, correctDirection, sessionDirection, opts = {}) {
  if (!embedder?.embed || !String(correctDirection || "").trim() || !String(sessionDirection || "").trim()) return null;
  const [a, b] = await Promise.all([embedder.embed(correctDirection), embedder.embed(sessionDirection)]);
  if (!a || !b) return null; // embedder indisponível → sinaliza ao caller via null
  const distance = cosineDistance(a, b);
  return { distance, drift: driftBucket(distance, opts), method: "embedding" };
}
