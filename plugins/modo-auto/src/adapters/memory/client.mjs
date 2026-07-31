// Cliente REST SLIM do daemon de memória (native-java). Só o que a MemoryPort usa: search, context,
// save, health. Contrato fiel a copilot-memory/lib/client.mjs (RestApiHandler.java):
//   POST /api/v1/search   → { results:[{text,score,documentId,chunkIndex}], count }
//   POST /api/v1/context  → { context, query, format }
//   POST /api/v1/documents→ { id, ... }
//   GET  /health
// ESCOPO é do chamador: passe metadata.project_id.

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

export class MemoryClient {
  constructor(baseUrl) { this.base = String(baseUrl).replace(/\/+$/, ""); }

  async #req(method, path, body, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init = { method, signal: ctrl.signal, headers: {} };
      if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
      const res = await fetch(this.base + path, init);
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (!res.ok) {
        const detail = (json && (json.error || json.message)) || (text ? text.slice(0, 200) : "");
        throw new Error(`HTTP ${res.status} ${method} ${path}${detail ? " — " + detail : ""}`);
      }
      return json;
    } finally { clearTimeout(t); }
  }

  search(query, opts = {}) {
    const body = { query };
    if (opts.topK != null) body.topK = opts.topK;
    if (opts.metadata) body.metadata = opts.metadata;
    if (opts.minScore != null) body.minScore = opts.minScore;
    return this.#req("POST", "/api/v1/search", body, opts.timeoutMs);
  }

  context(query, opts = {}) {
    const body = { query };
    if (opts.format) body.format = opts.format;
    if (opts.maxTokens != null) body.maxTokens = opts.maxTokens;
    if (opts.topK != null) body.topK = opts.topK;
    if (opts.metadata) body.metadata = opts.metadata;
    return this.#req("POST", "/api/v1/context", body, opts.timeoutMs);
  }

  save(content, metadata) {
    const body = { content };
    if (metadata) body.metadata = metadata;
    return this.#req("POST", "/api/v1/documents", body);
  }

  // Existe para o TEARDOWN do teste negativo ao vivo: aquele teste PRECISA plantar um documento de saída de agente
  // no escopo principal (é o veneno que a 2ª camada tem que barrar), e deixar esse lixo no corpus real do projeto
  // envenenaria de verdade o que o teste existe para proteger. Sem delete, a única saída seria não testar.
  remove(documentId) { return this.#req("DELETE", "/api/v1/documents/" + encodeURIComponent(documentId)); }

  health() { return this.#req("GET", "/health"); }
}
