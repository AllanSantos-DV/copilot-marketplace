// askBridgeShared.mjs — lado copilot-mobile do companion COMPARTILHADO ask-bridge (Fase 1).
//
// D2 = SEMENTE LOCAL (sem rede/release): a lib de 5 arquivos JS puros é EMBUTIDA aqui (ask-bridge-seed/) e
// materializada em ~/.ask-bridge/lib/ se estiver ausente OU se a semente embutida for MAIS NOVA (maior
// PROTOCOL_VERSION vence — mesma regra do modo-auto, os dois convergem). Depois importa da lib COMPARTILHADA
// (fonte única entre os plugins), com fallback à semente embutida se a lib sumir. Erro de import SOBE (FAIL LOUD).
//
// Por que semente e não release assinado: o payload é JS puro, pequeno e JÁ shipado dentro de cada plugin (que
// passa pelo gate do marketplace). O release assinado (embed-house/vox-engine) é p/ BINÁRIOS/MODELOS que não
// cabem embutidos e precisam verificar download não-confiável — não é o caso aqui.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, renameSync, rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(HERE, "ask-bridge-seed");
const LIB_FILES = ["askBridgeClaim.mjs", "askBridgeServer.mjs", "protocol.mjs", "package.json"];

function libDirFor(home) { return join(home, ".ask-bridge", "lib"); }

// Lê PROTOCOL_VERSION do protocol.mjs de um diretório (semente ou lib). Ausente/ilegível → "0.0.0".
export function readProtocolVersion(dir) {
  try {
    const m = readFileSync(join(dir, "protocol.mjs"), "utf8").match(/PROTOCOL_VERSION\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : "0.0.0";
  } catch { return "0.0.0"; }
}

// a > b? (semver por componente). Empata em iguais → false ("igual não é mais novo").
export function isNewer(a, b) {
  const A = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const B = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0); }
  return false;
}

/**
 * Garante ~/.ask-bridge/lib/ materializada a partir da semente embutida.
 * Semeia se a lib faltar OU se a semente for MAIS NOVA. Idempotente; escreve num tmp e renomeia (atômico-ish).
 * NUNCA rebaixa uma lib mais nova (respeita "maior versão vence" com o modo-auto). FAIL SOFT: se a materialização
 * falhar, retorna {seeded:false, error} e o loader cai na semente embutida — nunca trava o boot do bridge.
 * @param {{ home?:string, log?:(m:string)=>void }} [opts]
 * @returns {{ seeded:boolean, version:string, error?:string }}
 */
export function ensureAskBridgeLib({ home = homedir(), log = () => {} } = {}) {
  const libDir = libDirFor(home);
  const seedV = readProtocolVersion(SEED_DIR);
  const libV = existsSync(join(libDir, "protocol.mjs")) ? readProtocolVersion(libDir) : null;
  if (libV && !isNewer(seedV, libV)) return { seeded: false, version: libV }; // lib igual/mais nova → mantém
  try {
    mkdirSync(dirname(libDir), { recursive: true });
    const tmp = `${libDir}.tmp-${process.pid}-${Date.now()}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const f of readdirSync(SEED_DIR)) copyFileSync(join(SEED_DIR, f), join(tmp, f));
    rmSync(libDir, { recursive: true, force: true });
    renameSync(tmp, libDir);
    log(`ask-bridge: semente materializada v${seedV} (lib anterior=${libV || "nenhuma"})`);
    return { seeded: true, version: seedV };
  } catch (e) {
    log("ask-bridge: seed falhou (usando semente embutida): " + (e?.message || e));
    return { seeded: false, version: libV || seedV, error: String(e?.message || e) };
  }
}

/**
 * Materializa (se preciso) e IMPORTA os módulos do ask-bridge da lib compartilhada (fallback: semente embutida).
 * Devolve a API achatada + protocol + o diretório efetivo. Import falho SOBE (FAIL LOUD — o caller sinaliza).
 * @param {{ home?:string, log?:(m:string)=>void }} [opts]
 */
export async function loadAskBridge({ home = homedir(), log = () => {} } = {}) {
  ensureAskBridgeLib({ home, log });
  const libDir = libDirFor(home);
  const dir = existsSync(join(libDir, "protocol.mjs")) ? libDir : SEED_DIR;
  const v = readProtocolVersion(dir); // cache-bust por versão: materializações novas re-importam
  const url = (f) => `${pathToFileURL(join(dir, f)).href}?v=${encodeURIComponent(v)}`;
  const [claim, server, protocol] = await Promise.all([
    import(url("askBridgeClaim.mjs")),
    import(url("askBridgeServer.mjs")),
    import(url("protocol.mjs")),
  ]);
  return { ...claim, ...server, protocol, PROTOCOL_VERSION: protocol.PROTOCOL_VERSION, libDir: dir };
}

export { SEED_DIR, LIB_FILES };
