// voice-state.mjs — estado compartilhado do runtime da extensão (folha do grafo de módulos).
//
// MODELO FINO (v2): cada fork de sessão é um CLIENTE INDEPENDENTE do daemon vox. NÃO há
// eleição primário/secundário, porta canônica, registro de forks nem roteamento cross-fork.
// Sobrou só o estado que uma sessão usa para SI MESMA: os clientes SSE do próprio iframe,
// o histórico de áudio durável da própria sessão, e os handles de inferência em voo.
//
// Este módulo NÃO importa nenhum outro módulo do voice-chat (evita ciclos com a entry).

// --- clientes SSE do PRÓPRIO iframe desta fork ---
export const sseClients = new Map();

// --- fala / cues ---
export const spokenCheckpoints = new Set();
export const pendingTts = new Map();

// --- histórico de áudio durável (por sessão, só a PRÓPRIA) ---
export const audioHistoryBySid = new Map();   // sid -> item[]
export const audioSeqBySid = new Map();       // sid -> last seq issued
export const audioTurnBySid = new Map();      // sid -> current turn number
export const audioDeliveredBySid = new Map(); // sid -> highest seq SENT to a live client (dedup do push ao vivo)
export const audioHeardBySid = new Map();     // sid -> highest seq que o cliente CONFIRMOU ter TOCADO até o fim (cursor DURÁVEL de "consumido"; só avança via /played). Decide o autoplay ao reabrir: fechar no meio da fala NÃO marca como ouvido -> reabrir retoca o que faltou.

// --- motor (reuse do daemon vox) ---
export const pendingTranscribe = new Map(); // id -> {resolve,reject,timer} for /transcribe (engine reuse)

// ============================================================================
// Escalares mutáveis compartilhados (live-binding single-writer).
// LEITURAS usam o nome cru (binding vivo); ESCRITAS passam pelo setter (ESM não
// deixa reatribuir binding importado). Estado numa folha, sem ciclos com a entry.
// ============================================================================

// sid da PRÓPRIA sessão deste fork (p/ o heartbeat de vida ao Stop hook): mySid()
// pode vir vazio no load, então o open() do canvas fixa isto a partir do ctx.sessionId.
export let ownSid = "";
export function setOwnSid(v) { ownSid = v; }

// sid do turno de voz em andamento (o dono da captura). Escrito TANTO pela entry
// (claim/quiesce) QUANTO pelo hub de eventos do worker -> dual-writer, por isso
// mora aqui com setter.
export let turnOwnerSid = null;
export function setTurnOwnerSid(v) { turnOwnerSid = v; }

// sid que está monitorando o nível do microfone (VU meter). A entry escreve, o worker lê.
export let monitorSid = null;
export function setMonitorSid(v) { monitorSid = v; }
