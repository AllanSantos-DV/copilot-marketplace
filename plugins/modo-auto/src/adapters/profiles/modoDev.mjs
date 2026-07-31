// ADAPTER de PERFIL — "modo-dev" (estágio de BUILD, metodologia TDD do dono). Recebe uma FASE do
// plano vivo e roda o TIME FIXO seguindo TDD estrito (RED → GREEN → REFACTOR) + gates de código + QA:
//   TESTER (escreve o teste que FALHA) → DEVELOPER (mínimo p/ GREEN, reúso) → GATES (anti-boilerplate,
//   security, quality) → QA (revisa) → TECH LEAD (consolida: pass/mustFix/escalate; escala barreiras).
// Cada papel é um sub-agente REAL da fábrica (não stub). Reusa GatePort + AgentFactoryPort. Nunca lança.

import { resolveSkills, resolveGates } from "../skills/catalog.mjs";
import { recallIssue, renderRecall } from "../memory/memoryPort.mjs";
import { extractJson } from "../util/extractJson.mjs";
import { reviewUntilClean } from "../review/remediation.mjs";
import { createReviewerRotation } from "../review/reviewerRotation.mjs";
import { extractDiffContext } from "../review/diffContext.mjs";
import { abDecision, f4Threshold, shouldUseShallow, extractPaths } from "../review/rolloutGate.mjs";
import { flagsFromEnv } from "../review/rolloutFlags.mjs";
import { createCircuitBreaker } from "../review/circuitBreaker.mjs";
import { withRunContext } from "../agents/agentFactory.mjs";

// FLAGS por FASE (rollout gradual, default OFF — liga uma, observa, liga a próxima). Vêm de caps.rolloutFlags
// (estado PERSISTIDO, ligável por tool/painel); sem elas, cai no AMBIENTE (CI/testes). Motivo do estado: a
// extensão roda DENTRO do app, então env var não é acionável pelo dono — com env-only o rollout nunca sairia do OFF.
const readFlags = (caps) => (caps?.rolloutFlags?.get ? caps.rolloutFlags.get() : flagsFromEnv());

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
      // Toda a deliberação roda DENTRO do contexto de telemetria: os workers disparados aqui — inclusive os do
      // painel PROFUNDO (`deepPanel`, que sozinho responde por ~1545 spans e não passava `taskType`) — herdam o
      // tipo da tarefa sem que cada ponto de chamada precise lembrar de repassá-lo.
      const gid0 = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      return withRunContext({ taskType, stage: "dev", traceId: gid0, topic: String(phase || "").slice(0, 160) }, () =>
        this.__develop(phase, caps, { taskType, cwd, maxRounds: rounds, deep, gid: gid0 }));
    },
    async __develop(phase, caps = {}, { taskType = null, cwd = null, maxRounds: rounds = maxRounds, deep = false, gid: gidIn = null } = {}) {
      const ph = String(phase || "").slice(0, 2000);
      if (!ph) throw new Error("modo-dev.develop: fase vazia");
      if (!caps.factory?.run) throw new Error("modo-dev.develop: caps.factory ausente");
      if (!caps.gate?.run) throw new Error("modo-dev.develop: caps.gate ausente");
      // DELIBERAÇÃO (thread do dev): amarra tester/dev/QA/tech-lead/revisor da fase num só grupo.
      const gid = gidIn || ("dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6));

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
      const mem = caps.memory?.recall ? await caps.memory.recall(ph, { topK: 3, tag: "modo-dev" }) : null;
      if (mem && mem.ok) existing = renderRecall(mem.results, { max: 180 }).text;
      else { const iss = recallIssue(mem, "modo-dev"); if (iss) log(iss); }
      // DECISÕES ANTERIORES (namespace #adr). Quem CONSTRÓI uma fase precisa saber o que a mesa já DECIDIU — senão
      // o dev contradiz o ADR e o revisor reprova por um motivo que estava escrito e ninguém leu. Este é o
      // consumidor real do arquivo de ADRs: sem ele, a separação de escopo teria criado um artefato órfão
      // (write-only), que é o defeito oposto — e igualmente inútil — ao do auto-envenenamento.
      let decisions = "";
      if (caps.memory?.recall) {
        const adr = await caps.memory.recall(ph, { topK: 2, namespace: "adr" });
        if (adr && adr.ok) decisions = renderRecall(adr.results, { max: 240 }).text;
        else { const iss = recallIssue(adr, "modo-dev/adr"); if (iss) log(iss); }
      }
      const ctx = `FASE A CONSTRUIR:\n${ph}\n\nJÁ EXISTE (reúse, não reinvente):\n${existing || "(nada relevante)"}` +
        (decisions ? `\n\nDECISÕES JÁ TOMADAS PELA MESA (NÃO contradiga; se precisar divergir, diga explicitamente):\n${decisions}` : "") +
        `\n\nMETODOLOGIA: TDD estrito (RED → GREEN → REFACTOR) + QA.`;

      // 1) TESTER (RED) — o teste define o alvo (roda 1×). 2) DEVELOPER (GREEN) — 1ª implementação.
      const test = await run("tester", `${ctx}\n\nEscreva o TESTE que FALHA (RED) pra esta fase, com casos-limite. Só o teste.`, skillsFor("tester"));
      let impl = await run("developer", `${ctx}\n\nTESTE (RED):\n${test}\n\nEscreva o MÍNIMO de código de produção que faz passar (GREEN) e refatore. Só o código.`, skillsFor("developer"));
      const CODE_GATES = resolveGates(taskType, BASE_GATES);
      let lastGates = [], lastQa = "", prevImpl = null; // prevImpl: estado anterior da IMPL (F1, pré-filtro por diff)
      // A/B do F1 (rollout operacional): sorteia o braço UMA vez por fase. "bypass" = grupo de CONTROLE (roda sem
      // filtro) → sem controle não existe go/no-go medido, só achismo. Gravado no span do veredito (f1Arm).
      const flags = readFlags(caps);
      const f1Arm = flags.f1 ? abDecision({ bypassPct: flags.bypassPct }) : "off";
      if (f1Arm !== "off") log(`[modo-dev] F1 A/B: braço=${f1Arm} (bypass ${flags.bypassPct}%, fonte ${flags.source})`);
      // F5 — DISJUNTOR do revisor (ligado por padrão: só atua em FALHA REAL, onde hoje o desfecho já era ruim).
      // 2 falhas consecutivas → abre o circuito → escala pro humano COM o contexto parcial, em vez de repetir o
      // ciclo retry→timeout→retry. half-open (após 60s) deixa um pico transitório se recuperar sozinho.
      const breaker = createCircuitBreaker({ log });

      // ROTAÇÃO ANTI-VIÉS do revisor de VEREDITO: modelos disponíveis (do router, se houver) × papéis de
      // veredito, trocando a cada `perReviewerCap` rodadas. Sem router → rotação só por papel (ainda troca a lente).
      const verdictModels = caps.router?.ranked ? caps.router.ranked({ role: "tech-lead", taskType }) : [];
      const rotation = createReviewerRotation({ models: verdictModels, roles: VERDICT_ROLES, cap: perReviewerCap });

      // REVISÃO (um passe): GATES (enforcement pesado, paralelo) → QA → REVISOR DE VEREDITO (rotacionado).
      // QA recebe só o anticorpo comportamental (quality/security já são GATES dedicados — não duplicar).
      const review = async (round) => {
        // F1 (flag, default OFF): a partir da 2ª revisão manda só o DIFF da IMPL + contexto — o revisor não
        // precisa reler a impl inteira toda rodada. CONTRATO E3: par before/after do MESMO artefato (a IMPL),
        // NUNCA o blob composto. Sem ganho/sem par → PASS-THROUGH SINALIZADO (o log diz o motivo).
        let implPart = impl;
        if (f1Arm === "filtered" && round > 0 && prevImpl != null) {
          const dc = extractDiffContext({ before: prevImpl, after: impl });
          implPart = dc.text;
          log(`[modo-dev] F1 pré-filtro (rodada ${round}): modo=${dc.mode}${dc.reason ? " (" + dc.reason + ")" : ""} — ${dc.outLines}/${dc.afterLines} linhas ao revisor`);
        }
        const material = `FASE:\n${ph}\n\nTESTE:\n${test}\n\nIMPL${round ? " (rodada " + round + ")" : ""}:\n${implPart}`;
        const gateOuts = await Promise.all(CODE_GATES.map((g) => caps.gate.run(g, `Avalie a IMPL desta fase segundo o gate.\n\n${material}`)));
        const failed = gateOuts.filter((o) => !o.ok);
        if (failed.length) log(`[modo-dev] AVISO — gates que FALHARAM: ${failed.map((g) => g.gate + ": " + (g.error || "?")).join("; ")}`);
        const gatesText = gateOuts.filter((o) => o.ok && o.text).map((o) => `### GATE ${o.gate}\n${o.text}`).join("\n\n");
        const qa = await run("qa", `${material}\n\nRevise (QA): o requisito foi cumprido? os testes cobrem os casos-limite e não são tautológicos? Aponte concretamente o que falta pra APROVAR.`, skillsFor("qa"));
        lastGates = gateOuts; lastQa = qa;

        // VEREDITO — modo PROFUNDO (opt-in): painel de consenso multi-família em paralelo. Se não houver
        // ≥2 famílias, degrada SINALIZADO pro revisor único rotacionado (não finge painel).
        // F4 (flag, default OFF): GATE DE COMPLEXIDADE — material pequeno (< P25 MEDIDO de inputLines nos spans
        // v3) e sem arquivo crítico → pula o painel deep e usa o revisor único (barato). Threshold NUNCA
        // hardcoded: sai do dado; sem amostra (>=500 spans) → f4Threshold=null → gate NÃO atua (fallback seguro).
        let skipDeep = false;
        if (deep && flags.f4 && caps.telemetryRead) {
          const th = f4Threshold(caps.telemetryRead(), { override: flags.f4MaxLines || null });
          // GUARD-RAIL com DUAS defesas (o `ph` é PROSA, não lista de arquivos): (1) paths REAIS extraídos da fase
          // + da impl; (2) varredura do texto bruto pelos mesmos padrões críticos — se a fase FALA de auth/senha/
          // pagamento, vai pra revisão CHEIA mesmo que nenhum caminho tenha sido reconhecido.
          skipDeep = shouldUseShallow({
            inputLines: material.split(/\r?\n/).length,
            threshold: th,
            touchedPaths: extractPaths(`${ph}\n${impl}`),
            scanText: `${ph}\n${test}`,
          });
          if (skipDeep) log(`[modo-dev] F4 gate: material pequeno (< ${Math.round(th)} linhas) e nada crítico (paths+texto) → revisor único (pula o painel deep)`);
        }
        if (deep && !skipDeep && caps.deep?.review && caps.router) {
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
        prevImpl = impl; // F1: guarda o estado ANTERIOR p/ diferenciar na próxima revisão (contrato E3)
        impl = await run("developer",
          `${ctx}\n\nTESTE (RED):\n${test}\n\nIMPL ATUAL:\n${impl}\n\nOs revisores REPROVARAM. Corrija SOMENTE estes achados, sem reescrever do zero e sem quebrar o teste:\n- ${findings.join("\n- ")}\n\nDevolva a IMPL corrigida completa.`,
          skillsFor("developer"));
      };

      // LAÇO: revisa → corrige → re-revisa até ZERAR ou esgotar. FAIL LOUD: esgotou = pass:false + escala.
      // O `review` vai ENVOLVIDO pelo DISJUNTOR (F5): falha REAL de infra não vira loop de retry — abre e escala
      // com o contexto parcial. Reprovação (pass:false) NÃO conta como falha: é veredito legítimo.
      const guardedReview = async (round) => {
        if (!breaker.canAttempt()) {
          log(`[modo-dev] circuito ABERTO na rodada ${round} — escalando com contexto parcial (sem re-tentar)`);
          return { pass: false, findings: [], escalate: breaker.escalationMessage({ round, gates: lastGates, qa: lastQa }) };
        }
        try { const v = await review(round); breaker.onSuccess(); return v; }
        catch (e) {
          const st = breaker.onFailure(e);
          if (st === "open") return { pass: false, findings: [], escalate: breaker.escalationMessage({ round, gates: lastGates, qa: lastQa }) };
          throw e; // ainda abaixo do limiar → FAIL LOUD como antes (o erro sobe)
        }
      };
      const rem = await reviewUntilClean({ review: guardedReview, fix, maxRounds: rounds, cycleBudgetMs: flags.f2BudgetMs > 0 ? flags.f2BudgetMs : Infinity, log });
      let escalate = rem.escalate;
      if (rem.exhausted && !escalate) escalate = `esgotou ${rem.rounds} rodadas de revisão sem zerar os achados: ${rem.findings.join("; ")}`;

      const roles = { tester: true, developer: true, qa: true, techLead: true }; // chegou aqui = todos rodaram (run() falha alto)
      log(`[modo-dev] fase construída (TDD): pass=${rem.pass} em ${rem.rounds} rodada(s)${rem.exhausted ? " (ESGOTOU)" : ""}, papéis ativos=${JSON.stringify(roles)}`);
      // EFICÁCIA (GAP 2): registra o VEREDITO da fase como span (rounds/escalate/exhausted) p/ o gapDetector medir
      // "quantas rodadas até passar" e "escalou?". Injetável (caps.recordVerdict) — DRY entre modo_dev e pipeline;
      // ausente = sem telemetria de eficácia (degrada SINALIZADO, não quebra o build). Aritmética pura (Princípio 11).
      try {
        // `findingsCount` estava em 0% dos spans (o gapDetector pedia e ninguém gravava). Vai junto com o
        // histórico por rodada, que é o que permite ver se a remediação CONVERGE (achados caindo) ou patina.
        caps.recordVerdict?.({ gid, topic, taskType, pass: !!rem.pass, rounds: rem.rounds, mustFixCount: (rem.findings || []).length, findingsCount: (rem.findings || []).length, findingsByRound: (rem.history || []).map((h) => (h.findings || []).length), escalate: escalate || null, exhausted: !!rem.exhausted, budgetExhausted: !!rem.budgetExhausted, elapsedCycleMs: rem.elapsedCycleMs, f1Arm });
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
