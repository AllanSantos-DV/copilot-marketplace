// voice-state.mjs — estado compartilhado do runtime da extensão (folha do grafo de módulos).
//
// Fundação da modularização: as COLEÇÕES mutáveis (Maps/Sets) que os subsistemas
// (rede, worker, áudio, turnos, handover) compartilham vivem aqui e são importadas
// por referência. Como Map/Set são objetos, mutá-los (`.set`/`.get`/`.add`/`.delete`)
// atravessa os módulos sem reatribuição — não é preciso renomear nenhuma referência.
//
// Este módulo NÃO importa nenhum outro módulo do voice-chat (evita ciclos com a entry).

// --- rede / roteamento primário-secundário ---
export const sseClients = new Map();
export const servers = new Map();
export const forkVersions = new Map();      // sid -> versão anunciada no /register (diagnóstico + decisão de handover)
export const forks = new Map();
export const forkSeen = new Map();   // sid -> última vez que a fork se anunciou (para eviction de sids mortos)

// --- fala / cues ---
export const spokenCheckpoints = new Set();
export const pendingTts = new Map();
export const recentSpoken = new Map();

// --- histórico de áudio durável (por sessão) ---
export const audioHistoryBySid = new Map();   // sid -> item[]
export const audioSeqBySid = new Map();       // sid -> last seq issued
export const audioTurnBySid = new Map();      // sid -> current turn number
export const audioDeliveredBySid = new Map(); // sid -> highest seq SENT to a live client (dedup do push ao vivo)
export const audioHeardBySid = new Map();      // sid -> highest seq que o cliente CONFIRMOU ter TOCADO até o fim (cursor DURÁVEL de "consumido"; só avança via /played, NUNCA na entrega). É o que decide o autoplay ao reabrir: fechar no meio da fala NÃO marca como ouvido, então reabrir retoca o que faltou.

// --- entrega durável de turnos (held-turn) ---
export const pendingTurnsBySid = new Map(); // sid -> [{ id, text, ts }]
export const drainingTurns = new Set();     // sids with an /inject in flight
export const injectedTurnIds = new Set();
export const injectedTurnOrder = [];
export const injectingIds = new Set();   // ids com um turno EM ANDAMENTO (await session.send ainda não resolveu). Guarda contra DOUBLE-SEND: o dedup por id só grava NO SUCESSO, então se o primary re-injetar o mesmo id enquanto o 1º ainda está no ar (ex.: send VIVO > timeout do POST + sweep re-injeta), sem esta guarda o turno rodaria 2x.

// --- motor (reuse do daemon) ---
export const pendingTranscribe = new Map(); // id -> {resolve,reject,timer} for /transcribe (engine reuse)

// ============================================================================
// Escalares mutáveis compartilhados (live-binding single-writer).
//
// ESM exporta BINDINGS VIVOS: um importador que lê `activeSid` enxerga sempre o
// valor atual. Mas um importador NÃO pode reatribuir um binding importado — por
// isso cada escalar vem com um setter. Regra: LEITURAS usam o nome cru (binding
// vivo, sem custo); ESCRITAS passam pelo setter. Como as escritas são poucas, o
// churn é mínimo e o estado fica numa folha (sem ciclos com a entry).
// ============================================================================

export let primaryFork = false;
export function setPrimaryFork(v) { primaryFork = v; }

export let activeSid = null;
export function setActiveSid(v) { activeSid = v; }

export let myBaseUrl = null;
export function setMyBaseUrl(v) { myBaseUrl = v; }

export let registered = false;
export function setRegistered(v) { registered = v; }

// o handle joinSession desta fork morreu ("Session not found"/disconnected). Uma fork morta
// para de se registrar e reporta falha na entrega para o primary re-rotear a fala p/ uma fork
// VIVA (nunca perde o turno nem trava com unhandledRejection).
export let sessionDead = false;
export function setSessionDead(v) { sessionDead = v; }

// sid da PRÓPRIA sessão deste fork (p/ o heartbeat): mySid() pode vir vazio no load,
// então o open() do canvas fixa isto a partir do ctx.sessionId confiável.
export let ownSid = "";
export function setOwnSid(v) { ownSid = v; }
