// PERFIL "modo-reuso" — mesa de análise focada em REÚSO + ENXUGAMENTO. É só CONFIG do factory genérico
// (codeAnalysisProfile): scope + codeAnalysis (clones/dead-code/deps) + pesquisa externa crítica + mesa viva
// (analista, reuso-critico, advogado-diabo, facilitador) + OTF seed "lean". Anti-boilerplate: divide a MESMA
// máquina com modo_seguranca — um produto sobre reúso não duplica perfil.

import { createCodeAnalysisProfile } from "./codeAnalysisProfile.mjs";

export function createModoReuso({ log = () => {} } = {}) {
  return createCodeAnalysisProfile({
    id: "modo-reuso", tag: "reuso",
    order: ["analista", "reuso-critico", "advogado-diabo", "facilitador"],
    seedType: "lean", kinds: ["clones", "deadCode", "deps"], label: "REÚSO / ENXUGAMENTO",
    externalPrompt: (s) => `Pesquisa de reúso EXTERNO: para "${s}", que libs/padrões VALIDADOS já resolvem isto melhor? Avalie criticamente (manutenção, adoção, CVEs, fit) — e diga ONDE o custom é melhor. Achados CONCRETOS.`,
    freeFormInstruction: `Escreva um ADR de refatoração/enxugamento POR EXTENSO em markdown (cada "## Fase N" começa por CHARACTERIZATION TESTS + objetivo + entrega).`,
    log,
  });
}
