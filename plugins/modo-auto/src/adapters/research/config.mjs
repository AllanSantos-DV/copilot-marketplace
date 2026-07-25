// config.mjs — CONFIGURAÇÃO da pesquisa (o "lugar pra pôr API key" que faltava). Lê ~/.modo-auto/config.json
// (mesmo dir do worker-config; FORA do repo → seguro p/ secrets, nunca commitado) na seção "research", com
// OVERRIDE por env (precedência env > arquivo). FAIL-LOUD: se o arquivo EXISTE mas é JSON inválido, LANÇA
// (erro do usuário sobe, não cai calado no grátis); se AUSENTE, degrada p/ o modo grátis (jina-ddg) — ausência
// genuína e sinalizada. Determinístico e testável (deps injetáveis).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = process.env.MODO_AUTO_CONFIG || join(homedir(), ".modo-auto", "config.json");

const PROVIDERS = ["auto", "jina-ddg", "brave"]; // 'auto' = premium se key, senão grátis

/**
 * @param {{ path?:string, env?:Record<string,string>, readFile?:(p:string)=>string, exists?:(p:string)=>boolean }} [deps]
 * @returns {{ searchProvider:string, keys:{brave:string|null,tavily:string|null,jina:string|null}, source:string }}
 */
export function loadResearchConfig({ path = CONFIG_PATH, env = process.env, readFile = (p) => readFileSync(p, "utf8"), exists = existsSync } = {}) {
  let fileCfg = {};
  let source = "defaults";
  if (exists(path)) {
    let raw;
    try { raw = readFile(path); } catch (e) { throw new Error(`research.config: falha ao ler ${path}: ${e?.message || e}`); }
    try { fileCfg = JSON.parse(raw); } catch (e) { throw new Error(`research.config: ${path} é JSON inválido (corrija ou remova): ${e?.message || e}`); } // FAIL-LOUD
    source = path;
  }
  const research = (fileCfg && typeof fileCfg.research === "object" && fileCfg.research) || {};
  const fileKeys = (research.keys && typeof research.keys === "object" && research.keys) || {};

  // precedência: env > arquivo. Keys vazias/whitespace viram null (ausência real).
  const pick = (envName, fileVal) => { const v = (env[envName] || fileVal || "").toString().trim(); return v || null; };
  const keys = {
    brave: pick("MODO_AUTO_BRAVE_KEY", fileKeys.brave),
    tavily: pick("MODO_AUTO_TAVILY_KEY", fileKeys.tavily),
    jina: pick("MODO_AUTO_JINA_KEY", fileKeys.jina),
  };

  let searchProvider = (env.MODO_AUTO_SEARCH_PROVIDER || research.searchProvider || "auto").toString().trim();
  if (!PROVIDERS.includes(searchProvider)) throw new Error(`research.config: searchProvider inválido '${searchProvider}' (use: ${PROVIDERS.join(", ")})`); // FAIL-LOUD
  return { searchProvider, keys, source };
}

// Resolve QUAL provider de busca usar, dado o config. FAIL-LOUD honesto:
//  - provider EXPLÍCITO 'brave' SEM key → LANÇA (o usuário pediu premium mas não deu a key; não cair calado no grátis).
//  - 'auto' → 'brave' se houver key, senão 'jina-ddg' (grátis) — degradação natural sinalizada por `reason`.
//  - 'jina-ddg' → sempre grátis.
export function resolveSearchProvider(cfg) {
  const { searchProvider, keys } = cfg;
  if (searchProvider === "brave") {
    if (!keys.brave) throw new Error("research.config: searchProvider='brave' exige a key (config.research.keys.brave ou env MODO_AUTO_BRAVE_KEY). Configure a key ou use 'auto'/'jina-ddg'.");
    return { provider: "brave", reason: "explícito+key" };
  }
  if (searchProvider === "auto" && keys.brave) return { provider: "brave", reason: "auto+key" };
  return { provider: "jina-ddg", reason: searchProvider === "auto" ? "auto sem key (grátis)" : "explícito grátis" };
}
