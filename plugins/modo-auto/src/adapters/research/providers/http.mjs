// http.mjs — GET de texto com timeout (AbortController) e FAIL-LOUD. Base compartilhada dos providers de rede.
// fetchImpl é injetável (default = fetch global do Node ≥18) para os smokes rodarem SEM rede real (stub).
// Nunca lança: devolve {ok:true,status,text} ou {ok:false,error,detail} — o caller decide o fallback.

const DEFAULT_TIMEOUT = 15000;

export async function fetchText(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, error: "fetch_unavailable", detail: "fetch global ausente (Node<18?)" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: "http_" + res.status, status: res.status, detail: text.slice(0, 200) };
    return { ok: true, status: res.status, text };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    return { ok: false, error: aborted ? "timeout" : "network", detail: String((e && e.message) || e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

// Extração de texto POBRE (fallback quando o Jina Reader não está disponível): tira tags e condensa espaço.
// Não é limpeza fina — é o degradê honesto (marcado) quando o provider bom falha.
export function stripHtml(html) {
  const body = String(html || "");
  const main = (body.match(/<(?:article|main)[\s\S]*?<\/(?:article|main)>/i) || [null])[0] || body;
  return main
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
