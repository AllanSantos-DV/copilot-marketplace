// Réplica FIEL do ProjectIdResolver.java (native-java) + o passo do .memory/project.json: a escada
// determinística (o primeiro não-vazio vence) que gera o project_id lógico de um workspace.
//   0. .memory/project.json → metadata.defaults.project_id (INTENÇÃO DECLARADA — vence tudo)
//   1. git remote get-url origin  → normalizado para host/owner/repo minúsculo
//   2. repo base via git-common-dir (estável entre worktrees quando não há origin)
//   3. caminho absoluto do workspace (normalizado)
//   4. nome da pasta
// Se nada produzir valor: FALHA ALTO (nunca cai para home). Isto é o que faz o plugin
// carimbar/consultar com o MESMO escopo que o servidor entende — sem isso, o recall não casa.
import { execFileSync } from "node:child_process";
import { resolve as pathResolve, basename, dirname } from "node:path";
import { loadProjectConfig, declaredProjectId } from "./projectConfig.mjs";

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

// Resolve o project_id lógico para o caminho de workspace dado. Lança se impossível (fail-loud).
// Escada (o 1º não-vazio vence) — aprimora o ProjectIdResolver do servidor com o passo 2:
//   1. git remote normalizado         → estável entre worktrees E máquinas (== servidor)
//   2. repo base via git-common-dir    → estável entre worktrees quando NÃO há origin (fecha o furo)
//   3. caminho absoluto → nome da pasta → folder puro sem git (estável: não há worktree)
export function resolveProjectId(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) {
        throw new Error("Não foi possível resolver project_id: workspace vazio.");
    }

    // Passo 0 — INTENÇÃO DECLARADA: .memory/project.json → metadata.defaults.project_id. Vence tudo,
    // porque é a escolha explícita do usuário (portável entre máquinas/pessoas, independe de git/path).
    const declared = declaredProjectId(loadProjectConfig(dir));
    if (declared) return declared;

    // Passo 1 — git remote normalizado.
    const norm = normalizeGitRemote(gitRemoteOriginUrl(dir));
    if (norm) return norm;

    // Passo 2 — repo base (git-common-dir), estável entre worktrees sem origin.
    const base = gitRepoBase(dir);
    if (base) {
        try {
            const abs = pathResolve(base);
            if (abs && abs.trim()) return abs;
        } catch { /* cai para o passo 3 */ }
    }

    // Passo 3 — caminho absoluto normalizado.
    try {
        const abs = pathResolve(dir);
        if (abs && abs.trim()) return abs;
    } catch { /* cai para o nome */ }

    // Passo 3b — nome da pasta.
    const name = basename(dir);
    if (name && name.trim()) return name;

    throw new Error(
        "Não foi possível resolver project_id para o workspace: " + workspacePath +
        ". Nenhum remote git, repo base, caminho absoluto ou nome de pasta válido."
    );
}

// Tenta resolver; devolve null em vez de lançar (útil em hooks best-effort).
export function tryResolveProjectId(workspacePath) {
    try {
        return resolveProjectId(workspacePath);
    } catch {
        return null;
    }
}

// De ONDE veio o project_id — a "força" do escopo. Usado pelo nudge de scaffold (parte B): só um
// escopo FRÁGIL (path/name, sem declaração nem git remote/base) merece sugerir criar o project.json.
//   "declared" → .memory/project.json (forte, portável)
//   "git-remote" → origin normalizado (forte, portável entre máquinas)
//   "git-base" → repo base sem origin (estável entre worktrees, mas local)
//   "path" | "name" → FRÁGIL (não portável; recall não casa entre máquinas/pessoas)
//   "none" → não resolveu
export function projectIdStrength(workspacePath) {
    const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
    if (!dir) return "none";
    if (declaredProjectId(loadProjectConfig(dir))) return "declared";
    if (normalizeGitRemote(gitRemoteOriginUrl(dir))) return "git-remote";
    if (gitRepoBase(dir)) return "git-base";
    try { if (pathResolve(dir)) return "path"; } catch { /* ignore */ }
    if (basename(dir)) return "name";
    return "none";
}

export function isFragileScope(workspacePath) {
    const s = projectIdStrength(workspacePath);
    return s === "path" || s === "name" || s === "none";
}
