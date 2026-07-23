// daemon-lock.mjs — descoberta/estado do DAEMON ÚNICO do painel (session-unloader).
// Arbitragem de instância única = PORT-BINDING (quem consegue bindar a PORT vence; em NTFS o O_EXCL não tem
// a semântica do Unix, então NÃO dependemos de lock de arquivo p/ exclusão — a porta é o árbitro).
// O lockfile é só DISCOVERY: grava porta + pid + token + version p/ os clients (extension), o health e o kill.
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";
import { pidAlive } from "./process-utils.mjs";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.SESSION_UNLOADER_PORT || 8787);
export const lockPath = (home = resolveCopilotHome()) => join(home, "session-state", ".unloader-daemon.json");

export function writeLock({ home = resolveCopilotHome(), port, pid, token, version }) {
  try {
    const p = lockPath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ port, pid, token, version, at: new Date().toISOString() }));
    return true;
  } catch { return false; }
}
export function readLock(home = resolveCopilotHome()) {
  try { return JSON.parse(readFileSync(lockPath(home), "utf8")); } catch { return null; }
}
export function clearLock(home = resolveCopilotHome()) {
  try { const p = lockPath(home); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
}
export { pidAlive as isAlive };

// Health do daemon (GET /health?token=). Porta explícita, ou a do lockfile, ou a PORT padrão.
export async function isDaemonAlive({ home = resolveCopilotHome(), port, token, timeoutMs = 1000 } = {}) {
  const lk = readLock(home);
  const p = port || lk?.port || PORT;
  const tk = token || lk?.token || "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://${HOST}:${p}/health${tk ? `?token=${encodeURIComponent(tk)}` : ""}`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
