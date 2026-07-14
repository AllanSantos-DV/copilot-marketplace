// Discovery CLIENTE-PURO do daemon único de memória (native-java).
// Lê o registry auto-anunciado ~/.mcp-memory/run/daemon.json, faz health-check e reusa a URL.
// NUNCA sobe o JAR nem gerencia o daemon — isso é da infra do native-java (autostart de SO).
// Espelha DaemonRegistryPath.java:49-69, DaemonInfo.java:22-36 e HttpHealthChecker.java:36-43,
// mas só a parte read+health (sem spawn).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

// Health-check: GET {url}/health. Vivo = 200 (healthy) OU 503 (degraded). Nunca lança.
export async function health(url, timeoutMs = 2000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(String(url).replace(/\/+$/, "") + "/health", { signal: ctrl.signal });
        return res.status === 200 || res.status === 503;
    } catch {
        return false;
    } finally {
        clearTimeout(t);
    }
}

// Cliente-puro: lê registry → health → DaemonInfo | null. Sem spawn, sem efeitos colaterais.
export async function discover() {
    const info = readRegistry();
    if (!info) return null;
    const alive = await health(info.url);
    return alive ? info : null;
}
