// throttle.mjs — cadência do scan no UserPromptSubmit: evita varrer a cada prompt. Guarda o timestamp
// do último scan em ~/.copilot/session-state/.unloader-meta.json; só libera quando passou throttleMs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

const metaPath = (home) => join(home, "session-state", ".unloader-meta.json");

export function shouldScan(home = resolveCopilotHome(), throttleMs = 3600000, now = Date.now()) {
  try {
    const m = JSON.parse(readFileSync(metaPath(home), "utf8"));
    if (m.lastScan && (now - m.lastScan) < throttleMs) return false;
  } catch { /* sem meta = pode varrer */ }
  return true;
}

export function markScan(home = resolveCopilotHome(), now = Date.now()) {
  try {
    const p = metaPath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ lastScan: now }));
  } catch { /* best-effort */ }
}
