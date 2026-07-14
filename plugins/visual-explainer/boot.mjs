// visual-explainer/boot.mjs — hook de SessionStart.
// Instala/atualiza o kit VXK em ~/.copilot/vxk e o agente em ~/.copilot/agents,
// de forma IDEMPOTENTE (stamp por versão). Self-contained, sem imports externos.
// Nunca lança (um hook não pode quebrar a sessão) e só escreve em stdout um
// "progress" quando instala/atualiza (gatilho de "reinicie o app").

import {
  existsSync, readFileSync, readdirSync, mkdirSync,
  copyFileSync, writeFileSync, appendFileSync,
} from "node:fs";
import { join, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VXK_VERSION = "0.1.0";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve ~/.copilot de forma portável. Em hook de plugin,
// COPILOT_PLUGIN_ROOT = ...\.copilot\installed-plugins\<mp>\<plugin>.
function resolveCopilotHome() {
  const r = process.env.COPILOT_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "";
  const marker = sep + "installed-plugins" + sep;
  const i = r.indexOf(marker);
  if (i > 0) return r.slice(0, i);
  if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
  return join(homedir(), ".copilot");
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

export function install(home) {
  const payload = join(__dirname, "payload");
  const dest = join(home, "vxk");
  const stamp = join(dest, ".vxk-install.json");

  let cur = null;
  if (existsSync(stamp)) { try { cur = JSON.parse(readFileSync(stamp, "utf8")); } catch { /* re-instala */ } }
  if (cur && cur.version === VXK_VERSION) return { installed: false, version: VXK_VERSION };

  // kit + templates + builder + README
  copyDir(join(payload, "kit"), join(dest, "kit"));
  copyDir(join(payload, "templates"), join(dest, "templates"));
  copyFileSync(join(payload, "build-artifact.mjs"), join(dest, "build-artifact.mjs"));
  if (existsSync(join(payload, "README.md"))) copyFileSync(join(payload, "README.md"), join(dest, "README.md"));
  mkdirSync(join(dest, "specs"), { recursive: true });

  // agente -> ~/.copilot/agents
  const agentsDir = join(home, "agents");
  mkdirSync(agentsDir, { recursive: true });
  copyFileSync(join(payload, "visual-explainer.agent.md"), join(agentsDir, "visual-explainer.agent.md"));

  writeFileSync(stamp, JSON.stringify({
    version: VXK_VERSION, installedAt: new Date().toISOString(), managedBy: "visual-explainer-plugin",
  }, null, 2));
  return { installed: true, version: VXK_VERSION };
}

export function runAsHook() {
  const home = resolveCopilotHome();
  let res = null, err = null;
  try { res = install(home); } catch (e) { err = String(e?.message || e); }
  try {
    const logDir = join(home, "vxk"); mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "boot.log"),
      JSON.stringify({ at: new Date().toISOString(), v: VXK_VERSION, installed: res?.installed ?? false, err }) + "\n");
  } catch { /* ignore */ }
  if (res && res.installed) {
    try {
      process.stdout.write(JSON.stringify({
        type: "progress",
        message: "🎨 visual-explainer: kit VXK v" + VXK_VERSION + " instalado em ~/.copilot/vxk e agente pronto. Reinicie o app uma vez para o agente aparecer no seletor.",
      }) + "\n");
    } catch { /* ignore */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAsHook();
