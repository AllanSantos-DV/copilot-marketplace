// jinaReader.mjs — provider de LEITURA (web_read). Estratégia PROVADA ao vivo (probe fase 0):
//   1º Jina Reader  https://r.jina.ai/<url>  → markdown limpo, GRÁTIS, sem key (status 200 medido).
//   2º fallback fetch nativo do alvo + stripHtml (degradê honesto, marcado via `via`).
//   3º ambos falham → {ok:false,error:"read_failed"} FAIL-LOUD (nunca inventa conteúdo).
// A url JÁ vem validada pelo safeUrl no handler (https, não-local). Aqui só orquestra provider→fallback.
import { fetchText, stripHtml } from "./http.mjs";

const JINA_READ = "https://r.jina.ai/";

export async function readViaJina(url, { timeoutMs = 15000, fetchImpl } = {}) {
  // 1) Jina Reader (markdown limpo, sem key)
  const jina = await fetchText(JINA_READ + url, { headers: { Accept: "text/plain" }, timeoutMs, fetchImpl });
  if (jina.ok && jina.text && jina.text.trim()) {
    return { ok: true, via: "jina-reader", url, markdown: jina.text.trim() };
  }
  // 2) fallback: buscar o alvo direto e limpar o HTML na marra (pior qualidade, mas real)
  const raw = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0 (modo-auto research)" }, timeoutMs, fetchImpl });
  if (raw.ok && raw.text && raw.text.trim()) {
    const text = stripHtml(raw.text);
    if (text) return { ok: true, via: "native-fetch", url, markdown: text, degraded: true };
  }
  // 3) FAIL-LOUD — os dois caminhos falharam
  return { ok: false, error: "read_failed", url, detail: `jina:${jina.error || "vazio"} | native:${raw.error || "vazio"}` };
}
