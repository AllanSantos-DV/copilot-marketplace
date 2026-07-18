// As 7 tools de grafo do plugin (graph_*) — wrappers finos sobre lib/graphClient.mjs. Consumidor puro do
// Session Graph Engine (native-java). Ver files/design-graph-tools.md. Fail-open: nunca lança pro host.
//
// Regras aplicadas: /status-first (reuso), leituras não auto-ingerem (guiam o usuário), erro tipado tratado
// (ROOT_CONFLICT reporta as 2 raízes, ID_MISMATCH, QUEUE_SATURATED, GRAPH_API_MISSING), mensagem honesta de
// 0 nós, ressalva de CALLS por linguagem.

import * as G from "./graphClient.mjs";

function fmtNode(n) {
    if (!n) return "";
    const loc = n.file ? ` @ ${n.file}${n.startLine ? ":" + n.startLine : ""}` : "";
    const pr = typeof n.pagerank === "number" ? ` (pr ${n.pagerank.toFixed(4)})` : "";
    return `- ${n.type || "?"} ${n.name || "(sem nome)"}${loc}${pr}  [id: ${n.id}]`;
}
function fmtList(nodes, cap = 15) {
    const arr = Array.isArray(nodes) ? nodes : [];
    const head = arr.slice(0, cap).map(fmtNode).join("\n");
    return arr.length > cap ? `${head}\n… (+${arr.length - cap})` : (head || "(vazio)");
}

// Traduz um GraphError num texto acionável (nunca lança). ctx opcional p/ contexto de raiz.
function explainError(e) {
    if (!(e instanceof G.GraphError)) return "Erro no grafo: " + (e?.message || e);
    switch (e.code) {
        case "ROOT_CONFLICT":
            return [
                `🚧 Conflito de raiz (ROOT_CONFLICT): o grafo desse project_id já está mapeado para OUTRA raiz.`,
                `  • já mapeado em: ${e.mappedRoot || "(?)"}`,
                `  • você pediu:    ${e.requestedRoot || "(?)"}`,
                `No Cut 1 o grafo é single-snapshot por projeto (comum com worktrees do mesmo repo). Saídas:`,
                `  1) consultar o snapshot existente passando root: "${e.mappedRoot || "<raiz mapeada>"}" (pode ser outro branch/revisão);`,
                `  2) trabalhar na sessão dona daquela raiz;`,
                `  3) coexistir as duas raízes exige multi-snapshot (Cut 2, ainda não disponível).`,
            ].join("\n");
        case "ID_MISMATCH":
            return `O project_id esperado (${e.expected || "?"}) difere do derivado do caminho (${e.actual || "?"}). Verifique o 'root' passado.`;
        case "QUEUE_SATURATED":
            return `Fila de indexação cheia. Tente de novo em ${e.retryAfter || "alguns"}s (graph_status/graph_analyze).`;
        case "GRAPH_API_MISSING":
            return e.message;
        case "GRAPH_DISABLED":
            return "O grafo está desabilitado no servidor de memória agora.";
        default:
            return `Erro no grafo (${e.code || e.status}): ${e.message}`;
    }
}

// Prepara base+capability+contexto. Retorna { base, ctx } ou { error } (fail-open).
async function prep(rootArg, toolCwd) {
    const base = await G.graphBase();
    if (!base) return { error: "🕸️ Grafo indisponível: o daemon de memória está offline. (Rode memory_setup / memory_status.)" };
    const ctx = G.graphContextFor(rootArg, toolCwd());
    // §6.1: recusa raízes amplas/inexistentes ANTES de mandar o daemon caminhar o filesystem.
    const unsafe = G.assertSafeRoot(ctx.root);
    if (unsafe) return { error: "🚫 " + unsafe };
    try { await G.ensureCapable(base, ctx); } catch (e) { return { error: explainError(e) }; }
    return { base, ctx };
}

// header humano do escopo
function scopeLine(ctx, st) {
    return `📦 ${ctx.expectedProjectId || "(id não resolvido)"} · ${st ? st.state : ""}${st && typeof st.nodes === "number" ? ` · ${st.nodes} nós/${st.edges} arestas` : ""}`;
}

export function graphTools({ toolCwd }) {
    return [
        {
            name: "graph_status",
            description:
                "Estado do grafo semântico do projeto (ou de um repo externo via 'root'): indexado? quantos nós/arestas? " +
                "Barato e só leitura — NÃO indexa. Use antes de consultar; se não estiver 'ready', rode graph_analyze/graph_ingest.",
            parameters: {
                type: "object",
                properties: { root: { type: "string", description: "Caminho de um repo externo (opcional; padrão = projeto aberto)." } },
                additionalProperties: false,
            },
            handler: async (args) => {
                const p = await prep(args.root, toolCwd);
                if (p.error) return p.error;
                try {
                    const st = await G.status(p.base, p.ctx);
                    const lines = [scopeLine(p.ctx, st), `raiz: ${p.ctx.root}`];
                    if (st.state === "ready" && st.nodes === 0) lines.push("⚠️ " + G.zeroNodesMessage(st));
                    if (st.state !== "ready" && st.hint) lines.push("dica: " + st.hint);
                    if (Array.isArray(st.topHubs) && st.topHubs.length) lines.push("hubs:\n" + fmtList(st.topHubs, 8));
                    return lines.join("\n");
                } catch (e) { return explainError(e); }
            },
        },
        {
            name: "graph_ingest",
            description:
                "Indexa (ou re-indexa com refresh) o grafo do projeto/repo e aguarda ficar pronto (com deadline). " +
                "Regra: só indexa se ainda não estiver pronto — se já está 'ready', reusa (a menos que refresh=true). Assíncrono no servidor.",
            parameters: {
                type: "object",
                properties: {
                    root: { type: "string", description: "Repo externo (opcional; padrão = projeto aberto)." },
                    refresh: { type: "boolean", description: "Força re-indexar mesmo se já 'ready' (paga re-walk). Padrão false." },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const p = await prep(args.root, toolCwd);
                if (p.error) return p.error;
                try {
                    const st = await G.ensureReady(p.base, p.ctx, { refresh: !!args.refresh });
                    if (st.queued) return `⏳ Fila de indexação cheia. Tente de novo em ${st.retryAfter || "alguns"}s.`;
                    if (st.timedOut) return `⏳ Ainda indexando (${st.nodes || 0} nós até agora). Chame graph_status daqui a pouco.`;
                    if (st.state === "failed") return `❌ Indexação falhou: ${st.error || "(sem detalhe)"}`;
                    const extra = st.state === "ready" && st.nodes === 0 ? "\n⚠️ " + G.zeroNodesMessage(st) : "";
                    return `✅ Grafo pronto — ${scopeLine(p.ctx, st)}${extra}`;
                } catch (e) { return explainError(e); }
            },
        },
        {
            name: "graph_symbols",
            description:
                "Lista símbolos do grafo: sem 'query' = os HUBS (top PageRank, o que mais importa no código); com 'query' = símbolo por nome exato. " +
                "Só leitura (exige grafo 'ready' — senão rode graph_analyze).",
            parameters: {
                type: "object",
                properties: {
                    root: { type: "string" },
                    query: { type: "string", description: "Nome exato (case-insensitive); vazio = top por PageRank." },
                    limit: { type: "integer", description: "Máx. de símbolos (1–100, padrão 20)." },
                },
                additionalProperties: false,
            },
            handler: async (args) => readGuard(args, toolCwd, async (base, ctx) => {
                const r = await G.symbols(base, ctx, { query: args.query || "", limit: args.limit });
                return `Símbolos (${r.symbols?.length || 0}${r.truncated ? ", truncado" : ""}):\n` + fmtList(r.symbols, 20);
            }),
        },
        {
            name: "graph_search",
            description:
                "Busca semântica no grafo: dado um termo, devolve as sementes + a vizinhança (N-hops por CALLS/CONTAINS/IMPORTS) — " +
                "o 'ContextBundle' pra ir direto ao ponto sem garimpar. Só leitura (exige grafo 'ready').",
            parameters: {
                type: "object",
                properties: {
                    root: { type: "string" },
                    query: { type: "string", description: "Termo de busca (OBRIGATÓRIO)." },
                    topK: { type: "integer", description: "Sementes (1–25, padrão 8)." },
                    hops: { type: "integer", description: "Saltos de expansão (1–2, padrão 1)." },
                },
                required: ["query"],
                additionalProperties: false,
            },
            handler: async (args) => readGuard(args, toolCwd, async (base, ctx) => {
                const r = await G.search(base, ctx, { query: args.query, topK: args.topK, hops: args.hops });
                return [
                    `Sementes (${r.seed?.length || 0}):`, fmtList(r.seed, 10),
                    `Vizinhança (${r.expanded?.length || 0}${r.truncated ? ", truncado" : ""}):`, fmtList(r.expanded, 15),
                ].join("\n");
            }),
        },
        {
            name: "graph_callers",
            description: "Quem CHAMA um nó (arestas CALLS de entrada). Passe o 'id' de um símbolo (obtido em graph_symbols/graph_search). Só leitura.",
            parameters: {
                type: "object",
                properties: { root: { type: "string" }, id: { type: "string", description: "id do nó (OBRIGATÓRIO)." }, limit: { type: "integer" } },
                required: ["id"],
                additionalProperties: false,
            },
            handler: async (args) => readGuard(args, toolCwd, async (base, ctx) => {
                const r = await G.callers(base, ctx, { id: args.id, limit: args.limit });
                const caveat = G.callsCaveatFor(args.id); // caveat pela linguagem do NÓ CONSULTADO (não do 1º resultado)
                return `Chamadores (${r.callers?.length || 0}${r.truncated ? ` de ${r.totalCount}` : ""}):\n` + fmtList(r.callers, 15) + (caveat ? "\n" + caveat : "");
            }),
        },
        {
            name: "graph_references",
            description: "Tudo que aponta pro nó (CALLS + CONTAINS + IMPORTS). Passe o 'id' de um símbolo. Só leitura.",
            parameters: {
                type: "object",
                properties: { root: { type: "string" }, id: { type: "string", description: "id do nó (OBRIGATÓRIO)." }, limit: { type: "integer" } },
                required: ["id"],
                additionalProperties: false,
            },
            handler: async (args) => readGuard(args, toolCwd, async (base, ctx) => {
                const r = await G.references(base, ctx, { id: args.id, limit: args.limit });
                const caveat = G.callsCaveatFor(args.id); // caveat pela linguagem do NÓ CONSULTADO
                return `Referências (${r.references?.length || 0}${r.truncated ? ` de ${r.totalCount}` : ""}):\n` + fmtList(r.references, 15) + (caveat ? "\n" + caveat : "");
            }),
        },
        {
            name: "graph_analyze",
            description:
                "Analisa um projeto pelo grafo semântico num passo só: garante o grafo pronto (reusa se já existe; indexa se não) e " +
                "devolve os HUBS (top PageRank) + (se passar 'query') o ContextBundle. É o atalho pra entender um repo GIGANTE — o " +
                "aberto ou um externo via 'root' — sem garimpar arquivo por arquivo. Suporta 'refresh'.",
            parameters: {
                type: "object",
                properties: {
                    root: { type: "string", description: "Repo externo (opcional; padrão = projeto aberto)." },
                    query: { type: "string", description: "Se presente, também traz o ContextBundle (busca semântica) desse termo." },
                    refresh: { type: "boolean", description: "Re-indexar mesmo se já pronto (padrão false)." },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const p = await prep(args.root, toolCwd);
                if (p.error) return p.error;
                try {
                    const st = await G.ensureReady(p.base, p.ctx, { refresh: !!args.refresh });
                    if (st.queued) return `⏳ Fila cheia. Tente em ${st.retryAfter || "alguns"}s.`;
                    if (st.timedOut) return `⏳ Ainda indexando (${st.nodes || 0} nós). Chame graph_status/graph_analyze depois.`;
                    if (st.state === "failed") return `❌ Indexação falhou: ${st.error || "(sem detalhe)"}`;
                    if (st.state === "ready" && st.nodes === 0) return `${scopeLine(p.ctx, st)}\n⚠️ ${G.zeroNodesMessage(st)}`;
                    const out = [scopeLine(p.ctx, st), `raiz: ${p.ctx.root}`];
                    const hubs = await G.symbols(p.base, p.ctx, { query: "", limit: 12 });
                    out.push(`\n🏛️ Hubs (top PageRank):\n` + fmtList(hubs.symbols, 12));
                    if (args.query && String(args.query).trim()) {
                        const sr = await G.search(p.base, p.ctx, { query: args.query });
                        out.push(`\n🔎 ContextBundle "${args.query}": sementes ${sr.seed?.length || 0} + vizinhança ${sr.expanded?.length || 0}`);
                        out.push(fmtList(sr.seed, 6));
                    }
                    return out.join("\n");
                } catch (e) { return explainError(e); }
            },
        },
    ];

    // Guard comum das LEITURAS: prep + exige grafo 'ready' (não auto-ingere; guia pro graph_analyze).
    async function readGuard(args, cwdFn, fn) {
        const p = await prep(args.root, cwdFn);
        if (p.error) return p.error;
        try {
            const st = await G.status(p.base, p.ctx);
            if (st.state !== "ready") {
                return `🕸️ O grafo ainda não está pronto (${st.state}). Rode graph_analyze${args.root ? ` root:"${args.root}"` : ""} (ou graph_ingest) primeiro.` + (st.hint ? `\ndica: ${st.hint}` : "");
            }
            if (st.nodes === 0) return `${scopeLine(p.ctx, st)}\n⚠️ ${G.zeroNodesMessage(st)}`;
            return await fn(p.base, p.ctx);
        } catch (e) { return explainError(e); }
    }
}
