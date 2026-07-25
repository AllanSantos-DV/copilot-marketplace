// ROUTER DE MODELO — dá o modelo certo pro papel/tarefa, ciente do que está DISPONÍVEL na assinatura.
// Seleção por PREFERÊNCIA de capacidade filtrada por disponibilidade: NÃO é fallback que mascara — é
// escolha ordenada sobre um conjunto REAL, e SINALIZA quando teve que rebaixar do ideal (downgraded).
// FAIL LOUD: availability vazia, capacidade sem nenhum modelo disponível, ou override indisponível → LANÇA.

import { CAPABILITIES, capabilityFor, DESIRED_EFFORT } from "./modelCatalog.mjs";

const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];

/**
 * @param {{ available: (string|{id:string,enabled?:boolean,reasoning?:string[]})[], log?:(m:string)=>void }} opts
 */
export function createModelRouter({ available, log = () => {} } = {}) {
  const avail = new Map();
  for (const m of available || []) {
    const id = typeof m === "string" ? m : m?.id;
    if (!id) continue;
    const enabled = typeof m === "string" ? true : m.enabled !== false;
    if (enabled) avail.set(id, { reasoning: (typeof m === "object" && Array.isArray(m.reasoning)) ? m.reasoning : null });
  }
  if (!avail.size) throw new Error("modelRouter: nenhum modelo disponível (availability vazia) — não roteia às cegas");

  // 1º da preferência que está disponível; se a capacidade não tiver nenhum, tenta 'general'.
  function pick(capability) {
    const pref = CAPABILITIES[capability] || CAPABILITIES.general;
    for (const id of pref) if (avail.has(id)) return { model: id, ideal: pref[0], viaGeneral: false };
    for (const id of CAPABILITIES.general) if (avail.has(id)) return { model: id, ideal: pref[0], viaGeneral: true };
    return null;
  }

  // Clampa o esforço desejado ao que o modelo suporta (null se o modelo não suporta effort).
  function clampEffort(model, desired) {
    const efs = avail.get(model)?.reasoning;
    if (!efs || !efs.length) return null;
    if (efs.includes(desired)) return desired;
    const di = EFFORT_ORDER.indexOf(desired);
    let best = efs[0];
    for (const e of efs) if (Math.abs(EFFORT_ORDER.indexOf(e) - di) < Math.abs(EFFORT_ORDER.indexOf(best) - di)) best = e;
    return best;
  }

  return {
    /**
     * @param {{ role?:string, taskType?:string, override?:string }} q
     * @returns {{ model:string, capability:string, ideal:string, downgraded:boolean, reasoningEffort:string|null }}
     */
    route({ role, taskType = null, override = null } = {}) {
      if (override) {
        if (!avail.has(override)) throw new Error(`modelRouter: modelo forçado "${override}" não está disponível`);
        return { model: override, capability: "override", ideal: override, downgraded: false, reasoningEffort: clampEffort(override, "medium") };
      }
      const capability = capabilityFor(role, taskType);
      const p = pick(capability);
      if (!p) throw new Error(`modelRouter: nenhum modelo disponível p/ capacidade "${capability}" (role=${role}, task=${taskType}) — habilite um dos: ${(CAPABILITIES[capability] || []).join(", ")}`);
      const downgraded = p.model !== p.ideal;
      if (downgraded) log(`[modelRouter] ${role || "?"}/${capability}: ideal "${p.ideal}" indisponível → "${p.model}"`);
      return { model: p.model, capability, ideal: p.ideal, downgraded, reasoningEffort: clampEffort(p.model, DESIRED_EFFORT[capability] || "medium") };
    },
    // Lista ORDENADA (preferência ideal→pior) dos modelos DISPONÍVEIS p/ a capacidade — usada pela rotação
    // de revisores (rodar o mesmo lente satura; trocar de modelo/família quebra o viés). Sempre ≥ 1 se houver.
    ranked({ role, taskType = null } = {}) {
      const capability = capabilityFor(role, taskType);
      const pref = CAPABILITIES[capability] || CAPABILITIES.general;
      const out = pref.filter((id) => avail.has(id));
      for (const id of CAPABILITIES.general) if (avail.has(id) && !out.includes(id)) out.push(id);
      return out;
    },
    available: () => [...avail.keys()],
  };
}
