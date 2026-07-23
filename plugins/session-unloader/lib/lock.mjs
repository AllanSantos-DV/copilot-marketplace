// lock.mjs — lock anti-race entre scans concorrentes (dois hooks disparando ao mesmo tempo). Criação
// EXCLUSIVA (flag 'wx') + TTL: o primeiro adquire e executa; os demais saem silenciosamente. Um lock
// stale (processo morto sem liberar) é derrubado pelo TTL. Nunca lança.
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

export const LOCK_TTL_MS = 30000;
function lockPath(home) { return join(home, "session-state", ".unloader.lock"); }

export function acquireLock({ home = resolveCopilotHome() } = {}, now = Date.now()) {
  const p = lockPath(home);
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* ok */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx" }); // cria só se não existe
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") return false;
      let prev = null;
      try { prev = JSON.parse(readFileSync(p, "utf8")); } catch { /* ilegível */ }
      if (prev && prev.at && (now - prev.at) < LOCK_TTL_MS) return false; // lock fresco de outro scan
      try { unlinkSync(p); } catch { /* corrida: alguém removeu antes; tenta de novo */ }
    }
  }
  return false;
}

export function releaseLock({ home = resolveCopilotHome() } = {}) {
  try { unlinkSync(lockPath(home)); } catch { /* já removido = ok */ }
}
