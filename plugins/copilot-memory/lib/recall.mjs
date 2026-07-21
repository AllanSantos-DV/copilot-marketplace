// Compositor de recall passivo. O SERVIDOR compõe (compose_recall): o plugin só passa o
// project_id do projeto aberto, consome o envelope de blocos e injeta como `additionalContext`.
//
// Blocos (contract ADR-002): procedural[home] + skill_global[home] + knowledge[P] + skill[P] +
// setup[P]. Memória de projeto é ISOLADA (não vaza produto); skill_global é COMPARTILHADA (serve
// a todos). A hierarquia/agregação é decidida pelo SERVIDOR — o plugin não decide nada disso.
//
// Fallback: se o daemon não tiver compose (versão antiga), cai para um search ESCOPADO por
// project_id (só o projeto, nunca search aberto — não vaza). Best-effort: timeout curto, nunca lança.
import { tryResolveProjectId } from "./projectId.mjs";

export const RECALL_DEFAULTS = {
    maxItems: 8,          // teto total de itens injetados
    maxPerBlock: 3,       // teto POR bloco — evita que skill_global engula o orçamento e zere o projeto
    maxCharsPerItem: 320,
    minScore: 0.5,        // usado só no fallback escopado
    timeoutMs: 3500,      // hook não pode travar a sessão
    // compose faz 5 buscas (5× embedding) → é o 1º a estourar sob carga (medido: 143ms hoje, mas já
    // observado 113s com DB inchada/embedder frio). Orçamento próprio, curto: se estourar, cai no
    // fallback (context escopado, ~2ms) sem travar o hook. A otimização do compose é server-side.
    composeTimeoutMs: 2500,
    // Teto GLOBAL do recall no hook: mesmo no pior caso (compose→context→search em série num daemon
    // degradado), o hook nunca paga mais que isto por prompt. Acima disso, injeta nada (degrada).
    overallDeadlineMs: 4500,
};

// Ordem e títulos dos blocos do compose_recall (globais primeiro, depois projeto).
const BLOCK_ORDER = ["skill_global", "procedural", "knowledge", "skill", "setup"];
const BLOCK_TITLES = {
    skill_global: "Skills globais",
    procedural: "Lições globais",
    knowledge: "Conhecimento do projeto",
    skill: "Skills do projeto",
    setup: "Setup do projeto",
};
// Recall em DOIS NÍVEIS (pesquisa two-tier, validado): SKILL/skill_global/setup = POINTER
// (name+description+id → agente carrega o corpo sob demanda via memory_get, progressive disclosure).
// KNOWLEDGE/procedural = FATO INLINE (o chunk `text` direto no contexto; grounding, sem round-trip).
const POINTER_BLOCKS = new Set(["skill", "skill_global", "setup"]);

// Formata UM item conforme o nível do bloco.
function formatItem(block, it, o) {
    const sc = (Number(it.score) || 0).toFixed(2);
    const id = it.id ? ` [${it.id}]` : "";
    if (POINTER_BLOCKS.has(block)) {
        // pointer: gatilho (name+description) + id p/ carregar o corpo sob demanda.
        const nm = String(it.name || "").trim();
        const desc = clampText(it.description || "", o.maxCharsPerItem);
        return `- (${sc})${id} ${nm ? nm + (desc ? " — " : "") : ""}${desc}`;
    }
    // inline: o fato (chunk) direto; cai para name/description se o servidor não mandou text.
    const body = clampText(it.text || it.description || it.name || "", o.maxCharsPerItem);
    return `- (${sc})${id} ${body}`;
}

function clampText(s, n) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Lê overrides de ambiente (permite tunar sem editar código).
export function recallOptsFromEnv(base = RECALL_DEFAULTS) {
    const num = (v, d) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
    return {
        ...base,
        maxItems: num(process.env.COPILOT_MEMORY_MAXITEMS, base.maxItems),
        minScore: num(process.env.COPILOT_MEMORY_MINSCORE, base.minScore),
        timeoutMs: num(process.env.COPILOT_MEMORY_TIMEOUT_MS, base.timeoutMs),
    };
}

// Formata o envelope { blocks:[{block,scope,items:[{id,name,description,type,score}]}] } em markdown.
function formatEnvelope(env, projectId, o) {
    const blocks = (env && Array.isArray(env.blocks) ? env.blocks : []).filter((b) => (b.items || []).length);
    if (!blocks.length) return { text: null, count: 0, projectId, source: "compose", pointerIds: [] };

    // CONSOME os blocos do PROJETO primeiro (knowledge/skill/setup) e limita cada bloco a maxPerBlock,
    // para que muitas skills globais não engulam o orçamento e zerem a memória específica do projeto
    // (a promessa central do plugin). A EXIBIÇÃO segue BLOCK_ORDER (globais primeiro, como pano de fundo).
    const CONSUME_ORDER = ["knowledge", "skill", "setup", "skill_global", "procedural"];
    const perBlock = o.maxPerBlock || Math.max(1, Math.ceil(o.maxItems / 3));
    let budget = o.maxItems;
    const chosen = {};
    for (const name of CONSUME_ORDER) {
        if (budget <= 0) break;
        const b = blocks.find((x) => x.block === name);
        if (!b) continue;
        const items = (b.items || []).slice(0, Math.min(perBlock, budget));
        if (!items.length) continue;
        chosen[name] = items;
        budget -= items.length;
    }

    let total = 0;
    const sections = [];
    const pointerIds = [];
    for (const name of BLOCK_ORDER) {
        const items = chosen[name];
        if (!items || !items.length) continue;
        total += items.length;
        if (POINTER_BLOCKS.has(name)) {
            for (const it of items) if (it.id) pointerIds.push(it.id);
        }
        const lines = items.map((it) => formatItem(name, it, o));
        sections.push(`## ${BLOCK_TITLES[name] || name}\n${lines.join("\n")}`);
    }
    if (!total) return { text: null, count: 0, projectId, source: "compose", pointerIds: [] };

    const header =
        `# 🧠 Memória do projeto (copilot-memory)\n` +
        `_Composto pelo servidor (compose_recall) · project_id: ${projectId ?? "(home)"} · ${total} ${total === 1 ? "item" : "itens"}. Use \`memory_get(id)\` para o conteúdo completo de um item._`;
    return { text: [header, ...sections].join("\n\n"), count: total, projectId, source: "compose", pointerIds };
}

// Fallback quando o compose falha/estoura (medido lento sob carga): usa o `context` ESCOPADO
// por project_id — 1 busca só (~2ms medido), formatado, escopado (não vaza). Se o context também
// falhar, tenta `search` escopado como último recurso. Nunca busca aberta.
async function fallbackScoped(client, projectId, q, o) {
    if (!projectId) return { text: null, count: 0, projectId, source: "fallback", pointerIds: [] };

    // 1ª opção: context escopado (barato + já formatado pelo servidor).
    try {
        const r = await client.context(q, { topK: o.maxItems, maxTokens: 900, metadata: { project_id: projectId }, timeoutMs: o.timeoutMs });
        const ctx = r && typeof r.context === "string" ? r.context.trim() : "";
        if (ctx) {
            const header =
                `# 🧠 Memória do projeto (copilot-memory)\n` +
                `_Recall escopado (context, fallback do compose) · project_id: ${projectId}._`;
            return { text: `${header}\n\n${ctx}`, count: 1, projectId, source: "fallback-context", pointerIds: [] };
        }
    } catch { /* tenta search abaixo */ }

    // 2ª opção: search escopado cru.
    let results = [];
    try {
        const r = await client.search(q, { topK: o.maxItems, metadata: { project_id: projectId }, minScore: o.minScore, timeoutMs: o.timeoutMs });
        results = (r && r.results) || [];
    } catch {
        results = [];
    }
    if (!results.length) return { text: null, count: 0, projectId, source: "fallback", pointerIds: [] };
    const lines = results.slice(0, o.maxItems).map((r) => `- (${(Number(r.score) || 0).toFixed(2)}) ${clampText(r.text, o.maxCharsPerItem)}`);
    const header =
        `# 🧠 Memória do projeto (copilot-memory)\n` +
        `_Recall escopado (search, fallback) · project_id: ${projectId} · ${lines.length} ${lines.length === 1 ? "item" : "itens"}._`;
    return { text: [header, "## Do projeto", ...lines].join("\n"), count: lines.length, projectId, source: "fallback-search", pointerIds: [] };
}

// Ponto de entrada usado pelos hooks. Retorna { text, count, projectId, source }.
// text=null quando não há nada relevante (ex.: projeto novo sem memória).
export async function composeRecall(client, workingDirectory, query, opts = {}) {
    const o = { ...RECALL_DEFAULTS, ...opts };
    const projectId = tryResolveProjectId(workingDirectory);
    const q = String(query || "").trim();
    if (!q) return { text: null, count: 0, projectId, source: "none", pointerIds: [] };
    // Escopo ESTRITO: sem project_id estável (nem marcador nem git remote) NÃO injeta recall — honra
    // a decisão "sem identificador estável = sem recall". O nudge de scaffold (session-start) já avisa.
    if (!projectId) return { text: null, count: 0, projectId: null, source: "no-scope", pointerIds: [] };

    let env = null;
    try {
        env = await client.compose(q, { projectId, timeoutMs: o.composeTimeoutMs || o.timeoutMs });
    } catch {
        env = null; // compose ausente/erro/timeout → fallback escopado (context)
    }
    if (env && Array.isArray(env.blocks)) {
        const formatted = formatEnvelope(env, projectId, o);
        if (formatted.text) return formatted;
        // compose respondeu mas veio VAZIO (corpus não escopado): tenta o fallback escopado antes de desistir.
        const fb = await fallbackScoped(client, projectId, q, o);
        return fb.text ? fb : formatted;
    }
    return fallbackScoped(client, projectId, q, o);
}
