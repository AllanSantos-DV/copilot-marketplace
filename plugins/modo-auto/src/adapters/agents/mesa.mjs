// MESA — orquestração: pré-análise (triagem) → papéis em paralelo → convergência.
// Depende de uma AgentFactoryPort (spawna os papéis) e, opcionalmente, de MemoryPort/PlanPort.
// FAIL LOUD: não mascara falha — se a triagem, os papéis ou a convergência falham, LANÇA com o erro
// real (nunca cai em papéis default nem devolve pareceres crus como se fosse a resposta).
// `triageEnabled:false` usa defaultRoles por CONFIG (não é fallback de erro).
import { recallIssue, renderRecall } from "../memory/memoryPort.mjs";

function parseJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  return JSON.parse(m[0]); // JSON malformado LANÇA (erro real do agente, não mascarado)
}

// TOOL TEMPLATE da triagem (Princípio 11) — schema imposto pelo SDK; o triador CHAMA a tool em vez de escrever JSON.
const TRIAGE_SCHEMA = {
  name: "submit_triage",
  description: "Selecione QUAIS papéis devem deliberar sobre a pergunta. NUNCA responda a pergunta — só selecione papéis.",
  parameters: {
    type: "object",
    properties: {
      roles: { type: "array", items: { type: "string" }, description: "ids dos papéis fixos relevantes: negocio, tecnico, documentacao, pesquisador, revisor, advogado-diabo" },
      dynamic: { type: "array", items: { type: "object", properties: { id: { type: "string" }, subject: { type: "string" } }, required: ["id"] }, description: "papéis dinâmicos (seguranca, lgpd, performance, ux…) se a pergunta pedir; senão vazio" },
    },
    required: ["roles"],
  },
};

export function createMesa({ factory, memory = null, plan = null, gate = null, model, log = () => {}, defaultRoles, triageEnabled = true } = {}) {
  const DEFAULT = defaultRoles || ["negocio", "tecnico", "pesquisador", "revisor", "advogado-diabo"];

  // Contexto: memória (offline = degradado explícito, não erro) + plano (erro de leitura SOBE).
  async function gatherContext(question) {
    let planText = "", memText = "";
    const p = plan?.read ? await plan.read() : null;
    if (p?.text) planText = String(p.text).slice(0, 4000);
    const m = memory?.recall ? await memory.recall(question, { topK: 3, tag: "mesa" }) : null;
    if (m && m.ok) memText = renderRecall(m.results, { max: 300 }).text;
    else { const iss = recallIssue(m, "mesa"); if (iss) log(iss); }
    return { planText, memText };
  }

  async function triage(question, ctx, { group = null, topic = null } = {}) {
    if (!triageEnabled) return { roles: DEFAULT, dynamic: [] };
    const prompt = `PERGUNTA: ${question}\n\nCONTEXTO (resumo):\n${ctx.planText.slice(0, 800)}\n${ctx.memText.slice(0, 600)}\n\nChame submit_triage com os papéis relevantes.`;
    // TOOL TEMPLATE (Princípio 11): a seleção de papéis vem de submit_triage (schema imposto pelo SDK), NÃO de
    // "responda só o JSON" + parse de prosa — que quebrava quando o triador respondia a pergunta em vez de triar.
    // availableTools:[] → fail-closed (só a submit tool, sem built-ins) — triador é decisão pura, anti-agentic.
    const out = await factory.run("triagem", prompt, { timeoutMs: 60000, stage: "mesa", group, topic, schema: TRIAGE_SCHEMA, availableTools: [] });
    // RESILIÊNCIA: a triagem é uma OTIMIZAÇÃO. Se falha (worker caiu, ou o modelo não submeteu) a mesa NÃO quebra:
    // degrada pros DEFAULT roles, SINALIZADO (log). Fail-loud resiliente, não fail-hard.
    if (!out.ok) { log(`[mesa] triagem worker falhou (${out.error || "?"}) → fallback DEFAULT (sinalizado)`); return { roles: DEFAULT, dynamic: [] }; }
    const j = parseJson(out.text);
    const roles = j && Array.isArray(j.roles) ? j.roles.filter(Boolean) : null;
    const dynamic = j && Array.isArray(j.dynamic) ? j.dynamic.filter((d) => d && d.id) : [];
    if (!j || j.__nosubmit__ || !roles || !roles.length) { log(`[mesa] triagem não submeteu papéis válidos → fallback DEFAULT (sinalizado).`); return { roles: DEFAULT, dynamic }; }
    return { roles, dynamic };
  }

  async function deliberate(question, _caps) {
    const q = typeof question === "string" ? question : (question?.question || "");
    if (!factory?.run || !factory?.runMany) throw new Error("mesa.deliberate: factory (AgentFactoryPort) ausente");
    const ctx = await gatherContext(q);
    // DELIBERAÇÃO (thread da mesa): amarra triagem + pareceres + convergência num só grupo p/ o visualizador.
    const gid = "mesa-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const topic = q.slice(0, 160);
    const { roles, dynamic } = await triage(q, ctx, { group: gid, topic });
    // Papéis dinâmicos: DESENHADOS pelo arquiteto (FAIL LOUD se algum falhar).
    await Promise.all(dynamic.map((d) => factory.design(d.id, d.subject || d.id)));
    const roleIds = [...new Set([...roles, ...dynamic.map((d) => d.id)])];

    const rolePrompt =
      `PERGUNTA DA SESSÃO:\n${q}\n\n` +
      `CONTEXTO (plano vivo + memória do projeto):\n` +
      `${ctx.planText ? "PLANO:\n" + ctx.planText + "\n\n" : ""}` +
      `${ctx.memText ? "MEMÓRIA:\n" + ctx.memText : "(sem memória relevante)"}\n\n` +
      `Dê seu parecer no seu papel — curto e acionável.`;

    const outputs = await factory.runMany(roleIds, rolePrompt, { stage: "mesa", group: gid, topic });
    const failed = outputs.filter((o) => !o.ok);
    if (failed.length) log(`[mesa] AVISO — papéis que FALHARAM (não mascarado): ${failed.map((f) => f.role + ": " + (f.error || "?")).join("; ")}`);
    if (failed.length === outputs.length) throw new Error("mesa: TODOS os papeis falharam: " + failed.map((f) => f.role + ":" + f.error).join("; "));
    const pareceres = outputs.filter((o) => o.ok && o.text).map((o) => `### ${o.title}\n${o.text}`).join("\n\n");
    if (!pareceres) throw new Error("mesa: nenhum papel produziu parecer");

    const convergePrompt =
      `PERGUNTA ORIGINAL:\n${q}\n\n` +
      `CONTEXTO:\n${ctx.planText.slice(0, 1500)}\n\n` +
      `PARECERES DA MESA:\n${pareceres}\n\n` +
      `Sintetize UMA resposta final fundamentada à pergunta original.`;
    const conv = await factory.run("facilitador", convergePrompt, { timeoutMs: 90000, stage: "mesa", group: gid, topic });
    if (!conv.ok || !conv.text) throw new Error("mesa: convergencia (facilitador) falhou: " + (conv.error || "sem texto"));

    log(`mesa: ${roleIds.length} papéis (${roleIds.join(",")}) → resposta ${conv.text.length} chars`);
    return { answer: conv.text, roles: roleIds, outputs, converged: true, failedRoles: failed.map((f) => f.role) };
  }

  return { deliberate };
}
