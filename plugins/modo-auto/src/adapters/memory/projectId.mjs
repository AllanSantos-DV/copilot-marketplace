// Resolver de project_id — SLIM vendado. Escada determinística (1º não-vazio vence), fiel a
// copilot-memory/lib/projectId.mjs (para casar o MESMO escopo que o servidor entende):
//   0. .memory/project.json → metadata.defaults.project_id (intenção declarada — vence tudo)
//   1. git remote origin normalizado (host/owner/repo minúsculo)
//   2. repo base via git-common-dir (estável entre worktrees)
//   3. caminho absoluto → 4. nome da pasta

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve as pathResolve, basename, dirname } from "node:path";

function readDeclared(dir) {
  try {
    const raw = readFileSync(join(dir, ".memory", "project.json"), "utf8");
    const id = JSON.parse(raw)?.metadata?.defaults?.project_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch { return null; }
}

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

export function tryResolveProjectId(workspacePath) {
  const dir = workspacePath && String(workspacePath).trim() ? String(workspacePath).trim() : null;
  if (!dir) return null;
  const declared = readDeclared(dir); if (declared) return declared;
  const norm = normalizeGitRemote(git(["remote", "get-url", "origin"], dir)); if (norm) return norm;
  let common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir) || git(["rev-parse", "--git-common-dir"], dir);
  if (common) { try { const base = dirname(pathResolve(dir, common)); if (base && base.trim()) return base; } catch { /* segue */ } }
  try { const abs = pathResolve(dir); if (abs && abs.trim()) return abs; } catch { /* segue */ }
  const name = basename(dir);
  return name && name.trim() ? name : null;
}
