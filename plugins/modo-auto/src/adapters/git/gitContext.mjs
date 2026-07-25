// Detector de CONTEXTO GIT — read-only (NUNCA muta). Existe pra COOPERAR com o modelo de worktree do
// GitHub Copilot app (sessão de projeto `repository` já roda num worktree linkado sob
// ~/IdeaProjects/copilot-worktrees/<proj>/<nome>; projeto `folder` roda no filesystem cru, sem git).
// Por isso o fatiador NÃO assume worktree — ele detecta. kind:
//   • "worktree" → estamos num worktree linkado (git-dir ≠ git-common-dir) — braços paralelos = siblings;
//   • "repo"     → repo principal (não-linkado);
//   • "none"     → sem git (estado LEGÍTIMO, sinalizado — não é erro; ex.: o próprio modo-auto).
// FAIL LOUD só em erro INESPERADO do git (não confundir "não é repo" com falha).

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function tryGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, err: String(e.stderr || e.message || "").trim() }; }
}

function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of String(porcelain).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9).trim(), branch: null, bare: false, detached: false }; out.push(cur); }
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (cur && line === "bare") cur.bare = true;
    else if (cur && line === "detached") cur.detached = true;
  }
  return out;
}

/**
 * @param {string} cwd
 * @returns {{ kind:"worktree"|"repo"|"none", root:string|null, branch:string|null, isWorktree:boolean, commonDir?:string, worktrees:object[] }}
 */
export function detectGitContext(cwd) {
  const inside = tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    if (/not a git repository/i.test(inside.err)) return { kind: "none", root: null, branch: null, isWorktree: false, worktrees: [] };
    throw new Error(`gitContext: git falhou inesperadamente em "${cwd}": ${inside.err}`);
  }
  if (inside.out !== "true") return { kind: "none", root: null, branch: null, isWorktree: false, worktrees: [] };
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = resolve(cwd, git(cwd, ["rev-parse", "--git-dir"]));
  const commonDir = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
  const branch = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out || null;
  const isWorktree = gitDir !== commonDir; // worktree linkado tem git-dir próprio sob <main>/.git/worktrees/<nome>
  const wt = tryGit(cwd, ["worktree", "list", "--porcelain"]);
  return { kind: isWorktree ? "worktree" : "repo", root, branch, isWorktree, commonDir, worktrees: wt.ok ? parseWorktrees(wt.out) : [] };
}
