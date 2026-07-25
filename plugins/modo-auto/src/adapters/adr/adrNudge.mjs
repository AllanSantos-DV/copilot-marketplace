// Nudge do modo-adr — injeta uma DIRETRIZ LEVE (ponteiro pra skill `adr` / tool `modo_adr`) no
// SessionStart e, THROTTLED, no prompt-submit (anti-repeat: não re-dispara se disparou nos últimos N
// turnos). É a rede de segurança contra a COMPACTAÇÃO (quando o SessionStart não re-dispara). A
// diretriz é LEVE de propósito — injeção pesada/repetida polui o foco do agente (visto no voice-chat).
// Estado (contador de turno + último disparo) persistido por sessão.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".modo-auto", "adr-nudge");
const DIRECTIVE =
  "Diretriz (modo-adr): para QUALQUER tarefa que precise de PLANO — implementação, refatoração, fix, " +
  "detalhamento, incremento — monte o plano ANTES de construir, pela mesa de ADR: use a skill `adr` e a " +
  "tool `modo_adr` (briefing → mesa → plano vivo em fases). Tarefas triviais não precisam.";

export function createAdrNudge({ sessionId = "", throttleTurns = 8, log = () => {} } = {}) {
  let sid = sessionId;
  let file = join(DIR, `${(sid && String(sid).trim()) || "default"}.json`);
  let st = { turn: 0, lastFired: -999 };
  const load = () => {
    st = { turn: 0, lastFired: -999 };
    try { if (existsSync(file)) st = { ...st, ...JSON.parse(readFileSync(file, "utf8")) }; } catch (e) { console.error("[modo-auto] adr-nudge state corrompido (NÃO mascarado; reset): " + (e?.message || e)); }
  };
  load();
  const persist = () => { try { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); writeFileSync(file, JSON.stringify(st)); } catch { /* best-effort */ } };

  return {
    directive: () => DIRECTIVE,

    // Re-chaveia pela sessionId REAL do host (pós-join) — evita compartilhar o estado "default" entre sessões.
    rekey(newSessionId) {
      const next = (newSessionId && String(newSessionId).trim()) || "";
      if (!next || next === sid) return;
      sid = next;
      file = join(DIR, `${sid}.json`);
      load();
    },

    // SessionStart: sempre injeta (e marca o turno atual como o último disparo).
    onStart() { st.lastFired = st.turn; persist(); log("adr-nudge: SessionStart"); return DIRECTIVE; },

    // prompt-submit: conta o turno; só re-injeta se passou o throttle desde o último disparo.
    onPrompt() {
      st.turn += 1;
      if (st.turn - st.lastFired >= throttleTurns) { st.lastFired = st.turn; persist(); log(`adr-nudge: re-injeta (turno ${st.turn})`); return DIRECTIVE; }
      persist();
      return null;
    },
  };
}
