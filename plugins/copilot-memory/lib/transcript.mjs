// Limpeza ESTRUTURAL do transcript para curadoria semântica. NÃO usa regex de conteúdo (nada de
// procurar "funcionou"/"errado" — isso é trabalho do curador LLM, que entende ironia/xingamento).
// Aqui só há filtro por TIPO de evento (mecânico): mantém a CONVERSA (user + assistant) e descarta
// o ruído de máquina (tool calls/results, hooks, reasoning, usage, permissões, turn markers).
//
// Saída: turnos {role, text} em ordem cronológica, e um agrupador que empacota turnos em BLOCOS
// limitados por tamanho (o curador processa um bloco por vez; o limite depende do modelo).

// Extrai texto de um content que pode ser string OU array de partes ({text}|string).
function contentText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((p) => (typeof p === "string" ? p : (p && typeof p.text === "string" ? p.text : ""))).join("");
    }
    if (typeof content === "object" && typeof content.text === "string") return content.text;
    return "";
}

function norm(s) {
    return String(s || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

// events = SessionEvent[] (de session.getEvents()). Mantém só user.message e assistant.message,
// preservando a ordem. Ignora turnos de sub-agente (agentId) — queremos a conversa principal.
// Retorna [{ role:"user"|"assistant", text, id }].
export function cleanTranscript(events) {
    const arr = Array.isArray(events) ? events : (events && events.messages) || [];
    const turns = [];
    for (const e of arr) {
        if (!e || e.ephemeral) continue;
        if (e.agentId) continue; // só o loop principal
        if (e.type === "user.message") {
            const t = norm(contentText(e.data && e.data.content));
            if (t) turns.push({ role: "user", text: t, id: e.id });
        } else if (e.type === "assistant.message") {
            const t = norm(contentText(e.data && e.data.content));
            if (t) turns.push({ role: "assistant", text: t, id: e.id });
        }
        // tudo o mais (tool.execution_*, hook.*, assistant.reasoning, *.usage, permission.*) = descartado.
    }
    return turns;
}

// Renderiza turnos como texto de conversa para o curador. Marca só o papel (sem interpretar conteúdo).
export function renderTurns(turns) {
    return turns.map((t) => `## ${t.role === "user" ? "USER" : "ASSISTANT"}\n${t.text}`).join("\n\n");
}

// Agrupa turnos em BLOCOS cujo texto renderizado fica <= maxChars. Um turno gigante vira seu próprio
// bloco (não o corta no meio — o curador lida). Retorna [{ text, fromId, toId, turns }].
export function groupIntoBlocks(turns, maxChars = 12000) {
    const blocks = [];
    let cur = [];
    let curLen = 0;
    const flush = () => {
        if (!cur.length) return;
        blocks.push({
            text: renderTurns(cur),
            fromId: cur[0].id,
            toId: cur[cur.length - 1].id,
            turns: cur.length,
        });
        cur = [];
        curLen = 0;
    };
    for (const t of turns) {
        const piece = `## ${t.role === "user" ? "USER" : "ASSISTANT"}\n${t.text}`;
        const add = piece.length + 2;
        if (curLen + add > maxChars && cur.length) flush();
        cur.push(t);
        curLen += add;
    }
    flush();
    return blocks;
}
