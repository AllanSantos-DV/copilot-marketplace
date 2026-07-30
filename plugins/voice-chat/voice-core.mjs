// voice-core.mjs — utilitários base da extensão: logging em arquivo (estado LOCAL aqui) + IO em disco.
// NÃO carrega estado compartilhado da extensão. O `log` (que também emite pela sessão) fica no
// extension.mjs e chama o `dbg` daqui. O data dir vem do contrato único (voice-shared.cjs).

import { existsSync, mkdirSync, statSync, renameSync, createWriteStream, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import shared from "./voice-shared.cjs";

const DEBUG_LOG = join(shared.resolveDataDir(), "debug.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024;
let _logStream = null;
let _logDirReady = false;

function _logWrite(line) {
    try {
        if (!_logStream) {
            if (!_logDirReady) { mkdirSync(dirname(DEBUG_LOG), { recursive: true }); _logDirReady = true; }
            try {
                if (existsSync(DEBUG_LOG) && statSync(DEBUG_LOG).size > MAX_LOG_BYTES) renameSync(DEBUG_LOG, DEBUG_LOG + ".1");
            } catch { /* rotação best-effort */ }
            _logStream = createWriteStream(DEBUG_LOG, { flags: "a" });
            _logStream.on("error", () => { _logStream = null; });
        }
        _logStream.write(line);
    } catch { _logStream = null; }
}

// Log em arquivo (diagnóstico local). Barato e best-effort.
export function dbg(msg) {
    _logWrite(`[${new Date().toISOString()}] ${msg}\n`);
}

// ---- IO em disco (dedup dos padrões inline que estavam espalhados no extension.mjs) --------------
export function mkdirp(dir) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

// Lê JSON com fallback (nunca lança). Substitui o idioma `try { JSON.parse(readFileSync(f)) || x } catch { x }`.
export function readJson(path, fallback) {
    try { return JSON.parse(readFileSync(path, "utf8")) || fallback; } catch { return fallback; }
}

// Erro TRANSITÓRIO de FS no Windows: dois processos fazendo rename/replace no MESMO alvo ao mesmo
// tempo dão ACCESS_DENIED(5)/SHARING_VIOLATION(32) — que o Node superfície como EPERM/EACCES/EBUSY.
// (Descoberto na costura do mic.lock com o daemon vox, que hit o mesmo no os.replace.)
export function isTransientFsError(e) {
    return !!(e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY"));
}

// Sleep SÍNCRONO curto sem dependência: Atomics.wait num buffer efêmero. Só p/ o backoff do rename.
function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sem SAB: no-op */ }
}

// rename com RETRY+backoff: o mic.lock agora é escrito CONCORRENTEMENTE pela extensão E pelo daemon
// vox (mesmo alvo), então o rename atômico pode falhar transitório no Windows. Reintenta poucas vezes.
function renameWithRetry(tmp, dest, tries = 5) {
    for (let i = 0; ; i++) {
        try { renameSync(tmp, dest); return; }
        catch (e) {
            if (!isTransientFsError(e) || i >= tries) throw e;
            sleepSync(2 * (i + 1));   // 2,4,6,8,10ms
        }
    }
}

// Escrita ATÔMICA de JSON (tmp + rename): nunca deixa arquivo meio-escrito se cair no meio.
export function writeJsonAtomic(path, obj) {
    mkdirp(dirname(path));
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(obj));
    try { renameWithRetry(tmp, path); }
    catch (e) { try { unlinkSync(tmp); } catch { /* limpa o tmp órfão se o rename falhou de vez */ } throw e; }
}

// Sonda se um PID está VIVO (cross-fork). process.kill(pid,0) NÃO envia sinal — só testa
// existência: lança ESRCH se morto, EPERM se existe mas sem permissão (= vivo). Usado pra
// invalidar um lock stale cuja fork dona morreu sem liberar.
export function pidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    if (n === process.pid) return true;
    try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}
