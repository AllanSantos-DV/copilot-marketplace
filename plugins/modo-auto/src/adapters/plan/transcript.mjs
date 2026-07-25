// Limpeza ESTRUTURAL do transcript (filtro por TIPO, sem regex de conteúdo) — vendado de
// copilot-memory/lib/transcript.mjs. Mantém a CONVERSA (user + assistant), descarta ruído de máquina
// (tool calls/results, hooks, reasoning, usage, permissões). Entrada = eventos do events.jsonl.
import { contentText, norm } from "../util/textNorm.mjs";

// events = array de eventos (SessionEvent-like). Mantém user.message/assistant.message do loop
// principal (ignora agentId e ephemeral). Retorna [{ role, text, id }].
export function cleanTranscript(events) {
  const arr = Array.isArray(events) ? events : (events && events.messages) || [];
  const turns = [];
  for (const e of arr) {
    if (!e || e.ephemeral) continue;
    if (e.agentId) continue;
    if (e.type === "user.message") {
      const t = norm(contentText(e.data && e.data.content));
      if (t) turns.push({ role: "user", text: t, id: e.id });
    } else if (e.type === "assistant.message") {
      const t = norm(contentText(e.data && e.data.content));
      if (t) turns.push({ role: "assistant", text: t, id: e.id });
    }
  }
  return turns;
}

export function renderTurns(turns) {
  return turns.map((t) => `## ${t.role === "user" ? "USER" : "ASSISTANT"}\n${t.text}`).join("\n\n");
}
