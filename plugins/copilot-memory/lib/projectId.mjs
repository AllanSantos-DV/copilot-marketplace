// Escada ESTRITA e determinística que gera o project_id lógico de um workspace — a FRONTEIRA DE
// ISOLAMENTO da memória. Curta de propósito (o 1º não-vazio vence):
//   1. MARCADOR .memory/project.json → metadata.defaults.project_id. Achado SUBINDO até a raiz do
//      projeto (findProjectRoot): worktrees E subpastas do mesmo projeto convergem no MESMO id.
//   2. git remote origin normalizado → host/owner/repo minúsculo (único por repo, portável entre PCs).
//   3. Nada disso → FALHA ALTO (fail-loud). Sem identificador estável NÃO se grava nem se injeta —
//      é intencional: caminho de pasta vira escopo-lixo (C:\, Temp, AppData) que polui a memória.
// REMOVIDOS de propósito: os antigos fallbacks de caminho absoluto / nome-de-pasta / git-common-dir
// como ID (eram a origem do lixo). O git-common-dir agora só LOCALIZA o marcador (não vira id).
// Piso de segurança (assertSafeProjectId): mesmo que um id derive de path, é recusado.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { loadProjectConfig, declaredProjectId, projectConfigPath } from "./projectConfig.mjs";

// Mensagem ACIONÁVEL única (reusada pelo throw do resolver e pelos guards das tools/hooks).
export const SCOPE_HELP =
    "Crie um .memory/project.json na raiz do projeto (metadata.defaults.project_id, ex.: \"owner/projeto\") " +
    "OU trabalhe num repositório com git remote origin. Sem um identificador estável, a memória NÃO é " +
    "gravada nem injetada — isso evita espalhar escopo-lixo pelo caminho da pasta.";

// Normaliza uma URL de remote git para host/owner/repo, colapsando esquema, credenciais,
// sufixo .git e caixa. https://github.com/Acme/Widgets.git e git@github.com:Acme/Widgets.git
// resultam ambos em github.com/acme/widgets. (Espelha normalizeGitRemote, ProjectIdResolver.java:92-140.)
export function normalizeGitRemote(remoteUrl) {
    if (remoteUrl == null) return null;
    let s = String(remoteUrl).trim();
    if (!s) return null;

    const scheme = s.indexOf("://");
    if (scheme >= 0) s = s.slice(scheme + 3);

    const at = s.indexOf("@");
    if (at >= 0) s = s.slice(at + 1);

    const colon = s.indexOf(":");
    const slash = s.indexOf("/");
    if (colon >= 0 && (slash < 0 || colon < slash)) {
        s = s.slice(0, colon) + "/" + s.slice(colon + 1);
    }

    while (s.endsWith("/")) s = s.slice(0, -1);
    if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);
    while (s.endsWith("/")) s = s.slice(0, -1);

    s = s.toLowerCase();
    return s ? s : null;
}

// Executa git no diretório dado; retorna stdout trim ou null (nunca lança).
function git(args, cwd) {
    try {
        const out = execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
            windowsHide: true,
        });
        const s = String(out).trim();
        return s || null;
    } catch {
        return null;
    }
}

// Passo 1: `git remote get-url origin` no diretório. null se não houver remote,
// não for repo git, ou git estiver ausente (a escada cai para o próximo passo).
// IMPORTANTE: numa git worktree do Copilot, isto retorna o origin do REPO BASE —
// portanto é ESTÁVEL entre todas as sessões/worktrees do mesmo projeto.
function gitRemoteOriginUrl(workspacePath) {
    return git(["remote", "get-url", "origin"], workspacePath);
}

// Passo 2 (fallback p/ repos SEM origin): o REPO BASE compartilhado por todas as worktrees.
// `git rev-parse --git-common-dir` aponta para o `.git` do repo principal (comum a todas as
// worktrees); o repo base é o diretório-pai dele. Isto fecha o furo do Copilot: cada sessão é
// uma worktree com caminho próprio, mas o repo base é o MESMO — então o project_id bate entre
// sessões. Retorna caminho absoluto do repo base, ou null se não for git.
export function gitRepoBase(workspacePath) {
    let common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspacePath);
    if (!common) common = git(["rev-parse", "--git-common-dir"], workspacePath); // git < 2.31
    if (!common) return null;
    try {
        const abs = pathResolve(workspacePath, common); // resolve se vier relativo
        const base = dirname(abs); // .../repo/.git → .../repo
        return base && base.trim() ? base : null;
    } catch {
        return null;
    }
}

// Existe um marcador .memory/project.json neste diretório? (nunca lança)
function hasMarker(dir) {
    try { return existsSync(projectConfigPath(dir)); } catch { return false; }
}
function safeResolve(p) {
    try { const abs = pathResolve(p); return abs && abs.trim() ? abs : null; } catch { return null; }
}

// Localiza a RAIZ do projeto que contém o marcador .memory/project.json, sem walk-up ilimitado de
// filesystem (era o que "escalava até o CWD" e criava lixo). Ordem:
//   1. o próprio dir tem marcador → dir (não-git com marcador na raiz, OU git rodando da raiz).
//   2. git toplevel tem marcador → toplevel (subpasta/worktree com marcador RASTREADO).
//   3. repo-base (git-common-dir) tem marcador → base (worktree com marcador UNTRACKED só no base).
// Assim worktrees E subpastas do mesmo projeto convergem na MESMA raiz → MESMO project_id. null se
// não achar marcador em nenhuma dessas âncoras (fora de git NÃO sobe o filesystem: retorna null).
export function findProjectRoot(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) return null;
    if (hasMarker(dir)) return safeResolve(dir);
    const top = safeResolve(git(["rev-parse", "--show-toplevel"], dir));
    if (top && hasMarker(top)) return top;
    const base = gitRepoBase(dir);
    if (base && hasMarker(base)) return safeResolve(base);
    return null;
}

// PISO DE SEGURANÇA (defesa em profundidade): recusa um project_id que PAREÇA caminho de filesystem
// (raiz de disco, UNC, abs unix, ou qualquer backslash — que cobre caminhos Windows como AppData/Temp).
// Nenhum id legítimo — declarado (owner/repo) ou git-remote (host/owner/repo) — tem essa forma; um
// segmento chamado "appdata" num id owner/repo é legítimo e passa. Lança com mensagem acionável.
export function assertSafeProjectId(projectId) {
    const s = projectId == null ? "" : String(projectId).trim();
    if (!s) throw new Error("project_id vazio. " + SCOPE_HELP);
    const looksLikePath =
        /^[A-Za-z]:[\\/]/.test(s) ||         // C:\ ou C:/ (drive Windows)
        s.startsWith("\\\\") ||               // UNC \\server\share
        s.startsWith("/") ||                  // caminho absoluto unix
        s.includes("\\");                     // qualquer backslash — cobre AppData/Temp/... do Windows (que sempre têm \)
    if (looksLikePath) {
        throw new Error(
            "project_id parece um caminho de sistema de arquivos (\"" + s + "\") — recusado para não " +
            "criar escopo-lixo. " + SCOPE_HELP);
    }
    return s;
}

// Resolve o project_id lógico do workspace. Lança (fail-loud) se impossível. Escada ESTRITA:
//   1. marcador declarado (achado subindo à raiz via findProjectRoot) → vence
//   2. git remote origin normalizado
//   3. nada → THROW com mensagem acionável (sem escopo-lixo)
export function resolveProjectId(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) throw new Error("Não foi possível resolver project_id: workspace vazio. " + SCOPE_HELP);

    // Passo 1 — INTENÇÃO DECLARADA: marcador na raiz do projeto (worktree/subpasta convergem).
    const root = findProjectRoot(dir);
    if (root) {
        const declared = declaredProjectId(loadProjectConfig(root));
        if (declared) return assertSafeProjectId(declared);
    }

    // Passo 2 — git remote origin normalizado (único por repo, portável entre máquinas).
    const norm = normalizeGitRemote(gitRemoteOriginUrl(dir));
    if (norm) return assertSafeProjectId(norm);

    // Passo 3 — sem identificador estável: FALHA ALTO.
    throw new Error("Não foi possível resolver project_id para: " + workspacePath + ". " + SCOPE_HELP);
}

// Tenta resolver; devolve null em vez de lançar (útil em hooks best-effort).
export function tryResolveProjectId(workspacePath) {
    try {
        return resolveProjectId(workspacePath);
    } catch {
        return null;
    }
}

// De ONDE viria o project_id — a "força" do escopo. Usado pelo nudge de scaffold: escopo "none"
// (sem marcador declarado E sem git remote) é o que dispara a sugestão de criar o project.json.
//   "declared"   → marcador .memory/project.json (forte, portável; achado subindo à raiz)
//   "git-remote" → origin normalizado (forte, portável entre máquinas)
//   "none"       → não resolve → o resolver LANÇA (fail-loud); nada é gravado/injetado
export function projectIdStrength(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) return "none";
    const root = findProjectRoot(dir);
    if (root && declaredProjectId(loadProjectConfig(root))) return "declared";
    if (normalizeGitRemote(gitRemoteOriginUrl(dir))) return "git-remote";
    return "none";
}

export function isFragileScope(workspacePath) {
    return projectIdStrength(workspacePath) === "none";
}

// Resolve o project_id de FALLBACK: a escada IGNORANDO o marcador declarado. É o escopo que o projeto
// teria SEM a declaração — usado para detectar memória carimbada com o id ANTERIOR (o git-remote,
// quando o usuário depois declarou um id canônico diferente) e propor a migração. Uma-rung-abaixo =
// só git-remote; sem remote → null (nunca deriva de path/name: isso era a fonte do escopo-lixo).
export function resolveFallbackProjectId(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) return null;
    return normalizeGitRemote(gitRemoteOriginUrl(dir)) || null;
}

// Força do escopo de FALLBACK (nunca "declared"): git-remote | none. O git-remote é COMPARTILHADO
// (portável) — migrar dele pode deixar órfã a memória de quem ainda não tem o marcador; o consumidor
// (dashboard/migrate) usa isso para alertar antes de mover.
export function fallbackStrength(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) return "none";
    return normalizeGitRemote(gitRemoteOriginUrl(dir)) ? "git-remote" : "none";
}
