// resolveNode() — resolve o path do executável Node REAL. No fork da extensão (ou em spawns filhos),
// process.execPath aponta pro `copilot`/Electron, NÃO pro node; então varre o PATH atrás do binário node.
// DRY: extraído das 3 cópias byte-a-byte que viviam em agentFactory/liveWorkerClient/modelProbe — segue o
// precedente de util/extractJson.mjs (utilitário puro reusado por vários adapters). Import swap puro: MESMO
// comportamento (o existsSync no loop já garante que só retorna um path que existe; senão cai em "node").

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
