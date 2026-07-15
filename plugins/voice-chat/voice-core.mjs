// voice-core.mjs — utilitários base da extensão: logging em arquivo (estado LOCAL aqui) + IO em disco.
// NÃO carrega estado compartilhado da extensão. O `log` (que também emite pela sessão) fica no
// extension.mjs e chama o `dbg` daqui. O data dir vem do contrato único (voice-shared.cjs).

import { existsSync, mkdirSync, statSync, renameSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
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

// Escrita ATÔMICA de JSON (tmp + rename): nunca deixa arquivo meio-escrito se cair no meio.
export function writeJsonAtomic(path, obj) {
    mkdirp(dirname(path));
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path);
}
