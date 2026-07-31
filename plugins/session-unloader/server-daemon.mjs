#!/usr/bin/env node
// server-daemon.mjs — DAEMON ÚNICO do painel do session-unloader. Processo standalone e singleton por
// PORT-BINDING (arbiter na PORT fixa) + lockfile (discovery). REUSA a classe Dashboard (fonte única — NÃO
// reimplementa scan/snapshot/HTML: DRY). Token obrigatório (403 sem). IDLE TIMEOUT: 10 min sem
// lease/atividade E automático desligado E sem scan em voo → close + unlink lock + exit (lib/daemon-lifecycle.mjs
// decide isso puramente — testável sem esperar 10 min de verdade). Quando `enabled:true`, um
// scheduler ÚNICO (lib/scheduler.mjs) avalia em cadência própria, independente de qualquer prompt.
// Args: --home <path> --token <hex> --version <semver>.
import { Dashboard } from "./lib/dashboard.mjs";
import { PORT, writeLock, clearLock, readLock } from "./lib/daemon-lock.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";
import { readConfig } from "./lib/config.mjs";
import { createScheduler } from "./lib/scheduler.mjs";
import { shouldIdleExit } from "./lib/daemon-lifecycle.mjs";

function arg(name, def) { const i = process.argv.indexOf(name); return (i > 0 && process.argv[i + 1]) ? process.argv[i + 1] : def; }

const home = arg("--home", resolveCopilotHome());
const token = arg("--token", "");
const version = arg("--version", "0.0.0");
const IDLE_MS = 10 * 60 * 1000;
const startTime = Date.now();

let lastActivityAt = Date.now(); // lease/heartbeat: qualquer request (painel aberto fazendo poll) renova
const dashboard = new Dashboard({ home, token, port: PORT, version, startTime });
// marca atividade a cada request (o Dashboard segue servindo; aqui só alimentamos o idle-timeout/lease)
const origHandle = dashboard._handle.bind(dashboard);
dashboard._handle = (req, res) => { lastActivityAt = Date.now(); return origHandle(req, res); };

// scheduler do automático: inerte quando config.enabled:false (checa a cada tick); nunca precisa de
// restart do daemon para ligar/desligar — o toggle do painel já muda o que readConfig devolve.
const scheduler = createScheduler({ home, isEnabledFn: () => readConfig({ home }).enabled });

// Ownership do lock: só true DEPOIS de um writeLock() bem-sucedido NESTE processo. Em corrida de start
// concorrente, o PERDEDOR (EADDRINUSE) nunca chega a setar isso — então seu exit nunca mexe no lockfile,
// mesmo que o vencedor já o tenha publicado nesse meio-tempo. Defesa em profundidade: além da flag local,
// só limpa se o lock em disco AINDA aponta pro nosso próprio pid (protege até contra um cenário exótico
// de sobrescrita entre processos).
let ownsLock = false;
function clearOwnLockOnly() {
  if (!ownsLock) return; // nunca escrevemos o lock nesta execução → nada nosso a limpar
  try {
    const lk = readLock(home);
    if (lk && Number(lk.pid) === process.pid) clearLock(home);
  } catch { /* best-effort */ }
  ownsLock = false;
}

function shutdown() {
  try { scheduler.stop(); } catch { /* ignore */ }
  try { dashboard.close(); } catch { /* ignore */ }
  clearOwnLockOnly();
  process.exit(0);
}

async function main() {
  let url;
  try {
    url = await dashboard.ensureServer(); // binda a PORT fixa; EADDRINUSE → reject (outro daemon venceu)
  } catch (e) {
    // porta ocupada = OUTRO daemon já é o arbiter → sai limpo (idempotência do singleton). Este processo
    // NUNCA setou ownsLock, então seu exit (SESSION_UNLOADER_TEST_LOSER_EXIT_DELAY_MS ou não) jamais
    // toca no lockfile do vencedor.
    process.stderr.write(`[session-unloader] daemon nao subiu (${e?.code || e?.message}); outro ja e o arbiter — saindo.\n`);
    // hook SÓ de teste (env-gated, no-op em produção): atrasa a saída do PERDEDOR para tornar
    // determinística a janela de corrida "vencedor já publicou o lock, perdedor ainda vai sair"
    // (test-daemon-lock-race.mjs). Nunca ativo fora de um teste que define essa env var.
    const loserDelayMs = Number(process.env.SESSION_UNLOADER_TEST_LOSER_EXIT_DELAY_MS || 0);
    if (loserDelayMs > 0) await new Promise((r) => setTimeout(r, loserDelayMs));
    process.exit(0);
    return;
  }
  // ganhamos a porta (somos o arbiter) — publicar o lock de descoberta NÃO pode falhar em silêncio: se
  // falhar, este processo estaria vivo e servindo, mas invisível (nenhum cliente jamais o encontraria).
  // Isso é pior que não subir: fecha o server e sai com erro VISÍVEL em vez de virar um órfão fantasma.
  const wrote = writeLock({ home, port: PORT, pid: process.pid, token, version });
  if (!wrote) {
    process.stderr.write(`[session-unloader] FALHA ao publicar o lock de descoberta (venci a porta mas não consegui gravar ${home}/session-state/.unloader-daemon.json) — encerrando em vez de rodar invisível.\n`);
    try { dashboard.close(); } catch { /* ignore */ }
    process.exit(1);
    return;
  }
  ownsLock = true;
  process.stderr.write(`[session-unloader] daemon do painel no ar em ${url} (v${version})\n`);

  scheduler.start();
  const timer = setInterval(() => {
    const enabled = readConfig({ home }).enabled;
    if (shouldIdleExit({ enabled, lastActivityAt, now: Date.now(), idleMs: IDLE_MS, scanning: dashboard.sampler.isScanning() })) {
      shutdown();
    }
  }, 60000);
  timer.unref();
}

process.on("exit", clearOwnLockOnly); // safety net — mas só limpa o que É nosso (ver clearOwnLockOnly)
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
main();
