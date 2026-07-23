// extension.mjs — expõe a tool `unload_idle` ao agente (via joinSession do host). O scan automático é
// feito pelos command hooks (hooks.json → boot.mjs); aqui NÃO há hooks programáticos (evita duplicar).
// Import do SDK é dinâmico e guardado por SESSION_UNLOADER_SMOKE (permite importar { tools } em teste).
import { unloadIdle } from "./lib/unload.mjs";

function fmtList(items) {
  if (!items || !items.length) return "  (nenhuma)";
  return items.map((c) => `  • ${c.sessionId || "?"} (pid ${c.pid})`).join("\n");
}

export const tools = [
  {
    name: "unload_idle",
    description:
      "Descarrega da memória as sessões ociosas do Copilot (mata a árvore do processo-servidor sem apagar a " +
      "sessão do disco; o lazy-load reabre depois com chat e histórico). Por padrão faz DRY-RUN: só lista as " +
      "candidatas (sessão sem eventos há >10min E com CPU zerada). Passe force=true para descarregar de verdade. " +
      "Nunca encerra a sessão atual, subagente ativo, mesa de deliberação, nem daemons compartilhados.",
    parameters: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "true (padrão): só lista; false/force: executa o kill." },
        force: { type: "boolean", description: "Atalho para dryRun=false — descarrega de verdade." },
        sessionId: { type: "string", description: "Opcional: descarregar só uma sessão específica (pelo id)." }
      },
      additionalProperties: false
    },
    handler: async (args, _invocation) => {
      const force = args?.force === true || args?.dryRun === false;
      const dryRun = !force;
      const res = await unloadIdle({ dryRun, sessionId: args?.sessionId || null });

      if (dryRun) {
        if (!res.candidates?.length) {
          return "✅ Nenhuma sessão ociosa agora (nada sem eventos há >10min E com CPU zerada).";
        }
        return `🔎 DRY-RUN — ${res.candidates.length} sessão(ões) ociosa(s) candidata(s):\n${fmtList(res.candidates)}\n\n` +
          "Rode com force=true para descarregar (reversível: o app reabre pelo lazy-load).";
      }

      const skippedNote = res.skipped?.length
        ? `\n⏭️ Preservadas por guarda (ativa/singleton/self): ${res.skipped.length}.`
        : "";
      return `✅ Descarregadas ${res.killed?.length || 0} sessão(ões) ociosa(s):\n${fmtList(res.killed)}${skippedNote}\n` +
        "Reversível: reabra a sessão no app (o lazy-load restaura chat e histórico; extensões via reload).";
    }
  }
];

// Sem hooks programáticos: o scan automático é feito pelos command hooks (boot.mjs).
export const hooks = {};

// Entry do host — só junta à sessão fora de modo smoke/teste.
if (!process.env.SESSION_UNLOADER_SMOKE) {
  const { joinSession } = await import("@github/copilot-sdk/extension");
  const session = await joinSession({ tools, hooks });
  session.log?.("session-unloader ativo — tool unload_idle + scan automático (SessionStart/UserPromptSubmit).");
}
