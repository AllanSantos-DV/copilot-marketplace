// Carregador de SKILLS globais (~/.copilot/skills). Lê o corpo (sem frontmatter) e compõe um system
// prompt com as skills OBRIGATÓRIAS injetadas. FAIL LOUD: skill ausente/erro de leitura → LANÇA (nunca
// injeta silêncio). Fonte ÚNICA (DRY) reusada pelo GatePort e pela fábrica de agentes.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SKILLS_ROOT = join(homedir(), ".copilot", "skills");

// Corpo da SKILL.md sem o frontmatter YAML. null se genuinamente AUSENTE; erro de leitura → LANÇA.
export function readSkillBody(name) {
  const p = join(SKILLS_ROOT, name, "SKILL.md");
  if (!existsSync(p)) return null;
  const t = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  const m = t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m ? m[1] : t).trim();
}

// Compõe: baseSystem + cada skill injetada como bloco OBRIGATÓRIO. FAIL LOUD se alguma skill faltar.
export function composeSystem(baseSystem, skillNames = []) {
  const parts = [String(baseSystem || "")];
  for (const name of skillNames) {
    const body = readSkillBody(name);
    if (!body) throw new Error(`skillLoader.composeSystem: skill "${name}" nao encontrada em ${SKILLS_ROOT}`);
    parts.push(`=== SKILL OBRIGATORIA: ${name} (siga a risca) ===\n${body}`);
  }
  return parts.join("\n\n");
}
