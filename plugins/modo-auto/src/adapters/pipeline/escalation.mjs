// CANAL DE ESCALAÇÃO worker→orquestrador (bubble-up). Quando o time de dev trava numa DECISÃO que não
// resolve sozinho, o tech-lead emite `escalate` (uma pergunta). Em vez de borbulhar como texto morto, essa
// pergunta sobe pro ORQUESTRADOR, que a resolve via MESA (o mesmo mecanismo do modo-auto que responde
// ask_user) — e só cai no HUMANO em último caso. É a ponte que faltava entre a pipeline e o governador.
//
// FAIL LOUD: mesa presente mas falhando → LANÇA (não finge resposta). SEM mesa → devolve {resolved:false,
// forHuman} SINALIZADO (degradação legítima: não há quem resolver automaticamente → sobe pro humano).

/**
 * Resolve UMA escalação. @param {string} question  a pergunta objetiva do tech-lead
 * @param {{ mesa?:object }} caps  caps.mesa.deliberate = o resolvedor (mesa do modo-auto)
 * @param {{ context?:string }} [opts]
 * @returns {Promise<{ resolved:boolean, answer?:string, forHuman?:boolean, reason?:string }>}
 */
export async function resolveEscalation(question, caps = {}, { context = "" } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new Error("escalation.resolveEscalation: pergunta vazia");
  // Sem mesa configurada → não há resolvedor automático: sobe pro humano (sinalizado, não mascarado).
  if (!caps.mesa?.deliberate) return { resolved: false, forHuman: true, reason: "sem mesa (orquestrador) para resolver — requer humano" };
  const prompt = context ? `${q}\n\nCONTEXTO DA FASE:\n${context}` : q;
  const r = await caps.mesa.deliberate(prompt, caps); // erro da mesa SOBE (fail loud)
  if (!r || !r.answer) throw new Error("escalation.resolveEscalation: a mesa nao produziu resposta para: " + q);
  return { resolved: true, answer: r.answer };
}

/**
 * Resolve VÁRIAS escalações (as de um grupo/fase). Preserva a ordem; cada uma FAIL LOUD individualmente.
 * @param {{id?:string, question:string, context?:string}[]} escalations
 * @returns {Promise<{id?:string, question:string, resolved:boolean, answer?:string, forHuman?:boolean}[]>}
 */
export async function resolveAll(escalations, caps = {}) {
  const list = Array.isArray(escalations) ? escalations.filter((e) => e && e.question) : [];
  const out = [];
  for (const e of list) {
    const r = await resolveEscalation(e.question, caps, { context: e.context || "" });
    out.push({ id: e.id, question: e.question, ...r });
  }
  return out;
}
