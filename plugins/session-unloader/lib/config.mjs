// config.mjs — configuração GLOBAL do daemon único (não per-session). `enabled` liga/desliga o MODO
// AUTOMÁTICO: o scan-hook consulta antes de descarregar. Regras:
//   - arquivo AUSENTE (1ª vez) → default LIGADO (não quebra o comportamento atual);
//   - arquivo CORROMPIDO / erro real de I/O → FAIL-CLOSED (enabled:false): melhor não descarregar do que
//     matar por acidente com config quebrada.
// Write ATÔMICO (tmp→rename) com retry EBUSY/EPERM (Windows: MoveFileEx falha se o arquivo está aberto).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

const DEFAULTS = { enabled: true };
const configPath = (home) => join(home, "session-state", ".unloader-config.json");
function sleepSync(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy-wait curto, raro */ } }

export function readConfig({ home = resolveCopilotHome() } = {}) {
  let raw;
  try { raw = readFileSync(configPath(home), "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? { ...DEFAULTS } : { enabled: false }; } // ausente=on; erro real=fail-closed
  try { return { ...DEFAULTS, ...JSON.parse(raw) }; }
  catch { return { enabled: false }; }                                                  // corrompido=fail-closed
}

export function writeConfig(patch, { home = resolveCopilotHome() } = {}) {
  const next = { ...readConfig({ home }), ...patch };
  const p = configPath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next));
  const delays = [50, 100, 200];
  for (let i = 0; i < delays.length + 1; i++) {
    try { renameSync(tmp, p); return next; }
    catch (e) {
      if (i >= delays.length || (e.code !== "EBUSY" && e.code !== "EPERM")) throw e;
      sleepSync(delays[i]);
    }
  }
  return next;
}
