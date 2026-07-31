// ADAPTER de PERFIL — "modo-adr" (planejamento/documentação). A partir de um BRIEFING, roda a MESA DE
// ADR (grounded no que JÁ EXISTE via memória/reúso) e ESCREVE o plano vivo em FASES. É o oposto do
// modo-auto: aqui a elicitação vai pro HUMANO; o produto é o PLANO que o modo-auto depois defende.
// Reusa a AgentFactoryPort (papéis) + MemoryPort + PlanPort. Nunca lança.
//
// MOTOR: se `caps.liveMesa` está presente → MESA VIVA (debate round-robin turno a turno, cada agente vê o
// outro, documentador escreve com a DELIBERAÇÃO INTEIRA). Senão → fan-out/fan-in LEGADO (fallback).

import { getRole } from "../agents/roles.mjs";
import { withRunContext } from "../agents/agentFactory.mjs";
import { selectSeed } from "../adr/templateRegistry.mjs";
import { triage } from "../adr/complexityTriage.mjs";
import { createOutlineBuilder } from "../adr/outlineBuilder.mjs";
import { fillSlots } from "../adr/slotFiller.mjs";
import { assembleAdr, assemblePhases } from "../adr/assembler.mjs";
import { checkDivergence } from "../adr/divergenceCheck.mjs";
import { extractJson } from "../util/extractJson.mjs";

function textOf(o) { return o && o.ok && o.text ? o.text : ""; }

// TOOL TEMPLATE do refino de outline (Princípio 11) — schema imposto pelo SDK. SOFT: já degrada pro seed.
const OUTLINE_REFINE_SCHEMA = {
  name: "submit_outline_changes",
  description: "Ajustes no outline do ADR (add/adjust/remove seções). Objeto vazio se nada muda. NUNCA remova 'fases'.",
  parameters: {
    type: "object",
    properties: {
      add: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, guide: { type: "string" }, required: { type: "boolean" }, after: { type: "string" } }, required: ["id", "title"] } },
      adjust: { type: "object", description: "mapa id → { guide }" },
      remove: { type: "array", items: { type: "string" } },
    },
  },
};

// Ordem de fala da mesa VIVA de ADR: técnico abre → pesquisa → negócio → contesta → revisa → facilita.
const ADR_LIVE_ORDER = ["tecnico", "pesquisador", "negocio", "advogado-diabo", "revisor", "facilitador"];
// CAMINHO ADAPTATIVO (roteador de complexidade): express = 0 debate (só o documentador OTF); mini = 3 papéis,
// 1 volta; full = os 6 papéis, 2-4 voltas (o de sempre). O facilitador é sempre o juiz/síntese.
const PATH_CFG = {
  express: { skipDebate: true, roles: ["facilitador"], minRounds: 1, maxRounds: 1 },
  mini: { skipDebate: false, roles: ["tecnico", "revisor", "facilitador"], minRounds: 1, maxRounds: 1 },
  full: { skipDebate: false, roles: ADR_LIVE_ORDER, minRounds: 2, maxRounds: 4 },
};

// PISO DE RELEVÂNCIA: REMOVIDO (v0.3.0), e o motivo é medição, não gosto.
// Ele existiu como filtro de cosine (0.55) contra o ruído que sequestrava o plano. Só que a medição real, com o
// mesmo briefing curto que disparou o bug, mostrou o ruído pontuando 0.65-0.71 — ACIMA do piso. Ou seja: no caso
// que ele deveria cobrir, ele NUNCA disparava. Um guarda que não dispara não é defesa fraca, é FALSA SEGURANÇA:
// aparece no código, aparece no teste (com números fabricados), e faz todo mundo — inclusive eu — acreditar que
// há proteção ali. Calibrar de verdade exigiria a distribuição de scores de consultas boas x ruins, amostra que
// não existe; inventar um número novo repetiria o erro.
// O QUE PROTEGE DE FATO, por construção e não por limiar: (1) a mesa não grava mais o plano inteiro como
// conhecimento de reúso; (2) a saída dela vive num NAMESPACE separado, então não volta na busca que ela faz;
// (3) o que vem da memória entra ROTULADO como contexto descartável, nunca dentro do "CONSOLIDE isto".
// Barrar por relevância de verdade pede top-k amplo + reranker cross-encoder — anotado como dívida, não fingido
// com um piso de cosine.

// REGISTRO DE ADR na memória — deliberadamente COMPACTO, e esta é a correção da FONTE do envenenamento.
// Antes, o plano INTEIRO (~5 KB: fases, riscos, referências) era gravado como conhecimento de reúso. Como a
// mesa CONSULTA a memória para montar o "o que já existe", ela comia a própria saída: o plano de uma
// deliberação virava contexto da seguinte, e um briefing curto trazia fases de OUTRO assunto. Filtrar só na
// leitura (piso de relevância) trata o sintoma — o veneno continuava crescendo a cada run.
// POR QUE COMPACTO E NÃO "PARAR DE GRAVAR": o plano completo JÁ é persistido em `adr-plan.md` (o artefato que o
// dono lê) e NENHUM código o lê de volta da memória — o corpo inteiro tinha zero valor de leitura e dano medido.
// Mas o REGISTRO tem valor real de reúso ("já decidimos X sobre Y"), então ele fica: assunto + decisão + ponteiro
// para o arquivo. De quebra cabe em UM chunk, então o marcador sobrevive à fragmentação do daemon — num documento
// de 5 KB, picado em vários pedaços, só o primeiro carregaria o marcador, e por isso marcação em texto NÃO seria
// defesa confiável. Aqui o tamanho é o que torna a marcação utilizável.
const ADR_RECORD_MARK = "[ADR-REGISTRO]";
// NAMESPACE do arquivo de ADRs. A saída da mesa vai para `<project_id>#adr`, e o recall dela é escopado a
// `<project_id>` — logo o que ela grava NUNCA volta na busca que ela mesma faz. É a separação ESTRUTURAL que
// substitui a garantia frágil anterior (marcador no texto + torcer para o registro caber num chunk só, o que
// acoplava a defesa ao chunker de um servidor de terceiro e quebraria em silêncio num documento maior).
// O arquivo continua consultável de propósito: quem quiser o histórico de decisões busca nesse escopo.
const ADR_NAMESPACE = "adr";
function adrRecord(briefing, plan) {
  const sec = /^##\s*Decis[ãa]o\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/mi.exec(String(plan || ""));
  const decisao = (sec ? sec[1] : String(plan || "")).trim().replace(/\s+/g, " ").slice(0, 500);
  return `${ADR_RECORD_MARK} assunto: ${String(briefing || "").trim().replace(/\s+/g, " ").slice(0, 160)}\n` +
    `DECISÃO: ${decisao || "(não extraída)"}\n` +
    `Plano completo: adr-plan.md da sessão (este registro é um índice, não o plano).`;
}

export function createModoAdr({ log = () => {}, roles } = {}) {
  const ADR_ROLES = roles || ["pesquisador", "negocio", "tecnico", "revisor"];

  // MESA VIVA: monta os agentes vivos (papéis base + facilitador), roda o debate turno a turno, e o
  // documentador escreve o plano COM a deliberação inteira. Persiste o snapshot (sessionIds) p/ reabrir.
  async function buildPlanVivo(bf, existing, caps, { deep, taskType = null, path = "full", triageInfo = null, priorAdrs = "" }) {
  // Mesma razão do modo_dev: a deliberação do ADR produzia ~258 spans SEM `taskType`, inutilizando qualquer
  // comparação por tipo de tarefa. Com o contexto por cadeia assíncrona, todo papel disparado aqui herda.
  return withRunContext({ taskType, stage: "adr" }, () => buildPlanVivoInner(bf, existing, caps, { deep, taskType, path, triageInfo, priorAdrs }));
}

async function buildPlanVivoInner(bf, existing, caps, { deep, taskType = null, path = "full", triageInfo = null, priorAdrs = "" }) {
    const cfg = PATH_CFG[path] || PATH_CFG.full;
    const agents = cfg.roles.map((id) => {
      const r = getRole(id);
      if (!r || !r.system) throw new Error("modo-adr vivo: papel sem system no catálogo: " + id);
      const model = caps.router ? caps.router.route({ role: id, taskType: "planning" }).model : undefined;
      return { role: id, system: r.system, model };
    });
    const subject =
      `BRIEFING:\n${bf}\n\n` +
      `O QUE JÁ EXISTE NO PROJETO (memória — use SÓ o que casar com o briefing; o resto IGNORE):\n${existing || "(nada relevante)"}`;

    // O recall da memória é CONTEXTO DE FUNDO, não pauta. Ele entrava colado na deliberação, que carrega a
    // instrução "CONSOLIDE isto, não invente nem fuja" — então o documentador consolidava obedientemente
    // material de OUTRO assunto. Aqui ele vem rotulado e com a regra de descarte explícita: se não casar com
    // o briefing, IGNORE. O assunto da mesa é o BRIEFING, sempre.
    const reuseBlock = (ex) => (ex
      ? `\n\nCONTEXTO DE REÚSO (memória do projeto — NÃO é o assunto desta mesa e NÃO deve ser consolidado):\n` +
        `Use SOMENTE o que casar com o BRIEFING acima, para não reinventar o que já existe. ` +
        `O que não tiver relação com o briefing, IGNORE por completo — não traga esses temas para o plano.\n${ex}`
      : "") + (priorAdrs
      ? `\n\nDECISÕES ANTERIORES DESTA MESA (arquivo de ADRs — leia para NÃO CONTRADIZER nem refazer o que já foi\n` +
        `decidido; NÃO é o assunto desta mesa e NÃO deve ser consolidado no plano):\n${priorAdrs}`
      : "");

    let otfPhases = null, engine = "viva-otf"; // captura das fases + qual motor de escrita foi usado

    // FALLBACK LEGADO (SINALIZADO): o documentador escreve o plano em prosa livre (o modo antigo). Só entra
    // se a OTF falhar de verdade — e loga alto (não é o caminho feliz; a OTF é que garante a forma determinística).
    const freeFormWriteDoc = async ({ transcript, synthesis }) => {
      const r = await caps.factory.run("documentacao",
        `BRIEFING:\n${bf}\n\n` +
        `SÍNTESE DO FACILITADOR:\n${synthesis || "(sem síntese)"}\n\n` +
        `DELIBERAÇÃO COMPLETA DA MESA:\n${transcript}\n${reuseBlock(existing)}\n\n` +
        `Escreva o PLANO em FASES "## Fase N: <título>", cada fase autossuficiente (objetivo + requisito testável + entrega). Comece direto em "## Fase 1".`,
        { timeoutMs: 180000, stage: "adr", availableTools: [] });
      if (!r.ok || !r.text) throw new Error("modo-adr: fallback free-form do documentador falhou: " + (r.error || "sem texto"));
      return r.text;
    };

    // OTF (Outline-Then-Fill) — a FORMA é determinística: seed → co-construção → lock → slot-fill → assemble →
    // validação mini-LRM (re-fill se divergir). O conteúdo é heurístico; a montagem é TOOL. Mata a variância de shape.
    const otfWriteDoc = async ({ transcript, synthesis }) => {
      const deliberation = `SÍNTESE DO FACILITADOR:\n${synthesis || "(sem síntese)"}\n\nDELIBERAÇÃO COMPLETA DA MESA:\n${transcript}${reuseBlock(existing)}`;
      const otfTrace = "adr-otf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6); // correlaciona os spans desta build (telemetria)
      const seed = selectSeed(taskType, { log });
      const builder = createOutlineBuilder(seed, { log });
      // CO-CONSTRUÇÃO: a deliberação pode pedir ajustes no outline (best-effort, sinalizado — seed se falhar).
      try {
        const ids = seed.sections.map((s) => `${s.id}:${s.title}`).join("; ");
        const pr = await caps.factory.run("documentacao",
          `Com base na DELIBERAÇÃO abaixo, o outline do ADR precisa de ajustes? Outline atual: ${ids}. ` +
          `CHAME submit_outline_changes com add/adjust/remove (objeto vazio se nada muda). NUNCA remova "fases". NÃO responda em texto.\n\n${deliberation}`,
          { timeoutMs: 120000, stage: "adr", group: otfTrace, traceId: otfTrace, schema: OUTLINE_REFINE_SCHEMA, availableTools: [] });
        if (pr.ok && pr.text) { const p = extractJson(pr.text); if (p && typeof p === "object" && !Array.isArray(p) && !p.__nosubmit__) builder.propose(p); else log("[modo-adr OTF] refino de outline sem submissão (segue com o seed, sinalizado)"); }
        else log("[modo-adr OTF] refino de outline indisponível (segue com o seed, sinalizado)");
      } catch (e) { log("[modo-adr OTF] refino de outline falhou (segue com o seed, sinalizado): " + (e?.message || e)); }
      const template = builder.lock();

      // FAIL-CLOSED (availableTools: []): o documentador COMPÕE prosa a partir da deliberação que já está no
      // prompt — ele não tem por que ler disco, rodar comando ou pesquisar. Sem essa trava ele saía EXPLORANDO
      // e escrevia um plano sobre o que encontrasse por aí, IGNORANDO o briefing: um briefing de uma linha
      // produziu um ADR inteiro sobre locks/owner.json/respond_idle_session, assunto que não estava em lugar
      // nenhum da entrada. É o mesmo fechamento que o refino de outline (acima) já usava — faltava aqui, que é
      // justamente onde o CONTEÚDO do plano nasce.
      const runAgent = (prompt) => caps.factory.run("documentacao", prompt, { timeoutMs: 180000, stage: "adr", group: otfTrace, traceId: otfTrace, availableTools: [] });
      let slots = await fillSlots(template, { deliberation, runAgent });
      let adr = assembleAdr(template, slots);

      // Mini-LRM: o ADR montado bate com a deliberação? Se divergiu, RE-PREENCHE uma vez enfatizando a fidelidade.
      const dv = await checkDivergence(caps.embedder, { adrText: adr, deliberation, slots, template });
      if (dv.diverged) {
        log(`[modo-adr OTF] divergência ${dv.drift} (${dv.method}) → re-preenchendo (seções: ${dv.sections.map((s) => s.id).join(",") || "geral"})`);
        slots = await fillSlots(template, { deliberation, runAgent, extra: `ATENÇÃO: o preenchimento anterior DIVERGIU da deliberação (drift ${dv.drift}). Seja FIEL à deliberação, sobretudo nas seções: ${dv.sections.map((s) => s.id).join(", ") || "(geral)"}.` });
        adr = assembleAdr(template, slots);
      }
      otfPhases = assemblePhases(template, slots); // fases prontas p/ o modo_dev (sem re-parsear)
      return adr;
    };

    // OTF primeiro; se falhar de verdade, FALLBACK free-form SINALIZADO (não silencioso).
    const writeDoc = async (ctx) => {
      try { return await otfWriteDoc(ctx); }
      catch (e) { engine = "viva-freeform-fallback"; otfPhases = null; log(`[modo-adr] OTF FALHOU (${e?.message || e}) → fallback free-form (SINALIZADO)`); return await freeFormWriteDoc(ctx); }
    };

    // EXPRESS = 0 debate: o documentador escreve direto do briefing (OTF single-shot). mini/full = mesa viva
    // (encolhida ou completa). Reusa o MESMO writeDoc (OTF→fallback) nos dois — a forma do plano é idêntica.
    let res;
    if (cfg.skipDebate) {
      const plan0 = await writeDoc({ transcript: "(caminho EXPRESSO — sem debate da mesa; plano direto do briefing)", synthesis: bf });
      res = { document: plan0, rounds: 0, converged: true, snapshot: [] };
      log(`[modo-adr] caminho EXPRESSO: plano escrito sem debate (triagem ${triageInfo?.tier || "?"})`);
    } else {
      res = await caps.liveMesa.run(subject, { agents, writeDoc, minRounds: cfg.minRounds, maxRounds: cfg.maxRounds, facilitatorRole: "facilitador", embedder: caps.embedder, order: cfg.roles });
    }
    const plan = res.document;

    let written = null;
    if (caps.plan?.writeAdrPlan) {
      written = caps.plan.writeAdrPlan(plan); // adr-plan.md SEPARADO — a mesa NÃO toca no plan.md da sessão
      if (!written) throw new Error("modo-adr vivo: writeAdrPlan nao gravou o plano do ADR (sem workspaceDir?)");
    }
    if (caps.memory?.save) {
      const sv = await caps.memory.save(adrRecord(bf, plan), { type: "adr-registro", tags: ["adr", "registro"], namespace: ADR_NAMESPACE });
      if (sv && sv.ok === false) log(`[modo-adr] AVISO: memória não salvou o registro do ADR (${sv.error || "offline"})`);
      // snapshot dos sessionIds → permite REABRIR a mesa (resume) depois. Express não tem mesa → pula.
      if (res.snapshot && res.snapshot.length) {
        const svSnap = await caps.memory.save(JSON.stringify({ subject: bf.slice(0, 120), snapshot: res.snapshot }), { type: "adr-mesa-snapshot", tags: ["adr", "mesa-viva", "reabrir"], namespace: ADR_NAMESPACE });
        if (svSnap && svSnap.ok === false) log(`[modo-adr] AVISO: memória não salvou o snapshot da mesa (${svSnap.error || "offline"})`);
      }
    }

    let deepReview = null;
    if (deep && caps.deep?.review && caps.router) {
      const dp = await caps.deep.review({ material: plan, critiquePrompt: `Critique adversarialmente este PLANO: premissas furadas, fases faltando, riscos, reúso ignorado, entregas não verificáveis. Liste achados CONCRETOS, curto.\n\n${plan}`, router: caps.router, taskType: "planning" });
      if (dp.ok) { deepReview = { pass: dp.verdict.pass, findings: dp.verdict.findings, watch: dp.watch, families: dp.families }; }
      else log(`[modo-adr] deep indisponível (${dp.reason})`);
    }

    log(`[modo-adr VIVO] plano gerado (${plan.length} chars; caminho=${path}; ${res.rounds} voltas; convergiu=${res.converged}; motor=${engine}; fases=${otfPhases ? otfPhases.length : "?"}; escrito=${!!written})`);
    return { ok: true, plan, phases: otfPhases, roles: res.snapshot.map((s) => s.role), rounds: res.rounds, converged: res.converged, written, deepReview, engine, path, tier: triageInfo?.tier || null, triageSource: triageInfo?.source || null };
  }

  return {
    id: "modo-adr",

    /**
     * Constrói o plano vivo a partir do briefing.
     * @param {string} briefing
     * @param {{ factory?: object, memory?: object, plan?: object, deep?: object, router?: object }} caps
     * @param {{ deep?: boolean, taskType?: string, mesa?: string }} [opts]  deep = valida por painel multi-família;
     *   mesa = override do roteador de complexidade (auto|express|mini|full); auto = triagem decide.
     * @returns {Promise<{ok:boolean, plan?:string, roles?:string[], written?:string|null, deepReview?:object|null, path?:string, tier?:string, error?:string}>}
     */
    async buildPlan(briefing, caps = {}, { deep = false, taskType = null, mesa = "auto" } = {}) {
      const bf = String(briefing || "").trim();
      if (!bf) throw new Error("modo-adr.buildPlan: briefing vazio");
      if (!caps.factory?.run) throw new Error("modo-adr.buildPlan: caps.factory ausente");
      const gid = "adr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      const topic = bf.slice(0, 160);

      // 0) ROTEADOR DE COMPLEXIDADE: decide o CAMINHO (express|mini|full) antes de gastar a mesa inteira. Override
      // explícito (mesa=express|mini|full) pula a triagem; auto → triage (determinístico + desempate LLM na cinza).
      let path = "full", triageInfo = null;
      const ov = String(mesa || "auto").toLowerCase();
      if (["express", "mini", "full"].includes(ov)) { path = ov; triageInfo = { tier: "(override)", path, source: "override" }; log(`[modo-adr] caminho FORÇADO por override: ${path}`); }
      else {
        try { const t = await triage(bf, { factory: caps.factory, log }); path = t.path; triageInfo = t; log(`[modo-adr] triagem: tier=${t.tier} → caminho=${t.path} (${t.source})`); }
        catch (e) { log(`[modo-adr] triagem falhou (${e?.message || e}) → mesa COMPLETA (fail-safe)`); path = "full"; triageInfo = { tier: "?", path: "full", source: "triage-failed" }; }
      }

      // TELEMETRIA do roteador (Princípio 11): registra a decisão pra o safety-net do express não operar às cegas.
      // Best-effort SINALIZADO — falha de registro não derruba o plano.
      if (caps.onRoute) { try { caps.onRoute(triageInfo); } catch (e) { log(`[modo-adr] onRoute falhou (sinalizado): ${e?.message || e}`); } }

      // 1) o que JÁ EXISTE no projeto (memória). Offline = degradado explícito (não erro mascarado).
      // PISO DE RELEVÂNCIA: sem ele, um briefing curto/vago casa fracamente com QUALQUER coisa e o recall
      // devolve os planos que OUTRAS deliberações salvaram (a mesa grava cada plano na memória, então ela
      // envenena a si mesma). Foi assim que um briefing de uma linha virou um ADR sobre locks/owner.json:
      // 4 trechos de outro assunto entraram como "reúse" e dominaram o conteúdo. Abaixo do piso, é ruído.
      // 1) o que JÁ EXISTE no projeto. DUAS consultas de propósito, em escopos separados:
      //    (a) o escopo do PROJETO — conhecimento geral (memórias, lições, notas);
      //    (b) o ARQUIVO DE ADRs (`#adr`) — as DECISÕES anteriores da mesa.
      // Elas ficam separadas porque o problema original era a mesa consumir os PLANOS que ela mesma escrevia como
      // se fossem "o que já existe". Mas ignorar as decisões anteriores por completo trocaria envenenamento por
      // AMNÉSIA — e reusar decisão é justamente a dor que a memória existe para resolver. Então o arquivo é lido
      // no escopo próprio e entra ROTULADO como decisão anterior, nunca como matéria a consolidar.
      let existing = "";
      let priorAdrs = "";
      const mem = caps.memory?.recall ? await caps.memory.recall(bf, { topK: 4 }) : null;
      if (mem && mem.ok) {
        const rel = (mem.results || [])
          // Rede de segurança para o LEGADO: registros gravados ANTES da separação por namespace ainda vivem no
          // escopo principal e voltariam na busca. Este filtro por marcador cobre esses — e só esses. Ele NÃO é
          // mais a garantia (a garantia é o namespace, que não depende de chunker); é limpeza do que já ficou.
          .filter((r) => r && !String(r.text || "").includes(ADR_RECORD_MARK));
        const cortados = (mem.results || []).length - rel.length;
        if (cortados > 0) log(`[modo-adr] recall: ${cortados} registro(s) de ADR legado descartado(s) — a mesa não reconsome a própria saída`);
        existing = rel.map((r) => "- " + String(r.text || "").slice(0, 220)).join("\n");
      }
      else if (mem && mem.ok === false && mem.error) log(`[modo-adr] memória indisponível (${mem.error}) — segue sem contexto`);
      if (caps.memory?.recall) {
        try {
          const adrs = await caps.memory.recall(bf, { topK: 3, namespace: ADR_NAMESPACE });
          if (adrs && adrs.ok) priorAdrs = (adrs.results || []).map((r) => "- " + String(r.text || "").slice(0, 300)).join("\n");
        } catch (e) { log(`[modo-adr] arquivo de ADRs indisponível (sinalizado): ${e?.message || e}`); }
      }

      // MESA VIVA (debate real turno a turno) quando o motor está disponível OU no caminho express (que não usa a
      // mesa — só o documentador OTF). Senão, fan-out/fan-in LEGADO (sempre full — é fallback de teste).
      if (caps.liveMesa?.run || path === "express") return await buildPlanVivo(bf, existing, caps, { deep, taskType, path, triageInfo, priorAdrs });
      if (!caps.factory?.runMany) throw new Error("modo-adr.buildPlan (legado): caps.factory.runMany ausente");

      // 2) mesa de ADR: os papéis analisam o briefing grounded no que existe.
      const rolePrompt =
        `BRIEFING:\n${bf}\n\n` +
        `O QUE JÁ EXISTE NO PROJETO (memória — reúse, não reinvente):\n${existing || "(nada relevante)"}\n\n` +
        `No seu papel, dê o parecer que ajuda a montar um PLANO sólido (curto e acionável).`;
      const pareceres = await caps.factory.runMany(ADR_ROLES, rolePrompt, { stage: "adr", group: gid, topic });
      const failed = pareceres.filter((o) => !o.ok);
      if (failed.length) log(`[modo-adr] AVISO — papéis que FALHARAM: ${failed.map((f) => f.role + ": " + (f.error || "?")).join("; ")}`);
      if (failed.length === pareceres.length) throw new Error("modo-adr: TODOS os papeis da mesa falharam: " + failed.map((f) => f.role + ":" + f.error).join("; "));
      const notes = pareceres.filter((o) => o.ok && o.text).map((o) => `### ${o.title}\n${o.text}`).join("\n\n");
      if (!notes) throw new Error("modo-adr: nenhum parecer produzido");

      // 3) o DOCUMENTADOR escreve o plano em FASES. FAIL LOUD — se falha, NÃO usa as notas cruas como plano.
      const planPrompt =
        `BRIEFING:\n${bf}\n\n` +
        `${existing ? "JÁ EXISTE (reúse):\n" + existing + "\n\n" : ""}` +
        `PARECERES DA MESA DE ADR:\n${notes}\n\n` +
        `Escreva um PLANO DE EXECUÇÃO em markdown. FORMATO OBRIGATÓRIO: cada fase é um CABEÇALHO "## Fase N: <título>" ` +
        `seguido de (a) OBJETIVO; (b) REQUISITO concreto e AUTOSSUFICIENTE com os critérios TESTÁVEIS (quem implementa ` +
        `a fase não deve precisar de outra fase nem do briefing); (c) ENTREGA VERIFICÁVEL. Aproveite o reúso. Escreva o ` +
        `CONTEÚDO de CADA fase POR EXTENSO — NÃO liste só os títulos, NÃO diga que "criou um plano", NÃO escreva ` +
        `preâmbulo nem peça autorização. Comece direto em "## Fase 1".`;
      const doc = await caps.factory.run("documentacao", planPrompt, { timeoutMs: 150000, stage: "adr", group: gid, topic });
      if (!doc.ok || !textOf(doc)) throw new Error("modo-adr: documentador falhou ao escrever o plano: " + (doc.error || "sem texto"));
      const plan = textOf(doc);

      // 4) grava o plano vivo (REQUERIDO — falha SOBE) + memória (opcional, resultado surfaced).
      let written = null;
      if (caps.plan?.writeAdrPlan) {
        written = caps.plan.writeAdrPlan(plan); // adr-plan.md SEPARADO — a mesa NÃO toca no plan.md (fail-loud)
        if (!written) throw new Error("modo-adr: writeAdrPlan nao gravou o plano do ADR (sem workspaceDir?)");
      }
      const saved = caps.memory?.save ? await caps.memory.save(adrRecord(bf, plan), { type: "adr-registro", tags: ["adr", "registro"], namespace: ADR_NAMESPACE }) : null;
      if (saved && saved.ok === false) log(`[modo-adr] AVISO: memória não salvou o plano (${saved.error || "offline"})`);

      // 5) VALIDAÇÃO PROFUNDA (opt-in): painel multi-família critica o PLANO → riscos corroborados × isolados.
      // Não reescreve o plano automaticamente: SURFAÇA os achados (o agente/humano decide endurecer). Degrada sinalizado.
      let deepReview = null;
      if (deep && caps.deep?.review && caps.router) {
        const dp = await caps.deep.review({ material: plan, critiquePrompt: `Critique adversarialmente este PLANO: premissas furadas, fases faltando, riscos, reúso ignorado, entregas não verificáveis. Liste achados CONCRETOS, curto.\n\n${plan}`, router: caps.router, taskType: "planning" });
        if (dp.ok) { deepReview = { pass: dp.verdict.pass, findings: dp.verdict.findings, watch: dp.watch, families: dp.families }; log(`[modo-adr] validação PROFUNDA (painel ${dp.families.join("+")}): pass=${dp.verdict.pass}, ${dp.verdict.findings.length} corroborado(s)`); }
        else log(`[modo-adr] deep indisponível (${dp.reason}) — plano sem validação profunda`);
      }

      log(`[modo-adr] plano gerado (${plan.length} chars; ${pareceres.filter((o) => o.ok).length} papéis; escrito=${!!written})`);
      return { ok: true, plan, roles: pareceres.map((o) => o.role), failedRoles: failed.map((f) => f.role), written, deepReview };
    },
  };
}
