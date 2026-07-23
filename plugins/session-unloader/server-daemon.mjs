#!/usr/bin/env node
// server-daemon.mjs — DAEMON ÚNICO do painel do session-unloader. Processo standalone e singleton por
// PORT-BINDING (arbiter na PORT fixa) + lockfile (discovery). REUSA a classe Dashboard (fonte única — NÃO
// reimplementa scan/snapshot/HTML: DRY). Token obrigatório (403 sem). IDLE TIMEOUT: 10 min sem request →
// close + unlink lock + exit — assim o daemon do plugin NÃO vira o processo órfão que o plugin combate.
// Args: --home <path> --token <hex> --version <semver>.
import { Dashboard } from "./lib/dashboard.mjs";
import { PORT, writeLock, clearLock } from "./lib/daemon-lock.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";

function arg(name, def) { const i = process.argv.indexOf(name); return (i > 0 && process.argv[i + 1]) ? process.argv[i + 1] : def; }

const home = arg("--home", resolveCopilotHome());
const token = arg("--token", "");
const version = arg("--version", "0.0.0");
const IDLE_MS = 10 * 60 * 1000;

let lastRequest = Date.now();
const dashboard = new Dashboard({ home, token, port: PORT });
// marca atividade a cada request (o Dashboard segue servindo; aqui só alimentamos o idle-timeout)
const origHandle = dashboard._handle.bind(dashboard);
dashboard._handle = (req, res) => { lastRequest = Date.now(); return origHandle(req, res); };

function shutdown() {
  try { dashboard.close(); } catch { /* ignore */ }
  clearLock(home);
  process.exit(0);
}

async function main() {
  try {
    const url = await dashboard.ensureServer(); // binda a PORT fixa; EADDRINUSE → reject (outro daemon venceu)
    writeLock({ home, port: PORT, pid: process.pid, token, version });
    process.stderr.write(`[session-unloader] daemon do painel no ar em ${url} (v${version})\n`);
  } catch (e) {
    // porta ocupada = OUTRO daemon já é o arbiter → sai limpo (idempotência do singleton)
    process.stderr.write(`[session-unloader] daemon nao subiu (${e?.code || e?.message}); outro ja e o arbiter — saindo.\n`);
    process.exit(0);
  }
  const timer = setInterval(() => { if (Date.now() - lastRequest > IDLE_MS) shutdown(); }, 60000);
  timer.unref();
}

process.on("exit", () => { clearLock(home); }); // safety net
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
main();
