
import { createServer, request as httpRequest, get as httpGet, Agent as HttpAgent } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync, copyFileSync, linkSync, readdirSync, watch } from "node:fs";
import { setPriority, constants as osConstants } from "node:os";
import { randomBytes } from "node:crypto";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import shared from "./voice-shared.cjs";
import { dbg, mkdirp, readJson, writeJsonAtomic } from "./voice-core.mjs";
import { buildPythonCandidates, savePythonPath } from "./voice-python.mjs";
import { cleanForSpeech, makeSpoken } from "./voice-text.mjs";
import {
    verGt, shouldStepDownForNewer, sha256Hex, verifyManifestSig, updateVersionAcceptable,
    fetchBuf, pickPluginVersion, releaseAssetBase, computeLogicSha, classifyStagedUpdate,
    RUNNING_EXT_LOGIC_SHA, PLUGIN_NAME,
} from "./voice-update.mjs";
import {
    sseClients, servers, forkVersions, forks, forkSeen,
    spokenCheckpoints, pendingTts, recentSpoken,
    audioHistoryBySid, audioSeqBySid, audioTurnBySid, audioDeliveredBySid, audioHeardBySid,
    pendingTurnsBySid, drainingTurns, injectedTurnIds, injectedTurnOrder, injectingIds,
    pendingTranscribe,
    primaryFork, setPrimaryFork, activeSid, setActiveSid, myBaseUrl, setMyBaseUrl,
    registered, setRegistered, sessionDead, setSessionDead, ownSid, setOwnSid,
    turnOwnerSid, setTurnOwnerSid, monitorSid, setMonitorSid,
} from "./voice-state.mjs";
import {
    appendAudioItem, pushAudio, playOrQueueAudio, audioHistoryForHello, markPlayed,
    readAudioStateMap, persistAudioState, restoreAudioHistory, reloadAudioStateFromDisk,
} from "./voice-audio.mjs";
import {
    readPendingTurnsMap, persistPendingTurns, restorePendingTurns, enqueueTurn, pruneExpiredTurns,
    drainTurnsToFork, drainAllPendingTurns, selfDeliverOwnTurns, seenInjectedId, rememberInjectedId, injectTurn,
} from "./voice-turns.mjs";
import {
    ensureWorker, workerSend, restartWorker, manualRestartWorker, synthesize, transcribeViaWorker,
    shutdownWorkerForHandover, workerReady, lastDevice, lastVoices,
} from "./voice-worker.mjs";
import {
    mySid, canonicalBase, withSid, broadcast, broadcastTo, startHeartbeat, forwardToPrimary, readSavedPort, startServer, httpPostJson, pruneDeadSids,
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

export const CURRENT_VERSION = "1.5.27";
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
const UPDATABLE_FILES = new Set(["extension.mjs", "voice-shared.cjs", "voice-core.mjs", "voice-python.mjs", "voice-update.mjs", "voice-text.mjs", "voice-state.mjs", "voice-audio.mjs", "voice-turns.mjs", "voice-worker.mjs", "voice-net.mjs", "voice_worker.py", "vox_sdk.py", "vox_stream.py", "vox_audio_devices.py", "vox_capture.py", "_ed25519_ref.py", "iframe.html", "requirements.txt", "hooks.json", "voice-summary-stop.cjs", "voice-canvas-guard.cjs"]);

// Python interpreters are discovered dynamically (see buildPythonCandidates).

export const CONVERSE_ONSET_MS = Number(process.env.VOICE_CONVERSE_ONSET_MS) || 20000;

export let session; 

export let primaryServerEntry = null;
export function setPrimaryServerEntry(v) { primaryServerEntry = v; }
// Handover automático consciente de versão: um primário de código VELHO cede a porta+worker
// para uma fork MAIS NOVA — ativa um update do extension.mjs SEM fechar o app / matar processo.
export let handingOver = false;             // step-down de versão em andamento (throttle + guarda anti-respawn do worker)
export function setHandingOver(v) { handingOver = v; }
export const HANDOVER_GRACE_MS = 8000;
// ANTI-FLAP GLOBAL: durante um handover, QUALQUER fork (inclusive um secundário velho bystander que
// não cedeu) deve suspender o reclaim na janela — senão ele fisga a porta recém-liberada e vira um
// primário VELHO espúrio. suppressReclaimUntil é por-fork; este arquivo compartilha a janela.




export const FORK_TTL_MS = 600000;   // 10min sem re-registro => sid morto (uma fork viva re-registra a cada 4s; uma morta/sessionDead para). NUNCA remove a própria (mySid).

export let lastTtsPreviewSid = null;
export function setLastTtsPreviewSid(v) { lastTtsPreviewSid = v; }
export let recordingActiveSid = null; 
let recordingActiveTimer = null; 



const DEFAULT_SETTINGS = {
    voice: "Microsoft Maria Desktop",
    rate: 0,
    language: "pt",
    fullRead: false,
    ttsVoice: "",
    ttsSid: 0,
    authorSummary: true,
    confirmTranscript: false,
    cueStart: true,
    cueCheckpoints: true,
    wakeWord: false,
    wakePhrase: "escuta jarvis",
    handsfree: false,
    interruptMode: false,
    micDevice: null,
};
export let settings = { ...DEFAULT_SETTINGS };
export function setSettings(v) { settings = v; }

// Modelo por TOOL (v1.5.16+): o agente usa a tool `falar` para produzir áudio QUANDO quiser (inclusive
// antes de uma pergunta, várias vezes por turno). O Stop hook exige >=1 chamada de `falar` por turno.
const VOICE_TOOL_INSTRUCTION =
    "A mensagem anterior do usuário foi capturada por VOZ. Para tudo que o usuário deve OUVIR, use a " +
    "ferramenta (tool) `falar`, passando um texto natural em português do Brasil (1 a 3 frases curtas, " +
    "sem markdown, sem listas, sem código e sem emojis). Você DEVE chamar `falar` ao menos uma vez neste " +
    "turno com um resumo do essencial da sua resposta, e PODE chamá-la quantas vezes quiser — inclusive " +
    "ANTES de fazer uma pergunta, para que o áudio saia na hora certa. Não escreva a linha 🔊 no chat; " +
    "quem fala é a tool `falar`.";

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
}

export async function saveSettings() {
    try {
        await mkdir(ARTIFACTS, { recursive: true });
        await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
    } catch (e) {
        log("save settings failed: " + e.message);
    }
}

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
    // usar o cache aqui persistiria marcadores stale de OUTROS forks (lost-update cross-fork).
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
    if (typeof b.fullRead === "boolean") out.fullRead = b.fullRead;
    if (typeof b.authorSummary === "boolean") out.authorSummary = b.authorSummary;
    if (typeof b.confirmTranscript === "boolean") out.confirmTranscript = b.confirmTranscript;
    if (typeof b.cueStart === "boolean") out.cueStart = b.cueStart;
    if (typeof b.cueCheckpoints === "boolean") out.cueCheckpoints = b.cueCheckpoints;
    if (typeof b.wakeWord === "boolean") out.wakeWord = b.wakeWord;
    if (typeof b.wakePhrase === "string" && b.wakePhrase.trim())
        out.wakePhrase = b.wakePhrase.trim().slice(0, 60);
    if (typeof b.handsfree === "boolean") out.handsfree = b.handsfree;
    if (typeof b.interruptMode === "boolean") out.interruptMode = b.interruptMode;
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

export async function checkForUpdate(opts = {}) {
    const force = opts.force === true;
    if (UPDATE_DISABLED || !primaryFork) return { status: "disabled" };
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
            if (!rel || rel.includes("/") || rel.includes("\\") || rel.includes("..") || !UPDATABLE_FILES.has(rel)) {
                dbg("update: skipping unsafe/unlisted file " + rel);
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

export function dispatchVoiceTurn(text, sidArg) {
    const t = (text || "").trim();
    if (!t) return;
    tmark("dispatch");
    const want = sidArg || activeSid;
    // Run locally ONLY when the turn truly belongs to THIS fork's own session.
    // For any other explicit owner sid we MUST inject into that fork — never fall
    // back to mySid(), which is exactly what leaked a recording into the primary's
    // (last-active) session.
    if (!want || want === mySid()) {
        handleVoiceTranscript(t);
        return;
    }
    deliverTurnToFork(want, t);
}

function deliverTurnToFork(sid, text) {
    // The transcript must run session.send() INSIDE the owner session's fork
    // process. Pushing over HTTP can miss transiently (owner panel closed -> its
    // server is down but its heartbeat still advertises the port; or the fork has
    // not re-registered yet). So the turn is HELD in a persisted per-sid FIFO and
    // delivered the moment the owner is provably reachable (on (re-)register with a
    // fresh live URL, on focus, or via the safety sweep). It is never dropped on
    // the first miss — dropping is what lost the user's spoken prompt and surfaced
    // the old push-failure banner.
    if (!sid) return;
    enqueueTurn(sid, text);
    drainTurnsToFork(sid);
}

function notifyCanvas(obj) {
    if (primaryFork) {
        broadcastTo(mySid(), obj);
        return;
    }
    const base = canonicalBase();
    if (base) httpPostJson(base, "/relay", { sid: mySid(), event: obj });
}

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

const DEAD_NOTICE_THROTTLE_MS = 15000;
let _deadNoticeAt = 0;
function notifySessionDead() {
    // Avisa o usuário que a sessão morreu ("reabra o painel"), mas THROTTLED: o mesmo turno
    // retido é re-tentado pelo sweep a cada 5s contra a fork morta; sem throttle isso viraria
    // ~1 toast por sweep (spam). 1 aviso a cada 15s basta — o usuário sabe e a ação é clara.
    const now = Date.now();
    if (now - _deadNoticeAt < DEAD_NOTICE_THROTTLE_MS) return;
    _deadNoticeAt = now;
    notifyCanvas({ type: "error", msg: "Esta sessão foi recarregada. Reabra o painel Voz nesta sessão para voltar a falar por voz." });
}

function markSessionDead(e) {
    if (sessionDead) return;
    setSessionDead(true);
    log("session handle morto (não recuperável): " + (e && e.message ? e.message : e));
    // Para de se anunciar ao primary: a fork VIVA desta sessão (o painel real) reassume
    // o roteamento no próximo registro (≤4s). Uma mensagem clara só aparece se esta fork
    // ainda tiver um painel visível (o zumbi normalmente não tem, então não gera spam).
    notifySessionDead();
}

const SEND_DEAD_RETRIES = 3;        // re-tentativas de session.send diante de "Session not found" TRANSITÓRIO (ex.: logo após um Stop que só aborta o turno)
const SEND_RETRY_BASE_MS = 400;

// Só "mata" a fork (para de se registrar p/ a fork VIVA assumir o roteamento — comportamento v1.5.3)
// quando NÃO há painel aberto aqui, i.e., é uma fork ZUMBI. Uma fork com o painel ABERTO (o caso do
// usuário: um painel só) NUNCA vira zumbi por um erro de sessão: a sessão pode voltar, então re-tenta
// no próximo turno em vez de bricar a voz até reabrir.
function shouldLatchDeadFork(hasOpenPanel) {
    return !hasOpenPanel;
}
function hasOpenPanelHere() {
    return sessionHasClient(mySid());
}

export async function handleVoiceTranscript(text) {
    tmark("handle");
    // Uma fork ZUMBI com a sessão MORTA não pode cumprir o turno: reporta falha (o primary re-rota
    // para uma fork VIVA). Uma fork com painel aberto nunca fica nesse estado (ver abaixo).
    if (sessionDead) {
        notifySessionDead();
        return false;
    }
    // ROTEAMENTO 1 — ask_user ABERTO: responde a PERGUNTA (freeform) em vez de um send novo. Sem isto, o
    // send ficaria preso na fila ATRÁS do pedido pendente e a fala "sumia" (o chat funciona porque digitar
    // com pergunta aberta responde o campo). Se a resposta falhar (já resolvida por outro cliente), cai pro
    // send normal abaixo. Não dispara o setup de turno de voz (cues) — é uma resposta, não um turno novo.
    if (pendingUserInputId && session.rpc && session.rpc.ui && session.rpc.ui.handlePendingUserInput) {
        const rid = pendingUserInputId;
        try {
            // SDK: UIHandlePendingResult = { success: boolean }. success=false quando o requestId é
            // desconhecido/expirado/JÁ resolvido por outro cliente (ex.: GitHub) -> NÃO respondemos;
            // caímos pro send normal abaixo (não descarta a fala). (verificado em rpc.d.ts UIHandlePendingResult)
            const r = await session.rpc.ui.handlePendingUserInput({ requestId: rid, response: { answer: text, wasFreeform: true } });
            if (r && r.success) {
                if (pendingUserInputId === rid) pendingUserInputId = null;   // não limpa um pedido NOVO aberto durante o await
                dbg(`ask_user respondido por voz (freeform): requestId=${rid}`);
                return true;
            }
            dbg(`handlePendingUserInput success=false (rid=${rid}); caindo pro send normal`);
        } catch (e) {
            dbg(`handlePendingUserInput falhou (rid=${rid}): ${e && e.message}; caindo pro send normal`);
        }
        if (pendingUserInputId === rid) pendingUserInputId = null;   // este pedido não resolveu -> segue como send (sem re-tentar o mesmo)
    }
    pendingVoiceTurn = true;
    _phase = "voiceTurn:start";
    voiceInstructionPending =
        settings.authorSummary !== false || settings.cueCheckpoints !== false;
    spokenCheckpoints.clear();
    saveVoiceState();
    markTurn(mySid());
    notifyCanvas({ type: "status", state: "thinking" });
    armIdleFallback();
    dbg(`handleVoiceTranscript: sending prompt (${text.length} chars): ${text.slice(0, 120)}`);
    if (timingOn()) { const processing = await probeProcessing(); tmark("send_call", { processing }); }
    let lastErr = null;
    for (let attempt = 1; attempt <= SEND_DEAD_RETRIES; attempt++) {
        try {
            // ROTEAMENTO 2 — modo de entrega escolhido pelo usuário (chip "Interromper"): "immediate"
            // INTERROMPE o turno em andamento do agente; "enqueue" (padrão) espera o turno atual acabar.
            const mode = settings.interruptMode ? "immediate" : "enqueue";
            const messageId = await session.send({ prompt: text, mode });
            _phase = "voiceTurn:sent";
            tmark("send_done"); tflush("voiceTurn");
            if (timingOn()) _lastVoiceSendAt = Date.now();
            // Cue "Ok, comecei" SÓ depois do send ACEITO (numa fork zumbi o send lança antes → sem cue
            // dobrado no failover; também é mais honesto).
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
                notifyCanvas({ type: "error", msg: "Falha ao enviar para o Copilot: " + e.message });
                pendingVoiceTurn = false;
                return false;
            }
            // "Session not found" pode ser TRANSITÓRIO: o Stop aborta o turno e o backend reassenta a
            // sessão em ~1s. Re-tenta no MESMO handle — re-join do SDK NÃO é seguro (um 2º leitor no
            // process.stdin corromperia o IPC).
            dbg(`session.send dead-session (tentativa ${attempt}/${SEND_DEAD_RETRIES}): ${e && e.message}`);
            if (attempt < SEND_DEAD_RETRIES) {
                await new Promise((r) => setTimeout(r, SEND_RETRY_BASE_MS * attempt));
            }
        }
    }
    log("session.send falhou (sessão morta, " + SEND_DEAD_RETRIES + " tentativas): " + (lastErr && lastErr.message ? lastErr.message : lastErr));
    pendingVoiceTurn = false;
    if (shouldLatchDeadFork(hasOpenPanelHere())) {
        // Fork ZUMBI (sem painel): mata p/ a fork VIVA desta sessão reassumir o roteamento (v1.5.3).
        markSessionDead(lastErr);
    } else {
        // Painel ABERTO aqui: NÃO vira zumbi (não brica a voz). Avisa (throttled) e segue registrando;
        // o próximo turno re-tenta e recupera quando a sessão voltar.
        notifySessionDead();
    }
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
    if (primaryFork) drainPendingSpeak(mySid()).catch(() => { });
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

// ---- heartbeat de vida do fork por sessão (para o Stop hook detectar canvas CAÍDO) -------------
// O canvas é registrado pelo joinSession DESTA fork e MORRE com o processo. Então
// "canvas registrado <=> processo do fork vivo". Cada fork grava forks/<sid>.json={pid,ts} e o
// atualiza a cada 5s (NÃO remove no SIGTERM — de propósito: um PID morto no arquivo é a impressão
// digital DETERMINÍSTICA do canvas caído). O Stop hook lê isso e, se o PID estiver morto, avisa o
// agente a rodar extensions_reload (caminho A->B->C: hook detecta -> avisa -> agente recarrega).
const FORKS_DIR = shared.forksDir(ARTIFACTS);
function forkHeartbeatFile(sid) {
    return shared.forkHeartbeatFile(ARTIFACTS, sid);
}
function writeForkHeartbeat() {
    const sid = ownSid || mySid();
    if (!sid) return;
    // Só marca "vivo" se o handle do joinSession NÃO está morto. Assim o heartbeat NÃO mente:
    // um fork que descobriu que o handle caiu (markSessionDead, via send) para de atualizar o ts
    // -> ele envelhece -> o Stop hook detecta e avisa o reload. (Determinístico p/ processo MORTO;
    // best-effort p/ handle-morto-sem-exit, que só é conhecido quando a fork tenta usar o handle.)
    if (sessionDead) return;
    try { mkdirSync(FORKS_DIR, { recursive: true }); writeFileSync(forkHeartbeatFile(sid), JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* best-effort */ }
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
    if (!sid || !primaryFork) return;   // só o primário sintetiza/enfileira/toca
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
    if (!primaryFork) return;
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
    return !sid || !activeSid || sid === activeSid;
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
    if (primaryFork) return speakToCanvas(sid, spoken, full, cue);
    return forwardToPrimary("/speak", { sid, spoken, full, cue });
}

// Helpers de modelagem de texto p/ fala (cleanForSpeech/firstSentences/extractAuthoredSummary/
// stripCheckpointLines/makeSpoken): puros, em voice-text.mjs.



// Keep-alive só p/ loopback (forks na mesma máquina): reusa o socket entre POSTs
// (register a cada 4s + inject/speak/focus/relay) em vez de abrir um socket novo por
// chamada. Sem TLS, mesmo host -> ganho de handshake/FD sem custo de segurança.




// Timers de secundário (re-registro a cada 4s + probe do primário). Idempotente: chamado no
// cold-start (startServer) E quando um primário cede e volta a ser secundário (step-down).

// Ao PROMOVER um secundário a primário, os timers de secundário (re-registro/probe) precisam PARAR:
// senão um re-registro atrasado anuncia uma URL errada, e o step-down futuro tem um timer fantasma
// anunciando a canônica na janela (o vazamento cross-sessão que o gate pegou).


// Cede o microfone ÚNICO: encerra o worker SEM respawn (a fork nova abre o dela). O guard
// `handingOver` no exit handler impede o respawn de crash.

// Este primário roda código VELHO e uma fork MAIS NOVA apareceu: cede a ela de forma limpa —
// solta o worker, libera a porta canônica e cutuca a nova p/ reassumir JÁ. Vira secundário.
// suppressReclaimUntil impede reassumir a porta de volta na janela (anti-flap). É o que ativa
// um update do extension.mjs sem o usuário fechar o app.


// Reassume o primário com re-tentativas (o antigo pode levar um instante p/ liberar a porta).
// `force` no reclaim pula o throttle de 2s (é um pedido EXPLÍCITO de handover, não um probe).







export function claimVoiceOwnership(sid) {
    if (!sid) return;
    const s = String(sid);
    setActiveSid(s);
    setTurnOwnerSid(s);
}

export function setRecordingActive(sid) {
    recordingActiveSid = sid;
    if (recordingActiveTimer) clearTimeout(recordingActiveTimer);
    recordingActiveTimer = setTimeout(() => { recordingActiveSid = null; recordingActiveTimer = null; }, 60000);
    if (recordingActiveTimer.unref) recordingActiveTimer.unref();
}

export function clearRecordingActive() {
    recordingActiveSid = null;
    if (recordingActiveTimer) { clearTimeout(recordingActiveTimer); recordingActiveTimer = null; }
}

function hasVisibleVoiceClients(exceptSid = "") {
    for (const sid of sseClients.values()) {
        if (!exceptSid || sid !== exceptSid) return true;
    }
    return false;
}

export function startMonitor(sid) {
    if (!primaryFork || !sid) return;
    setMonitorSid(sid);
    ensureWorker();
    try { workerSend({ cmd: "monitor", on: true }); } catch { }
}

export function stopMonitor(sid) {
    if (!primaryFork) return;
    if (sid && monitorSid !== sid) return;
    setMonitorSid(null);
    try { workerSend({ cmd: "monitor", on: false }); } catch { }
}

export function quiesceClosedPanelCapture(sid, opts = {}) {
    if (!primaryFork) return;
    const cancelRecording = opts.cancelRecording !== false;
    if (cancelRecording && recordingActiveSid && (!sid || recordingActiveSid === sid)) {
        try { workerSend({ cmd: "cancel" }); } catch { }
        clearRecordingActive();
    }
    if (turnOwnerSid === sid) setTurnOwnerSid(null);
    if (monitorSid === sid) stopMonitor(sid);
    if (settings.wakeWord && !hasVisibleVoiceClients(sid)) {
        try { workerSend({ cmd: "wake", on: false }); } catch { }
    }
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
                const speakText = settings.fullRead ? full : spoken || text;
                const fullForUi = full && full !== speakText ? full : undefined;
                await routeSpeak({ spoken: speakText, full: fullForUi });
                return { ok: true, spoken: speakText };
            },
        },
        {
            name: "status",
            description: "Retorna o estado do motor de voz (pronto, modelo atual e configurações).",
            handler: async () => ({
                workerReady,
                settings,
                openPanels: servers.size,
                sseConnected: sseClients.size,
                recordingSupported: true,
                primaryFork,
                mySid: mySid(),
                activeSid,
                forks: [...forks.keys()],
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
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = (primaryFork && primaryServerEntry) ? primaryServerEntry : await startServer();
            if (entry.primary) setPrimaryServerEntry(entry);
            servers.set(ctx.instanceId, entry);
        }
        if (entry.primary) {
            ensureWorker();
            checkForUpdate().catch(() => {});
            return {
                title: "Voz",
                url: withSid(entry.url, panelSid),
                status: workerReady ? "Pronto" : "Iniciando…",
            };
        }
        const canonical = readSavedPort();
        const url = withSid(canonical ? `http://127.0.0.1:${canonical}/` : entry.url, panelSid);
        return { title: "Voz", url, status: "Pronto" };
    },
    onClose: async (ctx) => {
        const sid = String((ctx && ctx.sessionId) || mySid());
        if (primaryFork) quiesceClosedPanelCapture(sid);
        else forwardToPrimary("/quiesce", { sid });
        const entry = servers.get(ctx.instanceId);
        if (!entry) return;
        servers.delete(ctx.instanceId);
        if (entry.primary) return;
        await new Promise((r) => entry.server.close(() => r()));
    },
});

await loadSettings();

// Tool `falar` (v1.5.16): o agente produz áudio QUANDO quiser (não só no fim). Handler recebe o
// texto + invocation.sessionId (sid CONFIÁVEL). Motor ON -> speakToCanvas (toca/enfileira durável);
// motor OFF -> writePendingSpeak (fila de texto, drenada quando o motor ligar). Retorna tool_result.
const FALAR_STEER = " · [Entregue como ÁUDIO ao usuário — NÃO reescreva em texto o que acabou de falar; encerre o turno com texto mínimo (ou nenhum). Para seguir agindo, faça outras tool calls direto.]";
const falarTool = {
    name: "falar",
    description:
        "Fala em voz alta para o usuário no painel de Voz (pt-BR). Passe um texto natural, curto (1 a 3 " +
        "frases), sem markdown, sem código e sem emojis. Use SEMPRE que quiser que algo seja OUVIDO — " +
        "inclusive ANTES de fazer uma pergunta e várias vezes por turno. O áudio sai na hora (ou entra na " +
        "fila e toca quando o painel/motor de voz ligar). IMPORTANTE: o que você falar aqui JÁ chega ao " +
        "usuário como áudio — NÃO reescreva a mesma coisa em texto depois; encerre o turno com texto mínimo " +
        "(ou nenhum). Para continuar agindo, faça outras tool calls direto.",
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
        if (primaryFork) {
            if (!workerReady) { writePendingSpeak(sid, text); ensureWorker(); return "🔊 Enfileirado para falar quando o motor de voz ligar: " + text.slice(0, 90) + FALAR_STEER; }
            let ok = false;
            try { ok = await speakToCanvas(sid, text); } catch { ok = false; }
            if (ok) return "🔊 Falado: " + text.slice(0, 120) + FALAR_STEER;
            // synth falhou agora: re-enfileira (o drain re-tenta quando o motor voltar) e reporta HONESTO.
            writePendingSpeak(sid, text); ensureWorker();
            return "🔊 Enfileirado (falha ao sintetizar agora, re-tenta quando o motor voltar): " + text.slice(0, 90) + FALAR_STEER;
        }
        // secundário: encaminha ao primário; se não houver primário no ar, enfileira em arquivo.
        let ok = false;
        try { ok = await forwardToPrimary("/speak", { sid, spoken: text }); } catch { ok = false; }
        if (ok) return "🔊 Falado: " + text.slice(0, 120) + FALAR_STEER;
        writePendingSpeak(sid, text);
        return "🔊 Enfileirado para falar quando o motor de voz ligar: " + text.slice(0, 90) + FALAR_STEER;
    },
};

session = await joinSession({
    canvases: [canvas],
    tools: [falarTool],
    hooks: {
        onUserPromptSubmitted: async () => {
            if (!voiceInstructionPending) return undefined;
            voiceInstructionPending = false;
            let ctx = "";
            if (settings.authorSummary !== false) ctx += VOICE_TOOL_INSTRUCTION;
            if (settings.cueCheckpoints !== false) ctx += (ctx ? " " : "") + CHECKPOINT_INSTRUCTION;
            return ctx ? { additionalContext: ctx } : undefined;
        },
    },
});
session.on("assistant.message", onAssistantMessage);
session.on("session.idle", onIdle);
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
restorePendingTurns();
startHeartbeat();
writeForkHeartbeat();   // canvas registrado (joinSession OK) -> marca esta fork viva p/ o Stop hook
const _forkHb = setInterval(writeForkHeartbeat, 5000);
if (_forkHb.unref) _forkHb.unref();
const _turnSweep = setInterval(() => {
    drainAllPendingTurns();                          // primário: empurra p/ forks com painel ABERTO (HTTP, caminho rápido)
    selfDeliverOwnTurns(mySid()).catch(() => { });   // ESTE fork: entrega os PRÓPRIOS turnos IN-PROCESS (determinístico,
                                                     // funciona em BACKGROUND/sem painel — o furo do "espera eu voltar")
}, 5000);
if (_turnSweep.unref) _turnSweep.unref();
// Trigger EVENT-DRIVEN (quase instantâneo): assim que o primário GRAVA um turno na fila em disco, o fork
// DONO drena o próprio IN-PROCESS na hora (~ms) — sem esperar o sweep de 5s, que fica só como REDE DE
// SEGURANÇA (fs.watch pode perder evento). Debounce curto absorve os múltiplos eventos de uma escrita.
let _turnWatchT = null;
try {
    // Observa o dir ONDE o voice-turns realmente grava a fila (shared.resolveDataDir()), não ARTIFACTS —
    // que pode divergir no fallback legacy (achado do review). unref + listener de 'error' p/ um dir
    // removido/renomeado degradar pro sweep de 5s sem virar uncaughtException.
    const _turnWatcher = watch(shared.resolveDataDir(), (_evt, fname) => {
        if (String(fname || "") !== "pending-turns.json") return;
        clearTimeout(_turnWatchT);
        _turnWatchT = setTimeout(() => { selfDeliverOwnTurns(mySid()).catch(() => { }); }, 40);
    });
    _turnWatcher.on("error", () => { /* dir sumiu/renomeou -> só perde o fast-path; o sweep de 5s cobre */ });
    if (_turnWatcher.unref) _turnWatcher.unref();
} catch { /* fs.watch indisponível nesta plataforma -> o sweep de 5s cobre */ }
// Sweep do PRIMÁRIO que drena a fila-em-arquivo do Stop hook (pending/<sid>.jsonl) a cada 2s: com
// o painel ABERTO e o primário estável, nenhum hello/promoção dispara por turno, então SEM este
// sweep o resumo 🔊 ficaria no disco sem tocar. drainAllPendingSpeak é no-op fora do primário.
const _speakSweep = setInterval(() => { drainAllPendingSpeak().catch(() => { }); }, 2000);
if (_speakSweep.unref) _speakSweep.unref();
const _sidPrune = setInterval(() => { pruneDeadSids(); pruneForkHeartbeats(); }, 300000);   // 5min: poda sids mortos + heartbeats velhos
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
