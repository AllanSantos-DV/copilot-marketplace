// visual-explainer/boot.mjs — SessionStart (via neural-link). Cliente FINO do motor vxk:
//   1. garante o motor vxk instalado/atualizado em ~/.vxk pelo engine-kit (vendorizado em ./engine-kit:
//      resolve no engine-registry → download com SHA-256 + assinatura Ed25519, fail-closed);
//   2. instala o agente desenhista em ~/.copilot/agents (stamp por versão).
// O servidor MCP em si é declarado no .mcp.json do plugin (lançado por vxk-launch.mjs).
// Nunca lança (um hook não pode quebrar a sessão); falha vai para o log e para o progresso.
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VXK_VERSION = "0.6.0";
const __dirname = dirname(fileURLToPath(import.meta.url));

// ~/.copilot de forma portável: em hook de plugin, COPILOT_PLUGIN_ROOT = ...\.copilot\installed-plugins\<mp>\<plugin>
function resolveCopilotHome() {
  const r = process.env.COPILOT_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "";
  const marker = sep + "installed-plugins" + sep;
  const i = r.indexOf(marker);
  if (i > 0) return r.slice(0, i);
  if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
  return join(homedir(), ".copilot");
}

function installAgent(home) {
  const stampFile = join(home, "agents", ".visual-explainer.json");
  let cur = null; try { cur = JSON.parse(readFileSync(stampFile, "utf8")); } catch { /* 1ª vez */ }
  if (cur && cur.version === VXK_VERSION) return false;
  mkdirSync(join(home, "agents"), { recursive: true });
  copyFileSync(join(__dirname, "visual-explainer.agent.md"), join(home, "agents", "visual-explainer.agent.md"));
  writeFileSync(stampFile, JSON.stringify({ version: VXK_VERSION, installedAt: new Date().toISOString(), managedBy: "visual-explainer-plugin" }, null, 2));
  return true;
}

/**
 * Garante o motor vxk instalado/atualizado em ~/.vxk pelo engine-kit vendorizado (SHA-256 + assinatura Ed25519).
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<{available:boolean, bin?:string, reason?:string}>}
 */
export async function ensureVxk(log = () => {}) {
  const kit = await import(pathToFileURL(join(__dirname, "engine-kit", "index.mjs")).href);
  return kit.ensureEngine("vxk", { allowNetwork: true, log });
}

/**
 * Hook de SessionStart: instala o agente (stamp por versão), garante o motor e emite um "progress" quando algo mudou. Nunca lança.
 * @returns {Promise<void>}
 */
export async function runAsHook() {
  const home = resolveCopilotHome();
  const out = { at: new Date().toISOString(), v: VXK_VERSION, agent: false, engine: null, err: null };
  try { out.agent = installAgent(home); } catch (e) { out.err = "agente: " + (e?.message || e); }
  try {
    const r = await ensureVxk();
    out.engine = r.available ? { bin: r.bin } : { unavailable: r.reason };
  } catch (e) { out.err = (out.err ? out.err + " | " : "") + "motor: " + (e?.message || e); }
  try { mkdirSync(join(home, "vxk"), { recursive: true }); appendFileSync(join(home, "vxk", "boot.log"), JSON.stringify(out) + "\n"); } catch { /* ignore */ }
  const msg = out.engine && out.engine.unavailable
    ? "⚠ visual-explainer: motor vxk indisponível (" + out.engine.unavailable + ") — o MCP vxk não vai responder até instalar."
    : out.agent ? "🎨 visual-explainer v" + VXK_VERSION + ": motor vxk (MCP) pronto e agente atualizado. Reinicie o app uma vez para o agente aparecer no seletor." : null;
  if (msg) { try { process.stdout.write(JSON.stringify({ type: "progress", message: msg }) + "\n"); } catch { /* ignore */ } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAsHook();
