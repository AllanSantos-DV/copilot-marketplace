// Filtro de transcript do MODO-SOMBRA. Diferente do transcript comum (que só mantém user.message +
// assistant.message), o modo-sombra PRECISA do conteúdo que o agente entregou POR VOZ: numa sessão de voz o
// resumo real vai no `falar` (uma TOOL), e o assistant.message fica vazio → o filtro comum PERDE o conteúdo.
// VERIFICADO no events.jsonl real: tool.execution_start tem data.toolName + data.arguments; o texto falado
// está em arguments.texto (toolName="falar"). Aqui capturamos: user + assistant + FALAR + (opcional) web_search
// (query, p/ validar fontes externas). Descartamos o resto (ruído de máquina). Objetivo: entender o PEDIDO do
// usuário e o que o agente PROMETEU, com o mínimo de ruído, pra a contestação do sombra.

import { contentText, norm } from "../util/textNorm.mjs";

/**
 * @param {object[]} events  eventos do events.jsonl
 * @param {{ includeWebSearch?: boolean }} [opts]
 * @returns {{ role:"user"|"assistant", kind:"text"|"falar"|"web_search", text:string, id?:string }[]}
 */
export function cleanShadowTranscript(events, { includeWebSearch = true } = {}) {
  const arr = Array.isArray(events) ? events : (events && events.messages) || [];
  const turns = [];
  for (const e of arr) {
    if (!e || e.ephemeral) continue;
    if (e.agentId) continue; // só o loop principal (ignora ruído de sub-agentes)
    const d = e.data || {};
    if (e.type === "user.message") {
      const t = norm(contentText(d.content));
      if (t) turns.push({ role: "user", kind: "text", text: t, id: e.id });
    } else if (e.type === "assistant.message") {
      const t = norm(contentText(d.content));
      if (t) turns.push({ role: "assistant", kind: "text", text: t, id: e.id });
    } else if (e.type === "tool.execution_start" && d.toolName === "falar") {
      // conteúdo entregue POR VOZ — o que o agente REALMENTE resumiu ao usuário (crítico em voz).
      const t = norm(d.arguments && d.arguments.texto);
      if (t) turns.push({ role: "assistant", kind: "falar", text: t, id: e.id });
    } else if (includeWebSearch && e.type === "tool.execution_start" && d.toolName === "web_search") {
      const q = norm(d.arguments && d.arguments.query);
      if (q) turns.push({ role: "assistant", kind: "web_search", text: q, id: e.id });
    }
  }
  return turns;
}

// Render p/ o prompt do sombra: marca o que foi FALADO e o que foi PESQUISADO (sinais úteis à contestação).
export function renderShadow(turns) {
  return turns.map((t) => {
    if (t.role === "user") return `## USER\n${t.text}`;
    if (t.kind === "falar") return `## ASSISTANT (falado por voz)\n${t.text}`;
    if (t.kind === "web_search") return `## ASSISTANT (pesquisou na web)\n> ${t.text}`;
    return `## ASSISTANT\n${t.text}`;
  }).join("\n\n");
}
