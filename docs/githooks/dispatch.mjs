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
