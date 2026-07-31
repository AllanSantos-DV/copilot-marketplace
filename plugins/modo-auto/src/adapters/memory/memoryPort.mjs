// MemoryPort — recall/save escopados por project_id, via daemon native-java. Memória é OPCIONAL:
// daemon offline → { ok:false, offline:true } (degradado legítimo). Erro REAL da chamada → { ok:false,
// error } VISÍVEL (surfaced, não mascarado). Reusa o MESMO project_id da sessão (não recria escopo).

import { discover } from "./daemon.mjs";
import { tryResolveProjectId } from "./projectId.mjs";
import { MemoryClient } from "./client.mjs";

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

    async save(content, { type = "note", tags = [] } = {}) {
      const c = cached || await connect();
      if (!c) return { ok: false, offline: true };
      try {
        const metadata = { type };
        if (c.projectId) metadata.project_id = c.projectId;
        if (Array.isArray(tags) && tags.length) metadata.tags = tags;
        const r = await c.client.save(content, metadata);
        return { ok: true, id: r && r.id };
      } catch (e) {
        const error = e?.message || String(e);
        log("save ERRO (surfaced, não mascarado): " + error);
        return { ok: false, error };
      }
    },
  };
}
