// Scaffold do escopo de projeto (parte B) — nudge ASKED-ONCE. Quando o escopo é FRÁGIL (path/nome,
// sem .memory/project.json nem git remote/base), o hook sugere UMA vez que o agente analise a estrutura
// e crie o .memory/project.json. A decisão vira uma marca GLOBAL indexada pelo workspace (não suja a
// pasta de quem recusou). 3 estados efetivos: resolvido (arquivo existe) · asked (já perguntei) · declined.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
function stampPath() {
    return join(dir(), "scaffold-asked.json");
}
function wsKey(workspacePath) {
    return createHash("sha1").update(String(workspacePath || "").toLowerCase()).digest("hex").slice(0, 16);
}

function readStamps() {
    try {
        const raw = readFileSync(stampPath(), "utf8");
        const o = JSON.parse(raw);
        return o && typeof o === "object" ? o : {};
    } catch {
        return {};
    }
}
function writeStamps(obj) {
    try {
        mkdirSync(dir(), { recursive: true });
        writeFileSync(stampPath(), JSON.stringify(obj, null, 2), "utf8");
    } catch { /* best-effort */ }
}

// Já perguntei (ou o usuário recusou) para este workspace?
export function alreadyAsked(workspacePath) {
    const st = readStamps()[wsKey(workspacePath)];
    return !!st && (st.status === "asked" || st.status === "declined");
}

// Registra que perguntei (asked) ou que o usuário recusou de vez (declined). Nunca lança.
export function markAsked(workspacePath, status = "asked") {
    const all = readStamps();
    all[wsKey(workspacePath)] = { status, workspace: workspacePath, ts: new Date().toISOString() };
    writeStamps(all);
}

// Deve sugerir agora? Gate pela FORÇA do escopo (isFragileScope já faz o walk-up: strength declared/
// git-remote ⇒ não frágil ⇒ não sugere). Dispara quando frágil ("none") — inclusive no beco em que
// existe um marcador SEM project_id usável (resolver lança, mas o usuário precisa da orientação).
// Não checa a existência do arquivo (isso silenciava esse beco). Uma única vez por workspace.
export function shouldOfferScaffold(workspacePath, fragile) {
    if (!fragile) return false;
    if (alreadyAsked(workspacePath)) return false; // X de zero nas próximas
    return true;
}

// Template do .memory/project.json (espelha ProjectConfig.java) que o agente deve preencher.
export function projectJsonTemplate({ suggestedName, suggestedProjectId } = {}) {
    const name = suggestedName || "<nome-do-projeto>";
    const pid = suggestedProjectId || "<owner>/<projeto>";
    return JSON.stringify({
        version: "1",
        project: { name, client: "<cliente|opcional>", team: "<time|opcional>" },
        metadata: {
            defaults: { project_id: pid },
            branches: { "feat/*": { type: "feature" }, "fix/*": { type: "bugfix" }, "main": { type: "production" } },
        },
        user: { identifyBy: "git-email" },
    }, null, 2);
}

// Bloco de contexto (additionalContext) que instrui o agente — injetado UMA vez. Não força nada;
// explica o porquê e dá o modelo. A criação é decisão do agente/usuário.
export function scaffoldGuidance(workspacePath, { suggestedName, suggestedProjectId } = {}) {
    const tmpl = projectJsonTemplate({ suggestedName, suggestedProjectId });
    return [
        "# 🧠 Memória: escopo de projeto sem identificador estável",
        "",
        `Este workspace (${workspacePath}) não tem um \`project_id\` estável: não há \`.memory/project.json\` ` +
        "na raiz nem um `git remote origin`. **Sem um identificador estável, a memória NÃO é gravada nem " +
        "injetada** (fail-loud, de propósito — para não espalhar escopo-lixo indexado por caminho de pasta). " +
        "Resolva de uma destas formas:",
        "",
        "1. **Crie `.memory/project.json` na raiz do projeto** (recomendado; portável entre máquinas, " +
        "worktrees e subpastas). ANALISE a estrutura de pastas para inferir um bom nome e um `project_id` " +
        "canônico (ex.: `owner/projeto`, estável e único). Use `memory_init_project` ou escreva o arquivo. Modelo:",
        "",
        "```json",
        tmpl,
        "```",
        "",
        "2. **Ou** trabalhe num repositório com `git remote origin` — o `project_id` sai do remote (único por repo).",
        "",
        "_Se este diretório não for um projeto de verdade (pasta avulsa, temporário), ignore — " +
        "não vou sugerir de novo aqui._",
    ].join("\n");
}
