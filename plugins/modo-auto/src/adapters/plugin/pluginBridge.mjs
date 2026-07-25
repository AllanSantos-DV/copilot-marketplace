// Ponte de REUSO do plugin copilot-memory (dependência OPCIONAL). O plugin é a fonte CANÔNICA do client do
// servidor de memória (grafo semântico + memória). Se estiver instalado, o modo-auto REUSA a lib dele
// (single source of truth, sem duplicar) — em especial o graphClient (scanner de grafo) e o MemoryClient.
// Se NÃO estiver, cai nos clients vendados: nada quebra (sem dependência dura). O SERVIDOR fica agnóstico
// atrás do plugin — o modo-auto nunca fala direto com ele quando o plugin está presente.
//
// Import é 100% ESM puro (verificado ao vivo: só node:*, sem side-effects). FAIL LOUD sinalizado: plugin
// presente mas com import quebrado → loga o erro real e cai no fallback (não mascara silencioso, não derruba).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// Locais de instalação, em ordem: override de dev (env) → onde o app carrega (extensions) → installed-plugins.
export function pluginCandidates() {
  const h = homedir();
  const env = String(process.env.MODO_AUTO_MEMORY_PLUGIN_DIR || "").trim();
  return [
    ...(env ? [env] : []),
    join(h, ".copilot", "extensions", "copilot-memory"),
    join(h, ".copilot", "installed-plugins", "copilot-memory"),
  ];
}

// Diretório do plugin (o que tiver lib/graphClient.mjs) ou null.
export function resolvePluginDir(cands = pluginCandidates()) {
  for (const c of cands) { try { if (c && existsSync(join(c, "lib", "graphClient.mjs"))) return c; } catch { /* segue */ } }
  return null;
}

export function pluginVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).version || null; } catch { return null; }
}

let _cache; // undefined = não tentado; null = ausente; objeto = carregado; {error} = presente mas quebrado
/**
 * Carrega a lib do plugin (dynamic import). @returns null (ausente) | {dir,version,graph,client,recall,daemon,projectId} | {error}
 */
export async function loadMemoryPlugin({ dir, log = () => {} } = {}) {
  if (_cache !== undefined && !dir) return _cache;
  const root = dir || resolvePluginDir();
  // ausência legítima (dir não dado e não resolvido, OU dir dado sem a lib) → null, não erro.
  if (!root || !existsSync(join(root, "lib", "graphClient.mjs"))) { if (!dir) _cache = null; return null; }
  const libUrl = (m) => pathToFileURL(join(root, "lib", m)).href;
  try {
    const [graph, client, recall, daemon, projectId] = await Promise.all([
      import(libUrl("graphClient.mjs")), import(libUrl("client.mjs")),
      import(libUrl("recall.mjs")), import(libUrl("daemon.mjs")), import(libUrl("projectId.mjs")),
    ]);
    const bundle = { dir: root, version: pluginVersion(root), graph, client, recall, daemon, projectId };
    log(`[plugin] copilot-memory REUSADO de ${root} (v${bundle.version})`);
    if (!dir) _cache = bundle;
    return bundle;
  } catch (e) {
    // plugin existe mas o import quebrou → SINALIZA (não mascara) e cai no fallback vendado.
    log(`[plugin] copilot-memory presente mas falhou ao importar (fallback vendado): ${e?.message || e}`);
    const err = { error: e?.message || String(e) };
    if (!dir) _cache = err;
    return err;
  }
}

// bundle utilizável? (tem graph/client). {error} e null → não.
export function isUsable(loaded) { return !!(loaded && !loaded.error && loaded.graph && loaded.client); }
