// canvas-sync/sync.mjs — espelha canvas extensions instaladas via marketplace
// (installed-plugins/) para ~/.copilot/extensions/, ÚNICA pasta que o app GUI
// carrega como canvas. Self-contained (sem imports externos) — é baixado avulso.
//
// Princípios (validados em teste isolado, 10/10):
//  - SELETIVO: só o que está em settings.json -> enabledPlugins (= true).
//  - MARCADOR NATIVO: só plugin com o campo oficial `extensions` no plugin.json.
//  - IDEMPOTENTE: stamp .canvas-sync.json evita recopiar (versão+origem iguais).
//  - SEGURO: nunca sobrescreve pasta sem stamp (cópia dev) -> "exists-unmanaged".
//
// Uso como módulo: import { syncCanvases } from "./sync.mjs"
// Uso como script (hook): node sync.mjs  -> roda e loga em ~/.copilot/canvas-sync/last-run.log

import {
    existsSync, readFileSync, readdirSync, mkdirSync,
    copyFileSync, writeFileSync, appendFileSync,
} from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const STAMP = ".canvas-sync.json";
const SKIP_ENTRIES = new Set([".git", "node_modules", "artifacts", STAMP]);

// Resolve a raiz ~/.copilot de forma portável (qualquer usuário/máquina).
// Em hook de plugin, COPILOT_PLUGIN_ROOT = ...\.copilot\installed-plugins\<mp>\<plugin>.
export function resolveCopilotHome() {
    const r = process.env.COPILOT_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "";
    const marker = sep + "installed-plugins" + sep;
    const i = r.indexOf(marker);
    if (i > 0) return r.slice(0, i);
    if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
    return join(homedir(), ".copilot");
}

export function readEnabledPlugins(home) {
    const sp = join(home, "settings.json");
    if (!existsSync(sp)) return [];
    let j;
    try { j = JSON.parse(readFileSync(sp, "utf8")); } catch { return []; }
    const out = [];
    for (const [key, val] of Object.entries(j.enabledPlugins || {})) {
        if (val !== true) continue;
        const at = key.lastIndexOf("@");
        if (at <= 0) out.push({ name: key, marketplace: null });
        else out.push({ name: key.slice(0, at), marketplace: key.slice(at + 1) });
    }
    return out;
}

export function extensionDirsFor(pluginJson) {
    const e = pluginJson?.extensions;
    if (!e) return [];
    if (typeof e === "string") return [e];
    if (Array.isArray(e)) return e.filter((x) => typeof x === "string");
    if (typeof e === "object" && Array.isArray(e.paths)) return e.paths.filter((x) => typeof x === "string");
    return [];
}

function findPluginDir(installedRoot, name, marketplace) {
    const candidates = [];
    if (marketplace) candidates.push(join(installedRoot, marketplace, name));
    if (existsSync(installedRoot)) {
        for (const mp of readdirSync(installedRoot, { withFileTypes: true })) {
            if (mp.isDirectory()) candidates.push(join(installedRoot, mp.name, name));
        }
    }
    return candidates.find((c) => existsSync(join(c, "plugin.json"))) || null;
}

export function planSync(home) {
    const installedRoot = join(home, "installed-plugins");
    const extRoot = join(home, "extensions");
    const plan = [];
    for (const { name, marketplace } of readEnabledPlugins(home)) {
        const pdir = findPluginDir(installedRoot, name, marketplace);
        if (!pdir) { plan.push({ name, status: "missing" }); continue; }
        let pj;
        try { pj = JSON.parse(readFileSync(join(pdir, "plugin.json"), "utf8")); }
        catch { plan.push({ name, status: "bad-manifest" }); continue; }
        const extDirs = extensionDirsFor(pj);
        if (extDirs.length === 0) { plan.push({ name, status: "not-canvas" }); continue; }
        for (const rel of extDirs) {
            const srcDir = rel === "." ? pdir : join(pdir, rel);
            const targetName = rel === "." ? name : basename(rel);
            if (!existsSync(join(srcDir, "extension.mjs"))) {
                plan.push({ name: targetName, status: "no-extension-mjs", srcDir });
                continue;
            }
            const version = (pj.version && String(pj.version)) || "0.0.0";
            const target = join(extRoot, targetName);
            const stampPath = join(target, STAMP);
            if (existsSync(target) && !existsSync(stampPath)) {
                plan.push({ name: targetName, status: "exists-unmanaged", srcDir, version, target });
                continue;
            }
            let action = "create";
            if (existsSync(stampPath)) {
                let cur = null;
                try { cur = JSON.parse(readFileSync(stampPath, "utf8")); } catch {}
                action = (cur && cur.version === version && cur.source === srcDir) ? "uptodate" : "update";
            }
            plan.push({ name: targetName, status: "canvas", action, srcDir, version, target });
        }
    }
    return plan;
}

function copyDir(src, dst) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (SKIP_ENTRIES.has(entry.name)) continue;
        const s = join(src, entry.name);
        const d = join(dst, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else if (entry.isFile()) copyFileSync(s, d);
    }
}

export function syncCanvases(home, opts = {}) {
    const plan = planSync(home);
    const result = { mirrored: [], skipped: [], unmanaged: [], errors: [], items: plan };
    for (const item of plan) {
        if (item.status === "exists-unmanaged") { result.unmanaged.push(item.name); continue; }
        if (item.status !== "canvas") continue;
        if (item.action === "uptodate" && !opts.force) { result.skipped.push(item.name); continue; }
        if (opts.dryRun) { result.mirrored.push(item.name); continue; }
        try {
            copyDir(item.srcDir, item.target);
            writeFileSync(join(item.target, STAMP), JSON.stringify({
                source: item.srcDir, version: item.version,
                syncedAt: new Date().toISOString(), managedBy: "canvas-sync",
            }, null, 2));
            result.mirrored.push(item.name);
        } catch (e) {
            result.errors.push({ name: item.name, error: String(e?.message || e) });
        }
    }
    return result;
}

// Runner do hook: roda o sync e loga em arquivo (NUNCA em stdout — hooks
// interpretam stdout). Nunca lança: um hook não pode quebrar a sessão.
export function runAsHook() {
    const home = resolveCopilotHome();
    let line;
    try {
        const r = syncCanvases(home, {});
        line = JSON.stringify({ at: new Date().toISOString(), mirrored: r.mirrored, skipped: r.skipped, unmanaged: r.unmanaged, errors: r.errors });
    } catch (e) {
        line = JSON.stringify({ at: new Date().toISOString(), fatal: String(e?.message || e) });
    }
    try {
        const logDir = join(home, "canvas-sync");
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, "last-run.log"), line + "\n");
    } catch {}
}

// Executado direto? (node sync.mjs)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runAsHook();
}
