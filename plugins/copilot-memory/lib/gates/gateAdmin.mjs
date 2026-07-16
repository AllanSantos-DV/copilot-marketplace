// COLD PATH dos gates — administração (opt-in por projeto) e estado. Roda em tools, não no hot path.
// Liga/desliga o gate escrevendo o command hook PreToolUse no .github/hooks/hooks.json do REPO ALVO
// (per-workspace, opt-in — NUNCA no hooks.json global do plugin, que taxaria todas as sessões). Ver §0.8.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Caminho ABSOLUTO do gateHook instalado (irmão deste módulo). É o que o command hook do repo alvo invoca.
export function gateHookPath() {
    return join(HERE, "gateHook.mjs");
}

function hooksJsonPath(repoRoot) {
    return join(repoRoot, ".github", "hooks", "hooks.json");
}

// Marca nossa entrada para identificá-la no merge (sem depender do caminho exato).
const MARK = "copilot-memory-gate";

function readHooks(repoRoot) {
    try { return JSON.parse(readFileSync(hooksJsonPath(repoRoot), "utf8")); } catch { return null; }
}

function writeHooks(repoRoot, obj) {
    const p = hooksJsonPath(repoRoot);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
    return p;
}

function ourEntry() {
    // O comando cita o caminho absoluto do gateHook + um marcador comentável via campo "id".
    return {
        type: "command",
        id: MARK,
        command: `node "${gateHookPath()}"`,
        timeout: 10,
    };
}

function isOurs(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (entry.id === MARK) return true;
    return typeof entry.command === "string" && entry.command.includes("gateHook.mjs") && entry.command.includes("copilot-memory");
}

export function gateStatus(repoRoot) {
    const h = readHooks(repoRoot);
    const arr = h?.hooks?.PreToolUse;
    const enabled = Array.isArray(arr) && arr.some(isOurs);
    return { enabled, hooksJson: hooksJsonPath(repoRoot), hookScript: gateHookPath(), scriptExists: existsSync(gateHookPath()) };
}

// Liga o gate: adiciona (idempotente) nossa entrada PreToolUse, preservando quaisquer outros hooks.
export function enableGate(repoRoot) {
    const h = readHooks(repoRoot) || { version: 1, hooks: {} };
    if (!h.hooks || typeof h.hooks !== "object") h.hooks = {};
    const arr = Array.isArray(h.hooks.PreToolUse) ? h.hooks.PreToolUse.filter((e) => !isOurs(e)) : [];
    arr.push(ourEntry());
    h.hooks.PreToolUse = arr;
    if (!h.version) h.version = 1;
    const path = writeHooks(repoRoot, h);
    return { enabled: true, hooksJson: path, hookScript: gateHookPath() };
}

// Desliga: remove só a nossa entrada; se PreToolUse ficar vazio, remove a chave; preserva o resto.
export function disableGate(repoRoot) {
    const h = readHooks(repoRoot);
    if (!h?.hooks?.PreToolUse) return { enabled: false, hooksJson: hooksJsonPath(repoRoot), changed: false };
    const kept = h.hooks.PreToolUse.filter((e) => !isOurs(e));
    if (kept.length) h.hooks.PreToolUse = kept; else delete h.hooks.PreToolUse;
    const path = writeHooks(repoRoot, h);
    return { enabled: false, hooksJson: path, changed: true };
}
