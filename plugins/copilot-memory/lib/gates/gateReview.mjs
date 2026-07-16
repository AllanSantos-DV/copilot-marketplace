// Runner do gate de revisão (COLD PATH — roda na tool memory_gate_review, FORA do hook).
// Anti-echo-chamber + anti-forge: a revisão roda num SUBPROCESSO LIMPO (runAgent → curatorWorker, contexto
// e modelo independentes do agente que está sendo barrado). O RECIBO é escrito pela tool com base no veredito
// dessa revisão independente — o agente barrado NÃO consegue forjar (não é o "sim" dele que libera). Ver §0.5.

import { execFileSync } from "node:child_process";
import { runAgent } from "../curator.mjs";
import { writeReceipt, gitHeadHash, subjectHashFor } from "./receipts.mjs";

function git(args, cwd) {
    try {
        return String(execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 8000, maxBuffer: 16 * 1024 * 1024 })).trim();
    } catch { return null; }
}

// O que um push enviaria: commits locais à frente do upstream. Fallbacks robustos quando não há upstream.
export function computePushDiff(repoRoot) {
    const head = gitHeadHash(repoRoot);
    if (!head) return { error: "sem git HEAD neste diretório — nada a revisar/publicar.", head: null };
    // 1) range contra o upstream configurado
    let range = null;
    const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot);
    if (upstream) range = `${upstream}..HEAD`;
    // 2) senão, contra origin/<branch-atual>
    if (!range) {
        const br = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
        if (br && git(["rev-parse", "--verify", `origin/${br}`], repoRoot)) range = `origin/${br}..HEAD`;
    }
    let diff, commits;
    if (range) {
        commits = git(["log", "--oneline", range], repoRoot) || "";
        diff = git(["diff", range], repoRoot) || "";
    }
    // 3) último recurso: o último commit (melhor revisar algo do que nada)
    if (!range || (!diff && !commits)) {
        commits = git(["log", "--oneline", "-1", "HEAD"], repoRoot) || "";
        diff = git(["show", "--format=", "HEAD"], repoRoot) || "";
        range = range || "HEAD~1..HEAD";
    }
    return { head, range, commits, diff };
}

const REVIEW_SYS =
    "Você é um revisor de código externo e adversarial. Neste canal não há voz/áudio nem ferramentas — " +
    "não mencione isso. Sua resposta DEVE conter, ao final, um bloco de código ```json com o objeto do veredito. " +
    "Pode escrever seu raciocínio antes, mas o JSON do veredito é obrigatório.";

const REVIEW_INSTRUCTION = [
    "Revise o DIFF abaixo (o que será publicado num push). Reporte APENAS problemas de alta confiança:",
    "bugs reais, falhas de segurança, erros de lógica, quebras de contrato, segredos vazados.",
    "IGNORE estilo, formatação e preferências.",
    "",
    "OBRIGATÓRIO: termine sua resposta com um bloco ```json contendo EXATAMENTE este objeto:",
    '```json',
    '{"clean": <true|false>, "findings": [{"severity": "high|medium|low", "file": "<arquivo>", "issue": "<problema>", "fix": "<correção>"}], "summary": "<1 frase>"}',
    '```',
    'Regra: clean=true SOMENTE se não houver NENHUM finding "high". Se houver bug/segredo/erro grave, clean=false.',
].join("\n");

// Extrai o objeto JSON do veredito do texto do revisor.
export function parseVerdict(text) {
    const s = String(text || "");
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const cands = [];
    if (fenced) cands.push(fenced[1]);
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) cands.push(s.slice(a, b + 1));
    cands.push(s);
    for (const c of cands) {
        try {
            const v = JSON.parse(c.trim());
            if (v && typeof v === "object" && typeof v.clean === "boolean") {
                return { clean: v.clean, findings: Array.isArray(v.findings) ? v.findings : [], summary: String(v.summary || "") };
            }
        } catch { /* próximo */ }
    }
    return null;
}

/**
 * Roda a revisão externa sobre o diff do push e, se limpa, grava o recibo do gate.
 * @param {{ repoRoot:string, gateId?:string, model?:string, timeoutMs?:number, ttlMs?:number }} opts
 * @returns {Promise<{ ok:boolean, clean?:boolean, subject?:string, verdict?:any, receipt?:any, error?:string, diffMeta?:any }>}
 */
export async function runGateReview(opts) {
    const repoRoot = opts.repoRoot;
    const gateId = opts.gateId || "review-before-push";
    const d = computePushDiff(repoRoot);
    if (d.error) return { ok: false, error: d.error };
    if (!d.diff || !d.diff.trim()) {
        // Nada substantivo para revisar; considera limpo e emite recibo (não há mudança a barrar).
        const rec = writeReceipt({ gate_id: gateId, subject_hash: d.head, verdict: "pass", actor: "agent:code-review", note: "sem diff substantivo", ttlMs: opts.ttlMs });
        return { ok: true, clean: true, subject: d.head, verdict: { clean: true, findings: [], summary: "sem diff substantivo" }, receipt: rec, diffMeta: { range: d.range, commits: d.commits } };
    }
    const diff = d.diff.length > 60000 ? d.diff.slice(0, 60000) + "\n…(diff truncado)…" : d.diff;
    const prompt = `${REVIEW_INSTRUCTION}\n\n=== COMMITS (${d.range}) ===\n${d.commits}\n\n=== DIFF ===\n${diff}`;
    const turn2 = "Agora produza SOMENTE o bloco ```json com o objeto do veredito {clean, findings, summary} — nada além do bloco. Sem preâmbulo, sem comentários, sem mencionar voz ou ferramentas.";
    // Reviewer roda num subprocesso; DENTRO de uma sessão ativa há contenção (2 CopilotClient) + startup de
    // extensões → default de modelo RÁPIDO (haiku) e timeout GENEROSO (240s). turn2 é CONDICIONAL no worker
    // (só dispara se o turn1 não trouxer o veredito), cortando 1 chamada no caso limpo. Ver dogfood 2026-07-16.
    const model = opts.model || process.env.COPILOT_MEMORY_REVIEW_MODEL || "claude-haiku-4.5";
    const { text, error } = await runAgent(prompt, { workingDirectory: repoRoot, model, timeoutMs: opts.timeoutMs || 240000, systemMessage: REVIEW_SYS, turn2 });
    if (error) return { ok: false, error: "revisor externo falhou: " + error, subject: d.head, diffMeta: { range: d.range, commits: d.commits } };
    const verdict = parseVerdict(text);
    if (!verdict) return { ok: false, error: "não consegui interpretar o veredito do revisor (resposta pode ter truncado).", subject: d.head, diffMeta: { range: d.range, commits: d.commits } };

    if (verdict.clean) {
        const rec = writeReceipt({ gate_id: gateId, subject_hash: d.head, verdict: "pass", actor: "agent:code-review", note: verdict.summary, ttlMs: opts.ttlMs });
        return { ok: true, clean: true, subject: d.head, verdict, receipt: rec, diffMeta: { range: d.range, commits: d.commits } };
    }
    // Não limpo: registra o recibo FAIL (auditoria) e NÃO libera o push.
    const rec = writeReceipt({ gate_id: gateId, subject_hash: d.head, verdict: "fail", actor: "agent:code-review", note: verdict.summary, ttlMs: opts.ttlMs });
    return { ok: true, clean: false, subject: d.head, verdict, receipt: rec, diffMeta: { range: d.range, commits: d.commits } };
}

// Break-glass AUDITADO: grava um recibo pass com actor override + motivo. Emergência controlada (§0.1/§5).
// GATE do override: por padrão o AGENTE não pode se autoconceder bypass (contradizia o anti-forge). Exige o
// sinal HUMANO COPILOT_MEMORY_GATE_OVERRIDE=1 no ambiente do app (fixado no launch — o agente não muda o env
// do processo da extensão mid-sessão). Actor reflete o INICIADOR real (não finge "human"). TTL curto.
export function overrideReceipt(repoRoot, { gateId = "review-before-push", reason, ttlMs, normalized } = {}) {
    if (String(process.env.COPILOT_MEMORY_GATE_OVERRIDE || "") !== "1") {
        return { ok: false, error: "override desabilitado: só o humano pode habilitar break-glass definindo COPILOT_MEMORY_GATE_OVERRIDE=1 no ambiente do app (o agente não pode se autoconceder bypass)." };
    }
    if (!reason || !String(reason).trim()) return { ok: false, error: "override exige um motivo (auditoria)." };
    // Amarra ao MESMO sujeito que o gate vai computar (ref empurrado), não só HEAD.
    const subject = normalized ? subjectHashFor(normalized) : gitHeadHash(repoRoot);
    if (!subject) return { ok: false, error: "sem sujeito estável (git HEAD/ref) — nada a liberar." };
    const rec = writeReceipt({ gate_id: gateId, subject_hash: subject, verdict: "pass", actor: "override:break-glass", note: "BREAK-GLASS: " + reason, ttlMs: ttlMs || 2 * 60 * 60 * 1000 });
    return { ok: true, subject, receipt: rec };
}
