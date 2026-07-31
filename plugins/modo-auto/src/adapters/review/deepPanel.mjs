// PAINEL DE CONSENSO MULTI-FAMÍLIA ("modo profundo"). Manda o MESMO material para modelos de FAMÍLIAS
// diferentes (claude, gpt, gemini… conforme disponibilidade) EM PARALELO e CONSOLIDA: achado corroborado por
// ≥2 famílias = alta confiança; isolado (1 só) = a verificar. Famílias diferentes têm pontos-cegos diferentes,
// então o consenso pega o que um revisor único (mesmo rotacionado) deixaria passar. Custa MUITO mais token →
// é OPT-IN (deepMode, OFF por padrão). Serve p/ qualquer escopo (código de banco, segurança, conceito abstrato),
// não só pesquisa. Degradação HONESTA e SINALIZADA: sem ≥minFamilies famílias → ok:false, reason (NÃO finge
// painel; o caller cai no revisor único). FAIL LOUD em falha real do painel/consolidação.

import { extractJson } from "../util/extractJson.mjs";

// Orçamento GLOBAL do painel, em ms. NÃO é número mágico — sai da telemetria real deste produto
// (`~/.modo-auto/telemetry/traces.jsonl`, 1824 spans com `stage:"deep"`): P50 200s · P95 544s · P99 848s ·
// MÁX 1971s, com 39 spans terminando em `hung`. 900s fica acima do P99, então corta a cauda patológica (o
// worker pendurado, que era o dano real) sem derrubar painel legítimo. Se a distribuição mudar, este número
// muda COM ELA — a medição é o dono do valor, não a intuição.
const DEFAULT_TOTAL_MS = 900000;

function parseJson(t) { return extractJson(t); }

// TOOL TEMPLATE do consolidador do painel profundo (Princípio 11).
const PANEL_VERDICT_SCHEMA = {
  name: "submit_panel_verdict",
  description: "Consolide o veredito do painel multi-família, distinguindo corroborado × isolado.",
  parameters: {
    type: "object",
    properties: {
      pass: { type: "boolean", description: "true se a fase passa" },
      mustFix: { type: "array", items: { type: "string" }, description: "achados CORROBORADOS (≥2 famílias) a corrigir" },
      watch: { type: "array", items: { type: "string" }, description: "achados ISOLADOS (1 família) a verificar" },
      escalate: { type: "string", description: "decisão travada que o time não resolve, ou vazio" },
    },
    required: ["pass"],
  },
};

// família a partir do id do modelo (claude-*, gpt-*, gemini-*…).
export function familyOf(id) {
  const s = String(id || "").toLowerCase();
  if (s.startsWith("claude")) return "claude";
  if (s.startsWith("gpt")) return "gpt";
  if (s.startsWith("gemini")) return "gemini";
  if (/^o\d/.test(s)) return "openai-o";
  return "outro:" + (s.split(/[-.]/)[0] || "?");
}

// escolhe o melhor modelo de cada família DISTINTA (na ordem de preferência dada), até maxFamilies.
export function pickFamilies(rankedModels, maxFamilies = 3) {
  const seen = new Set(); const picks = [];
  for (const id of rankedModels || []) {
    const fam = familyOf(id);
    if (seen.has(fam)) continue;
    seen.add(fam); picks.push({ family: fam, model: id });
    if (picks.length >= maxFamilies) break;
  }
  return picks;
}

/**
 * @param {{ factory:object, log?:(m:string)=>void, memoryScopeProvider?:()=>string|null }} a
 *   `memoryScopeProvider` é o ESCOPO por injeção, resolvido no gargalo. A primeira versão recebia `memoryScope`
 *   por chamada, e de 7 call-sites só 1 passava — os outros 6 nasciam cegos, em silêncio. É a terceira vez nesta
 *   sessão que "consertar um chamador não conserta a classe" me pega; aqui a regra passa a viver na criação do
 *   painel, e nenhuma chamada precisa lembrar. Um `memoryScope` explícito na chamada ainda vence (para o caso
 *   raro de auditar OUTRO projeto), mas o default deixa de ser a cegueira.
 */
export function createDeepPanel({ factory, log = () => {}, memoryScopeProvider = null } = {}) {
  if (!factory?.run) throw new Error("deepPanel: factory (AgentFactoryPort) ausente");

  // famílias distintas p/ o painel: preferência da capacidade + qualquer família disponível não representada.
  function familiesFor(router, { role = "revisor", taskType = null, maxFamilies = 3 } = {}) {
    const ranked = router?.ranked ? router.ranked({ role, taskType }) : [];
    const picks = pickFamilies(ranked, maxFamilies);
    if (router?.available) {
      const seen = new Set(picks.map((p) => p.family));
      for (const id of router.available()) { const fam = familyOf(id); if (!seen.has(fam)) { seen.add(fam); picks.push({ family: fam, model: id }); } }
    }
    return picks.slice(0, maxFamilies);
  }

  return {
    familiesFor,

    /**
     * Roda o MESMO material em N famílias e consolida num veredito único.
     *
     * ORÇAMENTO: `timeoutMs` é o watchdog de OCIOSIDADE do worker (mata quem parou de produzir) — ele NUNCA foi
     * um teto de duração, e tratá-lo como teto foi o erro que deixou o painel sem relógio. A TELEMETRIA REAL
     * (1824 spans de família, `stage:"deep"`) mostra o tamanho do buraco: P50 200s, P95 544s, P99 848s,
     * MÁX 1971s — **1376 de 1824 famílias (75%) passaram dos supostos 120s**, e 39 terminaram como `hung`.
     * O teto de parede de verdade é `maxWallMs` do factory (default `Infinity` = sem limite), que este painel
     * não passava. `totalMs` agora é o orçamento GLOBAL, e o consolidador recebe o que SOBROU — não um teto novo.
     * O default de 900s vem da medição, não de palpite: corta a cauda patológica (P99=848s e os `hung`) sem
     * matar o painel legítimo. Estourar o orçamento devolve `ok:false` — o MESMO contrato de degradação que os
     * chamadores já tratam (caem no revisor único), então o parcial é SINALIZADO sem inventar contrato novo.
     * @returns {{ ok:true, verdict:{pass,findings,escalate}, watch:string[], families:string[], panel:object[], elapsedMs:number }
     *          | { ok:false, reason:"insufficient-families"|"panel-degraded"|"deadline", families:string[] }}
     */
    async review({ material, critiquePrompt, router, taskType = null, panelRole = "revisor", minFamilies = 2, maxFamilies = 3, timeoutMs = 120000, totalMs = DEFAULT_TOTAL_MS, memoryScope = null } = {}) {
      if (!material || !critiquePrompt) throw new Error("deepPanel.review: material/critiquePrompt ausente");
      const t0 = Date.now();
      // Escopo do painel: o explícito vence; senão vem do provider do gargalo. Nunca cego por omissão.
      const escopo = memoryScope != null ? memoryScope : (() => { try { return memoryScopeProvider ? memoryScopeProvider() : null; } catch { return null; } })();
      const restante = () => (Number.isFinite(totalMs) ? Math.max(0, totalMs - (Date.now() - t0)) : Infinity);
      const fams = familiesFor(router, { role: panelRole, taskType, maxFamilies });
      if (fams.length < minFamilies) {
        log(`[deep] famílias insuficientes (${fams.length}<${minFamilies}) — degrada p/ revisor único`);
        return { ok: false, reason: "insufficient-families", families: fams.map((f) => f.family) };
      }
      log(`[deep] painel de ${fams.length} famílias: ${fams.map((f) => f.family + "@" + f.model).join(", ")}` +
          (Number.isFinite(totalMs) ? ` · orçamento global ${Math.round(totalMs / 1000)}s` : " · SEM orçamento global"));

      // 1) crítica em PARALELO, cada família com seu modelo (override). `maxWallMs` é o relógio de PAREDE — é
      // ele que mata a família pendurada; o `timeoutMs` só cobre ociosidade.
      const outs = await Promise.all(fams.map(async (f) => {
        const r = await factory.run(panelRole, critiquePrompt, { subject: panelRole, timeoutMs, maxWallMs: restante(), model: f.model, stage: "deep", memoryScope: escopo });
        return { family: f.family, model: f.model, ok: r.ok, text: r.ok ? r.text : "", error: r.error || null };
      }));
      const okOuts = outs.filter((o) => o.ok && o.text);
      if (okOuts.length < minFamilies) {
        // DEGRADA (não lança): uma família que PENDURA/falha em runtime é INDISPONIBILIDADE, não erro do
        // painel — mesmo contrato da checagem upfront (acima): ok:false → o caller cai no revisor único.
        // FAIL LOUD fica reservado à falha REAL do painel/consolidação (meta-revisor sem JSON), NÃO a um
        // modelo lento/fora do ar. Sem isso, um único worker pendurado derrubava TODO modo com deep ON
        // (onStop, modo_adr, modo_dev, reuso/segurança, sombra, deep_gate).
        const failures = outs.filter((o) => !o.ok).map((o) => o.family + ":" + (o.error || "?")).join("; ");
        log(`[deep] só ${okOuts.length}<${minFamilies} famílias responderam (${failures || "?"}) — degrada p/ revisor único`);
        return { ok: false, reason: "panel-degraded", families: okOuts.map((o) => o.family), failures };
      }

      // 2) CONSOLIDAÇÃO (meta-revisor no melhor modelo de reasoning): distingue corroborado × isolado.
      // O consolidador recebe o que SOBROU do orçamento — dar-lhe um teto novo era o que fazia o pior caso ser
      // "famílias + consolidador" em vez de "orçamento". Se não sobrou tempo, DEGRADA sinalizado: um veredito
      // consolidado às pressas seria pior que dizer "não deu" e cair no revisor único.
      if (restante() <= 0) {
        log(`[deep] orçamento global de ${Math.round(totalMs / 1000)}s ESTOUROU antes de consolidar (${okOuts.length} famílias responderam) — degrada p/ revisor único (parcial SINALIZADO)`);
        return { ok: false, reason: "deadline", families: okOuts.map((o) => o.family), elapsedMs: Date.now() - t0 };
      }
      const consModel = router?.route ? router.route({ role: "facilitador", taskType }).model : null;
      const pareceres = okOuts.map((o) => `### FAMÍLIA ${o.family} (${o.model})\n${o.text}`).join("\n\n");
      const consPrompt =
        `Vários revisores de FAMÍLIAS de modelo diferentes avaliaram o MESMO material em paralelo. Consolide num ` +
        `veredito único, distinguindo o CORROBORADO (≥2 famílias apontaram — alta confiança) do ISOLADO (1 só — a verificar).\n\n` +
        `MATERIAL:\n${material}\n\nPARECERES DO PAINEL (${okOuts.length} famílias):\n${pareceres}\n\n` +
        `CHAME a ferramenta submit_panel_verdict com o veredito consolidado. NÃO responda em texto.`;
      const cr = await factory.run("facilitador", consPrompt, { subject: "facilitador", timeoutMs, maxWallMs: restante(), model: consModel || undefined, schema: PANEL_VERDICT_SCHEMA, availableTools: [] });
      if (!cr.ok || !cr.text) throw new Error("deepPanel.consolidate: meta-revisor falhou: " + (cr.error || "sem texto"));
      const j = parseJson(cr.text);
      if (!j || j.__nosubmit__ || typeof j.pass !== "boolean") throw new Error("deepPanel.consolidate: meta-revisor nao submeteu {pass}: " + String(cr.text).slice(0, 200));

      return {
        ok: true,
        verdict: { pass: !!j.pass, findings: Array.isArray(j.mustFix) ? j.mustFix.map(String) : [], escalate: j.escalate ? String(j.escalate) : null },
        watch: Array.isArray(j.watch) ? j.watch.map(String) : [],
        families: okOuts.map((o) => o.family),
        panel: outs,
        elapsedMs: Date.now() - t0,
      };
    },
  };
}
