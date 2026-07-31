// canvas-sync/boot.mjs — bootstrap mínimo embutido em CADA plugin da vitrine.
// No SessionStart: garante o canvas-sync (baixa se faltar, AUTO-ATUALIZA se a
// vitrine tem versão mais nova) e o aciona. Assim o usuário só escolhe o plugin —
// o sync vem/atualiza sozinho e espelha quem é canvas. Self-contained, nunca lança.

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // pasta do plugin (p/ semear a lib bundled do ask-bridge)

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

// PRUNE DO INSTALADOR (pedido explícito do dono): o mirror ~/.copilot/extensions/<plugin> é a INSTALAÇÃO que o
// app carrega — deve ter SÓ os arquivos de RUNTIME, jamais artefatos de dev (test/probes/docs/.memory/…). O
// canvas-sync copia a pasta INTEIRA (extensions:["."]); aqui, DEPOIS do sync, podamos o mirror por ALLOWLIST de
// runtime. Roda em todo SessionStart (após o 1º prune não há o que remover → barato). Best-effort, NUNCA lança.
const RUNTIME_KEEP = new Set([
  "extension.mjs", "boot.mjs", "plugin.json", "hooks.json", "package.json", "LICENSE",
  "src", "embed-house", "agents", "selftest", ".canvas-sync.json", ".canvas-sync-ignore",
  // Alvo do `npm test` do pacote publicado: sem ele a poda apagaria o script e o `npm test` do runtime voltaria
  // a falhar com "Cannot find module" — o mesmo erro opaco que ele existe para eliminar.
  "scripts",
  ".build-provenance.json", // PROVA de qual commit/tag/branch/remote originou o build (buildProvenance.mjs) — sem
                             // isso o modo-sombra audita o mirror podado e não tem como distinguir "não existe" de
                             // "não foi possível medir aqui" (falso negativo). Artefato de DADOS, não de dev.
]);
export function resolvePluginName(env = process.env) {
  try {
    const pdir = env.COPILOT_PLUGIN_ROOT || env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || "";
    const pj = pdir && existsSync(join(pdir, "plugin.json")) ? JSON.parse(readFileSync(join(pdir, "plugin.json"), "utf8")) : null;
    if (pj?.name) return String(pj.name);
  } catch { /* ignora */ }
  return "modo-auto";
}
// Poda o mirror deixando só o runtime (allowlist). Retorna os nomes removidos. Nunca lança.
export function pruneMirror(home, pluginName = resolvePluginName()) {
  const removed = [];
  try {
    const dir = join(home, "extensions", pluginName);
    if (!existsSync(dir)) return removed;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (RUNTIME_KEEP.has(ent.name)) continue;
      try { rmSync(join(dir, ent.name), { recursive: true, force: true }); removed.push(ent.name); } catch { /* travado: ignora */ }
    }
  } catch { /* nunca lança (hook não pode quebrar a sessão) */ }
  return removed;
}

// Aviso visível na timeline quando houve canvas novo/atualizado (gatilho de reinício).
export function emitRestartAlert(mirrored) {
    if (!Array.isArray(mirrored) || mirrored.length === 0) return;
    const n = mirrored.length;
    const msg = `\u26A0\uFE0F canvas-sync: ${n} canvas ${n === 1 ? "novo/atualizado" : "novos/atualizados"} (${mirrored.join(", ")}). Reinicie o app para carregar.`;
    try { process.stdout.write(JSON.stringify({ type: "progress", message: msg }) + "\n"); } catch {}
}

// SEMEIA a lib COMPARTILHADA do ask-bridge (~/.ask-bridge/lib) a partir da cópia BUNDLED deste plugin. Idempotente
// e "maior versão vence" (ver askBridgeShared). Roda no SessionStart p/ a lib existir mesmo que o modo-auto não
// seja armado (outro plugin pode depender do seed). Best-effort: NUNCA lança (hook não pode quebrar a sessão).
export async function seedAskBridge(home = homedir()) {
  try {
    const mod = await import(pathToFileURL(join(HERE, "src", "adapters", "session", "askBridgeShared.mjs")).href);
    if (mod && typeof mod.ensureAskBridgeLib === "function") return mod.ensureAskBridgeLib({ home, log: () => {} });
  } catch (e) { return { error: String(e?.message || e) }; }
  return { error: "askBridgeShared sem ensureAskBridgeLib" };
}

// Runner do hook: roda e loga em arquivo (nunca stdout, exceto o alerta). Nunca lança.
export async function runAsHook() {
    let report;
    try { report = await bootstrap(); }
    catch (e) { report = { fatal: String(e?.message || e) }; }
    // PRUNE do instalador: após o canvas-sync espelhar, remove os artefatos de dev do mirror (só runtime fica).
    let pruned = [];
    try { pruned = pruneMirror(resolveCopilotHome()); } catch { /* nunca lança */ }
    // SEMEIA a lib compartilhada do ask-bridge (idempotente, best-effort).
    let askBridge = null;
    try { askBridge = await seedAskBridge(); } catch (e) { askBridge = { error: String(e?.message || e) }; }
    try {
        const home = resolveCopilotHome();
        const dir = join(home, "canvas-sync");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "boot.log"), JSON.stringify({ at: new Date().toISOString(), ...report, pruned, askBridge }) + "\n");
    } catch {}
    if (report && report.result) emitRestartAlert(report.result.mirrored);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runAsHook();
}
