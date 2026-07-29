// PERFIL "modo-sombra" — contestação anti-bajulação em BACKGROUND. Reativo (não intervém no meio do
// raciocínio). Duas superfícies:
//   • onTurn(caps): chamado no boundary de turno (hook). NÃO bloqueia — surfaça um flag PENDENTE (de uma
//     consolidação async anterior) e, na cadência, dispara uma nova consolidação FIRE-AND-FORGET. Assim o
//     flag de drift aparece na fronteira segura seguinte (padrão "asynchronous flag", validado por pesquisa).
//   • handoff(sessionPlan, caps): no ponto de decisão, compara o PLANO da sessão × o dossiê de contestação
//     → veredito (aprova/corrige) + PRÉ-ADR. Alimenta o modo-adr (mais leve) → modo-dev (mais robusto).
// Custo alto (deep ON por padrão) → o toggle avisa ao ligar. FAIL LOUD no handoff; a consolidação de
// background é best-effort SINALIZADA (loga a falha, não derruba a sessão — é enriquecimento opcional).

import { cleanShadowTranscript, renderShadow } from "./shadowTranscript.mjs";
import { extractJson } from "../util/extractJson.mjs";

function parseJson(t) { return extractJson(t); }

// TOOL TEMPLATE do veredito de handoff do modo-sombra (Princípio 11) — schema imposto pelo SDK.
const HANDOFF_SCHEMA = {
  name: "submit_handoff",
  description: "O plano da sessão BATE com a direção correta do dossiê de contestação?",
  parameters: {
    type: "object",
    properties: {
      approve: { type: "boolean", description: "true se o plano bate com a direção correta e pode construir" },
      drift: { type: "string", enum: ["low", "medium", "high"] },
      corrections: { type: "array", items: { type: "string" }, description: "correções concretas a aplicar antes de construir (vazio se approve)" },
    },
    required: ["approve"],
  },
};

export function createModoSombra({ consolidator, log = () => {} } = {}) {
  if (!consolidator?.consolidate) throw new Error("createModoSombra: consolidator ausente");
  let dossier = null;      // último dossiê acumulado (Camada 1)
  let turnCount = 0;       // turnos desde a ativação
  let running = false;     // há consolidação async em andamento?
  let pendingFlag = null;  // flag de drift a surfaçar no próximo boundary (Camada 2)
  let lastRun = null;      // promessa da última consolidação (p/ flush/handoff/testes)

  function tailText(caps, tailTurns) {
    const events = caps.plan?.readEventsTail ? caps.plan.readEventsTail() : [];
    const turns = cleanShadowTranscript(events).slice(-tailTurns);
    return renderShadow(turns);
  }

  async function consolidateNow(caps, { tailTurns, deep, threshold, subject, vivo = false }) {
    const text = tailText(caps, tailTurns);
    if (!text) { log("[modo-sombra] sem transcript p/ consolidar"); return null; }
    const t0 = Date.now();
    const r = await consolidator.consolidate(text, caps, { deep, threshold, subject, vivo, turn: turnCount });
    const durationMs = Date.now() - t0;
    dossier = r.dossier;
    // F2: registra CADA consolidação como telemetria (shape único stage:"sombra-consolidation") — é o que
    // o injectionTracker usa p/ medir a trajetória de drift (aceitação da injeção). Best-effort SINALIZADO.
    // ATRIBUIÇÃO + DURAÇÃO (proposta 4 da auto-melhoria): sem `role` e `durationMs` este span era um MARCADOR
    // cego — dava pra ver o drift, mas NÃO dava pra medir quanto a consolidação custa, que é justamente o que o
    // gapDetector precisa pra apontar latência aqui. `vivo` distingue o caminho (mesa viva × efêmero).
    try {
      const sid = typeof caps.sessionId === "function" ? caps.sessionId() : caps.sessionId;
      caps.recordConsolidation?.({ sessionId: sid || null, role: "sombra-consolidador", durationMs, vivo: !!vivo, deep: !!deep, drift: r.drift, distance: r.distance ?? null, method: r.driftMethod || "?", injected: !!r.flag, flagId: r.gid || null, threshold });
    } catch (e) { log("[modo-sombra] recordConsolidation falhou (sinalizado, não derruba): " + (e?.message || e)); }
    return r;
  }

  return {
    id: "modo-sombra",
    reset() { dossier = null; turnCount = 0; running = false; pendingFlag = null; lastRun = null; log("[modo-sombra] estado resetado (ativação)"); },
    getDossier() { return dossier; },
    async flush() { if (lastRun) { try { await lastRun; } catch { /* já logado */ } } },

    /**
     * Boundary de turno (hook). NÃO bloqueia. Retorna um flag sugestivo se houver (senão null).
     * Consolida na 1ª chamada (cauda inicial) e a cada `everyTurns`. Consolidação = fire-and-forget.
     */
    onTurn(caps = {}, { tailTurns = 6, everyTurns = 4, deep = true, threshold = "high", subject = "" } = {}) {
      turnCount++;
      // EXPIRAÇÃO (Fase 6): findings ativos parados há turnos viram "expired" (não re-emitem, não contam como
      // resolvidos). Enforcement por CÓDIGO, não por disciplina do agente. Best-effort SINALIZADO.
      try { caps.findings?.expireStale?.(turnCount, { maxAgeTurns: 4 }); } catch (e) { log("[modo-sombra] expireStale falhou (sinalizado): " + (e?.message || e)); }
      const surfaced = pendingFlag; pendingFlag = null; // entrega o que ficou pronto desde o último boundary
      const due = turnCount === 1 || turnCount % everyTurns === 0;
      if (due && !running) {
        running = true;
        lastRun = consolidateNow(caps, { tailTurns, deep, threshold, subject })
          .then((r) => { if (r && r.flag) { pendingFlag = r.flag; log(`[modo-sombra] flag de drift PRONTO p/ próximo boundary (drift=${r.drift})`); } })
          .catch((e) => { log("[modo-sombra] consolidação de background falhou (sinalizada, não derruba a sessão): " + (e?.message || e)); })
          .finally(() => { running = false; });
      }
      return surfaced;
    },

    /**
     * HANDOFF / PRÉ-ADR: compara o PLANO da sessão × o dossiê de contestação → veredito + pré-ADR.
     * FAIL LOUD (é o momento crítico — não pode mascarar). Consolida a cauda atual antes de comparar.
     * @returns {{ ok:true, approve:boolean, drift:string, corrections:string[], preAdr:string, dossier:object }}
     */
    async handoff(sessionPlan, caps = {}, { tailTurns = 8, deep = true, threshold = "high" } = {}) {
      const plan = String(sessionPlan || "").trim();
      if (!plan) throw new Error("modo-sombra.handoff: plano da sessão vazio");
      if (!caps.factory?.run) throw new Error("modo-sombra.handoff: caps.factory ausente");
      await this.flush(); // não corre com uma consolidação de background em andamento
      // vivo:true — no handoff (FOCAL, o usuário espera o pré-ADR) a contestação roda como MESA VIVA
      // (questionador → advogado-diabo → âncora se veem turno a turno). O onTurn de background segue LEVE.
      const r = await consolidateNow(caps, { tailTurns, deep, threshold, subject: plan.slice(0, 200), vivo: true });
      if (!r) throw new Error("modo-sombra.handoff: sem transcript/dossiê para contestar o plano");

      // 1) VEREDITO: a âncora-realidade compara o plano da sessão com o dossiê independente.
      // TOOL TEMPLATE (Princípio 11): o veredito vem de submit_handoff (schema imposto pelo SDK).
      const vOut = await caps.factory.run("ancora-realidade",
        `PLANO DA SESSÃO (a validar):\n${plan}\n\nDOSSIÊ DE CONTESTAÇÃO (independente):\n` +
        `entendimento: ${r.dossier.understanding}\ndireção correta: ${r.dossier.direction}\n` +
        `perguntas críticas: ${r.dossier.questions.join(" | ")}\nriscos: ${r.dossier.flags.join(" | ")}\n` +
        `já existe (local): ${r.dossier.local || "(n/d)"}\njá existe (mercado): ${r.dossier.research || "(n/d)"}\n\n` +
        `O plano da sessão BATE com a direção correta? CHAME a ferramenta submit_handoff. NÃO responda em texto.`,
        { subject: "ancora-realidade", timeoutMs: 120000, stage: "sombra", schema: HANDOFF_SCHEMA, availableTools: [] });
      if (!vOut.ok || !vOut.text) throw new Error("modo-sombra.handoff: veredito falhou: " + (vOut.error || "sem texto"));
      const vj = parseJson(vOut.text);
      if (!vj || vj.__nosubmit__ || typeof vj.approve !== "boolean") throw new Error("modo-sombra.handoff: veredito nao submeteu {approve}: " + String(vOut.text).slice(0, 200));

      // 2) PRÉ-ADR: o documentador escreve o pré-ADR consolidando direção + correções (base p/ o modo-adr).
      const corrections = Array.isArray(vj.corrections) ? vj.corrections.map(String) : [];
      const dOut = await caps.factory.run("documentacao",
        `Escreva um PRÉ-ADR curto em markdown (base para o planejamento), consolidando:\n` +
        `DIREÇÃO CORRETA:\n${r.dossier.direction}\n\nENTENDIMENTO:\n${r.dossier.understanding}\n\n` +
        `PERGUNTAS RESPONDIDAS/EM ABERTO:\n- ${r.dossier.questions.join("\n- ")}\n\nCORREÇÕES A APLICAR:\n- ${corrections.join("\n- ") || "(nenhuma)"}\n\n` +
        `REUSO (já existe):\nlocal: ${r.dossier.local || "(n/d)"}\nmercado: ${r.dossier.research || "(n/d)"}\n\nComece direto pelo pré-ADR.`,
        { subject: "documentacao", timeoutMs: 120000 });
      if (!dOut.ok || !dOut.text) throw new Error("modo-sombra.handoff: pré-ADR (documentador) falhou: " + (dOut.error || "sem texto"));

      log(`[modo-sombra] handoff: approve=${vj.approve}, drift=${vj.drift}, ${corrections.length} correção(ões)`);
      return { ok: true, approve: !!vj.approve, drift: String(vj.drift || r.drift), corrections, preAdr: dOut.text, dossier: r.dossier };
    },
  };
}
