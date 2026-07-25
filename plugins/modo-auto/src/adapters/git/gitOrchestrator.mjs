// Orquestrador GIT (MUTA git) — aplica a política git-flow p/ a execução paralela do fatiador. Cada op é
// FAIL LOUD: falha do git SOBE com contexto (nada de mascarar). Coopera com o modelo de worktree do app:
// integração (develop) e cada braço (feature/*) são worktrees IRMÃOS DEDICADOS — o worktree ATIVO da
// sessão NUNCA é tocado (nada de `checkout` na pasta do usuário). "nothing to commit" = no-op sinalizado.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectGitContext } from "./gitContext.mjs";
import { GITFLOW } from "./gitFlow.mjs";

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    const err = String(e.stderr || e.stdout || e.message || "").trim();
    if (allowFail) return { ok: false, out: String(e.stdout || "").trim(), err };
    throw new Error(`git ${args.join(" ")} falhou em "${cwd}": ${err}`);
  }
}
const has = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--quiet", ref], { allowFail: true }).ok;
const conflictsIn = (cwd) => git(cwd, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);

// Garante um repo utilizável a partir do cwd. Projeto `folder` (sem git) → git init + commit baseline
// (pré-requisito p/ branches/worktrees). Repo/worktree existente → devolve o contexto sem tocar em nada.
export function ensureRepo(cwd) {
  let ctx = detectGitContext(cwd);
  if (ctx.kind === "none") {
    git(cwd, ["init", "-b", GITFLOW.production]);
    if (!git(cwd, ["config", "user.email"], { allowFail: true }).ok) git(cwd, ["config", "user.email", "modo-auto@local"]);
    if (!git(cwd, ["config", "user.name"], { allowFail: true }).ok) git(cwd, ["config", "user.name", "modo-auto"]);
    git(cwd, ["add", "-A"]);
    const dirty = git(cwd, ["status", "--porcelain"]).out;
    git(cwd, dirty ? ["commit", "-m", "chore: baseline (modo-auto)"] : ["commit", "--allow-empty", "-m", "chore: baseline (modo-auto)"]);
    ctx = detectGitContext(cwd);
  }
  return ctx;
}

// Garante as branches de integração (develop) e staging a partir da produção/HEAD. Não faz checkout.
export function ensureGitFlow(root) {
  const base = has(root, GITFLOW.production) ? GITFLOW.production : detectGitContext(root).branch;
  if (!base) throw new Error("gitOrchestrator.ensureGitFlow: sem branch base (HEAD)");
  for (const b of [GITFLOW.integration, GITFLOW.staging]) if (!has(root, b)) git(root, ["branch", b, base]);
  return { base, integration: GITFLOW.integration, staging: GITFLOW.staging };
}

// Worktree DEDICADO de integração (na branch develop já existente). É AQUI que os merges acontecem.
export function addIntegration(root, path, { branch = GITFLOW.integration } = {}) {
  if (!has(root, branch)) throw new Error(`gitOrchestrator.addIntegration: branch de integração inexistente: ${branch}`);
  git(root, ["worktree", "add", path, branch]);
  return { branch, path };
}

// Worktree de um BRAÇO paralelo, em branch NOVA a partir de base (default develop).
export function addArm(root, { branch, path, base = GITFLOW.integration }) {
  if (has(root, branch)) throw new Error(`gitOrchestrator.addArm: branch já existe: ${branch}`);
  git(root, ["worktree", "add", path, "-b", branch, base]);
  return { branch, path, base };
}

// Commit de tudo no worktree do braço (mensagem semântica). Sem mudanças = no-op sinalizado (committed:false).
export function commitAll(cwd, message) {
  if (!message) throw new Error("gitOrchestrator.commitAll: mensagem de commit vazia");
  git(cwd, ["add", "-A"]);
  if (!git(cwd, ["status", "--porcelain"]).out) return { ok: true, committed: false };
  git(cwd, ["commit", "-m", message]);
  return { ok: true, committed: true, sha: git(cwd, ["rev-parse", "HEAD"]).out };
}

// Merge de uma branch de braço NO worktree de integração (já está em develop → sem checkout). Conflito
// → devolve os arquivos p/ o merge-resolver. Falha SEM conflito = erro real → LANÇA.
export function mergeArm(integrationPath, branch, { message } = {}) {
  const m = git(integrationPath, ["merge", "--no-ff", "-m", message || `merge: ${branch} -> ${GITFLOW.integration}`, branch], { allowFail: true });
  if (m.ok) return { ok: true, conflicts: [] };
  const conflicts = conflictsIn(integrationPath);
  if (!conflicts.length) throw new Error(`gitOrchestrator.mergeArm: merge de "${branch}" falhou sem conflito detectável: ${m.err}`);
  return { ok: false, conflicts };
}

// Lados de um conflito p/ o resolver: ours(:2) / theirs(:3). Vazio = arquivo ausente num dos lados.
export function conflictSides(integrationPath, file) {
  return {
    file,
    ours: git(integrationPath, ["show", `:2:${file}`], { allowFail: true }).out,
    theirs: git(integrationPath, ["show", `:3:${file}`], { allowFail: true }).out,
  };
}

// Grava a resolução do resolver e marca resolvido (git add).
export function resolveFile(integrationPath, file, content) {
  writeFileSync(join(integrationPath, file), content);
  git(integrationPath, ["add", "--", file]);
}

// Conclui o merge — LANÇA se ainda houver conflito não resolvido (não commita merge pela metade).
export function commitMerge(integrationPath) {
  const rem = conflictsIn(integrationPath);
  if (rem.length) throw new Error(`gitOrchestrator.commitMerge: conflitos não resolvidos: ${rem.join(", ")}`);
  git(integrationPath, ["commit", "--no-edit"]);
  return { ok: true, sha: git(integrationPath, ["rev-parse", "HEAD"]).out };
}

// Remove um worktree (cleanup). Best-effort (allowFail): a limpeza não deve derrubar a pipeline.
export function removeWorktree(root, path) {
  git(root, ["worktree", "remove", "--force", path], { allowFail: true });
}
