// GatePort — roda um GATE aplicando uma SKILL real do dono (global em ~/.copilot/skills/). Estratégia
// robusta: LÊ o corpo da SKILL.md e injeta como system do sub-agente (skills = conhecimento injetado)
// E passa skillDirectories (carrega a skill do jeito nativo também). FAIL LOUD: skill ausente → LANÇA.

import { SKILLS_ROOT, readSkillBody } from "../skills/skillLoader.mjs";
import { GATES } from "../skills/catalog.mjs"; // gate id → skill (fonte única, DRY)

/**
 * @param {{ factory: object, log?: (m:string)=>void }} deps  (factory = AgentFactoryPort)
 * @returns {import("../../core/ports.mjs").GatePort}
 */
export function createGatePort({ factory, log = () => {} }) {
  return {
    gates: () => Object.keys(GATES),
    skillFor: (gate) => GATES[gate] || null,

    // Roda o gate sobre um payload → { ok, gate, skill, text, error? }. Skill ausente = erro de config → LANÇA.
    // 180s (não 120s): o corpo da skill vira system PESADO; gates rodam em PARALELO, então a folga não serializa
    // — só evita timeout falso do gate mais lento (o `quality` estourava 120s enquanto os outros passavam).
    async run(gate, payload, { timeoutMs = 180000 } = {}) {
      const skill = GATES[gate] || gate;
      const body = readSkillBody(skill);
      if (!body) throw new Error(`gatePort: skill "${skill}" (gate ${gate}) nao encontrada em ${SKILLS_ROOT}`);
      const system =
        `Você é um GATE que aplica a skill "${skill}" abaixo. Siga-a à risca e avalie o MATERIAL do ` +
        `usuário segundo ela — aponte o que passa e o que falha, de forma concreta e curta.\n\n` +
        `=== SKILL: ${skill} ===\n${body}`;
      const r = await factory.run(`gate:${gate}`, payload, { subject: gate, timeoutMs, system, skillDirectories: [SKILLS_ROOT], stage: "gate" });
      return { ok: r.ok, gate, skill, text: r.text, error: r.error };
    },
  };
}
