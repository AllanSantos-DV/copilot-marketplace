// snapshot.mjs — persiste o CPU acumulado por sessão (.cpu-snapshot.json na pasta da sessão) e decide
// ociosidade pelo SINAL DUPLO validado empiricamente:
//   (1) events.jsonl sem escrita há > IDLE_EVENTS_MS  (nenhum turno/subagente recente), E
//   (2) cpu_delta ≈ 0 desde o snapshot anterior       (nada — agente, subagente ou mesa de ADR — queimou CPU).
// Proteção por design: se QUALQUER sinal indica vida, NÃO é idle. COLD-START (sem snapshot) nunca mata:
// só grava a linha de base para a próxima passada — assim um PID reciclado nunca é morto por engano.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

export const IDLE_EVENTS_MS = 10 * 60 * 1000;      // 10 min sem eventos
export const CPU_DELTA_THRESHOLD = 5_000_000;      // 0,5 s de CPU (unidades de 100 ns) — margem sobre ruído

function snapPath(home, sid) { return join(home, "session-state", sid, ".cpu-snapshot.json"); }

export function readSnapshot(sid, { home = resolveCopilotHome() } = {}) {
  try { return JSON.parse(readFileSync(snapPath(home, sid), "utf8")); } catch { return null; }
}

export function writeSnapshot(sid, data, { home = resolveCopilotHome() } = {}) {
  const p = snapPath(home, sid);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}

// Remove a linha de base (ao descarregar a sessão): o reabrir vira cold-start limpo, nunca morto de imediato.
export function removeSnapshot(sid, { home = resolveCopilotHome() } = {}) {
  try { unlinkSync(snapPath(home, sid)); return true; } catch { return false; }
}

/**
 * Decide se um servidor está OCIOSO (seguro para descarregar).
 * @param {{sessionId:string|null, cpu:number|null, eventsMtimeMs:number|null}} server — item do scan.
 * @param {{cpu:number}|null} prevSnapshot — snapshot anterior (null = cold-start).
 * @param {number} [now]
 * @returns {boolean} true só quando AMBOS os sinais confirmam ociosidade e há linha de base de CPU.
 */
export function isIdle(server, prevSnapshot, now = Date.now()) {
  if (!server || !server.sessionId) return false;               // sem lock → não sabemos a sessão → não mexe
  if (server.eventsMtimeMs == null) return false;               // sem events → não confiável → não mexe
  if ((now - server.eventsMtimeMs) <= IDLE_EVENTS_MS) return false; // sinal 1: houve evento recente → viva
  if (!prevSnapshot || prevSnapshot.cpu == null || server.cpu == null) return false; // cold-start → nunca mata
  const delta = server.cpu - prevSnapshot.cpu;                  // sinal 2: CPU consumida desde a base
  return delta >= 0 && delta < CPU_DELTA_THRESHOLD;             // ~0 → nada trabalhou → ociosa
}
