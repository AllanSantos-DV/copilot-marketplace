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

// Cura um bloco de conversa. Retorna { skills, error? }. Nunca lança. Spawna o WORKER num node LIMPO
// (sem os loaders/hooks do fork, que quebram o CopilotClient) e passa o prompt via stdin.
export async function curateBlock(blockText, { workingDirectory, model, timeoutMs, sourceLabel } = {}) {
    const prompt = `${CURATOR_INSTRUCTION}\n\n=== CONVERSA (${sourceLabel || "bloco"}) ===\n${blockText}`;
    // Env do filho: LIMPA NODE_OPTIONS (senão herda os --import/--loader do fork → o resolver hook do
    // host redireciona @github/copilot e o CopilotClient falha). Repassa SDK path/cwd/model/timeout.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.COPILOT_SDK_PATH; // não usar o SDK do app; o worker resolve o global via PATH
    env.COPILOT_MEMORY_CURATOR_CWD = workingDirectory || process.cwd();
    if (model || process.env.COPILOT_MEMORY_CURATOR_MODEL) env.COPILOT_MEMORY_CURATOR_MODEL = model || process.env.COPILOT_MEMORY_CURATOR_MODEL;
    env.COPILOT_MEMORY_CURATOR_TIMEOUT = String(timeoutMs || 150000);

    const worker = join(HERE, "curatorWorker.mjs");
    return await new Promise((resolve) => {
        let out = "", err = "", done = false;
        let child;
        const finish = (r) => { if (done) return; done = true; try { child && child.kill(); } catch { /* ignore */ } resolve(r); };
        const killer = setTimeout(() => finish({ skills: [], error: "timeout na curadoria" }), (timeoutMs || 150000) + 30000);
        try {
            child = spawn(resolveNode(), [worker], { env, cwd: workingDirectory || process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        } catch (e) {
            clearTimeout(killer);
            return finish({ skills: [], error: "spawn falhou: " + (e?.message || e) });
        }
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.stderr.on("data", (d) => { err += d.toString(); });
        child.on("error", (e) => { clearTimeout(killer); finish({ skills: [], error: "worker: " + (e?.message || e) }); });
        child.on("close", (code) => {
            clearTimeout(killer);
            if (code !== 0) return finish({ skills: [], error: (err.trim() || `worker saiu com código ${code}`).slice(0, 300) });
            finish({ skills: parseSkillsJson(out) });
        });
        try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { clearTimeout(killer); finish({ skills: [], error: "stdin: " + (e?.message || e) }); }
    });
}
