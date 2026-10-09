// engine-kit/lifecycle.mjs — LIFECYCLE: garante o motor VIVO e devolve como falar com ele.
// Generalização do ensureDaemon.mjs do embed-house. Regra do kit: ele NUNCA adivinha a saúde do
// motor — `healthCheck` é sempre um callback de quem conhece o protocolo (handshake de versão,
// modelo, dimensão…). O kit cuida do que é genérico: ler o runtime.json fresco, subir o processo
// destacado e esperar o auto-anúncio. NUNCA lança.
//
// Dois tipos de motor (`kind`):
//   • daemon — processo longo que anuncia `runtime.json` e responde health. É o fluxo abaixo.
//   • cli    — executável invocado POR EVENTO (ex.: o dispatcher de hooks): não há processo para
//              manter vivo, nem runtime, nem health. Provisionar já é entregar. Forçar um daemon
//              aqui seria inventar um ciclo de vida que o motor não tem.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Janela padrão de frescor quando o motor não declara `heartbeatMs`.
 * NUNCA usar Infinity aqui: um `runtime.json` de dias atrás passaria como "vivo" e o
 * lifecycle devolveria um motor morto. Sem heartbeat declarado, 2 minutos é o teto.
 */
const DEFAULT_STALE_MS = 120000;

/** Lê o runtime.json do motor, sem julgar idade. `null` se ausente/ilegível. */
export function readRuntime(engine) {
  try {
    const rt = join(engine.homeDir, engine.runtime?.runtimeFile ?? "runtime.json");
    return JSON.parse(readFileSync(rt, "utf8"));
  } catch {
    return null;
  }
}

/** Lê o runtime.json do motor SE estiver fresco (heartbeat vivo). null se ausente/obsoleto. */
export function readFreshRuntime(engine, { staleMs } = {}) {
  const rt = join(engine.homeDir, engine.runtime?.runtimeFile ?? "runtime.json");
  const hb = engine.runtime?.heartbeatMs;
  const limit = staleMs ?? (hb ? hb * 3 : DEFAULT_STALE_MS);
  try {
    if (Date.now() - statSync(rt).mtimeMs > limit) { return null; }
    return JSON.parse(readFileSync(rt, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Localiza um motor VIVO: lê o runtime (dica de onde procurar) e pergunta ao próprio motor
 * (prova de que está vivo).
 *
 * A ordem importa e custou um bug de produção: antes, o frescor do `runtime.json` **vetava** o
 * handshake — um motor que escreve o arquivo só no boot (o caso do mcp-gateway) era declarado
 * morto depois de 2 minutos de uptime, e o kit tentava subir outro por cima do que estava
 * servindo. Arquivo é DICA (diz a porta); handshake é AUTORIDADE (prova que atende, e que é o
 * motor certo — o healthCheck confere o nome). Runtime velho apontando para porta alheia
 * continua seguro: o handshake não reconhece e o fluxo segue para o spawn.
 */
async function findAlive(engine, healthCheck) {
  const rt = readRuntime(engine);
  if (!rt) { return null; }
  const health = await healthCheck(rt);
  return health ? { runtime: rt, health } : null;
}

/**
 * Pede ao motor que se encerre, usando SÓ o que o registry declara.
 *
 * Existe porque no Windows um arquivo em uso não pode ser sobrescrito: atualizar um daemon vivo
 * falha com EPERM no meio do swap. O kit continua não adivinhando nada — se o descritor não
 * declara `shutdownPath`, ele não tenta; se declara um token, o token vem do campo declarado do
 * runtime.json, no cabeçalho declarado. Sem declaração, sem token (e não se inventa um: seria um
 * endpoint de desligar aberto no loopback).
 *
 * @returns {Promise<{ok:true, stopped:boolean} | {ok:false, reason:string}>} nunca lança.
 */
export async function shutdown(engine, { log = () => {}, timeoutMs = 5000 } = {}) {
  const path = engine.runtime?.shutdownPath;
  if (!path) { return { ok: true, stopped: false }; }

  // Runtime SEM gate de frescor: um motor que só escreve o arquivo no boot (caso do mcp-gateway)
  // seria considerado "morto" aqui e o shutdown viraria no-op — e aí o swap de arquivos falharia
  // no Windows com EPERM, exatamente o problema que esta função existe para evitar.
  const rt = readRuntime(engine);
  if (!rt?.port) { return { ok: true, stopped: false }; } // nada vivo para derrubar

  const headers = {};
  const field = engine.runtime?.shutdownTokenField;
  const header = engine.runtime?.shutdownTokenHeader;
  if (field && header && rt[field]) { headers[header] = rt[field]; }

  try {
    const res = await fetch(`http://127.0.0.1:${rt.port}${path}`, {
      method: "POST", headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { return { ok: false, reason: `${engine.name}: shutdown respondeu HTTP ${res.status}` }; }
    log(`[engine-kit] ${engine.name}: shutdown pedido (pid ${rt.pid ?? "?"})`);
    // O motor responde ANTES de sair. Sem esta espera, o swap ainda encontra o arquivo em uso.
    await sleep(1500);
    return { ok: true, stopped: true };
  } catch (e) {
    return { ok: false, reason: `${engine.name}: shutdown falhou (${e?.message || e})` };
  }
}

/** Sobe o motor destacado, com ambiente limpo (fora do fork do host). */
function spawnEngine(nodePath, entryPath, log, extraEnv) {
  try {
    const child = spawn(nodePath, [entryPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "", COPILOT_SDK_PATH: "", ...extraEnv },
    });
    child.unref();
    log(`[engine-kit] motor disparado: ${nodePath} ${entryPath}`);
    return true;
  } catch (e) {
    log(`[engine-kit] falha ao subir motor (sinalizado): ${e?.message || e}`);
    return false;
  }
}

/**
 * Garante o motor vivo.
 * @param engine   descritor resolvido (resolve.mjs)
 * @param entryPath caminho do entrypoint instalado (provision.mjs)
 * @param healthCheck (runtimeInfo) => Promise<object|null> — validação de saúde/protocolo DO MOTOR.
 * @returns {Promise<{available:true, runtime:object, health:object} | {available:false, reason:string}>}
 */
export async function lifecycle(engine, entryPath, { healthCheck, log = () => {}, bootTimeoutMs = 60000, nodePath = process.execPath, env } = {}) {
  // 0) MOTOR CLI: não existe daemon a subir nem runtime a esperar — o binário provisionado É a
  //    entrega. Sai ANTES da exigência de healthCheck: cobrar handshake de quem não tem protocolo
  //    de rede seria uma barreira artificial.
  if (engine.kind === "cli") {
    log(`[engine-kit] ${engine.name}: motor kind=cli (invocado por evento) — sem processo para manter vivo`);
    return { available: true, kind: "cli", bin: entryPath, runtime: null, health: null };
  }

  if (typeof healthCheck !== "function") {
    return { available: false, reason: "healthCheck é obrigatório (o kit não adivinha o protocolo do motor)" };
  }

  // 1) FAST PATH: já vivo? (runtime diz onde; o handshake do motor prova que sim)
  const alive = await findAlive(engine, healthCheck);
  if (alive) { log(`[engine-kit] ${engine.name}: fast-path (já vivo)`); return { available: true, ...alive }; }

  // 2) SOBE. A corrida por singleton é resolvida DENTRO do motor (port-lock/bind); quem perde sai.
  if (!spawnEngine(nodePath, entryPath, log, env)) {
    return { available: false, reason: `${engine.name}: spawn falhou` };
  }

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    const up = await findAlive(engine, healthCheck);
    if (up) { return { available: true, ...up }; }
    await sleep(1000);
  }
  return { available: false, reason: `${engine.name}: não anunciou em ${bootTimeoutMs}ms` };
}
