// LADO GESTOR do worker de sessão viva — gerencia UM processo liveWorker.mjs pelo protocolo NDJSON:
// spawna o node LIMPO, espera o `ready`, envia `turn` (serializados — 1 por vez), lê os `result` por id,
// pede `history`, e fecha. É a peça que o gestor da mesa (liveTable) usa, uma por AGENTE da mesa.
//
// FAIL LOUD: turno que falha volta { ok:false, error } VISÍVEL; morte inesperada do processo rejeita os
// turnos pendentes com o motivo. Isolamento: env limpo + NODE_NO_WARNINGS (sem ruído mascarando erro).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveNode } from "../util/resolveNode.mjs";
import { workers } from "../util/workerRegistry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_WORKER = join(HERE, "liveWorker.mjs");

/**
 * @param {{ role:string, system:string, model?:string, cwd?:string, configDir?:string, skillDirectories?:string[], reasoningEffort?:string, log?:(m:string)=>void }} opts
 */
export function createLiveWorker({ role, system, model, cwd, configDir, skillDirectories, reasoningEffort, resume, memoryScope = null, log = () => {} } = {}) {
  if (!role) throw new Error("createLiveWorker: role vazio");
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.COPILOT_SDK_PATH;
  env.NODE_NO_WARNINGS = "1";
  env.MODO_AUTO_WORKER_CWD = cwd || process.cwd();
  if (model) env.MODO_AUTO_WORKER_MODEL = model;
  env.MODO_AUTO_WORKER_SYSTEM = String(system || "");
  env.MODO_AUTO_WORKER_ROLE = String(role || ""); // Fase 2: o liveWorker usa o papel p/ injetar tools (pesquisador → web)
  if (configDir) env.MODO_AUTO_WORKER_CONFIGDIR = configDir;
  if (Array.isArray(skillDirectories) && skillDirectories.length) env.MODO_AUTO_WORKER_SKILLDIRS = JSON.stringify(skillDirectories);
  if (reasoningEffort) env.MODO_AUTO_WORKER_EFFORT = reasoningEffort;
  if (resume) env.MODO_AUTO_WORKER_RESUME = String(resume); // RELIGAR: resume a sessão (histórico preservado)
  // ESCOPO DE MEMÓRIA CRAVADO PELO PAI: o worker da mesa viva ganha `memory_search` já amarrado a este projeto.
  // Sem escopo, a variável nem existe e o worker sobe sem tool de memória (adaptador, não dependência).
  if (memoryScope) env.MODO_AUTO_WORKER_MEMORY_SCOPE = String(memoryScope);

  let child = null, buf = "", err = "", sessionId = null, closed = false, nextId = 0;
  const waiters = new Map();       // id → resolve(result)
  let readyResolve = null, readyReject = null;
  const readyP = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  function onLine(line) {
    const s = line.trim(); if (!s) return;
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.type === "ready") { sessionId = m.sessionId; readyResolve?.({ sessionId }); }
    else if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    else if (m.type === "history" && waiters.has("history")) { waiters.get("history")(m.events || []); waiters.delete("history"); }
  }

  function start() {
    if (child) return;
    child = spawn(resolveNode(), [LIVE_WORKER], { env, cwd: cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    workers.track(child);
    child.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(l); } });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      closed = true;
      const reason = `worker '${role}' encerrou (code ${code})${err ? ": " + err.slice(-200) : ""}`;
      readyReject?.(new Error(reason));
      for (const [, res] of waiters) res({ ok: false, error: reason }); // FAIL LOUD: turnos pendentes recebem o motivo
      waiters.clear();
    });
  }

  return {
    role, get sessionId() { return sessionId; },
    async ready(timeoutMs = 60000) {
      start();
      return Promise.race([
        readyP,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`worker '${role}' nao ficou ready em ${timeoutMs}ms`)), timeoutMs).unref?.()),
      ]);
    },
    // Um TURNO do agente (serializado pelo id). Devolve { ok, text|error }. `schema` (opcional) ativa o TOOL
    // TEMPLATE: o worker registra a submit tool e devolve os args capturados (JSON) em vez de prosa.
    turn(prompt, timeoutMs = 150000, schema = null) {
      if (closed) return Promise.resolve({ ok: false, error: `worker '${role}' ja encerrado` });
      const id = ++nextId;
      return new Promise((res) => {
        waiters.set(id, (m) => res(m.ok ? { ok: true, text: m.text || "" } : { ok: false, error: m.error || "erro desconhecido" }));
        try { child.stdin.write(JSON.stringify({ type: "turn", id, prompt, timeoutMs, ...(schema ? { schema } : {}) }) + "\n"); }
        catch (e) { waiters.delete(id); res({ ok: false, error: "stdin: " + (e?.message || e) }); }
      });
    },
    history() {
      if (closed) return Promise.resolve([]);
      return new Promise((res) => { waiters.set("history", res); try { child.stdin.write(JSON.stringify({ type: "history" }) + "\n"); } catch { res([]); } });
    },
    close() {
      if (!child || closed) return;
      try { child.stdin.write(JSON.stringify({ type: "close" }) + "\n"); } catch { /* ignore */ }
      setTimeout(() => { workers.reap(child); }, 1500).unref?.();
    },
  };
}
