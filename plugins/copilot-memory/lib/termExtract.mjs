// termExtract — captura DETERMINÍSTICA de até 3 termos de conteúdo de uma query que falhou (ADR-021 2b).
// NÃO é classificação semântica (nada de regex/heurística de SENTIDO): tokeniza, remove stopwords PT+EN,
// deduplica preservando ordem e corta em 3. Todos os termos, por construção, aparecem na query real — o
// servidor exige exatamente isso (só termos presentes na query validada; stopwords não contam nem furam
// o gate; teto de 3 termos de conteúdo por escrita).

/**
 * @typedef {"busca-validada"|"construção"} TagSource
 * @typedef {{ id:string, terms:string[], source:TagSource }} TagWriteParams
 * @typedef {{ accepted?:string[], dropped_over_cap?:string[], rejected?:string[] }} TagWriteResult
 */

// Stopwords PT+EN (funcionais, sem valor de conteúdo). Hardcoded e pequeno de propósito (determinístico,
// zero dependência). Não inclui termos técnicos curtos (id, io, db) — esses são conteúdo válido.
const STOPWORDS = new Set([
    // EN
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "on", "in", "to", "for", "with",
    "without", "from", "by", "at", "as", "is", "are", "was", "were", "be", "been", "being", "do", "does",
    "did", "how", "what", "when", "where", "which", "who", "why", "this", "that", "these", "those", "it",
    "its", "into", "over", "after", "before", "per", "via", "not", "no", "yes", "can", "could", "should",
    "would", "will", "shall", "may", "might", "must", "we", "you", "they", "i", "he", "she",
    // PT
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "e", "ou", "mas",
    "se", "que", "com", "sem", "por", "para", "pra", "no", "na", "nos", "nas", "em", "ao", "aos", "à",
    "às", "como", "quando", "onde", "qual", "quais", "quem", "porque", "isso", "isto", "aquilo", "ele",
    "ela", "eles", "elas", "nós", "você", "vocês", "ser", "estar", "é", "são", "foi", "era", "seu", "sua",
    "meu", "minha", "pelo", "pela", "num", "numa", "dele", "dela", "mais", "menos", "já", "também",
]);

/**
 * Extrai até 3 termos de conteúdo de uma query. Determinístico, puro (zero I/O).
 * @param {string} query
 * @returns {string[]} 0..3 termos (lowercase, únicos, presentes na query, sem stopwords)
 */
export function extractTerms(query) {
    if (typeof query !== "string" || !query.trim()) return [];
    // Tokeniza por não-alfanumérico, preservando letras acentuadas (Unicode). camelCase NÃO é quebrado.
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const tok of tokens) {
        if (tok.length < 2) continue;            // 1-char não é conteúdo
        if (STOPWORDS.has(tok)) continue;        // funcional, não conta
        if (!/\p{L}/u.test(tok)) continue;       // precisa ter ao menos uma letra (descarta puro-número)
        if (seen.has(tok)) continue;             // dedup preservando ordem
        seen.add(tok);
        out.push(tok);
        if (out.length === 3) break;             // teto do contrato
    }
    return out;
}

// Monta a TAG CANÔNICA a partir dos termos de conteúdo: 1 tag-frase com os ≤3 tokens em ordem ORDENADA.
// Por quê (decidido pela fonte do servidor — SparseTagMatcher): o matcher tokeniza cada tag e AGRUPA todas
// as tags live do nó num único conjunto de tokens; logo 1 tag-frase e N tags single-word casam/ranqueiam
// IDÊNTICO — mas a frase gasta 1 slot dos 5 (não N), e a ordem canônica faz a MESMA intenção de sessões/
// agentes diferentes virar a MESMA string → o servidor DEDUPA/reforça em vez de fragmentar. Order-invariant
// no match, então ordenar é grátis e só ganha convergência.
export function canonicalTag(words) {
    const w = Array.isArray(words) ? words.filter((x) => typeof x === "string" && x.trim()) : [];
    return w.slice().sort().join(" ");
}

export const _internal = { STOPWORDS };
