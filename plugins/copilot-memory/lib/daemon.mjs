// Discovery CLIENTE-PURO do daemon único de memória (native-java).
// Lê o registry auto-anunciado ~/.mcp-memory/run/daemon.json, faz health-check e reusa a URL.
// NUNCA sobe o JAR nem gerencia o daemon — isso é da infra do native-java (autostart de SO).
// Espelha DaemonRegistryPath.java:49-69, DaemonInfo.java:22-36 e HttpHealthChecker.java:36-43,
// mas só a parte read+health (sem spawn).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { configuredDaemonUrl } from "./daemonConfig.mjs";

// run-dir: env MCP_RUN_DIR → ~/.mcp-memory/run/ (o plugin não precisa da system property da JVM).
export function resolveRunDir() {
    const env = process.env.MCP_RUN_DIR;
    if (env && env.trim()) return env.trim();
    return join(homedir(), ".mcp-memory", "run");
}

// Leitura TOLERANTE do registry: ausente/vazio/corrompido → null (nunca lança).
// Só precisamos de `url`; campos desconhecidos são ignorados (forward-compat, schemaVersion).
export function readRegistry(runDir = resolveRunDir()) {
    try {
        const raw = readFileSync(join(runDir, "daemon.json"), "utf8");
        if (!raw || !raw.trim()) return null;
        const info = JSON.parse(raw);
        if (info && typeof info.url === "string" && info.url) return info;
        return null;
    } catch {
        return null;
    }
}

// Health-check detalhado: GET {url}/health. Vivo = 200 (healthy) OU 503 (degraded). Além do bool,
// captura `features` do body (ex.: { ingestion: bool }) — a superfície SOMENTE-LEITURA que o servidor
// (native-java ≥2.33.0) anuncia para o consumidor descobrir se a curadoria local está ligada e decidir
// se cura do próprio lado. Nunca lança.
export async function healthDetail(url, timeoutMs = 2000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(String(url).replace(/\/+$/, "") + "/health", { signal: ctrl.signal });
        if (res.status !== 200 && res.status !== 503) return { alive: false, features: null };
        let features = null;
        try {
            const body = await res.json();
            features = (body && typeof body === "object" && body.features) || null;
        } catch { /* body não-JSON → features null (servidor antigo) */ }
        return { alive: true, features };
    } catch {
        return { alive: false, features: null };
    } finally {
        clearTimeout(t);
    }
}

// Health-check simples (backward-compat): só o bool de vivo. Nunca lança.
export async function health(url, timeoutMs = 2000) {
    return (await healthDetail(url, timeoutMs)).alive;
}

// Resolvedor RICO da escada (etapa 0 configurada → registry local → none) com estado EXPLÍCITO, para o
// consentimento opt-in (Fase 3) distinguir "sem config" de "configurada mas fora do ar". Deps injetáveis.
// FAIL-LOUD: URL configurada INALCANÇÁVEL NÃO cai pro registry local (respeita a intenção de quem apontou
// um servidor — nunca troca em silêncio por outro). Nunca lança.
export async function resolveDaemon(opts = {}) {
    const _readConfig = opts._readConfig;                      // undefined → configuredDaemonUrl usa o default
    const _readRegistry = opts._readRegistry || readRegistry;
    const _health = opts._health || healthDetail;              // contrato: retorna bool (legado) OU {alive,features}
    const _env = opts._env || process.env;

    // Normaliza o retorno de _health (bool legado OU {alive,features}) → { alive, features }.
    const check = async (url, ms) => {
        const r = await _health(url, ms);
        if (r && typeof r === "object") return r;               // {alive,features} (healthDetail real)
        return { alive: !!r, features: null };                  // bool legado (testes/mocks antigos)
    };

    // etapa 0 — URL CONFIGURADA (env > config.json), já validada/normalizada.
    const configured = _readConfig ? configuredDaemonUrl(_env, _readConfig) : configuredDaemonUrl(_env);
    if (configured) {
        const hd = await check(configured, 5000);               // timeout maior p/ WAN/VPN
        if (hd.alive) return { info: { url: configured, source: "configured", features: hd.features }, source: "configured", configuredUrl: configured };
        return { info: null, source: "configured-unreachable", configuredUrl: configured };
    }

    // etapa 1 — registry local (auto-anúncio do daemon nesta máquina).
    const reg = _readRegistry();
    if (reg && reg.url) {
        const hd = await check(reg.url, 2000);
        if (hd.alive) return { info: { ...reg, source: "registry", features: hd.features }, source: "registry" };
        return { info: null, source: "registry-dead" };
    }

    // etapa 2 — nada configurado nem registrado.
    return { info: null, source: "none" };
}

// Cliente-puro: DaemonInfo | null (backward-compat p/ os consumidores existentes). Delega ao resolvedor.
export async function discover() {
    return (await resolveDaemon()).info;
}
