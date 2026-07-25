// complexityTriage.mjs — Fase 2 do roteador: ORQUESTRA o classify determinístico + o DESEMPATE LLM na zona
// cinzenta. Determinístico decide o óbvio (0 LLM); SÓ quando `ambiguous` (e há factory) gasta 1 chamada BARATA
// (papel "triagem" → capability "speed" no router: gpt-5-mini/haiku) com TOOL-TEMPLATE (schema imposto pelo SDK).
// SOFT + FAIL LOUD sinalizado: factory falha / tier inválido → cai no determinístico (source marca o fallback,
// nunca silencioso). Reusa complexityRouter (puro) + extractJson. É o módulo com I/O; o classify fica puro.

import { classify, pathForTier } from "./complexityRouter.mjs";
import { extractJson } from "../util/extractJson.mjs";

const VALID = new Set(["trivial", "simples", "medio", "complexo"]);

const TRIAGE_SYSTEM =
  "Você é um TRIADOR de complexidade de tarefas de engenharia. Dado um BRIEFING e sinais determinísticos, " +
  "classifique o esforço de PLANEJAMENTO necessário em UM tier: trivial (mudança cosmética/local, dispensa " +
  "debate), simples (feature pequena, pouca deliberação), medio (várias partes, decisões reais), complexo " +
  "(arquitetura/integração/risco — exige debate completo). Responda SÓ chamando submit_complexity.";

// TOOL TEMPLATE (Princípio 11) — o schema é imposto pelo SDK; o triador NÃO responde em prosa.
const TIER_SCHEMA = {
  name: "submit_complexity",
  description: "Classifica a complexidade de PLANEJAMENTO do briefing em um tier.",
  parameters: {
    type: "object",
    properties: {
      tier: { type: "string", enum: ["trivial", "simples", "medio", "complexo"], description: "o tier de esforço de planejamento" },
      rationale: { type: "string", description: "1 frase curta do porquê" },
    },
    required: ["tier"],
  },
};

/**
 * Classifica o briefing; desempata com LLM leve SÓ na zona cinzenta.
 * @param {string} briefing
 * @param {{ factory?: object, log?: Function }} [caps]
 * @returns {Promise<{ tier:string, path:string, score:number, signals:object, ambiguous:boolean, rationale?:string, source:string }>}
 */
export async function triage(briefing, { factory, log = () => {} } = {}) {
  const det = classify(briefing, { log }); // FAIL LOUD se vazio
  if (!det.ambiguous || !factory?.run) return { ...det }; // óbvio, ou sem LLM disponível → determinístico puro

  const prompt =
    `BRIEFING:\n${String(briefing).slice(0, 1500)}\n\n` +
    `SINAIS DETERMINÍSTICOS: ${JSON.stringify(det.signals)} — score ${det.score}, palpite "${det.tier}" (ZONA CINZENTA/ambíguo).\n` +
    `Decida o tier e CHAME submit_complexity com { tier, rationale }. NÃO responda em texto.`;
  try {
    const r = await factory.run("triagem", prompt, { system: TRIAGE_SYSTEM, timeoutMs: 45000, stage: "adr", schema: TIER_SCHEMA, availableTools: [] });
    if (r.ok && r.text) {
      const p = extractJson(r.text);
      const tier = p && typeof p === "object" && !Array.isArray(p) ? String(p.tier || "").toLowerCase() : "";
      if (VALID.has(tier)) {
        log(`[complexityTriage] desempate LLM: ${det.tier} → ${tier} (${p.rationale || "sem rationale"})`);
        return { tier, path: pathForTier(tier), score: det.score, signals: det.signals, ambiguous: true, rationale: p.rationale || "", source: "llm-tiebreak" };
      }
      log("[complexityTriage] LLM não devolveu tier válido → determinístico (SINALIZADO)");
    } else log(`[complexityTriage] desempate LLM indisponível (${r.error || "sem texto"}) → determinístico (SINALIZADO)`);
  } catch (e) { log(`[complexityTriage] desempate LLM FALHOU (${e?.message || e}) → determinístico (SINALIZADO)`); }
  return { ...det, source: "deterministic-fallback" };
}
