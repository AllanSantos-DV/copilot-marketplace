// FONTE ÚNICA do texto do guia (DRY): tanto a tool `modo_guia` quanto o painel canvas consomem daqui.
// Assim o painel e o guia nunca divergem — um parágrafo por interruptor, um lugar só pra editar.

export const PRODUCT = "modo-auto — mesa de agentes que assume o modo autônomo do Copilot.";

export const CAPABILITIES = [
  ["modo_adr", "vira um briefing em PLANO vivo em fases (fundamentado no que já existe)."],
  ["modo_dev", "constrói cada fase por TDD (tester→dev→gates→QA→veredito), corrigindo até zerar."],
  ["modo_scopo", "entende um projeto grande via grafo semântico (ou garimpo manual)."],
  ["modo_reuso", "analisa um código-base e propõe enxugamento (clones, dead-code, deps) — reúso primeiro."],
  ["modo_seguranca", "audita segurança por SAST e prioriza correção por severidade, triando falso-positivo."],
  ["fatiar / modo_pipeline", "paraleliza fases independentes em worktrees git isolados."],
  ["deep_gate / sombra_preadr", "avalia material por painel multi-família / gera o pré-ADR de contestação."],
];

// Os 3 interruptores conscientes — fonte única (key casa com o tool/estado; paragraph é 1 frase).
export const SWITCHES = [
  {
    key: "auto", name: "MODO-AUTO", tool: "modo_auto",
    paragraph: "A mesa responde as perguntas (validando se já estão no ADR) e barra o Stop até o plano fechar. Independente dos outros.",
  },
  {
    key: "deep", name: "MODO PROFUNDO", tool: "modo_deep",
    paragraph: "Troca o revisor único por um PAINEL de famílias de modelo diferentes em paralelo (consenso). Custa MUITO mais token; vale p/ dev, ADR e modo-auto quando a decisão pesa.",
  },
  {
    key: "sombra", name: "MODO-SOMBRA", tool: "modo_sombra",
    paragraph: "Um 2º cérebro CONTESTA em background (anti-bajulação): lê a conversa, questiona público/dor/reuso/arquitetura e, se a base derrapar, solta um aviso sugestivo. Deep-research ON por padrão → custo elevado.",
  },
];

const onoff = (b) => (b ? "LIGADO" : "desligado");

/**
 * Texto COESO do guia (o que a tool `modo_guia` devolve), com o estado ATUAL de cada interruptor.
 * @param {{auto:boolean, deep:boolean, sombra:boolean}} state
 */
export function renderGuideText(state = {}) {
  const st = { auto: !!state.auto, deep: !!state.deep, sombra: !!state.sombra };
  const caps = CAPABILITIES.map(([n, d]) => `• ${n} — ${d}`).join("\n");
  const sw = SWITCHES.map((s) => `• ${s.name} (${s.tool} on) — ${s.paragraph} [agora: ${onoff(st[s.key])}]`).join("\n");
  return (
    `${PRODUCT}\n\n` +
    `COMO FUNCIONA (sempre disponível, você chama quando precisa):\n${caps}\n\n` +
    `3 INTERRUPTORES CONSCIENTES (todos OFF por padrão — nada liga sozinho):\n${sw}\n\n` +
    "Recomendação: comece com os três desligados; ligue o modo-auto p/ autonomia contínua, o profundo quando " +
    "a decisão pesa, e o sombra quando estiver formando uma ideia/base nova e quiser contestação honesta."
  );
}
