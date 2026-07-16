// Camada 1 dos gates — normalizador de evento DETERMINÍSTICO e PURO (sem I/O, sem rede).
// Recebe o que o onPreToolUse entrega ({ toolName, toolArgs, workingDirectory }) e devolve um
// EVENTO ESTRUTURADO { operation, ... } quando a ação é de uma classe de risco conhecida, ou null.
//
// Princípio (revisão externa 2026-07-16): isto NÃO julga significado — só reconhece a FORMA da ação
// (estrutura de um comando de shell, caminho de um write). É a autoridade do enforcement; a semântica
// (bge-m3) só entra depois, para SUGERIR policies, nunca para bloquear. Ver files/design-dynamic-gates.md §0.
//
// Os nomes de tool abaixo são um superconjunto defensivo; o G0 shadow-mode confirma ao vivo quais o
// runtime realmente emite e este conjunto é ajustado com base nisso (não se chuta em produção).

// Nomes de tool (validados AO VIVO no G0, 2026-07-16): a terminal tool do app é "Bash" (maiúsculo),
// mesmo no Windows; outras sessões podem expor como "powershell"/"shell". O check é CASE-INSENSITIVE
// (lowercase) para casar Bash/BASH/bash. Superconjunto defensivo confirmado/ajustado pelo shadow do G0.
const SHELL_TOOLS = new Set([
    "shell", "bash", "sh", "run_in_terminal", "runinterminal", "powershell",
    "pwsh", "exec", "execute", "terminal", "cmd", "command",
]);
const WRITE_TOOLS = new Set([
    "write", "create", "createfile", "create_file", "edit", "str_replace",
    "str_replace_editor", "strreplace", "apply_patch", "applypatch", "insert", "write_file",
]);

// Tokeniza uma linha de shell respeitando aspas simples/duplas. Estrutural, não semântico.
export function tokenize(line) {
    const out = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === " " || ch === "\t") { if (cur) { out.push(cur); cur = ""; } continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

// Separa uma string de comando em sub-comandos pelos operadores de shell (&&, ||, ;, |, nova linha).
// Assim "echo x && git push" vira ["echo x", "git push"] e cada segmento é avaliado isolado.
export function splitSegments(cmd) {
    return String(cmd)
        .split(/&&|\|\||;|\n|\|/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

// Globais do git que CONSOMEM um valor no formato com espaço (ex.: `git -C /repo push`). Sem tratar isto,
// o valor viraria o "subcomando" e o push passava batido — bypass real (revisão externa, high). Ver headOf.
const GIT_VALUE_GLOBALS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

// O executável de um segmento é o primeiro token não-flag; para git, pula as flags globais (as que levam
// valor consomem 2 tokens). Devolve { exe, sub, rest } onde rest são os tokens após o subcomando.
function headOf(tokens) {
    if (!tokens.length) return null;
    const exeTok = tokens[0];
    const exe = exeTok.replace(/\\/g, "/").split("/").pop(); // /usr/bin/git -> git ; git.exe -> git.exe
    let i = 1;
    if (exe === "git" || exe === "git.exe") {
        while (i < tokens.length) {
            const t = tokens[i];
            if (t.startsWith("--") && t.includes("=")) { i += 1; continue; }   // --opt=value
            if (GIT_VALUE_GLOBALS.has(t)) { i += 2; continue; }                 // -C <val>, --git-dir <val>, -c <val>
            if (t.startsWith("-")) { i += 1; continue; }                        // flag booleana (--no-pager, -p)
            break;
        }
        return { exe: "git", sub: tokens[i] || "", rest: tokens.slice(i + 1) };
    }
    return { exe, sub: tokens[1] || "", rest: tokens.slice(2) };
}

// Reconhece um `git push` num segmento e extrai remote/branch quando presentes (estrutural). Marca formas
// cujo ALVO não dá pra resolver a um único commit (--all/--mirror/--tags ou refspec com ':') — nesses casos
// o recibo de HEAD NÃO pode ser reutilizado (bypass), então o gate trata como sujeito não-resolvível.
function parseGit(segment) {
    const h = headOf(tokenize(segment));
    if (!h || h.exe !== "git") return null;
    if (h.sub !== "push") return null;
    const positional = h.rest.filter((t) => !t.startsWith("-"));
    const remote = positional[0] || null;
    const branch = positional[1] || null;
    const force = h.rest.some((t) => t === "-f" || t === "--force" || t === "--force-with-lease");
    const pushAll = h.rest.some((t) => t === "--all" || t === "--mirror" || t === "--tags");
    // refspec: qualquer token posicional com ':' (ex.: sha:refs/heads/x) ou push de múltiplos refs.
    const refspec = positional.some((t) => t.includes(":")) || positional.length > 2;
    return {
        operation: "git-push", remote, branch, force, pushAll, refspec,
        targetRef: [remote, branch].filter(Boolean).join("/") || null,
    };
}

function firstString(obj, keys) {
    for (const k of keys) {
        const v = obj?.[k];
        if (typeof v === "string" && v.trim()) return v;
    }
    return null;
}

function toRelPath(p, workingDirectory) {
    let rel = String(p).replace(/\\/g, "/");
    const root = String(workingDirectory || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && rel.toLowerCase().startsWith(root.toLowerCase() + "/")) rel = rel.slice(root.length + 1);
    return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}

// Sinal ESTRUTURAL de GitHub Pages: um write dentro de docs/ (layout do marketplace) ou do publish dir.
// Refinável por policy (changedPaths + pagesProfile); aqui é só o reconhecedor de forma.
function pagesInfo(rel) {
    const segs = rel.split("/");
    if (segs[0] === "docs") {
        return {
            pagesProfile: "docs",
            publishKind: rel.endsWith(".html") ? "page" : (rel.startsWith("docs/content/") ? "content" : "asset"),
        };
    }
    return null;
}

/**
 * Normaliza um evento de tool em fatos estruturais, ou null se não for classe de risco.
 * @returns {null | { operation, repoRoot, targetRef?, remote?, branch?, force?, changedPaths?, pagesProfile?, publishKind?, tool, raw }}
 */
export function normalizeEvent({ toolName, toolArgs, workingDirectory } = {}) {
    const name = String(toolName || "");
    const key = name.toLowerCase();
    const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};

    if (SHELL_TOOLS.has(key)) {
        const cmd = firstString(args, ["command", "cmd", "script", "commandLine", "input", "shellCommand", "code"]);
        if (!cmd) return null;
        for (const seg of splitSegments(cmd)) {
            const g = parseGit(seg);
            if (g) return { ...g, repoRoot: workingDirectory || null, tool: name, raw: seg };
        }
        return null;
    }

    if (WRITE_TOOLS.has(key)) {
        const p = firstString(args, ["path", "file", "filePath", "file_path", "filename", "target", "uri"]);
        if (!p) return null;
        const rel = toRelPath(p, workingDirectory);
        const pi = pagesInfo(rel);
        if (pi) return { operation: "pages-write", changedPaths: [rel], ...pi, repoRoot: workingDirectory || null, tool: name, raw: rel };
        return null;
    }

    return null;
}

export const _internal = { headOf, parseGit, pagesInfo, toRelPath };
