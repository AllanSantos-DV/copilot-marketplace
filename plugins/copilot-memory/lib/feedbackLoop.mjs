// feedbackLoop — orquestra o loop de feedback governado do ADR-021 2b (lado PLUGIN, estratégia).
// miss (a busca por intenção não trouxe o nó) → GARIMPO por NOME EXATO (graph_symbols, determinístico) →
// captura ≤3 termos da query que falhou → escreve a tag amarrada ao nó confirmado.
//
// Princípios: determinístico primeiro; validação por NOME EXATO (nunca palpite fuzzy); FAIL-LOUD — o nó não
// confirmado retorna {ok:false, reason} VISÍVEL (não inventa nó) e o erro do servidor PROPAGA tipado (não
// mascara). DI: recebe {symbols, tagNode} p/ teste; default = os do graphClient.

import * as G from "./graphClient.mjs";
import { extractTerms, canonicalTag } from "./termExtract.mjs";

/**
 * @param {{ base:string, ctx:object, query:string, expectedName:string, source?:"busca-validada"|"construção" }} args
 * @param {{ symbols?:Function, tagNode?:Function }} [deps]
 * @returns {Promise<{ok:true,id:string,terms:string[],verdict:object} | {ok:false,reason:string,tried?:string,terms?:string[]}>}
 */
export async function tagOnMiss({ base, ctx, query, expectedName, source }, deps = {}) {
    const symbols = deps.symbols || G.symbols;
    const tagNode = deps.tagNode || G.tagNode;

    if (!expectedName || !String(expectedName).trim()) {
        return { ok: false, reason: "no-expected-name" };
    }

    // 1) GARIMPO determinístico: confirmar o nó por NOME EXATO (case-insensitive). Nunca por palpite.
    const res = await symbols(base, ctx, { query: expectedName, limit: 10 });
    const nodes = Array.isArray(res?.symbols) ? res.symbols : [];
    const want = String(expectedName).trim().toLowerCase();
    const node = nodes.find((n) => String(n?.name || "").toLowerCase() === want);
    if (!node || !node.id) {
        // FAIL-LOUD: não achou o nó exato → não inventa, sinaliza claramente.
        return { ok: false, reason: "node-not-found", tried: expectedName };
    }

    // 2) captura ≤3 termos de conteúdo da query que FALHOU.
    const words = extractTerms(query);
    if (words.length < 2) {
        // <2 termos distintos nunca satisfaz o gate de match (≥2) do servidor → não escreve.
        return { ok: false, reason: "too-few-terms", terms: words };
    }

    // 3) monta 1 TAG-FRASE canônica (ordenada; 1 slot dos 5, convergente) e escreve.
    //    erro do servidor PROPAGA tipado — fail-loud.
    const tag = canonicalTag(words);
    const verdict = await tagNode(base, ctx, { id: node.id, terms: [tag], source: source === "build_time" ? "build_time" : "search_validated" });
    return { ok: true, id: node.id, terms: [tag], words, verdict };
}
