// AGENTE DE AUTO-MELHORIA (tel-3) — meta-agente Reflexion/Gödel-style que roda SEPARADO do hot path. Lê o
// relatório de GAPS (determinístico, tel-2) + amostra de traces e PROPÕE melhorias da mesa sob os GATES:
//   1) PRINCÍPIO 11 — cada melhoria é "tool" (determinística) ou "agent" (heurística)? Se um TOOL resolve sem
//      heurística (ex.: template/assembler), PRESCREVE o tool.
//   2) ANTI-BOILERPLATE — não reinventar; simplificar; colapsar passos que dão volta (desvio circular).
//   3) CAMINHO-ABC — se um gap é dead-end ("não dá A→C direto"), FORÇAR a rota alternativa A→B→C.
// NÃO auto-aplica (applied:false): devolve PROPOSTAS versionáveis/auditáveis — o dono decide (gate humano).
// FAIL LOUD: agente sem JSON → LANÇA. runAgent injetável (worker meta real ou stub).

import { extractJson } from "../util/extractJson.mjs";

// TOOL TEMPLATE das propostas (Princípio 11) — schema imposto pelo SDK. FAIL-LOUD (offline, gate humano).
const PROPOSALS_SCHEMA = {
  name: "submit_proposals",
  description: "Propostas concretas de melhoria da mesa, cada uma sob um dos 3 gates.",
  parameters: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            gap: { type: "string", description: "tipo/onde o gap ocorre" },
            kind: { type: "string", enum: ["tool", "agent"], description: "tool=determinística, agent=heurística" },
            change: { type: "string", description: "o que mudar (concreto)" },
            gate: { type: "string", enum: ["principio-11", "anti-boilerplate", "caminho-abc"] },
            abc: { type: "string", description: "se caminho-abc, a rota A→B→C; senão vazio" },
          },
          required: ["gap", "kind", "change", "gate"],
        },
      },
      summary: { type: "string", description: "1 linha" },
    },
    required: ["proposals"],
  },
};

/**
 * @param {{ gaps:{gaps:object[],counts:object}, sample?:object[], runAgent:(p:string,schema?:object)=>Promise<{ok,text?,error?}> }} args
 * @returns {Promise<{ ok:true, proposals:object[], summary:string, applied:false }>}
 */
export async function proposeImprovements({ gaps, sample = [], runAgent }, { log = () => {} } = {}) {
  if (typeof runAgent !== "function") throw new Error("selfImprove: runAgent ausente");
  const g = gaps && Array.isArray(gaps.gaps) ? gaps : { gaps: [], counts: {} };
  if (!g.gaps.length) { log("[auto-melhoria] sem gaps na janela — nada a propor"); return { ok: true, proposals: [], summary: "sem gaps na janela", applied: false }; }

  const prompt =
    `Você é o AGENTE DE AUTO-MELHORIA da mesa (roda SEPARADO, não intervém ao vivo). Abaixo os GAPS ` +
    `DETERMINÍSTICOS detectados na telemetria (onde a mesa travou) + amostra de traces. Proponha melhorias ` +
    `CONCRETAS da mesa, cada uma passando pelos GATES:\n` +
    `1) PRINCÍPIO 11: a melhoria é "tool" (determinística) ou "agent" (heurística)? Se um TOOL resolve sem heurística, prescreva o tool.\n` +
    `2) ANTI-BOILERPLATE: não reinventar; simplificar; colapsar passos que dão volta (desvio circular A→…→C).\n` +
    `3) CAMINHO-ABC: se um gap é um beco sem saída ("não dá A→C direto"), proponha a ROTA alternativa A→B→C.\n\n` +
    `GAPS (contagem): ${JSON.stringify(g.counts)}\nGAPS (detalhe):\n${g.gaps.slice(0, 20).map((x) => `- [${x.type}] ${x.role || "?"} (${x.traceId || "?"}): ${x.detail || ""}`).join("\n")}\n\n` +
    `AMOSTRA DE TRACES:\n${(sample || []).slice(0, 20).map((s) => `- ${s.role || "?"}/${s.stage || "?"} ${s.status || "?"} ${s.durationMs != null ? s.durationMs + "ms" : "?"}`).join("\n") || "(sem amostra)"}\n\n` +
    `CHAME submit_proposals com o array de propostas. NÃO responda em texto.`;

  const r = await runAgent(prompt, PROPOSALS_SCHEMA);
  if (!r || !r.ok || !r.text) throw new Error("selfImprove: agente de auto-melhoria falhou: " + (r?.error || "sem texto"));
  const j = extractJson(r.text);
  if (!j || j.__nosubmit__ || !Array.isArray(j.proposals)) throw new Error("selfImprove: não submeteu {proposals}: " + String(r.text).slice(0, 200));

  const proposals = j.proposals.map((p) => ({
    gap: String(p.gap || ""),
    kind: p.kind === "tool" ? "tool" : "agent",
    change: String(p.change || ""),
    gate: String(p.gate || ""),
    abc: p.abc ? String(p.abc) : null,
  }));
  log(`[auto-melhoria] ${proposals.length} proposta(s) — NÃO auto-aplicadas (versionar/auditar; gate do dono). tipos: ${proposals.map((p) => p.kind).join(",") || "-"}`);
  return { ok: true, proposals, summary: String(j.summary || ""), applied: false };
}
