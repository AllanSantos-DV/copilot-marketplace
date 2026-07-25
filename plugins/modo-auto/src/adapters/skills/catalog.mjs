// CATÁLOGO de skills — camada de POLÍTICA sobre o mecanismo (skillLoader). Fonte ÚNICA de verdade de:
//   • SKILLS  → o conjunto FECHADO de skills que o sistema conhece (injetáveis ou só-gate);
//   • BUNDLES → perfis reutilizáveis (grupos nomeados: developer, tester, pesquisador…);
//   • GATES   → eixo de ENFORCEMENT pesado (id do gate → skill; roda como agente dedicado);
//   • TASK_SCOPES → escopo por TIPO DE TAREFA (aditivo: inject leve + gates pesados).
//
// Lição embutida (bug do QA): injetar skill PESADA no system estoura contexto/timeout. Por isso as
// pesadas (quality-gate/security-check) são `injectable:false` e a máquina RECUSA injetá-las — elas só
// entram como GATE (agente próprio). FAIL LOUD em toda a linha: referência desconhecida, ciclo de
// bundle, skill ausente no disco ou tentativa de injetar gate-only → LANÇA (nunca injeta o que não há).

import { readSkillBody } from "./skillLoader.mjs";

const dedup = (a) => [...new Set(a)];

// 1) Skills conhecidas. injectable=false ⇒ só GATE (pesada demais p/ system prompt).
export const SKILLS = {
  "fail-loud":               { desc: "Proíbe fallback que mascara erro; erros SURFACED.", injectable: true },
  "anti-boilerplate":        { desc: "Reuso/DRY/clean; core + ports&adapters; não reinventar.", injectable: true },
  "tdd":                     { desc: "RED → GREEN → REFACTOR + QA.", injectable: true },
  "adr":                     { desc: "Mesa de decisões: briefing → plano vivo/ADR.", injectable: true },
  "pesquisa-ativa":          { desc: "Pesquisa interna+externa antes de decidir; não reinventar.", injectable: true },
  "web-research-techniques": { desc: "Técnicas de pesquisa na web.", injectable: true },
  "quality-gate":            { desc: "Qualidade de entrega (testes/fontes/versões de API).", injectable: false },
  "security-check":          { desc: "OWASP/injeção/segredos/authz.", injectable: false },
};

// 2) Bundles = perfis. Só skills LEVES (injetáveis). Podem referenciar outros bundles (DRY).
export const BUNDLES = {
  base:          ["fail-loud", "anti-boilerplate"],   // anticorpos universais de build
  developer:     ["base", "tdd"],
  tester:        ["tdd"],
  qa:            ["fail-loud"],
  "tech-lead":   [],                                  // consolidador: sem injeção (retorna veredito JSON)
  pesquisador:   ["pesquisa-ativa", "web-research-techniques"],
  planejamento:  ["adr", "pesquisa-ativa", "anti-boilerplate"],
  dev:           ["developer"],                       // alias legível ("perfil de dev")
};

// 3) Gates conhecidos (id → skill). Eixo pesado; rodam como agentes dedicados (GatePort).
export const GATES = {
  quality: "quality-gate",
  security: "security-check",
  "anti-boilerplate": "anti-boilerplate",
  pesquisa: "pesquisa-ativa",
};

// 4) Escopo por TIPO DE TAREFA (ABERTO: tipo desconhecido = nada extra + matchedTaskType:false, sinalizado).
//    inject = skills LEVES adicionadas ao system; gates = enforcement pesado (agentes).
export const TASK_SCOPES = {
  api:       { inject: [], gates: ["security"] },
  backend:   { inject: [], gates: ["security"] },
  auth:      { inject: [], gates: ["security"] },
  data:      { inject: [], gates: ["security"] },
  infra:     { inject: [], gates: ["security"] },
  critical:  { inject: ["fail-loud"], gates: ["security"] },   // eleva o anticorpo até em quem só tinha tdd
  research:  { inject: [], gates: ["pesquisa"] },
  discovery: { inject: [], gates: ["pesquisa"] },
  planning:  { inject: ["planejamento"], gates: ["pesquisa"] },
  refactor:  { inject: [], gates: ["anti-boilerplate"] },
  fix:       { inject: [], gates: [] },
  feature:   { inject: [], gates: [] },
  docs:      { inject: [], gates: [] },
  ui:        { inject: [], gates: [] },
};

// Expande nomes (skill OU bundle) → lista de skills injetáveis. FAIL LOUD: desconhecido, ciclo de
// bundle (path DFS c/ backtrack), ou tentativa de injetar skill gate-only → LANÇA.
function expandInject(names, path = new Set()) {
  const out = [];
  for (const name of names) {
    if (SKILLS[name]) {
      if (!SKILLS[name].injectable) throw new Error(`catalog: skill "${name}" é gate-only (injectable:false) — não injetável no system`);
      out.push(name);
    } else if (BUNDLES[name]) {
      if (path.has(name)) throw new Error(`catalog: ciclo de bundle em "${name}"`);
      path.add(name);
      for (const s of expandInject(BUNDLES[name], path)) out.push(s);
      path.delete(name);
    } else {
      throw new Error(`catalog: referência desconhecida "${name}" (não é skill nem bundle)`);
    }
  }
  return out;
}

/**
 * MÁQUINA DE INJEÇÃO: resolve as skills LEVES a injetar p/ um perfil + tipo de tarefa.
 * @param {{ profile?: string, taskType?: string, extra?: string[] }} opts
 * @returns {{ skills: string[], matchedTaskType: boolean }}
 */
export function resolveSkills({ profile, taskType, extra = [] } = {}) {
  const names = [];
  if (profile) names.push(profile);
  for (const e of extra) names.push(e);
  let matchedTaskType = false;
  if (taskType != null && taskType !== "") {
    const sc = TASK_SCOPES[taskType];
    if (sc) { matchedTaskType = true; for (const n of sc.inject) names.push(n); }
  }
  return { skills: dedup(expandInject(names)), matchedTaskType };
}

// Resolve os GATES a rodar: base + gates do tipo de tarefa (dedup). FAIL LOUD em gate desconhecido.
export function resolveGates(taskType, baseGates = []) {
  const out = [...baseGates];
  const sc = taskType != null && taskType !== "" ? TASK_SCOPES[taskType] : null;
  if (sc) for (const g of sc.gates) out.push(g);
  for (const g of out) if (!GATES[g]) throw new Error(`catalog: gate desconhecido "${g}"`);
  return dedup(out);
}

// Validação de integridade — chamar no startup (FAIL LOUD agregado: mostra TODOS os problemas de uma vez):
//   toda SKILL existe no disco · todo GATE aponta p/ skill conhecida · bundles resolvem sem ciclo/gate-only ·
//   TASK_SCOPES.inject resolvem e .gates existem. Assim NUNCA se tenta injetar uma skill inexistente.
export function validateCatalog() {
  const problems = [];
  for (const id of Object.keys(SKILLS)) if (!readSkillBody(id)) problems.push(`skill ausente no disco: ${id}`);
  for (const [gid, sk] of Object.entries(GATES)) if (!SKILLS[sk]) problems.push(`gate "${gid}" aponta p/ skill fora do catálogo: ${sk}`);
  for (const b of Object.keys(BUNDLES)) { try { expandInject([b]); } catch (e) { problems.push(`bundle "${b}": ${e.message}`); } }
  for (const [t, sc] of Object.entries(TASK_SCOPES)) {
    try { expandInject(sc.inject || []); } catch (e) { problems.push(`task "${t}".inject: ${e.message}`); }
    for (const g of sc.gates || []) if (!GATES[g]) problems.push(`task "${t}".gates: gate desconhecido "${g}"`);
  }
  if (problems.length) throw new Error("catálogo de skills INVÁLIDO (FAIL LOUD):\n- " + problems.join("\n- "));
  return { ok: true, skills: Object.keys(SKILLS).length, bundles: Object.keys(BUNDLES).length, gates: Object.keys(GATES).length, taskTypes: Object.keys(TASK_SCOPES).length };
}
