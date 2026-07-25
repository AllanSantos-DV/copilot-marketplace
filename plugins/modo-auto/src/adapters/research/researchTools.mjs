// researchTools.mjs — as 2 TOOLS de pesquisa real do papel pesquisador (molde verifyTools: {name,description,
// parameters,handler}). FACTORY (não array estático) porque o CAP vive no CLOSURE por-instância: o worker cria
// UMA instância por sessão → o limite é por-sessão-de-worker (resolve a crítica do painel: contador module-level
// resetaria a cada spawn). Handlers ASYNC (rede). Cada handler devolve JSON string e NUNCA lança pro modelo.
// Sinal de confiança = METADADO FACTUAL (count/single_source) computado aqui — não texto que depende do modelo
// obedecer (o prompt em roles complementa, mas o enforcement honesto é este fato estrutural).
import { safeUrl, cleanQuery, cleanOutput } from "./guards.mjs";
import { searchViaDdg } from "./providers/ddgSearch.mjs";
import { searchViaBrave } from "./providers/braveSearch.mjs";
import { readViaJina } from "./providers/jinaReader.mjs";
import { loadResearchConfig, resolveSearchProvider } from "./config.mjs";

export const RESEARCH_TOOL_NAMES = ["web_search", "web_read"];
const DEFAULT_CAPS = { search: 5, read: 10 };

export function createResearchTools({ caps = {}, fetchImpl, timeoutMs = 15000, config } = {}) {
  // estado de cap no closure — uma instância por sessão de worker
  const state = {
    search: { used: 0, max: Number(caps.search ?? DEFAULT_CAPS.search) },
    read: { used: 0, max: Number(caps.read ?? DEFAULT_CAPS.read) },
    signals: [], // confiança de cada resultado usado — base do enforcement determinístico do sinal (Guard 5)
  };
  const overCap = (k) => (state[k].used >= state[k].max
    ? { ok: false, error: "cap_exhausted", tool: k === "search" ? "web_search" : "web_read", used: state[k].used, max: state[k].max }
    : null);
  // Resolve o PROVIDER de busca via config (~/.modo-auto/config.json): brave (premium+key) ou jina-ddg (grátis).
  // Erro de config (JSON inválido, provider explícito sem key) é CAPTURADO → vira {ok:false} na tool (FAIL-LOUD
  // visível ao modelo), nunca quebra o worker.
  let searchPlan = null, searchPlanErr = null;
  try { const cfg = config || loadResearchConfig(); const r = resolveSearchProvider(cfg); searchPlan = { provider: r.provider, reason: r.reason, braveKey: cfg.keys.brave }; }
  catch (e) { searchPlanErr = String(e?.message || e); }

  const tools = [
    {
      name: "web_search",
      description: "Busca na WEB (DuckDuckGo via Jina Reader, grátis). Devolve JSON {ok, results:[{title,url,snippet}], count, single_source}. Use para achar o estado da arte / versão atual / fontes ANTES de opinar. Depois use web_read numa url para ler a fonte inteira.",
      parameters: { type: "object", properties: { query: { type: "string", description: "o que buscar (curto e específico)" } }, required: ["query"] },
      handler: async (a) => {
        try {
          if (searchPlanErr) return JSON.stringify({ ok: false, error: "config_error", detail: searchPlanErr });
          const cap = overCap("search"); if (cap) return JSON.stringify(cap);
          const cq = cleanQuery(a?.query); if (!cq.ok) return JSON.stringify(cq);
          const r = searchPlan.provider === "brave"
            ? await searchViaBrave(cq.query, { apiKey: searchPlan.braveKey, timeoutMs, fetchImpl })
            : await searchViaDdg(cq.query, { timeoutMs, fetchImpl });
          if (!r.ok) return JSON.stringify(r); // provider (inclusive brave explícito) falhou → FAIL-LOUD, não cai calado no grátis
          state.search.used++;
          const results = r.results.map((x) => ({ title: cleanOutput(x.title).slice(0, 160), url: x.url, snippet: cleanOutput(x.snippet) }));
          const confidence = results.length <= 1 ? "BAIXA" : results.length === 2 ? "MEDIA" : "ALTA";
          state.signals.push(confidence);
          return JSON.stringify({ ok: true, via: r.via, degraded: !!r.degraded, query: cq.query, count: results.length, single_source: results.length <= 1, confidence, results });
        } catch (e) { return JSON.stringify({ ok: false, error: "handler_error", detail: String((e && e.message) || e).slice(0, 160) }); }
      },
    },
    {
      name: "web_read",
      description: "LÊ uma página web e devolve o conteúdo em markdown limpo (Jina Reader, grátis). JSON {ok, url, markdown, via, single_source:true}. Use para ler a fonte inteira de uma url (ex.: vinda do web_search). Só https; alvos locais/privados são bloqueados.",
      parameters: { type: "object", properties: { url: { type: "string", description: "url https da página a ler" } }, required: ["url"] },
      handler: async (a) => {
        try {
          const cap = overCap("read"); if (cap) return JSON.stringify(cap);
          const su = safeUrl(a?.url); if (!su.ok) return JSON.stringify(su);
          const r = await readViaJina(su.url, { timeoutMs, fetchImpl });
          if (!r.ok) return JSON.stringify(r);
          state.read.used++;
          state.signals.push("BAIXA");
          return JSON.stringify({ ok: true, via: r.via, degraded: !!r.degraded, url: su.url, single_source: true, confidence: "BAIXA", markdown: cleanOutput(r.markdown) });
        } catch (e) { return JSON.stringify({ ok: false, error: "handler_error", detail: String((e && e.message) || e).slice(0, 160) }); }
      },
    },
  ];

  return { tools, names: RESEARCH_TOOL_NAMES, state };
}

// Fiação por PAPEL (função pura, testável sem SDK): só o "pesquisador" recebe as web tools; os demais papéis
// da mesa recebem [] (isolamento — não ganham rede). O liveWorker chama isto para decidir o que injetar.
export function toolsForRole(role, opts) {
  return role === "pesquisador" ? createResearchTools(opts).tools : [];
}

// ENFORCEMENT DETERMINÍSTICO do sinal de confiança (Guard 5): se HOUVE pesquisa (o pesquisador chamou as tools)
// e o texto FINAL não menciona confiança/fonte, o worker ANEXA um rótulo factual derivado do `state` — garante
// que o usuário VÊ o sinal mesmo se o modelo o omitir. NÃO é heurística de NLP (não "entende" o texto): só checa
// presença de keyword e anexa um FATO (nº de fontes + pior confiança observada). Não re-anexa se já houver sinal.
export function enforceConfidenceSignal(text, state) {
  const used = ((state && state.search && state.search.used) || 0) + ((state && state.read && state.read.used) || 0);
  if (!used) return text; // não pesquisou → nada a sinalizar
  const t = String(text || "");
  if (/confian|confidence|sinal autom/i.test(t)) return t; // o modelo já declarou a CONFIANÇA (ou já foi anexado)
  const signals = (state && state.signals) || [];
  const worst = signals.includes("BAIXA") ? "BAIXA" : signals.includes("MEDIA") ? "MEDIA" : (signals.length ? "ALTA" : "BAIXA");
  return t + `\n\n[sinal automático — fontes web consultadas: ${used} · confiança: ${worst}]`;
}
