// O CURADOR — um agente LLM (subagente via SDK createSession) que lê um bloco de CONVERSA (usuário +
// assistente) e extrai lições reusáveis. É SEMÂNTICO por design: entende ironia, xingamento velado,
// frustração e instrução repetida — sinais que regex jamais pega. NÃO há filtro determinístico de
// conteúdo aqui; a decisão do que é lição é 100% do modelo. Captura DOIS tipos: técnica e
// COMPORTAMENTAL (anti-padrões do próprio assistente que o usuário criticou).
import { fileURLToPath } from "node:url";
import { join, dirname, basename, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve o binário do NODE real. No fork da extensão, process.execPath é o `copilot` (não node), então
// spawná-lo rodaria o CLI. Procuramos node/node.exe: 1) se execPath já é node, usa; 2) no PATH; 3) "node".
function resolveNode() {
    try {
        const self = basename(process.execPath).toLowerCase();
        if (self === "node" || self === "node.exe") return process.execPath;
    } catch { /* segue */ }
    for (const dir of String(process.env.PATH || "").split(delimiter)) {
        if (!dir || !dir.trim()) continue;
        for (const marker of ["node.exe", "node"]) {
            try { const c = join(dir, marker); if (existsSync(c)) return c; } catch { /* segue */ }
        }
    }
    return "node";
}

function contentText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p && typeof p.text === "string" ? p.text : ""))).join("");
    if (typeof content === "object" && typeof content.text === "string") return content.text;
    return "";
}

// Extrai o array JSON da resposta do modelo (pode vir cercado por ```json … ``` ou prosa).
export function parseSkillsJson(text) {
    const s = String(text || "");
    // 1) bloco cercado
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    // 2) primeiro '[' … último ']'
    const a = s.indexOf("["), b = s.lastIndexOf("]");
    if (a >= 0 && b > a) candidates.push(s.slice(a, b + 1));
    candidates.push(s);
    for (const c of candidates) {
        try {
            const v = JSON.parse(c.trim());
            if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object" && x.name && x.description && x.body);
        } catch { /* tenta o próximo */ }
    }
    return [];
}

export const CURATOR_INSTRUCTION = [
    "Você é um CURADOR de aprendizado. Leia a conversa abaixo entre um USUÁRIO e um ASSISTENTE de código",
    "e extraia LIÇÕES reusáveis para o assistente aplicar em sessões futuras.",
    "",
    "Capture DOIS tipos:",
    "1. TÉCNICA — um fato/procedimento verificado e generalizável (uma API que se comporta diferente do",
    "   documentado, um passo que resolveu o problema, uma convenção do projeto).",
    "2. COMPORTAMENTAL — um anti-padrão do ASSISTENTE que o usuário criticou. O sinal é SEMÂNTICO, não",
    "   literal: o usuário fica irônico, xinga, se irrita, repete a mesma instrução, ou diz que algo 'já",
    "   está claro/validado'. Ex.: pedir confirmação do que já foi aprovado; perguntar o óbvio; ler raso;",
    "   ignorar uma instrução explícita; fugir do que foi combinado; usar solução frágil que o usuário",
    "   rejeitou. A lição ensina o assistente a NÃO repetir aquilo — no gatilho certo.",
    "",
    "Regras duras:",
    "- Só o que é GENERALIZÁVEL e VERIFICADO: o usuário confirmou, ou o resultado se provou na conversa.",
    "  Descarte tentativa-e-erro, detalhe efêmero e específico-demais.",
    "- Para comportamental, ancore no sinal REAL do usuário (a crítica/ironia) e formule 'quando X, faça Y — não Z'.",
    "- name e description em PORTUGUÊS; body em INGLÊS. description diz o que é E quando aplicar, com um 'não use quando'.",
    "",
    "Responda APENAS um array JSON válido, nada fora dele. Cada item:",
    '{"kind":"technical"|"behavioral","name":"curto (PT, <=64)","description":"PT: o que + quando usar (e quando NÃO)","body":"## What\\n…\\n## When to use\\n…\\n## Do\\n…\\n## Don\'t\\n…"}',
    "Se não houver lição que valha (generalizável E verificada), responda [].",
].join("\n");

// Roda o agente (worker) com um prompt e retorna { text, error? }. Spawna um node LIMPO (sem os
// loaders/hooks do fork, que quebram o CopilotClient) e passa o prompt via stdin. Nunca lança.
export async function runAgent(prompt, { workingDirectory, model, timeoutMs } = {}) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;      // não herdar o resolver hook do fork
    delete env.COPILOT_SDK_PATH;  // não usar o SDK do app; o worker resolve o global via PATH
    env.COPILOT_MEMORY_CURATOR_CWD = workingDirectory || process.cwd();
    if (model || process.env.COPILOT_MEMORY_CURATOR_MODEL) env.COPILOT_MEMORY_CURATOR_MODEL = model || process.env.COPILOT_MEMORY_CURATOR_MODEL;
    env.COPILOT_MEMORY_CURATOR_TIMEOUT = String(timeoutMs || 150000);

    const worker = join(HERE, "curatorWorker.mjs");
    return await new Promise((resolve) => {
        let out = "", err = "", done = false;
        let child;
        const finish = (r) => { if (done) return; done = true; try { child && child.kill(); } catch { /* ignore */ } resolve(r); };
        const killer = setTimeout(() => finish({ text: "", error: "timeout no agente" }), (timeoutMs || 150000) + 30000);
        try {
            child = spawn(resolveNode(), [worker], { env, cwd: workingDirectory || process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        } catch (e) {
            clearTimeout(killer);
            return finish({ text: "", error: "spawn falhou: " + (e?.message || e) });
        }
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.stderr.on("data", (d) => { err += d.toString(); });
        child.on("error", (e) => { clearTimeout(killer); finish({ text: "", error: "worker: " + (e?.message || e) }); });
        child.on("close", (code) => {
            clearTimeout(killer);
            if (code !== 0) return finish({ text: "", error: (err.trim() || `worker saiu com código ${code}`).slice(0, 300) });
            finish({ text: out });
        });
        try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { clearTimeout(killer); finish({ text: "", error: "stdin: " + (e?.message || e) }); }
    });
}

// Cura um bloco de conversa → { skills, error? }.
export async function curateBlock(blockText, { workingDirectory, model, timeoutMs, sourceLabel } = {}) {
    const prompt = `${CURATOR_INSTRUCTION}\n\n=== CONVERSA (${sourceLabel || "bloco"}) ===\n${blockText}`;
    const { text, error } = await runAgent(prompt, { workingDirectory, model, timeoutMs });
    if (error) return { skills: [], error };
    return { skills: parseSkillsJson(text) };
}

// Extrai o primeiro objeto JSON da resposta (a decisão do reconciliador).
export function parseDecisionJson(text) {
    const s = String(text || "");
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const cands = [];
    if (fenced) cands.push(fenced[1]);
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) cands.push(s.slice(a, b + 1));
    cands.push(s);
    for (const c of cands) {
        try { const v = JSON.parse(c.trim()); if (v && typeof v === "object" && v.action) return v; } catch { /* próximo */ }
    }
    return null;
}

export const RECONCILE_INSTRUCTION = [
    "Você é o SKILL CREATOR. Recebe uma LIÇÃO nova (destilada de uma conversa) e as SKILLS EXISTENTES",
    "mais similares (do PROJETO e GLOBAIS). Decida o que fazer, semanticamente:",
    "",
    "- \"create\" — a lição é genuinamente NOVA (nenhuma existente cobre o mesmo tópico).",
    "- \"update\" — a lição melhora, CORRIGE ou complementa uma skill EXISTENTE DO PROJETO. Dê o `targetId`",
    "  dela e o CONTEÚDO reconciliado (mescle o que há de bom; se a lição nova corrige a antiga —",
    "  informação mais recente vence — escreva a versão correta). Use isto quando a nova CONTRADIZ uma",
    "  existente: não crie duplicata, corrija a existente.",
    "- \"promote_global\" — a lição é GENERALIZÁVEL além deste projeto (vale para qualquer projeto: um",
    "  comportamento do assistente, uma verdade de uma ferramenta/SDK). Se evolui uma existente, dê o",
    "  `targetId`; se é nova, omita targetId.",
    "- \"skip\" — a lição é redundante com uma existente que já está correta (nada a fazer).",
    "",
    "Regras: name/description em PORTUGUÊS (description com 'quando NÃO usar'); body em INGLÊS com",
    "## What / ## When to use / ## Do / ## Don't. Lições COMPORTAMENTAIS (anti-padrões do assistente)",
    "quase sempre são \"promote_global\" — servem em qualquer projeto.",
    "",
    "Responda APENAS um objeto JSON, nada fora dele:",
    '{"action":"create|update|promote_global|skip","targetId":"<id ou omita>","kind":"technical|behavioral","name":"PT","description":"PT","body":"EN","reason":"curto"}',
].join("\n");

// Decide o destino de uma lição dado os candidatos existentes. lesson={kind,name,description,body};
// candidates=[{id,scope,score,name,description,content}]. Retorna a decisão (ou null em erro).
export async function reconcileSkill(lesson, candidates, { workingDirectory, model, timeoutMs } = {}) {
    const prompt = [
        RECONCILE_INSTRUCTION,
        "",
        "## LIÇÃO NOVA",
        JSON.stringify({ kind: lesson.kind, name: lesson.name, description: lesson.description, body: lesson.body }, null, 2),
        "",
        "## SKILLS EXISTENTES SIMILARES",
        JSON.stringify(candidates.map((c) => ({ id: c.id, scope: c.scope, name: c.name, description: c.description })), null, 2),
    ].join("\n");
    const { text, error } = await runAgent(prompt, { workingDirectory, model, timeoutMs });
    if (error) return null;
    return parseDecisionJson(text);
}
