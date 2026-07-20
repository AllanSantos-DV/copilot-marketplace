// As 7 tools de grafo do plugin (graph_*) — wrappers finos sobre lib/graphClient.mjs. Consumidor puro do
// Session Graph Engine (native-java). Ver files/design-graph-tools.md. Fail-open: nunca lança pro host.
//
// Regras aplicadas: /status-first (reuso), leituras não auto-ingerem (guiam o usuário), erro tipado tratado
// (ROOT_CONFLICT reporta as 2 raízes, ID_MISMATCH, QUEUE_SATURATED, GRAPH_API_MISSING), mensagem honesta de
// 0 nós, ressalva de CALLS por linguagem.

import * as G from "./graphClient.mjs";
import { extractTerms, canonicalTag } from "./termExtract.mjs";
import { tagOnMiss } from "./feedbackLoop.mjs";

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

// Formata o veredito de uma escrita de tag (nada silencioso): aceitos/além-do-teto/recusados.
// Contrato do servidor: accepted/dropped_over_cap = arrays de STRINGS; rejected = array de OBJETOS
// {term, reason}. source: search_validated | build_time (exibo rótulo PT).
const SOURCE_LABEL = { search_validated: "busca-validada", build_time: "construção" };
function fmtTagVerdict(id, source, verdict) {
    const acc = verdict?.accepted || [], drop = verdict?.dropped_over_cap || [], rej = verdict?.rejected || [];
    const rejStr = rej.map((o) => (typeof o === "string" ? o : `${o?.term ?? "?"} (${o?.reason ?? "?"})`));
    const parts = [`🏷️ Tag em ${id} (${SOURCE_LABEL[source] || "busca-validada"}):`];
    parts.push(`  ✓ aceitos: ${acc.length ? acc.join(", ") : "—"}`);
    if (drop.length) parts.push(`  ⤵️ além do teto (5/nó): ${drop.join(", ")}`);
    if (rejStr.length) parts.push(`  ✗ recusados: ${rejStr.join("; ")}`);
    if (!acc.length && !drop.length && !rejStr.length) parts.push("  (servidor não reportou termos — verifique o contrato)");
    return parts.join("\n");
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
        case "VALIDATION_ERROR":
            return `Requisição inválida para o grafo: ${e.message}. (Ex.: 'id'/'terms' ausentes ou malformados, nó inexistente, source inválida, path inválido.)`;
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
        {
            name: "graph_tag_node",
            description:
                "Feedback GOVERNADO (ADR-021 2b): ensina o grafo a achar um nó por INTENÇÃO, taggeando-o com as palavras da " +
                "query que FALHOU. Use SÓ depois de uma busca semântica (graph_search) NÃO trazer o nó certo — NUNCA por palpite. " +
                "Dois modos: (A) passe 'id' já confirmado por nome exato (graph_symbols) + a 'query' que falhou (extraio ≤3 termos) " +
                "ou 'terms' explícitos; (B) passe 'expectedName' (o nome exato do símbolo) + a 'query' que falhou, e EU confirmo o nó " +
                "por nome exato e taggeio (o loop completo). O servidor governa (teto 5 tags/nó, dedup, tag amarrada ao fingerprint, " +
                "TTL 90d) e devolve accepted/dropped/rejected (nada silencioso). Numa próxima sessão/agente, a mesma intenção casa sem o nome exato.",
            parameters: {
                type: "object",
                properties: {
                    root: { type: "string", description: "Repo externo (opcional; padrão = projeto aberto)." },
                    id: { type: "string", description: "Modo A: node_id CONFIRMADO por nome exato (graph_symbols)." },
                    expectedName: { type: "string", description: "Modo B: nome EXATO do símbolo; a tool confirma o nó por você (garimpo determinístico) antes de taggear." },
                    query: { type: "string", description: "A query de intenção que FALHOU; dela extraio até 3 termos de conteúdo (sem stopwords)." },
                    terms: { type: "array", items: { type: "string" }, description: "Modo A alternativo a 'query': termos explícitos (≤3, palavras da query real)." },
                    source: { type: "string", enum: ["search_validated", "build_time"], description: "Origem da tag: search_validated (padrão, tag de busca que falhou) ou build_time (taggeando enquanto escreve o código)." },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const p = await prep(args.root, toolCwd);
                if (p.error) return p.error;
                if (!args.id && !args.expectedName) {
                    return "🚫 Passe 'id' (nó já confirmado em graph_symbols) OU 'expectedName' (o nome exato do símbolo, que eu confirmo por você) + a 'query' que falhou.";
                }
                try {
                    // Exige grafo pronto (a tag amarra a um nó existente) — guia se não estiver.
                    const st = await G.status(p.base, p.ctx);
                    if (st.state !== "ready") {
                        return `🕸️ O grafo ainda não está pronto (${st.state}). Rode graph_analyze${args.root ? ` root:"${args.root}"` : ""} antes de taggear.`;
                    }
                    // Modo B: loop completo — confirma o nó por NOME EXATO e taggeia (garimpo + captura + escrita).
                    if (!args.id && args.expectedName) {
                        const r = await tagOnMiss({ base: p.base, ctx: p.ctx, query: args.query || "", expectedName: args.expectedName, source: args.source });
                        if (r.ok) return fmtTagVerdict(r.id, args.source, r.verdict);
                        if (r.reason === "node-not-found") return `🚫 Não achei um símbolo com o nome EXATO "${args.expectedName}" (graph_symbols). Confirme o nome — nunca taggeio por palpite.`;
                        if (r.reason === "too-few-terms") return `🚫 Não taggeei: <2 termos de conteúdo em "${args.query || ""}" (o servidor exige ≥2 distintos casando). Passe uma query com mais palavras de conteúdo.`;
                        return `🚫 Não taggeei (${r.reason}).`;
                    }
                    // Modo A: id já confirmado pelo agente. termos explícitos OU da query (mesma normalização).
                    const words = Array.isArray(args.terms) && args.terms.length
                        ? extractTerms(args.terms.join(" "))
                        : extractTerms(args.query || "");
                    if (words.length < 2) {
                        return `🚫 Não taggeei: preciso de ao menos 2 termos de conteúdo (o servidor exige ≥2 distintos casando no retrieval). ` +
                            `Recebi ${words.length} de "${args.query || (args.terms || []).join(" ")}". Passe uma query com mais palavras ou 'terms' explícitos.`;
                    }
                    // 1 tag-frase canônica (ordenada) — 1 slot dos 5, convergente entre sessões/agentes.
                    const r = await G.tagNode(p.base, p.ctx, { id: args.id, terms: [canonicalTag(words)], source: args.source });
                    return fmtTagVerdict(args.id, args.source, r);
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
