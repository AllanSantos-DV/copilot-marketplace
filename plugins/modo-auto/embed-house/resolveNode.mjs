// resolveNode() — resolve o path do executável Node REAL. Num fork de extensão (ou spawn filho),
// process.execPath aponta pro `copilot`/Electron, NÃO pro node; então varre o PATH atrás do binário.
// CÓPIA internalizada na casa (embed-house é STANDALONE — não pode importar de nenhum plugin consumidor).
// Fonte: modo-auto/src/adapters/util/resolveNode.mjs (função PURA, sem deps). Ao extrair p/ repo próprio,
// esta cópia vai junto; o consumidor não precisa fornecer nada.
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";

export function resolveNode() {
  const exe = process.execPath || "node";
  if (/node(\.exe)?$/i.test(exe)) return exe;
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    for (const n of ["node.exe", "node"]) { const p = join(dir, n); if (existsSync(p)) return p; }
  }
  return "node";
}
