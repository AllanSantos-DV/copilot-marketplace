// ScopePort — ENTENDIMENTO DE ESCOPO de um projeto grande, com REUSO capability-gated do grafo semântico
// (Session Graph Engine, via memory server). Padrão dos contratos de adapter deste projeto (não hardcoded):
//   • grafo disponível (daemon ≥ 2.23.0)  → usa graph_search + hubs (rápido, semântico);
//   • daemon offline OU antigo (sem grafo) → GARIMPO MANUAL bounded (fs walk + grep) — degradação HONESTA
//     e SINALIZADA (strategy:"manual", reason), não um fallback que mascara;
//   • erro REAL do grafo (ingest failed/rede) → SURFACED ({ok:false,error}) — não vira manual silencioso.
// O cliente de grafo é INJETÁVEL (default = vendado) p/ testar as duas trilhas de forma determinística.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import * as defaultGraph from "./graphClient.mjs";

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".rb", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".php", ".kt", ".swift", ".scala", ".vue", ".svelte", ".mts", ".cts"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", ".gradle", "coverage", "vendor", "bin", "obj", ".idea", ".vscode"]);

// GARIMPO MANUAL bounded: caminha o projeto (com limites p/ não estourar), rankeia diretórios por volume,
// e procura os termos da query num subconjunto de arquivos. Sinaliza truncamento. Nunca "inventa" grafo.
function manualMine(root, query, { walkCap = 6000, scanCap = 400, matchCap = 50 } = {}) {
  const files = [];
  const dirCount = new Map();
  const stack = [root];
  let walked = 0, truncated = false;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++walked > walkCap) { truncated = true; break; }
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) stack.push(full); }
      else if (CODE_EXT.has(extname(e.name).toLowerCase())) {
        files.push(full);
        const rd = relative(root, dir) || ".";
        dirCount.set(rd, (dirCount.get(rd) || 0) + 1);
      }
    }
    if (walked > walkCap) { truncated = true; break; }
  }
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
  // relevância por nome de arquivo/caminho batendo os termos → prioriza o que escanear.
  const scored = files.map((f) => ({ f, s: terms.reduce((a, t) => a + (f.toLowerCase().includes(t) ? 1 : 0), 0) }));
  scored.sort((a, b) => b.s - a.s);
  const matches = [];
  let scanned = 0;
  for (const { f } of scored) {
    if (scanned >= scanCap || matches.length >= matchCap) break;
    if (!terms.length) break;
    let text = "";
    try { if (statSync(f).size <= 400_000) text = readFileSync(f, "utf8"); } catch { continue; }
    scanned++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < matchCap; i++) {
      const low = lines[i].toLowerCase();
      if (terms.some((t) => low.includes(t))) matches.push({ file: relative(root, f), line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  const topDirs = [...dirCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([dir, count]) => ({ dir, count }));
  return { fileCount: files.length, truncated, topDirs, topFiles: scored.slice(0, 25).map((x) => relative(root, x.f)), matches };
}

/**
 * @param {{ cwdProvider?: ()=>string, graph?: object, log?: (m:string)=>void }} [opts]
 */
export function createScopePort({ cwdProvider = () => process.cwd(), graph = defaultGraph, log = () => {} } = {}) {
  // Detecta a CAPACIDADE de grafo (o corte de versão). Nunca lança: devolve o estado sinalizado.
  async function detect(root) {
    const ctx = graph.graphContextFor(root, cwdProvider());
    const base = await graph.graphBase();
    if (!base) return { available: false, reason: "offline" };
    try { await graph.ensureCapable(base, ctx); return { available: true, reason: "graph", base }; }
    catch (e) {
      if (e && e.code === "GRAPH_API_MISSING") return { available: false, reason: "version", detail: e.message };
      return { available: false, reason: "error", detail: e?.message || String(e) };
    }
  }

  return {
    detect,

    /**
     * Entende o escopo p/ um assunto/consulta. Grafo se disponível, senão garimpo manual (sinalizado).
     * @returns {{ ok:boolean, strategy:"graph"|"manual", ... }}
     */
    async scope(query, { root, deadlineMs = 120000 } = {}) {
      const q = String(query || "").trim();
      if (!q) throw new Error("scopePort.scope: query vazia");
      const ctx = graph.graphContextFor(root, cwdProvider());
      const bad = graph.assertSafeRoot(ctx.root);
      if (bad) return { ok: false, error: bad };

      const base = await graph.graphBase();
      if (!base) { log("[scope] daemon offline → garimpo manual"); return { ok: true, strategy: "manual", reason: "offline", root: ctx.root, ...manualMine(ctx.root, q) }; }

      try { await graph.ensureCapable(base, ctx); }
      catch (e) {
        if (e && e.code === "GRAPH_API_MISSING") { log("[scope] daemon sem Graph API (versão antiga) → garimpo manual"); return { ok: true, strategy: "manual", reason: "version", root: ctx.root, ...manualMine(ctx.root, q) }; }
        return { ok: false, strategy: "graph", error: e?.message || String(e), code: e?.code }; // erro REAL surfaced
      }

      let st;
      try { st = await graph.ensureReady(base, ctx, { deadlineMs, onProgress: (state, n) => log(`[scope] grafo ${state} (${n || 0} nós)`) }); }
      catch (e) { return { ok: false, strategy: "graph", error: e?.message || String(e), code: e?.code }; }

      const usable = st.state === "ready" || (st.timedOut && (st.nodes || 0) > 0);
      if (!usable) return { ok: false, strategy: "graph", state: st.state, timedOut: !!st.timedOut, queued: !!st.queued, error: st.error || `grafo não utilizável (${st.state})` };

      const [hubs, bundle] = await Promise.all([
        graph.symbols(base, ctx, { limit: 20 }).catch((e) => { throw new Error("graph.symbols: " + (e?.message || e)); }),
        graph.search(base, ctx, { query: q, topK: 12, hops: 1 }).catch((e) => { throw new Error("graph.search: " + (e?.message || e)); }),
      ]);
      return {
        ok: true, strategy: "graph", root: ctx.root, projectId: st.project_id,
        nodes: st.nodes, edges: st.edges, partial: !!st.timedOut,
        hubs: (hubs && hubs.symbols) || [], seed: (bundle && bundle.seed) || [], expanded: (bundle && bundle.expanded) || [],
      };
    },
  };
}
