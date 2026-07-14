// Formato e validação de skill de conhecimento (M4 — base de qualidade).
//
// EVIDÊNCIA que molda o formato: o servidor SÓ embeda o `content` (metadata NÃO entra no vetor —
// DocumentService.storeDocument). Logo o `content` indexado precisa conter o PT (name+description)
// no topo + o corpo EN — assim a busca casa com prompts em PT e o corpo EN é o payload reusável.
//
// CICLO DE QUALIDADE (guardrails dos revisores externos):
//   • nasce type:"skill_candidate" (status candidate) → NÃO entra no recall automático (o compose
//     casa type:"skill"); só após promoção explícita (validação) vira type:"skill".
//   • escopo global DESLIGADO no MVP: só projeto (project_id).
//   • auto-capture nunca sobrescreve conteúdo humano (checado na invalidação).

export const SKILL_LIMITS = { name: 64, description: 1024 };
export const TYPE_CANDIDATE = "skill_candidate";
export const TYPE_ACTIVE = "skill";

// Heurística: a description contém um "não use quando…" (anti-gatilho)? Cobre PT e EN.
// Best-effort — serve só para um WARNING educativo, nunca bloqueia (evita falso-negativo travar
// uma skill boa por causa de fraseado que a regex não previu).
function hasNegativeTrigger(text) {
    return /n[ãa]o\s+us|n[ãa]o\s+aplic|evite|exceto|a\s+menos\s+que|do\s*n'?t\s+use|not\s+use|avoid|except\s+when|unless/i.test(String(text || ""));
}

// Valida os campos. Erros bloqueiam; warnings apenas sinalizam (completude Anthropic).
export function validateSkill({ name, description, body } = {}) {
    const errors = [];
    const warnings = [];
    const nm = String(name || "").trim();
    const desc = String(description || "").trim();
    const bd = String(body || "").trim();

    if (!nm) errors.push("name (PT) é obrigatório");
    else if (nm.length > SKILL_LIMITS.name) errors.push(`name excede ${SKILL_LIMITS.name} chars (${nm.length})`);
    if (!desc) errors.push("description (PT) é obrigatória");
    else if (desc.length > SKILL_LIMITS.description) errors.push(`description excede ${SKILL_LIMITS.description} chars (${desc.length})`);
    if (!bd) errors.push("body (EN) é obrigatório");

    const low = bd.toLowerCase();
    if (bd && !low.includes("## what")) warnings.push("body sem seção '## What'");
    if (bd && !low.includes("## when")) warnings.push("body sem seção '## When to use'");
    if (bd && !low.includes("## do")) warnings.push("body sem seção '## Do'");
    if (bd && !/##\s*don'?t/i.test(bd)) warnings.push("body sem seção \"## Don't\" (anti-padrões)");

    // Ensino no momento da autoria (guia S2): a description deve dizer QUANDO NÃO usar (anti-disparo),
    // ficar no ponto ótimo (~300; >400 = ampla demais → dividir), e o body precisa ser reusável.
    if (desc && !hasNegativeTrigger(desc)) {
        warnings.push('description sem "não use quando…" — inclua o anti-gatilho para evitar recall errado (ex.: "Não use para…")');
    }
    if (desc.length > 400) {
        warnings.push(`description longa (${desc.length} chars; ideal ~300) — se cobre casos demais, considere dividir em skills focadas`);
    }
    if (bd && bd.length < 80) {
        warnings.push("body muito curto — uma skill reusável costuma ter Do/Don't concretos; talvez seja fato do projeto (memory_save), não skill");
    }

    return { ok: errors.length === 0, errors, warnings };
}

// Monta { content, metadata } para POST /documents. content = PT (name+description) + corpo EN.
export function buildSkillDocument({ name, description, body, tags, projectId, sessionId, evidence } = {}) {
    const nm = String(name || "").trim();
    const desc = String(description || "").trim();
    const bd = String(body || "").trim();

    // O que é INDEXADO (embedado): PT no topo + corpo EN.
    const content = `# ${nm}\n\n${desc}\n\n${bd}`;

    const metadata = {
        type: TYPE_CANDIDATE,      // guardrail: nasce candidata (fora do recall automático)
        status: "candidate",
        name: nm,
        description: desc,
        confidence: "low",
        source: "copilot-autoskill",
    };
    if (Array.isArray(tags) && tags.length) metadata.tags = tags;
    if (sessionId) metadata.session_id = sessionId;
    if (Array.isArray(evidence) && evidence.length) metadata.evidence = evidence;
    // Escopo: SOMENTE projeto no MVP (global/home desligado). project_id obrigatório a montante.
    if (projectId) metadata.project_id = projectId;

    return { content, metadata };
}
