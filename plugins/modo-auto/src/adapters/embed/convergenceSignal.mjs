// SINAL DETERMINÍSTICO DE CONVERGÊNCIA da mesa — reusa o embedder dedicado (o "mini-LRM" do drift). A mesa
// "estabilizou" (converge pra um FOCO único) quando a posição consolidada de uma volta está PRÓXIMA da
// anterior — as falas pararam de mudar. É o harness que faltava ao facilitador: em vez de só o LLM julgar
// (heurístico, sujeito a bajulação), o número vem de vetores. Anti-fechar-cedo: enquanto as posições ainda
// DIVERGEM, o determinístico VETA a convergência mesmo que o facilitador diga "convergiu".
//
// FAIL LOUD em bug real; embedder ausente/textos vazios → null (o caller cai no heurístico, sinalizado).

import { cosineDistance } from "./driftSignal.mjs";

/**
 * @param {object} embedder  o embedder dedicado (opcional) — { embed(text)->vetor }
 * @param {string} prevRoundText  posição consolidada da volta anterior
 * @param {string} curRoundText   posição consolidada da volta atual
 * @param {{ stableAt?:number }} [opts]  distância <= stableAt ⇒ estabilizou (default 0.35, mais apertado que drift)
 * @returns {Promise<{ distance:number, converged:boolean, method:"embedding" }|null>}
 */
export async function convergenceSignal(embedder, prevRoundText, curRoundText, { stableAt = 0.35 } = {}) {
  if (!embedder?.embed || !String(prevRoundText || "").trim() || !String(curRoundText || "").trim()) return null;
  const [a, b] = await Promise.all([embedder.embed(prevRoundText), embedder.embed(curRoundText)]);
  if (!a || !b) return null; // embedder indisponível → sinaliza ao caller via null
  const distance = cosineDistance(a, b);
  return { distance, converged: distance <= stableAt, method: "embedding" };
}
