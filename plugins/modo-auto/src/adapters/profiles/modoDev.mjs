// ADAPTER de PERFIL — "modo-dev" (estágio de BUILD, metodologia TDD do dono). Recebe uma FASE do
// plano vivo e roda o TIME FIXO seguindo TDD estrito (RED → GREEN → REFACTOR) + gates de código + QA:
//   TESTER (escreve o teste que FALHA) → DEVELOPER (mínimo p/ GREEN, reúso) → GATES (anti-boilerplate,
//   security, quality) → QA (revisa) → TECH LEAD (consolida: pass/mustFix/escalate; escala barreiras).
// Cada papel é um sub-agente REAL da fábrica (não stub). Reusa GatePort + AgentFactoryPort. Nunca lança.

import { resolveSkills, resolveGates } from "../skills/catalog.mjs";
import { extractJson } from "../util/extractJson.mjs";
import { reviewUntilClean } from "../review/remediation.mjs";
import { createReviewerRotation } from "../review/reviewerRotation.mjs";

function parseJson(t) { return extractJson(t); }
function textOf(o) { return o && o.ok && o.text ? o.text : ""; }

// TOOL TEMPLATE do veredito de dev (Princípio 11) — schema imposto pelo SDK.
const DEV_VERDICT_SCHEMA = {
  name: "submit_dev_verdict",
  description: "Veredito da fase de dev: passa ou tem correções?",
  parameters: {
    type: "object",
    properties: {
      pass: { type: "boolean", description: "true se a fase passa com rigor" },
      mustFix: { type: "array", items: { type: "string" }, description: "itens concretos a corrigir" },
      escalate: { type: "string", description: "pergunta objetiva a subir pro orquestrador se houver bloqueio de DECISÃO que o time não resolve; senão vazio" },
    },
    required: ["pass"],
  },
};

export function createModoDev({ log = () => {}, gates, maxRounds = 4, perReviewerCap = 2 } = {}) {
  const BASE_GATES = gates || ["anti-boilerplate", "security", "quality"];
  const VERDICT_ROLES = ["tech-lead", "revisor"]; // lentes de veredito: consolidador → adversarial (rotação)

  return {
    id: "modo-dev",
    roster: () => ["tester", "developer", "qa", "tech-lead"],

    /**
     * Constrói UMA fase por TDD com o time fixo → artefatos (test/impl/qa) + veredito.
     * REVISÃO ITERATIVA com ROTAÇÃO ANTI-VIÉS: gates+QA+revisor-de-veredito revisam; se reprovar, o developer
     * CORRIGE os mustFix e a fase é RE-revisada — repete até ZERAR ou esgotar `maxRounds`. O MESMO revisor
     * (papel+modelo) só roda `perReviewerCap` vezes; depois TROCA de modelo/papel (quebra o echo chamber).
     * Esgotou sem zerar → pass:false + escala (nunca finge passar).
     * @param {string} phase  a fase do plano
     * @param {{ factory?: object, gate?: object, memory?: object, router?: object, deep?: object }} caps
     * @param {{ taskType?: string, cwd?: string, maxRounds?: number, deep?: boolean }} [opts]  deep = painel multi-família no veredito
     */
    async develop(phase, caps = {}, { taskType = null, cwd = null, maxRounds: rounds = maxRounds, deep = false } = {}) {
      const ph = String(phase || "").slice(0, 2000);
      if (!ph) throw new Error("modo-dev.develop: fase vazia");
      if (!caps.factory?.run) throw new Error("modo-dev.develop: caps.factory ausente");
      if (!caps.gate?.run) throw new Error("modo-dev.develop: caps.gate ausente");
      // DELIBERAÇÃO (thread do dev): amarra tester/dev/QA/tech-lead/revisor da fase num só grupo.
      const gid = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      const topic = ph.slice(0, 160);
      // roda um papel; FAIL LOUD se falhar (não segue com texto vazio mascarando a falha do papel).
      // skills[] são INJETADAS no system do papel — o dev herda os mesmos anticorpos (fail-loud etc.).
      // cwd (opcional) = worktree do braço, pra o worker editar isolado durante o paralelismo do fatiador.
      const run = async (role, prompt, skills = null, ms = 180000, modelOverride = null, schema = null) => {
        const r = await caps.factory.run(role, prompt, { subject: role, timeoutMs: ms, skills, cwd, taskType, model: modelOverride || undefined, stage: "dev", group: gid, topic, ...(schema ? { schema, availableTools: [] } : {}) });
        if (!r.ok || !r.text) throw new Error(`modo-dev: papel "${role}" falhou: ${r.error || "sem texto"}`);
        return r.text;
      };
      // injeção escopada por PAPEL (+ tipo de tarefa) via CATÁLOGO — nunca injeta skill fora do catálogo.
      const skillsFor = (role) => resolveSkills({ profile: role, taskType }).skills;

      // contexto: o que já existe (memória offline = degradado explícito, não erro mascarado).
      let existing = "";
      const mem = caps.memory?.recall ? await caps.memory.recall(ph, { topK: 3 }) : null;
      if (mem && mem.ok) existing = (mem.results || []).map((r) => "- " + String(r.text || "").slice(0, 180)).join("\n");
      else if (mem && mem.ok === false && mem.error) log(`[modo-dev] memória indisponível (${mem.error})`);
      const ctx = `FASE A CONSTRUIR:\n${ph}\n\nJÁ EXISTE (reúse, não reinvente):\n${existing || "(nada relevante)"}\n\nMETODOLOGIA: TDD estrito (RED → GREEN → REFACTOR) + QA.`;

      // 1) TESTER (RED) — o teste define o alvo (roda 1×). 2) DEVELOPER (GREEN) — 1ª implementação.
      const test = await run("tester", `${ctx}\n\nEscreva o TESTE que FALHA (RED) pra esta fase, com casos-limite. Só o teste.`, skillsFor("tester"));
      let impl = await run("developer", `${ctx}\n\nTESTE (RED):\n${test}\n\nEscreva o MÍNIMO de código de produção que faz passar (GREEN) e refatore. Só o código.`, skillsFor("developer"));
      const CODE_GATES = resolveGates(taskType, BASE_GATES);
      let lastGates = [], lastQa = "";

      // ROTAÇÃO ANTI-VIÉS do revisor de VEREDITO: modelos disponíveis (do router, se houver) × papéis de
      // veredito, trocando a cada `perReviewerCap` rodadas. Sem router → rotação só por papel (ainda troca a lente).
      const verdictModels = caps.router?.ranked ? caps.router.ranked({ role: "tech-lead", taskType }) : [];
      const rotation = createReviewerRotation({ models: verdictModels, roles: VERDICT_ROLES, cap: perReviewerCap });

      // REVISÃO (um passe): GATES (enforcement pesado, paralelo) → QA → REVISOR DE VEREDITO (rotacionado).
      // QA recebe só o anticorpo comportamental (quality/security já são GATES dedicados — não duplicar).
      const review = async (round) => {
        const material = `FASE:\n${ph}\n\nTESTE:\n${test}\n\nIMPL${round ? " (rodada " + round + ")" : ""}:\n${impl}`;
        const gateOuts = await Promise.all(CODE_GATES.map((g) => caps.gate.run(g, `Avalie a IMPL desta fase segundo o gate.\n\n${material}`)));
        const failed = gateOuts.filter((o) => !o.ok);
        if (failed.length) log(`[modo-dev] AVISO — gates que FALHARAM: ${failed.map((g) => g.gate + ": " + (g.error || "?")).join("; ")}`);
        const gatesText = gateOuts.filter((o) => o.ok && o.text).map((o) => `### GATE ${o.gate}\n${o.text}`).join("\n\n");
        const qa = await run("qa", `${material}\n\nRevise (QA): o requisito foi cumprido? os testes cobrem os casos-limite e não são tautológicos? Aponte concretamente o que falta pra APROVAR.`, skillsFor("qa"));
        lastGates = gateOuts; lastQa = qa;

        // VEREDITO — modo PROFUNDO (opt-in): painel de consenso multi-família em paralelo. Se não houver
        // ≥2 famílias, degrada SINALIZADO pro revisor único rotacionado (não finge painel).
        if (deep && caps.deep?.review && caps.router) {
          const critique = `Avalie CRITICAMENTE (adversarial) esta fase — fure segurança, casos-limite, escalabilidade, reúso/DRY e aderência ao requisito.\n\n${material}\n\nGATES:\n${gatesText || "(sem gates)"}\n\nQA:\n${qa}\n\nListe achados CONCRETOS (o que falta/quebra), curto.`;
          const dp = await caps.deep.review({ material, critiquePrompt: critique, router: caps.router, taskType, panelRole: "revisor" });
          if (dp.ok) {
            log(`[modo-dev] veredito PROFUNDO (painel ${dp.families.join("+")}): pass=${dp.verdict.pass}${dp.watch.length ? ", " + dp.watch.length + " a verificar" : ""}`);
            return { pass: dp.verdict.pass, findings: dp.verdict.findings, escalate: dp.verdict.escalate };
          }
          log(`[modo-dev] deep indisponível (${dp.reason}) → revisor único rotacionado`);
        }

        // VEREDITO — revisor único ROTACIONADO (anti-viés: modelo/papel trocam a cada perReviewerCap rodadas).
        const rv = rotation.for(round); // { role, model } — revisor de veredito desta rodada
        if (rv.rotated) log(`[modo-dev] rodada ${round}: rotacionando revisor → ${rv.role}${rv.model ? "@" + rv.model : ""} (anti-viés)`);
        const verdictText = await run(rv.role,
          `Você é o REVISOR DE VEREDITO da fase (rodada ${round}). Abaixo: teste, impl, gates de código e QA.\n\n${material}\n\nGATES:\n${gatesText || "(sem gates)"}\n\nQA:\n${qa}\n\n` +
          `Decida com rigor e CHAME a ferramenta submit_dev_verdict com o veredito. NÃO responda em texto.`,
          null, 180000, rv.model || null, DEV_VERDICT_SCHEMA); // veredito = maior prompt + modelo pesado; tool template p/ formato determinístico
        const j = parseJson(verdictText);
        if (!j || j.__nosubmit__ || typeof j.pass !== "boolean") throw new Error("modo-dev: revisor de veredito nao submeteu {pass}: " + String(verdictText).slice(0, 200));
        return { pass: !!j.pass, findings: Array.isArray(j.mustFix) ? j.mustFix.map(String) : [], escalate: j.escalate ? String(j.escalate) : null };
      };

      // CORREÇÃO: o developer corrige APENAS os achados dos revisores (não reescreve do zero) → nova IMPL.
      const fix = async (findings) => {
        impl = await run("developer",
          `${ctx}\n\nTESTE (RED):\n${test}\n\nIMPL ATUAL:\n${impl}\n\nOs revisores REPROVARAM. Corrija SOMENTE estes achados, sem reescrever do zero e sem quebrar o teste:\n- ${findings.join("\n- ")}\n\nDevolva a IMPL corrigida completa.`,
          skillsFor("developer"));
      };

      // LAÇO: revisa → corrige → re-revisa até ZERAR ou esgotar. FAIL LOUD: esgotou = pass:false + escala.
      const rem = await reviewUntilClean({ review, fix, maxRounds: rounds, log });
      let escalate = rem.escalate;
      if (rem.exhausted && !escalate) escalate = `esgotou ${rem.rounds} rodadas de revisão sem zerar os achados: ${rem.findings.join("; ")}`;

      const roles = { tester: true, developer: true, qa: true, techLead: true }; // chegou aqui = todos rodaram (run() falha alto)
      log(`[modo-dev] fase construída (TDD): pass=${rem.pass} em ${rem.rounds} rodada(s)${rem.exhausted ? " (ESGOTOU)" : ""}, papéis ativos=${JSON.stringify(roles)}`);
      // EFICÁCIA (GAP 2): registra o VEREDITO da fase como span (rounds/escalate/exhausted) p/ o gapDetector medir
      // "quantas rodadas até passar" e "escalou?". Injetável (caps.recordVerdict) — DRY entre modo_dev e pipeline;
      // ausente = sem telemetria de eficácia (degrada SINALIZADO, não quebra o build). Aritmética pura (Princípio 11).
      try {
        caps.recordVerdict?.({ gid, topic, taskType, pass: !!rem.pass, rounds: rem.rounds, mustFixCount: (rem.findings || []).length, escalate: escalate || null, exhausted: !!rem.exhausted });
      } catch (e) { log(`[modo-dev] recordVerdict falhou (sinalizado, não derruba o build): ${e?.message || e}`); }
      return {
        ok: true,
        pass: !!rem.pass,
        rounds: rem.rounds,
        exhausted: !!rem.exhausted,
        mustFix: rem.findings || [],
        escalate: escalate || null,
        artifacts: { test, impl, qa: lastQa },
        gates: lastGates.map((o) => ({ gate: o.gate, ok: o.ok })),
        gateFailed: lastGates.filter((o) => !o.ok).map((g) => g.gate),
        roles,
      };
    },
  };
}
