#!/usr/bin/env node
// Dispatcher global de pre-push (copilot-marketplace).
//
// Instalado em ~/.copilot/githooks/ e acionado pelo `core.hooksPath` global, ele roda
// para QUALQUER repositório. A regra é simples e segura:
//   - Se o repo atual tem `docs/gate.mjs` (ou seja, é o copilot-marketplace / um fork),
//     delega a verificação a ele: `node docs/gate.mjs prepush <remoteUrl>` com a mesma
//     stdin do pre-push. O gate decide bloquear (exit≠0) ou liberar.
//   - Caso contrário, é transparente: chama o hook local do repo (se existir) para não
//     roubar o comportamento que o core.hooksPath global substituiria; senão, libera.
//   - Qualquer erro inesperado -> libera (fail-open). Nunca brica um push alheio.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function bufferStdin() {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

const args = process.argv.slice(2); // [remoteName, remoteUrl]
const input = bufferStdin();

let root = "";
try {
  root = (spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout || "").trim();
} catch {}

// ---- BLOQUEIO GLOBAL (defesa de push): rejeita enviar commit com o trailer
// "Co-authored-by: ... Copilot ..." que o usuario NAO autorizou. Vale para QUALQUER
// caminho de criacao do commit (commit normal, filter-branch, rebase, amend): se a
// mensagem carrega o trailer, o push e BARRADO ate limpar. Isto complementa o
// commit-msg (que remove no commit normal) fechando o buraco do filter-branch/sh.
// Fail-open apenas em ERRO de execucao (nunca brica push alheio por falha da checagem).
try {
  const linhas = input.toString("utf8").split(/\r?\n/).filter(Boolean);
  const ZERO = /^0+$/;
  const infratores = new Set();
  const cwd = root || process.cwd();
  for (const linha of linhas) {
    const partes = linha.split(" ");
    const localSha = partes[1];
    const remoteSha = partes[3];
    if (!localSha || ZERO.test(localSha)) continue; // delecao de ref: nada a enviar
    const range = (remoteSha && !ZERO.test(remoteSha))
      ? [`${remoteSha}..${localSha}`]
      : [localSha, "--not", "--remotes", "--max-count=1000"];
    const shas = (spawnSync("git", ["rev-list", ...range], { cwd, encoding: "utf8" }).stdout || "")
      .split(/\r?\n/).filter(Boolean);
    for (const sha of shas) {
      const body = spawnSync("git", ["log", "-1", "--format=%B", sha], { cwd, encoding: "utf8" }).stdout || "";
      if (/^\s*co-authored-by:.*copilot/im.test(body)) infratores.add(sha.slice(0, 9));
    }
  }
  if (infratores.size > 0) {
    process.stderr.write(
      "\n[pre-push BLOQUEADO] Commit(s) com o trailer 'Co-authored-by: ... Copilot ...' NAO autorizado:\n  " +
      [...infratores].join(", ") +
      "\nLimpe a(s) mensagem(ns) SEM o trailer antes do push. Este bloqueio nao pode ser contornado por filter-branch/sh.\n\n"
    );
    process.exit(1);
  }
} catch {
  // fail-open: erro na verificacao nao deve bloquear push alheio
}

function delegateLocalAndExit() {
  try {
    const p = spawnSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], {
      cwd: root || process.cwd(),
      encoding: "utf8",
    });
    const local = (p.stdout || "").trim();
    if (local && existsSync(local)) {
      const res = spawnSync(local, args, { input, stdio: ["pipe", "inherit", "inherit"] });
      process.exit(res.status ?? 0);
    }
  } catch {}
  process.exit(0);
}

try {
  const gate = root ? join(root, "docs", "gate.mjs") : "";
  if (gate && existsSync(gate)) {
    const res = spawnSync(process.execPath, [gate, "prepush", args[1] ?? ""], {
      cwd: root,
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    process.exit(res.status ?? 0);
  }
  delegateLocalAndExit();
} catch {
  process.exit(0);
}
