// CATÁLOGO DE MODELOS — política de roteamento por CAPACIDADE. As listas são PREFERÊNCIA (ideal → pior)
// e incluem modelos que talvez NÃO estejam liberados na assinatura agora: o router filtra pelo que está
// disponível e pega o melhor. Assim, quando um modelo melhor (ex.: Opus 4.8, Gemini 3) for habilitado,
// ele entra AUTOMATICAMENTE. Dado VOLÁTIL/afinável (o "melhor por tarefa" muda) — fonte da 1ª versão:
// GitHub Docs "AI model comparison" + blog "Which AI model should I use with GitHub Copilot" (2026).
//   design → Gemini 3 / GPT-5 multimodal · segurança+reasoning → Opus / GPT-5.5 · código → Sonnet / codex.

export const CAPABILITIES = {
  // código rotineiro/implementação: codex é especializado; sonnet forte generalista.
  coding: ["claude-sonnet-5", "gpt-5.3-codex", "claude-sonnet-4.6", "gpt-5.4-mini", "gpt-5-mini", "claude-sonnet-4.5"],
  // UI/visual/multimodal: Gemini e GPT-5.x lideram; sonnet como rede.
  design: ["gemini-3.1-pro-preview", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "claude-sonnet-5", "claude-sonnet-4.6"],
  // auditoria/vulnerabilidade: Opus e GPT-5.5 (contexto profundo, agêntico).
  security: ["claude-opus-4.8", "gpt-5.5", "claude-opus-4.6", "gpt-5.4", "claude-sonnet-4.6"],
  // debug profundo/arquitetura/decisão: Opus no topo.
  reasoning: ["claude-opus-4.8", "claude-opus-4.6", "gpt-5.5", "gpt-5.4", "claude-sonnet-4.6"],
  // triagem/classificação barata e rápida.
  speed: ["gpt-5-mini", "gemini-3.5-flash", "claude-haiku-4.5", "gpt-5.4-mini", "claude-sonnet-4.6"],
  // genérico / sem especialização clara.
  general: ["claude-sonnet-4.6", "gpt-5.4", "claude-sonnet-4.5", "gpt-5-mini"],
};

// Papel → capacidade primária.
export const ROLE_CAPABILITY = {
  developer: "coding", tester: "coding", "merge-resolver": "coding",
  qa: "security", revisor: "security",
  "tech-lead": "reasoning", fatiador: "reasoning", negocio: "reasoning", tecnico: "reasoning",
  pesquisador: "reasoning", "advogado-diabo": "reasoning", facilitador: "reasoning", documentacao: "general",
  validador: "reasoning", questionador: "reasoning", "ancora-realidade": "reasoning",
  triagem: "speed",
};

// Tipo de tarefa → capacidade (sobrepõe a do papel, exceto papéis meta baratos).
export const TASK_CAPABILITY = {
  api: "security", auth: "security", data: "security", backend: "security", infra: "security", critical: "security",
  ui: "design", design: "design",
  research: "reasoning", discovery: "reasoning", planning: "reasoning",
};

// Papéis META baratos: mantêm a capacidade do papel (não sobem por tipo de tarefa).
export const META_ROLES = new Set(["triagem", "facilitador", "validador"]);

// Esforço de raciocínio desejado por capacidade (o router "clampa" ao que o modelo suporta).
export const DESIRED_EFFORT = { security: "high", reasoning: "high", design: "high", coding: "medium", speed: "low", general: "medium" };

// Resolve a capacidade p/ um papel + tipo de tarefa.
export function capabilityFor(role, taskType) {
  if (META_ROLES.has(role)) return ROLE_CAPABILITY[role] || "general";
  return (taskType && TASK_CAPABILITY[taskType]) || ROLE_CAPABILITY[role] || "general";
}
