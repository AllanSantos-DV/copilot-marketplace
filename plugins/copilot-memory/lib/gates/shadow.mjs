// Shadow-mode dos gates (G0) — observa e MEDE, nunca bloqueia.
// Grava um JSONL append-only com o toolName real emitido pelo runtime, as CHAVES dos toolArgs
// (não os valores → sem vazar segredos/conteúdo) e o evento normalizado (com raw redigido), além da
// latência da Camada 1. É como se prova ao vivo o timing dos hooks e se confirma quais toolNames o
// runtime usa, antes de ligar qualquer enforcement. Ver files/design-dynamic-gates.md §0.6 (G0).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
export function shadowFile() {
    return join(dir(), "gate-shadow.jsonl");
}
export function contractFile() {
    return join(dir(), "gate-contract.jsonl");
}

// G0 — captura a FORMA real do stdin do command hook (nomes de campo reais do app), sem vazar valores:
// grava as chaves de topo, as chaves do objeto de args e alguns identificadores não-secretos (toolName,
// cwd, event). É como se descobre o contrato exato do runtime na 1ª sessão real, em vez de assumir.
export function logContract(input) {
    try {
        mkdirSync(dir(), { recursive: true });
        const shape = { ts: new Date().toISOString(), topKeys: Object.keys(input || {}) };
        for (const k of ["tool_input", "toolArgs", "arguments", "input", "args", "toolInput"]) {
            if (input && input[k] && typeof input[k] === "object") shape[k + "_keys"] = Object.keys(input[k]);
        }
        for (const k of ["tool_name", "toolName", "name", "cwd", "workingDirectory", "working_directory", "hookEventName", "hook_event_name", "sessionId", "session_id"]) {
            if (input && typeof input[k] === "string") shape[k] = input[k].length > 60 ? input[k].slice(0, 60) + "…" : input[k];
        }
        appendFileSync(contractFile(), JSON.stringify(shape) + "\n", "utf8");
    } catch { /* nunca interfere */ }
}

// Redige o raw: mantém só tokens SEGUROS (executável + subcomando), removendo qualquer token que pareça
// URL/credencial (contém "@" ou "://") — ex.: `git push https://user:pass@host` não pode ir pro log
// (revisão externa, low). Cap curto.
function redactRaw(raw) {
    if (typeof raw !== "string") return undefined;
    const toks = raw.split(/\s+/).slice(0, 6).map((t) => (/[@]|:\/\//.test(t) ? "<redacted>" : t));
    const out = toks.join(" ");
    return out.length > 48 ? out.slice(0, 48) + "…" : out;
}

/**
 * Registra uma observação de gate. Best-effort: nunca lança para o chamador (hook não pode cair).
 * @param {{ toolName:string, toolArgs?:any, normalized:any, ms:number, decision?:string }} rec
 */
export function logShadow(rec) {
    try {
        mkdirSync(dir(), { recursive: true });
        const argKeys = rec.toolArgs && typeof rec.toolArgs === "object" ? Object.keys(rec.toolArgs).slice(0, 12) : [];
        const norm = rec.normalized ? { ...rec.normalized, raw: redactRaw(rec.normalized.raw) } : null;
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            toolName: rec.toolName,
            argKeys,
            matched: !!rec.normalized,
            operation: norm?.operation || null,
            normalized: norm,
            ms: Math.round((rec.ms || 0) * 1000) / 1000,
            decision: rec.decision || "observe",
        });
        appendFileSync(shadowFile(), line + "\n", "utf8");
    } catch { /* shadow nunca interfere na sessão */ }
}

// Lê as últimas N linhas do shadow log (para inspeção/telemetria).
export function readShadow(limit = 100) {
    try {
        const raw = readFileSync(shadowFile(), "utf8").trim();
        if (!raw) return [];
        const lines = raw.split("\n");
        return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

// Resumo agregado: contagem por toolName e por operation, latência p50/p95.
export function summarizeShadow() {
    const rows = readShadow(10000);
    const byTool = {}, byOp = {};
    const lat = [];
    for (const r of rows) {
        byTool[r.toolName] = (byTool[r.toolName] || 0) + 1;
        if (r.operation) byOp[r.operation] = (byOp[r.operation] || 0) + 1;
        if (typeof r.ms === "number") lat.push(r.ms);
    }
    lat.sort((a, b) => a - b);
    const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0;
    return { total: rows.length, byTool, byOp, latencyMs: { p50: pct(50), p95: pct(95), max: lat[lat.length - 1] || 0 } };
}
