// OUTLINE VIVO co-construído (otf-2) — a mesa parte do SEED e PROPÕE ajustes no outline durante a deliberação;
// depois TRAVA (lock) na convergência. Determinístico na aplicação (as propostas vêm da heurística; APLICAR é
// tool). GUARDS anti-bloat + invariantes: nunca remove o slot de fases nem obrigatórios, não cria 2º slot de
// fases, não duplica id, respeita o cap de seções. FAIL LOUD: propor após lock LANÇA; lock que quebra o
// invariante LANÇA. Propostas inválidas são REJEITADAS e SINALIZADAS (não mascara).

import { makeSection, validateTemplate } from "./adrTemplate.mjs";

/**
 * @param {{ taskType:string, sections:object[] }} seed  template inicial (selectSeed)
 * @param {{ maxSections?:number, log?:(m:string)=>void }} [opts]
 */
export function createOutlineBuilder(seed, { maxSections = 14, log = () => {} } = {}) {
  if (!seed || !Array.isArray(seed.sections)) throw new Error("createOutlineBuilder: seed inválido");
  let sections = seed.sections.map((s) => ({ ...s })); // trabalha numa CÓPIA (não muta o seed)
  let locked = false;
  const has = (id) => sections.some((x) => x.id === id);

  return {
    get sections() { return sections.map((s) => ({ ...s })); },
    get locked() { return locked; },

    /**
     * Aplica uma proposta ESTRUTURADA da mesa. Formato:
     *   { add:[{id,title,guide?,required?,kind?,after?}], adjust:{id:{title?/guide?/required?}}, remove:[ids] }
     * @returns {{ added:string[], adjusted:string[], removed:string[], rejected:string[] }}
     */
    propose(p = {}) {
      if (locked) throw new Error("outlineBuilder.propose: outline já TRAVADO — não aceita mudanças");
      const rep = { added: [], adjusted: [], removed: [], rejected: [] };

      for (const id of (p.remove || [])) {
        const s = sections.find((x) => x.id === id);
        if (!s) { rep.rejected.push(`remove ${id}: inexistente`); continue; }
        if (s.kind === "phases") { rep.rejected.push(`remove ${id}: slot de fases é protegido`); continue; }
        if (s.required) { rep.rejected.push(`remove ${id}: seção obrigatória é protegida`); continue; }
        sections = sections.filter((x) => x.id !== id); rep.removed.push(id);
      }

      for (const [id, ov] of Object.entries(p.adjust || {})) {
        const idx = sections.findIndex((x) => x.id === id);
        if (idx === -1) { rep.rejected.push(`adjust ${id}: inexistente`); continue; }
        // kind é IMUTÁVEL via adjust (protege o invariante de 1 slot de fases); id idem.
        sections[idx] = makeSection({ ...sections[idx], ...ov, id, kind: sections[idx].kind });
        rep.adjusted.push(id);
      }

      for (const a of (p.add || [])) {
        if (!a || !a.id) { rep.rejected.push("add: proposta sem id"); continue; }
        if (has(a.id)) { rep.rejected.push(`add ${a.id}: id duplicado`); continue; }
        if (a.kind === "phases") { rep.rejected.push(`add ${a.id}: não pode criar 2º slot de fases`); continue; }
        if (sections.length >= maxSections) { rep.rejected.push(`add ${a.id}: cap de ${maxSections} seções (anti-bloat)`); continue; }
        const sec = makeSection({ id: a.id, title: a.title, guide: a.guide, required: a.required, kind: a.kind && a.kind !== "phases" ? a.kind : "prose" });
        let pos = a.after ? sections.findIndex((x) => x.id === a.after) : -1;
        if (pos >= 0) sections.splice(pos + 1, 0, sec);
        else { const fi = sections.findIndex((x) => x.id === "fases"); sections.splice(fi >= 0 ? fi : sections.length, 0, sec); } // default: antes de "fases"
        rep.added.push(sec.id);
      }

      if (rep.rejected.length) log(`[outline] ${rep.rejected.length} proposta(s) rejeitada(s) (sinalizado): ${rep.rejected.join("; ")}`);
      return rep;
    },

    /** TRAVA o outline: valida o invariante (1 slot de fases, ids únicos) e congela. FAIL LOUD se quebrou. */
    lock() {
      const template = { taskType: seed.taskType, sections: sections.map((s) => ({ ...s })) };
      validateTemplate(template); // FAIL LOUD se as propostas quebraram a forma
      locked = true;
      log(`[outline] TRAVADO: ${sections.length} seções (${sections.map((s) => s.id).join(" → ")})`);
      return template;
    },
  };
}
