// PlanPort — lê o "plano vivo" da sessão a partir do workspaceDir (session.workspacePath):
//   plan.md (o plano), checkpoints/ (saída curada) e events.jsonl (transcript → limpo).
// Fallback DE DADO (não de erro): sem plan.md → usa o transcript limpo. events.jsonl pode ter centenas
// de MB → lê só a CAUDA (tail) até maxBytes. FAIL LOUD: erro de leitura/escrita SOBE; só a AUSÊNCIA
// (arquivo inexistente) vira vazio/null.

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanTranscript, renderTurns } from "./transcript.mjs";

// REGISTRO dos arquivos de plano da sessão. Ordem = precedência (o 1º é o plano "principal" da sessão).
// Adicionar um plano novo AQUI faz o modo-sombra passar a validá-lo automaticamente (sem descasamento).
export const PLAN_FILES = Object.freeze([
  { file: "plan.md", kind: "session", label: "PLANO DA SESSÃO (o agente edita)" },
  { file: "adr-plan.md", kind: "adr", label: "PLANO DO ADR (escrito pela mesa; o agente incorpora ao dele)" },
]);

/**
 * @param {{ sessionProvider?: ()=>({workspacePath?:string}|null), workspaceDir?: string, log?: (m:string)=>void }} [opts]
 * @returns {import("../../core/ports.mjs").PlanPort}
 */
export function createPlanPort({ sessionProvider = () => null, workspaceDir = null, log = () => {} } = {}) {
  const dir = () => workspaceDir || sessionProvider()?.workspacePath || null;

  function readTail(file, maxBytes) {
    const size = statSync(file).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      let text = buf.toString("utf8");
      if (start > 0) { const nl = text.indexOf("\n"); if (nl >= 0) text = text.slice(nl + 1); } // descarta linha parcial
      return text;
    } finally { closeSync(fd); }
  }

  return {
    dir,

    hasPlan() { const d = dir(); return !!(d && existsSync(join(d, "plan.md"))); },

    // Leitura do plano: ausente → null (legítimo); erro de leitura (permissão etc.) → LANÇA (fail loud).
    readPlan() {
      const d = dir(); if (!d) return null;
      const f = join(d, "plan.md");
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },

    // Escreve/atualiza o plano vivo (plan.md). FAIL LOUD: erro de escrita/sem dir → LANÇA (não mascara).
    // ESTE é o plano DA SESSÃO (o agente edita, o modo-sombra lê, o canvas mostra). A mesa de ADR NÃO usa —
    // ela grava em adr-plan.md (writeAdrPlan). Assim a mesa nunca sobrescreve o plano do agente.
    writePlan(text) {
      const d = dir(); if (!d) throw new Error("planPort.writePlan: sem workspaceDir/sessão ativa");
      const f = join(d, "plan.md");
      writeFileSync(f, String(text ?? ""), "utf8");
      return f;
    },

    // ── Plano PRÓPRIO do modo_adr, ISOLADO do plan.md da sessão ───────────────────────────────────────
    // A mesa de ADR grava o plano dela em adr-plan.md (arquivo SEPARADO). O agente LÊ e INCREMENTA o SEU
    // plan.md como quiser — a mesa NUNCA toca no plan.md (que o agente edita e o sombra lê). Corrige o bug
    // de a mesa ADR sobrescrever o plano vivo da sessão.
    hasAdrPlan() { const d = dir(); return !!(d && existsSync(join(d, "adr-plan.md"))); },

    // Ausente → null (legítimo, ainda não rodou ADR); erro de leitura → LANÇA (fail loud).
    readAdrPlan() {
      const d = dir(); if (!d) return null;
      const f = join(d, "adr-plan.md");
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },

    // Escreve o plano do ADR (adr-plan.md) — NUNCA plan.md. FAIL LOUD: sem dir / erro de escrita → LANÇA.
    writeAdrPlan(text) {
      const d = dir(); if (!d) throw new Error("planPort.writeAdrPlan: sem workspaceDir/sessão ativa");
      const f = join(d, "adr-plan.md");
      writeFileSync(f, String(text ?? ""), "utf8");
      return f;
    },

    // TODOS os planos da sessão, como ARRAY (o modo-sombra confere o código contra o PLANO — se ele só olha o
    // plan.md e a mesa de ADR escreveu noutro arquivo, ele audita contra um plano INCOMPLETO e acusa divergência
    // falsa: o DESCASAMENTO que a separação plan.md × adr-plan.md introduziu). Cada item traz `kind` (session|adr),
    // o texto e o mtime — o mtime permite detectar "o plano do ADR é MAIS NOVO que o da sessão" (= o agente ainda
    // não incorporou). Ausente → não entra na lista; erro de leitura → LANÇA (fail loud).
    readPlans() {
      const d = dir(); if (!d) return [];
      const out = [];
      for (const { file, kind, label } of PLAN_FILES) {
        const f = join(d, file);
        if (!existsSync(f)) continue;
        out.push({ source: file, path: file, kind, label, text: readFileSync(f, "utf8"), mtimeMs: statSync(f).mtimeMs });
      }
      return out;
    },

    // Dir de checkpoints ausente → [] (legítimo); erro de leitura do dir → LANÇA.
    listCheckpoints() {
      const d = dir(); if (!d) return [];
      const c = join(d, "checkpoints");
      return existsSync(c) ? readdirSync(c).sort() : [];
    },

    // events.jsonl ausente → [] (legítimo); erro de leitura do arquivo → LANÇA. Linha JSON inválida é
    // pulada (tolerância de dado num log em streaming, não mascaramento de erro).
    readTranscriptTurns({ maxBytes = 4 * 1024 * 1024, maxTurns = 40 } = {}) {
      return cleanTranscript(this.readEventsTail({ maxBytes })).slice(-maxTurns);
    },

    // Eventos CRUS da cauda do events.jsonl (p/ filtros específicos, ex.: o do modo-sombra). Ausente → [];
    // erro de leitura → LANÇA. Linha inválida (parcial do log em streaming) é pulada (dado, não erro).
    readEventsTail({ maxBytes = 4 * 1024 * 1024 } = {}) {
      const d = dir(); if (!d) return [];
      const f = join(d, "events.jsonl"); if (!existsSync(f)) return [];
      const events = [];
      for (const line of readTail(f, maxBytes).split("\n")) {
        const s = line.trim(); if (!s) continue;
        try { events.push(JSON.parse(s)); } catch { /* linha parcial/inválida do log — dado, não erro */ }
      }
      return events;
    },

    // "Plano vivo": plan.md se existir; senão o transcript limpo.
    read() {
      const plan = this.readPlan();
      if (plan) return { source: "plan.md", text: plan, checkpoints: this.listCheckpoints().length };
      const turns = this.readTranscriptTurns();
      return { source: "transcript", text: renderTurns(turns), turns: turns.length };
    },
  };
}
