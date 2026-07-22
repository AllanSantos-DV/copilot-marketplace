// Classificador PURO (zero I/O) do grep-guard: decide se uma chamada de busca é AMPLA/absurda
// (varre uma raiz gigante → frita a máquina) e deve ser BLOQUEADA, ou é escopada e passa.
//
// Cirúrgico de propósito (decisão do dono + mesa): bloqueia só ALVOS ABSURDOS — home, raiz de disco,
// ~/.copilot, ~/.copilot-memory, ~/.mcp-memory, AppData, Temp, Program Files, Windows — NÃO grep em
// geral. Um grep dentro de um projeto normal (mesmo o repo inteiro, que é pequeno) PASSA: o que trava
// a máquina é varrer árvores gigantes (medido: ~/.copilot = 137k arquivos / 21GB). Fail-open: na dúvida,
// ALLOW (nunca trava a sessão). A checagem de "memória ativa" NÃO é feita aqui — é do hook (I/O).
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";

// Nomes de tool de BUSCA (case-insensitive): host (Grep/Glob) + variantes; shell é tratado à parte.
const HOST_SEARCH = new Set(["grep", "glob", "ripgrep", "rg", "grep_search", "file_search"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "pwsh", "run_in_terminal", "shell", "sh", "cmd"]);

// É uma tool de busca (host ou shell)? Usado pelo hook para early-exit BARATO (sem git) nos ~95% de
// tool calls que não são busca. Case-insensitive.
export function isSearchTool(toolName) {
    if (!toolName) return false;
    const n = String(toolName).toLowerCase();
    return HOST_SEARCH.has(n) || SHELL_TOOLS.has(n);
}

// Normaliza um caminho para comparação (resolve + barra unix + minúsculo p/ Windows-insensitive).
function norm(p) {
    try { return resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/"; }
    catch { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
}

// Subárvores INTEIRAS a bloquear (prefixo): qualquer alvo DENTRO delas é absurdo p/ busca recursiva.
function prefixRoots() {
    const home = homedir();
    const out = [];
    const add = (p) => { if (p && String(p).trim()) out.push(norm(p)); };
    add(`${home}/.copilot`);
    add(`${home}/.copilot-memory`);
    add(`${home}/.mcp-memory`);
    add(process.env.APPDATA);
    add(process.env.LOCALAPPDATA);
    add(process.env.TEMP);
    add(process.env.TMP);
    add(process.env.ProgramFiles);
    add(process.env["ProgramFiles(x86)"]);
    add(process.env.SystemRoot); // C:\Windows
    return [...new Set(out)];
}

// É uma raiz de disco? c:/  d:/  ou  /  (unix).
function isDriveRoot(n) { return /^[a-z]:$/i.test(n) || /^[a-z]:\/$/i.test(n) || n === "/" || n === ""; }

// O alvo (resolvido a partir do cwd) é ABSURDO para busca recursiva?
export function isBroadTarget(cwd, target) {
    const base = cwd && String(cwd).trim() ? String(cwd) : process.cwd();
    let t;
    try { t = norm(isAbsolute(String(target)) ? String(target) : resolve(base, String(target))); }
    catch { return false; } // não resolveu → fail-open (não bloqueia)
    if (isDriveRoot(t)) return true;                 // raiz de disco
    if (t === norm(homedir())) return true;          // home EXATO (projetos sob home passam)
    for (const root of prefixRoots()) {              // subárvores inteiras (prefixo)
        if (t === root || t.startsWith(root + "/")) return true;
    }
    return false;
}

// Remove LITERAIS antes de tokenizar posição-de-comando: here-strings do PowerShell (@'...'@ / @"..."@)
// e strings entre aspas. Assim o corpo de um heredoc/echo (que pode CITAR rg/grep/crases como dado) não
// é confundido com invocação. O executável de busca real é sempre bareword em posição de comando.
function stripLiterals(cmd) {
    return String(cmd)
        .replace(/@(['"])[\s\S]*?\1@/g, " ")   // here-string PowerShell @'...'@ / @"..."@
        .replace(/"[^"]*"/g, " ")               // "..."
        .replace(/'[^']*'/g, " ");              // '...'
}

// Tokens em POSIÇÃO DE COMANDO: o 1º bareword de cada segmento (split por pipe/;/&/newline/backtick/
// parênteses), sobre o comando SEM literais. É isto que distingue "rodar rg" de só CITAR "rg" num texto.
function leadTokens(cmd) {
    return stripLiterals(cmd)
        .split(/[|;&\n\r`()]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            let seg = s;
            // pula atribuições de env à frente (FOO=bar cmd)
            let a;
            while ((a = seg.match(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/))) seg = seg.slice(a[0].length);
            const m = seg.match(/^["']?([^\s"']+)/);
            if (!m) return "";
            // tira prefixo de caminho do executável (/usr/bin/grep, .\rg.exe) e sufixo .exe
            return String(m[1]).split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
        })
        .filter(Boolean);
}

const SEARCH_EXE = new Set(["rg", "ripgrep", "grep", "egrep", "fgrep", "findstr", "select-string", "sls"]);

// O comando shell INVOCA uma busca recursiva? Só conta se a ferramenta está em posição de comando —
// citar "grep"/"rg" como dado (doc, echo, heredoc Node) NÃO conta.
function isRecursiveSearchCmd(cmd) {
    for (const t of leadTokens(cmd)) {
        if (SEARCH_EXE.has(t)) return true;
        if ((t === "get-childitem" || t === "gci" || t === "ls" || t === "dir") && /(-r\b|-recurse\b|\/s\b)/i.test(cmd)) return true;
    }
    return false;
}

// O comando referencia explicitamente uma raiz absurda? (best-effort, sem parsear shell). home NÃO
// entra como prefixo — só é amplo como ALVO EXATO (senão qualquer caminho sob a home casaria). Conta
// as subárvores gigantes (~/.copilot, AppData, Temp…) como substring e a raiz de disco como token isolado.
// Roda sobre o comando SEM literais (stripLiterals): um caminho amplo dentro de string/aspas é DADO, não
// alvo — evita bloquear uma busca escopada cujo PADRÃO cita um caminho amplo entre aspas.
function cmdMentionsBroad(cwd, cmd) {
    const stripped = stripLiterals(cmd);
    const c = String(stripped).replace(/\\/g, "/").toLowerCase();
    for (const root of prefixRoots()) { if (c.includes(root)) return true; }
    if (/(^|\s)[a-z]:[\\/](\s|$)/i.test(String(stripped))) return true;   // C:\ ou C:/ isolado
    if (/(^|\s)~[\\/]\.(copilot|mcp-memory)/i.test(String(stripped))) return true; // ~/.copilot em forma tilde
    return false;
}

const ALLOW = { decision: "allow" };
function deny(target) {
    return {
        decision: "deny",
        reason:
            `🧠 Busca recursiva AMPLA bloqueada (alvo: ${target}). Varrer uma raiz gigante ` +
            `(home, raiz de disco, ~/.copilot, AppData, Temp, Program Files…) trava a máquina. ` +
            `Escope o \`paths\` para um arquivo ou subpasta específica. Se a memória do projeto estiver ` +
            `ativa, use \`graph_search\`/\`graph_analyze\` para ir DIRETO ao node e então busque escopado. ` +
            `Escape: defina COPILOT_MEMORY_GREP_GUARD=off no ambiente.`,
    };
}

// Decisão pura. Recebe já normalizado {toolName, toolInput, cwd}. Nunca lança (na dúvida → allow).
export function classify({ toolName, toolInput, cwd } = {}) {
    try {
        if (!toolName) return ALLOW;
        const name = String(toolName).toLowerCase();
        const isHost = HOST_SEARCH.has(name);
        const isShell = SHELL_TOOLS.has(name);
        if (!isHost && !isShell) return ALLOW;                       // não é tool de busca
        if (!toolInput || typeof toolInput !== "object" || !Object.keys(toolInput).length) return ALLOW; // opaco → allow

        const base = cwd && String(cwd).trim() ? String(cwd) : process.cwd();

        if (isHost) {
            const raw = toolInput.paths != null ? toolInput.paths : toolInput.path;
            const targets = raw == null ? [base] : (Array.isArray(raw) ? raw : [raw]);
            if (!targets.length) targets.push(base);
            for (const tgt of targets) {
                if (tgt == null || String(tgt).trim() === "") { if (isBroadTarget(base, base)) return deny(base); continue; }
                if (isBroadTarget(base, tgt)) return deny(String(tgt));
            }
            return ALLOW;
        }

        // shell
        const cmd = String(toolInput.command != null ? toolInput.command : (toolInput.cmd || ""));
        if (!cmd.trim()) return ALLOW;
        if (!isRecursiveSearchCmd(cmd)) return ALLOW;                // não é busca recursiva
        if (cmdMentionsBroad(base, cmd)) return deny("(shell) " + cmd.slice(0, 60));
        if (isBroadTarget(base, base)) return deny(base);           // rodando de uma raiz absurda
        return ALLOW;                                               // escopado OU não-parseável → fail-open
    } catch {
        return ALLOW; // fail-open DURO
    }
}
