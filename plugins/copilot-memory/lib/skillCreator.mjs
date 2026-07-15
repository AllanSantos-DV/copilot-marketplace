// SKILL CREATOR — o processo de criação de skill (não um save cego). Dado uma LIÇÃO destilada, desenha
// o frontmatter, BUSCA semanticamente skills correspondentes (projeto E global), e DECIDE: criar nova,
// atualizar uma existente (reconciliando/corrigindo — resolve contradições como getMessages↔getEvents),
// ou EVOLUIR para global (lição generalizável além do projeto). A decisão quando há ambiguidade é
// semântica (reconciliador LLM). Segue o padrão: frontmatter PT + corpo EN.
import { buildSkillDocument, validateSkill, TYPE_ACTIVE } from "./skill.mjs";

export const GLOBAL_TYPE = "skill_global";

// Busca similares no PROJETO (type:skill) e no GLOBAL (type:skill_global). Sem minScore (evita o modo
// de score não-normalizado do servidor); corta no cliente. Retorna candidatos ordenados por score.
async function findSimilar(client, projectId, frontmatter, limit = 4) {
    const out = [];
    try {
        const r = await client.search(frontmatter, { topK: limit, metadata: { project_id: projectId, type: TYPE_ACTIVE } });
        for (const x of (r.results || [])) out.push({ id: x.documentId, score: Number(x.score) || 0, scope: "project" });
    } catch { /* ignore */ }
    try {
        const r = await client.search(frontmatter, { topK: limit, metadata: { type: GLOBAL_TYPE } });
        for (const x of (r.results || [])) out.push({ id: x.documentId, score: Number(x.score) || 0, scope: "global" });
    } catch { /* ignore */ }
    const seen = new Set();
    const uniq = [];
    for (const c of out.sort((a, b) => b.score - a.score)) { if (!seen.has(c.id)) { seen.add(c.id); uniq.push(c); } }
    return uniq.slice(0, limit);
}

// Enriquece candidatos com name/description (para o reconciliador decidir).
async function enrich(client, cands) {
    const out = [];
    for (const c of cands) {
        try {
            const d = await client.getDocument(c.id);
            out.push({ id: c.id, scope: c.scope, score: c.score, name: (d && d.metadata && d.metadata.name) || "", description: (d && d.metadata && d.metadata.description) || "" });
        } catch { out.push({ ...c, name: "", description: "" }); }
    }
    return out;
}

// Cria/atualiza/promove uma skill a partir de uma lição. deps: { client, projectId, sessionId,
// reconcile: async(lesson, candidates)=>decision, strongScore }. Retorna { action, id?, name, reason? }.
export async function createOrUpdateSkill(lesson, { client, projectId, sessionId, reconcile, strongScore = 0.62 } = {}) {
    // Normaliza o name ao limite (o curador às vezes excede; truncar > descartar a skill).
    if (lesson && typeof lesson.name === "string" && lesson.name.length > 64) {
        lesson = { ...lesson, name: lesson.name.slice(0, 63).trimEnd() + "…" };
    }
    const v = validateSkill(lesson);
    if (!v.ok) return { action: "skip", reason: "inválida: " + v.errors.join("; ") };

    const frontmatter = `${lesson.name}\n${lesson.description}`;
    const cands = await findSimilar(client, projectId, frontmatter);
    const strong = cands.filter((c) => c.score >= strongScore);

    let decision;
    let known = [];
    if (!strong.length) {
        decision = { action: "create", ...lesson };  // nada parecido → nova
    } else if (typeof reconcile === "function") {
        known = await enrich(client, strong);
        decision = await reconcile(lesson, known);
        if (!decision || !decision.action) decision = { action: "create", ...lesson }; // fallback conservador
    } else {
        known = await enrich(client, strong);
        decision = strong.some((c) => c.scope === "project") ? { action: "skip", reason: "similar já existe" } : { action: "create", ...lesson };
    }

    return await apply(client, projectId, sessionId, lesson, decision, known);
}

const AUTO_SOURCES = new Set(["copilot-curator", "copilot-autoskill", "copilot"]);

async function apply(client, projectId, sessionId, lesson, decision, known = []) {
    const name = decision.name || lesson.name;
    const description = decision.description || lesson.description;
    const body = decision.body || lesson.body;
    const kind = decision.kind || lesson.kind;
    const built = buildSkillDocument({ name, description, body, tags: kind ? [kind] : undefined, projectId, sessionId });
    const content = built.content;

    const baseMeta = (extra) => {
        const m = { status: "active", confidence: "medium", name, description, source: "copilot-curator", ...extra };
        if (kind) m.kind = kind;
        if (sessionId) m.session_id = sessionId;
        return m;
    };

    const doCreate = async () => {
        const saved = await client.save(content, baseMeta({ type: TYPE_ACTIVE, project_id: projectId }));
        return { action: "create", id: saved && saved.id, name };
    };

    if (decision.action === "skip") return { action: "skip", reason: decision.reason || "sem ação", name };

    // Guarda para ações que MUTAM um alvo: o targetId tem de estar entre os candidatos apresentados,
    // e o alvo não pode ser conteúdo HUMANO (auto-capture nunca sobrescreve humano — invariante skill.mjs).
    const needsTarget = (decision.action === "update") || (decision.action === "promote_global" && decision.targetId);
    if (needsTarget) {
        const cand = known.find((c) => c.id === decision.targetId);
        if (!decision.targetId || !cand) {
            // update/promote sem alvo válido, mas HÁ vizinho forte → NÃO cria duplicata: pula.
            return { action: "skip", reason: "targetId ausente/desconhecido; evitando duplicata", name };
        }
        let target;
        try { target = await client.getDocument(decision.targetId); } catch { target = null; }
        const src = target && target.metadata ? target.metadata.source : null;
        if (src && !AUTO_SOURCES.has(src)) {
            return { action: "skip", reason: `alvo ${decision.targetId} é conteúdo humano (source=${src}); não sobrescrevo`, name };
        }
        // não REBAIXAR uma global para projeto num 'update'.
        if (decision.action === "update" && cand.scope === "global") {
            return { action: "skip", reason: "alvo é global; não rebaixo para projeto num update", name };
        }
    }

    if (decision.action === "update") {
        await client.updateDocument(decision.targetId, content, baseMeta({ type: TYPE_ACTIVE, project_id: projectId }));
        return { action: "update", id: decision.targetId, name };
    }

    if (decision.action === "promote_global") {
        if (decision.targetId) {
            await client.updateDocument(decision.targetId, content, baseMeta({ type: GLOBAL_TYPE }));
            try { await client.patchMetadata(decision.targetId, { type: GLOBAL_TYPE }, ["project_id"]); } catch { /* best-effort */ }
            return { action: "promote_global", id: decision.targetId, name };
        }
        const saved = await client.save(content, baseMeta({ type: GLOBAL_TYPE }));  // nova global (sem project_id)
        return { action: "promote_global_new", id: saved && saved.id, name };
    }

    return await doCreate();  // create (default): nova skill de projeto, auto-ativa.
}
