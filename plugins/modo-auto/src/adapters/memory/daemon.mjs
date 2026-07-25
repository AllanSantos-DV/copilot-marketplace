// Discovery CLIENTE-PURO do daemon de memória (native-java) — versão SLIM vendada no modo-auto.
// Lê ~/.mcp-memory/run/daemon.json, health-check, reusa a URL. NUNCA sobe o JAR. Fiel a
// copilot-memory/lib/daemon.mjs (mesmo contrato do servidor).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveRunDir() {
  const env = process.env.MCP_RUN_DIR;
  return env && env.trim() ? env.trim() : join(homedir(), ".mcp-memory", "run");
}

export function readRegistry(runDir = resolveRunDir()) {
  try {
    const raw = readFileSync(join(runDir, "daemon.json"), "utf8");
    if (!raw || !raw.trim()) return null;
    const info = JSON.parse(raw);
    return info && typeof info.url === "string" && info.url ? info : null;
  } catch { return null; }
}

export async function health(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(String(url).replace(/\/+$/, "") + "/health", { signal: ctrl.signal });
    return res.status === 200 || res.status === 503;
  } catch { return false; } finally { clearTimeout(t); }
}

export async function discover() {
  const info = readRegistry();
  if (!info) return null;
  return (await health(info.url)) ? info : null;
}
