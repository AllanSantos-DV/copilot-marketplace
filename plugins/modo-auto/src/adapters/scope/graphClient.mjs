// Cliente REST SLIM do Session Graph Engine (native-java) — vendado no modo-auto, fiel a
// copilot-memory/lib/graphClient.mjs. CONSUMIDOR puro: POST /api/v1/graph/<sub> com corpo path-scoped.
// Reusa o MESMO discover()/projectId do MemoryPort (DRY). Erro TIPADO (GraphError preserva status/code)
// — NUNCA vira string. Capability probe distingue "daemon antigo (<2.23.0, sem grafo)" de "rota errada".

import { realpathSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { discover } from "../memory/daemon.mjs";
import { tryResolveProjectId } from "../memory/projectId.mjs";

export class GraphError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.name = "GraphError";
    this.status = status; this.code = code;
    Object.assign(this, extra);
  }
}

// GraphContext: root ALVO canonicalizado + project_id DELE (não da sessão). root vazio = projeto próprio.
export function graphContextFor(rootArg, cwd) {
  let root = rootArg && String(rootArg).trim() ? pathResolve(String(rootArg).trim()) : String(cwd || process.cwd());
  try { root = realpathSync(root); } catch { /* não existe → assertSafeRoot recusa */ }
  return { root, expectedProjectId: tryResolveProjectId(root) };
}

// Recusa raízes amplas demais (disco/UNC/home) e inexistentes. Retorna msg de erro ou null (ok).
export function assertSafeRoot(root) {
  if (!root || !existsSync(root)) return "o caminho não existe: " + (root || "(vazio)");
  const norm = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:$/.test(norm) || norm === "") return "raiz de disco é ampla demais — passe um projeto específico.";
  if (/^\/\/[^/]+(\/[^/]+)?$/.test(norm)) return "raiz de rede (UNC) é ampla demais — passe um projeto específico.";
  const home = String(homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
  if (home && norm.toLowerCase() === home.toLowerCase()) return "a home inteira é ampla demais — passe um projeto específico.";
  return null;
}

export async function graphBase() {
  const info = await discover();
  return info && info.url ? String(info.url).replace(/\/+$/, "") : null;
}

const httpCodeName = (s) => ({ 400: "BAD_FIELD", 404: "SUBPATH_OR_API_MISSING", 405: "METHOD_NOT_ALLOWED", 503: "GRAPH_DISABLED" })[s] || ("HTTP_" + s);
const clampInt = (v, def, max) => { const n = Number.isFinite(+v) ? Math.floor(+v) : def; return Math.max(1, Math.min(n, max)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST cru. 200/202 = sucesso; 4xx/5xx → GraphError tipado (preserva corpo). Rede/timeout → NETWORK.
async function post(base, sub, ctx, extra = {}, timeoutMs = 15000) {
  const body = { path: ctx.root, ...(ctx.expectedProjectId ? { expected_project_id: ctx.expectedProjectId } : {}), ...extra };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/v1/graph/${sub}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    let json = null; try { json = await res.json(); } catch { /* corpo não-JSON */ }
    if (res.status === 200 || res.status === 202) return { status: res.status, json: json || {} };
    const code = (json && (json.code || json.error)) || httpCodeName(res.status);
    const retryAfter = res.headers.get("retry-after");
    throw new GraphError(res.status, code, (json && json.message) || code, { hint: json?.hint, state: json?.state, retryAfter: retryAfter ? Number(retryAfter) || retryAfter : undefined });
  } catch (e) {
    if (e instanceof GraphError) throw e;
    throw new GraphError(0, "NETWORK", "falha/timeout ao falar com o grafo: " + (e?.message || e));
  } finally { clearTimeout(t); }
}

// Capability probe (cacheado por base): 200→tem grafo; 404→daemon<2.23.0 (GRAPH_API_MISSING).
const _cap = new Map();
export async function ensureCapable(base, ctx) {
  if (_cap.get(base)) return true;
  try { await post(base, "status", ctx, {}, 8000); _cap.set(base, true); return true; }
  catch (e) {
    if (e instanceof GraphError && e.status === 404) throw new GraphError(404, "GRAPH_API_MISSING", "o daemon de memória não expõe o Graph API — atualize para uma versão com /api/v1/graph (daemon ≥ 2.23.0).");
    throw e;
  }
}

export async function status(base, ctx) { const { json } = await post(base, "status", ctx); return json; }

// Máquina de estados: garante o grafo utilizável e devolve o último status. not_indexed→ingest+poll;
// indexing→poll(backoff, deadline); ready→usa; failed→1 retry; 429→devolve {queued}. Nunca poll infinito.
export async function ensureReady(base, ctx, { refresh = false, deadlineMs = 180000, onProgress } = {}) {
  let st = await status(base, ctx);
  const report0 = st.report;
  if (st.state === "ready" && !refresh) return st;
  let triedFailedRetry = st.state === "failed";
  const started = Date.now();
  const shouldIngest = st.state === "not_indexed" || st.state === "failed" || (refresh && st.state === "ready");
  if (shouldIngest) {
    try { const ing = await post(base, "ingest", ctx); if (ing.status === 202) st = { ...st, state: "indexing" }; }
    catch (e) { if (e instanceof GraphError && e.status === 429) return { ...st, queued: true, retryAfter: e.retryAfter }; throw e; }
  }
  let wait = 2000;
  while (st.state === "indexing") {
    if (Date.now() - started > deadlineMs) return { ...st, timedOut: true, report: st.report || report0 };
    await sleep(wait); wait = Math.min(wait * 2, 15000);
    st = await status(base, ctx);
    if (onProgress) { try { onProgress(st.state, st.nodes); } catch { /* noop */ } }
    if (st.state === "failed" && !triedFailedRetry) {
      triedFailedRetry = true;
      try { await post(base, "ingest", ctx); st = { ...st, state: "indexing" }; wait = 2000; }
      catch (e) { if (e instanceof GraphError && e.status === 429) return { ...st, queued: true, retryAfter: e.retryAfter }; throw e; }
    } else if (st.state === "failed") return st;
  }
  return { ...st, report: st.report || report0 };
}

// Leituras (nunca ingerem).
export async function symbols(base, ctx, { query = "", limit } = {}) { const { json } = await post(base, "symbols", ctx, { query: query || "", limit: clampInt(limit, 20, 100) }); return json; }
export async function search(base, ctx, { query, topK, hops } = {}) {
  if (!query || !String(query).trim()) throw new GraphError(0, "BAD_FIELD", "graph_search exige 'query'.");
  const { json } = await post(base, "search", ctx, { query: String(query), topK: clampInt(topK, 8, 25), hops: clampInt(hops, 1, 2) });
  return json;
}
