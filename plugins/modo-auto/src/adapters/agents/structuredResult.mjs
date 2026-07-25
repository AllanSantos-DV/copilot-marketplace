// structuredResult.mjs — TOOL TEMPLATE para respostas de FORMATO DETERMINÍSTICO (Princípio 11 — tool vs agent).
// O JEITO CERTO de obter um resultado estruturado de um sub-agente NÃO é pedir "responda SOMENTE JSON" e fazer
// parse da PROSA (frágil: o modelo responde em texto e o parse quebra — causou o bug do onStop/triage). É dar
// ao modelo uma TOOL cujo `parameters` (JSON schema) o SDK IMPÕE: o modelo CHAMA submit_<x>(args) e o handler
// CAPTURA os args aqui. Resultado idêntico entre modelos, sem parsing de linguagem natural.
//
// Uso: const s = makeSubmitTool({ name, description, parameters });
//      createSession({ tools:[s.tool, ...], availableTools:[s.name, ...] }); await turn; const out = s.get();

export function makeSubmitTool({ name, description, parameters } = {}) {
  if (!name || !parameters || typeof parameters !== "object") {
    throw new Error("makeSubmitTool: `name` e `parameters` (JSON schema) são obrigatórios"); // FAIL LOUD
  }
  let captured = null;
  let resolveCalled;
  const called = new Promise((res) => { resolveCalled = res; }); // resolve NO INSTANTE em que o modelo chama a tool
  const tool = {
    name,
    description: description || `Envie o RESULTADO FINAL estruturado chamando ${name}. Não responda em texto — use esta ferramenta.`,
    parameters,
    handler: (a) => { captured = a && typeof a === "object" ? a : {}; try { resolveCalled(captured); } catch { /* já resolvido */ } return JSON.stringify({ ok: true, received: true }); },
  };
  return { tool, name, get: () => captured, captured: () => captured != null, called };
}

// Roda o turno e FORÇA a chamada da submit tool com um LOOP de reforço LIMITADO (o SDK não expõe toolChoice:
// required nem Stop hook p/ worker — então o determinismo é: capturar NO INSTANTE da chamada + re-pedir até N
// vezes com nudge escalado). Retorna os args capturados ou null (o caller decide o degrade/FAIL-LOUD — nunca
// finge). `runTurn(prompt)` roda UM turno na sessão (não precisa devolver nada — a captura vem do handler).
export async function runUntilSubmitted(runTurn, submit, { retries = 2 } = {}) {
  if (submit.captured()) return submit.get();
  const nudges = [
    `Finalize AGORA chamando a ferramenta ${submit.name} com os campos exigidos — é OBRIGATÓRIO. NÃO responda em texto.`,
    `Você AINDA não chamou ${submit.name}. Chame-a agora, com o resultado. Não escreva texto — só a tool call.`,
  ];
  for (let i = 0; i < retries && !submit.captured(); i++) {
    try { await runTurn(nudges[Math.min(i, nudges.length - 1)]); } catch { /* re-ask best-effort — a captura pode ter vindo pelo handler */ }
  }
  return submit.get();
}
