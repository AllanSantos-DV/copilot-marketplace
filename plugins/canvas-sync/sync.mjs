// canvas-sync/sync.mjs — espelha canvas extensions instaladas via marketplace
// (installed-plugins/) para ~/.copilot/extensions/, ÚNICA pasta que o app GUI
// carrega como canvas. Self-contained (sem imports externos) — é baixado avulso.
//
// Princípios (validados em teste isolado, 10/10):
//  - SELETIVO: só o que está em settings.json -> enabledPlugins (= true).
//  - MARCADOR NATIVO: só plugin com o campo oficial `extensions` no plugin.json.
//  - IDEMPOTENTE: stamp .canvas-sync.json evita recopiar (versão+origem iguais).
//  - SEGURO: nunca sobrescreve pasta sem stamp (cópia dev) -> "exists-unmanaged".
//  - NUNCA REBAIXA (0.5.0): a versão que ENTRA é comparada com a do CARIMBO; entrada
//    mais velha é RECUSADA e reportada ("blocked"), nunca aplicada em silêncio. Foi a
//    ausência desta guarda que deixou uma cópia velha sobrescrever o mirror a cada boot.
//  - SEM AMBIGUIDADE (0.5.0): duas origens mirando o MESMO alvo não são mais resolvidas
//    por ordem de varredura ("o último ganha") e sim pela MAIOR versão, com os perdedores
//    reportados como "shadowed" — visíveis, nunca silenciosos.
//  - DETECÇÃO ANTES DE PREVENÇÃO (0.5.0): o log e o carimbo gravam QUAL motor escreveu
//    (versão + hash), para que divergência entre cópias do próprio canvas-sync apareça.
//  - REGRA FIRME: versão semântica é a ÚNICA chave de decisão. mtime JAMAIS entra no `if`.
//
// Uso como módulo: import { syncCanvases } from "./sync.mjs"
// Uso como script (hook): node sync.mjs  -> roda e loga em ~/.copilot/canvas-sync/last-run.log

import {
    existsSync, readFileSync, readdirSync, mkdirSync,
    copyFileSync, writeFileSync, appendFileSync, rmSync,
} from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// Versão do canvas-sync. O boot embutido em cada plugin compara esta versão com
// a do sync em cache e re-baixa quando a vitrine tem uma mais nova (auto-update).
export const CANVAS_SYNC_VERSION = "0.6.0";

// Impressão digital do PRÓPRIO arquivo em execução. Existiram três cópias divergentes
// deste motor rodando na mesma máquina (0.3.0 cego para _direct no hook, 0.4.0 no cache)
// e nada tornava isso visível. Agora todo carimbo e toda linha de log dizem quem escreveu.
export function engineFingerprint() {
    try { return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 12); }
    catch { return null; }
}

// Compara versões semânticas. Devolve -1 | 0 | 1, ou null se QUALQUER lado for
// inconhecível — null é "não sei", e quem chama trata explicitamente (nunca vira 0).
export function cmpVersion(a, b) {
    if (!a || !b) return null;
    const parse = (v) => String(v).trim().replace(/^v/i, "").split("-")[0].split(".").map((n) => parseInt(n, 10));
    const pa = parse(a), pb = parse(b);
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0, y = pb[i] ?? 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

// CIRCUIT-BREAKER anti-downgrade — tabela de 4 casos (nunca um `incoming < current` simples,
// que congelaria a primeira publicação de um canvas novo):
//   ambos versionados      -> escreve se entrada >= atual; senão RECUSA
//   entrada sem / atual com-> RECUSA (não deixa artefato sem versão apagar um versionado)
//   entrada com / atual sem-> ESCREVE, mas SINALIZA (é a adoção legítima do primeiro carimbo)
//   ambos sem              -> ESCREVE, registrado como NÃO-PROTEGIDO (last-write assumido)
export function guardDowngrade(currentVersion, incomingVersion) {
    if (incomingVersion && currentVersion) {
        const c = cmpVersion(incomingVersion, currentVersion);
        if (c === null) return { allow: false, reason: "versao-inconhecivel", current: currentVersion, incoming: incomingVersion };
        if (c < 0) return { allow: false, reason: "downgrade-recusado", current: currentVersion, incoming: incomingVersion };
        return { allow: true, reason: c === 0 ? "mesma-versao-origem-nova" : "upgrade", current: currentVersion, incoming: incomingVersion };
    }
    if (!incomingVersion && currentVersion) return { allow: false, reason: "entrada-sem-versao", current: currentVersion, incoming: null };
    if (incomingVersion && !currentVersion) return { allow: true, reason: "carimbo-sem-versao-sinalizado", current: null, incoming: incomingVersion };
    return { allow: true, reason: "ambos-sem-versao-nao-protegido", current: null, incoming: null };
}

// Duas ORIGENS mirando o MESMO alvo (ex.: a mesma extensão instalada pela vitrine E direto)
// era resolvida pela ORDEM da varredura — o último gravava. Agora vence a MAIOR versão e os
// perdedores viram "shadowed", reportados. Determinístico e auditável.
export function resolveAmbiguity(plan) {
    const byTarget = new Map();
    for (const item of plan) {
        if (item.status !== "canvas" || !item.target) continue;
        const list = byTarget.get(item.target) || [];
        list.push(item);
        byTarget.set(item.target, list);
    }
    const out = [];
    const losers = new Set();
    for (const [, list] of byTarget) {
        if (list.length < 2) continue;
        let winner = list[0];
        for (const cand of list.slice(1)) {
            const c = cmpVersion(cand.version, winner.version);
            if (c !== null && c > 0) winner = cand;
        }
        for (const item of list) {
            if (item === winner) { item.ambiguous = list.map((i) => i.srcDir); continue; }
            losers.add(item);
        }
    }
    for (const item of plan) {
        if (!losers.has(item)) { out.push(item); continue; }
        out.push({ ...item, status: "shadowed", action: null, reason: "outra-origem-tem-versao-maior" });
    }
    return out;
}

const STAMP = ".canvas-sync.json";
// Marcador opt-out: se existir na pasta da extensão, o canvas-sync NÃO toca nela
// (protege uma cópia de desenvolvimento intencional). Sem ele, o marketplace vence.
const IGNORE_MARKER = ".canvas-sync-ignore";
const SKIP_ENTRIES = new Set([".git", "node_modules", "artifacts", STAMP, IGNORE_MARKER]);

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

// Installs DIRETOS (`copilot plugin install owner/repo`) caem em installed-plugins/_direct/<owner>--<repo>
// e NÃO entram no enabledPlugins do settings.json — então o canvas-sync não os via. Aqui varremos a pasta
// _direct e lemos o NOME real de cada plugin.json (a pasta é owner--repo, não bate com o name). Local-only.
export function readDirectInstalls(installedRoot) {
    const out = [];
    const directRoot = join(installedRoot, "_direct");
    if (!existsSync(directRoot)) return out;
    for (const ent of readdirSync(directRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const pdir = join(directRoot, ent.name);
        const pjPath = join(pdir, "plugin.json");
        if (!existsSync(pjPath)) continue;
        let pj; try { pj = JSON.parse(readFileSync(pjPath, "utf8")); } catch { continue; }
        out.push({ name: (pj && pj.name) || ent.name, pdir });
    }
    return out;
}

export function planSync(home) {
    const installedRoot = join(home, "installed-plugins");
    const extRoot = join(home, "extensions");
    const plan = [];
    // Plugins do marketplace (via enabledPlugins) + installs DIRETOS (owner/repo → _direct/, fora do enabledPlugins).
    const work = [];
    for (const { name, marketplace } of readEnabledPlugins(home)) work.push({ name, pdir: findPluginDir(installedRoot, name, marketplace) });
    const seen = new Set(work.map((w) => w.pdir).filter(Boolean));
    for (const d of readDirectInstalls(installedRoot)) { if (!seen.has(d.pdir)) { work.push(d); seen.add(d.pdir); } }
    for (const { name, pdir } of work) {
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
            const version = pj.version ? String(pj.version) : null;
            const target = join(extRoot, targetName);
            const stampPath = join(target, STAMP);
            if (existsSync(target) && !existsSync(stampPath)) {
                // Cópia SEM stamp (dev/obsoleta). Por padrão o canvas-sync ADOTA
                // (marketplace = fonte da verdade) — a menos que haja o opt-out.
                if (existsSync(join(target, IGNORE_MARKER))) {
                    plan.push({ name: targetName, status: "dev-protected", srcDir, version, target });
                    continue;
                }
                plan.push({ name: targetName, status: "canvas", action: "adopt", srcDir, version, target });
                continue;
            }
            let action = "create";
            let guard = null;
            if (existsSync(stampPath)) {
                let cur = null;
                try { cur = JSON.parse(readFileSync(stampPath, "utf8")); } catch {}
                if (cur && cur.version === version && cur.source === srcDir) action = "uptodate";
                else {
                    // A ENTRADA só sobrescreve o CARIMBO se a guarda deixar. É aqui que o
                    // rebaixamento silencioso morre.
                    guard = guardDowngrade(cur && cur.version ? String(cur.version) : null, version);
                    action = guard.allow ? "update" : "blocked";
                }
            }
            plan.push({ name: targetName, status: "canvas", action, srcDir, version, target, ...(guard ? { guard } : {}) });
        }
    }
    return resolveAmbiguity(plan);
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

// Espelha src -> target. ESPELHO EXATO (0.6.0): além de copiar, REMOVE do destino o que não existe mais na
// origem. Antes só o "adopt" limpava, e o "update" copiava POR CIMA — então todo arquivo apagado na origem
// ficava órfão no destino PARA SEMPRE. Isso não é teórico: um artefato de teste (`src/soma-pares.mjs`) já
// tinha sido removido da fonte, da vitrine e do install, e MESMO ASSIM continuava no mirror instalado,
// fazendo auditoria acusar código que não existe mais. Espelho que não remove não é espelho, é acúmulo.
// O carimbo e o marcador de opt-out são PRESERVADOS (são metadados do destino, não conteúdo da origem).
function pruneOrphans(srcDir, target) {
  const removed = [];
  const walk = (rel) => {
    const dstDir = rel ? join(target, rel) : target;
    let entries;
    try { entries = readdirSync(dstDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP_ENTRIES.has(ent.name)) continue; // .git/node_modules/stamp/ignore-marker: metadados, não conteúdo
      const childRel = rel ? join(rel, ent.name) : ent.name;
      const srcPath = join(srcDir, childRel);
      if (ent.isDirectory()) {
        if (!existsSync(srcPath)) { try { rmSync(join(target, childRel), { recursive: true, force: true }); removed.push(childRel); } catch { /* travado: fica */ } }
        else walk(childRel);
      } else if (!existsSync(srcPath)) {
        try { rmSync(join(target, childRel), { force: true }); removed.push(childRel); } catch { /* travado: fica */ }
      }
    }
  };
  walk("");
  return removed;
}

function mirrorInto(srcDir, target, clean) {
  if (clean && existsSync(target)) {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* travado: sobrescreve por cima */ }
  }
  copyDir(srcDir, target);
  return clean ? [] : pruneOrphans(srcDir, target);
}

export function syncCanvases(home, opts = {}) {
    const plan = planSync(home);
    const engine = engineFingerprint();
    const result = { mirrored: [], adopted: [], skipped: [], protected: [], blocked: [], shadowed: [], pruned: [], errors: [], engine: CANVAS_SYNC_VERSION, engineHash: engine, items: plan };
    for (const item of plan) {
        if (item.status === "dev-protected") { result.protected.push(item.name); continue; }
        if (item.status === "shadowed") { result.shadowed.push({ name: item.name, srcDir: item.srcDir, version: item.version, reason: item.reason }); continue; }
        if (item.status !== "canvas") continue;
        // RECUSA VISÍVEL: nem `force` atropela a guarda. Rebaixar exige `allowDowngrade`
        // explícito — senão "consertar com force" reintroduz o bug que a guarda existe p/ matar.
        if (item.action === "blocked" && !opts.allowDowngrade) {
            result.blocked.push({ name: item.name, from: item.guard?.current ?? null, to: item.guard?.incoming ?? null, reason: item.guard?.reason ?? "blocked", srcDir: item.srcDir });
            continue;
        }
        if (item.action === "uptodate" && !opts.force) { result.skipped.push(item.name); continue; }
        if (opts.dryRun) { result.mirrored.push(item.name); if (item.action === "adopt") result.adopted.push(item.name); continue; }
        try {
            const orphans = mirrorInto(item.srcDir, item.target, item.action === "adopt");
            if (orphans && orphans.length) result.pruned.push({ name: item.name, files: orphans });
            writeFileSync(join(item.target, STAMP), JSON.stringify({
                source: item.srcDir, version: item.version, action: item.action,
                syncedAt: new Date().toISOString(), managedBy: "canvas-sync",
                engine: CANVAS_SYNC_VERSION, engineHash: engine,
                ...(item.guard ? { guard: item.guard.reason } : {}),
                ...(item.ambiguous ? { ambiguousSources: item.ambiguous } : {}),
            }, null, 2));
            result.mirrored.push(item.name);
            if (item.action === "adopt") result.adopted.push(item.name);
        } catch (e) {
            result.errors.push({ name: item.name, error: String(e?.message || e) });
        }
    }
    return result;
}

// Emite um aviso VISÍVEL na timeline (progress message) quando houve canvas novo
// ou atualizado — é o gatilho nativo de "reinicie o app". Só emite se houver algo.
export function emitRestartAlert(mirrored) {
    if (!Array.isArray(mirrored) || mirrored.length === 0) return;
    const n = mirrored.length;
    const msg = `\u26A0\uFE0F canvas-sync: ${n} canvas ${n === 1 ? "novo/atualizado" : "novos/atualizados"} (${mirrored.join(", ")}). Reinicie o app para carregar.`;
    try { process.stdout.write(JSON.stringify({ type: "progress", message: msg }) + "\n"); } catch {}
}

// Runner do hook: roda o sync e loga em arquivo (NUNCA em stdout, exceto o
// progress message do alerta). Nunca lança: um hook não pode quebrar a sessão.
export function runAsHook() {
    const home = resolveCopilotHome();
    let result = null, line;
    try {
        result = syncCanvases(home, {});
        line = JSON.stringify({ at: new Date().toISOString(), v: CANVAS_SYNC_VERSION, engineHash: engineFingerprint(), mirrored: result.mirrored, skipped: result.skipped, blocked: result.blocked, shadowed: result.shadowed, pruned: result.pruned, unmanaged: result.unmanaged, errors: result.errors });
    } catch (e) {
        line = JSON.stringify({ at: new Date().toISOString(), fatal: String(e?.message || e) });
    }
    try {
        const logDir = join(home, "canvas-sync");
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, "last-run.log"), line + "\n");
    } catch {}
    if (result) emitRestartAlert(result.mirrored);
}

// Executado direto? (node sync.mjs)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runAsHook();
}
