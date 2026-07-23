// ensure-daemon.mjs — garante o DAEMON ÚNICO do painel vivo e retorna { url, token }. find-or-start
// IDEMPOTENTE e fail-open (padrão bolão) + version-mismatch (mata o velho num upgrade) + limpeza do painel
// legado v0.2.0. Se N sessões chamam ao mesmo tempo, o PORT-BINDING arbitra: só 1 daemon vive; os demais
// leem o lockfile do vencedor e usam o token dele.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter, basename } from "node:path";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import { HOST, readLock, clearLock, isAlive, isDaemonAlive } from "./lib/daemon-lock.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server-daemon.mjs");

// Resolve um NODE de verdade pra spawnar o daemon. DENTRO da extensão canvas o process.execPath é o
// `copilot.exe` (wrapper do CLI) — ele IGNORA ELECTRON_RUN_AS_NODE e trata os args como comando do CLI
// (`unknown option`), então o daemon nunca nascia e o painel caía SEMPRE no fallback in-process (1 servidor
// POR sessão — o oposto do preceito). Estratégia: (1) execPath se já for node; (2) node no PATH; (3) último
// recurso, o execPath como electron-as-node (vale onde o host É electron real). null → sem node → fallback.
export function resolveNodeExec() {
  const ep = process.execPath || "";
  const base = basename(ep).toLowerCase();
  if (base === "node.exe" || base === "node") return { exec: ep, electronAsNode: false };
  const names = process.platform === "win32" ? ["node.exe", "node.cmd", "node"] : ["node"];
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const cand = join(dir, n);
      try { if (existsSync(cand)) return { exec: cand, electronAsNode: false }; } catch { /* ignore */ }
    }
  }
  return ep ? { exec: ep, electronAsNode: true } : null;
}

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

  // spawn detached — sobrevive ao processo do host. Usa um NODE REAL (resolveNodeExec); só ativa
  // ELECTRON_RUN_AS_NODE quando o executável é o host electron (não quando é node.exe puro).
  const token = crypto.randomBytes(16).toString("hex");
  const node = resolveNodeExec();
  if (!node) throw new Error("nenhum node executável encontrado para subir o daemon");
  const env = { ...process.env };
  if (node.electronAsNode) env.ELECTRON_RUN_AS_NODE = "1"; else delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(node.exec, [SERVER, "--home", home, "--token", token, "--version", version], {
    cwd: HERE,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // aguarda o daemon (vencedor do arbiter) publicar o lockfile e responder /health.
  // 12×500ms = 6s de folga: cobre o COLD-START no Windows (node embutido + import de scan/guards +
  // bind da porta + escrita do lockfile em disco frio/Defender) pós-idle, sem cair no fallback à toa.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const lk2 = readLock(home);
    if (lk2 && await isDaemonAlive({ home, port: lk2.port, token: lk2.token, timeoutMs: 500 })) {
      return { url: `http://${HOST}:${lk2.port}/`, token: lk2.token };
    }
  }
  throw new Error("daemon do painel não confirmou a porta a tempo (6s)");
}
