// FÁBRICA genérica de PERFIL DE ANÁLISE DE CÓDIGO (anti-boilerplate) — a mesa que COMPÕE scope + codeAnalysis
// (evidência determinística) + deep-research EXTERNO + mesa VIVA + OTF, PARAMETRIZADA. `modo_reuso` e
// `modo_seguranca` são só CONFIG (order/seed/kinds/label/prompts). Reúso máximo: um produto sobre reúso NÃO
// pode duplicar perfil. FAIL LOUD: assunto/factory/mesa ausente → LANÇA. Evidência ausente = degradação SINALIZADA.

import { getRole } from "../agents/roles.mjs";
import { escopoParaWorker } from "../memory/memoryTools.mjs";
import { selectSeed } from "../adr/templateRegistry.mjs";
import { createOutlineBuilder } from "../adr/outlineBuilder.mjs";
import { fillSlots } from "../adr/slotFiller.mjs";
import { assembleAdr, assemblePhases } from "../adr/assembler.mjs";
import { checkDivergence } from "../adr/divergenceCheck.mjs";

/**
 * @param {{ id:string, tag:string, order:string[], seedType:string, kinds:string[], label:string,
 *          externalPrompt:(s:string)=>string, freeFormInstruction:string, log?:(m:string)=>void }} cfg
 */
export function createCodeAnalysisProfile(cfg) {
  const { id, tag, order, seedType, kinds, label, externalPrompt, freeFormInstruction, log = () => {} } = cfg;
  return {
    id,
    roster: () => order,

    /**
     * @param {string} subject  o alvo da análise (área/assunto do código)
     * @param {{ factory:object, liveMesa:object, scope?:object, codeAnalysis?:object, deep?:object, router?:object, embedder?:object, root?:string }} caps
     * @param {{ deep?:boolean }} [opts]
     * @returns {Promise<{ok:true, adr:string, phases:string[]|null, evidence:string, rounds:number, converged:boolean, engine:string}>}
     */
    async analyze(subject, caps = {}, { deep = true } = {}) {
      const s = String(subject || "").trim();
      if (!s) throw new Error(`${id}.analyze: assunto vazio`);
      if (!caps.factory?.run) throw new Error(`${id}.analyze: caps.factory ausente`);
      if (!caps.liveMesa?.run) throw new Error(`${id}.analyze: caps.liveMesa ausente (mesa viva)`);
      const root = caps.root || process.cwd();

      // 1) EVIDÊNCIA determinística (Princípio 11): scope + codeAnalysis (filtrado por `kinds`) + pesquisa EXTERNA.
      const parts = [];
      if (caps.scope?.scope) {
        const sc = await caps.scope.scope(s, { root });
        if (sc.ok) parts.push("MAPA (scope): " + (sc.strategy === "graph" ? "hubs: " + (sc.hubs || []).slice(0, 12).map((h) => h.id || h.name).join(", ") : "arquivos: " + (sc.topFiles || []).slice(0, 12).join(", ")));
        else log(`[${id}] scope indisponível (${sc.error || sc.reason})`);
      }
      if (caps.codeAnalysis?.analyze) {
        const ev = await caps.codeAnalysis.analyze(root, { kinds });
        parts.push(caps.codeAnalysis.render(ev));
      }
      if (deep && caps.deep?.review && caps.router) {
        const dp = await caps.deep.review({ material: s, critiquePrompt: externalPrompt(s), router: caps.router, taskType: "research" });
        if (dp.ok) parts.push(`EXTERNO (painel ${dp.families.join("+")}): ${dp.verdict.findings.join("; ") || "(nada corroborado)"}`);
        else log(`[${id}] deep indisponível (${dp.reason})`);
      }
      const evidence = parts.join("\n\n") || "(sem evidência determinística — análise heurística, SINALIZADO)";

      // 2) DELIBERAÇÃO na mesa VIVA com os papéis do perfil; saída OTF (seed → forma constante).
      const agents = order.map((rid) => {
        const r = getRole(rid);
        if (!r || !r.system) throw new Error(`${id}: papel sem system no catálogo: ${rid}`);
        const model = caps.router ? caps.router.route({ role: rid, taskType: "research" }).model : undefined;
        return { role: rid, system: r.system, model };
      });
      const subjectFull = `ANÁLISE DE ${label}:\n${s}\n\nEVIDÊNCIA DETERMINÍSTICA:\n${evidence}`;

      let otfPhases = null, engine = `${tag}-otf`;
      const otfTrace = `${tag}-otf-` + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      const otfWriteDoc = async ({ transcript, synthesis }) => {
        const deliberation = `SÍNTESE:\n${synthesis || "(sem síntese)"}\n\nDELIBERAÇÃO:\n${transcript}\n\nEVIDÊNCIA:\n${evidence}`;
        const template = createOutlineBuilder(selectSeed(seedType, { log }), { log }).lock();
        const runAgent = (p) => caps.factory.run("documentacao", p, { timeoutMs: 180000, stage: tag, group: otfTrace, traceId: otfTrace, memoryScope: escopoParaWorker(caps) });
        let slots = await fillSlots(template, { deliberation, runAgent });
        let adr = assembleAdr(template, slots);
        const dv = await checkDivergence(caps.embedder, { adrText: adr, deliberation, slots, template });
        if (dv.diverged) {
          log(`[${id}] divergência ${dv.drift} → re-preenchendo (${dv.sections.map((x) => x.id).join(",") || "geral"})`);
          slots = await fillSlots(template, { deliberation, runAgent, extra: `Seja FIEL à EVIDÊNCIA e à deliberação (divergiu: ${dv.sections.map((x) => x.id).join(", ") || "geral"}).` });
          adr = assembleAdr(template, slots);
        }
        otfPhases = assemblePhases(template, slots);
        return adr;
      };
      const freeFormWriteDoc = async ({ transcript, synthesis }) => {
        const r = await caps.factory.run("documentacao", `${freeFormInstruction} Fundamente na SÍNTESE (${synthesis || "-"}) e na DELIBERAÇÃO abaixo. Comece em "## Contexto" e traga "## Fase N: <título>". Você NÃO tem ferramentas: NÃO diga que registrou arquivos, NÃO escreva resumo executivo nem peça autorização — só o ADR.\n\n${transcript}`, { timeoutMs: 180000, stage: tag, group: otfTrace, traceId: otfTrace, memoryScope: escopoParaWorker(caps) });
        if (!r.ok || !r.text) throw new Error(`${id}: fallback free-form falhou: ${r.error || "sem texto"}`);
        return r.text;
      };
      const writeDoc = async (ctx) => {
        try { return await otfWriteDoc(ctx); }
        catch (e) { engine = `${tag}-freeform-fallback`; otfPhases = null; log(`[${id}] OTF FALHOU (${e?.message || e}) → fallback free-form (SINALIZADO)`); return await freeFormWriteDoc(ctx); }
      };

      const res = await caps.liveMesa.run(subjectFull, { agents, writeDoc, minRounds: 2, maxRounds: 4, facilitatorRole: "facilitador", embedder: caps.embedder, order });
      log(`[${id}] ADR gerado (${res.document.length} chars; ${res.rounds} voltas; motor=${engine}; fases=${otfPhases ? otfPhases.length : "?"})`);
      return { ok: true, adr: res.document, phases: otfPhases, evidence, rounds: res.rounds, converged: res.converged, engine };
    },
  };
}
