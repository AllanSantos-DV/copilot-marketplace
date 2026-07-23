
import { createServer, request as httpRequest, get as httpGet, Agent as HttpAgent } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync, copyFileSync, linkSync, readdirSync } from "node:fs";
import { setPriority, constants as osConstants, homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import shared from "./voice-shared.cjs";
import { dbg, mkdirp, readJson, writeJsonAtomic, pidAlive } from "./voice-core.mjs";
import { buildPythonCandidates, savePythonPath } from "./voice-python.mjs";
import { cleanForSpeech, makeSpoken } from "./voice-text.mjs";
import {
    verGt, shouldStepDownForNewer, sha256Hex, verifyManifestSig, updateVersionAcceptable,
    fetchBuf, pickPluginVersion, releaseAssetBase, computeLogicSha, classifyStagedUpdate, updateNameSafe,
    RUNNING_EXT_LOGIC_SHA, PLUGIN_NAME,
} from "./voice-update.mjs";
import {
    sseClients, spokenCheckpoints,
    ownSid, setOwnSid, turnOwnerSid, setTurnOwnerSid, monitorSid, setMonitorSid,
} from "./voice-state.mjs";
import {
    playOrQueueAudio, restoreAudioHistory,
} from "./voice-audio.mjs";
import {
    ensureWorker, workerSend, restartWorker, manualRestartWorker, synthesize, transcribeViaWorker,
    shutdownWorkerForHandover, workerReady, lastDevice, lastVoices,
} from "./voice-worker.mjs";
import {
    mySid, withSid, broadcast, broadcastTo, startHeartbeat, startServer,
} from "./voice-net.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_ARTIFACTS = join(EXT_DIR, "artifacts");

let ARTIFACTS = shared.resolveDataDir();
try {
    if (ARTIFACTS !== LEGACY_ARTIFACTS && existsSync(LEGACY_ARTIFACTS) && !existsSync(ARTIFACTS)) {
        mkdirSync(dirname(ARTIFACTS), { recursive: true });
        renameSync(LEGACY_ARTIFACTS, ARTIFACTS);
    }
} catch {
    ARTIFACTS = LEGACY_ARTIFACTS;
}
const TTS_DIR = join(ARTIFACTS, "tts");
const SETTINGS_FILE = join(ARTIFACTS, "settings.json");
export const DEBUG_LOG = join(ARTIFACTS, "debug.log");
const VOICE_STATE_FILE = join(ARTIFACTS, "voice-state.json");

export const CURRENT_VERSION = "2.3.2";
// Single release hub: the PUBLIC marketplace repo carries per-plugin tagged
// releases (voice-chat-v<version>), exactly like copilot-mobile. The auto-updater
// reads the published version from the marketplace manifest, then pulls the tagged
// assets from the same repo. The source repo (copilot-voice) can stay private —
// nothing is fetched from it, so no unauthenticated 404.
const MARKETPLACE_MANIFEST_URL = process.env.VOICE_MARKETPLACE_MANIFEST || "https://raw.githubusercontent.com/AllanSantos-DV/copilot-marketplace/main/.github/plugin/marketplace.json";
export const RUNNING_AS_PLUGIN = /[\\/]installed-plugins[\\/]/.test(EXT_DIR);
const UPDATE_DISABLED = process.env.VOICE_UPDATE_DISABLED === "1" || RUNNING_AS_PLUGIN;
const UPDATE_THROTTLE_MS = Number(process.env.VOICE_UPDATE_THROTTLE_MS) || 0;
const UPDATE_STATE_FILE = join(ARTIFACTS, "update-state.json");
// Fonte DECLARATIVA do conjunto empacotado (o gate afere gen-manifest FILES == UPDATABLE_FILES).
// NÃO é mais a allowlist do updater em runtime — a autorização do que se escreve é a ASSINATURA
// Ed25519 do manifesto (ver checkForUpdate + updateNameSafe); senão install antigo nunca recebia
// arquivo NOVO (ex.: vox_lifecycle.py) e aplicava update PARCIAL = "motor de voz falhou" em loop.
const UPDATABLE_FILES = new Set(["extension.mjs", "voice-shared.cjs", "voice-core.mjs", "voice-python.mjs", "voice-update.mjs", "voice-text.mjs", "voice-state.mjs", "voice-audio.mjs", "voice-worker.mjs", "voice-net.mjs", "voice_worker.py", "vox_sdk.py", "vox_lifecycle.py", "vox_splash.py", "vox_stream.py", "capture_port.py", "capture_session.py", "vox_capture_adapter.py", "_ed25519_ref.py", "iframe.html", "requirements.txt", "hooks.json", "voice-summary-stop.cjs", "voice-canvas-guard.cjs"]);

// Python interpreters are discovered dynamically (see buildPythonCandidates).
export let session; 

export let lastTtsPreviewSid = null;
export function setLastTtsPreviewSid(v) { lastTtsPreviewSid = v; }
export let recordingActiveSid = null; 
let recordingActiveTimer = null; 

// Pré-checagem READ-ONLY do lock de mic do DAEMON. A captura é 100% no daemon agora (capture_open),
// então o DAEMON é o ÚNICO DONO/ESCRITOR do lock em %USERPROFILE%\.copilot\vox\mic.lock (sid
// reservado "vox-daemon"; o dictate usa "vox-dictate"). O voice-chat só LÊ este arquivo para um
// "ocupado" RÁPIDO no /rec/start (evita subir a captura só pra ouvir busy). NUNCA escreve: escrever
// com a PRÓPRIA sid fazia o daemon ver um dono "estranho" e recusar a PRÓPRIA captura (mic_busy) —
// o bug do AUTO-BLOQUEIO. Formato {sid,pid,ts}, TTL, pid-check (dono morto -> livre).
const MIC_LOCK_FILE = process.env.VOICE_MIC_LOCK_FILE || join(homedir(), ".copilot", "vox", "mic.lock");
const MIC_LOCK_TTL_MS = Number(process.env.VOICE_MIC_LOCK_TTL_MS) || 15000;
export function micLockHeldByOther(mySid) {
    const l = readJson(MIC_LOCK_FILE, null);
    if (!l || !l.sid) return false;
    if (String(l.sid) === String(mySid || "")) return false;          // defensivo: só o daemon escreve, nunca eu
    if ((Date.now() - (Number(l.ts) || 0)) > MIC_LOCK_TTL_MS) return false;  // lease expirada
    if (!pidAlive(l.pid)) return false;                               // dono (daemon/dictate) morto
    return true;                                                      // vivo + fresco + de OUTRO (daemon/dictate)
}



const DEFAULT_SETTINGS = {
    voice: "Microsoft Maria Desktop",
    rate: 0,
    language: "pt",
    ttsVoice: "",
    ttsSid: 0,
    authorSummary: true,
    confirmTranscript: false,
    cueStart: true,
    cueCheckpoints: true,
    handsfree: false,
    interruptMode: false,
    focusGate: false,
    micDevice: null,
};
export let settings = { ...DEFAULT_SETTINGS };
export function setSettings(v) { settings = v; }

// Dedup local de fala (sid -> {text, ts}): antes vinha de voice-state; no cliente fino é estado
// só desta fork (cada fork fala pela própria sessão). Ver alreadySpoke/speakToCanvas.
const recentSpoken = new Map();
// Servidor HTTP local desta fork por instância de canvas (cliente fino: 1 fork = 1 servidor efêmero,
// sem porta canônica nem eleição). Antes vinha do estado compartilhado; agora é local. Ver canvas open/onClose.
const _servers = new Map();

// Modelo por TOOL (v1.5.16+): o agente usa a tool `falar` para produzir áudio QUANDO quiser (inclusive
// antes de uma pergunta, várias vezes por turno). O Stop hook exige >=1 chamada de `falar` por turno.
const VOICE_TOOL_INSTRUCTION =
    "A mensagem anterior do usuário foi capturada por VOZ. Para tudo que o usuário deve OUVIR, use a " +
    "ferramenta (tool) `falar`, passando um texto natural em português do Brasil (1 a 3 frases curtas, " +
    "sem markdown, sem listas, sem código e sem emojis). Você DEVE chamar `falar` ao menos uma vez neste " +
    "turno com um resumo do essencial da sua resposta, e PODE chamá-la quantas vezes quiser — inclusive " +
    "ANTES de fazer uma pergunta, para que o áudio saia na hora certa. Não escreva a linha 🔊 no chat; " +
    "quem fala é a tool `falar`.";

// Modo FALA COMPLETA (fullRead=ON): a resposta é entregue como ÁUDIO pela tool `falar`, SEM duplicar em
// texto (não gasta o dobro de tokens). Só artefatos não-faláveis (código/tabela/imagem/diagrama) vão ao
// chat, e SEMPRE FORA do `falar`. É o modo mãos-livres/conversação — foca em falar tudo pela ferramenta.
const VOICE_TOOL_INSTRUCTION_FULL =
    "A mensagem anterior do usuário foi capturada por VOZ e o modo FALA COMPLETA está ATIVO. Responda a " +
    "resposta INTEIRA pela ferramenta (tool) `falar`, como conversa natural em português do Brasil — todos " +
    "os pontos, curada para ser OUVIDA (sem markdown, listas, código ou emojis dentro do `falar`). Pode " +
    "chamar `falar` VÁRIAS vezes para cobrir a resposta toda. NÃO reescreva a resposta como texto no chat: " +
    "o áudio É a entrega (evita duplicar e gastar o dobro de tokens). SOMENTE artefatos que não dá para " +
    "falar — blocos de código, tabelas, imagens, diagramas — vão para o texto do chat, SEMPRE FORA da " +
    "chamada `falar`. Não escreva a linha 🔊 no chat. Priorize a conversa pela ferramenta em vez de escrever.";

const CHECKPOINT_INSTRUCTION =
    "Se ESTE turno envolver uma tarefa LONGA ou COMPLEXA (montar uma feature inteira, um fluxo " +
    "completo, mudanças em vários arquivos, várias etapas), você PODE emitir checkpoints de progresso " +
    'durante o trabalho: escreva, em uma linha separada, algo começando exatamente com "📍 " seguido ' +
    "de UMA frase curta em português do Brasil dizendo o que acabou de fazer ou o próximo passo. " +
    "Emita apenas em marcos relevantes (não a cada passo pequeno) e NUNCA em tarefas curtas. Esses 📍 " +
    "são lidos em voz alta como sinal de direção: mantenha-os curtos, naturais, sem markdown nem código.";

// Catálogo de vozes de TTS: VEM SÓ DO MOTOR (evento worker "voices"). Sem lista local
// de fallback — se o motor não reportar, fica vazio e a UI mostra "indisponível" ALTO.

let pendingVoiceTurn = false;
let voiceInstructionPending = false; 
let pendingUserInputId = null;   // requestId de um ask_user ABERTO (SDK user_input.requested) -> a fala responde ele
let latestReply = "";
let lastSpokenContent = "";
// EM VOO? um turno de voz pendente (session.send não resolveu) OU um inject in-flight. O self-reload
// usa isto p/ ADIAR o relaunch e não matar o processo no meio do session.send (evita replay do turno).
export function voiceBusy() { try { return !!pendingVoiceTurn; } catch { return false; } }
let idleFallback = null;
const IDLE_FALLBACK_MS = 15000; 
let _phase = "boot"; 

// ---- INSTRUMENTAÇÃO de latência transcrição→injeção (gated, OFF por padrão) -------------------------
// Mede cada hop do caminho "transcrição pronta -> session.send aceito", pra saber se o delay percebido
// é: (a) a INJEÇÃO em si (nosso JS), (b) o HOST OCUPADO (enqueue espera atrás do turno atual -> capturo
// isProcessing), ou (c) decode/VAD ANTES da transcrição (aí os marcos JS saem todos pequenos). Ligado por
// env VOICE_TIMING=1 ou arquivo timing.flag no dataDir. Turnos são sequenciais -> array de marcos único.
let _timingMarks = [];
let _lastVoiceSendAt = 0;   // instante do session.send aceito -> mede latência do HOST até o agente começar
function timingOn() {
    try { if (process.env.VOICE_TIMING === "1") return true; } catch { }
    try { return existsSync(join(shared.resolveDataDir(), "timing.flag")); } catch { return false; }
}
export function tmark(label, extra) {
    if (!timingOn()) return;
    // Um turno anterior que NÃO deu flush (roteado cross-fork, early-return de ask_user/sessão morta,
    // ou falha do send) não vaza: um novo turno recomeça quando um label de ENTRADA (recv/dispatch/handle)
    // reaparece -> zera os marcos velhos. Mantém o array limitado a um turno mesmo sem flush terminal.
    if (_timingMarks.length && (label === "recv" || label === "dispatch" || label === "handle") && _timingMarks.some((m) => m.label === label)) {
        _timingMarks = [];
    }
    _timingMarks.push({ label, t: Date.now(), ...(extra || {}) });
}
export function timingEnabled() { return timingOn(); }
function tflush(reason) {
    if (!timingOn() || _timingMarks.length === 0) { _timingMarks = []; return; }
    const t0 = _timingMarks[0].t;
    const seq = _timingMarks.map((m) => `${m.label}+${m.t - t0}ms`).join(" ");
    const meta = _timingMarks.find((m) => m.ms != null) || {};
    const proc = _timingMarks.find((m) => m.processing !== undefined);
    dbg(`[timing] ${reason} | ${seq}`
        + (meta.ms != null ? ` | decode=${meta.ms}ms audio=${meta.dur_ms}ms` : "")
        + (proc ? ` | isProcessing@send=${proc.processing}` : "")
        + ` | total=${_timingMarks[_timingMarks.length - 1].t - t0}ms`);
    _timingMarks = [];
}
async function probeProcessing() {
    try {
        if (!(session && session.rpc && session.rpc.metadata && session.rpc.metadata.isProcessing)) return undefined;
        const r = await session.rpc.metadata.isProcessing();
        if (r && typeof r === "object") return r.processing ?? r.isProcessing ?? JSON.stringify(r);
        return r;
    } catch { return undefined; }
}

export function log(msg, level = "debug") {
    dbg(msg);
    try {
        // session.log() é uma RPC ASSÍNCRONA (Promise). O try/catch NÃO pega uma
        // rejeição async: com o handle de sessão morto ("Session not found") a Promise
        // rejeita e vira unhandledRejection [FATAL] — o que derrubava/desestabilizava a
        // fork (re-fork → registro flapping). O .catch() neutraliza (log é best-effort).
        const p = session?.log?.(`[voice-chat] ${msg}`, { level, ephemeral: true });
        if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
    }
}

async function loadSettings() {
    try {
        const raw = await readFile(SETTINGS_FILE, "utf8");
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        settings = { ...DEFAULT_SETTINGS };
    }
    delete settings.fullRead;   // fullRead é POR SESSÃO (modes/<sid>.json) — remove qualquer legado global do settings.json
}

export async function saveSettings() {
    try {
        await mkdir(ARTIFACTS, { recursive: true });
        await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
    } catch (e) {
        log("save settings failed: " + e.message);
    }
}

// fullRead (modo Fala Completa / "Ler resposta completa") é POR SESSÃO — cada painel tem o seu
// (modes/<sid>.json), ao contrário dos demais toggles (globais no settings.json). Ligar num painel
// NÃO afeta as outras sessões. Wrappers sobre voice-shared (fonte ÚNICA do path, igual ao hook).
// Exportados p/ o voice-net (endpoint /full-mode + o hello por-sid). TODO: GC de modes/*.json antigos
// (mesma dívida de forks/ e hook-state-*).
export function readSessionFullRead(sid) { return shared.readSessionFullRead(ARTIFACTS, sid); }
export function writeSessionFullRead(sid, val) { return shared.writeSessionFullRead(ARTIFACTS, sid, val); }

const VOICE_STATE_TTL = 600000; 
const VOICE_TURNS_FILE = join(ARTIFACTS, "voice-turns.json");
const VOICE_TURN_TTL = 300000;
const SPEAK_DEDUP_MS = 20000;

let _turnsCache = null;
let _turnsCacheAt = 0;
const TURNS_CACHE_MS = 1000;
function readTurns(fresh) {
    // Cache curto (1s): sessionTurnPending() era um readFileSync+JSON.parse POR evento de
    // assistant.message (hot path da resposta). O TTL colapsa as N leituras/s numa só e
    // ainda re-lê a cada 1s (visibilidade cross-fork; o TTL do turno é 5min, folgado).
    // INVARIANTE: o retorno é o objeto de cache COMPARTILHADO por referência — NÃO mutar sem
    // passar por writeTurns(). Escritores usam readTurns(true) e chamam writeTurns em seguida.
    // fresh=true: escritores (markTurn/clearTurn) fazem read-modify-write do mapa INTEIRO;
    // usar o cache aqui persistiria marcadores stale de OUTRAS sessões (lost-update cross-sessão).
    const now = Date.now();
    if (!fresh && _turnsCache && now - _turnsCacheAt < TURNS_CACHE_MS) return _turnsCache;
    try { _turnsCache = JSON.parse(readFileSync(VOICE_TURNS_FILE, "utf8")) || {}; } catch { _turnsCache = {}; }
    _turnsCacheAt = now;
    return _turnsCache;
}
function writeTurns(m) {
    _turnsCache = m; _turnsCacheAt = Date.now();   // write-through: mantém o cache coerente
    try { writeFileSync(VOICE_TURNS_FILE, JSON.stringify(m)); } catch {  }
}
function markTurn(sid) {
    if (!sid) return;
    const m = readTurns(true);   // fresh: nunca escreve um mapa stale de outro fork
    m[String(sid)] = Date.now();
    writeTurns(m);
}
function clearTurn(sid) {
    if (!sid) return;
    const m = readTurns(true);   // fresh antes do RMW (idem markTurn)
    if (m[String(sid)] != null) { delete m[String(sid)]; writeTurns(m); }
}
function sessionTurnPending(sid) {
    if (!sid) return false;
    const t = readTurns()[String(sid)];
    return !!t && (Date.now() - t) < VOICE_TURN_TTL;
}
function hasPendingTurn() {
    return pendingVoiceTurn || sessionTurnPending(mySid());
}
function alreadySpoke(sid, text) {
    const key = String(sid || "");
    const prev = recentSpoken.get(key);
    const now = Date.now();
    if (prev && prev.text === text && (now - prev.ts) < SPEAK_DEDUP_MS) return true;
    recentSpoken.set(key, { text, ts: now });
    return false;
}

function saveVoiceState() {
    try {
        writeFileSync(
            VOICE_STATE_FILE,
            JSON.stringify({ pending: true, ts: Date.now(), sid: mySid() }),
            "utf8",
        );
    } catch {
    }
}
function clearVoiceState() {
    try {
        unlinkSync(VOICE_STATE_FILE);
    } catch {
    }
}
function restoreVoiceState() {
    try {
        if (existsSync(VOICE_STATE_FILE)) {
            const st = JSON.parse(readFileSync(VOICE_STATE_FILE, "utf8"));
            const fresh = st && st.pending && Date.now() - (st.ts || 0) < VOICE_STATE_TTL;
            if (fresh && st.sid && st.sid !== mySid()) return;
            if (fresh) {
                pendingVoiceTurn = true;
                armIdleFallback();
                dbg("restoreVoiceState: recovered a pending voice turn after restart");
                return;
            }
        }
    } catch {
    }
    clearVoiceState();
}

export function sanitizeSettings(b) {
    const out = {};
    if (typeof b.voice === "string") out.voice = b.voice;
    if (typeof b.ttsVoice === "string" && b.ttsVoice.trim()) out.ttsVoice = b.ttsVoice.trim();
    if (typeof b.rate === "number" && b.rate >= -10 && b.rate <= 10) out.rate = Math.round(b.rate);
    if (typeof b.language === "string" && /^[a-z]{2}$|^auto$/.test(b.language)) out.language = b.language;
    if (typeof b.authorSummary === "boolean") out.authorSummary = b.authorSummary;
    if (typeof b.confirmTranscript === "boolean") out.confirmTranscript = b.confirmTranscript;
    if (typeof b.cueStart === "boolean") out.cueStart = b.cueStart;
    if (typeof b.cueCheckpoints === "boolean") out.cueCheckpoints = b.cueCheckpoints;
    if (typeof b.handsfree === "boolean") out.handsfree = b.handsfree;
    if (typeof b.interruptMode === "boolean") out.interruptMode = b.interruptMode;
    if (typeof b.focusGate === "boolean") out.focusGate = b.focusGate;
    if (b.micDevice === null || typeof b.micDevice === "number") out.micDevice = b.micDevice;
    return out;
}







export function readUpdateState() {
    try {
        return JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8"));
    } catch {
        return {};
    }
}
export function writeUpdateState(s) {
    try {
        writeFileSync(UPDATE_STATE_FILE, JSON.stringify(s));
    } catch (e) {
        dbg("writeUpdateState failed: " + (e && e.message));
    }
}
// --- Auto-update DA EXTENSÃO: funções puras em voice-update.mjs (versão/assinatura/fetch/logic-hash).
// Versão EFETIVA instalada: o maior entre a baked (extension.mjs em memória) e a aplicada a quente.
export function effectiveVersion(state) {
    const applied = state && state.appliedVersion;
    return (applied && verGt(applied, CURRENT_VERSION)) ? applied : CURRENT_VERSION;
}
// pendingUpdate p/ a UI: só quando há um app-restart pendente E é mais novo que o efetivo.
export function pendingRestartVersion(state) {
    const pv = state && state.pendingVersion;
    return (pv && verGt(pv, effectiveVersion(state))) ? pv : null;
}

// Single-flight: timer periódico + canvas-open + clique + primários velho/novo NÃO podem sobrepor
// (staging concorrente sobre os mesmos .part / update-state). Uma operação por vez; os demais
// aguardam a MESMA promise. `detectOnly` (auto) SÓ verifica a versão remota; o modo cheio (clique)
// baixa+stagea (e o /apply-update relança). Resolve blocking #1 (detect/apply) e #2 (single-flight).
let _updateOpInFlight = null;
let _updateOpFull = false;   // modo da op EM VOO: true = baixa+stagea (force/clique); false = só detecta
export async function checkForUpdate(opts = {}) {
    const full = opts.detectOnly !== true;   // detectOnly=true => leve; qualquer outro (force/normal) => stagea
    // Reusa a op em voo SÓ se ela cobre o pedido: um detect pode pegar carona em qualquer op; um
    // pedido FULL (baixar+stagear) só pega carona em outra FULL — NUNCA num detectOnly (que resolve
    // "available" sem stagear nada). Sem isso, um /apply-update concorrente com o timer/canvas-open
    // adotaria o resultado do detect e relançaria TODAS as sessões sem ter baixado (blocking #1).
    if (_updateOpInFlight && (!full || _updateOpFull)) return _updateOpInFlight;
    // FULL pedido com um detect em voo: encadeia DEPOIS dele (espera terminar, mas roda o stage próprio).
    const prev = _updateOpInFlight;
    const run = (async () => { if (prev) { try { await prev; } catch { } } return _checkForUpdateImpl(opts); })();
    _updateOpInFlight = run; _updateOpFull = full;
    try { return await run; } finally { if (_updateOpInFlight === run) { _updateOpInFlight = null; _updateOpFull = false; } }
}
async function _checkForUpdateImpl(opts = {}) {
    const force = opts.force === true;
    if (UPDATE_DISABLED) return { status: "disabled" };
    const st = readUpdateState();
    const now = Date.now();
    if (!force && UPDATE_THROTTLE_MS > 0 && st.lastCheck && now - st.lastCheck < UPDATE_THROTTLE_MS) {
        const pend = pendingRestartVersion(st);
        if (pend) {
            broadcast({ type: "update", version: pend, needsAppRestart: true });
            return { status: "pending", version: pend, needsAppRestart: true };
        }
        return { status: "throttled" };
    }
    st.lastCheck = now;
    writeUpdateState(st);
    try {
        // Discover the published version from the PUBLIC marketplace manifest, then
        // pull the per-plugin tagged release assets (voice-chat-v<version>) from the
        // same marketplace repo — the single release hub (copilot-mobile convention).
        const mp = JSON.parse((await fetchBuf(MARKETPLACE_MANIFEST_URL)).toString("utf8"));
        const remoteVer = pickPluginVersion(mp, PLUGIN_NAME);
        if (!remoteVer || !verGt(remoteVer, effectiveVersion(st))) {
            // Reconcilia o state: se sobrou um pendingVersion stale de um restart que a versão em
            // execução JÁ alcançou, limpa — senão o guard de canvas (voice-canvas-guard.cjs) leria
            // "restart pendente" para sempre e mandaria reload à toa. Sinal honesto p/ o hook.
            if (st.pendingVersion && !verGt(st.pendingVersion, effectiveVersion(st))) {
                delete st.pendingVersion; writeUpdateState(st);
            }
            return { status: "uptodate", version: effectiveVersion(st) };
        }
        if (st.pendingVersion === remoteVer) {
            broadcast({ type: "update", version: remoteVer, needsAppRestart: true });
            return { status: "pending", version: remoteVer, needsAppRestart: true };
        }
        if (opts.detectOnly === true) {
            // DETECÇÃO automática (timer/canvas-open): anuncia "nova versão disponível" SEM baixar/
            // stagear/aplicar. Baixar+aplicar (stage + fan-out reload) é SÓ no CLIQUE (/apply-update).
            broadcast({ type: "update", version: remoteVer, available: true, needsAppRestart: true });
            return { status: "available", version: remoteVer, needsAppRestart: true };
        }
        const base = releaseAssetBase(remoteVer);
        const manifest = JSON.parse((await fetchBuf(base + "manifest.json")).toString("utf8"));
        // Portão de AUTENTICIDADE: o manifesto precisa estar assinado pela chave do
        // projeto. Sem isso (ou assinatura inválida), ABORTA — nem em rede que
        // reassina o TLS um atacante consegue empurrar bytes/hashes forjados.
        if (!verifyManifestSig(manifest)) throw new Error("assinatura do manifesto de update inválida ou ausente");
        // Anti-rollback: a versão ASSINADA precisa ser a anunciada E maior que a atual.
        // Bloqueia o MITM que anuncia versão alta (marketplace.json não é assinado) e
        // devolve um manifesto ANTIGO genuinamente assinado (downgrade forçado).
        if (!updateVersionAcceptable(manifest.version, remoteVer, effectiveVersion(st)))
            throw new Error("versão do update recusada (rollback/incoerente): assinada="
                + (manifest && manifest.version) + " anunciada=" + remoteVer + " atual=" + effectiveVersion(st));
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const staged = [];
        for (const f of files) {
            const rel = typeof f === "string" ? f : f && f.path;
            // AUTORIZAÇÃO = assinatura Ed25519 do manifesto (verifyManifestSig, acima), NÃO a
            // allowlist LOCAL: um install ANTIGO precisa poder receber um arquivo NOVO do release
            // (ex.: vox_lifecycle.py) — senão aplica update PARCIAL (worker novo sem o módulo novo
            // -> ModuleNotFoundError -> "motor de voz falhou"). Só a segurança do NOME fica aqui
            // (basename, sem traversal); o conteúdo já é coberto por assinatura + sha256 por arquivo.
            if (!updateNameSafe(rel)) {
                dbg("update: skipping unsafe file name " + rel);
                continue;
            }
            const want = typeof f === "object" ? f.sha256 : null;
            if (!want) throw new Error("manifest sem sha256 para " + rel);   // obrigatório
            const buf = await fetchBuf(base + rel);
            if (sha256Hex(buf) !== want) throw new Error("sha256 mismatch for " + rel);
            staged.push({ rel, buf });
        }
        if (!staged.length) return { status: "uptodate", version: effectiveVersion(st) };
        // Classifica ANTES de sobrescrever: o que muda vs o disco atual + se a LÓGICA do extension.mjs mudou.
        const changedRels = [];
        const stagedMap = new Map(staged.map((s) => [s.rel, s.buf]));
        for (const s of staged) {
            const target = join(EXT_DIR, s.rel);
            let preSha = null;
            try { if (existsSync(target)) preSha = sha256Hex(readFileSync(target)); } catch { }
            if (sha256Hex(s.buf) !== preSha) changedRels.push(s.rel);
        }
        // LÓGICA mudou? compara o hash do CONJUNTO de módulos de lógica (staged onde houver, senão o
        // disco ATUAL — antes do overwrite abaixo) contra o que está rodando em memória.
        const stagedLogicSha = computeLogicSha((rel) =>
            stagedMap.has(rel) ? stagedMap.get(rel).toString("utf8") : readFileSync(join(EXT_DIR, rel), "utf8"));
        const extLogicChanged = stagedLogicSha !== RUNNING_EXT_LOGIC_SHA;
        // Commit em DUAS FASES p/ resistir a interrupção (a máquina do usuário reclamou de "voice-audio
        // importa voice-net que não está na máquina" — sintoma de update parcial). Fase 1: escreve TODOS
        // os .part (+ .bak). Fase 2: renomeia TODOS de uma vez. Assim nunca fica um MIX novo+velho em que
        // um importer novo (voice-audio.mjs) referencia um módulo ainda ausente (voice-net.mjs) — a janela
        // vira só o loop de renames locais contíguos, não um write/rename intercalado por arquivo.
        const pending = [];
        for (const s of staged) {
            const target = join(EXT_DIR, s.rel);
            const part = target + ".part";
            writeFileSync(part, s.buf);
            try { if (existsSync(target)) copyFileSync(target, target + ".bak"); } catch { }
            pending.push({ part, target });
        }
        for (const p of pending) renameSync(p.part, p.target);
        const plan = classifyStagedUpdate(changedRels, extLogicChanged);
        if (plan.needsAppRestart) {
            // A LÓGICA do extension.mjs mudou: o bundle é co-versionado -> só um restart do app aplica
            // tudo junto (o host precisa reimportar o módulo). NÃO aplica a quente (evita UI/worker novos
            // contra um extension.mjs velho). Marca pendente e avisa de forma honesta.
            st.pendingVersion = remoteVer;
            delete st.appliedVersion;
            writeUpdateState(st);
            log("auto-update: v" + remoteVer + " baixado; extension.mjs (lógica) mudou -> app restart pendente");
            broadcast({ type: "update", version: remoteVer, needsAppRestart: true });
            return { status: "staged", version: remoteVer, needsAppRestart: true };
        }
        // extension.mjs (lógica) inalterado -> worker/UI novos são compatíveis com o módulo em memória:
        // aplica a QUENTE (só o primary chega aqui, guard no topo). Sem "reinicie" eterno.
        if (plan.workerChanged) { try { restartWorker(); } catch (e) { dbg("auto-update restartWorker: " + (e && e.message)); } }
        if (plan.uiChanged) { try { broadcast({ type: "reloadUi" }); } catch { } }
        st.appliedVersion = remoteVer;
        delete st.pendingVersion;
        writeUpdateState(st);
        log("auto-update: v" + remoteVer + " aplicado a quente (worker=" + plan.workerChanged + " ui=" + plan.uiChanged + ")");
        broadcast({ type: "updated", version: remoteVer });
        return { status: "applied", version: remoteVer };
    } catch (e) {
        dbg("update check failed: " + (e && e.message));
        return { status: "error", error: (e && e.message) || "falha ao verificar" };
    }
}

// --- Python interpreter discovery (PATH-independent) ------------------------
// "spawn python ENOENT" bricked the motor whenever the app was launched without
// Python on PATH. Discovery prefers a cached known-good interpreter and absolute
// paths from the py launcher (registry-based, PATH-independent) + common install
// dirs, falling back to bare PATH names only as a last resort. The interpreter
// that reaches "ready" is cached so later starts no longer depend on PATH.
// --- Python interpreter discovery: ver voice-python.mjs (independente do PATH) ---

function isDeadSessionError(e) {
    // O handle joinSession morreu: o backend não conhece mais a sessão. O SDK reporta
    // "Session not found for sessionId: …" ou "session has been disconnected". NÃO há
    // reconnect no SDK — a fork morta deve parar de competir para o primary re-rotear.
    const m = (e && (e.message || String(e))) || "";
    // SÓ frases TERMINAIS que o SDK realmente lança (verificado no fonte do SDK,
    // copilot-sdk/extension.js): "Session not found: <id>" / "…Session not found for
    // sessionId:…" (8135-8190), "Connection is closed." (2307), "Connection is disposed."
    // (2310), "…connection got disposed" (2628). NÃO casar o substring cru "disconnect":
    // mensagens RECUPERÁVEIS ("client disconnected, retrying", "reconnecting…") não podem
    // quiescer a fork p/ sempre (falso-positivo = perda de voz até reabrir o painel).
    return /session not found|has been disconnected|connection is (closed|disposed)|connection got disposed/i.test(m);
}

const SEND_DEAD_RETRIES = 3;        // re-tentativas de session.send diante de "Session not found" TRANSITÓRIO (ex.: logo após um Stop que só aborta o turno)
const SEND_RETRY_BASE_MS = 400;

export async function handleVoiceTranscript(text) {
    tmark("handle");
    // ROTEAMENTO 1 — ask_user ABERTO: responde a PERGUNTA (freeform) em vez de um send novo.
    if (pendingUserInputId && session.rpc && session.rpc.ui && session.rpc.ui.handlePendingUserInput) {
        const rid = pendingUserInputId;
        try {
            const r = await session.rpc.ui.handlePendingUserInput({ requestId: rid, response: { answer: text, wasFreeform: true } });
            if (r && r.success) {
                if (pendingUserInputId === rid) pendingUserInputId = null;
                dbg(`ask_user respondido por voz (freeform): requestId=${rid}`);
                return true;
            }
            dbg(`handlePendingUserInput success=false (rid=${rid}); caindo pro send normal`);
        } catch (e) {
            dbg(`handlePendingUserInput falhou (rid=${rid}): ${e && e.message}; caindo pro send normal`);
        }
        if (pendingUserInputId === rid) pendingUserInputId = null;
    }
    pendingVoiceTurn = true;
    _phase = "voiceTurn:start";
    voiceInstructionPending = settings.authorSummary !== false || settings.cueCheckpoints !== false;
    spokenCheckpoints.clear();
    saveVoiceState();
    markTurn(mySid());
    broadcastTo(mySid(), { type: "status", state: "thinking" });
    armIdleFallback();
    dbg(`handleVoiceTranscript: sending prompt (${text.length} chars): ${text.slice(0, 120)}`);
    if (timingOn()) { const processing = await probeProcessing(); tmark("send_call", { processing }); }
    let lastErr = null;
    for (let attempt = 1; attempt <= SEND_DEAD_RETRIES; attempt++) {
        try {
            const mode = settings.interruptMode ? "immediate" : "enqueue";
            if (stopDiagOn()) { const s = await _snapProc(); dtrace(`SEND(voice) mode=${mode} textlen=${text.length} pre.isProcessing=${s.proc} preview="${text.slice(0, 48).replace(/\s+/g, " ")}"`); }
            const messageId = await session.send({ prompt: text, mode });
            if (stopDiagOn()) {
                const s1 = await _snapProc();
                dtrace(`SEND(voice) post messageId=${messageId} pendingItems=${s1.pend}`);
                setTimeout(async () => { const s2 = await _snapProc(); dtrace(`SEND(voice) +2s isProcessing=${s2.proc} pendingItems=${s2.pend} (started=${s2.proc && s2.proc.includes("true")})`); }, 2000);
            }
            _phase = "voiceTurn:sent";
            tmark("send_done"); tflush("voiceTurn");
            if (timingOn()) _lastVoiceSendAt = Date.now();
            if (settings.cueStart !== false) {
                speakCue("Ok, comecei a trabalhar na sua solicitação.", "start").catch(() => {});
            }
            dbg(`session.send resolved messageId=${messageId}${attempt > 1 ? ` (após ${attempt} tentativas)` : ""}`);
            return true;
        } catch (e) {
            lastErr = e;
            if (!isDeadSessionError(e)) {
                dbg(`session.send THREW (não-recuperável): ${e && e.stack ? e.stack : e}`);
                log("session.send failed: " + e.message);
                broadcastTo(mySid(), { type: "error", msg: "Falha ao enviar para o Copilot: " + e.message });
                pendingVoiceTurn = false;
                return false;
            }
            dbg(`session.send dead-session (tentativa ${attempt}/${SEND_DEAD_RETRIES}): ${e && e.message}`);
            if (attempt < SEND_DEAD_RETRIES) { await new Promise((r) => setTimeout(r, SEND_RETRY_BASE_MS * attempt)); }
        }
    }
    log("session.send falhou (" + SEND_DEAD_RETRIES + " tentativas): " + (lastErr && lastErr.message ? lastErr.message : lastErr));
    pendingVoiceTurn = false;
    broadcastTo(mySid(), { type: "error", msg: "Não consegui enviar sua fala ao Copilot. Tente de novo." });
    return false;
}

function onAssistantMessage(event) {
    if (event?.agentId) return; // só as mensagens do agente raiz são faladas
    const content = event?.data?.content;
    // Processa APENAS turnos de VOZ pendentes (o usuário falou). O áudio da resposta é produzido pela
    // tool `falar` (o agente a chama); aqui só cuidamos dos cues de checkpoint + limpeza do turno.
    const pending = hasPendingTurn();
    if (!pending) return;
    if (_lastVoiceSendAt) { dbg(`[timing] host-latency: send->1ª msg do agente = ${Date.now() - _lastVoiceSendAt}ms`); _lastVoiceSendAt = 0; }
    _phase = "reply:msg";
    dbg(`onAssistantMessage: len=${typeof content === "string" ? content.length : 0} pending=${pending}`);
    armIdleFallback();
    if (typeof content === "string" && content.trim()) {
        latestReply = content;
        maybeSpeakCheckpoints(content);
    }
}

function maybeSpeakCheckpoints(content) {
    if (!hasPendingTurn() || settings.cueCheckpoints === false) return;
    const re = /📍[ \t]*([^\n]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        const text = m[1].trim();
        if (!text || spokenCheckpoints.has(text)) continue;
        spokenCheckpoints.add(text);
        speakCue(text, "checkpoint").catch(() => {});
    }
}

function onIdle(event) {
    if (!hasPendingTurn()) return;
    _phase = "idle-event";
    dbg(`onIdle: agentId=${event?.agentId ?? "(root)"} pendingVoiceTurn=${pendingVoiceTurn}`);
    if (event?.agentId) return;
    flushSpeech();
}

function armIdleFallback() {
    if (idleFallback) clearTimeout(idleFallback);
    idleFallback = setTimeout(onIdleFallbackFired, IDLE_FALLBACK_MS);
}

function onIdleFallbackFired() {
    idleFallback = null;
    dbg("idleFallback: firing flushSpeech (session.idle never arrived)");
    flushSpeech();
}

async function flushSpeech() {
    _phase = "flushSpeech";
    if (idleFallback) {
        clearTimeout(idleFallback);
        idleFallback = null;
    }
    const content = latestReply;
    dbg(`flushSpeech: hasContent=${!!content} pendingVoiceTurn=${pendingVoiceTurn} sameAsLast=${content === lastSpokenContent}`);
    if (!content) return;
    if (!hasPendingTurn()) return;
    if (content === lastSpokenContent) {
        pendingVoiceTurn = false;
        clearVoiceState();
        clearTurn(mySid());
        return;
    }
    lastSpokenContent = content;
    pendingVoiceTurn = false;
    clearVoiceState();
    clearTurn(mySid());
    // A COLETA do resumo falado é do Stop hook (voice-summary-stop.cjs), NÃO da extensão. O hook
    // roda a cada fim de turno (painel aberto OU fechado, servidor vivo ou não), garante o 🔊 e
    // ESCREVE o resumo em pending/<sid>.jsonl. A extensão só DRENA esse arquivo (drainPendingSpeak)
    // e toca; aqui NÃO sintetiza nem enfileira a resposta "ao vivo" (senão duplicaria o do hook).
    // Melhor-esforço: se ESTA fork é o primário, dreno já o que o hook escreveu neste turno (baixa
    // latência). Pode perder a corrida com o hook (que escreve no agentStop) — o sweep periódico
    // abaixo garante em ≤2s de qualquer forma.
    drainPendingSpeak(mySid()).catch(() => { });
    _phase = "flushSpeech:done";
}

// ---- Per-session audio HISTORY (navigable + re-playable) --------------------
// Replaces the old consumable FIFO. Every spoken audio (start cue, checkpoints,
// final reply) is APPENDED to a per-session history that is NEVER discarded on
// play, so the user can scroll back and re-hear earlier summaries. Item shape:
//   { seq, id, turn, type:"reply"|"cue", kind, spoken, full, audio, ts }
// A reply (🔊) closes a turn, so the next item starts turn+1 (UI turn separators).
// `deliveredSeq` = highest seq already handed to the active client, so a reopened
// session autoplays only the tail it hasn't heard yet. Persisted so it survives a
// primary failover / extension restart.

// ---- heartbeat de vida da sessão (para o Stop hook detectar canvas CAÍDO) -------------
// O canvas é registrado pelo joinSession DESTA sessão e MORRE com o processo. Então
// "canvas registrado <=> processo da sessão vivo". Cada sessão grava seu heartbeat em forks/<sid>.json={pid,ts} e o
// atualiza a cada 5s (NÃO remove no SIGTERM — de propósito: um PID morto no arquivo é a impressão
// digital DETERMINÍSTICA do canvas caído). O Stop hook lê isso e, se o PID estiver morto, avisa o
// agente a rodar extensions_reload (caminho A->B->C: hook detecta -> avisa -> agente recarrega).
const FORKS_DIR = shared.forksDir(ARTIFACTS);
function forkHeartbeatFile(sid) {
    return shared.forkHeartbeatFile(ARTIFACTS, sid);
}
function writeForkHeartbeat(status = "ready") {
    const sid = ownSid || mySid();
    if (!sid) return;
    // status: "joining" (gravado ANTES do joinSession) | "ready" (canvas registrado) | "failed"
    // (joinSession falhou 2x). O Stop hook lê isto: "failed" (ou PID morto/ts velho) => aconselha
    // extensions_reload. É o rastro em disco, cross-process, do REGISTRO do canvas — tira o sistema
    // do buraco negro "host vivo sem canvas" (a causa do erro recorrente "Canvas ... not registered").
    try { mkdirSync(FORKS_DIR, { recursive: true }); writeFileSync(forkHeartbeatFile(sid), JSON.stringify({ pid: process.pid, ts: Date.now(), status })); } catch { /* best-effort */ }
}
function pruneForkHeartbeats() {
    // higiene: remove heartbeats de sids antigos cujo PID está morto E o ts é velho (>1 dia).
    try {
        if (!existsSync(FORKS_DIR)) return;
        const now = Date.now();
        for (const fn of readdirSync(FORKS_DIR)) {
            if (!fn.endsWith(".json")) continue;
            const full = join(FORKS_DIR, fn);
            let hb; try { hb = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
            if (hb && (now - (hb.ts || 0)) > 86400000) { try { unlinkSync(full); } catch { /* ignore */ } }
        }
    } catch { /* ignore */ }
}

// ---- fila EM ARQUIVO que o Stop hook (voice-summary-stop.cjs) escreve --------------------------
// O hook SEMPRE coleta o resumo 🔊 pra pending/<sid>.jsonl — mesmo com servidor/canvas CAÍDOS.
// Quando o servidor sobe (primary) E/OU um canvas conecta (hello), o PRIMÁRIO drena: sintetiza +
// enfileira na fila durável + toca; o item some do pending (consumido). A rotação por rename é
// atômica, então um append do hook durante o drain não se perde (fica pro próximo drain).
const PENDING_SPEAK_DIR = shared.pendingDir(ARTIFACTS);
function pendingSpeakFile(sid) {
    return shared.pendingSpeakFile(ARTIFACTS, sid);
}
async function _processDrainFile(proc, fallbackSid) {
    let lines = [];
    try { lines = readFileSync(proc, "utf8").split("\n"); } catch { /* ignore */ }
    for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        let item;
        try { item = JSON.parse(t); } catch { continue; }
        const spoken = cleanForSpeech(String((item && item.spoken) || ""));
        if (spoken) { try { await speakToCanvas(item.sid || fallbackSid, spoken); } catch { /* segue */ } }
    }
    try { unlinkSync(proc); } catch { /* ignore */ }
}
export async function drainPendingSpeak(sid) {
    if (!sid) return;
    if (!workerReady) return;           // motor OFF -> deixa o texto na fila de síntese (drena qdo ligar)
    const f = pendingSpeakFile(sid);
    if (!existsSync(f)) return;
    const proc = `${f}.draining-${process.pid}-${Date.now()}`;
    try { renameSync(f, proc); } catch { return; }   // sumiu / outro drain já pegou (rotação atômica)
    await _processDrainFile(proc, sid);
}
// Writer da fila de TEXTO (motor off / sem primário alcançável): o handler da tool `falar` grava
// aqui e o drain sintetiza+toca quando o motor liga. Mesmo formato que o Stop hook usava.
function writePendingSpeak(sid, text) {
    if (!sid || !text) return false;
    try {
        mkdirSync(PENDING_SPEAK_DIR, { recursive: true });
        appendFileSync(pendingSpeakFile(sid), JSON.stringify({ sid, spoken: text, ts: Date.now() }) + "\n");
        return true;
    } catch { return false; }
}
export async function drainAllPendingSpeak() {
    try {
        if (!existsSync(PENDING_SPEAK_DIR)) return;
        for (const fn of readdirSync(PENDING_SPEAK_DIR)) {
            if (fn.endsWith(".jsonl")) { await drainPendingSpeak(fn.slice(0, -6)); continue; }
            // órfão: um ".jsonl.draining-*" VELHO (>60s) = drain que crashou no meio. Apaga pra não
            // VAZAR (os itens já se perderam no crash; reprocessar arriscaria áudio DOBRADO — pior).
            if (fn.includes(".jsonl.draining-")) {
                const full = join(PENDING_SPEAK_DIR, fn);
                try { if (Date.now() - statSync(full).mtimeMs > 60000) unlinkSync(full); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

export async function speakToCanvas(sid, spoken, full, cue) {
    if (cue) {
        // Progress cue text updates the UI immediately (silent); the AUDIO only
        // plays if this session is active, otherwise it joins the per-session FIFO
        // queue and plays in order when the user returns to the session.
        broadcastTo(sid, { type: "cue", kind: cue, spoken });
        try {
            const wav = await synthesize(spoken);
            playOrQueueAudio(sid, { type: "cue", kind: cue, spoken, audio: "/tts/" + wav });
        } catch (e) {
            dbg("speakToCanvas cue tts failed: " + (e && e.message));
        }
        return;
    }
    if (alreadySpoke(sid, spoken)) {
        dbg(`dedup: ignoring duplicate reply for sid=${sid}`);
        return true;   // já tratado recentemente -> sucesso p/ o chamador (não re-enfileirar)
    }
    // Reply text shows immediately (silent UI update); the audio is persisted for
    // replay and either plays now (if this is the active session) or queues FIFO.
    broadcastTo(sid, { type: "reply", spoken, full });
    try {
        const wav = await synthesize(spoken);
        playOrQueueAudio(sid, { type: "reply", spoken, full, audio: "/tts/" + wav });
        return true;
    } catch (e) {
        log("tts failed: " + e.message);
        broadcastTo(sid, { type: "error", msg: "Falha na síntese de voz: " + e.message });
        // nada tocou: libera o dedup desta fala p/ um re-enqueue (fila de texto) poder RE-TENTAR sem ser
        // suprimido, e sinaliza a falha ao chamador (o handler da tool re-enfileira em vez de mentir "Falado").
        const k = String(sid || "");
        const cur = recentSpoken.get(k);
        if (cur && cur.text === spoken) recentSpoken.delete(k);
        return false;
    }
}

function canPlayInSession(sid) {
    return !sid || sid === mySid();
}

export function sessionHasClient(sid) {
    if (!sid) return true;
    for (const csid of sseClients.values()) if (csid === sid) return true;
    return false;
}

async function speakCue(text, kind) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    await routeSpeak({ spoken: clean, cue: kind });
}



async function routeSpeak({ spoken, full, cue, sid = mySid() }) {
    if (!spoken) return false;
    return speakToCanvas(sid, spoken, full, cue);
}

// Helpers de modelagem de texto p/ fala (cleanForSpeech/firstSentences/extractAuthoredSummary/
// stripCheckpointLines/makeSpoken): puros, em voice-text.mjs.

export function claimVoiceOwnership(sid) {
    if (!sid) return;
    const s = String(sid);
    setTurnOwnerSid(s);
}

export function setRecordingActive(sid) {
    recordingActiveSid = sid;
    if (recordingActiveTimer) clearTimeout(recordingActiveTimer);
    recordingActiveTimer = setTimeout(() => { recordingActiveSid = null; recordingActiveTimer = null; }, 60000);
    if (recordingActiveTimer.unref) recordingActiveTimer.unref();
    // NÃO escreve mais o mic.lock: a captura é 100% no DAEMON (capture_open) e ele é o ÚNICO
    // dono/escritor do lock (sid "vox-daemon"). Escrever aqui com a MINHA sid fazia o daemon ver
    // um dono "estranho" e recusar a PRÓPRIA captura (mic_busy) = auto-bloqueio. Só estado em memória.
}

export function clearRecordingActive() {
    recordingActiveSid = null;
    if (recordingActiveTimer) { clearTimeout(recordingActiveTimer); recordingActiveTimer = null; }
    // NÃO toca no mic.lock: quem o possui e o libera é o DAEMON (no stop/cancel da captura).
}

export function startMonitor(sid) {
    if (!sid) return;
    setMonitorSid(sid);
    ensureWorker();
    try { workerSend({ cmd: "monitor", on: true }); } catch { }
}

export function stopMonitor(sid) {
    if (sid && monitorSid !== sid) return;
    setMonitorSid(null);
    try { workerSend({ cmd: "monitor", on: false }); } catch { }
}

export function quiesceClosedPanelCapture(sid, opts = {}) {
    const cancelRecording = opts.cancelRecording !== false;
    if (cancelRecording && recordingActiveSid && (!sid || recordingActiveSid === sid)) {
        try { workerSend({ cmd: "cancel" }); } catch { }
        clearRecordingActive();
    }
    if (turnOwnerSid === sid) setTurnOwnerSid(null);
    if (monitorSid === sid) stopMonitor(sid);
}





















const canvas = createCanvas({
    id: "voice-chat",
    displayName: "Voz",
    description:
        "Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (transcrição e voz em pt-BR pelo motor de voz vox-engine).",
    actions: [
        {
            name: "speak",
            description: "Sintetiza e reproduz um texto em voz alta no painel de voz (voz pt-BR pelo motor).",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string", description: "Texto a ser falado em voz alta." } },
                required: ["text"],
            },
            handler: async (ctx) => {
                const text = String(ctx.input?.text || "").trim();
                if (!text) throw new CanvasError("invalid_input", "O campo 'text' está vazio.");
                const { spoken, full } = makeSpoken(text);
                const sid = String((ctx && ctx.sessionId) || ownSid || mySid());
                const speakText = readSessionFullRead(sid) ? full : spoken || text;
                // Motor ainda não pronto -> ENFILEIRA (mesmo padrão do falarTool) em vez de estourar no
                // routeSpeak sem worker; o drain toca quando o motor liga. Sem isto, um speak precoce
                // (ex.: logo após o registro do canvas, motor subindo) virava exceção na ação do canvas.
                if (!workerReady) { writePendingSpeak(sid, speakText); ensureWorker(); return { ok: true, queued: true, spoken: speakText }; }
                const fullForUi = full && full !== speakText ? full : undefined;
                await routeSpeak({ spoken: speakText, full: fullForUi, sid });
                return { ok: true, spoken: speakText };
            },
        },
        {
            name: "status",
            description: "Retorna o estado do motor de voz (pronto, modelo atual e configurações).",
            handler: async () => ({
                workerReady,
                settings,
                sseConnected: sseClients.size,
                recordingSupported: true,
                mySid: mySid(),
            }),
        },
        {
            name: "selftest",
            description:
                "Diagnóstico: injeta uma fala de teste no Copilot (como se viesse do microfone) para validar o circuito de voz de ponta a ponta.",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
            },
            handler: async (ctx) => {
                const text =
                    String(ctx.input?.text || "").trim() ||
                    "Autoteste do circuito de voz. Por favor, responda em uma frase curta confirmando que me ouviu.";
                setTimeout(() => {
                    handleVoiceTranscript(text);
                }, 1500);
                return { ok: true, scheduled: true, injected: text };
            },
        },
    ],
    open: async (ctx) => {
        await mkdir(ARTIFACTS, { recursive: true }).catch(() => {});
        const panelSid = String((ctx && ctx.sessionId) || mySid());
        if (!(ctx && ctx.sessionId)) log("open: ctx.sessionId ausente; usando mySid() como fallback — sid do painel pode ficar errado");
        // O open() roda no fork DONO do canvas desta sessão -> ctx.sessionId é o sid confiável desta
        // fork. Fixa o ownSid (uma vez) e grava o heartbeat já, mesmo que mySid() estivesse vazio.
        if (ctx && ctx.sessionId && !ownSid) { setOwnSid(String(ctx.sessionId)); writeForkHeartbeat(); }
        let entry = _servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer();
            _servers.set(ctx.instanceId, entry);
        }
        ensureWorker();
        checkForUpdate({ detectOnly: true }).catch(() => {});
        return {
            title: "Voz",
            url: withSid(entry.url, panelSid),
            status: workerReady ? "Pronto" : "Iniciando…",
        };
    },
    onClose: async (ctx) => {
        const sid = String((ctx && ctx.sessionId) || mySid());
        quiesceClosedPanelCapture(sid);
        const entry = _servers.get(ctx.instanceId);
        if (!entry) return;
        _servers.delete(ctx.instanceId);
        await new Promise((r) => entry.server.close(() => r()));
    },
});

// Tool `falar` (v1.5.16): o agente produz áudio QUANDO quiser (não só no fim). Handler recebe o
// texto + invocation.sessionId (sid CONFIÁVEL). Motor ON -> speakToCanvas (toca/enfileira durável);
// motor OFF -> writePendingSpeak (fila de texto, drenada quando o motor ligar). Retorna tool_result.
const FALAR_STEER = " · [Entregue como ÁUDIO ao usuário — NÃO reescreva em texto o que acabou de falar; encerre o turno com texto mínimo (ou nenhum). Para seguir agindo, faça outras tool calls direto.]";
// Steer do modo FALA COMPLETA: a resposta INTEIRA é áudio, então NÃO pede "texto mínimo/1 frase" —
// reforça continuar com mais `falar` até cobrir tudo; só artefato (código/tabela/imagem) vai ao texto.
const FALAR_STEER_FULL = " · [Entregue como ÁUDIO — esta É a resposta ao usuário; NÃO reescreva em texto (evita duplicar). Continue a resposta com mais chamadas `falar` até cobrir TUDO; só código/tabela/imagem vão ao texto, FORA do `falar`.]";
const falarTool = {
    name: "falar",
    description:
        "Fala em voz alta para o usuário no painel de Voz (pt-BR). Passe um texto natural, sem markdown, " +
        "sem código e sem emojis. Use SEMPRE que quiser que algo seja OUVIDO — inclusive ANTES de fazer " +
        "uma pergunta e várias vezes por turno. O QUANTO falar (um resumo curto ou a resposta completa) " +
        "segue a instrução do turno / a configuração do painel. O áudio sai na hora (ou entra na fila e " +
        "toca quando o painel/motor de voz ligar). IMPORTANTE: o que você falar aqui JÁ chega ao usuário " +
        "como áudio — NÃO reescreva a mesma coisa em texto depois (evita duplicar). Para continuar agindo, " +
        "faça outras tool calls direto.",
    parameters: {
        type: "object",
        properties: {
            texto: { type: "string", description: "O texto a ser falado em voz alta (natural, pt-BR, sem markdown/código/emojis)." },
        },
        required: ["texto"],
    },
    skipPermission: true,
    handler: async (args, invocation) => {
        const sid = String((invocation && invocation.sessionId) || ownSid || mySid());
        const text = cleanForSpeech(String((args && (args.texto ?? args.text)) || ""));
        if (!text) return "Nada para falar: o texto veio vazio.";
        const steer = readSessionFullRead(sid) ? FALAR_STEER_FULL : FALAR_STEER;   // completo (por-sessão) -> continue falando; resumo -> feche
        if (!workerReady) { writePendingSpeak(sid, text); ensureWorker(); return "🔊 Enfileirado para falar quando o motor de voz ligar: " + text.slice(0, 90) + steer; }
        let ok = false;
        try { ok = await speakToCanvas(sid, text); } catch { ok = false; }
        if (ok) return "🔊 Falado: " + text.slice(0, 120) + steer;
        // synth falhou agora: re-enfileira (o drain re-tenta quando o motor voltar) e reporta HONESTO.
        writePendingSpeak(sid, text); ensureWorker();
        return "🔊 Enfileirado (falha ao sintetizar agora, re-tenta quando o motor voltar): " + text.slice(0, 90) + steer;
    },
};

// REGISTER-FIRST (register-first, configure-later — igual ao activate() do VS Code): o canvas é o
// CONTRATO com o host e PRECISA registrar ANTES de qualquer I/O interno. A causa-raiz do erro
// recorrente «Canvas "voice-chat" is not registered» era um await BLOQUEANTE antes daqui (o
// loadSettings lendo disco durante um update in-place, p.ex.): o host ficava VIVO sem o canvas e só
// um extensions_reload manual curava. Registrando primeiro, settings/worker viram detalhe pós-contrato.
const _joinCfg = {
    canvases: [canvas],
    tools: [falarTool],
    hooks: {
        onUserPromptSubmitted: async (input) => {
            if (!voiceInstructionPending) return undefined;
            voiceInstructionPending = false;
            let ctx = "";
            if (settings.authorSummary !== false) ctx += readSessionFullRead(mySid()) ? VOICE_TOOL_INSTRUCTION_FULL : VOICE_TOOL_INSTRUCTION;
            if (settings.cueCheckpoints !== false) ctx += (ctx ? " " : "") + CHECKPOINT_INSTRUCTION;
            return ctx ? { additionalContext: ctx } : undefined;
        },
    },
};
// Rastro ANTES do join: se ele TRAVAR (heartbeat "joining" envelhece) ou FALHAR ("failed"), o Stop
// hook deixa de ver o VÁCUO de antes e passa a aconselhar o reload — fim do buraco negro silencioso.
writeForkHeartbeat("joining");
try {
    session = await joinSession(_joinCfg);
} catch (e1) {
    // Registrar o canvas é INVARIANTE: em vez de silenciar, 1 retry (disconnect+rejoin — mesmo padrão
    // do reflect(); o SDK faz canvases.clear()+set(), então o re-join é idempotente). SEM process.exit:
    // o SDK trata a saída do host como fatal SEM respawn, e host morto é pior que host recuperável.
    log("joinSession FALHOU (1/2): " + (e1 && e1.message) + " — retry via disconnect+rejoin");
    try { await session?.disconnect?.(); } catch { /* pode nem haver sessão criada */ }
    try {
        session = await joinSession(_joinCfg);
    } catch (e2) {
        writeForkHeartbeat("failed");   // PID vivo + status "failed" -> o Stop hook aconselha extensions_reload
        log("CRITICAL: joinSession FALHOU 2x — canvas 'voice-chat' NÃO registrado nesta sessão (" + (e2 && e2.message) + "). Rode extensions_reload.");
        throw e2;   // fail-loud: nada de sucesso fake; o rastro "failed" + o CRITICAL ficam visíveis
    }
}
writeForkHeartbeat("ready");   // canvas registrado
await loadSettings();          // AGORA sim o I/O interno (settings), DEPOIS do contrato com o host
session.on("assistant.message", onAssistantMessage);
session.on("session.idle", onIdle);
// --- STOP-DIAG (gated: `stop-diag.flag` no dataDir OU env VOICE_STOP_DIAG=1) --------------------
// Diagnóstico DO ZERO da queixa real: "quando dou Stop, o turno NÃO libera e deveria". O debug.log é
// COMPARTILHADO por todas as sessões da máquina, então TODA linha é carimbada com o sid pra eu
// isolar ESTA sessão. Captura a linha do tempo pós-abort: o evento abort, se/quando assistant.idle e
// turn_start/turn_end chegam, e isProcessing+pendingItems amostrados em 0.2/1/3/6/12/20/30s — pra ver
// se o turno REALMENTE solta sozinho, e o que o re-ocupa (suspeita nº1: a nossa própria varredura de
// held-turns re-injetando). Só leitura; nenhum session.send aqui.
export function stopDiagOn() {
    if (process.env.VOICE_STOP_DIAG === "1") return true;
    try { return existsSync(join(shared.resolveDataDir(), "stop-diag.flag")); } catch { return false; }
}
export function dtrace(msg) { if (stopDiagOn()) { try { dbg(`[STOP-DIAG sid=${mySid()}] ${msg}`); } catch { } } }
function _withTimeout(p, ms, label) {
    return Promise.race([
        Promise.resolve(p).then((v) => JSON.stringify(v)).catch((e) => "err:" + (e && e.message)),
        new Promise((res) => { const h = setTimeout(() => res(`HANG(>${ms}ms)`), ms); if (h && h.unref) h.unref(); }),
    ]).catch(() => "err:race");
}
async function _snapProc() {
    // CADA chamada corre contra um timeout: se o RPC TRAVA pós-abort (suspeita nº1), loga HANG em vez de
    // sumir silenciosamente (foi por isso que o poll anterior não logou nada). Isso PROVA se a sessão fica
    // presa como ocupada (RPC não responde) ou se realmente libera.
    let proc = "?", pend = "-";
    try { proc = await _withTimeout(session.rpc && session.rpc.metadata && session.rpc.metadata.isProcessing ? session.rpc.metadata.isProcessing() : "no-api", 1500); } catch (e) { proc = "err:" + (e && e.message); }
    try { pend = await _withTimeout(session.rpc && session.rpc.queue && session.rpc.queue.pendingItems ? session.rpc.queue.pendingItems() : "no-api", 1500); } catch (e) { pend = "err:" + (e && e.message); }
    return { proc, pend };
}
let _procPollT = [];
function pollProcessingAfterAbort() {
    for (const t of _procPollT) { try { clearTimeout(t); } catch { } }
    _procPollT = [];
    const t0 = Date.now();
    for (const ms of [200, 1000, 3000, 6000, 12000, 20000, 30000]) {
        const h = setTimeout(async () => {
            const s = await _snapProc();
            dtrace(`+${Date.now() - t0}ms isProcessing=${s.proc} pendingItems=${s.pend}`);
        }, ms);
        if (h && h.unref) h.unref();
        _procPollT.push(h);
    }
}
try {
    session.on("abort", (e) => {
        if (e && e.agentId) return;                       // ignora subagentes
        const reason = (e && e.data && e.data.reason) || "-";
        dtrace(`ABORT reason=${reason} — poll HARDENED de release (isProcessing c/ timeout; assistant.idle já=?)`);
        pollProcessingAfterAbort();
    });
    session.on("assistant.turn_start", (e) => { if (e && e.agentId) return; dtrace(`turn_start turnId=${(e && e.data && e.data.turnId) ?? "?"}`); });
    session.on("assistant.turn_end", (e) => { if (e && e.agentId) return; dtrace(`turn_end turnId=${(e && e.data && e.data.turnId) ?? "?"}`); });
    session.on("assistant.idle", (e) => { if (e && e.agentId) return; dtrace(`assistant.idle`); });
    session.on("user.message", (e) => { if (!stopDiagOn()) return; const d = (e && e.data) || {}; dtrace(`user.message delivery=${d.delivery || "-"} id=${d.id || "-"}`); });
} catch (err) { dbg(`stop-diag listeners falharam: ${err && err.message}`); }
// Rastreia um ask_user ABERTO (evento do SDK) p/ rotear a fala como RESPOSTA daquela pergunta em vez de
// um send novo (que ficaria preso na fila ATRÁS do pedido pendente). Guarda só o requestId; a resposta é
// SEMPRE freeform (decisão do dono: todo ask_user abre campo livre, injetamos nele). completed limpa.
session.on("user_input.requested", (e) => {
    const rid = e && e.data && e.data.requestId;
    if (rid) { pendingUserInputId = rid; dbg(`ask_user aberto: requestId=${rid}`); }
});
session.on("user_input.completed", (e) => {
    const rid = e && e.data && e.data.requestId;
    if (rid && pendingUserInputId === rid) { pendingUserInputId = null; dbg(`ask_user resolvido: requestId=${rid}`); }
});
restoreVoiceState();
restoreAudioHistory();
// BOOT reconcile do update: se a versão em execução já alcançou/passou o pendingVersion, limpa-o
// (senão o guard de canvas leria "restart pendente" pra sempre e a UI re-ofereceria "Ativar" à toa).
// Prova de sucesso do self-reload: o processo NOVO boota com CURRENT_VERSION novo -> aqui reconcilia.
try { const _us = readUpdateState(); if (_us && _us.pendingVersion && !verGt(String(_us.pendingVersion), CURRENT_VERSION)) { delete _us.pendingVersion; writeUpdateState(_us); dbg("boot: pendingVersion <= CURRENT_VERSION -> limpo (self-reload/restart concluído)"); } } catch { }
startHeartbeat();
writeForkHeartbeat("ready");   // canvas registrado (joinSession OK) -> marca esta fork viva p/ o Stop hook
const _forkHb = setInterval(() => writeForkHeartbeat("ready"), 5000);
if (_forkHb.unref) _forkHb.unref();
// Sweep que drena a fila-em-arquivo do Stop hook (pending/<sid>.jsonl) a cada 2s: sem ele o resumo 🔊
// escrito no disco pelo hook ficaria sem tocar quando nenhum outro gatilho (hello/foco) dispara no turno.
const _speakSweep = setInterval(() => { drainPendingSpeak(mySid()).catch(() => { }); }, 2000);
if (_speakSweep.unref) _speakSweep.unref();
const _sidPrune = setInterval(() => { pruneForkHeartbeats(); }, 300000);   // 5min: poda heartbeats velhos

// Auto-check PERIÓDICO (só DETECÇÃO): o PRIMÁRIO verifica a versão remota SEM baixar/aplicar
// (detectOnly) — se houver nova, o broadcast {available} faz o selo aparecer. APLICAR continua SÓ no
// clique. Completion-driven (reagenda após terminar), unref (não segura o processo), jitter
// (dessincroniza sessões). Default 4h, tunável por VOICE_AUTO_CHECK_MS.
const AUTO_CHECK_MS = Number(process.env.VOICE_AUTO_CHECK_MS) || 4 * 60 * 60 * 1000;
let _autoCheckT = null;
function scheduleAutoCheck() {
    const delay = AUTO_CHECK_MS + Math.floor(Math.random() * 5 * 60 * 1000);   // +0..5min jitter
    _autoCheckT = setTimeout(async () => {
        try { await checkForUpdate({ detectOnly: true }); } catch { }
        scheduleAutoCheck();
    }, delay);
    if (_autoCheckT && _autoCheckT.unref) _autoCheckT.unref();
}
scheduleAutoCheck();
if (_sidPrune.unref) _sidPrune.unref();
log("voice-chat extension loaded", "info");

function _hbWrite(s) {
    try {
        appendFileSync(DEBUG_LOG, s);
    } catch {
    }
}
process.on("uncaughtException", (e) => {
    _hbWrite(`[${new Date().toISOString()}] [FATAL] uncaughtException phase=${_phase}: ${(e && e.stack) || e}\n`);
});
process.on("unhandledRejection", (e) => {
    _hbWrite(`[${new Date().toISOString()}] [FATAL] unhandledRejection phase=${_phase}: ${(e && e.stack) || e}\n`);
});
["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"].forEach((sig) => {
    try {
        process.on(sig, () => {
            _hbWrite(`[${new Date().toISOString()}] [SIGNAL] ${sig} received phase=${_phase} pendingTurn=${pendingVoiceTurn}\n`);
            process.exit(0);
        });
    } catch {
    }
});
