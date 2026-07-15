// voice-text.mjs — modelagem de TEXTO para fala (puro, sem estado/IO). Limpa markdown/emoji/HTML para
// o TTS, corta em frases, e separa o resumo "autoral" (linha 🔊 legada) do corpo. Reusável e testável.

export const VOICE_SENTINEL = "🔊";
export const CHECKPOINT_SENTINEL = "📍";

// Converte markdown/HTML em texto plano falável (idempotente): tira blocos/inline de código, imagens,
// links (mantém o rótulo), títulos/citações/listas, ênfase, tags HTML, pipes de tabela, emojis e
// colapsa espaços/pontuação repetida. Nunca lança.
export function cleanForSpeech(md) {
    let t = String(md || "");
    t = t.replace(/```[\s\S]*?```/g, " ");
    t = t.replace(/`([^`]+)`/g, "$1");
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    t = t.replace(/^\s{0,3}>\s?/gm, "");
    t = t.replace(/^\s*[-*+]\s+/gm, "");
    t = t.replace(/^\s*\d+\.\s+/gm, "");
    t = t.replace(/[*_~]{1,3}/g, "");
    t = t.replace(/<[^>]+>/g, " ");
    t = t.replace(/\|/g, " ");
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "");
    t = t.replace(/\r/g, "");
    t = t.replace(/\n{2,}/g, ". ");
    t = t.replace(/\n/g, ". ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/(\.\s*){2,}/g, ". ");
    return t.trim();
}

// Trunca em fronteira de FRASE até maxChars (fallback: corte cru).
export function firstSentences(text, maxChars) {
    if (text.length <= maxChars) return text;
    const parts = text.match(/[^.!?]+[.!?]+/g) || [text];
    let out = "";
    for (const p of parts) {
        if (out && (out + p).length > maxChars) break;
        out += p;
    }
    if (!out) out = text.slice(0, maxChars);
    return out.trim();
}

// Extrai o resumo autoral (o que vem depois da ÚLTIMA linha 🔊 — modelo legado). null se não houver.
export function extractAuthoredSummary(content) {
    const idx = content.lastIndexOf(VOICE_SENTINEL);
    if (idx === -1) return null;
    const after = content.slice(idx + VOICE_SENTINEL.length).split(/\n{2,}/)[0];
    return after.trim() || null;
}

// Remove as linhas de checkpoint (📍) do corpo (elas são faladas à parte como cue de progresso).
export function stripCheckpointLines(text) {
    return String(text || "")
        .split("\n")
        .filter((ln) => !ln.includes(CHECKPOINT_SENTINEL))
        .join("\n");
}

// Deriva { spoken, full, authored } de uma resposta: se houver resumo 🔊 autoral, fala ele (e o corpo
// vira o "full" p/ a UI); senão fala as primeiras frases do corpo limpo.
export function makeSpoken(content) {
    const authored = extractAuthoredSummary(content);
    if (authored) {
        let spoken = cleanForSpeech(authored);
        if (spoken.length > 2400) spoken = firstSentences(spoken, 2400);
        const body = stripCheckpointLines(content.slice(0, content.lastIndexOf(VOICE_SENTINEL))).trim();
        const fullClean = cleanForSpeech(body || content);
        const full = fullClean.length > 3000 ? fullClean.slice(0, 3000) : fullClean;
        if (spoken) return { spoken, full, authored: true };
    }
    const cleaned = cleanForSpeech(stripCheckpointLines(content));
    const full = cleaned.length > 3000 ? cleaned.slice(0, 3000) : cleaned;
    const spoken = firstSentences(full, 450);
    return { spoken, full, authored: false };
}
