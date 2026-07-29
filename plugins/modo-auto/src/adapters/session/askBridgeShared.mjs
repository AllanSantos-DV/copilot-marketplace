// askBridgeShared.mjs — SEEDER + LOADER do companion COMPARTILHADO ~/.ask-bridge/lib/ (Fase 0, decisão do dono:
// módulo compartilhado, fonte única — os dois plugins importam de lá). Semente LOCAL pura (D2): cada plugin embute
// uma cópia pinada e no boot roda ensureAskBridgeLib() — se a lib faltar OU a PROTOCOL_VERSION instalada < a da
// semente, materializa ATÔMICO (tmp + rename, sob lock; MAIOR VERSÃO VENCE). Sem rede/release (é JS puro pequeno).
// loadAskBridge() importa claim+server+protocol da lib; assere MAJOR compatível; FAIL LOUD com fallback ao bundled
// (nunca silencioso). Reuso do padrão embed-house (ensure-on-boot + version guard) — sem daemon (a lib é passiva).

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, renameSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROTOCOL_VERSION, isNewer, isCompatible, majorOf } from "./askBridgeProtocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Semente = os arquivos BUNDLED deste plugin. Mapeados p/ os nomes do contrato na lib (protocol.mjs).
const SEED_FILES = [
  { from: join(HERE, "askBridgeClaim.mjs"), to: "askBridgeClaim.mjs" },
  { from: join(HERE, "askBridgeServer.mjs"), to: "askBridgeServer.mjs" },
  { from: join(HERE, "askBridgeProtocol.mjs"), to: "protocol.mjs" },
];
// PROTOCOL.md (contrato legível) — semeado se existir no bundle (docs/). Opcional, não bloqueia.
const PROTOCOL_MD = join(HERE, "..", "..", "..", "docs", "ask-bridge-PROTOCOL.md");

export function askBridgeRoot(home = homedir()) { return join(home, ".ask-bridge"); }
export function askBridgeLibDir(home = homedir()) { return join(askBridgeRoot(home), "lib"); }

function installedVersion(libDir) {
  try { return JSON.parse(readFileSync(join(libDir, "package.json"), "utf8")).version || null; } catch { return null; }
}

function materialize(libDir, seedVersion, seedFiles, root, log) {
  const tmp = join(root, ".lib.tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(tmp, { recursive: true });
  for (const f of seedFiles) { try { copyFileSync(f.from, join(tmp, f.to)); } catch (e) { throw new Error(`seed copy ${f.to}: ${e?.message || e}`); } }
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "@local/ask-bridge", version: seedVersion, type: "module", private: true, description: "Companion compartilhado do ask-bridge (semeado localmente; não editar à mão)." }, null, 2));
  try { if (existsSync(PROTOCOL_MD)) copyFileSync(PROTOCOL_MD, join(tmp, "PROTOCOL.md")); } catch { /* opcional */ }
  // swap atômico: remove o antigo e renomeia o tmp. (Windows: rename sobre dir existente falha → remove antes.)
  try { if (existsSync(libDir)) rmSync(libDir, { recursive: true, force: true }); } catch (e) { log(`[ask-bridge] limpeza do lib antigo falhou (segue): ${e?.message || e}`); }
  renameSync(tmp, libDir);
}

/**
 * Garante ~/.ask-bridge/lib/ com a MAIOR versão entre a instalada e a semente deste plugin. Idempotente.
 * @param {{ home?:string, log?:Function, seedVersion?:string, seedFiles?:Array, pollMs?:number, pollTries?:number }} [opts]
 * @returns {{ dir:string, version:string, action:"reuse"|"seed"|"upgrade"|"waited" }}
 */
export function ensureAskBridgeLib({ home = homedir(), log = () => {}, seedVersion = PROTOCOL_VERSION, seedFiles = SEED_FILES, pollMs = 100, pollTries = 20 } = {}) {
  const root = askBridgeRoot(home);
  const libDir = askBridgeLibDir(home);
  mkdirSync(root, { recursive: true });

  const cur = installedVersion(libDir);
  if (cur && !isNewer(seedVersion, cur)) return { dir: libDir, version: cur, action: "reuse" };

  // Precisa semear/atualizar → LOCK atômico p/ resolver corrida entre 2 escritores (só um materializa por vez).
  const lockPath = join(root, ".seed.lock");
  let fd = null;
  try { fd = openSync(lockPath, "wx"); }
  catch (e) {
    if (e && e.code === "EEXIST") {
      // outro plugin está semeando; espera a lib aparecer com versão compatível, senão segue com o que houver.
      for (let i = 0; i < pollTries; i++) { const v = installedVersion(libDir); if (v && !isNewer(seedVersion, v)) return { dir: libDir, version: v, action: "waited" }; sleepBusy(pollMs); }
      const v = installedVersion(libDir); if (v) return { dir: libDir, version: v, action: "waited" };
    } else { log(`[ask-bridge] lock inesperado (segue best-effort): ${e?.message || e}`); }
    // sem lock e sem lib pronta → tenta materializar sem lock (degrada sinalizado; o rename atômico protege)
    materialize(libDir, seedVersion, seedFiles, root, log);
    return { dir: libDir, version: seedVersion, action: cur ? "upgrade" : "seed" };
  }
  try {
    // re-checa sob lock (outro pode ter terminado); só materializa se a semente ainda for mais nova.
    const now = installedVersion(libDir);
    if (now && !isNewer(seedVersion, now)) return { dir: libDir, version: now, action: "reuse" };
    materialize(libDir, seedVersion, seedFiles, root, log);
    return { dir: libDir, version: seedVersion, action: now ? "upgrade" : "seed" };
  } finally { try { closeSync(fd); } catch { /* ignore */ } try { rmSync(lockPath, { force: true }); } catch { /* ignore */ } }
}

// espera curta síncrona (sem depender de async no caminho de boot). Loop de poll do seeder.
function sleepBusy(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* spin curto */ } }

/**
 * Carrega a API do ask-bridge da LIB COMPARTILHADA (fonte única). Assere MAJOR compatível; se a lib estiver num
 * MAJOR diferente do suportado por este plugin → NÃO usa a compartilhada, cai no BUNDLED (sinalizado) — o caller
 * decide engajar ou não. Fallback ao bundled também em qualquer erro de import (FAIL LOUD no log, nunca quebra).
 * @returns {Promise<{ ok:boolean, source:"shared"|"bundled", version:string, api:object, reason?:string }>}
 */
export async function loadAskBridge({ home = homedir(), log = () => {} } = {}) {
  const bundled = async () => {
    const claim = await import(pathToFileURL(join(HERE, "askBridgeClaim.mjs")).href);
    const server = await import(pathToFileURL(join(HERE, "askBridgeServer.mjs")).href);
    return { ...pick(claim), ...pick(server) };
  };
  try {
    const { dir, version } = ensureAskBridgeLib({ home, log });
    if (!isCompatible(version, PROTOCOL_VERSION)) {
      log(`[ask-bridge] lib compartilhada major=${majorOf(version)} ≠ suportado major=${majorOf(PROTOCOL_VERSION)} → usando BUNDLED (sinalizado, não engaja a compartilhada).`);
      return { ok: true, source: "bundled", version: PROTOCOL_VERSION, api: await bundled(), reason: "major-incompat" };
    }
    const claim = await import(pathToFileURL(join(dir, "askBridgeClaim.mjs")).href);
    const server = await import(pathToFileURL(join(dir, "askBridgeServer.mjs")).href);
    return { ok: true, source: "shared", version, api: { ...pick(claim), ...pick(server) } };
  } catch (e) {
    log(`[ask-bridge] load da lib compartilhada FALHOU (FAIL LOUD, sinalizado) → BUNDLED: ${e?.message || e}`);
    try { return { ok: true, source: "bundled", version: PROTOCOL_VERSION, api: await bundled(), reason: "shared-load-failed" }; }
    catch (e2) { return { ok: false, source: "bundled", version: PROTOCOL_VERSION, api: {}, reason: "bundled-load-failed: " + (e2?.message || e2) }; }
  }
}

function pick(mod) {
  const api = {};
  for (const k of ["bridgeDir", "pidAlive", "readOwner", "ownerStale", "acquireOrConnect", "releaseClaim", "updateOwnerInfo", "heartbeat", "startHeartbeat", "setArmed", "isArmed", "postJson", "createAskBridgeOwner", "createAskBridgeResponder", "registerWithOwner"]) {
    if (typeof mod[k] === "function") api[k] = mod[k];
  }
  return api;
}
