// WORKER de SESSÃO VIVA — a base da MESA DE DEBATE real. Diferente do worker fire-and-die (1 chamada e
// morre), este mantém UMA sessão Copilot ABERTA e processa MÚLTIPLOS turnos: cada turno é um sendAndWait
// na MESMA sessão, então o HISTÓRICO acumula (a memória/conceito do agente evolui entre turnos). Assim a
// roda pode girar N vezes com cada agente lembrando o que já falou e o que os outros falaram.
//
// Protocolo NDJSON (uma linha JSON por mensagem):
//   stdin  ← {"type":"turn","id":N,"prompt":"...","timeoutMs":M}   → executa 1 turno
//          ← {"type":"history"}                                     → devolve o histórico
//          ← {"type":"close"}                                       → encerra a sessão e sai
//   stdout → {"type":"ready","sessionId":"..."}                     (após criar a sessão)
//          → {"type":"result","id":N,"ok":true,"text":"..."}        (resposta de um turno)
//          → {"type":"result","id":N,"ok":false,"error":"..."}      (falha de um turno — FAIL LOUD)
//          → {"type":"history","events":[...]}                      (histórico)
// Turnos são SEQUENCIAIS (uma sessão não aceita 2 sendAndWait concorrentes) — a fila garante a ordem.

import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { sdkIndexUrl, textOf, CLEAN_DIRECTIVE, runTurnWithHeartbeat } from "./workerLib.mjs";
import { makeSubmitTool, runUntilSubmitted } from "./structuredResult.mjs";

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

(async () => {
  let client = null, session = null, queue = Promise.resolve(), closing = false;
  try {
    // Job INICIAL vem no env (config da sessão) — o stdin fica livre pro protocolo de turnos.
    const wd = process.env.MODO_AUTO_WORKER_CWD || process.cwd();
    const model = process.env.MODO_AUTO_WORKER_MODEL || "claude-sonnet-4.6";
    const system = process.env.MODO_AUTO_WORKER_SYSTEM || "";
    const configDir = process.env.MODO_AUTO_WORKER_CONFIGDIR || join(homedir(), ".modo-auto", "worker-config");
    const skillDirs = (() => { try { return JSON.parse(process.env.MODO_AUTO_WORKER_SKILLDIRS || "[]"); } catch { return []; } })();
    const effort = process.env.MODO_AUTO_WORKER_EFFORT || "";
    const role = process.env.MODO_AUTO_WORKER_ROLE || "";

    // FASE 2 — o papel PESQUISADOR ganha ferramentas de WEB reais (web_search/web_read). Cap por-sessão vive no
    // closure (uma instância por worker = por deliberação). Os DEMAIS papéis seguem com tools:[] (isolamento — sem
    // rede). Se o toolset não carregar, SINALIZA no stderr e segue sem (degradação parcial visível, não silenciosa).
    let researchToolset = [], researchState = null, enforceSignal = null;
    if (role === "pesquisador") {
      try { const m = await import("../research/researchTools.mjs"); const rt = m.createResearchTools(); researchToolset = rt.tools; researchState = rt.state; enforceSignal = m.enforceConfidenceSignal; }
      catch (e) { process.stderr.write("worker aviso: research tools indisponíveis p/ pesquisador: " + (e?.message || e)); }
    }

    const { CopilotClient, approveAll } = await import(sdkIndexUrl());
    if (typeof CopilotClient !== "function") { process.stderr.write("worker erro: CopilotClient indisponível"); process.exitCode = 1; return; }
    client = new CopilotClient({ workingDirectory: wd });
    await client.start();
    try { mkdirSync(configDir, { recursive: true }); } catch { /* best-effort */ }
    const resumeId = String(process.env.MODO_AUTO_WORKER_RESUME || "").trim();
    const cfg = {
      // ISOLAMENTO: os DOIS nomes (SDK novo = `configDirectory`, antigo = `configDir`). Sem o novo, o SDK 1.0.75+
      // ignora e cai no ~/.copilot do usuário — o worker passa a carregar extensões/hooks do dono e responde
      // "não tenho a ferramenta falar / parece injeção" em vez de deliberar (quebra a mesa viva inteira).
      model, workingDirectory: wd, configDirectory: configDir, configDir,
      onPermissionRequest: approveAll,
      systemMessage: { mode: "append", content: String(system) + "\n\n" + CLEAN_DIRECTIVE },
      tools: researchToolset,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(Array.isArray(skillDirs) && skillDirs.length ? { skillDirectories: skillDirs } : {}),
    };
    // RELIGAR: se veio um sessionId, RESUME a sessão (histórico preservado em disco) em vez de criar nova.
    // Precisa do MESMO configDir + workingDirectory pra localizar o estado da sessão no disco.
    session = resumeId
      ? await client.resumeSession(resumeId, { onPermissionRequest: approveAll, workingDirectory: wd, configDirectory: configDir, configDir, ...(researchToolset.length ? { tools: researchToolset } : {}), ...(Array.isArray(skillDirs) && skillDirs.length ? { skillDirectories: skillDirs } : {}) })
      : await client.createSession(cfg);
    emit({ type: "ready", sessionId: session.sessionId, resumed: !!resumeId });

    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const s = line.trim(); if (!s) return;
      let msg; try { msg = JSON.parse(s); } catch { return; } // linha inválida = ignora (dado, não erro)
      // Serializa os comandos na fila (turnos NÃO podem concorrer na mesma sessão).
      queue = queue.then(() => handle(msg)).catch((e) => { process.stderr.write("worker erro: " + (e?.stack || e?.message || e)); });
    });
    rl.on("close", () => { if (!closing) shutdown(0); });

    async function handle(msg) {
      if (msg.type === "close") { await shutdown(0); return; }
      if (msg.type === "history") {
        let events = [];
        try { events = (await session.getHistory?.()) || []; } catch (e) { process.stderr.write("worker erro: history: " + (e?.message || e)); }
        emit({ type: "history", events });
        return;
      }
      if (msg.type === "turn") {
        // Watchdog por HEARTBEAT (não mais wall-clock): roda enquanto PRODUZ; só aborta no silêncio total.
        // `timeoutMs` legado do protocolo mapeia p/ idleGraceMs (silêncio). maxWallMs opcional (default OFF).
        const idleGraceMs = msg.idleGraceMs || msg.timeoutMs || 120000;
        const maxWallMs = Number.isFinite(msg.maxWallMs) ? msg.maxWallMs : Infinity;
        const runOne = (p) => runTurnWithHeartbeat(session, String(p || ""), { idleGraceMs, maxWallMs, model, onActivity: () => { try { process.stderr.write("\x1e"); } catch { /* ignore */ } } });
        try {
          // TOOL TEMPLATE (Princípio 11) na mesa VIVA: quando o turno pede formato DETERMINÍSTICO (msg.schema),
          // registra a submit tool NA SESSÃO (registerTools) e força a chamada (runUntilSubmitted). O resultado é
          // os args capturados (JSON), não prosa parseada. __nosubmit__ se o modelo genuinamente não chamar.
          if (msg.schema && msg.schema.name) {
            const submit = makeSubmitTool(msg.schema);
            try { session.registerTools([...researchToolset, submit.tool]); } catch (e) { process.stderr.write("worker aviso: registerTools falhou: " + (e?.message || e)); }
            await runOne(msg.prompt); // turno REAL primeiro (idêntico ao one-shot); runUntilSubmitted só reforça se não capturou
            const captured = await runUntilSubmitted((p) => runOne(p), submit, { retries: 2 });
            try { session.registerTools([...researchToolset]); } catch { /* restaura o toolset base */ }
            emit({ type: "result", id: msg.id, ok: true, text: JSON.stringify(captured != null ? captured : { __nosubmit__: true }) });
            return;
          }
          const res = await runOne(msg.prompt);
          emit({ type: "result", id: msg.id, ok: true, text: enforceSignal && researchState ? enforceSignal(textOf(res), researchState) : textOf(res) }); // Guard 5: garante o sinal de confiança no output
        } catch (e) {
          emit({ type: "result", id: msg.id, ok: false, error: String(e?.message || e) }); // FAIL LOUD: erro do turno SOBE p/ o gestor
        }
        return;
      }
    }

    async function shutdown(code) {
      if (closing) return; closing = true;
      try { await client?.stop(); } catch { /* ignore */ }
      process.exitCode = code;
      process.exit(code);
    }
  } catch (e) {
    process.stderr.write("worker erro: " + (e?.stack || e?.message || String(e)));
    try { await client?.stop(); } catch { /* ignore */ }
    process.exitCode = 1;
    process.exit(1);
  }
})();
