// provision.mjs — BAIXA+INSTALA a casa compartilhada de um RELEASE PÚBLICO (copilot-marketplace, padrão
// vox-engine), verificada por SHA256 FAIL-CLOSED (sidecar ausente/malformado/mismatch = ABORT), com lock
// atômico (openSync 'wx') p/ serializar consumidores concorrentes. NUNCA lança → {ok:false,reason}.
// Instala em ~/.embed-house/bin (neutro, cross-plugin). O artefato é self-contained (traz o próprio
// node_modules trimado) → funciona em máquina limpa, sem depender do node_modules do consumidor.
import { mkdirSync, existsSync, renameSync, rmSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const DEFAULT_VERSION = "1.0.4";
const MARKETPLACE = "https://github.com/AllanSantos-DV/copilot-marketplace/releases/download";
const HOME = join(homedir(), ".embed-house");
const BIN = join(HOME, "bin");
const LOCK = join(HOME, "provision.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = () => `${process.platform}-${process.arch}`;
const serverPathIn = (dir) => join(dir, "server.mjs");

// Reúso por SEMVER same-major >=: a instalada serve o pin se tem o MESMO major E é >= a pinada (protocolo é
// atado ao major). Assim dois consumidores com pins diferentes estabilizam no MAIOR pin, sem loop de re-download
// (igual npm/apt). Major diferente ou instalada menor → precisa baixar. Sem dependência externa de semver.
const parseVer = (v) => String(v || "").split(".").map((n) => parseInt(n, 10) || 0);
export function satisfiesPin(installed, pinned) {
  const a = parseVer(installed), b = parseVer(pinned);
  if (a[0] !== b[0]) return false;                 // major diferente → incompatível
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x > y) return true; if (x < y) return false; }
  return true;                                     // igual → satisfaz
}

// UPDATE (Windows DLL lock): antes de sobrescrever ~/.embed-house/bin, derruba um daemon vivo servindo de lá
// (POST /shutdown com o token do runtime.json) e espera ele sair — senão o rmSync falha com EBUSY/EPERM
// porque onnxruntime.dll fica locked pelo OS. Best-effort: se não der, o rmSync tenta assim mesmo.
async function shutdownFirst(log) {
  try {
    const rtPath = join(HOME, "run", "runtime.json");
    if (!existsSync(rtPath)) return;
    const rt = JSON.parse(readFileSync(rtPath, "utf8"));
    if (!rt?.port) return;
    log(`[provision] update: derrubando casa viva (porta ${rt.port}) antes de sobrescrever…`);
    try { await fetch(`http://127.0.0.1:${rt.port}/shutdown`, { method: "POST", headers: rt.shutdownToken ? { "x-shutdown-token": rt.shutdownToken } : {}, signal: AbortSignal.timeout(3000) }); } catch {}
    for (let i = 0; i < 15; i++) { try { const r = await fetch(`http://127.0.0.1:${rt.port}/health`, { signal: AbortSignal.timeout(500) }); if (!r.ok) break; } catch { break; } await sleep(1000); }
  } catch { /* best-effort */ }
}

function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex").toLowerCase(); }

async function fetchBuf(url, timeoutMs = 120000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Garante a casa compartilhada instalada em ~/.embed-house/bin. Baixa do release se ausente. NUNCA lança.
 * @returns {Promise<{ok:true, serverPath, reused?|installed?, version?} | {ok:false, reason:string}>}
 */
export async function provision({ log = () => {}, version = DEFAULT_VERSION, allowNetwork = true } = {}) {
  const sp = serverPathIn(BIN);
  // já instalada e completa? (server + node_modules) → reusa SE a versão instalada satisfaz o pin (same-major >=);
  // senão ATUALIZA (update-on-use) baixando a pinada.
  if (existsSync(sp) && existsSync(join(BIN, "node_modules"))) {
    let inst = null;
    try { inst = JSON.parse(readFileSync(join(BIN, "package.json"), "utf8")).version; } catch {}
    if (inst && satisfiesPin(inst, version)) return { ok: true, serverPath: sp, reused: true, version: inst };
    log(`[provision] instalada v${inst || "?"} não satisfaz pin v${version} (same-major >=) → atualizando (update-on-use)`);
  }
  if (!allowNetwork) return { ok: false, reason: "casa não instalada/atual e rede desabilitada" };

  mkdirSync(HOME, { recursive: true });

  // LOCK atômico: só um consumidor provisiona; os outros esperam o resultado dele (fail-open p/ o poll).
  let lockFd = null;
  try { lockFd = openSync(LOCK, "wx"); }
  catch {
    for (let i = 0; i < 40; i++) { if (existsSync(sp) && existsSync(join(BIN, "node_modules"))) return { ok: true, serverPath: sp, reused: true }; await sleep(1000); }
    return { ok: false, reason: "provision-locked-timeout" };
  }

  try {
    const t = target();
    const base = `${MARKETPLACE}/embed-house-v${version}`;
    const tgzUrl = `${base}/embed-house-${t}.tgz`;
    const shaUrl = `${tgzUrl}.sha256`;

    // SHA256 sidecar OBRIGATÓRIO (fail-closed): ausência/malformado = ABORT (não instala sem integridade).
    let expected;
    try {
      const shaBuf = await fetchBuf(shaUrl, 15000);
      expected = String(shaBuf).trim().split(/\s+/)[0].toLowerCase();
    } catch (e) { return { ok: false, reason: `sha256 sidecar inacessível (${e.status || e.message}) → ABORT (fail-closed)` }; }
    if (!/^[0-9a-f]{64}$/.test(expected)) return { ok: false, reason: "sha256 sidecar malformado → ABORT" };

    // download → arquivo .part → rename atômico
    log(`[provision] baixando ${tgzUrl} …`);
    let tgzBuf;
    try { tgzBuf = await fetchBuf(tgzUrl); } catch (e) { return { ok: false, reason: `download falhou (${e.status || e.message})` }; }
    const part = join(HOME, `dl-${t}.tgz.part`);
    const tgz = join(HOME, `dl-${t}.tgz`);
    writeFileSync(part, tgzBuf); renameSync(part, tgz);

    // verifica SHA256 (mismatch = DELETE + ABORT)
    const actual = sha256File(tgz);
    if (actual !== expected) { try { unlinkSync(tgz); } catch {} return { ok: false, reason: `SHA256 mismatch (esperado ${expected.slice(0, 12)}…, obtido ${actual.slice(0, 12)}…) → ABORT` }; }

    // extrai p/ staging e faz swap atômico → BIN. (1º install: BIN ausente, sem risco de DLL lock.)
    const staging = join(HOME, `bin-stage-${version}`);
    rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
    try { execFileSync("tar", ["-xzf", tgz, "-C", staging], { stdio: "ignore" }); }
    catch (e) { return { ok: false, reason: `extract (tar) falhou: ${e?.message || e}` }; }
    if (existsSync(BIN)) { await shutdownFirst(log); rmSync(BIN, { recursive: true, force: true }); } // shutdown-first p/ DLL lock no Windows
    renameSync(staging, BIN);
    try { unlinkSync(tgz); } catch {}

    if (!existsSync(serverPathIn(BIN)) || !existsSync(join(BIN, "node_modules")))
      return { ok: false, reason: "artefato extraído incompleto (sem server.mjs/node_modules)" };

    log(`[provision] casa instalada em ${BIN} (v${version})`);
    return { ok: true, serverPath: serverPathIn(BIN), installed: true, version };
  } catch (e) {
    return { ok: false, reason: `provision falhou: ${e?.message || e}` };
  } finally {
    try { closeSync(lockFd); unlinkSync(LOCK); } catch {}
  }
}
