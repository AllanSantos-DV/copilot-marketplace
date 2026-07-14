// Migração de ESCOPO — reatribui o project_id de documentos de um escopo ANTIGO para um NOVO via
// PATCH metadata-only (ADR-016): sem re-chunkar/re-embedar (validado ao vivo: conteúdo e createdAt
// preservados; o doc some do escopo antigo e aparece no novo). O servidor NÃO tem endpoint de
// "migrar" dedicado — o cliente itera list→PATCH. Só toca documentos carimbados EXATAMENTE com
// fromId; as lições globais / home spine não têm esse project_id, então nunca são movidas.
//
// SEGURANÇA (decidido com o dono): migração NUNCA é silenciosa nem automática — quem chama
// (a tool memory_migrate_scope) previsualiza por padrão e só aplica com confirm explícito.

const clampText = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// Conta os documentos sob fromId + uma amostra (para a prévia). Nunca lança: erro vai no objeto.
// `count` é limitado por `limit` (a migração real pagina além disso); `capped` sinaliza truncamento.
export async function previewMigration(client, fromId, toId, { limit = 200 } = {}) {
    try {
        const r = await client.list({ limit, metadata: { project_id: fromId } });
        const docs = (r && r.data) || [];
        return {
            fromId,
            toId,
            count: docs.length,
            capped: docs.length >= limit,
            sample: docs.slice(0, 8).map((d) => ({
                id: d.id,
                type: (d.metadata && d.metadata.type) || null,
                name: (d.metadata && d.metadata.name) || null,
                text: clampText(d.content, 120),
            })),
        };
    } catch (e) {
        return { fromId, toId, count: 0, capped: false, sample: [], error: String(e?.message || e) };
    }
}

// Executa a migração fromId→toId. Pagina (list→PATCH), idempotente (re-rodar acha 0 e é no-op),
// erros por-documento coletados SEM abortar o lote. Para quando: o escopo antigo esvazia, OU só
// sobram documentos que já falharam (sem progresso → evita loop infinito), OU atinge `max`.
export async function migrateScope(client, fromId, toId, { pageLimit = 100, max = 5000 } = {}) {
    if (!fromId || !toId) return { ok: false, migrated: 0, failed: 0, errors: [], reason: "escopos inválidos" };
    if (fromId === toId) return { ok: false, migrated: 0, failed: 0, errors: [], reason: "escopos iguais" };

    let migrated = 0;
    const errors = [];
    const failedIds = new Set();

    while (migrated < max) {
        let docs;
        try {
            const r = await client.list({ limit: pageLimit, metadata: { project_id: fromId } });
            docs = (r && r.data) || [];
        } catch (e) {
            return { ok: false, migrated, failed: errors.length, errors, reason: "list falhou: " + (e?.message || e) };
        }
        // Ignora os que já falharam (senão o mesmo doc reapareceria em toda página → loop eterno).
        const pending = docs.filter((d) => d && d.id && !failedIds.has(d.id));
        if (pending.length === 0) break; // esvaziou OU só sobraram falhas

        let progressed = 0;
        for (const d of pending) {
            try {
                await client.patchMetadata(d.id, { project_id: toId });
                migrated++;
                progressed++;
            } catch (e) {
                failedIds.add(d.id);
                errors.push({ id: d.id, error: String(e?.message || e) });
            }
        }
        if (progressed === 0) break; // nenhum avanço nesta rodada
    }

    return { ok: errors.length === 0, migrated, failed: errors.length, errors };
}
