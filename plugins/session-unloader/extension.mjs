// extension.mjs — CLIENTE FINO. Expõe a tool `unload_idle` e o canvas do painel ao agente (via
// joinSession do host). TODO o núcleo pesado (scan/procmap/guards/telemetria/unload) vive SÓ no
// processo do daemon único (server-daemon.mjs); este arquivo nunca o importa, direta ou
// transitivamente — ele só sabe achar/subir o daemon (ensure-daemon.mjs) e falar HTTP com ele
// (lib/daemon-client.mjs). Falha do daemon é visível (erro explícito); não existe fallback local.
import { ensureDaemon } from "./ensure-daemon.mjs";
import { requestUnload } from "./lib/daemon-client.mjs";
import { CANVAS_ID, CANVAS_TITLE } from "./lib/canvas-meta.mjs";

function fmtList(items) {
  if (!items || !items.length) return "  (nenhuma)";
  return items.map((c) => `  • ${c.sessionId || "?"} (pid ${c.pid}; ${c.reason || "sem motivo"})`).join("\n");
}

export const tools = [
  {
    name: "unload_idle",
    description:
      "Descarrega da memória as sessões ociosas do Copilot (mata a árvore do processo-servidor sem apagar a " +
      "sessão do disco; o lazy-load reabre depois com chat e histórico). Por padrão faz DRY-RUN: só lista as " +
      "candidatas após inatividade contínua da árvore inteira pelo tempo configurado no canvas. Passe force=true " +
      "para descarregar de verdade. Voz, workers/mesas allowlisted, a sessão atual e daemons compartilhados são preservados.",
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
      // encaminha ao DAEMON ÚNICO — nunca executa a avaliação/kill no processo da sessão.
      // Falha do daemon propaga (fail loud): sem fallback, sem "sucesso" fabricado.
      const res = await requestUnload({ ensureDaemonFn: ensureDaemon, dryRun, sessionId: args?.sessionId || null, callerPid: process.pid });

      if (dryRun) {
        if (!res.candidates?.length) {
          return "✅ Nenhuma sessão atingiu agora a política configurada de inatividade contínua da árvore.";
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

// Sem hooks programáticos: o scan/nudge automático é feito pelos command hooks (boot.mjs/scan-hook.mjs),
// que também são clientes finos do daemon.
export const hooks = {};

// Entry do host — só junta à sessão fora de modo smoke/teste.
if (!process.env.SESSION_UNLOADER_SMOKE) {
  const { joinSession, createCanvas } = await import("@github/copilot-sdk/extension");
  const panel = createCanvas({
    id: CANVAS_ID,
    displayName: "Session Unloader",
    description: "Painel do session-unloader: status, telemetria (descargas e RAM liberada) e as sessões carregadas agora (candidatas × protegidas). Servido por um daemon ÚNICO compartilhado entre as sessões.",
    open: async () => {
      // THIN-CLIENT: aponta pro DAEMON ÚNICO (1 leitura de processos p/ N sessões). token + callerPid (esta
      // sessão). Sem fallback: se o daemon não subir, o erro propaga com contexto — o painel nunca cai para
      // um segundo servidor in-process (isso violaria o preceito singleton).
      try {
        const { url, token } = await ensureDaemon();
        return { title: CANVAS_TITLE, url: `${url}?token=${encodeURIComponent(token)}&callerPid=${process.pid}` };
      } catch (e) {
        throw new Error(`session-unloader: daemon do painel indisponível — ${e?.message || e}`);
      }
    },
  });
  const session = await joinSession({ tools, canvases: [panel], hooks });
  session.log?.("session-unloader ativo — decisão por árvore inteira + allowlist configurável; automático fail-closed.");
}
