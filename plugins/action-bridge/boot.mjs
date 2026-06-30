// canvas-sync/boot.mjs — bootstrap mínimo embutido em CADA plugin da vitrine.
// No SessionStart do plugin: localiza o canvas-sync; se faltar, BAIXA da vitrine
// (cópia zero/canônica) e o aciona. Assim o usuário só escolhe o plugin — o sync
// vem sozinho quando não existe e espelha quem é canvas. Self-contained, nunca lança.

import { existsSync, readdirSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const DEFAULT_RAW_URL =
    "https://raw.githubusercontent.com/AllanSantos-DV/copilot-marketplace/main/plugins/canvas-sync/sync.mjs";

export function resolveCopilotHome() {
    const r = process.env.COPILOT_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "";
    const marker = sep + "installed-plugins" + sep;
    const i = r.indexOf(marker);
    if (i > 0) return r.slice(0, i);
    if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
    return join(homedir(), ".copilot");
}

// Procura um sync.mjs do canvas-sync já presente: cache dedicado OU plugin instalado.
export function locateSync(home) {
    const cache = join(home, "canvas-sync", "sync.mjs");
    if (existsSync(cache)) return cache;
    const installedRoot = join(home, "installed-plugins");
    if (existsSync(installedRoot)) {
        for (const mp of readdirSync(installedRoot, { withFileTypes: true })) {
            if (!mp.isDirectory()) continue;
            const p = join(installedRoot, mp.name, "canvas-sync", "sync.mjs");
            if (existsSync(p)) return p;
        }
    }
    return null;
}

async function download(url, dest, fetchImpl, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, { signal: ctrl.signal });
        if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
        const text = await res.text();
        if (!text || text.length < 50) throw new Error("conteúdo vazio/curto");
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, text);
        return true;
    } finally {
        clearTimeout(t);
    }
}

// Núcleo testável: deps injetáveis (fetch/import). Nunca lança — retorna relatório.
export async function bootstrap({
    home = resolveCopilotHome(),
    rawUrl = DEFAULT_RAW_URL,
    fetchImpl = globalThis.fetch,
    importImpl = (href) => import(href),
} = {}) {
    const report = { home, downloaded: false, ran: false, syncPath: null, error: null };
    try {
        let syncPath = locateSync(home);
        if (!syncPath) {
            const cachePath = join(home, "canvas-sync", "sync.mjs");
            await download(rawUrl, cachePath, fetchImpl);
            report.downloaded = true;
            syncPath = cachePath;
        }
        report.syncPath = syncPath;
        const mod = await importImpl(pathToFileURL(syncPath).href);
        if (mod && typeof mod.syncCanvases === "function") {
            report.result = mod.syncCanvases(home, {});
            report.ran = true;
        } else {
            report.error = "sync.mjs sem export syncCanvases";
        }
    } catch (e) {
        report.error = String(e?.message || e);
    }
    return report;
}

// Runner do hook: roda e loga em arquivo (nunca stdout). Nunca lança.
export async function runAsHook() {
    let report;
    try { report = await bootstrap(); }
    catch (e) { report = { fatal: String(e?.message || e) }; }
    try {
        const home = resolveCopilotHome();
        const dir = join(home, "canvas-sync");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "boot.log"), JSON.stringify({ at: new Date().toISOString(), ...report }) + "\n");
    } catch {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runAsHook();
}
