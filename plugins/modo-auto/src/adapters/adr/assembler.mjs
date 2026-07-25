// ASSEMBLER determinístico (otf-4) — monta o ADR em markdown a partir do outline TRAVADO + slots. ZERO LLM:
// mesmo (template, slots) → MESMO markdown, byte a byte (reproduzível). É o passo que garante a FORMA CONSTANTE
// (o que o modo_dev consome como ## Fase N). Princípio 11: a MONTAGEM é tool, não heurística.

import { phasesSection } from "./adrTemplate.mjs";

function phaseBody(f) {
  const lines = [];
  if (f.objetivo) lines.push(`**Objetivo:** ${String(f.objetivo).trim()}`);
  if (f.requisito) lines.push(`**Requisito:** ${String(f.requisito).trim()}`);
  if (f.entrega) lines.push(`**Entrega:** ${String(f.entrega).trim()}`);
  if (!lines.length && f.corpo) lines.push(String(f.corpo).trim());
  return lines.join("\n");
}

function slotText(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => `- ${String(x).trim()}`).join("\n");
  if (typeof v === "object") return JSON.stringify(v, null, 2); // defensivo: não perde conteúdo como "[object Object]"
  return String(v).trim();
}

function phaseHeading(f, n) {
  return `## Fase ${n}: ${String(f.titulo || f.title || ("Fase " + n)).trim()}\n${phaseBody(f)}`;
}

/**
 * Monta o ADR completo (markdown). O slot de fases vira uma sequência de "## Fase N: <titulo>".
 * @param {{ sections:object[] }} template  outline travado
 * @param {object} slots  {sectionId: conteudo}
 * @returns {string}
 */
export function assembleAdr(template, slots = {}) {
  if (!template || !Array.isArray(template.sections)) throw new Error("assembleAdr: template inválido");
  const parts = [];
  let n = 0;
  for (const s of template.sections) {
    if (s.kind === "phases") {
      const arr = Array.isArray(slots[s.id]) ? slots[s.id] : [];
      for (const f of arr) { n += 1; parts.push(phaseHeading(f, n)); }
    } else {
      const body = slotText(slots[s.id]);
      if (body) parts.push(`## ${s.title}\n${body}`);
      else if (s.required) parts.push(`## ${s.title}\n(pendente)`); // não deveria ocorrer (fillSlots é fail-loud)
    }
  }
  return parts.join("\n\n") + "\n";
}

/**
 * As FASES como textos AUTOSSUFICIENTES (o orchestrator passa cada uma direto ao modo_dev — sem re-parsear
 * o markdown, sem a variância que quebrava o handoff). Ordem e forma determinísticas.
 * @returns {string[]}
 */
export function assemblePhases(template, slots = {}) {
  const ph = phasesSection(template);
  const arr = ph && Array.isArray(slots[ph.id]) ? slots[ph.id] : [];
  return arr.map((f, i) => phaseHeading(f, i + 1));
}
