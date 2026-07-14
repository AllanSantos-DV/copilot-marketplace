// Ledger de destilação (bloqueador "duplicação temporal" do revisor externo). Registra o que já foi
// destilado para não re-destilar a MESMA lição em sessões seguidas. Local, append-only, best-effort.
// Fingerprint = hash normalizado de {project, name, description} → detecta a mesma lição reformulada.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
export function ledgerPath() {
    return join(dir(), "distill-ledger.jsonl");
}

// Fingerprint estável de uma lição (normaliza caixa/espaços/pontuação).
export function fingerprint(projectId, name, description) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
    return createHash("sha1").update(`${norm(projectId)}::${norm(name)}::${norm(description)}`).digest("hex").slice(0, 16);
}

// Lê o ledger inteiro (tolerante: ausente/corrompido → []).
export function readLedger() {
    try {
        const raw = readFileSync(ledgerPath(), "utf8");
        return raw.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
        return [];
    }
}

// A sessão já foi destilada antes? (evita reprocessar a mesma sessão)
export function sessionDistilled(sessionId) {
    if (!sessionId) return false;
    return readLedger().some((r) => r.sessionId === sessionId);
}

// Já existe uma lição com este fingerprint? Retorna o registro anterior (com recorrência) ou null.
export function findFingerprint(fp) {
    const rows = readLedger().filter((r) => r.fp === fp);
    if (!rows.length) return null;
    return { fp, occurrences: rows.length, last: rows[rows.length - 1] };
}

// Registra uma destilação (append-only). Nunca lança.
export function recordDistillation({ sessionId, projectId, name, description, memoryId }) {
    try {
        mkdirSync(dir(), { recursive: true });
        const fp = fingerprint(projectId, name, description);
        const prior = findFingerprint(fp);
        const rec = {
            ts: new Date().toISOString(),
            sessionId: sessionId || null,
            projectId: projectId || null,
            fp,
            name: name || null,
            memoryId: memoryId || null,
            recurrence: (prior ? prior.occurrences : 0) + 1,
        };
        appendFileSync(ledgerPath(), JSON.stringify(rec) + "\n", "utf8");
        return rec;
    } catch {
        return null;
    }
}
