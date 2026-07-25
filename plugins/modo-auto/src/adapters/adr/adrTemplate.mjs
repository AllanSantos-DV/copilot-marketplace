// MODELO do OUTLINE/template do ADR (Outline-Then-Fill). Determinístico: define a FORMA (seções/slots
// ordenados), NÃO o conteúdo. É o "empreite" que o documentador preenche e o assembler monta em forma
// constante. kind: "prose" (texto livre da seção), "phases" (fatiado em ## Fase N pelo assembler — o slot
// que o modo_dev consome), "list" (itens). FAIL LOUD: seção/template malformado LANÇA (nunca template mudo).

export const SECTION_KINDS = ["prose", "phases", "list"];

/** Cria uma seção/slot bem-formada do outline. Campos ausentes/ inválidos LANÇAM. */
export function makeSection({ id, title, guide = "", required = false, kind = "prose" } = {}) {
  if (!id || typeof id !== "string") throw new Error("adrTemplate.makeSection: id ausente");
  if (!title || typeof title !== "string") throw new Error(`adrTemplate.makeSection: title ausente (id=${id})`);
  if (!SECTION_KINDS.includes(kind)) throw new Error(`adrTemplate.makeSection: kind inválido "${kind}" (id=${id})`);
  return { id, title, guide: String(guide || ""), required: !!required, kind };
}

/**
 * Valida um template: seções bem-formadas, ids ÚNICOS e EXATAMENTE uma seção kind:"phases" (o slot fatiado
 * em ## Fase N — invariante que garante que o plano sempre tem a espinha de fases que o dev consome).
 */
export function validateTemplate(t) {
  if (!t || !Array.isArray(t.sections) || !t.sections.length) throw new Error("adrTemplate.validateTemplate: template sem seções");
  const ids = new Set();
  for (const s of t.sections) {
    makeSection(s); // relança se a seção estiver malformada
    if (ids.has(s.id)) throw new Error("adrTemplate.validateTemplate: id de seção duplicado: " + s.id);
    ids.add(s.id);
  }
  const phases = t.sections.filter((s) => s.kind === "phases");
  if (phases.length !== 1) throw new Error(`adrTemplate.validateTemplate: precisa de EXATAMENTE 1 seção kind:"phases" (achou ${phases.length})`);
  return true;
}

export function requiredSections(t) { return (t?.sections || []).filter((s) => s.required); }
export function phasesSection(t) { return (t?.sections || []).find((s) => s.kind === "phases") || null; }
