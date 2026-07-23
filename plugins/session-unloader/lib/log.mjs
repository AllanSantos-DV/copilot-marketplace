// log.mjs — log append-only JSON-line em ~/.copilot/logs/unloader.log. Nunca lança.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

export function logLine(obj) {
  try {
    const dir = join(resolveCopilotHome(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "unloader.log"), JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch { /* nunca derruba o hook */ }
}
