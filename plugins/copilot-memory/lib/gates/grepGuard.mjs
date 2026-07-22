#!/usr/bin/env node
// COMMAND HOOK (hooks.json do PLUGIN → PreToolUse) — GUARD de busca recursiva AMPLA. GLOBAL: roda em
// TODA sessão do plugin (mesmo mecanismo do boot.mjs em SessionStart). Barra grep/rg/glob sobre raízes
// gigantes (frita a máquina — medido: ~/.copilot = 137k arq/21GB) e redireciona pro grafo semântico do
// plugin, que vai DIRETO ao node. Só gateia com MEMÓRIA ATIVA (project_id resolve → há grafo p/ redirecionar).
//
// Princípios (iguais ao gateHook): self-contained, só built-ins do Node + módulos irmãos built-in-only,
// NUNCA importa o SDK. FAIL-OPEN DURO: qualquer erro/timeout/dúvida → allow (o hook JAMAIS trava a sessão).
// Early-exit BARATO por tool_name ANTES de qualquer git/fs (95%+ dos tools saem em <1ms).
//
// Modo (COPILOT_MEMORY_GREP_GUARD env → senão grepguard.json{mode} no stateDir → senão "enforce"):
//   off      = passthrough total
//   observe  = classifica e LOGA, mas sempre allow (medição sem bloquear)
//   enforce  = deny nas buscas amplas (default)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { classify, isSearchTool } from "./searchClassifier.mjs";
import { tryResolveProjectId } from "../projectId.mjs";
import { logShadow } from "./shadow.mjs";
import { stateDir } from "../paths.mjs";

function resolveMode() {
    const env = String(process.env.COPILOT_MEMORY_GREP_GUARD || "").trim().toLowerCase();
    if (env === "off" || env === "observe" || env === "enforce") return env;
    try {
        const cfg = JSON.parse(readFileSync(join(stateDir(), "grepguard.json"), "utf8"));
        const m = String(cfg && cfg.mode || "").trim().toLowerCase();
        if (m === "off" || m === "observe" || m === "enforce") return m;
    } catch { /* sem config → default */ }
    return "enforce";
}

// Resolução de project_id com CACHE por-cwd (TTL 5min). Motivo (revisão externa, medium): o command hook
// roda num processo NOVO por tool call, e tryResolveProjectId faz git SÍNCRONO (até 3 execFileSync). No hot
// path de TODA busca isso custa 100–360ms e, no pior caso (fsmonitor-hang), 3×5s poderiam estourar o timeout
// do host. O cache faz o git rodar no MÁXIMO 1×/cwd a cada 5min; o resto é leitura de 1 arquivo (~1ms).
// Cacheia inclusive null (sem escopo). Fail-open: qualquer erro → resolve direto.
const SCOPE_TTL_MS = 5 * 60 * 1000;
function scopeCacheFile() { return join(stateDir(), "grepguard-scope-cache.json"); }
function cwdKey(cwd) { return createHash("sha1").update(String(cwd || "").toLowerCase()).digest("hex").slice(0, 16); }

function cachedProjectId(cwd) {
    const key = cwdKey(cwd);
    let all = {};
    try { all = JSON.parse(readFileSync(scopeCacheFile(), "utf8")) || {}; } catch { all = {}; }
    const hit = all[key];
    if (hit && typeof hit.ts === "number" && (Date.now() - hit.ts) < SCOPE_TTL_MS) {
        return hit.pid || null; // hit fresco (inclui null cacheado) → sem git
    }
    let pid = null;
    try { pid = tryResolveProjectId(cwd); } catch { pid = null; }
    try {
        mkdirSync(stateDir(), { recursive: true });
        all[key] = { pid: pid || null, cwd: String(cwd || ""), ts: Date.now() };
        writeFileSync(scopeCacheFile(), JSON.stringify(all), "utf8");
    } catch { /* best-effort: cache é otimização, não corretude */ }
    return pid;
}

let raw = "";
let finished = false;
function guard() { if (finished) return true; finished = true; return false; }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => { if (!guard()) { try { run(raw); } catch { allow(); } } });
// Fail-open DURO: dispara mesmo com input parcial (chunk sem 'end') — nunca segura até o timeout do host.
setTimeout(() => { if (!guard()) { try { run(raw); } catch { allow(); } } }, 3500).unref?.();

function pick(o, keys) { for (const k of keys) { if (o && o[k] != null) return o[k]; } return undefined; }
function allow() { process.exit(0); }
function emit(payload) {
    try { process.stdout.write(JSON.stringify(payload) + "\n", () => process.exit(0)); }
    catch { process.exit(0); }
}

function run(text) {
    const mode = resolveMode();
    if (mode === "off") return allow();
    let input;
    try { input = JSON.parse(text); } catch { return allow(); }

    const toolName = pick(input, ["tool_name", "toolName", "name"]);
    // EARLY-EXIT barato: só as tools de busca seguem (sem git/fs para o resto).
    if (!toolName || !isSearchTool(toolName)) return allow();

    const toolInput = pick(input, ["tool_input", "toolArgs", "toolInput", "arguments", "input", "args"]);
    const cwd = pick(input, ["cwd", "workingDirectory", "working_directory"]) || process.cwd();

    // Só gateia com MEMÓRIA ATIVA (o dono: "se a memória estiver ativa, com project id"). Sem project_id →
    // não há grafo p/ redirecionar → passthrough. Resolução COM CACHE (git no máx 1×/cwd/5min — hot path).
    let pid = null;
    try { pid = cachedProjectId(cwd); } catch { pid = null; }
    if (!pid) return allow();

    let verdict;
    try { verdict = classify({ toolName, toolInput, cwd }); } catch { return allow(); }

    try { logShadow({ toolName, toolArgs: toolInput, normalized: { operation: "search" }, ms: 0, decision: "grepguard:" + verdict.decision + ":" + mode }); } catch { /* noop */ }

    if (verdict.decision === "deny" && mode === "enforce") {
        return emit({
            hookSpecificOutput: {
                permissionDecision: "deny",
                permissionDecisionReason: verdict.reason,
                additionalContext: verdict.reason,
            },
        });
    }
    return allow(); // observe (loga, libera) OU allow
}
