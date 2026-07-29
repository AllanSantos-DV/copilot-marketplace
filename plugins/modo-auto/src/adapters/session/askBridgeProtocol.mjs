// askBridgeProtocol.mjs — CONTRATO do ask-bridge (semeado como `protocol.mjs` na lib compartilhada
// ~/.ask-bridge/lib/). FONTE ÚNICA da PROTOCOL_VERSION (semver) + shapes/const que os DOIS plugins (modo-auto e
// copilot-mobile) asseram p/ compatibilidade. Sem deps (stdlib puro). Compat por MAJOR: major instalado > o que
// o plugin suporta → o plugin NÃO engaja o bridge (fallback seguro, sinalizado) — nunca silencioso.

export const PROTOCOL_VERSION = "1.2.1";

// SINAL DE POSSE POR SESSÃO (1.2.0, aditivo): arquivo `armed.json` no dir da sessão. Um plugin de CONTROLE
// AUTÔNOMO por sessão (ex.: modo-auto ARMADO) declara que ELE responde o ask_user daquela sessão. Plugins de
// RELAY (ex.: whatsapp-bridge, cujo bind é UMA sessão só) devem CEDER: não registrar o override quando há um
// armed VIVO de outro plugin nessa sessão. Regra do dono: numa sessão com controle autônomo armado, quem manda
// é o controle autônomo; o relay atende as OUTRAS sessões (onde não há armado).
export const ARMED_FILE = "armed.json";

// Endpoints loopback (autenticados por x-ask-token).
export const OWNER_ENDPOINTS = { register: "/register", unregister: "/register/", health: "/health" };
export const RESPONDER_ENDPOINTS = { ask: "/ask", health: "/health" };

// Timeouts canônicos (ms). dispatch = RTT p/ confirmar respondedor vivo; answer = por respondedor.
// mesaAnswerTimeoutMs: CORRIGIDO em 1.2.1 de 30s → 300s. MEDIÇÃO REAL (2026-07-28, log do dono): uma mesa
// deliberando (múltiplos papéis + pesquisa) passa de 60s com folga; o dono HONRA o prazo que o respondedor
// declara, então um prazo curto = a mesa cortada no meio ("timeout:60000") e a pergunta caindo no humano —
// exatamente o travamento que o dono do produto reportou. Prazo maior NÃO atrasa ninguém: o dispatch resolve
// no PRIMEIRO {answer} válido (first-to-answer); quem responder antes ganha.
export const DEFAULTS = Object.freeze({
  dispatchTimeoutMs: 2000,
  mesaAnswerTimeoutMs: 300000,  // mesa (LLM deliberando) — medido: >60s é normal
  phoneAnswerTimeoutMs: 300000, // humano
  declineMs: 500,
  heartbeatIntervalMs: 20000,   // dono re-carimba heartbeatAt (prova de vida)
  staleMs: 90000,               // heartbeat mais velho que isto → dono considerado morto (pid reciclado/travado)
});

export function majorOf(v) { return parseInt(String(v || "0").split(".")[0], 10) || 0; }
export function minorOf(v) { return parseInt(String(v || "0").split(".")[1], 10) || 0; }
export function patchOf(v) { return parseInt(String(v || "0").split(".")[2], 10) || 0; }

// a > b? (semver-ish, componente a componente). Usado no "maior versão vence" do seeder.
export function isNewer(a, b) {
  const A = [majorOf(a), minorOf(a), patchOf(a)], B = [majorOf(b), minorOf(b), patchOf(b)];
  for (let i = 0; i < 3; i++) { if (A[i] !== B[i]) return A[i] > B[i]; }
  return false;
}

// Compatível se o MAJOR bate (regra fail-loud do handoff: major instalado ≠ suportado → não engaja).
export function isCompatible(installedVersion, supportedVersion = PROTOCOL_VERSION) {
  return majorOf(installedVersion) === majorOf(supportedVersion);
}
