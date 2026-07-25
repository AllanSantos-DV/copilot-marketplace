// Estado do TOGGLE por SESSÃO (ON/OFF). Persiste em ~/.copilot-modo-auto/<sessionId>[.<key>].json para
// sobreviver a reload da extensão. Default OFF (inerte). Isolado por sessão — ligar aqui NÃO afeta
// as outras sessões da máquina. `key` namespaceia flags independentes (ex.: toggle principal vs deepMode).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".copilot-modo-auto");
const fileFor = (sid, key) => join(DIR, `${(sid && String(sid).trim()) || "default"}${key ? "." + key : ""}.json`);

export function createToggleState(sessionId, { key = null } = {}) {
  let sid = sessionId;
  let on = false;
  const load = () => {
    try {
      const f = fileFor(sid, key);
      on = existsSync(f) ? !!JSON.parse(readFileSync(f, "utf8")).on : false;
    } catch (e) { on = false; console.error("[modo-auto] toggle-state corrompido (NÃO mascarado; default OFF): " + (e?.message || e)); }
  };
  load();

  const persist = () => {
    try {
      if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
      writeFileSync(fileFor(sid, key), JSON.stringify({ on, ts: Date.now() }));
    } catch { /* best-effort */ }
  };

  return {
    get() { return on; },
    set(v) { on = !!v; persist(); return on; },
    toggle() { return this.set(!on); },
    // Re-chaveia pela sessionId REAL do host (pós-join). Re-lê o estado persistido DESTA sessão →
    // sem vazamento entre sessões (o fallback env/"default" era compartilhado). No-op se sid não muda.
    rekey(newSessionId) {
      const next = (newSessionId && String(newSessionId).trim()) || "";
      if (!next || next === sid) return on;
      sid = next;
      load();
      return on;
    },
    sessionId() { return sid; },
  };
}
