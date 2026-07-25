// SEEDS de template de ADR por TIPO DE TAREFA — research-grounded (ADR canônico: Context / Decision /
// Reuse+Alternatives / Phases / Risks / Acceptance / Rollback / References; adaptado por tipo de tarefa —
// pesquisa ativa 2026). NÃO é fixo: é o PONTO DE PARTIDA que a mesa CO-CONSTRÓI (otf-2) e trava na
// convergência. DRY (anti-boilerplate): uma BASE universal + DELTAS por tipo (add/adjust), compostos
// deterministicamente — não repete a lista inteira por tipo. FAIL LOUD: seed que não valida LANÇA.

import { makeSection, validateTemplate } from "./adrTemplate.mjs";

const S = makeSection;

// BASE universal, na ordem canônica do ADR. "fases" = o slot kind:"phases" (fatiado em ## Fase N pelo assembler).
const BASE = [
  S({ id: "contexto", title: "Contexto", guide: "Por que existe: problema, restrições e decisões anteriores.", required: true }),
  S({ id: "decisao", title: "Decisão", guide: "O que será feito e a justificativa (a escolha central).", required: true }),
  S({ id: "reuso", title: "Reúso e Alternativas", guide: "O que JÁ EXISTE pra reusar; alternativas avaliadas e por que não foram escolhidas.", required: true }),
  S({ id: "fases", title: "Fases", guide: "Execução em fases numeradas; cada fase AUTOSSUFICIENTE (objetivo + requisito testável + entrega verificável).", required: true, kind: "phases" }),
  S({ id: "riscos", title: "Riscos e Mitigações", guide: "Riscos concretos e como tratar ou aceitar.", required: false }),
  S({ id: "aceite", title: "Critérios de Aceite", guide: "Como saber que terminou: testes, resultados mensuráveis.", required: true }),
  S({ id: "rollback", title: "Rollback", guide: "Como reverter se falhar.", required: false }),
  S({ id: "referencias", title: "Referências", guide: "Links, tickets e discussões de apoio.", required: false }),
];

// Deltas por tipo: `add` = seções extras (inseridas ANTES de "fases", pois informam as fases); `adjust` =
// overrides {sectionId: {title?/guide?/required?}}. Grounded na matriz da pesquisa (feature/api/refactor/research/fix).
const SEEDS = {
  feature: { adjust: { contexto: { guide: "Objetivo do usuário / necessidade que a feature atende." } } },
  api: {
    add: [S({ id: "contrato", title: "Contrato e Versionamento", guide: "Shape do endpoint, versionamento e compatibilidade retroativa.", required: true })],
    adjust: { riscos: { required: true, guide: "Compatibilidade retroativa, performance, limites." } },
  },
  refactor: {
    add: [S({ id: "safety", title: "Redes de Segurança", guide: "Testes de caracterização e mudanças em etapas pequenas e reversíveis.", required: true })],
    adjust: { rollback: { required: true } },
  },
  research: {
    add: [S({ id: "hipoteses", title: "Hipóteses e Go/No-Go", guide: "Perguntas abertas, PoCs e o critério de decisão go/no-go.", required: true })],
    adjust: { aceite: { guide: "Perguntas respondidas ou uma decisão go/no-go clara." } },
  },
  fix: {
    add: [S({ id: "reproducao", title: "Reprodução e Causa Raiz", guide: "Passos determinísticos p/ reproduzir + a causa raiz identificada.", required: true })],
    adjust: { rollback: { required: true, guide: "Restaurar backup / reverter o PR." }, riscos: { required: true, guide: "Regressão e perda de dados." } },
  },
  critical: { adjust: { rollback: { required: true }, riscos: { required: true } } },
  lean: {    add: [
      S({ id: "hotspots", title: "Hotspots (duplicação / dead-code / boilerplate)", guide: "Evidência CONCRETA: clones (jscpd), código morto, deps não usadas, boilerplate repetido — e onde dói mais.", required: true }),
      S({ id: "reuso-interno", title: "Reúso Interno", guide: "O que consolidar reusando o que JÁ EXISTE no projeto (núcleo/ports/utils) — sem reinventar.", required: true }),
      S({ id: "externas", title: "Alternativas Externas Avaliadas", guide: "Libs candidatas avaliadas como 'novo contratado' (manutenção, adoção, CVEs, fit, licença, custo). Conclua ADOTAR ou MANTER CUSTOM, com o motivo.", required: true }),
    ],
    adjust: {
      decisao: { guide: "O que ENXUGAR/consolidar, o que ADOTAR (externo validado) e o que MANTER custom (quando é melhor). Enxuto SEM quebrar." },
      fases: { guide: "Cada fase começa por CHARACTERIZATION TESTS (captura o comportamento atual) e SÓ ENTÃO enxuga/consolida — pequena, reversível." },
      aceite: { required: true, guide: "Comportamento preservado (characterization tests verdes) + performance MEDIDA (benchmark antes/depois), NÃO afirmada." },
      rollback: { required: true },
      riscos: { required: true, guide: "Quebra de comportamento, regressão de performance, dependência externa ruim." },
    },
  },
  security: {
    add: [
      S({ id: "superficie", title: "Superfície de Ataque", guide: "Entradas não confiáveis, authn/authz, dados sensíveis, deps expostas — onde o risco mora.", required: true }),
      S({ id: "achados", title: "Achados por Severidade", guide: "Vulnerabilidades do SAST (semgrep/bandit) por CRITICAL/HIGH/MEDIUM/LOW, com CWE/OWASP quando houver.", required: true }),
      S({ id: "triagem", title: "Triagem (verdadeiro × falso-positivo)", guide: "Cada achado: VERDADEIRO-POSITIVO explorável ou FALSO-POSITIVO (com o motivo); exploitabilidade e impacto reais.", required: true }),
    ],
    adjust: {
      reuso: { title: "Controles Existentes", guide: "Validações/mitigações/libs de segurança que JÁ existem no projeto — reusar/reforçar, não reinventar." },
      decisao: { guide: "O que CORRIGIR agora (por severidade, CRITICAL primeiro), o que ACEITAR (risco documentado) e o que é FALSO-POSITIVO." },
      fases: { guide: "Cada fase corrige por severidade e INCLUI um TESTE DE REGRESSÃO de segurança (ex.: requisição não-autorizada DEVE falhar)." },
      aceite: { required: true, guide: "Achados corrigidos + RE-SCAN limpo (semgrep/bandit sem HIGH/CRITICAL) + testes de regressão verdes." },
      rollback: { required: true },
      riscos: { required: true, guide: "Risco residual aceito, regressão, quebra de fluxo por hardening." },
    },
  },
};

// Compõe BASE + delta deterministicamente. Sempre COPIA (isolamento: mutar um template retornado NÃO pode
// contaminar a BASE/os SEEDS do módulo). `add` entra ANTES de "fases" (contexto que informa a execução).
function apply(base, delta) {
  const adjust = delta?.adjust || {};
  const sections = base.map((s) => makeSection(adjust[s.id] ? { ...s, ...adjust[s.id] } : { ...s }));
  const extras = (delta?.add || []).map((e) => ({ ...e }));
  if (extras.length) {
    const i = sections.findIndex((s) => s.id === "fases");
    sections.splice(i, 0, ...extras);
  }
  return sections;
}

export const TASK_TYPES = Object.keys(SEEDS);

/**
 * Seed determinístico por tipo de tarefa. Tipo desconhecido/nulo → BASE universal (SINALIZADO via downgraded).
 * @returns {{ taskType:string, downgraded:boolean, sections:object[] }}
 */
export function selectSeed(taskType = null, { log = () => {} } = {}) {
  const key = taskType && SEEDS[taskType] ? taskType : null;
  if (taskType && !key) log(`[adr-template] tipo "${taskType}" sem seed dedicado → BASE universal (sinalizado)`);
  const sections = key ? apply(BASE, SEEDS[key]) : BASE.map((s) => ({ ...s }));
  const template = { taskType: key || "base", downgraded: !!(taskType && !key), sections };
  validateTemplate(template); // FAIL LOUD se algum seed compôs um template inválido
  return template;
}
