// askBridgeProtocol.mjs — CONTRATO do ask-bridge (semeado como `protocol.mjs` na lib compartilhada
// ~/.ask-bridge/lib/). FONTE ÚNICA da PROTOCOL_VERSION (semver) + shapes/const que os DOIS plugins (modo-auto e
// copilot-mobile) asseram p/ compatibilidade. Sem deps (stdlib puro). Compat por MAJOR: major instalado > o que
// o plugin suporta → o plugin NÃO engaja o bridge (fallback seguro, sinalizado) — nunca silencioso.

export const PROTOCOL_VERSION = "1.1.0";

// Endpoints loopback (autenticados por x-ask-token).
export const OWNER_ENDPOINTS = { register: "/register", unregister: "/register/", health: "/health" };
export const RESPONDER_ENDPOINTS = { ask: "/ask", health: "/health" };

// Timeouts canônicos (ms). dispatch = RTT p/ confirmar respondedor vivo; answer = por respondedor.
export const DEFAULTS = Object.freeze({
  dispatchTimeoutMs: 2000,
  mesaAnswerTimeoutMs: 30000,   // LLM
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
