// Ledger de CURADORIA — rastreia, por sessão, o que já foi curado, para a curadoria em background do
// SessionStart ser INCREMENTAL e IDEMPOTENTE: nunca recura um checkpoint/bloco já processado. É o
// determinismo LEGÍTIMO (rastreamento de progresso por id), distinto da extração de conhecimento
// (que é semântica, feita pelo curador LLM). Arquivo global keyed por sessionId.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
function file() {
    return join(dir(), "curation-ledger.json");
}
function readAll() {
    try {
        const o = JSON.parse(readFileSync(file(), "utf8"));
        return o && typeof o === "object" ? o : {};
    } catch {
        return {};
    }
}
function writeAll(obj) {
    try {
        mkdirSync(dir(), { recursive: true });
        writeFileSync(file(), JSON.stringify(obj, null, 2), "utf8");
    } catch { /* best-effort */ }
}

// Estado de uma sessão: { checkpoints: [id…], liveToId: <último event.id de turno curado> }.
function sessionState(sessionId) {
    const all = readAll();
    const s = all[sessionId];
    return s && typeof s === "object" ? { checkpoints: Array.isArray(s.checkpoints) ? s.checkpoints : [], liveToId: s.liveToId || null } : { checkpoints: [], liveToId: null };
}

export function isCheckpointCurated(sessionId, checkpointId) {
    return sessionState(sessionId).checkpoints.includes(checkpointId);
}

export function markCheckpointCurated(sessionId, checkpointId) {
    if (!sessionId || !checkpointId) return;
    const all = readAll();
    const s = all[sessionId] && typeof all[sessionId] === "object" ? all[sessionId] : { checkpoints: [], liveToId: null };
    s.checkpoints = Array.isArray(s.checkpoints) ? s.checkpoints : [];
    if (!s.checkpoints.includes(checkpointId)) s.checkpoints.push(checkpointId);
    s.ts = new Date().toISOString();
    all[sessionId] = s;
    writeAll(all);
}

// Último event.id de turno vivo já curado (para retomar a parte viva de onde parou).
export function liveProgress(sessionId) {
    return sessionState(sessionId).liveToId;
}

export function markLiveProgress(sessionId, toId) {
    if (!sessionId || !toId) return;
    const all = readAll();
    const s = all[sessionId] && typeof all[sessionId] === "object" ? all[sessionId] : { checkpoints: [], liveToId: null };
    s.liveToId = toId;
    s.ts = new Date().toISOString();
    all[sessionId] = s;
    writeAll(all);
}
