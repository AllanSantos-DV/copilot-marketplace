// Persistência do workingDirectory por SESSÃO — para o painel/tools resolverem o project_id CERTO
// logo após um reload da extensão, sem depender de process.cwd() (que num fork de reload aponta
// para ~/.copilot, não para o projeto aberto). Os hooks recebem input.workingDirectory e gravam
// aqui (keyed por SESSION_ID); no boot, a extensão semeia sessionCwd a partir disto. Best-effort:
// ausente/corrompido → null (cai para process.cwd(), o comportamento anterior).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
function file() {
    return join(dir(), "session-cwd.json");
}
function readAll() {
    try {
        const o = JSON.parse(readFileSync(file(), "utf8"));
        return o && typeof o === "object" ? o : {};
    } catch {
        return {};
    }
}

// Último workingDirectory conhecido desta sessão (ou null).
export function readPersistedCwd(sessionId) {
    if (!sessionId) return null;
    const e = readAll()[sessionId];
    return e && typeof e.cwd === "string" && e.cwd.trim() ? e.cwd : null;
}

// Grava o workingDirectory da sessão. Não reescreve se não mudou (evita churn a cada prompt).
export function persistCwd(sessionId, cwd) {
    if (!sessionId || !cwd || typeof cwd !== "string" || !cwd.trim()) return;
    try {
        const all = readAll();
        if (all[sessionId] && all[sessionId].cwd === cwd) return;
        all[sessionId] = { cwd, ts: new Date().toISOString() };
        mkdirSync(dir(), { recursive: true });
        writeFileSync(file(), JSON.stringify(all, null, 2), "utf8");
    } catch { /* best-effort */ }
}
