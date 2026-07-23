// ensure-daemon.mjs — garante o DAEMON ÚNICO do painel vivo e retorna { url, token }. find-or-start
// IDEMPOTENTE e fail-open (padrão bolão) + version-mismatch (mata o velho num upgrade) + limpeza do painel
// legado v0.2.0. Se N sessões chamam ao mesmo tempo, o PORT-BINDING arbitra: só 1 daemon vive; os demais
// leem o lockfile do vencedor e usam o token dele.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import crypto from "node:crypto";
import { HOST, readLock, clearLock, isAlive, isDaemonAlive } from "./lib/daemon-lock.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server-daemon.mjs");

function pkgVersion() {
  try { return JSON.parse(readFileSync(join(HERE, "plugin.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
}
const majorMinor = (v) => { const p = String(v || "0.0.0").split("."); return `${p[0]}.${p[1]}`; };

export async function ensureDaemon(home = resolveCopilotHome()) {
  try { unlinkSync(join(home, "session-state", ".unloader-dashboard-port.json")); } catch { /* painel legado v0.2.0 — best-effort */ }

  const version = pkgVersion();
  const lk = readLock(home);

  if (lk && isAlive(lk.pid) && await isDaemonAlive({ home, port: lk.port, token: lk.token, timeoutMs: 800 })) {
    if (majorMinor(lk.version) !== majorMinor(version)) {           // upgrade → mata o velho
      try { process.kill(lk.pid, "SIGTERM"); } catch { /* já morto */ }
      await new Promise((r) => setTimeout(r, 500));
      clearLock(home);
    } else {
      return { url: `http://${HOST}:${lk.port}/`, token: lk.token }; // vivo e na versão certa → reusa
    }
  } else if (lk) {
    clearLock(home);                                                // lockfile stale (pid morto/health fail)
  }

  // spawn detached — sobrevive ao processo do host; ELECTRON_RUN_AS_NODE=1 roda o node embutido como node puro
  const token = crypto.randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [SERVER, "--home", home, "--token", token, "--version", version], {
    cwd: HERE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // aguarda o daemon (vencedor do arbiter) publicar o lockfile e responder /health
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const lk2 = readLock(home);
    if (lk2 && await isDaemonAlive({ home, port: lk2.port, token: lk2.token, timeoutMs: 500 })) {
      return { url: `http://${HOST}:${lk2.port}/`, token: lk2.token };
    }
  }
  throw new Error("daemon do painel não confirmou a porta a tempo");
}
