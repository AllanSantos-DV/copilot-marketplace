// complexityRouter.mjs — TRIAGEM de complexidade do briefing ANTES da mesa. Evita rodar 6 papéis × 2-4 voltas
// (12-24 chamadas LLM + OTF) pra um plano trivial. DETERMINÍSTICO-PRIMEIRO: sinais BARATOS (0 LLM) decidem o
// óbvio; a ZONA CINZENTA é marcada `ambiguous` p/ o desempate LLM leve (Fase 2). Puro, sem deps, REUSÁVEL por
// qualquer perfil (fiado no modo_adr primeiro). FAIL LOUD: briefing vazio LANÇA (não classifica o nada).
//
// classify(briefing) → { tier, path, score, signals, ambiguous, source:"deterministic" }
//   tier: trivial | simples | medio | complexo   ·   path: express | mini | full

// Léxico de ESCOPO (normalizado sem acento). HIGH puxa p/ complexo; LOW puxa p/ trivial. Pesos ajustáveis.
export const LEX_HIGH = [
  "arquitetura", "arquitetural", "sistema", "refatorar", "refatoracao", "refactor", "migrar", "migracao",
  "integracao", "integrar", "pipeline", "multiplos", "varios", "redesenhar", "reescrever", "hexagonal",
  "ports", "adapters", "orquestrar", "orquestracao", "distribuido", "protocolo", "cross-plugin", "e2e",
  "schema", "seguranca", "concorrencia", "paralelo", "daemon", "servidor", "novo perfil", "novo modulo",
];
export const LEX_LOW = [
  "ajuste", "ajustar", "ajusta", "corrigir", "correcao", "renomear", "renomeia", "rename", "typo", "comentario",
  "log", "mensagem", "texto", "tweak", "pequeno", "trivial", "rapido", "apenas", "unico", "cosmetico",
];

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const countHits = (hay, words) => { let n = 0; for (const w of words) { const re = new RegExp("(^|[^a-z])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)", "g"); const m = hay.match(re); if (m) n += m.length; } return n; };

// Conta artefatos citados (arquivos, caminhos src/, identificadores CamelCase, termos de arquitetura) — DISTINTOS.
function countComponents(raw) {
  const set = new Set();
  for (const m of raw.matchAll(/\b[\w-]+\.(?:mjs|js|ts|tsx|json|py|md|mmd)\b/g)) set.add(m[0].toLowerCase());
  for (const m of raw.matchAll(/\bsrc\/[\w/-]+/g)) set.add(m[0].toLowerCase());
  for (const m of raw.matchAll(/\b[a-z]+[A-Z][a-zA-Z]+\b/g)) set.add(m[0].toLowerCase());
  let archWords = 0;
  const nn = norm(raw);
  for (const w of ["adapter", "port", "perfil", "modulo", "fase", "mesa", "gate", "endpoint", "contrato"]) archWords += countHits(nn, [w]);
  return { distinct: set.size, archWords };
}

export const THRESHOLDS = Object.freeze({ trivialMax: -1, simplesMax: 2, medioMax: 5 }); // score → tier
export const TIER_PATH = Object.freeze({ trivial: "express", simples: "mini", medio: "full", complexo: "full" });
export function pathForTier(tier) { return TIER_PATH[tier] || "full"; }

function tierForScore(score) {
  if (score <= THRESHOLDS.trivialMax) return "trivial";
  if (score <= THRESHOLDS.simplesMax) return "simples";
  if (score <= THRESHOLDS.medioMax) return "medio";
  return "complexo";
}

// Perto de um limite (±band) → ambíguo; sinais conflitantes fortes (HIGH e LOW juntos) → ambíguo.
function isAmbiguous(score, highHits, lowHits, band = 0.75) {
  const edges = [THRESHOLDS.trivialMax, THRESHOLDS.simplesMax, THRESHOLDS.medioMax];
  if (edges.some((e) => Math.abs(score - e) <= band)) return true;
  if (highHits >= 1 && lowHits >= 1 && Math.abs(highHits - lowHits) <= 1) return true;
  return false;
}

/**
 * @param {string} briefing
 * @param {{ log?:Function }} [opts]
 * @returns {{ tier:string, path:string, score:number, signals:object, ambiguous:boolean, source:"deterministic" }}
 */
export function classify(briefing, { log = () => {} } = {}) {
  const raw = String(briefing || "").trim();
  if (!raw) throw new Error("complexityRouter.classify: briefing vazio — não classifica o nada (FAIL LOUD)");
  const nn = norm(raw);

  const chars = raw.length;
  const lines = raw.split(/\r?\n/).filter((l) => l.trim()).length;
  const bullets = (raw.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  const highHits = countHits(nn, LEX_HIGH);
  const lowHits = countHits(nn, LEX_LOW);
  const { distinct: components, archWords } = countComponents(raw);

  let score = 0;
  // tamanho (peso moderado — tamanho SOZINHO não faz trivial; o léxico LOW é que puxa pra trivial)
  if (chars < 150) score -= 1; else if (chars < 500) score += 0; else if (chars < 1000) score += 1; else if (chars < 1800) score += 2; else score += 3;
  // estrutura (muitos itens = mais escopo)
  score += Math.min(3, Math.max(0, bullets - 2) * 0.5);
  score += Math.min(2, Math.max(0, lines - 4) * 0.25);
  // léxico: LOW (cosmético) puxa forte pra trivial; HIGH puxa pra complexo
  score += Math.min(6, highHits * 1.5);
  score -= Math.min(4, lowHits * 1.2);
  // artefatos citados
  score += Math.min(3, Math.max(0, components - 1) * 0.5);
  score += Math.min(2.5, archWords * 0.5);
  score = Math.round(score * 100) / 100;

  const tierRaw = tierForScore(score);
  // SAFETY-NET contra FALSO-TRIVIAL (express pula a mesa INTEIRA): trivial só é aceito com ZERO sinal de
  // complexidade. Qualquer hit de léxico HIGH ou ≥3 artefatos citados → PISO em "simples" (mini) — na dúvida,
  // delibera um pouco em vez de arriscar um plano raso. Transparente: `floored` marca quando o piso agiu.
  let tier = tierRaw, floored = false;
  if (tierRaw === "trivial" && (highHits > 0 || components >= 3)) { tier = "simples"; floored = true; }
  const ambiguous = isAmbiguous(score, highHits, lowHits);
  const signals = { chars, lines, bullets, highHits, lowHits, components, archWords };
  log(`[complexityRouter] score=${score} tier=${tier}${floored ? " (piso←trivial)" : ""} path=${pathForTier(tier)} ambiguous=${ambiguous} sig=${JSON.stringify(signals)}`);
  return { tier, path: pathForTier(tier), score, signals, ambiguous, floored, source: "deterministic" };
}
