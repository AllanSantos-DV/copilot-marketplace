// SLOT-FILLING estruturado (otf-3) — o documentador PREENCHE o conteúdo de cada seção do outline TRAVADO como
// JSON {sectionId: conteudo}, recebendo a DELIBERAÇÃO inteira. NÃO escreve markdown livre — o CONTEÚDO é
// heurístico, mas a FORMA já está travada (o assembler monta). O slot de fases retorna um ARRAY de fases
// {titulo,objetivo,requisito,entrega} autossuficientes. FAIL LOUD: seção OBRIGATÓRIA vazia / JSON ausente / slot
// de fases não-array → LANÇA (não entrega meia-boca). runAgent injetável (documentador real ou stub de teste).

import { extractJson } from "../util/extractJson.mjs";
import { requiredSections, phasesSection } from "./adrTemplate.mjs";

function empty(v) { return v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length); }

/**
 * @param {{ taskType:string, sections:object[] }} template  outline TRAVADO (outlineBuilder.lock)
 * @param {{ deliberation?:string, runAgent:(prompt:string)=>Promise<{ok:boolean,text?:string,error?:string}>, extra?:string }} caps
 * @returns {Promise<object>} slots {sectionId: conteudo}
 */
export async function fillSlots(template, { deliberation = "", runAgent, extra = "" } = {}) {
  if (!template || !Array.isArray(template.sections)) throw new Error("fillSlots: template inválido");
  if (typeof runAgent !== "function") throw new Error("fillSlots: runAgent ausente");
  const ph = phasesSection(template);
  const spec = template.sections.map((s) => `- ${s.id} (${s.kind}${s.required ? ", OBRIGATÓRIA" : ""}): ${s.title} — ${s.guide}`).join("\n");
  const prompt =
    `DELIBERAÇÃO DA MESA (base — CONSOLIDE isto, não invente nem fuja):\n${deliberation}\n\n${extra ? extra + "\n\n" : ""}` +
    `Preencha o CONTEÚDO de CADA seção do outline abaixo. Responda SOMENTE um JSON {sectionId: conteudo}. ` +
    `A seção kind "phases" (id "${ph?.id || "fases"}") tem como conteúdo um ARRAY de fases, cada uma ` +
    `{"titulo","objetivo","requisito","entrega"} — AUTOSSUFICIENTE e testável (quem implementa não precisa de ` +
    `outra fase). As demais seções: texto (string). NÃO escreva markdown de cabeçalho — só o conteúdo por id. ` +
    `IMPORTANTE: você NÃO tem ferramentas — NÃO escreve arquivos, NÃO registra em plan.md/SQL, NÃO diz que ` +
    `"consolidou/registrou" nem pede pra prosseguir. A resposta é APENAS o objeto JSON dos slots, nada antes nem depois.\n\n` +
    `OUTLINE (ids e o que cada um deve conter):\n${spec}`;

  const r = await runAgent(prompt);
  if (!r || !r.ok || !r.text) throw new Error("fillSlots: agente de preenchimento falhou: " + (r?.error || "sem texto"));
  const slots = extractJson(r.text);
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) throw new Error("fillSlots: preenchimento não retornou JSON de slots: " + String(r.text).slice(0, 200));

  const missing = requiredSections(template).filter((s) => {
    const v = slots[s.id];
    if (empty(v)) return true;
    if (s.kind === "prose" && typeof v !== "string") return true; // objeto/num/bool num slot de PROSA = não é conteúdo de verdade
    return false;
  }).map((s) => s.id);
  if (missing.length) throw new Error("fillSlots: seções OBRIGATÓRIAS vazias/inválidas (fail-loud): " + missing.join(", "));

  if (ph) {
    const arr = slots[ph.id];
    if (!Array.isArray(arr) || !arr.length || !arr.every((f) => f && (f.titulo || f.title))) {
      throw new Error("fillSlots: slot de fases precisa ser ARRAY de fases {titulo,...}: " + JSON.stringify(arr).slice(0, 200));
    }
  }
  return slots;
}
