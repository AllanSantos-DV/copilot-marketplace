// ddgSearch.mjs — provider de BUSCA (web_search) SEM key. Estratégia PROVADA ao vivo (probe fase 0):
//   s.jina.ai exige API key (401). Solução grátis medida: LER a SERP do DuckDuckGo lite pelo Jina Reader —
//   `https://r.jina.ai/https://lite.duckduckgo.com/lite/?q=<q>` devolve os resultados JÁ em markdown limpo
//   (título, link de redirect do DDG, snippet). Reúsa o Reader grátis provado no jinaReader.
//   1º jina-sobre-ddg (markdown) → parse; 2º ddg-lite direto (HTML) → regex; 3º FAIL-LOUD search_failed.
import { fetchText, stripHtml } from "./http.mjs";

const READER = "https://r.jina.ai/";
const DDG_LITE = "https://lite.duckduckgo.com/lite/?q=";

// O DDG entrega links como redirect: https://duckduckgo.com/l/?uddg=<url-real-encodada>&rut=... → decodifica.
function decodeDdg(href) {
  const s = String(href || "");
  const m = s.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* keep */ } }
  return s;
}

// Parser do markdown do Jina-sobre-DDG: itens no formato `N.[title](ddg-redirect)` + snippet nas linhas seguintes.
function parseJinaDdg(md) {
  const text = String(md || "");
  const re = /(\d+)\.\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const hits = [...text.matchAll(re)];
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const m = hits[i];
    const title = m[2].trim();
    const url = decodeDdg(m[3]);
    if (!/^https?:\/\//i.test(url)) continue;
    const from = m.index + m[0].length;
    const to = i + 1 < hits.length ? hits[i + 1].index : Math.min(text.length, from + 400);
    const snippet = text.slice(from, to).replace(/\s+/g, " ").trim().slice(0, 300);
    out.push({ title, url, snippet });
  }
  return out;
}

// Fallback: HTML cru do DDG lite. Extrai os alvos reais via uddg= (best-effort, marcado degraded).
function parseDdgHtml(html) {
  const text = String(html || "");
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(/[?&]uddg=([^&"']+)/g)) {
    let url; try { url = decodeURIComponent(m[1]); } catch { continue; }
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: url.replace(/^https?:\/\//, "").slice(0, 80), url, snippet: "" });
    if (out.length >= 10) break;
  }
  return out;
}

export async function searchViaDdg(query, { timeoutMs = 15000, fetchImpl, max = 8 } = {}) {
  const enc = encodeURIComponent(query);
  // 1) Jina Reader sobre a SERP do DDG lite → markdown com resultados (grátis, sem key)
  const jina = await fetchText(READER + DDG_LITE + enc, { headers: { Accept: "text/plain" }, timeoutMs, fetchImpl });
  if (jina.ok && jina.text) {
    const results = parseJinaDdg(jina.text).slice(0, max);
    if (results.length) return { ok: true, via: "jina-ddg", query, results };
  }
  // 2) fallback: DDG lite HTML direto
  const raw = await fetchText(DDG_LITE + enc, { headers: { "User-Agent": "Mozilla/5.0 (modo-auto research)" }, timeoutMs, fetchImpl });
  if (raw.ok && raw.text) {
    const results = parseDdgHtml(raw.text).slice(0, max);
    if (results.length) return { ok: true, via: "ddg-lite", query, results, degraded: true };
  }
  // 3) FAIL-LOUD
  return { ok: false, error: "search_failed", query, detail: `jina:${jina.error || "0 resultados"} | ddg:${raw.error || "0 resultados"}` };
}

export const _internal = { decodeDdg, parseJinaDdg, parseDdgHtml };
