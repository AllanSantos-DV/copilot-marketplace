// visual-explainer/vxk-launch.mjs — lançador do servidor MCP vxk (declarado no .mcp.json do plugin).
// Não carrega o motor: lê o PONTEIRO que o motor publica (~/.vxk/cli.json, contrato do engine-registry)
// e repassa o stdio para `node <mcp>`. Sem ponteiro (1º uso, antes do boot), instala pelo engine-kit
// vendorizado e usa o binário que ele devolve. Falha alto (stderr + exit 1) — nunca um MCP mudo.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const die = (m) => { process.stderr.write("vxk-launch: " + m + "\n"); process.exit(1); };

async function mcpPath() {
  const ptr = join(process.env.VXK_HOME || join(homedir(), ".vxk"), "cli.json");
  try { const p = JSON.parse(readFileSync(ptr, "utf8")); if (p.mcp && existsSync(p.mcp)) return p.mcp; } catch { /* sem ponteiro ainda */ }
  const kit = await import(pathToFileURL(join(here, "engine-kit", "index.mjs")).href);
  const r = await kit.ensureEngine("vxk", { allowNetwork: true, log: (m) => process.stderr.write(m + "\n") });
  if (!r.available || !r.bin || !existsSync(r.bin)) die("motor vxk indisponível: " + (r.reason || "binário não encontrado"));
  return r.bin;
}

const mcp = await mcpPath();
const child = spawn(process.execPath, [mcp], { stdio: "inherit", windowsHide: true });
child.on("error", (e) => die("não consegui iniciar o servidor: " + e.message));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
