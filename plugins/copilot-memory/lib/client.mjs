// Cliente REST do daemon de memória (native-java) — contratos LIDOS DO CÓDIGO, não da spec:
//   POST /api/v1/search   (RestApiHandler.java:914-962) → { results:[{text,score,documentId,chunkIndex}], count, query }
//   POST /api/v1/context  (RestApiHandler.java:964-989) → { context, query, format }
//   POST /api/v1/documents(RestApiHandler.java:747-821) → { id, ... }
//   GET  /api/v1/documents/recent (:850-866)            → { data:[...], count }
//   GET  /health                                        → { status, version, ... }
// ESCOPO é responsabilidade do CHAMADOR: passe metadata.project_id (via resolveProjectId).
// O REST é stateless e filtra só pelo metadata enviado — o servidor não adivinha o projeto.
export class MemoryClient {
    constructor(baseUrl) {
        this.base = String(baseUrl).replace(/\/+$/, "");
    }

    async #req(method, path, body, timeoutMs = 15000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const init = { method, signal: ctrl.signal, headers: {} };
            if (body !== undefined) {
                init.headers["content-type"] = "application/json";
                init.body = JSON.stringify(body);
            }
            const res = await fetch(this.base + path, init);
            const text = await res.text();
            const json = text ? safeJson(text) : null;
            if (!res.ok) {
                const detail = (json && (json.error || json.message)) || (text ? text.slice(0, 200) : "");
                throw new Error(`HTTP ${res.status} ${method} ${path}${detail ? " — " + detail : ""}`);
            }
            return json;
        } finally {
            clearTimeout(t);
        }
    }

    // Busca semântica. opts: { topK?=5, metadata?, minScore?, dateRange?, timeoutMs? }
    search(query, opts = {}) {
        const body = { query };
        if (opts.topK != null) body.topK = opts.topK;
        if (opts.metadata) body.metadata = opts.metadata;
        if (opts.minScore != null) body.minScore = opts.minScore;
        if (opts.dateRange) body.dateRange = opts.dateRange;
        return this.#req("POST", "/api/v1/search", body, opts.timeoutMs);
    }

    // Contexto já formatado para prompt. opts: { format?, maxTokens?, topK?, metadata?, timeoutMs? }
    context(query, opts = {}) {
        const body = { query };
        if (opts.format) body.format = opts.format;
        if (opts.maxTokens != null) body.maxTokens = opts.maxTokens;
        if (opts.topK != null) body.topK = opts.topK;
        if (opts.metadata) body.metadata = opts.metadata;
        return this.#req("POST", "/api/v1/context", body, opts.timeoutMs);
    }

    // Documentos recentes (opcionalmente escopados). opts: { limit?, metadata? }
    recent(opts = {}) {
        const qs = new URLSearchParams();
        if (opts.limit != null) qs.set("limit", String(opts.limit));
        if (opts.metadata) {
            for (const [k, v] of Object.entries(opts.metadata)) qs.set("metadata." + k, String(v));
        }
        const q = qs.toString();
        return this.#req("GET", "/api/v1/documents/recent" + (q ? "?" + q : ""));
    }

    // Salva um documento carimbando o metadata fornecido (inclua project_id do projeto aberto).
    save(content, metadata) {
        const body = { content };
        if (metadata) body.metadata = metadata;
        return this.#req("POST", "/api/v1/documents", body);
    }

    // POST /api/v1/compose (compose_recall). O SERVIDOR compõe os blocos rotulados.
    // opts: { projectId?, setup?, includeLifecycleState?, metadata?, timeoutMs? }
    // → { query, blocks:[{block,scope,items:[{id,name,description,type,score}]}], timestamp }
    compose(query, opts = {}) {
        const body = { query };
        if (opts.projectId) body.project_id = opts.projectId;
        if (opts.setup) body.setup = true;
        if (opts.includeLifecycleState) body.includeLifecycleState = true;
        if (opts.metadata) body.metadata = opts.metadata;
        return this.#req("POST", "/api/v1/compose", body, opts.timeoutMs);
    }

    // GET /api/v1/documents?metadata.<k>=v&limit= → { data:[{id,content,metadata,...}], pagination }
    list(opts = {}) {
        const qs = new URLSearchParams();
        if (opts.limit != null) qs.set("limit", String(opts.limit));
        if (opts.metadata) {
            for (const [k, v] of Object.entries(opts.metadata)) qs.set("metadata." + k, String(v));
        }
        const q = qs.toString();
        return this.#req("GET", "/api/v1/documents" + (q ? "?" + q : ""));
    }

    // PUT /api/v1/documents/{id} { content, metadata } → atualiza (usado para promover candidate→active).
    updateDocument(id, content, metadata) {
        const body = { content };
        if (metadata) body.metadata = metadata;
        return this.#req("PUT", "/api/v1/documents/" + encodeURIComponent(id), body);
    }

    // POST /api/v1/documents/{id}/feedback → lifecycle (signal_memory_feedback). ADR-016 (servidor ≥2.19.0).
    // opts: { reason?, replacementDocId? }. verdict=wrong tira do recall e PRESERVA os bytes. 404 se doc
    // não existe; 400 se verdict inválido/superseded sem replacement; 503 se feedback desabilitado.
    feedback(id, verdict, opts = {}) {
        const body = { verdict };
        if (opts.reason) body.reason = opts.reason;
        if (opts.replacementDocId) body.replacementDocId = opts.replacementDocId;
        return this.#req("POST", "/api/v1/documents/" + encodeURIComponent(id) + "/feedback", body);
    }

    // PATCH /api/v1/documents/{id} → update metadata-only (NÃO re-chunka). ADR-016 (servidor ≥2.19.0).
    // body { metadata?, remove? }. 400 se metadata/remove com tipo errado, patch vazio ou JSON malformado.
    patchMetadata(id, metadata, remove) {
        const body = { metadata: metadata || {} };
        if (Array.isArray(remove) && remove.length) body.remove = remove;
        return this.#req("PATCH", "/api/v1/documents/" + encodeURIComponent(id), body);
    }

    // GET /api/v1/documents/{id} → { id, content, createdAt, metadata }
    getDocument(id) {
        return this.#req("GET", "/api/v1/documents/" + encodeURIComponent(id));
    }

    // DELETE /api/v1/documents/{id} → 204 (sem corpo)
    deleteDocument(id) {
        return this.#req("DELETE", "/api/v1/documents/" + encodeURIComponent(id));
    }

    // GET /health → objeto de saúde do servidor.
    health() {
        return this.#req("GET", "/health");
    }
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
