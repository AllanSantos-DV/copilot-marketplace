// PAINEL DE CONSENSO MULTI-FAMÍLIA ("modo profundo"). Manda o MESMO material para modelos de FAMÍLIAS
// diferentes (claude, gpt, gemini… conforme disponibilidade) EM PARALELO e CONSOLIDA: achado corroborado por
// ≥2 famílias = alta confiança; isolado (1 só) = a verificar. Famílias diferentes têm pontos-cegos diferentes,
// então o consenso pega o que um revisor único (mesmo rotacionado) deixaria passar. Custa MUITO mais token →
// é OPT-IN (deepMode, OFF por padrão). Serve p/ qualquer escopo (código de banco, segurança, conceito abstrato),
// não só pesquisa. Degradação HONESTA e SINALIZADA: sem ≥minFamilies famílias → ok:false, reason (NÃO finge
// painel; o caller cai no revisor único). FAIL LOUD em falha real do painel/consolidação.

import { extractJson } from "../util/extractJson.mjs";

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

export function createDeepPanel({ factory, log = () => {} } = {}) {
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
     * @returns {{ ok:true, verdict:{pass,findings,escalate}, watch:string[], families:string[], panel:object[] }
     *          | { ok:false, reason:"insufficient-families", families:string[] }}
     */
    async review({ material, critiquePrompt, router, taskType = null, panelRole = "revisor", minFamilies = 2, maxFamilies = 3, timeoutMs = 120000 } = {}) {
      if (!material || !critiquePrompt) throw new Error("deepPanel.review: material/critiquePrompt ausente");
      const fams = familiesFor(router, { role: panelRole, taskType, maxFamilies });
      if (fams.length < minFamilies) {
        log(`[deep] famílias insuficientes (${fams.length}<${minFamilies}) — degrada p/ revisor único`);
        return { ok: false, reason: "insufficient-families", families: fams.map((f) => f.family) };
      }
      log(`[deep] painel de ${fams.length} famílias: ${fams.map((f) => f.family + "@" + f.model).join(", ")}`);

      // 1) crítica em PARALELO, cada família com seu modelo (override).
      const outs = await Promise.all(fams.map(async (f) => {
        const r = await factory.run(panelRole, critiquePrompt, { subject: panelRole, timeoutMs, model: f.model, stage: "deep" });
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
      const consModel = router?.route ? router.route({ role: "facilitador", taskType }).model : null;
      const pareceres = okOuts.map((o) => `### FAMÍLIA ${o.family} (${o.model})\n${o.text}`).join("\n\n");
      const consPrompt =
        `Vários revisores de FAMÍLIAS de modelo diferentes avaliaram o MESMO material em paralelo. Consolide num ` +
        `veredito único, distinguindo o CORROBORADO (≥2 famílias apontaram — alta confiança) do ISOLADO (1 só — a verificar).\n\n` +
        `MATERIAL:\n${material}\n\nPARECERES DO PAINEL (${okOuts.length} famílias):\n${pareceres}\n\n` +
        `CHAME a ferramenta submit_panel_verdict com o veredito consolidado. NÃO responda em texto.`;
      const cr = await factory.run("facilitador", consPrompt, { subject: "facilitador", timeoutMs, model: consModel || undefined, schema: PANEL_VERDICT_SCHEMA, availableTools: [] });
      if (!cr.ok || !cr.text) throw new Error("deepPanel.consolidate: meta-revisor falhou: " + (cr.error || "sem texto"));
      const j = parseJson(cr.text);
      if (!j || j.__nosubmit__ || typeof j.pass !== "boolean") throw new Error("deepPanel.consolidate: meta-revisor nao submeteu {pass}: " + String(cr.text).slice(0, 200));

      return {
        ok: true,
        verdict: { pass: !!j.pass, findings: Array.isArray(j.mustFix) ? j.mustFix.map(String) : [], escalate: j.escalate ? String(j.escalate) : null },
        watch: Array.isArray(j.watch) ? j.watch.map(String) : [],
        families: okOuts.map((o) => o.family),
        panel: outs,
      };
    },
  };
}
