// home.mjs — resolve a raiz do Copilot (~/.copilot) a partir do ambiente do plugin ou do home do usuário.
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveCopilotHome() {
  const r = process.env.COPILOT_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "";
  const marker = "\\installed-plugins\\";
  const i = r.indexOf(marker);
  if (i > 0) return r.slice(0, i);
  if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
  return join(homedir(), ".copilot");
}
