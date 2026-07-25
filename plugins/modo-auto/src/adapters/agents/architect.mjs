// FÁBRICA-AGENTE = ARQUITETO. O elo fraco apontado no §4.6: papéis dinâmicos nasciam de um TEMPLATE
// determinístico (dynamicRole) — genérico e cego ao que a mesa já cobre. Aqui o papel dinâmico é
// DESENHADO por um agente ARQUITETO (um worker que escreve o system prompt do novo especialista),
// informado pela COBERTURA atual (pra não sobrepor papéis existentes).
//
// FAIL LOUD: arquiteto falha OU JSON inválido → LANÇA. SEM fallback de template (a regra do dono): se o
// arquiteto não consegue desenhar o papel, o erro SOBE — não se finge um persona genérico.

import { extractJson } from "../util/extractJson.mjs";

// TOOL TEMPLATE do arquiteto (Princípio 11) — schema imposto pelo SDK; o arquiteto CHAMA a tool com o desenho.
const DESIGN_SCHEMA = {
  name: "submit_role_design",
  description: "Envie o desenho do novo papel especialista (título + system prompt).",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "título curto do papel" },
      system: { type: "string", description: "o system prompt completo do agente, em 2ª pessoa ('Você é o agente de…')" },
    },
    required: ["system"],
  },
};

/**
 * Desenha o papel `id` para o assunto `subject`, rodando o agente "arquiteto" via a própria fábrica.
 * @param {string} id
 * @param {string} subject
 * @param {{ factory:object, coverage?:string[], model?:string }} deps
 * @returns {Promise<{ id:string, title:string, kind:string, system:string }>}
 */
export async function designRole(id, subject, { factory, coverage = [], model } = {}) {
  if (!id) throw new Error("architect.designRole: id vazio");
  if (!factory?.run) throw new Error("architect.designRole: factory (AgentFactoryPort) ausente");
  const sub = String(subject || id).trim();
  const cov = coverage.filter(Boolean).join(", ") || "(nenhum além dos fixos)";
  const prompt =
    `ASSUNTO (especialidade que falta): ${sub}\n` +
    `COBERTURA ATUAL (não sobreponha): ${cov}\n\n` +
    `Desenhe o system prompt do novo agente especialista em ${sub} para a mesa.`;
  const out = await factory.run("arquiteto", prompt + "\n\nCHAME a ferramenta submit_role_design com o título e o system. NÃO responda em texto.", { taskType: "design", model, schema: DESIGN_SCHEMA, availableTools: [] });
  if (!out.ok) throw new Error(`architect.designRole: arquiteto falhou para '${sub}': ${out.error || "sem saída"}`);
  const parsed = parseDesign(out.text);
  if (!parsed) throw new Error(`architect.designRole: JSON invalido do arquiteto para '${sub}': ${String(out.text).slice(0, 200)}`);
  return { id, title: parsed.title || id, kind: "designed", system: parsed.system };
}

function parseDesign(text) {
  const s = String(text || "");
  const obj = extractJson(s); // robusto a ```json + prosa (fonte única)
  if (!obj || typeof obj.system !== "string" || !obj.system.trim()) return null;
  return { title: typeof obj.title === "string" ? obj.title.trim() : "", system: obj.system.trim() };
}
