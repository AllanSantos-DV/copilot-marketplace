// braveSearch.mjs — provider PREMIUM de busca (opt-in por API key). Índice independente do Brave (não proxia
// Google), privacy/ZDR. Usado quando o config.research aponta 'brave'/'auto' E há key. Sem key → {ok:false}
// (o caller decide: FAIL-LOUD se explícito, ou o resolveSearchProvider já mandou pro grátis). Mesmo formato de
// saída do ddgSearch: {ok, via, query, results:[{title,url,snippet}]}.
import { fetchText } from "./http.mjs";

const BRAVE = "https://api.search.brave.com/res/v1/web/search";

export async function searchViaBrave(query, { apiKey, timeoutMs = 15000, fetchImpl, max = 8 } = {}) {
  if (!apiKey) return { ok: false, error: "brave_no_key" };
  const url = `${BRAVE}?q=${encodeURIComponent(query)}&count=${max}`;
  const r = await fetchText(url, { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" }, timeoutMs, fetchImpl });
  if (!r.ok) return { ok: false, error: `brave_${r.error || "fail"}`, query, detail: r.detail };
  let json;
  try { json = JSON.parse(r.text); } catch { return { ok: false, error: "brave_bad_json", query }; }
  const web = json && json.web && Array.isArray(json.web.results) ? json.web.results : [];
  const results = web.slice(0, max).map((x) => ({
    title: String(x.title || "").replace(/<[^>]+>/g, "").slice(0, 160),
    url: x.url,
    snippet: String(x.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
  })).filter((x) => /^https?:\/\//.test(x.url || ""));
  if (!results.length) return { ok: false, error: "brave_empty", query };
  return { ok: true, via: "brave", query, results };
}
