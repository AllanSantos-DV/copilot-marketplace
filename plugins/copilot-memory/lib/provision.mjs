// Auto-provisionamento do memory server (native-java) — M7. O plugin é cliente puro, mas quando NÃO
// há daemon vivo E não há server instalado, ele faz o BOOTSTRAP inicial: baixa a release pública
// (assinada por sha256), sobe o JAR detached e aguarda o auto-anúncio. A partir daí o próprio daemon
// assume (singleton, update, auto-anúncio) — o plugin volta a só descobrir/reusar.
//
// PRINCÍPIO preservado: o plugin não REIMPLEMENTA o server nem gerencia singleton/update — ele só
// DISPARA a primeira instalação (o "ovo e galinha": o daemon não existe pra se instalar sozinho).
// Mesmo padrão do boot.mjs/canvas-sync (baixa-se-falta, reusa-se-existe).
//
// CONTRATO (lido do native-java, validado ao vivo):
//   releases: GET https://api.github.com/repos/AllanSantos-DV/mcp-memory-server-releases/releases?per_page=30
//   filtro:   tag ^v\d+\.\d+\.\d+$ (ignora sidecar-*/draft/prerelease); asset mcp-memory-server-*.jar
//   verify:   <jarUrl>.sha256 (best-effort — pula se ausente)
//   subir:    java -jar <jar> --transport http --daemon  (detached → escreve ~/.mcp-memory/run/daemon.json)
//
// Fail-open ABSOLUTO: qualquer erro (sem Java, rede, sha, spawn) → degrada; nunca lança, nunca trava.
import { spawn } from "node:child_process";
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { discover } from "./daemon.mjs";

const RELEASES_API = "https://api.github.com/repos/AllanSantos-DV/mcp-memory-server-releases/releases?per_page=30";
const MIN_VERSION = [2, 19, 0]; // ADR-016: lifecycle REST (feedback/PATCH) exige ≥2.19.0

export function autoProvisionEnabled() {
    return process.env.COPILOT_MEMORY_AUTOPROVISION !== "0";
}

function serverDir() {
    return process.env.COPILOT_MEMORY_SERVER_DIR || join(homedir(), ".mcp-memory", "server");
}
function lockPath() { return join(serverDir(), ".provisioning.lock"); }

// Resolve um executável java: JAVA_HOME/bin/java(.exe) → "java" no PATH. null se claramente ausente.
export function resolveJava() {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    const home = process.env.JAVA_HOME && process.env.JAVA_HOME.trim();
    if (home) {
        const p = join(home, "bin", exe);
        if (existsSync(p)) return p;
    }
    return "java"; // confia no PATH; o spawn falha (fail-open) se não existir
}

function parseVer(tag) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVer(a, b) {
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); }
    return 0;
}

// Busca a release de SERVIDOR mais nova (tag vX.Y.Z, com asset jar). Ignora sidecar/draft/prerelease
// e versões < MIN_VERSION. Retorna { version, tag, jarUrl, sha256Url } ou null. Nunca lança.
export async function fetchLatestServerRelease(fetchImpl = globalThis.fetch, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(RELEASES_API, { signal: ctrl.signal, headers: { "User-Agent": "copilot-memory", accept: "application/vnd.github+json" } });
        if (!res.ok) return null;
        const list = await res.json();
        if (!Array.isArray(list)) return null;
        let best = null;
        for (const rel of list) {
            if (rel.draft || rel.prerelease) continue;
            const ver = parseVer(rel.tag_name);
            if (!ver || cmpVer(ver, MIN_VERSION) < 0) continue;
            const assets = Array.isArray(rel.assets) ? rel.assets : [];
            const jar = pickJarAsset(assets);
            if (!jar) continue;
            if (!best || cmpVer(ver, best.version) > 0) {
                const sha = assets.find((a) => a.name === jar.name + ".sha256" || a.name === jar.name.replace(/\.jar$/, ".jar.sha256"));
                best = { version: ver, tag: rel.tag_name, jarUrl: jar.browser_download_url, jarName: jar.name, sha256Url: sha ? sha.browser_download_url : null };
            }
        }
        return best;
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

// Escolhe o asset do JAR do servidor. Prefere o "plain" (mcp-memory-server-X.Y.Z.jar) sobre variantes
// (ex.: -gpu), mas aceita qualquer mcp-memory-server-*.jar (espelha findServerJarUrl do servidor).
function pickJarAsset(assets) {
    const jars = assets.filter((a) => /^mcp-memory-server-.*\.jar$/.test(a.name || "") && !/\.sha256$/.test(a.name));
    if (!jars.length) return null;
    const plain = jars.find((a) => /^mcp-memory-server-\d+\.\d+\.\d+\.jar$/.test(a.name));
    return plain || jars[0];
}

export async function downloadTo(url, dest, fetchImpl = globalThis.fetch, timeoutMs = 120000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, { signal: ctrl.signal, headers: { "User-Agent": "copilot-memory" } });
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    } finally {
        clearTimeout(t);
    }
}

function sha256File(path) {
    return new Promise((resolve, reject) => {
        const h = createHash("sha256");
        createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
    });
}

// Verifica o sha256 do JAR contra o arquivo .sha256 da release. Best-effort: sem url → true (pula).
export async function verifySha256(jarPath, sha256Url, fetchImpl = globalThis.fetch) {
    if (!sha256Url) return true;
    try {
        const res = await fetchImpl(sha256Url, { headers: { "User-Agent": "copilot-memory" } });
        if (!res.ok) return true; // sha ausente/erro → best-effort (não bloqueia)
        const txt = (await res.text()).trim();
        const expected = (txt.split(/\s+/)[0] || "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expected)) return true;
        const actual = (await sha256File(jarPath)).toLowerCase();
        return actual === expected;
    } catch {
        return true; // best-effort
    }
}

// Lock com TTL: evita várias worktrees provisionarem em paralelo (start-or-reuse idempotente).
function acquireLock(ttlMs = 10 * 60 * 1000) {
    const p = lockPath();
    try {
        if (existsSync(p)) {
            const age = Date.now() - statSync(p).mtimeMs;
            if (age < ttlMs) return false; // outra sessão provisionando
        }
        writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        return true;
    } catch {
        return false;
    }
}
function releaseLock() { try { rmSync(lockPath(), { force: true }); } catch { /* ignore */ } }

function spawnDaemon(javaCmd, jarPath) {
    const child = spawn(javaCmd, ["-jar", jarPath, "--transport", "http", "--daemon"], {
        detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
}

async function waitForAnnounce(timeoutMs = 90000, stepMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const info = await discover();
        if (info) return info;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    return null;
}

// Ponto de entrada. Garante um daemon vivo. Retorna um relatório; NUNCA lança.
//   { ok, reused?, installed?, pending?, version?, reason? }
// Deps injetáveis (opts._*) têm defaults reais — servem para testar a orquestração sem IO real.
export async function ensureServer(opts = {}) {
    const _discover = opts._discover || discover;
    const _fetchRelease = opts._fetchRelease || fetchLatestServerRelease;
    const _download = opts._download || downloadTo;
    const _verify = opts._verify || verifySha256;
    const _spawn = opts._spawn || spawnDaemon;
    const _wait = opts._wait || waitForAnnounce;

    const already = await _discover();
    if (already) return { ok: true, reused: true, version: already.version || null };
    if (!autoProvisionEnabled()) return { ok: false, reason: "auto-provisionamento desligado (COPILOT_MEMORY_AUTOPROVISION=0)" };

    const dir = serverDir();
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    if (!acquireLock()) {
        // outra sessão está provisionando; dá uma janela e re-descobre
        const info = await _wait(opts.waitMs || 60000);
        return info ? { ok: true, installed: true, version: info.version || null } : { ok: false, pending: true, reason: "provisionamento em curso em outra sessão" };
    }
    try {
        const java = resolveJava();
        const release = await _fetchRelease();
        if (!release) return { ok: false, reason: "nenhuma release de servidor elegível (>=2.19.0) encontrada" };
        const jarPath = join(dir, release.jarName);
        if (!existsSync(jarPath)) {
            const tmp = jarPath + ".tmp";
            try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
            await _download(release.jarUrl, tmp);
            const okSha = await _verify(tmp, release.sha256Url);
            if (!okSha) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } return { ok: false, reason: "verificação sha256 do JAR falhou (download corrompido/adulterado)" }; }
            const { renameSync } = await import("node:fs");
            renameSync(tmp, jarPath);
        }
        _spawn(java, jarPath);
        const info = await _wait(opts.waitMs || 90000);
        if (info) return { ok: true, installed: true, version: info.version || release.tag };
        return { ok: false, reason: "servidor iniciado mas não anunciou a tempo (talvez sem Java 21 no PATH, ou warmup do modelo). Veja o README do mcp-memory-server." };
    } catch (e) {
        return { ok: false, reason: "falha ao provisionar: " + (e?.message || e) };
    } finally {
        releaseLock();
    }
}
