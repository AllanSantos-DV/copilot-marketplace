// Resolver de project_id — SLIM vendado, FIEL a copilot-memory/lib/projectId.mjs (o plugin é o DONO do
// contrato; aqui só se reusa a MESMA regra, para casar o mesmo escopo que o servidor entende).
//
// ESCADA ESTRITA — duas rungs e um erro (o 1º não-vazio vence):
//   1. MARCADOR `.memory/project.json` → metadata.defaults.project_id, achado SUBINDO até a raiz do projeto
//      (findProjectRoot). Worktree e subpasta do mesmo projeto convergem no MESMO id — é isso que faz o escopo
//      NÃO depender de onde o processo está rodando.
//   2. `git remote origin` normalizado → host/owner/repo minúsculo (único por repo, portável entre máquinas).
//   3. Nada disso → **FALHA ALTO**. Sem identificador estável não se grava nem se injeta.
//
// OS FALLBACKS DE CAMINHO FORAM REMOVIDOS DE PROPÓSITO (caminho absoluto, nome-de-pasta, e git-common-dir COMO
// id). Eram a fonte do escopo-lixo: `C:\`, `Temp`, `AppData` viravam "projeto" e poluíam a memória. O
// git-common-dir continua existindo, mas só para LOCALIZAR o marcador — nunca para virar id.
//
// POR QUE ESTE ARQUIVO FOI REESCRITO: a versão anterior desta cópia ainda tinha a escada ANTIGA, com
// path/basename/git-common-dir como id. Eu li a MINHA cópia em vez do plugin e cheguei a relatar como
// característica do produto ("o escopo sai da pasta") algo que já estava consertado upstream — e ainda
// construí em cima disso um conceito de "escopo fraco" que não existe mais: upstream, escopo assim é ERRO.
// Cópia vendada que não é resincronizada vira uma segunda verdade, e a segunda verdade é sempre a errada.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as pathResolve, dirname } from "node:path";

/** Mensagem ACIONÁVEL única — reusada pelo throw e por quem precisa orientar o usuário. */
export const SCOPE_HELP =
  'Crie um .memory/project.json na raiz do projeto (metadata.defaults.project_id, ex.: "owner/projeto") ' +
  "OU trabalhe num repositório com git remote origin. Sem um identificador estável, a memória NÃO é " +
  "gravada nem injetada — isso evita espalhar escopo-lixo pelo caminho da pasta.";

export function normalizeGitRemote(remoteUrl) {
  if (remoteUrl == null) return null;
  let s = String(remoteUrl).trim();
  if (!s) return null;
  const scheme = s.indexOf("://"); if (scheme >= 0) s = s.slice(scheme + 3);
  const at = s.indexOf("@"); if (at >= 0) s = s.slice(at + 1);
  const colon = s.indexOf(":"), slash = s.indexOf("/");
  if (colon >= 0 && (slash < 0 || colon < slash)) s = s.slice(0, colon) + "/" + s.slice(colon + 1);
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);
  while (s.endsWith("/")) s = s.slice(0, -1);
  s = s.toLowerCase();
  return s || null;
}

function git(args, cwd) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true });
    return String(out).trim() || null;
  } catch { return null; }
}

function projectConfigPath(dir) { return join(dir, ".memory", "project.json"); }
function hasMarker(dir) { try { return existsSync(projectConfigPath(dir)); } catch { return false; } }
function safeResolve(p) { try { const abs = p ? pathResolve(p) : null; return abs && abs.trim() ? abs : null; } catch { return null; } }

function declaredIdAt(dir) {
  try {
    const id = JSON.parse(readFileSync(projectConfigPath(dir), "utf8"))?.metadata?.defaults?.project_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch { return null; }
}

/** Repo BASE compartilhado por todas as worktrees (só para LOCALIZAR o marcador — não vira id). */
export function gitRepoBase(workspacePath) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspacePath)
    || git(["rev-parse", "--git-common-dir"], workspacePath);
  if (!common) return null;
  try { const base = dirname(pathResolve(workspacePath, common)); return base && base.trim() ? base : null; } catch { return null; }
}

/**
 * Localiza a RAIZ do projeto que contém o marcador, SEM walk-up ilimitado do filesystem (era o que escalava até
 * o CWD e criava lixo). Âncoras, nesta ordem: o próprio dir → o toplevel do git → o repo base. É isso que faz
 * subpasta e worktree convergirem no MESMO project_id.
 */
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

/**
 * PISO DE SEGURANÇA (defesa em profundidade): recusa id que PAREÇA caminho de filesystem. Nenhum id legítimo
 * — declarado (`owner/projeto`) ou git-remote (`host/owner/repo`) — tem essa forma.
 */
export function assertSafeProjectId(projectId) {
  const s = projectId == null ? "" : String(projectId).trim();
  if (!s) throw new Error("project_id vazio. " + SCOPE_HELP);
  const pareceCaminho = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/") || s.includes("\\");
  if (pareceCaminho) {
    throw new Error(`project_id parece um caminho de sistema de arquivos ("${s}") — recusado para não criar escopo-lixo. ` + SCOPE_HELP);
  }
  return s;
}

/** Resolve o project_id lógico. LANÇA quando não há identificador estável (fail-loud, por desenho). */
export function resolveProjectId(workspacePath) {
  const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
  if (!dir) throw new Error("Não foi possível resolver project_id: workspace vazio. " + SCOPE_HELP);
  const root = findProjectRoot(dir);
  if (root) { const declared = declaredIdAt(root); if (declared) return assertSafeProjectId(declared); }
  const norm = normalizeGitRemote(git(["remote", "get-url", "origin"], dir));
  if (norm) return assertSafeProjectId(norm);
  throw new Error("Não foi possível resolver project_id para: " + workspacePath + ". " + SCOPE_HELP);
}

/** De ONDE o id viria: "declared" | "git-remote" | "none". "none" significa que o resolver LANÇA. */
export function projectIdStrength(workspacePath) {
  const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
  if (!dir) return "none";
  const root = findProjectRoot(dir);
  if (root && declaredIdAt(root)) return "declared";
  if (normalizeGitRemote(git(["remote", "get-url", "origin"], dir))) return "git-remote";
  return "none";
}

/**
 * Detecta o risco de ESCOPO ERRADO — o furo que o fail-loud não cobre. `resolveProjectId` garante que o id
 * EXISTE e é estável; não garante que é o projeto CERTO. Quem trabalha num fork tem `origin` apontando para o
 * fork, e a memória do upstream (que é onde está o acervo real) fica invisível — em silêncio, porque tudo
 * "funciona".
 *
 * O sinal MEDÍVEL é a presença de um remote `upstream` diferente de `origin`: é exatamente a marca que o
 * `gh repo fork` deixa. O código NÃO decide qual é o certo (só o dono sabe se quer o acervo do fork ou do
 * upstream) — ele AVISA, com os dois ids na mão, para a escolha ser consciente.
 * @returns {{ risco: null|"fork", escopo: string|null, alternativa: string|null }}
 */
export function detectarEscopoSuspeito(workspacePath) {
  const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
  if (!dir) return { risco: null, escopo: null, alternativa: null };
  // Marcador declarado VENCE e encerra a dúvida: o dono já disse qual é o projeto. Nada a avisar.
  const root = findProjectRoot(dir);
  if (root && declaredIdAt(root)) return { risco: null, escopo: declaredIdAt(root), alternativa: null };
  const origem = normalizeGitRemote(git(["remote", "get-url", "origin"], dir));
  const upstream = normalizeGitRemote(git(["remote", "get-url", "upstream"], dir));
  if (origem && upstream && origem !== upstream) return { risco: "fork", escopo: origem, alternativa: upstream };
  return { risco: null, escopo: origem, alternativa: null };
}
export function tryResolveProjectId(workspacePath) {
  try { return resolveProjectId(workspacePath); } catch { return null; }
}