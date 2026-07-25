// SLICER — usa o papel `fatiador` (sub-agente) pra inferir as dependências REAIS entre as fases do plano
// e produz os grupos de execução (via dag). FAIL LOUD: fatiador falhou/JSON inválido/ciclo → LANÇA (nunca
// devolve um fatiamento chutado). É o passo que decide o que roda em paralelo antes da pipeline executar.

import { buildGroups } from "./dag.mjs";
import { extractJson } from "../util/extractJson.mjs";

function parseJson(t) { return extractJson(t); }

// TOOL TEMPLATE do fatiador (Princípio 11) — schema imposto pelo SDK; o fatiador CHAMA a tool com as dependências.
const DEPS_SCHEMA = {
  name: "submit_deps",
  description: "Envie as dependências REAIS entre as fases do plano.",
  parameters: {
    type: "object",
    properties: {
      deps: { type: "object", description: "mapa id-da-fase → lista de ids das fases das quais ela depende, ex: {\"fase-2\":[\"fase-1\"],\"fase-4\":[\"fase-2\",\"fase-3\"]}. Omita as fases sem dependência." },
    },
    required: ["deps"],
  },
};

// Roda o fatiador → mapa de dependências { fase: [deps...] }. FAIL LOUD em falha/JSON inválido.
export async function inferDeps(phases, caps) {
  if (!Array.isArray(phases) || !phases.length) throw new Error("slicer: sem fases");
  if (!caps?.factory?.run) throw new Error("slicer: caps.factory ausente");
  const list = phases.map((p) => `- ${p.id}: ${p.text}`).join("\n");
  const r = await caps.factory.run("fatiador", `FASES DO PLANO:\n${list}\n\nIdentifique as dependências REAIS e CHAME a ferramenta submit_deps. NÃO responda em texto.`, { subject: "fatiador", timeoutMs: 90000, schema: DEPS_SCHEMA, availableTools: [] });
  if (!r.ok || !r.text) throw new Error(`slicer: fatiador falhou: ${r.error || "sem texto"}`);
  const j = parseJson(r.text);
  if (!j || j.__nosubmit__ || typeof j.deps !== "object" || j.deps == null) throw new Error("slicer: fatiador não submeteu {deps}: " + String(r.text).slice(0, 200));
  return j.deps;
}

// Fatia o plano → { deps, groups, parallel, maxWidth, sequential }. buildGroups valida refs + ciclo (FAIL LOUD).
export async function slice(phases, caps) {
  const deps = await inferDeps(phases, caps);
  return { deps, ...buildGroups(phases.map((p) => p.id), deps) };
}
