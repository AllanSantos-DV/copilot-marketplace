// Cache LOCAL de policies de gate. Separação de caminhos (design §0.8):
//  - HOT PATH (gateHook, command hook): só LÊ este arquivo. Zero rede, zero daemon. Rápido e offline.
//  - COLD PATH (extensão/tools/curador): ESCREVE aqui (semeia defaults, sincroniza do servidor type:policy_gate).
//
// Uma policy é um predicado ESTRUTURAL declarativo + o requisito + o nível de enforcement:
//   { gate_id, version, when:{operation:[...], ...}, enforcement:"detect-only"|"suggest"|"enforce",
//     decision:"ask"|"deny", requires:{receipt:"<gate_id>"}, action:"run_agent:code-review", name, description }
// O match é local e determinístico (nada de score semântico no hot path). Ver design §0.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
function file() {
    return join(dir(), "gate-policies.json");
}

// Policy default: revisor externo antes de publicar (git push). Nasce em "enforce"/"ask" — obrigatória, mas
// com escape (rodar memory_gate_review gera o recibo); promover a "deny" depois de provado. version=1.
export function defaultPolicies() {
    return [
        {
            gate_id: "review-before-push",
            version: 1,
            when: { operation: ["git-push"] },
            enforcement: "enforce",
            decision: "ask",
            requires: { receipt: "review-before-push" },
            action: "run_agent:code-review",
            ttlMs: 24 * 60 * 60 * 1000,
            name: "Revisor externo antes do push",
            description: "Exige um parecer de revisão externa (limpo) para o commit atual antes de um git push. Sem recibo válido, o push é barrado até rodar memory_gate_review.",
        },
    ];
}

export function readPolicies() {
    try {
        const raw = readFileSync(file(), "utf8");
        const obj = JSON.parse(raw);
        const arr = Array.isArray(obj) ? obj : obj?.policies;
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

export function writePolicies(policies) {
    mkdirSync(dir(), { recursive: true });
    const tmp = file() + "." + process.pid + ".tmp";
    const payload = { version: 1, updatedAt: new Date().toISOString(), policies: Array.isArray(policies) ? policies : [] };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file());
    return payload.policies.length;
}

// Semeia os defaults só se o arquivo ainda não existir (idempotente; não sobrescreve edições/sync).
export function ensureSeeded() {
    if (existsSync(file())) return { seeded: false, count: readPolicies().length };
    const d = defaultPolicies();
    writePolicies(d);
    return { seeded: true, count: d.length };
}

// Casa um evento normalizado contra as policies. Predicado hoje: when.operation inclui normalized.operation.
// Extensível (targetRef/changedPaths/pagesProfile) sem tocar no hot path — só cresce este matcher. Determinístico.
export function matchPolicies(normalized, policies = readPolicies()) {
    if (!normalized || !normalized.operation) return [];
    return policies.filter((p) => {
        const w = p && p.when;
        if (!w) return false;
        if (Array.isArray(w.operation) && !w.operation.includes(normalized.operation)) return false;
        if (typeof w.branch === "string" && normalized.branch && w.branch !== normalized.branch) return false;
        if (w.force === true && normalized.force !== true) return false;
        return true;
    });
}

export const _internal = { policiesFile: file };
