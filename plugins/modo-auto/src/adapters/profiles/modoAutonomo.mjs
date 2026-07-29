// ADAPTER de PERFIL — "modo-autonomo" (modo-auto / continuidade). Governa a sessão em 2 gatilhos:
//   • onQuestion: ENTENDIMENTO DE VALIDADE — a pergunta JÁ está respondida no PLANO/ADR/memória? Se sim,
//     responde direto (não gasta a mesa nem incomoda o humano); se é decisão nova, delibera na MESA VIVA
//     (debate round-robin turno a turno) quando disponível — senão a mesa fan-out legado.
//   • onStop: valida se o PARAR é válido (a tarefa terminou conforme o plano). MODO PROFUNDO opcional
//     (painel multi-família) quando o deep está ligado — senão revisor único. FAIL LOUD em toda falha real.
// Contrato: ProfilePort (ver src/core/ports.mjs).

import { getRole } from "../agents/roles.mjs";
import { extractJson } from "../util/extractJson.mjs";

function parseJson(t) { return extractJson(t); }

// TOOL TEMPLATE do veredito de Stop (Princípio 11) — schema imposto pelo SDK, resultado determinístico.
const STOP_REVIEW_SCHEMA = {
  name: "submit_review",
  description: "Envie o veredito final: a tarefa terminou DE VERDADE conforme o plano?",
  parameters: {
    type: "object",
    properties: {
      done: { type: "boolean", description: "true se a tarefa terminou de verdade conforme o plano; false se ainda falta" },
      continuation: { type: "string", description: "se NÃO terminou, os próximos passos concretos a executar; se terminou, vazio" },
    },
    required: ["done"],
  },
};

// TOOL TEMPLATE do validador (Princípio 11).
const VALIDATOR_SCHEMA = {
    name: "submit_validation",
    description: "A pergunta da sessão JÁ está respondida pelo plano/ADR/memória, ou exige nova deliberação?",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["answered", "deliberate"], description: "answered se o plano/memória REALMENTE responde; deliberate se exige decisão nova não coberta" },
        answer: { type: "string", description: "se answered, a resposta objetiva tirada do plano/memória (sem inventar); senão vazio" },
        reason: { type: "string", description: "curto" },
      },
      required: ["status"],
    },
};

// Mesa VIVA enxuta do modo-auto: propõe (técnico) → contesta (advogado-diabo) → sintetiza (facilitador).
const ALTO_ORDER = ["tecnico", "advogado-diabo", "facilitador"];

export function createModoAutonomo({ log = () => {} } = {}) {
  // Delibera uma PERGUNTA na mesa VIVA e devolve a RESPOSTA consolidada (não um viés único).
  async function deliberarVivo(q, ctx, caps) {
    const agents = ALTO_ORDER.map((id) => {
      const r = getRole(id);
      if (!r?.system) throw new Error("modo-auto vivo: papel sem system: " + id);
      const model = caps.router ? caps.router.route({ role: id, taskType: "reasoning" }).model : undefined;
      return { role: id, system: r.system, model };
    });
    const subject = `PERGUNTA DA SESSÃO:\n${q}\n\nCONTEXTO (plano/ADR + memória):\n${ctx || "(sem contexto)"}`;
    const writeDoc = async ({ transcript, synthesis }) => {
      const r = await caps.factory.run("facilitador",
        `PERGUNTA ORIGINAL:\n${q}\n\nSÍNTESE:\n${synthesis || "(sem síntese)"}\n\nDELIBERAÇÃO DA MESA (todas as voltas):\n${transcript}\n\n` +
        `Escreva a RESPOSTA FINAL à pergunta, consolidando a DELIBERAÇÃO acima (não um viés). Direta e acionável.`,
        { timeoutMs: 90000, stage: "alto" }); // 90s (era 120s): cabe na janela de 300s do ask-bridge
      if (!r.ok || !r.text) throw new Error("modo-auto vivo: resposta final falhou: " + (r.error || "sem texto"));
      return r.text;
    };
    // ORÇAMENTO DE TEMPO DO ask_user (medido 2026-07-28): o dono do ask-bridge corta o respondedor em
    // mesaAnswerTimeoutMs (300s). Com 2-3 voltas × N agentes vivos + consolidação de 120s a mesa ESTOUROU essa
    // janela ("timeout:300000" no log do dono) e a pergunta caía no humano — a sessão congelava, que é o oposto
    // do propósito. Aqui o caminho da PERGUNTA usa 1-2 voltas (o ADR/plano, que não tem essa janela, segue com a
    // mesa completa). TRADE-OFF CONSCIENTE E SINALIZADO: menos deliberação, mas resposta ENTREGUE — uma pergunta
    // não respondida vale ZERO e ainda trava o dono. A convergência por embedder pode encerrar já na 1ª volta.
    const res = await caps.liveMesa.run(subject, { agents, writeDoc, minRounds: 1, maxRounds: 2, facilitatorRole: "facilitador", embedder: caps.embedder, timeoutMs: 90000 });
    log(`[modo-autonomo] mesa VIVA: ${res.rounds} voltas, convergiu=${res.converged}`);
    return res.document;
  }

  return {
    id: "modo-autonomo",

    // onQuestion: 1) VALIDADE (já respondida pelo plano/ADR/memória?) → responde direto; 2) senão, MESA.
    // FAIL LOUD — sem fallback stub: validador/mesa que falham SOBEM (não viram resposta fake).
    async onQuestion(request, caps = {}) {
      const q = request?.question ?? "";
      log(`[modo-autonomo] pergunta recebida: ${q}`);
      if (!caps.factory?.run) throw new Error("modo-autonomo.onQuestion: caps.factory ausente (config invalida)");
      if (!caps.mesa?.deliberate && !caps.liveMesa?.run) throw new Error("modo-autonomo.onQuestion: nenhuma mesa disponível (caps.mesa.deliberate ou caps.liveMesa.run)");

      // 1) ENTENDIMENTO DE VALIDADE — a pergunta já está coberta pelo PLANO/ADR ou pela MEMÓRIA?
      const planText = caps.plan?.read ? String((await caps.plan.read())?.text || "").slice(0, 4000) : "";
      let memText = "";
      const m = caps.memory?.recall ? await caps.memory.recall(q, { topK: 3 }) : null;
      if (m && m.ok) memText = (m.results || []).map((r) => "- " + String(r.text || "").slice(0, 200)).join("\n");
      else if (m && m.ok === false && m.error) log(`[modo-autonomo] memória indisponível (${m.error}) — segue`);
      const u = await caps.factory.run("validador",
        `PERGUNTA DA SESSÃO:\n${q}\n\nPLANO VIVO / ADR:\n${planText || "(sem plano)"}\n\nMEMÓRIA DO PROJETO:\n${memText || "(sem memória)"}\n\nChame a ferramenta submit_validation com o veredito. NÃO responda em texto.`,
        { timeoutMs: 60000, schema: VALIDATOR_SCHEMA, availableTools: [] });
      if (!u.ok) throw new Error("modo-autonomo.onQuestion: validador falhou: " + (u.error || "sem texto"));
      const j = parseJson(u.text) || {};
      // schema-enforced. Se o validador não submeteu status válido, DEGRADA p/ deliberate (mesa) — o caminho
      // seguro (a mesa resolve), nunca crash (antes: throw derrubava o onQuestion).
      if (j.__nosubmit__ || (j.status !== "answered" && j.status !== "deliberate")) log("[modo-autonomo] validador não submeteu status válido → deliberate (mesa)");
      if (j.status === "answered" && j.answer) {
        log("[modo-autonomo] pergunta JÁ respondida pelo plano/ADR — respondendo sem mesa");
        return { answer: String(j.answer), wasFreeform: true };
      }

      // 2) decisão genuína → a MESA delibera. VIVA (debate round-robin) quando disponível; senão fan-out legado.
      if (caps.liveMesa?.run) {
        const answer = await deliberarVivo(q, `${planText}\n${memText}`.trim(), caps); // erro SOBE (fail loud)
        if (!answer) throw new Error("modo-autonomo.onQuestion: a mesa viva nao produziu resposta para: " + q);
        return { answer: String(answer), wasFreeform: true };
      }
      const r = await caps.mesa.deliberate(q, caps); // erro da mesa SOBE (não vira resposta fake)
      if (!r || !r.answer) throw new Error("modo-autonomo.onQuestion: a mesa nao produziu resposta para: " + q);
      log(`[modo-autonomo] mesa respondeu (${r.roles?.length || 0} papeis, convergiu=${r.converged})`);
      return { answer: r.answer, wasFreeform: true };
    },

    // onStop: o PARAR é válido? Compara ENTREGUE × PLANO. MODO PROFUNDO (painel multi-família) quando o deep
    // está ligado — senão revisor único. FAIL LOUD — sem fail-safe: se a revisão falha, o erro SOBE (nunca
    // finge "done", que seria o OPOSTO do objetivo).
    async onStop(caps = {}) {
      if (!caps.factory?.run) throw new Error("modo-autonomo.onStop: caps.factory ausente");
      const planInfo = caps.plan?.read ? await caps.plan.read() : null;
      const turns = caps.plan?.readTranscriptTurns ? await caps.plan.readTranscriptTurns({ maxTurns: 12 }) : [];
      const delivered = turns.map((t) => `## ${String(t.role).toUpperCase()}\n${t.text}`).join("\n\n").slice(-6000);
      const planText = String(planInfo?.text || "").slice(0, 6000);
      if (!planText && !delivered) throw new Error("modo-autonomo.onStop: sem plano vivo nem historico para revisar");
      let material = `PLANO VIVO:\n${planText || "(sem plano)"}\n\nO QUE FOI FEITO (turnos recentes):\n${delivered || "(sem histórico)"}`;

      // COOPERAÇÃO com o modo-sombra (quando ligado): REUSA o DOSSIÊ de contestação JÁ consolidado (getDossier
      // = cache, SEM custo de LLM — o sombra já fez o trabalho a cada N turnos) como INPUT INDEPENDENTE do stop.
      // Perguntas críticas em aberto / riscos que o sombra levantou podem significar "ainda NÃO terminou". Pode
      // estar algumas voltas atrasado — SINALIZADO no material. Ausente (sombra off) → nada muda (retrocompat).
      const dossie = caps.sombraDossier?.();
      if (dossie && (dossie.direction || (dossie.questions || []).length || (dossie.flags || []).length)) {
        material += `\n\nCONTESTAÇÃO INDEPENDENTE DO MODO-SOMBRA (pode estar algumas voltas atrasada — se as perguntas/riscos em aberto NÃO foram resolvidos, provavelmente AINDA não terminou):\n` +
          `direção correta: ${dossie.direction || "(n/d)"}\n` +
          `perguntas críticas em aberto: ${(dossie.questions || []).join(" | ") || "(nenhuma)"}\n` +
          `riscos apontados: ${(dossie.flags || []).join(" | ") || "(nenhum)"}`;
        log("[modo-autonomo] onStop: reusando o dossiê do modo-sombra (cooperação, cache — sem custo de LLM)");
      }

      // MODO PROFUNDO (opt-in): consenso multi-família sobre "terminou DE VERDADE?". Degrada sinalizado.
      if (caps.deepEnabled?.() && caps.deep?.review && caps.router) {
        const dp = await caps.deep.review({ material, critiquePrompt: `Verifique CRITICAMENTE se a tarefa terminou DE VERDADE conforme o plano — o que AINDA FALTA? Liste concreto.\n\n${material}`, router: caps.router });
        if (dp.ok) {
          const done = dp.verdict.pass;
          log(`[modo-autonomo] stop review PROFUNDO (painel ${dp.families.join("+")}) → done=${done}`);
          return { done, continuation: done ? null : (dp.verdict.findings.join("; ") || "Continue: ha itens do plano pendentes.") };
        }
        log(`[modo-autonomo] deep indisponível (${dp.reason}) → revisor único`);
      }

      // revisor VIVO (COM ferramentas): decide se a tarefa terminou conforme o plano. Controle por ATIVIDADE —
      // enquanto ele trabalha (emite eventos) o watchdog NÃO o mata; só corta no silêncio REAL. idle-grace
      // generoso p/ dar espaço a modelos que raciocinam calados. A checagem profunda é o painel acima (opt-in).
      // TOOL TEMPLATE (Princípio 11): o veredito vem de submit_review (schema imposto pelo SDK), NÃO de "responda
      // SOMENTE JSON" + parse de prosa — que quebrava quando o modelo respondia em texto ('The task is done...').
      const r = await caps.factory.run("revisor",
        `${material}\n\nInvestigue com suas ferramentas se precisar e então CHAME a ferramenta submit_review com o veredito. NÃO responda em texto.`,
        { timeoutMs: 240000, schema: STOP_REVIEW_SCHEMA });
      if (!r.ok) {
        // SILÊNCIO real (idle/zumbi/parede) não é bug de código — é timeout OPERACIONAL: degrada SINALIZADO
        // (libera o stop) sem spammar "corrija!". Erro REAL (spawn/exit) segue FAIL LOUD (visível pra corrigir).
        if (/hung:|zombie:|hardcap:|maxwall:/.test(r.error || "")) { log(`[modo-autonomo] onStop: revisor ficou em silêncio (${r.error}) → liberando stop (degradado, SINALIZADO)`); return { done: true, continuation: null, degraded: "review-idle" }; }
        throw new Error("modo-autonomo.onStop: revisor falhou: " + (r.error || "sem texto"));
      }
      const j = parseJson(r.text);
      // schema-enforced: j.done é boolean quando o revisor submeteu. Se NÃO submeteu (__nosubmit__ após o loop de
      // reforço — raro): NÃO liberar o stop (deixar uma tarefa possivelmente incompleta PARAR é o erro pior). O
      // seguro num gate de Stop é CONTINUAR trabalhando (done:false) — o oposto do silêncio operacional acima.
      if (!j || j.__nosubmit__ || typeof j.done !== "boolean") { log(`[modo-autonomo] onStop: revisor não submeteu veredito após reforço → NÃO libera o stop (segue trabalhando, SINALIZADO)`); return { done: false, continuation: "Revisor não confirmou a conclusão conforme o plano — verifique os itens pendentes e conclua antes de parar.", degraded: "review-nosubmit" }; }
      log(`[modo-autonomo] stop review → done=${j.done}`);
      return { done: j.done, continuation: j.done ? null : (j.continuation || "Continue: ha itens do plano pendentes.") };
    },
  };
}
