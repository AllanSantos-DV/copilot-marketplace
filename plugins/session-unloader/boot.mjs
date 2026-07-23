// canvas-sync/boot.mjs — bootstrap mínimo embutido em CADA plugin da vitrine.
// No SessionStart: garante o canvas-sync (baixa se faltar, AUTO-ATUALIZA se a
// vitrine tem versão mais nova) e o aciona. Assim o usuário só escolhe o plugin —
// o sync vem/atualiza sozinho e espelha quem é canvas. Self-contained, nunca lança.

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const DEFAULT_RAW_URL =
    "https://raw.githubusercontent.com/AllanSantos-DV/copilot-marketplace/main/plugins/canvas-sync/sync.mjs";
const CHECK_THROTTLE_MS = Number(process.env.CANVAS_SYNC_TTL_MS) || 30000; // dedup boots paralelos

export function resolveCopilotHome() {
    const r = process.env.COPILOT_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "";
    const marker = sep + "installed-plugins" + sep;
    const i = r.indexOf(marker);
    if (i > 0) return r.slice(0, i);
    if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
    return join(homedir(), ".copilot");
}

// Lê `export const CANVAS_SYNC_VERSION = "x.y.z"` de um texto de sync.mjs.
export function extractVersion(text) {
    const m = /CANVAS_SYNC_VERSION\s*=\s*["']([^"']+)["']/.exec(String(text || ""));
    return m ? m[1] : null;
}

// true se a > b (semver-ish, componente a componente).
export function isNewer(a, b) {
    const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

// canvas-sync instalado como PLUGIN (gerenciado pelo plugin system) — fonte usada
// só quando não há cache.
function locateInstalled(home) {
    const installedRoot = join(home, "installed-plugins");
    if (!existsSync(installedRoot)) return null;
    for (const mp of readdirSync(installedRoot, { withFileTypes: true })) {
        if (!mp.isDirectory()) continue;
        const p = join(installedRoot, mp.name, "canvas-sync", "sync.mjs");
        if (existsSync(p)) return p;
    }
    return null;
}

// Compat p/ testes: cache tem prioridade, depois installed-plugins.
export function locateSync(home) {
    const cache = join(home, "canvas-sync", "sync.mjs");
    if (existsSync(cache)) return cache;
    return locateInstalled(home);
}

async function fetchText(url, fetchImpl, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, { signal: ctrl.signal });
        if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
        const text = await res.text();
        if (!text || text.length < 50) throw new Error("conteúdo vazio/curto");
        return text;
    } finally { clearTimeout(t); }
}

function readMeta(metaPath) {
    try { return JSON.parse(readFileSync(metaPath, "utf8")); } catch { return {}; }
}

// Núcleo testável: deps injetáveis (fetch/import/now). Nunca lança — retorna relatório.
export async function bootstrap({
    home = resolveCopilotHome(),
    rawUrl = DEFAULT_RAW_URL,
    fetchImpl = globalThis.fetch,
    importImpl = (href) => import(href),
    now = () => Date.now(),
    throttleMs = CHECK_THROTTLE_MS,
} = {}) {
    const report = { home, downloaded: false, updated: false, ran: false, syncPath: null, version: null, error: null };
    try {
        const cacheDir = join(home, "canvas-sync");
        const cachePath = join(cacheDir, "sync.mjs");
        const metaPath = join(cacheDir, "installed.json");
        let syncPath = null;

        if (existsSync(cachePath)) {
            // Fonte = cache: auto-update por versão (com throttle p/ dedup de boots paralelos).
            syncPath = cachePath;
            const meta = readMeta(metaPath);
            if (now() - (meta.checkedAt || 0) >= throttleMs) {
                try {
                    const text = await fetchText(rawUrl, fetchImpl);
                    const remoteVer = extractVersion(text);
                    const localVer = meta.version || extractVersion(readFileSync(cachePath, "utf8"));
                    if (remoteVer && isNewer(remoteVer, localVer)) {
                        writeFileSync(cachePath, text);
                        report.updated = true;
                        report.version = remoteVer;
                    } else {
                        report.version = localVer;
                    }
                    writeFileSync(metaPath, JSON.stringify({ version: report.version || localVer, checkedAt: now() }));
                } catch { /* offline: mantém o cache */ }
            } else {
                report.version = meta.version || null;
            }
        } else {
            const inst = locateInstalled(home);
            if (inst) {
                syncPath = inst; // canvas-sync instalado como plugin — gerenciado pelo plugin system
            } else {
                const text = await fetchText(rawUrl, fetchImpl);
                mkdirSync(cacheDir, { recursive: true });
                writeFileSync(cachePath, text);
                const ver = extractVersion(text);
                writeFileSync(metaPath, JSON.stringify({ version: ver, checkedAt: now() }));
                report.downloaded = true;
                report.version = ver;
                syncPath = cachePath;
            }
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

// Aviso visível na timeline quando houve canvas novo/atualizado (gatilho de reinício).
export function emitRestartAlert(mirrored) {
    if (!Array.isArray(mirrored) || mirrored.length === 0) return;
    const n = mirrored.length;
    const msg = `\u26A0\uFE0F canvas-sync: ${n} canvas ${n === 1 ? "novo/atualizado" : "novos/atualizados"} (${mirrored.join(", ")}). Reinicie o app para carregar.`;
    try { process.stdout.write(JSON.stringify({ type: "progress", message: msg }) + "\n"); } catch {}
}

// Runner do hook: roda e loga em arquivo (nunca stdout, exceto o alerta). Nunca lança.
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
    if (report && report.result) emitRestartAlert(report.result.mirrored);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runAsHook();
}
