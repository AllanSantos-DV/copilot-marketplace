// PERFIL "modo-seguranca" — mesa de AUDITORIA DE SEGURANÇA. É só CONFIG do factory genérico
// (codeAnalysisProfile): scope + codeAnalysis (SAST: semgrep agnóstico + bandit p/ Python) + pesquisa externa
// (CVE/advisory/OWASP) + mesa viva (analista, seguranca-critico que TRIA falso-positivo, advogado-diabo,
// facilitador) + OTF seed "security" → ADR de segurança (achados por severidade + correção com teste de
// regressão). Gêmeo do modo_reuso — mesma máquina, lente de AMEAÇAS. Anti-boilerplate.

import { createCodeAnalysisProfile } from "./codeAnalysisProfile.mjs";

export function createModoSeguranca({ log = () => {} } = {}) {
  return createCodeAnalysisProfile({
    id: "modo-seguranca", tag: "seguranca",
    order: ["analista", "seguranca-critico", "advogado-diabo", "facilitador"],
    seedType: "security", kinds: ["security"], label: "SEGURANÇA",
    externalPrompt: (s) => `Pesquisa de segurança EXTERNA: para "${s}", quais CVEs/advisories conhecidos, itens do OWASP Top 10 e mitigações VALIDADAS se aplicam? Quais são falsos-positivos comuns de SAST aqui? Achados CONCRETOS com referência.`,
    freeFormInstruction: `Escreva um ADR de SEGURANÇA POR EXTENSO em markdown (achados por severidade; cada "## Fase N" corrige por severidade, CRITICAL primeiro, e INCLUI um TESTE DE REGRESSÃO de segurança).`,
    log,
  });
}
