// Ledger de TURNOS de curadoria — conta prompts/turnos por sessão para a curadoria rodar a cada X
// TURNOS (não a cada stop). Entre um user e um assistant há muito resíduo de máquina (tool calls,
// tool results, hooks); consolidar um lote de turnos antes de curar gera documentos melhores e
// economiza LLM. Mesmo padrão do curationLedger (arquivo JSON global, escrita atômica).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { stateDir as dir } from "./paths.mjs";

function file() {
    return join(dir(), "curation-turns.json");
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
        const tmp = file() + "." + process.pid + ".tmp";
        writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
        renameSync(tmp, file());
    } catch { /* best-effort */ }
}

// Incrementa o contador de turnos da sessão e devolve o NOVO valor. Sem sessão → no-op (0).
export function bumpTurn(sessionId) {
    if (!sessionId) return 0;
    const all = readAll();
    const s = all[sessionId] && typeof all[sessionId] === "object" ? all[sessionId] : { turns: 0 };
    s.turns = (Number(s.turns) || 0) + 1;
    s.ts = new Date().toISOString();
    all[sessionId] = s;
    writeAll(all);
    return s.turns;
}

// Quantos turnos já passaram nesta sessão sem reset.
export function turnsSince(sessionId) {
    if (!sessionId) return 0;
    const all = readAll();
    const s = all[sessionId];
    return s && typeof s === "object" ? Number(s.turns) || 0 : 0;
}

// Zera o contador da sessão (após curar). Opcionalmente guarda quantos turnos foram consumidos.
export function resetTurns(sessionId, consumed = 0) {
    if (!sessionId) return;
    const all = readAll();
    const s = all[sessionId] && typeof all[sessionId] === "object" ? all[sessionId] : { turns: 0 };
    s.turns = 0;
    if (consumed) s.lastConsumed = consumed;
    s.ts = new Date().toISOString();
    all[sessionId] = s;
    writeAll(all);
}
