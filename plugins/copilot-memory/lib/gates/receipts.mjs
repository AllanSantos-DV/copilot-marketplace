// Recibos de gate — prova LOCAL de que um requisito (ex.: revisão externa) foi cumprido para um SUJEITO
// específico. Hot-path readable pelo gateHook (só built-ins do Node, zero rede). Ver design §0.3/§0.4.
//
// Anti-stale (a sacada da revisão externa): o recibo é amarrado a um subject_hash. Para git-push, o sujeito
// é o commit em HEAD (git rev-parse HEAD). Se o autor revisar e depois emendar/commitar, o HEAD muda → o
// hash muda → o recibo NÃO casa mais → re-revisão obrigatória. Não há bypass por parecer obsoleto.

import { appendFileSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
function file() {
    return join(dir(), "gate-receipts.jsonl");
}

// subject_hash para git-push: o SHA de HEAD do repoRoot (o que está prestes a ser publicado). Determinístico,
// local, ~5ms. Sem git/HEAD → null (o chamador trata como "sem sujeito estável" → não consegue emitir recibo).
export function gitHeadHash(repoRoot) {
    return gitRevParse(repoRoot, "HEAD");
}

// rev-parse genérico e seguro de um ref → SHA (ou null). Usa --verify para não "resolver" lixo.
export function gitRevParse(repoRoot, ref) {
    try {
        const out = execFileSync("git", ["rev-parse", "--verify", "--quiet", String(ref)], { cwd: repoRoot || process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
        const sha = String(out).trim();
        return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
    } catch { return null; }
}

// Deriva o subject_hash de um evento normalizado. Para git-push, o sujeito é o COMMIT DO REF QUE SERÁ
// EMPURRADO — não sempre HEAD (senão um `git push origin outraBranch` reusaria o recibo de HEAD = bypass,
// revisão externa high). Formas sem alvo resolvível (--all/--mirror/--tags/refspec) → sentinela que NUNCA
// casa um recibo normal → força ask/deny. Extensível por operação; hoje cobre git-push e pages-write.
export function subjectHashFor(normalized) {
    if (!normalized) return null;
    if (normalized.operation === "git-push") {
        // múltiplos refs / refspec explícito → não dá pra amarrar a um único commit revisado.
        if (normalized.pushAll || normalized.refspec) return "unresolved-push:" + String(normalized.raw || normalized.targetRef || "");
        // branch explícita → resolve o tip DESSA branch (não HEAD).
        if (normalized.branch) {
            const sha = gitRevParse(normalized.repoRoot, "refs/heads/" + normalized.branch) || gitRevParse(normalized.repoRoot, normalized.branch);
            return sha || ("unresolved-branch:" + normalized.branch);
        }
        // push "nu" (git push / git push <remote>) → a branch atual = HEAD.
        return gitHeadHash(normalized.repoRoot);
    }
    // pages-write / outros: sujeito = os caminhos alterados (assinatura estável do conteúdo a publicar).
    if (Array.isArray(normalized.changedPaths) && normalized.changedPaths.length) {
        return "paths:" + normalized.changedPaths.slice().sort().join(",");
    }
    return null;
}

/**
 * Grava um recibo (append-only). actor = quem/como (ex.: "agent:code-review").
 * @param {{ gate_id:string, policy_version?:number, subject_hash:string, verdict:"pass"|"fail", actor?:string, ttlMs?:number, note?:string }} r
 */
export function writeReceipt(r) {
    const now = Date.now();
    const rec = {
        gate_id: r.gate_id,
        policy_version: r.policy_version ?? 1,
        subject_hash: r.subject_hash,
        verdict: r.verdict,
        actor: r.actor || "unknown",
        note: r.note || "",
        created_at: new Date(now).toISOString(),
        expiry: r.ttlMs ? new Date(now + r.ttlMs).toISOString() : null,
    };
    mkdirSync(dir(), { recursive: true });
    appendFileSync(file(), JSON.stringify(rec) + "\n", "utf8");
    return rec;
}

function readAll() {
    try {
        const raw = readFileSync(file(), "utf8").trim();
        if (!raw) return [];
        return raw.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

/**
 * Recibo VÁLIDO mais recente para {gate_id, subject_hash}: verdict "pass" e não expirado.
 * Retorna o recibo ou null. Hot path — barato, só leitura de arquivo.
 */
export function findValidReceipt(gateId, subjectHash) {
    if (!gateId || !subjectHash) return null;
    const now = Date.now();
    let best = null;
    for (const r of readAll()) {
        if (r.gate_id !== gateId || r.subject_hash !== subjectHash) continue;
        if (r.verdict !== "pass") continue;
        if (r.expiry && Date.parse(r.expiry) < now) continue;
        if (!best || Date.parse(r.created_at) > Date.parse(best.created_at)) best = r;
    }
    return best;
}

// Compacta o arquivo (mantém só os N mais recentes) — higiene opcional, escrita atômica.
export function compactReceipts(keep = 500) {
    const all = readAll();
    if (all.length <= keep) return all.length;
    const trimmed = all.slice(-keep);
    mkdirSync(dir(), { recursive: true });
    const tmp = file() + "." + process.pid + ".tmp";
    writeFileSync(tmp, trimmed.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    renameSync(tmp, file());
    return trimmed.length;
}

export const _internal = { receiptsFile: file };
