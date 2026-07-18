// Cliente REST do Session Graph Engine (native-java) — CONSUMIDOR puro. Não reimplementa nada do servidor.
// Contrato: POST http://<daemon>/api/v1/graph/<sub>, corpo path-scoped. Ver files/design-graph-tools.md (spec
// revisada) — máquina de estados normativa, GraphContext p/ root externo, erro tipado, clamps, capability probe.
//
// Regras-chave implementadas aqui:
//  - /status-first: só ingere se not_indexed/failed (ou refresh); ready → lê direto (reuso cross-session).
//  - erro TIPADO (GraphError) preservando status/code/body — NUNCA vira string (ao contrário do MemoryClient).
//  - dois 409 distintos: ID_MISMATCH (derivação) vs ROOT_CONFLICT (worktrees, traz mappedRoot/requestedRoot).
//  - clamps de limit/topK/hops; capability probe (200 ok, 404 daemon<2.23.0, 503 grafo off).
//  - poll com backoff + deadline (nunca infinito); 429 QUEUE_SATURATED → não faz poll, devolve Retry-After.

import { resolve as pathResolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { discover } from "./daemon.mjs";
import { tryResolveProjectId } from "./projectId.mjs";

export class GraphError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message || code || ("HTTP " + status));
        this.name = "GraphError";
        this.status = status;
        this.code = code || null;
        Object.assign(this, extra); // mappedRoot, requestedRoot, expected, actual, retryAfter, hint, state
    }
}

const clampInt = (v, def, max) => {
    const n = Number.isFinite(+v) ? Math.floor(+v) : def;
    return Math.max(1, Math.min(max, n));
};

// GraphContext: resolve o root ALVO (CANONICALIZADO via realpath) e deriva o project_id DELE (não da sessão).
// Fatal evitado: nunca mandar o id do projeto aberto para um root externo (daria 409 ID_MISMATCH). rootArg
// vazio = projeto próprio (cwd). Canonicaliza (symlink/case) p/ o id casar e evitar ROOT_CONFLICT espúrio.
export function graphContextFor(rootArg, cwd) {
    let root = rootArg && String(rootArg).trim() ? pathResolve(String(rootArg).trim()) : String(cwd || process.cwd());
    try { root = realpathSync(root); } catch { /* não existe → assertSafeRoot recusa depois */ }
    return { root, expectedProjectId: tryResolveProjectId(root) };
}

// Guard de segurança do root (spec §6.1): o daemon CAMINHA+lê+hasheia o filesystem no `path`. Recusa raízes
// amplas demais (raiz de disco, UNC, home inteira) e inexistentes — evita DoS/indexar árvore arbitrária.
// Retorna null se ok, ou uma mensagem de erro.
export function assertSafeRoot(root) {
    if (!root || !existsSync(root)) return "o caminho não existe: " + (root || "(vazio)");
    const norm = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-zA-Z]:$/.test(norm) || norm === "") return "raiz de disco é ampla demais — passe um caminho de projeto específico.";
    if (/^\/\/[^/]+(\/[^/]+)?$/.test(norm)) return "raiz de compartilhamento de rede (UNC) é ampla demais — passe um projeto específico.";
    const home = String(homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
    if (home && norm.toLowerCase() === home.toLowerCase()) return "a pasta home inteira é ampla demais — passe um projeto específico.";
    return null;
}

// Descobre o daemon vivo; devolve a base URL (sem barra final) ou null (offline → fail-open no chamador).
export async function graphBase() {
    const info = await discover();
    if (!info || !info.url) return null;
    return String(info.url).replace(/\/+$/, "");
}

// POST cru a um subpath. Retorna { status, json }. Lança GraphError em 4xx/5xx (com corpo estruturado).
// 200 (inclui leitura não-ready {state,hint}) e 202 (ingest aceito) são sucesso.
async function post(base, sub, ctx, extra = {}, timeoutMs = 15000) {
    const body = { path: ctx.root, ...(ctx.expectedProjectId ? { expected_project_id: ctx.expectedProjectId } : {}), ...extra };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/api/v1/graph/${sub}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: ctrl.signal,
        });
        // timeout ainda ATIVO aqui → limita também a LEITURA do corpo (não só headers). clearTimeout no finally.
        let json = null;
        try { json = await res.json(); } catch { /* corpo não-JSON */ }
        if (res.status === 200 || res.status === 202) return { status: res.status, json: json || {} };
        // erro: monta GraphError tipado preservando o corpo estruturado
        const code = (json && (json.code || json.error)) || httpCodeName(res.status);
        const retryAfter = res.headers.get("retry-after");
        throw new GraphError(res.status, code, (json && json.message) || code, {
            mappedRoot: json?.mappedRoot, requestedRoot: json?.requestedRoot,
            expected: json?.expected, actual: json?.actual,
            retryAfter: retryAfter ? Number(retryAfter) || retryAfter : undefined,
            hint: json?.hint, state: json?.state,
        });
    } catch (e) {
        if (e instanceof GraphError) throw e; // não re-embrulha erro tipado como NETWORK
        throw new GraphError(0, "NETWORK", "falha/timeout ao falar com o grafo: " + (e?.message || e));
    } finally {
        clearTimeout(t);
    }
}

function httpCodeName(s) {
    return ({ 400: "BAD_FIELD", 404: "SUBPATH_OR_API_MISSING", 405: "METHOD_NOT_ALLOWED", 503: "GRAPH_DISABLED" })[s] || ("HTTP_" + s);
}

// Capability probe (barato, 1×/base cacheado): confirma que /api/v1/graph existe. 200→ok; 404→daemon<2.23.0;
// 503→grafo off. Distingue "daemon antigo" de "rota errada" (o discover aceita 503 como vivo).
const _capCache = new Map();
export async function ensureCapable(base, ctx) {
    if (_capCache.get(base)) return true;
    try {
        await post(base, "status", ctx, {}, 8000);
        _capCache.set(base, true);
        return true;
    } catch (e) {
        if (e instanceof GraphError && e.status === 404) {
            throw new GraphError(404, "GRAPH_API_MISSING", "o daemon de memória não expõe o Graph API — atualize para uma versão com /api/v1/graph (instalar o JAR novo em ~/.mcp-memory/lib + reiniciar).");
        }
        throw e;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /status simples.
export async function status(base, ctx) {
    const { json } = await post(base, "status", ctx);
    return json; // {project_id, root, state, nodes, edges, topHubs?, report?, error?, hint?}
}

// Máquina de estados NORMATIVA (spec §5c): garante o grafo utilizável e devolve o último /status.
//  ready→(refresh?ingest+poll:usa); indexing→poll; not_indexed→ingest+poll; failed→1 retry; 429→devolve estado.
// onProgress(state,nodes) opcional. Nunca poll infinito (deadline). Retorna { state, nodes, edges, report?,
//   timedOut?, queued?, retryAfter? }.
export async function ensureReady(base, ctx, { refresh = false, deadlineMs = 180000, onProgress } = {}) {
    let st = await status(base, ctx);
    const report0 = st.report; // captura o report da 1ª leitura (some após TTL)
    if (st.state === "ready" && !refresh) return st;

    // Issue #4: se o estado INICIAL já é failed, o ingest abaixo é a "1 tentativa" (spec §5c) → não repetir no loop.
    let triedFailedRetry = st.state === "failed";
    const started = Date.now();
    // Dispara ingest só quando FAZ SENTIDO: not_indexed/failed, ou ready+refresh. NUNCA em indexing (já roda).
    const shouldIngest = st.state === "not_indexed" || st.state === "failed" || (refresh && st.state === "ready");
    if (shouldIngest) {
        try {
            const ing = await post(base, "ingest", ctx);
            if (ing.status === 202) st = { ...st, state: "indexing" };
        } catch (e) {
            if (e instanceof GraphError && e.status === 429) {
                return { ...st, queued: true, retryAfter: e.retryAfter };
            }
            throw e;
        }
    }

    // poll com backoff até ready|failed|deadline
    let wait = 2000;
    while (st.state === "indexing") {
        if (Date.now() - started > deadlineMs) return { ...st, timedOut: true, report: st.report || report0 };
        await sleep(wait);
        wait = Math.min(wait * 2, 15000);
        st = await status(base, ctx);
        if (onProgress) { try { onProgress(st.state, st.nodes); } catch { /* noop */ } }
        if (st.state === "failed" && !triedFailedRetry) {
            triedFailedRetry = true;
            try { await post(base, "ingest", ctx); st = { ...st, state: "indexing" }; wait = 2000; }
            catch (e) { if (e instanceof GraphError && e.status === 429) return { ...st, queued: true, retryAfter: e.retryAfter }; throw e; }
        } else if (st.state === "failed") {
            return st; // falhou de novo → para (o chamador mostra st.error)
        }
    }
    return { ...st, report: st.report || report0 };
}

// Leituras (nunca ingerem). Clamps aplicados aqui.
export async function symbols(base, ctx, { query = "", limit } = {}) {
    const { json } = await post(base, "symbols", ctx, { query: query || "", limit: clampInt(limit, 20, 100) });
    return json; // {symbols:[...], truncated?}
}
export async function search(base, ctx, { query, topK, hops } = {}) {
    if (!query || !String(query).trim()) throw new GraphError(0, "BAD_FIELD", "graph_search exige 'query'.");
    const { json } = await post(base, "search", ctx, { query: String(query), topK: clampInt(topK, 8, 25), hops: clampInt(hops, 1, 2) });
    return json; // {seed:[...], expanded:[...], truncated?}
}
export async function callers(base, ctx, { id, limit } = {}) {
    if (!id) throw new GraphError(0, "BAD_FIELD", "graph_callers exige 'id'.");
    // Cut 1: /callers aceita SÓ {id} (sem paginação — validado ao vivo: limit/cursor → 400 UNKNOWN_FIELD).
    // A paginação é item §13 (servidor). Por ora: pega a lista inteira e TRUNCA no cliente (evita despejo).
    const { json } = await post(base, "callers", ctx, { id: String(id) });
    return capList(json, "callers", clampInt(limit, 50, 100));
}
export async function references(base, ctx, { id, limit } = {}) {
    if (!id) throw new GraphError(0, "BAD_FIELD", "graph_references exige 'id'.");
    const { json } = await post(base, "references", ctx, { id: String(id) });
    return capList(json, "references", clampInt(limit, 50, 100));
}

// Trunca no CLIENTE (o servidor Cut 1 não pagina callers/references): mantém os top-N por PageRank e marca
// truncated. Protege o contexto do agente num hub gigante (spec §3.2) sem depender do servidor.
function capList(json, key, cap) {
    const arr = Array.isArray(json?.[key]) ? json[key] : [];
    if (arr.length <= cap) return json;
    const sorted = arr.slice().sort((a, b) => (b?.pagerank ?? 0) - (a?.pagerank ?? 0)).slice(0, cap);
    return { ...json, [key]: sorted, truncated: true, totalCount: arr.length };
}

// Ressalva de CALLS por extensão (spec §8/§10): só Java extrai CALLS no Cut 1. Vazio em outra linguagem = "sem
// CALLS extraídos", não "ninguém chama".
const CALLS_LANGS = new Set(["java"]);
export function callsCaveatFor(nodeOrFile) {
    let f = typeof nodeOrFile === "string" ? nodeOrFile : (nodeOrFile && nodeOrFile.file);
    if (typeof f === "string" && f.includes("::")) f = f.split("::")[0]; // id de nó (file::symbol) → parte do arquivo
    const ext = String(f || "").split(".").pop()?.toLowerCase();
    return ext && !CALLS_LANGS.has(ext)
        ? `Nota: CALLS só é extraído para Java no Cut 1; a lista para .${ext} pode estar incompleta (sem chamadas extraídas).`
        : null;
}

// Mensagem honesta de "0 nós" (spec §8): usa report quando existe; conservador quando não há.
export function zeroNodesMessage(st) {
    const r = st && st.report;
    if (!r) return "grafo vazio; a causa (linguagem não suportada vs repo vazio) está indisponível porque o relatório expirou. Rode graph_ingest com refresh:true para regerar (paga re-walk).";
    if (r.scanned > 0 && (r.files === 0)) return `tem ${r.scanned} arquivo(s), mas nenhum de linguagem suportada pelo grafo (ex.: extensões fora da lista).`;
    if ((r.scanned || 0) === 0) return "repo vazio ou só diretórios podados.";
    if ((r.files || 0) > 0) return `${r.files} arquivo(s) de código lidos, mas sem símbolos extraídos.`;
    return "grafo vazio.";
}

export const _internal = { clampInt, httpCodeName };
