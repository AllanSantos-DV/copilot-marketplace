// WORKER de sub-agente (fire-and-die) — roda como node LIMPO (fora do fork da extensão). Lê um job JSON
// do stdin { system, prompt, model, timeoutMs } e roda CopilotClient.createSession com o system prompt do
// papel, imprimindo a resposta crua no stdout. Padrão de copilot-memory/lib/curatorWorker.mjs: dentro do
// fork o resolver hook quebra o CopilotClient; num node filho limpo o SDK sobe. (Sessão VIVA multi-turno:
// ver liveWorker.mjs.)

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { sdkIndexUrl, textOf, CLEAN_DIRECTIVE, runTurnWithHeartbeat } from "./workerLib.mjs";
import { usageFromEvent, mergeUsage } from "../activity/costMeter.mjs";
import { makeSubmitTool, runUntilSubmitted } from "./structuredResult.mjs";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

(async () => {
  let client = null;
  try {
    const job = JSON.parse((await readStdin()) || "{}");
    const wd = process.env.MODO_AUTO_WORKER_CWD || process.cwd();
    const model = job.model || process.env.MODO_AUTO_WORKER_MODEL || "claude-sonnet-4.6";
    const { CopilotClient, approveAll } = await import(sdkIndexUrl());
    if (typeof CopilotClient !== "function") { process.stderr.write("CopilotClient indisponível"); process.exitCode = 1; return; }
    client = new CopilotClient({ workingDirectory: wd });
    await client.start();
    // configDir ISOLADO: o CLI deste worker não enxerga ~/.copilot/extensions, então extensões do
    // usuário (ex.: voice-chat) NÃO se anexam à sessão do worker e não injetam o mandato de voz.
    const configDir = process.env.MODO_AUTO_WORKER_CONFIGDIR || join(homedir(), ".modo-auto", "worker-config");
    try { mkdirSync(configDir, { recursive: true }); } catch { /* best-effort */ }
    // FASE 2 (one-shot) — o papel PESQUISADOR na mesa CLÁSSICA (factory.run → usado pelo MODO AUTÔNOMO ao
    // responder ask_user) ganha as WEB tools. ASSIMETRIA ALINHADA (antes era fail-closed só-web AQUI): agora o
    // pesquisador recebe web tools + os built-ins do CLI (pesquisa externa E interna), IGUAL à mesa viva
    // (liveWorker) — comportamento CONSISTENTE nos dois caminhos. Demais papéis: tools:[] + job.availableTools.
    let researchToolset = [], researchState = null, enforceSignal = null;
    if (job.role === "pesquisador") {
      try { const m = await import("../research/researchTools.mjs"); const rt = m.createResearchTools(); researchToolset = rt.tools; researchState = rt.state; enforceSignal = m.enforceConfidenceSignal; }
      catch (e) { process.stderr.write("worker aviso: research tools indisponíveis p/ pesquisador: " + (e?.message || e)); }
    }
    // TOOL TEMPLATE (Princípio 11) — quando o caller pede formato DETERMINÍSTICO (job.schema), a resposta vem de
    // uma TOOL cujo schema o SDK IMPÕE (submit_<x>), não de "responda SOMENTE JSON" + parse de prosa (frágil, varia
    // por modelo — causou o bug do onStop/triage). O handler captura os args; devolvemos eles crus no stdout.
    const submit = job.schema && job.schema.name ? makeSubmitTool(job.schema) : null;
    const tools = [...researchToolset, ...(submit ? [submit.tool] : [])];
    // availableTools = allowlist. Omitido (null) → built-ins + custom liberados (pesquisador/revisor investigam e
    // depois submetem). Caller passou lista (crítico puro) → fail-closed; a submit é SEMPRE anexada p/ ser chamável.
    let avail = Array.isArray(job.availableTools) ? [...job.availableTools] : null;
    if (submit && avail) avail.push(submit.name);
    const session = await client.createSession({
      model,
      workingDirectory: wd,
      configDir,
      onPermissionRequest: approveAll,
      systemMessage: { mode: "append", content: String(job.system || "") + "\n\n" + CLEAN_DIRECTIVE },
      tools,
      ...(avail ? { availableTools: avail } : {}), // null → built-ins + custom; lista → fail-closed (crítico/text-only)
      ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
      ...(Array.isArray(job.skillDirectories) && job.skillDirectories.length ? { skillDirectories: job.skillDirectories } : {}),
    });
    // Watchdog por HEARTBEAT (não mais wall-clock): o turno roda enquanto PRODUZ; só aborta se TRAVAR
    // (silêncio total > idleGraceMs). `timeoutMs` legado do job mapeia p/ idleGraceMs. FAIL LOUD no hung.
    const idleGraceMs = job.idleGraceMs || job.timeoutMs || 120000;
    const maxWallMs = Number.isFinite(job.maxWallMs) ? job.maxWallMs : Infinity;
    // PULSO de atividade pro PAI: a cada evento do SDK, escreve \x1e no stderr → o reaper do pai (por atividade)
    // reseta e NUNCA mata um worker que está trabalhando. O pai filtra esse marcador do texto de erro.
    // CUSTO: acumula o usage dos eventos assistant.usage (tokens/nanoAiu — shape PROVADO no probe-usage-shape).
    let usage = null;
    const res = await runTurnWithHeartbeat(session, String(job.prompt || ""), { idleGraceMs, maxWallMs, model, onActivity: (ev) => {
      try { process.stderr.write("\x1e"); } catch { /* ignore */ }
      if (ev?.type === "assistant.usage") { try { usage = mergeUsage(usage, usageFromEvent(ev.data, model)); } catch { /* custo é enriquecimento — nunca derruba o turno */ } }
    } });
    if (submit) {
      // Resposta ESTRUTURADA (tool template): captura os args NO INSTANTE em que o modelo chama a tool. Se ainda
      // não chamou, LOOP de reforço LIMITADO (o SDK não tem toolChoice:required nem Stop hook p/ worker). Se após
      // as tentativas o modelo genuinamente NÃO submeter → sentinela __nosubmit__ (o caller DEGRADA sinalizado ou
      // FALHA LOUD — nunca finge um veredito). Captura-na-chamada = determinístico; só o "nunca chamou" degrada.
      const captured = await runUntilSubmitted(
        (p) => runTurnWithHeartbeat(session, p, { idleGraceMs, maxWallMs, model, onActivity: () => { try { process.stderr.write("\x1e"); } catch { /* ignore */ } } }),
        submit, { retries: 2 });
      process.stdout.write(JSON.stringify(captured != null ? captured : { __nosubmit__: true }));
    } else {
      // Guard 5 — enforcement determinístico do sinal de confiança (pesquisador). No-op pros demais papéis.
      process.stdout.write(enforceSignal && researchState ? enforceSignal(textOf(res), researchState) : textOf(res));
    }
    // emite o custo do turno numa linha estruturada no stderr (o pai extrai; heartbeat \x1e solo segue por compat).
    if (usage) { try { process.stderr.write("\x1e#USAGE " + JSON.stringify(usage) + "\n"); } catch { /* ignore */ } }
  } catch (e) {
    process.stderr.write("worker erro: " + (e?.stack || e?.message || String(e)));
    process.exitCode = 1;
  } finally {
    try { await client?.stop(); } catch { /* ignore */ }
  }
})();
