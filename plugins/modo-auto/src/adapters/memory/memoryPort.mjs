// MemoryPort — recall/save escopados por project_id, via daemon native-java. Memória é OPCIONAL:
// daemon offline → { ok:false, offline:true } (degradado legítimo). Erro REAL da chamada → { ok:false,
// error } VISÍVEL (surfaced, não mascarado). Reusa o MESMO project_id da sessão (não recria escopo).

import { discover } from "./daemon.mjs";
import { tryResolveProjectId } from "./projectId.mjs";
import { MemoryClient } from "./client.mjs";

/**
 * Monta o metadata de gravação. PURO de propósito: é aqui que mora a separação de escopo, e sem daemon vivo não
 * daria para testá-la através do port (o connect() exige o serviço no ar). Regra: `namespace` SUFIXA o project_id
 * — e como o recall é escopado ao project_id puro, o que vai para um namespace nunca volta na busca principal.
 * @param {{ projectId?: string|null, type?: string, tags?: string[], namespace?: string|null }} a
 */
export function buildSaveMetadata({ projectId = null, type = "note", tags = [], namespace = null } = {}) {
  const metadata = { type };
  const ns = namespace ? String(namespace).trim() : "";
  if (projectId) metadata.project_id = ns ? `${projectId}#${ns}` : projectId;
  if (Array.isArray(tags) && tags.length) metadata.tags = tags;
  return metadata;
}

/**
 * @param {{ cwdProvider?: ()=>string, clientFactory?: (url:string)=>object, log?: (m:string)=>void }} [opts]
 * @returns {import("../../core/ports.mjs").MemoryPort}
 */
export function createMemoryPort({ cwdProvider = () => process.cwd(), clientFactory = () => null, log = () => {} } = {}) {
  let cached = null; // { client, projectId }

  async function connect() {
    const info = await discover();
    if (!info) { log("memória offline (sem daemon vivo)"); cached = null; return null; }
    // clientFactory pode devolver o client do PLUGIN (reuso); null/undefined → cai no vendado (default).
    const client = clientFactory(info.url) || new MemoryClient(info.url);
    cached = { client, projectId: tryResolveProjectId(cwdProvider()), url: info.url };
    log(`memória online (${info.url}) escopo=${cached.projectId || "?"}`);
    return cached;
  }

  return {
    projectId() { return tryResolveProjectId(cwdProvider()); },

    async recall(query, { topK = 5, minScore = null } = {}) {
      const c = cached || await connect();
      if (!c) return { ok: false, offline: true, results: [] }; // daemon offline = degradado legítimo (não erro)
      try {
        const metadata = c.projectId ? { project_id: c.projectId } : undefined;
        const r = await c.client.search(query, { topK, metadata, ...(minScore != null ? { minScore } : {}) });
        return { ok: true, results: (r && r.results) || [], projectId: c.projectId };
      } catch (e) {
        const error = e?.message || String(e);
        log("recall ERRO (surfaced, não mascarado): " + error);
        return { ok: false, error, results: [] }; // erro REAL vai no retorno pro caller surfacear
      }
    },

    /**
     * Grava na memória. `namespace` SEPARA de fato o escopo: ele sufixa o project_id, e como o recall é escopado
     * por project_id (mecânica já em produção, é assim que projetos não se misturam), o que vai para um namespace
     * NUNCA volta na busca do escopo principal.
     * POR QUE ISSO E NÃO MARCADOR NO TEXTO: a defesa anterior contra a mesa reconsumir a própria saída dependia de
     * um marcador `[ADR-REGISTRO]` no texto + do registro "caber em um chunk". Isso é acoplamento ao chunker de um
     * servidor de terceiro: se ele picar o documento, os pedaços do meio voltam SEM o marcador e a garantia quebra
     * EM SILÊNCIO. Aqui a separação usa só `project_id`, que é a única mecânica de escopo comprovadamente aplicada
     * pelo daemon — não depende de tamanho de documento nem de como ele fragmenta.
     */
    async save(content, { type = "note", tags = [], namespace = null } = {}) {
      const c = cached || await connect();
      if (!c) return { ok: false, offline: true };
      try {
        const metadata = buildSaveMetadata({ projectId: c.projectId, type, tags, namespace });
        const r = await c.client.save(content, metadata);
        return { ok: true, id: r && r.id, scope: metadata.project_id || null };
      } catch (e) {
        const error = e?.message || String(e);
        log("save ERRO (surfaced, não mascarado): " + error);
        return { ok: false, error };
      }
    },
  };
}
