// Digest EVIDENCE-FIRST da sessão (getMessages() — forma validada ao vivo). Compacta o transcript
// em SINAIS VERIFICÁVEIS, não em prosa: o oráculo do "verificado" (bloqueador do advogado-do-diabo)
// são os tool.execution_complete com success=true — sinal machine-checkable, não a afirmação do agente.
//
// Mantém: pedidos do usuário, execuções de tool (nome+success+resultado curto), confirmações/correções
// do usuário, e a última mensagem do assistente. Descarta ruído: ephemeral, usage, reasoning, hooks,
// permissions, turn markers. Cada item citável carrega o `id` do evento (auditoria: "cite a fonte").

const DROP_TYPES = new Set([
    "assistant.reasoning", "assistant.usage", "session.usage_info", "assistant.turn_start",
    "assistant.turn_end", "pending_messages.modified", "session.tools_updated", "session.start",
    "session.idle", "permission.requested", "permission.completed", "hook.start", "hook.end",
]);

const CONFIRM = /\b(funciona|funcionou|deu certo|passou|correto|isso mesmo|perfeito|ótimo|otimo|resolvido|works|worked|passed|fixed|correct|resolved)\b/i;
const CORRECT = /\b(não|nao|errado|na verdade|corrig|não use|nao use|not|wrong|actually|incorrect|revert|desfaz)\b/i;

function clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
}

// Constrói o digest. messages = saída de session.getMessages(). Retorna { text, evidence, stats }.
// evidence: [{id, kind:"tool"|"user", name?, success?, label}] — os ids citáveis pela reflexão.
export function buildDigest(messages, opts = {}) {
    const maxChars = opts.maxChars || 7000;
    const arr = Array.isArray(messages) ? messages : (messages && messages.messages) || [];

    // indexa tool.execution_start por toolCallId (o nome/args moram no start; o success no complete).
    const startById = new Map();
    for (const m of arr) {
        if (m && m.type === "tool.execution_start" && m.data) startById.set(m.data.toolCallId, m.data);
    }

    const evidence = [];
    const userLines = [];
    const toolLines = [];
    let lastAssistant = "";
    let toolOk = 0, toolFail = 0;

    for (const m of arr) {
        if (!m || m.ephemeral || DROP_TYPES.has(m.type)) continue;
        if (m.type === "user.message") {
            const c = clean(m.data && m.data.content);
            if (!c) continue;
            const tag = CONFIRM.test(c) ? " (confirmação)" : CORRECT.test(c) ? " (correção)" : "";
            userLines.push(`[USER ${m.id}]${tag} ${c.slice(0, 400)}`);
            if (tag) evidence.push({ id: m.id, kind: "user", label: (tag.includes("conf") ? "confirmação: " : "correção: ") + c.slice(0, 80) });
        } else if (m.type === "tool.execution_complete") {
            const start = startById.get(m.data && m.data.toolCallId) || {};
            const name = start.toolName || (m.data && m.data.toolName) || "tool";
            const success = !!(m.data && m.data.success);
            success ? toolOk++ : toolFail++;
            const res = clean(m.data && m.data.result && (m.data.result.content || m.data.result.detailedContent));
            const args = start.arguments ? clean(JSON.stringify(start.arguments)).slice(0, 100) : "";
            toolLines.push(`[TOOL ${m.id}] ${name}(${args}) success=${success}${res ? " → " + res.slice(0, 140) : ""}`);
            evidence.push({ id: m.id, kind: "tool", name, success, label: `${name} success=${success}` });
        } else if (m.type === "assistant.message") {
            const c = clean(m.data && m.data.content);
            if (c) lastAssistant = c;
        }
    }

    // Monta evidence-first: pedidos+correções do usuário, execuções de tool, e o desfecho do assistente.
    const parts = [];
    if (userLines.length) parts.push("### Pedidos/《sinais》 do usuário\n" + userLines.join("\n"));
    if (toolLines.length) parts.push("### Execuções de ferramenta (sinal verificável)\n" + toolLines.join("\n"));
    if (lastAssistant) parts.push("### Desfecho (assistente)\n" + lastAssistant.slice(0, 800));
    let text = parts.join("\n\n");

    // orçamento: se estourar, corta as execuções de tool mais ANTIGAS (mantém usuário + desfecho).
    if (text.length > maxChars && toolLines.length > 6) {
        const keptTools = toolLines.slice(-6);
        const p2 = [];
        if (userLines.length) p2.push("### Pedidos/《sinais》 do usuário\n" + userLines.join("\n"));
        p2.push("### Execuções de ferramenta (recentes; " + (toolLines.length - keptTools.length) + " anteriores omitidas)\n" + keptTools.join("\n"));
        if (lastAssistant) p2.push("### Desfecho (assistente)\n" + lastAssistant.slice(0, 800));
        text = p2.join("\n\n");
    }
    if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";

    return {
        text,
        evidence,
        stats: { messages: arr.length, userMsgs: userLines.length, toolOk, toolFail, hasOutcome: !!lastAssistant },
    };
}
