// AUTO-INSTALL de agentes: o plugin TRAZ seus .agent.md (ex.: o maestro) e os instala na pasta
// GLOBAL de agentes do app (~/.copilot/agents/), pra ficarem selecionáveis como agente de sessão. O
// install de plugin não copia agentes sozinho, então a própria extensão faz isso no load.
//
// Idempotente: copia só se AUSENTE ou CONTEÚDO DIFERENTE. Best-effort SINALIZADO: erro num arquivo entra
// em `errors` (não derruba os demais nem a extensão) — é enriquecimento, não caminho crítico. Ausência de
// agentes empacotados é estado legítimo (report vazio), não erro.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Pasta global de agentes do app (portável). COPILOT_HOME quando setado; senão ~/.copilot.
export function globalAgentsDir() {
  const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  return join(home, "agents");
}

/**
 * @param {string} srcDir  pasta com os .agent.md empacotados no plugin
 * @param {{ destDir?:string, log?:(m:string)=>void }} [opts]
 * @returns {{ dir:string, installed:string[], updated:string[], skipped:string[], errors:{name:string,error:string}[] }}
 */
export function installBundledAgents(srcDir, { destDir = globalAgentsDir(), log = () => {} } = {}) {
  const report = { dir: destDir, installed: [], updated: [], skipped: [], errors: [] };
  if (!srcDir || !existsSync(srcDir)) return report; // sem agentes empacotados → nada a fazer (legítimo)
  let entries;
  try { entries = readdirSync(srcDir).filter((f) => f.endsWith(".agent.md")); }
  catch (e) { report.errors.push({ name: srcDir, error: String(e?.message || e) }); return report; }
  if (entries.length === 0) return report;
  try { mkdirSync(destDir, { recursive: true }); }
  catch (e) { report.errors.push({ name: destDir, error: String(e?.message || e) }); return report; }
  for (const f of entries) {
    try {
      const src = readFileSync(join(srcDir, f), "utf8");
      const dstPath = join(destDir, f);
      if (existsSync(dstPath)) {
        if (readFileSync(dstPath, "utf8") === src) { report.skipped.push(f); continue; }
        writeFileSync(dstPath, src); report.updated.push(f); log(`agente atualizado: ${f}`);
      } else {
        writeFileSync(dstPath, src); report.installed.push(f); log(`agente instalado: ${f}`);
      }
    } catch (e) { report.errors.push({ name: f, error: String(e?.message || e) }); }
  }
  return report;
}
