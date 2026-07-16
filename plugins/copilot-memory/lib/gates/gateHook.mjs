#!/usr/bin/env node
// COMMAND HOOK dos gates (hooks.json → "PreToolUse") — o ÚNICO ponto capaz de BLOQUEAR uma tool.
//
// Por quê aqui e não na extensão: validado ao vivo (G0, 2026-07-16) que o onPreToolUse de uma extensão
// joinSession NÃO dispara para as tool calls do agente host; o pipeline do runtime só executa hooks vindos
// de .github/hooks e do hooks.json de plugins. Logo, o gate É um command hook, spawnado pelo host por tool
// call. Ver files/design-dynamic-gates.md §0.7/§0.8.
//
// CONTRATO REAL (capturado ao vivo, G0): stdin = JSON { hook_event_name, session_id, timestamp, cwd,
// tool_name, tool_input } — tudo snake_case; tool_input do terminal = { command, description }; a terminal
// tool chama-se "Bash" (mesmo no Windows) ou "powershell" conforme a sessão. Output p/ BLOQUEAR:
//   { "hookSpecificOutput": { "permissionDecision": "deny"|"ask", "permissionDecisionReason": "...",
//                             "additionalContext": "..." } }
// exit 0 sempre (mesmo bloqueando — o veredito vai no JSON, não no exit). Matchers IGNORADOS → filtra-se no
// script. Self-contained: só built-ins do Node + módulos irmãos built-in-only. NUNCA importa o SDK.
// Fail-open: qualquer erro → allow silencioso. Hot path: lê cache de policy + recibos LOCAIS (sem daemon).

import { normalizeEvent } from "./eventNormalizer.mjs";
import { logShadow, logContract } from "./shadow.mjs";
import { readPolicies, matchPolicies } from "./policyCache.mjs";
import { subjectHashFor, findValidReceipt } from "./receipts.mjs";

const MODE = (process.env.COPILOT_MEMORY_GATE_MODE || "enforce").toLowerCase(); // off|observe|enforce

let raw = "";
let finished = false;
function guard() { if (finished) return true; finished = true; return false; }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => { if (!guard()) { try { run(raw); } catch { allow(); } } });
// Fail-open DURO: dispare mesmo com input PARCIAL (chunk chegou mas 'end' nunca veio). Antes só saíamos se
// raw estivesse vazio → travava até o timeout do host (revisão externa, medium). Agora processa o que tiver.
setTimeout(() => { if (!guard()) { try { run(raw); } catch { allow(); } } }, 4000).unref?.();

function pick(obj, keys) {
    for (const k of keys) { if (obj && obj[k] != null) return obj[k]; }
    return undefined;
}

function run(text) {
    if (MODE === "off") return allow();
    let input;
    try { input = JSON.parse(text); } catch { return allow(); }

    try { logContract(input); } catch { /* noop */ }

    const toolName = pick(input, ["tool_name", "toolName", "name"]);
    const toolArgs = pick(input, ["tool_input", "toolArgs", "toolInput", "arguments", "input", "args"]);
    const cwd = pick(input, ["cwd", "workingDirectory", "working_directory"]);

    const t0 = hrms();
    let normalized = null;
    try { normalized = normalizeEvent({ toolName, toolArgs, workingDirectory: cwd }); } catch { normalized = null; }
    const ms = hrms() - t0;

    if (!normalized) { obs(toolName, toolArgs, null, ms, "observe"); return allow(); }

    let policies = [];
    try { policies = matchPolicies(normalized, readPolicies()); } catch { policies = []; }
    if (!policies.length || MODE === "observe") {
        obs(toolName, toolArgs, normalized, ms, policies.length ? "observe" : "no-policy");
        return allow();
    }

    // ENFORCE PRIMEIRO: uma policy bloqueante (enforce) SEMPRE vence uma advisory (suggest). Antes o loop
    // dava return "allow" na 1ª suggest, curto-circuitando uma enforce posterior (revisão externa, medium).
    for (const p of policies) {
        if (p.enforcement !== "enforce") continue;
        const needReceipt = p.requires && p.requires.receipt;
        if (!needReceipt) continue;
        const subject = subjectHashFor(normalized);
        const receipt = subject ? findValidReceipt(String(needReceipt), subject) : null;
        if (!receipt) {
            const dec = p.decision === "deny" ? "deny" : "ask";
            return decide(dec, normalized, ms, toolName, toolArgs, blockText(p, normalized, subject), "no-receipt");
        }
    }
    // Nenhuma enforce barrou → se houver suggest, injeta a dica (allow); senão, allow silencioso.
    const suggestP = policies.find((p) => p.enforcement === "suggest");
    if (suggestP) return decide("allow", normalized, ms, toolName, toolArgs, suggestText(suggestP), "suggest");
    obs(toolName, toolArgs, normalized, ms, "receipt-ok");
    return allow();
}

function obs(toolName, toolArgs, normalized, ms, tag) {
    try { logShadow({ toolName, toolArgs, normalized, ms, decision: tag }); } catch { /* noop */ }
}

function decide(decision, normalized, ms, toolName, toolArgs, reason, tag) {
    obs(toolName, toolArgs, normalized, ms, decision + (tag ? ":" + tag : ""));
    if (decision === "allow") {
        if (reason) return emit({ hookSpecificOutput: { permissionDecision: "allow", additionalContext: reason } });
        return allow();
    }
    return emit({
        hookSpecificOutput: {
            permissionDecision: decision,       // "deny" | "ask"
            permissionDecisionReason: reason,    // mostrado ao usuário na confirmação
            additionalContext: reason,           // injetado pro agente adaptar
        },
    });
}

function blockText(policy, n, subject) {
    const what = n.operation === "git-push" ? `git push${n.targetRef ? " (" + n.targetRef + ")" : ""}` : n.operation;
    const subj = subject ? ` (commit ${String(subject).slice(0, 10)})` : "";
    return `Gate "${policy.gate_id}": ${policy.description || "requisito de gate nao cumprido"} `
        + `Antes de ${what}${subj}, rode a revisao externa com a tool memory_gate_review — ela grava o recibo se o parecer sair limpo; entao repita a acao. `
        + `Emergencia: memory_gate_review com override auditado.`;
}

function suggestText(policy) {
    return `Gate "${policy.gate_id}" (sugestao): ${policy.description || ""} Acao recomendada: ${policy.action || "revisar"}.`;
}

function hrms() { try { return Number(process.hrtime.bigint()) / 1e6; } catch { return Date.now(); } }
function allow() { process.exit(0); }
function emit(payload) {
    try { process.stdout.write(JSON.stringify(payload) + "\n", () => process.exit(0)); }
    catch { process.exit(0); }
}
