
import { createServer, request as httpRequest, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, sep } from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync, copyFileSync, linkSync, readdirSync } from "node:fs";
import { setPriority, constants as osConstants, homedir } from "node:os";
import { randomBytes, createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_ARTIFACTS = join(EXT_DIR, "artifacts");

function resolveDataDir() {
    if (process.env.VOICE_DATA_DIR) return process.env.VOICE_DATA_DIR;
    const marker = sep + ".copilot" + sep;
    const i = EXT_DIR.indexOf(marker);
    const home = i >= 0 ? EXT_DIR.slice(0, i + marker.length - 1) : join(homedir(), ".copilot");
    return join(home, "voice-chat-data");
}

let ARTIFACTS = resolveDataDir();
try {
    if (ARTIFACTS !== LEGACY_ARTIFACTS && existsSync(LEGACY_ARTIFACTS) && !existsSync(ARTIFACTS)) {
        mkdirSync(dirname(ARTIFACTS), { recursive: true });
        renameSync(LEGACY_ARTIFACTS, ARTIFACTS);
    }
} catch {
    ARTIFACTS = LEGACY_ARTIFACTS;
}
const MODELS_DIR = join(ARTIFACTS, "models");
const TTS_DIR = join(ARTIFACTS, "tts");
const SETTINGS_FILE = join(ARTIFACTS, "settings.json");
const IFRAME_FILE = join(EXT_DIR, "iframe.html");
const WORKER_FILE = join(EXT_DIR, "voice_worker.py");
const DEBUG_LOG = join(ARTIFACTS, "debug.log");
const VOICE_STATE_FILE = join(ARTIFACTS, "voice-state.json");
const PORT_FILE = join(ARTIFACTS, "server-port.json");

const CURRENT_VERSION = "1.5.1";
// Single release hub: the PUBLIC marketplace repo carries per-plugin tagged
// releases (voice-chat-v<version>), exactly like copilot-mobile. The auto-updater
// reads the published version from the marketplace manifest, then pulls the tagged
// assets from the same repo. The source repo (copilot-voice) can stay private —
// nothing is fetched from it, so no unauthenticated 404.
const MARKETPLACE_MANIFEST_URL = process.env.VOICE_MARKETPLACE_MANIFEST || "https://raw.githubusercontent.com/AllanSantos-DV/copilot-marketplace/main/.github/plugin/marketplace.json";
const PLUGIN_NAME = "voice-chat";
const RUNNING_AS_PLUGIN = /[\\/]installed-plugins[\\/]/.test(EXT_DIR);
const UPDATE_DISABLED = process.env.VOICE_UPDATE_DISABLED === "1" || RUNNING_AS_PLUGIN;
const UPDATE_THROTTLE_MS = Number(process.env.VOICE_UPDATE_THROTTLE_MS) || 0;
const UPDATE_STATE_FILE = join(ARTIFACTS, "update-state.json");
const UPDATABLE_FILES = new Set(["extension.mjs", "voice_worker.py", "vox_sdk.py", "_ed25519_ref.py", "iframe.html", "requirements.txt"]);

// Python interpreters are discovered dynamically (see buildPythonCandidates).

const CONVERSE_ONSET_MS = Number(process.env.VOICE_CONVERSE_ONSET_MS) || 20000;

let session; 

const sseClients = new Map(); 
const servers = new Map(); 
let preferredPort = 0;
let sharedToken = "";
let primaryFork = false;
const DEAD_PRIMARY_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);
let reclaiming = false;
let lastReclaimAttempt = 0;
let promotedServer = null;
let primaryServerEntry = null;

const forks = new Map(); 
let activeSid = null; 
let lastTtsPreviewSid = null;
let turnOwnerSid = null; 
let recordingActiveSid = null; 
let recordingActiveTimer = null; 
let monitorSid = null; 
let myBaseUrl = null; 
let registered = false; 
function mySid() {
    return process.env.SESSION_ID || (session && session.sessionId) || "";
}
function canonicalBase() {
    const p = preferredPort || readSavedPort();
    return p ? `http://127.0.0.1:${p}/` : null;
}
function withSid(u, sid = mySid()) {
    // O token de loopback é entregue à canvas via cookie de mesma origem + injeção no
    // corpo do HTML (ver o handler GET /), nunca na query da URL do painel — assim não
    // vaza por referrer/histórico/log. A página lê o token para o header x-voice-token.
    return u + (u.includes("?") ? "&" : "?") + "sid=" + encodeURIComponent(sid);
}
const DEFAULT_SETTINGS = {
    voice: "Microsoft Maria Desktop",
    rate: 0,
    language: "pt",
    fullRead: false,
    speakAll: false,
    ttsVoice: "",
    ttsSid: 0,
    authorSummary: true,
    confirmTranscript: false,
    cueStart: true,
    cueCheckpoints: true,
    wakeWord: false,
    wakePhrase: "escuta jarvis",
    handsfree: false,
    micDevice: null,
};
let settings = { ...DEFAULT_SETTINGS };

const VOICE_SENTINEL = "🔊";
const VOICE_SUMMARY_INSTRUCTION =
    "A mensagem anterior do usuário foi capturada por VOZ e a sua resposta será lida em voz alta. " +
    "Responda normalmente no chat e, ao FINAL da resposta, acrescente uma última linha começando " +
    'exatamente com "🔊 " seguida de um RESUMO FALADO autoexplicativo da sua própria resposta: ' +
    "de 1 a 3 frases curtas, em português do Brasil, naturais e completas (sem cortar no meio), " +
    "sem markdown, sem listas, sem código e sem outros emojis. Essa linha 🔊 é exatamente o que " +
    "será falado, então escreva-a para ser ouvida com clareza, resumindo o essencial da resposta.";

const CHECKPOINT_SENTINEL = "📍";
const CHECKPOINT_INSTRUCTION =
    "Se ESTE turno envolver uma tarefa LONGA ou COMPLEXA (montar uma feature inteira, um fluxo " +
    "completo, mudanças em vários arquivos, várias etapas), você PODE emitir checkpoints de progresso " +
    'durante o trabalho: escreva, em uma linha separada, algo começando exatamente com "📍 " seguido ' +
    "de UMA frase curta em português do Brasil dizendo o que acabou de fazer ou o próximo passo. " +
    "Emita apenas em marcos relevantes (não a cada passo pequeno) e NUNCA em tarefas curtas. Esses 📍 " +
    "são lidos em voz alta como sinal de direção: mantenha-os curtos, naturais, sem markdown nem código.";

let worker = null;
let workerReady = false;
let workerStarting = false;
let pyIndex = 0;
let pyCandidates = null;   // concrete interpreters for the current start sequence
let pyExhaustCount = 0;    // consecutive full-discovery exhaustions (bounded retry)
let activePy = "";         // interpreter used by the in-flight start (cached on ready)
let crashCount = 0;
const WORKER_STABLE_MS = 30000;
let readyAt = 0;
let workerStartAt = 0;
let lastLoadingMsg = "";
let lastLoadingAt = 0;
let lastLoadingBusy = false;   // a última fase de "loading" é uma operação LONGA e LEGÍTIMA (install/update do motor)? Se sim, o watchdog NÃO reinicia (matar no meio do install corromperia o venv).
let startupWatchdog = null;
let stabilityTimer = null;
let intentionalRestart = false;
let wedgeRestarts = 0;   // auto-reinícios consecutivos de um boot TRAVADO (worker vivo, mudo e que nunca ficou pronto); zerado ao ficar pronto, limitado por WEDGE_MAX_RESTARTS.
let lastDevice = "cpu";
let lastMics = { devices: [], current: null, default: null };
// Catálogo de vozes de TTS: VEM SÓ DO MOTOR (evento worker "voices"). Sem lista local
// de fallback — se o motor não reportar, fica vazio e a UI mostra "indisponível" ALTO.
let lastVoices = { voices: [], default: null };

let pendingVoiceTurn = false;
let voiceInstructionPending = false; 
let spokenCheckpoints = new Set(); 
let latestReply = "";
let lastSpokenContent = "";
let idleFallback = null;
const IDLE_FALLBACK_MS = 15000; 
let ttsSeq = 0;
const pendingTts = new Map(); 
let _phase = "boot"; 

const MAX_LOG_BYTES = 10 * 1024 * 1024; 
let _logStream = null;
let _logDirReady = false;

function _logWrite(line) {
    try {
        if (!_logStream) {
            if (!_logDirReady) {
                mkdirSync(ARTIFACTS, { recursive: true });
                _logDirReady = true;
            }
            try {
                if (existsSync(DEBUG_LOG) && statSync(DEBUG_LOG).size > MAX_LOG_BYTES) {
                    renameSync(DEBUG_LOG, DEBUG_LOG + ".1"); 
                }
            } catch {
            }
            _logStream = createWriteStream(DEBUG_LOG, { flags: "a" });
            _logStream.on("error", () => {
                _logStream = null;
            });
        }
        _logStream.write(line);
    } catch {
        _logStream = null;
    }
}

function dbg(msg) {
    _logWrite(`[${new Date().toISOString()}] ${msg}\n`);
}

function log(msg, level = "debug") {
    dbg(msg);
    try {
        session?.log?.(`[voice-chat] ${msg}`, { level, ephemeral: true });
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

async function saveSettings() {
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
const recentSpoken = new Map();

function readTurns() {
    try { return JSON.parse(readFileSync(VOICE_TURNS_FILE, "utf8")) || {}; } catch { return {}; }
}
function writeTurns(m) {
    try { writeFileSync(VOICE_TURNS_FILE, JSON.stringify(m)); } catch {  }
}
function markTurn(sid) {
    if (!sid) return;
    const m = readTurns();
    m[String(sid)] = Date.now();
    writeTurns(m);
}
function clearTurn(sid) {
    if (!sid) return;
    const m = readTurns();
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
// A 🔊 authored summary is an explicit "speak this aloud" marker. Honor it even
// when no voice turn was started (i.e. a TEXT turn), so an open panel still gets
// the spoken summary. Delivery still respects the per-session audio queue: it
// plays now if the session is active, otherwise it queues until the user returns.
function replyWantsSpeech(content) {
    return settings.authorSummary !== false
        && typeof content === "string"
        && content.includes(VOICE_SENTINEL);
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

function sanitizeSettings(b) {
    const out = {};
    if (typeof b.voice === "string") out.voice = b.voice;
    if (typeof b.ttsVoice === "string" && b.ttsVoice.trim()) out.ttsVoice = b.ttsVoice.trim();
    if (typeof b.rate === "number" && b.rate >= -10 && b.rate <= 10) out.rate = Math.round(b.rate);
    if (typeof b.language === "string" && /^[a-z]{2}$|^auto$/.test(b.language)) out.language = b.language;
    if (typeof b.fullRead === "boolean") out.fullRead = b.fullRead;
    if (typeof b.speakAll === "boolean") out.speakAll = b.speakAll;
    if (typeof b.authorSummary === "boolean") out.authorSummary = b.authorSummary;
    if (typeof b.confirmTranscript === "boolean") out.confirmTranscript = b.confirmTranscript;
    if (typeof b.cueStart === "boolean") out.cueStart = b.cueStart;
    if (typeof b.cueCheckpoints === "boolean") out.cueCheckpoints = b.cueCheckpoints;
    if (typeof b.wakeWord === "boolean") out.wakeWord = b.wakeWord;
    if (typeof b.wakePhrase === "string" && b.wakePhrase.trim())
        out.wakePhrase = b.wakePhrase.trim().slice(0, 60);
    if (typeof b.handsfree === "boolean") out.handsfree = b.handsfree;
    if (b.micDevice === null || typeof b.micDevice === "number") out.micDevice = b.micDevice;
    return out;
}

function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of sseClients.keys()) {
        try {
            res.write(line);
        } catch {
        }
    }
}

function broadcastTo(sid, obj) {
    if (!sid) { dbg("broadcastTo: empty sid, dropping event " + (obj && obj.type)); return; }
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const [res, csid] of sseClients) {
        if (csid !== sid) continue;
        try {
            res.write(line);
        } catch {
        }
    }
}

let heartbeatTimer = null;
function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        for (const res of [...sseClients.keys()]) {
            try { res.write(": ping\n\n"); }
            catch { sseClients.delete(res); }
        }
    }, 15000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function parseVer(v) {
    return String(v || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
}
function verGt(a, b) {
    const A = parseVer(a), B = parseVer(b);
    for (let i = 0; i < 3; i++) {
        if ((A[i] || 0) > (B[i] || 0)) return true;
        if ((A[i] || 0) < (B[i] || 0)) return false;
    }
    return false;
}
function readUpdateState() {
    try {
        return JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8"));
    } catch {
        return {};
    }
}
function writeUpdateState(s) {
    try {
        writeFileSync(UPDATE_STATE_FILE, JSON.stringify(s));
    } catch {
    }
}
function sha256Hex(buf) {
    return createHash("sha256").update(buf).digest("hex");
}
// Chave pública Ed25519 do projeto (pinada). O manifest.json de cada release é
// ASSINADO com a chave PRIVADA (fora do repo; ver gen-manifest.mjs) e verificado
// aqui antes de qualquer arquivo ser staged. Isso fecha o buraco de um proxy que
// reassina o TLS (rede "SSL assinado" / CA hostil no trust store): sem a privada,
// ninguém forja um manifesto — então nem os bytes nem os sha256 podem ser trocados
// por conteúdo malicioso. Rotacionar a chave = nova release com esta constante nova.
const UPDATE_PUBLIC_KEY_B64 = "/PHACLNF4lvlJuSGsa44VGbfu+IbwccWoIvoDUwZmOQ=";
// Prefixo DER SPKI de uma chave Ed25519 (12 bytes) + os 32 bytes crus da pública.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
let _updPubKey = null;
function updatePublicKey() {
    if (_updPubKey) return _updPubKey;
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(UPDATE_PUBLIC_KEY_B64, "base64")]);
    _updPubKey = createPublicKey({ key: der, format: "der", type: "spki" });
    return _updPubKey;
}
// Campos do manifesto assinado com formato ESTRITO — assim a mensagem canônica é
// INJETIVA (nenhum separador `:` ou `\n` pode aparecer DENTRO de um campo), e uma
// assinatura nunca vale para dois (version, files) distintos:
//   path:    basename simples [A-Za-z0-9._-] (casa os UPDATABLE_FILES; sem / \ : \n)
//   sha256:  exatamente 64 hex minúsculos
//   version: dígitos/letras/.+- (sem `\n`)
const MANIFEST_PATH_RE = /^[A-Za-z0-9._-]+$/;
const MANIFEST_SHA256_RE = /^[0-9a-f]{64}$/;
const MANIFEST_VERSION_RE = /^[0-9A-Za-z.+-]+$/;
function manifestFileValid(f) {
    return !!f && typeof f === "object"
        && typeof f.path === "string" && MANIFEST_PATH_RE.test(f.path)
        && typeof f.sha256 === "string" && MANIFEST_SHA256_RE.test(f.sha256);
}
// Mensagem canônica assinada — IDÊNTICA à de gen-manifest.mjs: rótulo + versão +
// "path:sha256" de cada arquivo, ordenado por path (determinístico nos dois lados).
// Só produz bytes sem ambiguidade quando os campos passaram a validação estrita.
function manifestSigMessage(version, files) {
    const parts = (Array.isArray(files) ? files : [])
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((f) => f.path + ":" + f.sha256);
    return Buffer.from("voice-chat-manifest-v1\n" + (version || "") + "\n" + parts.join("\n"), "utf8");
}
// Verdadeiro só se o manifesto é Ed25519-assinado, a assinatura confere com a chave
// pinada, a versão é bem-formada, E todo arquivo traz path seguro + sha256 hex de 64
// (a assinatura cobre path E hash, sem ambiguidade de encoding). Nunca lança.
function verifyManifestSig(manifest) {
    try {
        if (!manifest || manifest.sigAlg !== "ed25519" || typeof manifest.sig !== "string") return false;
        if (typeof manifest.version !== "string" || !MANIFEST_VERSION_RE.test(manifest.version)) return false;
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        if (!files.length || !files.every(manifestFileValid)) return false;
        const msg = manifestSigMessage(manifest.version, files);
        return edVerify(null, msg, updatePublicKey(), Buffer.from(manifest.sig, "base64"));
    } catch (e) {
        dbg("verifyManifestSig error: " + (e && e.message));
        return false;
    }
}
// Anti-rollback: a versão ASSINADA precisa ser exatamente a anunciada no marketplace
// E estritamente maior que a instalada. Sem isto, um MITM anuncia uma versão alta (o
// marketplace.json NÃO é assinado) e devolve um manifesto ANTIGO genuinamente
// assinado → downgrade forçado para uma release vulnerável. `verGt` já é estrito.
function updateVersionAcceptable(signedVer, announcedVer, currentVer) {
    return typeof signedVer === "string" && signedVer.length > 0
        && signedVer === announcedVer && verGt(signedVer, currentVer);
}
let _caBundle = null;
function caBundle() {
    if (_caBundle) return _caBundle;
    let sys = [];
    try { sys = tls.getCACertificates("system") || []; } catch { sys = []; }
    _caBundle = [...(tls.rootCertificates || []), ...sys];
    return _caBundle;
}
// Teto de tamanho para downloads do updater (nativo E curl): uma rede hostil não
// pode streamar um corpo infinito e derrubar por OOM o event loop single-thread.
const MAX_FETCH_BYTES = 64 * 1024 * 1024;
function fetchViaNode(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        const getter = new URL(url).protocol === "http:" ? httpGet : httpsGet;
        const req = getter(url, { headers: { "User-Agent": "voice-chat-updater", Accept: "*/*" }, ca: caBundle() }, (res) => {
            const sc = res.statusCode || 0;
            if (sc >= 300 && sc < 400 && res.headers.location && redirects < 5) {
                const next = new URL(res.headers.location, url);
                res.resume();
                // Nunca segue um downgrade https -> http (evita rebaixar a segurança
                // do canal via redirect forjado).
                if (new URL(url).protocol === "https:" && next.protocol !== "https:") {
                    reject(new Error("redirect inseguro (https->" + next.protocol + ")"));
                    return;
                }
                resolve(fetchViaNode(next.toString(), redirects + 1));
                return;
            }
            if (sc !== 200) {
                res.resume();
                const err = new Error("HTTP " + sc);
                err.httpStatus = sc;   // já houve resposta HTTP: curl não ajudaria
                reject(err);
                return;
            }
            const chunks = [];
            let len = 0;
            // Teto de tamanho (mesmo do fetchViaCurl): uma rede hostil não pode streamar
            // um corpo infinito e derrubar por OOM o event loop single-thread da extensão.
            res.on("data", (c) => {
                len += c.length;
                if (len > MAX_FETCH_BYTES) {
                    res.destroy();
                    reject(new Error("resposta excedeu o limite de tamanho"));
                    return;
                }
                chunks.push(c);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    });
}
// Fallback para redes que reassinam o HTTPS com uma CA própria ("SSL assinado" /
// TLS interception corporativo): o CA bundle do Node não conhece essa CA, então o
// fetch nativo falha na verificação. O curl.exe do System32 usa o Schannel (o stack
// TLS do Windows), que confia no MESMO trust store da máquina onde a CA corporativa
// está instalada — e respeita HTTP(S)_PROXY. Só Windows; sem dep nova. Caminho
// ABSOLUTO de System32 de propósito: garante o curl Schannel (não um curl OpenSSL
// que estiver no PATH, ex.: git/msys). Retorna Buffer (o sha256 do update é checado
// depois, então o conteúdo continua verificado).
function fetchViaCurl(url) {
    if (process.platform !== "win32") return Promise.resolve(null);
    const curl = join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
    if (!existsSync(curl)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        // spawn ASSÍNCRONO (não spawnSync): baixar por curl NÃO pode congelar o
        // event loop single-thread da extensão (áudio/turnos ficariam parados). Teto
        // de 64MB na resposta + timeout backstop de 35s (além do --max-time do curl).
        const child = spawn(curl, [
            "--fail", "--location", "--silent", "--show-error",
            "--proto-redir", "=https", "--max-redirs", "5",
            "--max-time", "30", "-A", "voice-chat-updater", "--", url,
        ], { windowsHide: true });
        const out = [], err = [];
        let outLen = 0, done = false;
        const MAX = MAX_FETCH_BYTES;
        const to = setTimeout(() => end(reject, new Error("curl: timeout")), 35000);
        function end(fn, arg) {
            if (done) return;
            done = true;
            clearTimeout(to);
            try { child.kill(); } catch { /* já saiu */ }
            fn(arg);
        }
        child.on("error", (e) => end(reject, new Error("curl: " + e.message)));
        child.stdout.on("data", (c) => {
            outLen += c.length;
            if (outLen > MAX) return end(reject, new Error("curl: resposta excedeu 64MB"));
            out.push(c);
        });
        child.stderr.on("data", (c) => err.push(c));
        child.on("close", (code) => {
            if (done) return;
            done = true;
            clearTimeout(to);
            if (code !== 0) {
                reject(new Error("curl: " + (Buffer.concat(err).toString().trim() || ("exit " + code))));
                return;
            }
            resolve(Buffer.concat(out));
        });
    });
}
async function fetchBuf(url) {
    try {
        return await fetchViaNode(url);
    } catch (e) {
        // Só cai no curl em falha de REDE/TLS (o caso das redes que reassinam o
        // HTTPS). Se já houve resposta HTTP (4xx/5xx) ou um redirect inseguro, o
        // curl não ajudaria — propaga o erro original.
        if (e && (e.httpStatus || /redirect inseguro/.test(e.message || ""))) throw e;
        let buf = null;
        try {
            buf = await fetchViaCurl(url);
        } catch (ce) {
            throw new Error("download falhou (node: " + (e && e.message || e) + "; curl: " + (ce && ce.message || ce) + ")");
        }
        if (buf == null) throw e;   // sem curl (não-Windows / ausente): erro original
        dbg("update: fetch nativo falhou (" + (e && e.message) + "); usei curl.exe do Windows (Schannel/trust store)");
        return buf;
    }
}
function pickPluginVersion(mp, name) {
    const arr = mp && Array.isArray(mp.plugins) ? mp.plugins : [];
    const p = arr.find((x) => x && x.name === name);
    return p && typeof p.version === "string" ? p.version : "";
}
function releaseAssetBase(version) {
    if (process.env.VOICE_UPDATE_BASE) return process.env.VOICE_UPDATE_BASE.replace(/\/?$/, "/");
    return `https://github.com/AllanSantos-DV/copilot-marketplace/releases/download/${PLUGIN_NAME}-v${version}/`;
}

async function checkForUpdate(opts = {}) {
    const force = opts.force === true;
    if (UPDATE_DISABLED || !primaryFork) return { status: "disabled" };
    const st = readUpdateState();
    const now = Date.now();
    if (!force && UPDATE_THROTTLE_MS > 0 && st.lastCheck && now - st.lastCheck < UPDATE_THROTTLE_MS) {
        if (st.pendingVersion && verGt(st.pendingVersion, CURRENT_VERSION)) {
            broadcast({ type: "update", version: st.pendingVersion });
            return { status: "pending", version: st.pendingVersion };
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
        if (!remoteVer || !verGt(remoteVer, CURRENT_VERSION)) return { status: "uptodate", version: CURRENT_VERSION };
        if (st.pendingVersion === remoteVer) {
            broadcast({ type: "update", version: remoteVer });
            return { status: "pending", version: remoteVer };
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
        if (!updateVersionAcceptable(manifest.version, remoteVer, CURRENT_VERSION))
            throw new Error("versão do update recusada (rollback/incoerente): assinada="
                + (manifest && manifest.version) + " anunciada=" + remoteVer + " atual=" + CURRENT_VERSION);
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
        if (!staged.length) return { status: "uptodate", version: CURRENT_VERSION };
        for (const s of staged) {
            const target = join(EXT_DIR, s.rel);
            const part = target + ".part";
            writeFileSync(part, s.buf);
            try {
                if (existsSync(target)) copyFileSync(target, target + ".bak");
            } catch {
            }
            renameSync(part, target);
        }
        st.pendingVersion = remoteVer;
        writeUpdateState(st);
        log("auto-update: staged v" + remoteVer + " (" + staged.length + " files) — restart pending");
        broadcast({ type: "update", version: remoteVer });
        return { status: "staged", version: remoteVer };
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
const PYTHON_CACHE_FILE = join(ARTIFACTS, "python-path.json");
function readPythonCache() {
    try {
        const p = JSON.parse(readFileSync(PYTHON_CACHE_FILE, "utf8"));
        const path = p && typeof p.path === "string" ? p.path : "";
        if (!path) return "";
        if (/[\\/]/.test(path) && !existsSync(path)) return ""; // cached interpreter was removed
        return path;
    } catch { return ""; }
}
function savePythonPath(p) {
    try { if (p && /[\\/]/.test(p)) writeFileSync(PYTHON_CACHE_FILE, JSON.stringify({ path: p })); } catch { }
}
function whichPython(name) {
    try {
        const whereExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
        const bin = existsSync(whereExe) ? whereExe : "where";
        const r = spawnSync(bin, [name], { encoding: "utf8", windowsHide: true });
        if (r && r.status === 0 && r.stdout) {
            return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
    } catch { }
    return [];
}
function pyLauncherPaths() {
    // The py launcher lives at a fixed path and lists interpreters from the
    // registry (PEP 514) — it works even when PATH has no Python at all.
    try {
        const pyExe = join(process.env.SystemRoot || "C:\\Windows", "py.exe");
        const bin = existsSync(pyExe) ? pyExe : "py";
        const r = spawnSync(bin, ["-0p"], { encoding: "utf8", windowsHide: true });
        if (r && r.status === 0 && r.stdout) {
            const out = [];
            for (const line of r.stdout.split(/\r?\n/)) {
                const m = line.match(/([A-Za-z]:\\[^\r\n*]*python\.exe)\s*$/i);
                if (m) out.push(m[1].trim());
            }
            return out;
        }
    } catch { }
    return [];
}
function commonPythonDirs() {
    const out = [];
    try {
        for (const n of readdirSync("C:\\")) {
            if (/^Python\d+$/i.test(n)) out.push(join("C:\\", n, "python.exe"));
        }
    } catch { }
    try {
        const base = join(process.env.LOCALAPPDATA || "", "Programs", "Python");
        for (const n of readdirSync(base)) out.push(join(base, n, "python.exe"));
    } catch { }
    try {
        const pyExe = join(process.env.SystemRoot || "C:\\Windows", "py.exe");
        if (existsSync(pyExe)) out.push(pyExe);
    } catch { }
    return out.filter((p) => { try { return existsSync(p); } catch { return false; } });
}
// PURE ordering/dedup — the piece worth locking with a test (no I/O here).
function orderPythonCandidates(sources) {
    const raw = [
        sources.override,
        sources.cached,
        ...(sources.launcher || []),   // registry-based, PATH-independent
        ...(sources.common || []),     // filesystem, PATH-independent
        ...(sources.where || []),      // PATH-based
        ...(sources.bare || []),       // last-resort bare names
    ].filter((s) => typeof s === "string" && s.trim());
    const seen = new Set();
    const out = [];
    for (const c of raw) {
        const v = c.trim();
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}
function buildPythonCandidates() {
    const bare = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
    if (process.platform !== "win32") {
        return orderPythonCandidates({ override: process.env.VOICE_PYTHON, cached: readPythonCache(), bare });
    }
    return orderPythonCandidates({
        override: process.env.VOICE_PYTHON,
        cached: readPythonCache(),
        launcher: pyLauncherPaths(),
        common: commonPythonDirs(),
        where: whichPython("python").concat(whichPython("python3")),
        bare,
    });
}

function ensureWorker() {
    if (worker || workerStarting || !primaryFork) return;
    pyIndex = 0;
    pyCandidates = null;   // rebuild discovery fresh for this start sequence
    startWorker();
}

function startWorker() {
    workerStarting = true;
    if (!pyCandidates || !pyCandidates.length) pyCandidates = buildPythonCandidates();
    if (!pyCandidates.length) pyCandidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
    const py = pyCandidates[pyIndex] || pyCandidates[pyCandidates.length - 1];
    activePy = py;
    const env = {
        ...process.env,
        VOICE_MODEL_ROOT: MODELS_DIR,
        VOICE_LANG: settings.language,
        VOICE_TTS_MODEL: settings.ttsVoice || "",
        VOICE_WAKE_PHRASES: settings.wakePhrase || "escuta jarvis",
        VOICE_MIC_DEVICE: settings.micDevice == null ? "" : String(settings.micDevice),
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
    };

    let child;
    try {
        child = spawn(py, ["-u", WORKER_FILE], {
            cwd: EXT_DIR,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (e) {
        workerStarting = false;
        tryNextPy("spawn threw: " + e.message);
        return;
    }

    worker = child;
    try {
        if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
    } catch (e) {
        dbg("setPriority(worker) failed: " + (e && e.message));
    }
    let sawReady = false;
    let errored = false;

    child.on("error", (e) => {
        log("worker spawn error: " + e.message);
        errored = true;
        worker = null;
        workerStarting = false;
        if (!sawReady) tryNextPy(e.message);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
        line = line.trim();
        if (!line) return;
        let ev;
        try {
            ev = JSON.parse(line);
        } catch {
            log("worker non-json: " + line.slice(0, 160));
            return;
        }
        if (ev.event === "ready") {
            sawReady = true;
            crashCount = 0;
            pyExhaustCount = 0;
            savePythonPath(activePy); // this interpreter works — reuse it, PATH-free
        }
        onWorkerEvent(ev);
    });

    const errRl = createInterface({ input: child.stderr });
    errRl.on("line", (line) => {
        if (line.trim()) dbg("py: " + line.trim());
    });

    child.on("exit", (code, sig) => {
        log(`worker exited code=${code} sig=${sig}`);
        worker = null;
        workerReady = false;
        workerStarting = false;
        clearStartupWatchdog();
        if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; }
        for (const [id, p] of pendingTts) {
            clearTimeout(p.timer);
            try { p.reject(new Error("motor de voz encerrou durante a síntese")); } catch {  }
            pendingTts.delete(id);
        }
        if (intentionalRestart) {
            intentionalRestart = false;
            crashCount = 0;
            broadcast({ type: "worker", state: "loading", msg: "Reiniciando motor de voz…" });
            setTimeout(ensureWorker, 300);
            return;
        }
        if (errored) return; 
        const wasStable = sawReady && readyAt && (Date.now() - readyAt >= WORKER_STABLE_MS);
        if (!wasStable) crashCount++;
        if (crashCount > 4) {
            broadcast({
                type: "worker",
                state: "error",
                msg: "O motor de voz falhou repetidamente. Verifique os logs da extensão.",
            });
            return;
        }
        broadcast({ type: "worker", state: "loading", msg: "Reiniciando motor de voz…" });
        setTimeout(ensureWorker, 1500);
    });

    broadcast({ type: "worker", state: "loading", msg: "Iniciando motor de voz…" });
    armStartupWatchdog();
    workerStarting = false; 
}

function clearStartupWatchdog() {
    if (startupWatchdog) { clearInterval(startupWatchdog); startupWatchdog = null; }
}

// Auto-recuperação de um boot TRAVADO. O motor (daemon vox-engine) pode ficar saudável
// enquanto o WORKER prende no connect (ex.: open() de um named pipe ocupado): fica vivo,
// ocioso e nunca emite "ready" — a UI eternizava "Iniciando motor de voz…". O respawn por
// SAÍDA (child "exit") NÃO cobre isso: um worker travado não sai. Então o watchdog decide,
// pelo estado observável, AUTO-REINICIAR o worker (restart provou resolver em ~1s).
const WEDGE_QUIET_SECS = 40;     // sem progresso E sem "ready" por este tempo ⇒ travado
const WEDGE_MAX_RESTARTS = 3;    // auto-reinícios antes de desistir com erro ALTO
// Decisão PURA (sem timers/efeitos) p/ ser testável de forma adversarial. NUNCA reinicia
// durante uma operação longa e LEGÍTIMA (busy: install/update do motor, silenciosa por
// minutos) — matar o worker no meio ORFANARIA a árvore do install.ps1 e um respawn
// iniciaria uma 2ª instalação concorrente, corrompendo o venv. Silêncio só conta como
// wedge FORA de uma fase busy.
function startupWatchdogAction({ workerReady, hasWorker, quietFor, busy, wedgeRestarts }) {
    if (workerReady || !hasWorker) return { action: "stop" };
    if (!busy && quietFor >= WEDGE_QUIET_SECS) {
        return wedgeRestarts >= WEDGE_MAX_RESTARTS ? { action: "giveup" } : { action: "restart" };
    }
    if (quietFor >= 25) return { action: "narrate" };
    return { action: "none" };
}
function armStartupWatchdog() {
    clearStartupWatchdog();
    workerStartAt = Date.now();
    lastLoadingAt = 0;
    lastLoadingBusy = false;
    // The motor start must never be a silent infinite spinner. While it is coming up
    // (no "ready" yet), keep logging elapsed + last phase; once the worker goes quiet
    // (no progress event for a while) and is NOT in a busy install phase, take it as a
    // WEDGE and auto-restart it (bounded). Otherwise surface elapsed time + the
    // debug.log path so the user can SEE where it is stuck.
    startupWatchdog = setInterval(() => {
        if (workerReady || !worker) { clearStartupWatchdog(); return; }
        const secs = Math.round((Date.now() - workerStartAt) / 1000);
        const quietFor = Math.round((Date.now() - (lastLoadingAt || workerStartAt)) / 1000);
        const phase = lastLoadingMsg || "iniciando";
        dbg(`worker startup watchdog: ${secs}s total, quiet ${quietFor}s, busy=${lastLoadingBusy}, phase="${phase}"`);
        const act = startupWatchdogAction({
            workerReady, hasWorker: !!worker, quietFor, busy: lastLoadingBusy, wedgeRestarts,
        });
        if (act.action === "restart") {
            wedgeRestarts++;
            log(`worker startup WEDGED (quiet ${quietFor}s, phase="${phase}", total ${secs}s) → auto-reinício ${wedgeRestarts}/${WEDGE_MAX_RESTARTS}. Log: ${DEBUG_LOG}`);
            broadcast({ type: "worker", state: "loading", msg: `O motor de voz travou em "${phase}" — reiniciando (${wedgeRestarts}/${WEDGE_MAX_RESTARTS})…`, secs, stalled: true });
            clearStartupWatchdog();   // limpa JÁ: worker.kill() é assíncrono; não conte com o "exit" chegar antes do próximo tick (senão double-restart). O respawn re-arma.
            restartWorker();
            return;
        }
        if (act.action === "giveup") {
            clearStartupWatchdog();
            log(`worker startup: desisti após ${wedgeRestarts} auto-reinícios (fase="${phase}", ${secs}s)`);
            broadcast({ type: "worker", state: "error", msg: `O motor de voz não respondeu após ${wedgeRestarts} reinícios (fase: ${phase}, ${secs}s). Verifique o log: ${DEBUG_LOG}` });
            return;
        }
        if (act.action === "narrate") {
            const msg = secs >= 90
                ? `Motor sem resposta há ${quietFor}s (fase: ${phase}, total ${secs}s). Log: ${DEBUG_LOG}`
                : `${phase} — ${secs}s`;
            broadcast({ type: "worker", state: "loading", msg, secs, stalled: quietFor >= 60 });
        }
    }, 10000);
    if (startupWatchdog.unref) startupWatchdog.unref();
}

function tryNextPy(reason) {
    pyIndex++;
    if (pyCandidates && pyIndex < pyCandidates.length) {
        log(`retry python candidate '${pyCandidates[pyIndex]}' (${reason})`);
        setTimeout(startWorker, 200);
        return;
    }
    // Every candidate failed. Do NOT brick permanently — a machine that has Python
    // may just need PATH/env to settle, and discovery is rebuilt each attempt.
    pyIndex = 0;
    pyCandidates = null;
    pyExhaustCount++;
    if (pyExhaustCount <= 3) {
        log(`python discovery exhausted (${reason}); retry #${pyExhaustCount} in 8s`);
        broadcast({ type: "worker", state: "loading", msg: "Procurando o Python do motor de voz…" });
        setTimeout(() => { workerStarting = false; ensureWorker(); }, 8000);
        return;
    }
    broadcast({
        type: "worker",
        state: "error",
        msg: "Não foi possível iniciar o Python do motor de voz. Instale o Python 3 e reabra o painel.",
    });
}

function workerSend(obj) {
    if (worker && worker.stdin && worker.stdin.writable) {
        try {
            worker.stdin.write(JSON.stringify(obj) + "\n");
            return true;
        } catch (e) {
            log("worker write failed: " + e.message);
        }
    }
    return false;
}

function restartWorker() {
    if (!worker) {
        ensureWorker();
        return;
    }
    intentionalRestart = true;
    try { workerSend({ cmd: "shutdown" }); } catch {  }
    try { worker.kill(); } catch {  }
}

// Reinício por INTENÇÃO EXPLÍCITA do usuário (botão / POST /restart-worker). Renova o
// orçamento de auto-reinício: sem isto, um giveup anterior (wedgeRestarts no teto, que só
// zera num "ready") faria o watchdog recém-armado desistir na 1ª verificação — matando o
// restart manual com um erro falso "não respondeu após N reinícios", sem uma única tentativa.
function manualRestartWorker() {
    wedgeRestarts = 0;
    broadcast({ type: "worker", state: "loading", msg: "Reiniciando a captura de voz…" });
    restartWorker();
}

function onWorkerEvent(ev) {
    switch (ev.event) {
        case "ready":
            workerReady = true;
            clearStartupWatchdog();
            wedgeRestarts = 0;   // boot saudável: renova o orçamento de auto-reinício
            readyAt = Date.now();
            lastDevice = ev.device || "cpu";
            if (stabilityTimer) clearTimeout(stabilityTimer);
            stabilityTimer = setTimeout(() => { crashCount = 0; stabilityTimer = null; }, WORKER_STABLE_MS);
            broadcast({ type: "worker", state: "ready", device: lastDevice });
            warmTts();
            if (settings.wakeWord) {
                workerSend({ cmd: "wake", on: true, phrases: [settings.wakePhrase] });
            }
            break;
        case "loading":
            lastLoadingMsg = ev.msg || lastLoadingMsg;
            lastLoadingAt = Date.now();
            lastLoadingBusy = !!ev.busy;   // install/update (busy) é longo e legítimo: o watchdog NÃO reinicia nessa fase
            broadcast({ type: "worker", state: "loading", msg: ev.msg, pct: ev.pct });
            break;
        case "level":
            broadcastTo(turnOwnerSid || activeSid, { type: "level", rms: ev.rms, peak: ev.peak });
            break;
        case "recording":
            broadcastTo(turnOwnerSid || activeSid, { type: "recording", state: ev.state });
            break;
        case "monitor_level":
            if (monitorSid) broadcastTo(monitorSid, { type: "monitorLevel", rms: ev.rms, peak: ev.peak });
            break;
        case "transcript": {
            const t = (ev.text || "").trim();
            const confirm = settings.confirmTranscript === true && !!t;
            // The recorder sid travels WITH the capture through the worker and is
            // echoed back here, so routing is correct even if a primary failover or
            // focus change mutated the in-memory turnOwnerSid/activeSid globals.
            const owner = ev.sid || turnOwnerSid || activeSid;
            turnOwnerSid = null;
            clearRecordingActive();
            broadcastTo(owner, { type: "transcript", text: ev.text || "", confirm, note: ev.note, peak: ev.peak, micOk: ev.micOk });
            if (t && !confirm) dispatchVoiceTurn(t, owner);
            break;
        }
        case "error":
            clearRecordingActive();
            turnOwnerSid = null;
            // Liveness: um worker que EMITE erro está vivo e ciclando (o loop de boot
            // retenta) — não é um wedge mudo. Renova o "quiet" p/ o self-heal NÃO
            // reiniciar por cima de um erro ALTO (reiniciar não conserta motor-down),
            // e encerra qualquer fase busy (a operação longa terminou em erro).
            lastLoadingAt = Date.now();
            lastLoadingBusy = false;
            if (ev.fatal) {
                workerReady = false;
                broadcast({ type: "worker", state: "error", msg: ev.msg });
            } else {
                broadcast({ type: "error", msg: ev.msg });
            }
            break;
        case "tts": {
            if (ev.id === "__warm__") {
                broadcast({ type: "worker", state: "voiceReady" });
                break;
            }
            const p = pendingTts.get(ev.id);
            if (p) {
                pendingTts.delete(ev.id);
                if (p.timer) clearTimeout(p.timer);
                if (ev.ok && existsSync(p.wavFile)) p.resolve();
                else p.reject(new Error(ev.msg || "falha na síntese de voz"));
            }
            break;
        }
        case "transcribed": {
            const p = pendingTranscribe.get(ev.id);
            if (p) {
                pendingTranscribe.delete(ev.id);
                if (p.timer) clearTimeout(p.timer);
                if (ev.ok) p.resolve((ev.text || "").trim());
                else p.reject(new Error(ev.msg || "falha na transcrição"));
            }
            break;
        }
        case "tts_voice":
            broadcast({ type: "worker", state: "voiceReady" });
            if (ev.ok) previewVoice();
            else if (ev.msg) broadcast({ type: "error", msg: ev.msg });
            break;
        case "wake":
            broadcast({ type: "wake", state: ev.state, phrase: ev.phrase, msg: ev.msg ?? ev.message });
            break;
        case "mics":
            lastMics = { devices: ev.devices || [], current: ev.current ?? null, default: ev.default ?? null };
            broadcast({ type: "mics", ...lastMics });
            break;
        case "voices":
            // Catálogo do motor (fonte única). ok:false / lista vazia é repassado como
            // está — a UI mostra "vozes indisponíveis" ALTO, sem mascarar com lista local.
            lastVoices = { voices: Array.isArray(ev.voices) ? ev.voices : [], default: ev.default_voice ?? null };
            broadcast({ type: "voices", ...lastVoices, ok: ev.ok, msg: ev.msg });
            break;
        case "command": {
            const c = (ev.text || "").trim();
            dbg(`wake command: ${c.slice(0, 120)}`);
            if (c) {
                const owner = turnOwnerSid || activeSid;
                turnOwnerSid = null;
                broadcastTo(owner, { type: "transcript", text: c, confirm: false });
                dispatchVoiceTurn(c, owner);
            }
            break;
        }
        case "status":
        case "pong":
        default:
            break;
    }
}

function dispatchVoiceTurn(text, sidArg) {
    const t = (text || "").trim();
    if (!t) return;
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

async function handleVoiceTranscript(text) {
    pendingVoiceTurn = true;
    _phase = "voiceTurn:start";
    voiceInstructionPending =
        settings.authorSummary !== false || settings.cueCheckpoints !== false;
    spokenCheckpoints = new Set();
    saveVoiceState();
    markTurn(mySid());
    notifyCanvas({ type: "status", state: "thinking" });
    if (settings.cueStart !== false) {
        speakCue("Ok, comecei a trabalhar na sua solicitação.", "start").catch(() => {});
    }
    armIdleFallback();
    dbg(`handleVoiceTranscript: sending prompt (${text.length} chars): ${text.slice(0, 120)}`);
    try {
        const messageId = await session.send({ prompt: text });
        _phase = "voiceTurn:sent";
        dbg(`session.send resolved messageId=${messageId}`);
    } catch (e) {
        dbg(`session.send THREW: ${e && e.stack ? e.stack : e}`);
        log("session.send failed: " + e.message);
        notifyCanvas({ type: "error", msg: "Falha ao enviar para o Copilot: " + e.message });
    }
}

function onAssistantMessage(event) {
    if (event?.agentId) return; // só as mensagens do agente raiz são faladas
    const content = event?.data?.content;
    // Speak when there's a pending voice turn OR an explicit 🔊 summary (text turns),
    // OR global speakAll on the primary.
    if (!hasPendingTurn() && !replyWantsSpeech(content) && !(primaryFork && settings.speakAll)) return;
    _phase = "reply:msg";
    dbg(`onAssistantMessage: len=${typeof content === "string" ? content.length : 0} pending=${hasPendingTurn()} sentinel=${typeof content === "string" && content.includes(VOICE_SENTINEL)}`);
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
    if (!hasPendingTurn() && !replyWantsSpeech(latestReply) && !(primaryFork && settings.speakAll)) return; 
    _phase = "idle-event";
    dbg(`onIdle: agentId=${event?.agentId ?? "(root)"} pendingVoiceTurn=${pendingVoiceTurn} speakAll=${settings.speakAll}`);
    if (event?.agentId) return;
    flushSpeech();
}

function armIdleFallback() {
    if (idleFallback) clearTimeout(idleFallback);
    idleFallback = setTimeout(onIdleFallbackFired, IDLE_FALLBACK_MS);
}

function onIdleFallbackFired() {
    idleFallback = null;
    if (hasPendingTurn() && settings.authorSummary && latestReply && !latestReply.includes(VOICE_SENTINEL)) {
        dbg("idleFallback: no 🔊 sentinel yet — re-arming instead of speaking partial reply");
        armIdleFallback();
        return;
    }
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
    dbg(`flushSpeech: hasContent=${!!content} pendingVoiceTurn=${pendingVoiceTurn} speakAll=${settings.speakAll} sameAsLast=${content === lastSpokenContent}`);
    if (!content) return;
    if (!hasPendingTurn() && !replyWantsSpeech(content) && !settings.speakAll) return;
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

    const { spoken, full } = makeSpoken(content);
    let speakText = settings.fullRead ? full : spoken;
    if (!speakText) {
        speakText = "A resposta não tem texto para ler em voz alta. Confira o chat para os detalhes.";
    }
    const fullForUi = full && full !== speakText ? full : undefined;

    _phase = "flushSpeech:speak";
    await routeSpeak({ spoken: speakText, full: fullForUi });
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
const AUDIO_HISTORY_MAX = 30;
const AUDIO_QUEUE_FILE = join(ARTIFACTS, "audio-queue.json");
const audioHistoryBySid = new Map();   // sid -> item[]
const audioSeqBySid = new Map();       // sid -> last seq issued
const audioTurnBySid = new Map();      // sid -> current turn number
const audioDeliveredBySid = new Map(); // sid -> highest seq delivered to active client

function appendAudioItem(sid, partial) {
    if (!sid) return null;
    const seq = (audioSeqBySid.get(sid) || 0) + 1;
    audioSeqBySid.set(sid, seq);
    const turn = audioTurnBySid.get(sid) || 1;
    const item = {
        seq, id: `${sid}:${seq}`, turn,
        type: partial.type, kind: partial.kind || null,
        spoken: partial.spoken || "", full: partial.full || "",
        audio: partial.audio || null, ts: Date.now(),
    };
    const hist = audioHistoryBySid.get(sid) || [];
    hist.push(item);
    // Cap to the newest N; keep deliveredSeq coherent if the cursor item is pruned.
    while (hist.length > AUDIO_HISTORY_MAX) hist.shift();
    audioHistoryBySid.set(sid, hist);
    // A final reply closes the turn -> the next audio belongs to the next turn.
    if (partial.type === "reply") audioTurnBySid.set(sid, turn + 1);
    persistAudioState();
    return item;
}

// Deliver to the active+connected client every history item it hasn't seen yet
// (seq > deliveredSeq), in order, and advance the cursor. Idempotent: a second
// call finds nothing new. Used on live append, on /focus and on reconnect.
function pushAudio(sid) {
    if (!sid || sid !== activeSid || !sessionHasClient(sid)) return;
    const hist = audioHistoryBySid.get(sid) || [];
    if (!hist.length) return;
    const delivered = audioDeliveredBySid.get(sid) || 0;
    const fresh = hist.filter((it) => it.seq > delivered);
    if (!fresh.length) return;
    audioDeliveredBySid.set(sid, hist[hist.length - 1].seq);
    persistAudioState();
    for (const item of fresh) broadcastTo(sid, { type: "audio", item });
    dbg(`pushAudio: delivered ${fresh.length} audio item(s) to sid=${sid}`);
}

// Public entry used by speakToCanvas: record the audio in history, then deliver
// it live if this session is active (else it waits in history for the reopen).
function playOrQueueAudio(sid, partial) {
    if (appendAudioItem(sid, partial)) pushAudio(sid);
}

// The audio state the hello hands a (re)connecting client: the FULL per-session
// history (for the navigable player) + playFromSeq = the first seq it hasn't
// heard, so the client autoplays only the accumulated tail. Marks it delivered.
function audioHistoryForHello(sid) {
    const hist = audioHistoryBySid.get(sid) || [];
    const playFromSeq = (audioDeliveredBySid.get(sid) || 0) + 1;
    if (hist.length) {
        // Advancing the delivered cursor MUST be persisted, else a restart/failover
        // after a reopen-only delivery resets it to 0 and the whole history
        // re-autoplays on the next reopen (the very bug this feature removes).
        audioDeliveredBySid.set(sid, hist[hist.length - 1].seq);
        persistAudioState();
    }
    return { items: hist, playFromSeq, max: AUDIO_HISTORY_MAX };
}

function readAudioStateMap() {
    try { return JSON.parse(readFileSync(AUDIO_QUEUE_FILE, "utf8")) || {}; } catch { return {}; }
}
function persistAudioState() {
    try {
        const map = {};
        for (const [sid, hist] of audioHistoryBySid) {
            if (!hist || !hist.length) continue;
            map[sid] = {
                items: hist, seq: audioSeqBySid.get(sid) || 0,
                turn: audioTurnBySid.get(sid) || 1, delivered: audioDeliveredBySid.get(sid) || 0,
            };
        }
        writeFileSync(AUDIO_QUEUE_FILE, JSON.stringify(map));
    } catch { }
}
function restoreAudioHistory() {
    try {
        const map = readAudioStateMap();
        for (const [sid, v] of Object.entries(map)) {
            // New format: { items, seq, turn, delivered }. Legacy: a bare item[].
            const items = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
            if (!items.length) continue;
            let maxSeq = 0;
            items.forEach((it, i) => {                 // backfill legacy items
                if (typeof it.seq !== "number") it.seq = i + 1;
                if (typeof it.turn !== "number") it.turn = 1;
                if (!it.id) it.id = `${sid}:${it.seq}`;
                if (it.seq > maxSeq) maxSeq = it.seq;
            });
            audioHistoryBySid.set(sid, items);
            audioSeqBySid.set(sid, Array.isArray(v) ? maxSeq : (v.seq || maxSeq));
            audioTurnBySid.set(sid, Array.isArray(v) ? 1 : (v.turn || 1));
            // On restart nothing counts as delivered -> the reopened session
            // re-offers the tail (better than silently dropping unheard audio).
            audioDeliveredBySid.set(sid, Array.isArray(v) ? 0 : (v.delivered || 0));
        }
    } catch { }
}

// --- Held voice-turn delivery (per-session, persisted) ----------------------
// A transcript captured while the owner session is in the background must reach
// THAT session's fork to run session.send(). The HTTP push can miss transiently
// (owner panel closed -> server down but heartbeat still advertises the port; or
// the fork has not re-registered yet). Turns are therefore held in a persisted
// per-sid FIFO and delivered when the owner is provably reachable: right after it
// (re-)registers (fresh, live URL), on focus, and via a safety sweep. Delivery is
// idempotent (peek -> ack -> remove, one in-flight per sid) and each turn carries
// an id the receiver uses to reject a duplicate after a failover.
const PENDING_TURNS_FILE = join(ARTIFACTS, "pending-turns.json");
const pendingTurnsBySid = new Map(); // sid -> [{ id, text, ts }]
const drainingTurns = new Set();     // sids with an /inject in flight
const TURN_TTL_MS = 90000;           // give up (and tell the user) after 90s
function readPendingTurnsMap() {
    try { return JSON.parse(readFileSync(PENDING_TURNS_FILE, "utf8")) || {}; } catch { return {}; }
}
function persistPendingTurns(sid) {
    if (!sid) return;
    try {
        const map = readPendingTurnsMap();
        const q = pendingTurnsBySid.get(String(sid)) || [];
        if (q.length) map[String(sid)] = q; else delete map[String(sid)];
        writeFileSync(PENDING_TURNS_FILE, JSON.stringify(map));
    } catch { }
}
function restorePendingTurns() {
    try {
        const map = readPendingTurnsMap();
        const now = Date.now();
        for (const [sid, items] of Object.entries(map)) {
            if (!Array.isArray(items)) continue;
            const fresh = items.filter((it) => it && it.text && (now - (it.ts || 0)) < TURN_TTL_MS);
            if (fresh.length) pendingTurnsBySid.set(String(sid), fresh);
        }
    } catch { }
}
function enqueueTurn(sid, text) {
    const t = (text || "").trim();
    if (!sid || !t) return null;
    const q = pendingTurnsBySid.get(sid) || [];
    const entry = { id: randomBytes(8).toString("hex"), text: t, ts: Date.now() };
    q.push(entry);
    pendingTurnsBySid.set(sid, q);
    persistPendingTurns(sid);
    return entry;
}
function pruneExpiredTurns(sid) {
    const q = pendingTurnsBySid.get(sid);
    if (!q || !q.length) return;
    const now = Date.now();
    const fresh = q.filter((it) => (now - (it.ts || 0)) < TURN_TTL_MS);
    if (fresh.length === q.length) return;
    const dropped = q.length - fresh.length;
    if (fresh.length) pendingTurnsBySid.set(sid, fresh); else pendingTurnsBySid.delete(sid);
    persistPendingTurns(sid);
    dbg(`pending turn(s) expired for sid=${sid}: dropped ${dropped}`);
    broadcastTo(sid, { type: "error", msg: "Não consegui entregar sua fala a esta sessão (ficou indisponível). Fale de novo, por favor." });
}
function drainTurnsToFork(sid, urlArg) {
    if (!sid) return;
    if (drainingTurns.has(sid)) return;            // an /inject is already in flight for this sid
    pruneExpiredTurns(sid);
    const q = pendingTurnsBySid.get(sid);
    if (!q || !q.length) return;
    const url = urlArg || forks.get(sid);
    if (!url) return;                              // owner not reachable yet; a later (re-)register/focus/sweep retries
    const head = q[0];
    drainingTurns.add(sid);
    dbg(`deliver turn -> sid=${sid} url=${url} id=${head.id} (queued=${q.length})`);
    httpPostJson(url, "/inject", { text: head.text, id: head.id }).then((ok) => {
        drainingTurns.delete(sid);
        if (!ok) return;                           // keep the head queued; retry on next trigger
        const cur = pendingTurnsBySid.get(sid);
        if (cur && cur.length && cur[0].id === head.id) {
            cur.shift();
            if (cur.length) pendingTurnsBySid.set(sid, cur); else pendingTurnsBySid.delete(sid);
            persistPendingTurns(sid);
        }
        drainTurnsToFork(sid, url);                // deliver the next, in FIFO order
    });
}
function drainAllPendingTurns() {
    for (const sid of [...pendingTurnsBySid.keys()]) drainTurnsToFork(sid);
}
// Receiver-side de-dup: a turn re-sent after a mid-inject failover must not run
// session.send() twice (the user raged about duplicated audio; same rule here).
const injectedTurnIds = new Set();
const injectedTurnOrder = [];
function seenInjectedId(id) { return !!id && injectedTurnIds.has(id); }
function rememberInjectedId(id) {
    if (!id || injectedTurnIds.has(id)) return;
    injectedTurnIds.add(id);
    injectedTurnOrder.push(id);
    if (injectedTurnOrder.length > 300) injectedTurnIds.delete(injectedTurnOrder.shift());
}

async function speakToCanvas(sid, spoken, full, cue) {
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
        return;
    }
    // Reply text shows immediately (silent UI update); the audio is persisted for
    // replay and either plays now (if this is the active session) or queues FIFO.
    broadcastTo(sid, { type: "reply", spoken, full });
    try {
        const wav = await synthesize(spoken);
        playOrQueueAudio(sid, { type: "reply", spoken, full, audio: "/tts/" + wav });
    } catch (e) {
        log("tts failed: " + e.message);
        broadcastTo(sid, { type: "error", msg: "Falha na síntese de voz: " + e.message });
    }
}

function canPlayInSession(sid) {
    return !sid || !activeSid || sid === activeSid;
}

function sessionHasClient(sid) {
    if (!sid) return true;
    for (const csid of sseClients.values()) if (csid === sid) return true;
    return false;
}

async function speakCue(text, kind) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    await routeSpeak({ spoken: clean, cue: kind });
}

function forwardToPrimary(path, body) {
    const base = canonicalBase();
    return base ? httpPostJson(base, path, body) : Promise.resolve(false);
}

async function routeSpeak({ spoken, full, cue, sid = mySid() }) {
    if (!spoken) return false;
    if (primaryFork) return speakToCanvas(sid, spoken, full, cue);
    return forwardToPrimary("/speak", { sid, spoken, full, cue });
}

function cleanForSpeech(md) {
    let t = String(md || "");
    t = t.replace(/```[\s\S]*?```/g, " "); 
    t = t.replace(/`([^`]+)`/g, "$1"); 
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); 
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); 
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ""); 
    t = t.replace(/^\s{0,3}>\s?/gm, ""); 
    t = t.replace(/^\s*[-*+]\s+/gm, ""); 
    t = t.replace(/^\s*\d+\.\s+/gm, ""); 
    t = t.replace(/[*_~]{1,3}/g, ""); 
    t = t.replace(/<[^>]+>/g, " "); 
    t = t.replace(/\|/g, " "); 
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "");
    t = t.replace(/\r/g, "");
    t = t.replace(/\n{2,}/g, ". ");
    t = t.replace(/\n/g, ". ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/(\.\s*){2,}/g, ". "); 
    return t.trim();
}

function firstSentences(text, maxChars) {
    if (text.length <= maxChars) return text;
    const parts = text.match(/[^.!?]+[.!?]+/g) || [text];
    let out = "";
    for (const p of parts) {
        if (out && (out + p).length > maxChars) break;
        out += p;
    }
    if (!out) out = text.slice(0, maxChars);
    return out.trim();
}

function extractAuthoredSummary(content) {
    const idx = content.lastIndexOf(VOICE_SENTINEL);
    if (idx === -1) return null;
    const after = content.slice(idx + VOICE_SENTINEL.length).split(/\n{2,}/)[0];
    return after.trim() || null;
}

function stripCheckpointLines(text) {
    return String(text || "")
        .split("\n")
        .filter((ln) => !ln.includes(CHECKPOINT_SENTINEL))
        .join("\n");
}

function makeSpoken(content) {
    const authored = extractAuthoredSummary(content);
    if (authored) {
        let spoken = cleanForSpeech(authored);
        if (spoken.length > 2400) spoken = firstSentences(spoken, 2400);
        const body = stripCheckpointLines(content.slice(0, content.lastIndexOf(VOICE_SENTINEL))).trim();
        const fullClean = cleanForSpeech(body || content);
        const full = fullClean.length > 3000 ? fullClean.slice(0, 3000) : fullClean;
        if (spoken) return { spoken, full, authored: true };
    }
    const cleaned = cleanForSpeech(stripCheckpointLines(content));
    const full = cleaned.length > 3000 ? cleaned.slice(0, 3000) : cleaned;
    const spoken = firstSentences(full, 450);
    return { spoken, full, authored: false };
}

async function synthesize(text) {
    await mkdir(TTS_DIR, { recursive: true });
    const id = `${Date.now()}-${ttsSeq++}`;
    const wavFile = join(TTS_DIR, `reply-${id}.wav`);
    const speakText = text && text.trim() ? text : "Sem conteúdo para ler.";
    try {
        await synthViaWorker(id, speakText, wavFile);
    } catch (e) {
        // O TTS vem SÓ do motor único — SEM fallback SAPI/local. O erro sobe ALTO
        // para o chamador surfaçar (a UI mostra "Falha na síntese de voz").
        log("tts do motor falhou (motor único, sem fallback): " + e.message);
        throw e;
    }
    cleanupOldWavs().catch(() => {});
    return basename(wavFile);
}

async function previewVoice() {
    try {
        const wav = await synthesize("Voz alterada. Agora estou falando assim.");
        if (lastTtsPreviewSid) broadcastTo(lastTtsPreviewSid, { type: "voicePreview", audio: "/tts/" + wav });
    } catch (e) {
        dbg("voice preview failed: " + (e && e.message));
    }
}

function ttsSpeed(rate) {
    const r = typeof rate === "number" ? rate : 0;
    return Math.max(0.7, Math.min(1.4, 1 + r * 0.03));
}

function synthViaWorker(id, text, wavFile) {
    return new Promise((resolve, reject) => {
        if (!worker || !workerReady) {
            reject(new Error("motor de voz não está pronto"));
            return;
        }
        const timer = setTimeout(() => {
            if (pendingTts.has(id)) {
                pendingTts.delete(id);
                reject(new Error("tempo esgotado na síntese de voz"));
            }
        }, 30000);
        pendingTts.set(id, { resolve, reject, timer, wavFile });
        const ok = workerSend({
            cmd: "tts",
            id,
            text,
            out: wavFile,
            speed: ttsSpeed(settings.rate),
            sid: settings.ttsSid || 0,
        });
        if (!ok) {
            clearTimeout(timer);
            pendingTts.delete(id);
            reject(new Error("falha ao enviar texto ao motor de voz"));
        }
    });
}

function warmTts() {
    workerSend({ cmd: "tts", id: "__warm__", text: "ok", warm: true });
}

const pendingTranscribe = new Map(); // id -> {resolve,reject,timer} for /transcribe (engine reuse)
function transcribeViaWorker(path) {
    return new Promise((resolve, reject) => {
        if (!worker || !workerReady) { reject(new Error("motor de voz não está pronto")); return; }
        const id = "tr-" + randomBytes(6).toString("hex");
        const timer = setTimeout(() => {
            if (pendingTranscribe.has(id)) { pendingTranscribe.delete(id); reject(new Error("tempo esgotado na transcrição")); }
        }, 60000);
        pendingTranscribe.set(id, { resolve, reject, timer });
        const ok = workerSend({ cmd: "transcribe_file", id, path });
        if (!ok) { clearTimeout(timer); pendingTranscribe.delete(id); reject(new Error("falha ao enviar áudio ao motor de voz")); }
    });
}

async function cleanupOldWavs() {
    try {
        const files = (await readdir(TTS_DIR)).filter((f) => f.endsWith(".wav"));
        if (files.length <= 8) return;
        // Never prune a wav still referenced by any session's audio HISTORY — those
        // must stay re-playable. basename() maps the "/tts/<file>.wav" url to a file.
        const kept = new Set();
        for (const hist of audioHistoryBySid.values()) {
            for (const it of hist) if (it && it.audio) kept.add(basename(it.audio));
        }
        const prunable = files.filter((f) => !kept.has(f));
        if (prunable.length <= 8) return;
        const withTime = await Promise.all(
            prunable.map(async (f) => ({ f, m: (await stat(join(TTS_DIR, f))).mtimeMs })),
        );
        withTime.sort((a, b) => b.m - a.m);
        for (const { f } of withTime.slice(8)) unlink(join(TTS_DIR, f)).catch(() => {});
    } catch {
    }
}

function readBody(req) {
    return new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            try {
                resolve(b ? JSON.parse(b) : {});
            } catch {
                resolve({});
            }
        });
    });
}

function httpPostJson(baseUrl, path, body) {
    return new Promise((resolve) => {
        try {
            const u = new URL(path, baseUrl);
            const data = Buffer.from(JSON.stringify(body || {}));
            const req = httpRequest(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": data.length,
                        ...(sharedToken ? { "x-voice-token": sharedToken } : {}),
                    },
                },
                (res) => {
                    res.on("data", () => {});
                    res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
                },
            );
            req.on("error", (e) => {
                if (!primaryFork && e && DEAD_PRIMARY_CODES.has(e.code) && baseUrl === canonicalBase()) {
                    reclaimPrimaryIfOrphaned("forward " + e.code).catch(() => { });
                }
                resolve(false);
            });
            req.write(data);
            req.end();
        } catch {
            resolve(false);
        }
    });
}

function registerSelf() {
    if (!myBaseUrl) return;
    if (primaryFork) {
        forks.set(mySid(), myBaseUrl);
        return;
    }
    const base = canonicalBase();
    if (base) httpPostJson(base, "/register", { sid: mySid(), url: myBaseUrl });
}

function sendJson(res, obj, code = 200) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function cookieToken(req) {
    const raw = req.headers.cookie;
    if (!raw) return "";
    for (const part of raw.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0 && part.slice(0, eq).trim() === "vt") {
            try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return part.slice(eq + 1).trim(); }
        }
    }
    return "";
}
function tokenOK(req, url) {
    if (!sharedToken) return true; 
    // Header (POST), cookie de mesma origem (SSE, que não manda header) e query (fallback
    // legado, quando um webview cross-origin descarta o cookie) — todos aceitos.
    const got = req.headers["x-voice-token"] || cookieToken(req) || url.searchParams.get("t") || "";
    return got === sharedToken;
}

function claimVoiceOwnership(sid) {
    if (!sid) return;
    const s = String(sid);
    activeSid = s;
    turnOwnerSid = s;
}

function setRecordingActive(sid) {
    recordingActiveSid = sid;
    if (recordingActiveTimer) clearTimeout(recordingActiveTimer);
    recordingActiveTimer = setTimeout(() => { recordingActiveSid = null; recordingActiveTimer = null; }, 60000);
    if (recordingActiveTimer.unref) recordingActiveTimer.unref();
}

function clearRecordingActive() {
    recordingActiveSid = null;
    if (recordingActiveTimer) { clearTimeout(recordingActiveTimer); recordingActiveTimer = null; }
}

function hasVisibleVoiceClients(exceptSid = "") {
    for (const sid of sseClients.values()) {
        if (!exceptSid || sid !== exceptSid) return true;
    }
    return false;
}

function startMonitor(sid) {
    if (!primaryFork || !sid) return;
    monitorSid = sid;
    ensureWorker();
    try { workerSend({ cmd: "monitor", on: true }); } catch { }
}

function stopMonitor(sid) {
    if (!primaryFork) return;
    if (sid && monitorSid !== sid) return;
    monitorSid = null;
    try { workerSend({ cmd: "monitor", on: false }); } catch { }
}

function quiesceClosedPanelCapture(sid, opts = {}) {
    if (!primaryFork) return;
    const cancelRecording = opts.cancelRecording !== false;
    if (cancelRecording && recordingActiveSid && (!sid || recordingActiveSid === sid)) {
        try { workerSend({ cmd: "cancel" }); } catch { }
        clearRecordingActive();
    }
    if (turnOwnerSid === sid) turnOwnerSid = null;
    if (monitorSid === sid) stopMonitor(sid);
    if (settings.wakeWord && !hasVisibleVoiceClients(sid)) {
        try { workerSend({ cmd: "wake", on: false }); } catch { }
    }
}

async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    if ((req.method === "POST" || path === "/events") && !tokenOK(req, url)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "forbidden" }));
        return;
    }

    if (req.method === "GET" && path === "/ping") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, primary: primaryFork, sid: mySid() }));
        return;
    }

    if (req.method === "POST" && path === "/transcribe") {
        // Engine-reuse endpoint: a sibling extension POSTs a WAV (base64) and gets
        // back the transcript. Token-gated (sharedToken). Stateless: never touches
        // the live mic / wake pipeline.
        ensureWorker();
        if (!workerReady) { return sendJson(res, { ok: false, error: "voice_warming", msg: "motor de voz ainda carregando — tente novamente em alguns segundos" }, 503); }
        const body = await readBody(req);
        let b64 = body && typeof body.audio === "string" ? body.audio : "";
        if (b64.startsWith("data:")) { const i = b64.indexOf(","); if (i >= 0) b64 = b64.slice(i + 1); }
        if (!b64 || b64.length < 32) { return sendJson(res, { ok: false, error: "no_audio" }, 400); }
        let buf;
        try { buf = Buffer.from(b64, "base64"); } catch { return sendJson(res, { ok: false, error: "bad_base64" }, 400); }
        if (buf.length > 30 * 1024 * 1024) { return sendJson(res, { ok: false, error: "too_large" }, 413); }
        let wavPath;
        try {
            mkdirSync(join(ARTIFACTS, "transcribe"), { recursive: true });
            wavPath = join(ARTIFACTS, "transcribe", randomBytes(8).toString("hex") + ".wav");
            writeFileSync(wavPath, buf);
        } catch (e) { return sendJson(res, { ok: false, error: "write_failed", msg: e.message }, 500); }
        try {
            const text = await transcribeViaWorker(wavPath);
            return sendJson(res, { ok: true, text });
        } catch (e) {
            return sendJson(res, { ok: false, error: "transcribe_failed", msg: String(e.message || e) }, 500);
        } finally {
            try { unlinkSync(wavPath); } catch {}
        }
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        try {
            let html = await readFile(IFRAME_FILE, "utf8");
            const headers = { "Content-Type": "text/html; charset=utf-8" };
            if (sharedToken) {
                // Entrega o token de loopback no CORPO do HTML (var inline), nunca na URL do
                // painel — então não vaza por referrer/histórico/log. A página o usa no header
                // x-voice-token dos POSTs. Um cookie de mesma origem também é setado para o SSE
                // (EventSource não manda header) autenticar sem token na URL; se um webview
                // cross-origin descartar o cookie, a página cai para a query com este mesmo
                // valor. Sem HttpOnly (a página lê), sem Secure (loopback http), SameSite=Strict.
                html = html.replace("/*__VOICE_BOOT__*/", "window.__voiceToken=" + JSON.stringify(sharedToken) + ";");
                headers["Set-Cookie"] = `vt=${encodeURIComponent(sharedToken)}; Path=/; SameSite=Strict`;
            }
            res.writeHead(200, headers);
            res.end(html);
        } catch (e) {
            res.writeHead(500);
            res.end("iframe load error: " + e.message);
        }
        return;
    }

    if (req.method === "GET" && path === "/events") {
        const sid = url.searchParams.get("sid") || "";
        if (!sid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "missing sid" }));
            return;
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        sseClients.set(res, sid);
        if (sid && !activeSid) activeSid = sid;
        if (primaryFork && settings.wakeWord) {
            try { workerSend({ cmd: "wake", on: true, phrases: [settings.wakePhrase] }); } catch { }
        }
        const _us = readUpdateState();
        const pendingUpdate = _us.pendingVersion && verGt(_us.pendingVersion, CURRENT_VERSION) ? _us.pendingVersion : null;
        res.write(
            `data: ${JSON.stringify({
                type: "hello",
                settings,
                worker: workerReady ? "ready" : "loading",
                voices: lastVoices,
                audioHistory: audioHistoryForHello(sid),
                pendingUpdate,
                version: CURRENT_VERSION,
                pluginManaged: RUNNING_AS_PLUGIN,
            })}\n\n`,
        );
        if (!workerReady) {
            res.write(
                `data: ${JSON.stringify({
                    type: "worker",
                    state: "loading",
                    msg: "Iniciando motor de voz…",
                })}\n\n`,
            );
        }
        req.on("close", () => {
            sseClients.delete(res);
            if (primaryFork && sid) {
                const t1 = setTimeout(() => {
                    if (!sessionHasClient(sid)) quiesceClosedPanelCapture(sid, { cancelRecording: false });
                }, 5000);
                if (t1.unref) t1.unref();
                const t2 = setTimeout(() => {
                    if (!sessionHasClient(sid) && recordingActiveSid === sid) {
                        try { workerSend({ cmd: "cancel" }); } catch { }
                        clearRecordingActive();
                    }
                }, 15000);
                if (t2.unref) t2.unref();
            }
        });
        ensureWorker();
        // Reopening the session that is already active: deliver any held audio now.
        // pushAudio is idempotent (delivers only seq > deliveredSeq) so this never
        // double-plays what the hello already handed over.
        if (sid === activeSid) pushAudio(sid);
        return;
    }

    if (req.method === "POST" && path === "/quiesce") {
        const body = await readBody(req);
        if (body && body.sid) quiesceClosedPanelCapture(String(body.sid));
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/monitor/start") {
        const body = await readBody(req);
        const sid = body && body.sid ? String(body.sid) : "";
        if (!sid) return sendJson(res, { ok: false, error: "missing sid" });
        if (recordingActiveSid) return sendJson(res, { ok: false, busy: true });
        startMonitor(sid);
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/monitor/stop") {
        const body = await readBody(req);
        stopMonitor(body && body.sid ? String(body.sid) : null);
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/rec/start") {
        const body = await readBody(req);
        const reqSid = body && body.sid ? String(body.sid) : "";
        if (recordingActiveSid && reqSid && recordingActiveSid !== reqSid) {
            dbg(`rec/start busy: mic in use by ${recordingActiveSid}, requested by ${reqSid}`);
            broadcastTo(reqSid, { type: "busy", msg: "O microfone está em uso por outra sessão." });
            return sendJson(res, { ok: false, busy: true });
        }
        if (reqSid) { claimVoiceOwnership(reqSid); setRecordingActive(reqSid); }
        ensureWorker();
        workerSend({ cmd: "start", sid: reqSid });
        return sendJson(res, { ok: true });
    }
    if (req.method === "POST" && path === "/rec/stop") {
        workerSend({ cmd: "stop" });
        return sendJson(res, { ok: true });
    }
    if (req.method === "POST" && path === "/rec/cancel") {
        workerSend({ cmd: "cancel" });
        clearRecordingActive();
        turnOwnerSid = null;
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/converse") {
        const body = await readBody(req);
        if (body && body.sid) claimVoiceOwnership(body.sid); 
        if (settings.wakeWord) {
            ensureWorker();
            workerSend({ cmd: "converse", timeoutMs: CONVERSE_ONSET_MS });
        }
        return sendJson(res, { ok: !!settings.wakeWord });
    }

    if (req.method === "POST" && path === "/register") {
        const body = await readBody(req);
        if (body && body.sid && body.url) {
            const sid = String(body.sid), url = String(body.url);
            const changed = forks.get(sid) !== url;
            forks.set(sid, url);
            if (changed) dbg(`registered fork sid=${sid}`);
            // The URL just arrived from a live server -> deliver any held turns now
            // against this fresh URL (fixes stale-URL and late-register drops).
            drainTurnsToFork(sid, url);
        }
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/focus") {
        const body = await readBody(req);
        if (body && body.sid) {
            activeSid = String(body.sid);
            pushAudio(activeSid);
            drainTurnsToFork(activeSid);
        }
        dbg(`focus -> activeSid=${activeSid}`);
        return sendJson(res, { ok: true, activeSid });
    }

    if (req.method === "POST" && path === "/applied") {
        try {
            const st = readUpdateState();
            delete st.pendingVersion;
            writeUpdateState(st);
        } catch {
        }
        dbg("update applied by user; pendingVersion cleared");
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/inject") {
        const body = await readBody(req);
        const text = (body && body.text ? String(body.text) : "").trim();
        const id = body && body.id ? String(body.id) : "";
        if (id && seenInjectedId(id)) return sendJson(res, { ok: true, dup: true });
        if (text) {
            if (id) rememberInjectedId(id);
            handleVoiceTranscript(text);
        }
        return sendJson(res, { ok: !!text });
    }

    if (req.method === "POST" && path === "/speak") {
        const body = await readBody(req);
        const spoken = String((body && body.spoken) || "").trim();
        const sid = body && body.sid ? String(body.sid) : "";
        if (!sid) return sendJson(res, { ok: false, error: "missing sid" });
        if (spoken) speakToCanvas(sid, spoken, body.full, body.cue);
        return sendJson(res, { ok: !!spoken });
    }

    if (req.method === "POST" && path === "/relay") {
        const body = await readBody(req);
        if (body && body.sid && body.event) broadcastTo(String(body.sid), body.event);
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/send") {
        const body = await readBody(req);
        if (body && body.sid) activeSid = String(body.sid);
        const text = (body && body.text ? String(body.text) : "").trim();
        if (text) dispatchVoiceTurn(text);
        return sendJson(res, { ok: !!text });
    }

    if (req.method === "POST" && path === "/settings") {
        const body = await readBody(req);
        const prevLang = settings.language;
        const prevWake = settings.wakeWord;
        const prevPhrase = settings.wakePhrase;
        const prevTtsVoice = settings.ttsVoice;
        settings = { ...settings, ...sanitizeSettings(body) };
        await saveSettings();
        if (settings.language !== prevLang) {
            workerSend({ cmd: "set", language: settings.language });
        }
        if (settings.ttsVoice !== prevTtsVoice) {
            lastTtsPreviewSid = body && body.sid ? String(body.sid) : activeSid;
            workerSend({ cmd: "tts_voice", voice: settings.ttsVoice });
        }
        if (settings.wakeWord !== prevWake || settings.wakePhrase !== prevPhrase) {
            ensureWorker();
            workerSend({ cmd: "wake", on: settings.wakeWord, phrases: [settings.wakePhrase] });
        }
        return sendJson(res, { ok: true, settings });
    }

    if (req.method === "POST" && path === "/check-update") {
        const r = await checkForUpdate({ force: true });
        const ok = r.status !== "error" && r.status !== "disabled";
        return sendJson(res, { ok, status: r.status, version: r.version, current: CURRENT_VERSION, error: r.error });
    }

    if (req.method === "GET" && path === "/mics") {
        ensureWorker();
        workerSend({ cmd: "list_mics" });
        return sendJson(res, { ok: true, ...lastMics });
    }

    if (req.method === "GET" && path === "/voices") {
        ensureWorker();
        workerSend({ cmd: "list_voices" });
        return sendJson(res, { ok: true, ...lastVoices });
    }

    if (req.method === "POST" && path === "/set-mic") {
        const body = await readBody(req);
        const dev = body && (body.device === null || typeof body.device === "number") ? body.device : null;
        settings.micDevice = dev;
        await saveSettings();
        ensureWorker();
        workerSend({ cmd: "set_mic", device: dev });
        return sendJson(res, { ok: true, device: dev });
    }

    if (req.method === "POST" && path === "/restart-worker") {
        manualRestartWorker();
        return sendJson(res, { ok: true });
    }

    if (req.method === "GET" && path.startsWith("/tts/")) {
        const name = basename(path);
        if (!/^[\w.\-]+\.wav$/.test(name)) {
            res.writeHead(404);
            res.end();
            return;
        }
        const file = join(TTS_DIR, name);
        const rs = createReadStream(file);
        rs.on("error", () => {
            if (!res.headersSent) res.writeHead(404);
            res.end();
        });
        res.on("close", () => rs.destroy()); 
        rs.once("open", () => {
            res.writeHead(200, { "Content-Type": "audio/wav" });
            rs.pipe(res);
        });
        return;
    }

    res.writeHead(404);
    res.end("not found");
}

function readSavedPort() {
    try {
        const n = Number(JSON.parse(readFileSync(PORT_FILE, "utf8"))?.port);
        if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
    } catch {
    }
    return 0;
}

function readSavedToken() {
    try {
        const t = JSON.parse(readFileSync(PORT_FILE, "utf8"))?.token;
        if (typeof t === "string" && /^[a-f0-9]{8,}$/.test(t)) return t;
    } catch {
    }
    return "";
}

function savePort(port) {
    try {
        writeFileSync(PORT_FILE, JSON.stringify({ port, token: sharedToken }));
    } catch (e) {
        log("savePort failed: " + e.message);
    }
}

function claimPortFileExclusive(port) {
    const tmp = PORT_FILE + "." + process.pid + ".tmp";
    try {
        writeFileSync(tmp, JSON.stringify({ port, token: sharedToken }));
        linkSync(tmp, PORT_FILE);
        return true;
    } catch (e) {
        if (e && e.code === "EEXIST") return false;
        log("claimPortFileExclusive failed: " + e.message);
        return false;
    } finally {
        try { unlinkSync(tmp); } catch { }
    }
}

function listenOnce(server, port) {
    return new Promise((resolve, reject) => {
        const onErr = (e) => {
            server.removeListener("listening", onOk);
            reject(e);
        };
        const onOk = () => {
            server.removeListener("error", onErr);
            resolve();
        };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, "127.0.0.1");
    });
}

function makeVoiceServer() {
    return createServer((req, res) => {
        handleRequest(req, res).catch((e) => {
            log("request error: " + e.message);
            try {
                res.writeHead(500);
                res.end();
            } catch {
            }
        });
    });
}

async function startServer() {
    const server = makeVoiceServer();

    let bound = 0;
    const canonical = preferredPort || readSavedPort();
    if (canonical) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await listenOnce(server, canonical);
                bound = canonical;
                break;
            } catch (e) {
                if (e && e.code === "EADDRINUSE") {
                    await new Promise((r) => setTimeout(r, 200));
                    continue;
                }
                break; 
            }
        }
    }
    let primary;
    if (bound) {
        primary = true; 
    } else {
        await listenOnce(server, 0);
        bound = server.address().port;
        if (canonical) {
            primary = false;
        } else {
            sharedToken = readSavedToken() || randomBytes(16).toString("hex");
            if (claimPortFileExclusive(bound)) {
                primary = true;
            } else {
                primary = false;
                dbg("cold-start: lost port-file race, becoming secondary");
            }
        }
    }

    if (primary) {
        primaryFork = true;
        if (!preferredPort) preferredPort = bound; 
        sharedToken = sharedToken || readSavedToken() || randomBytes(16).toString("hex");
        savePort(bound); 
    } else {
        sharedToken = readSavedToken(); 
    }
    myBaseUrl = `http://127.0.0.1:${bound}/`;
    if (!registered) {
        registered = true;
        registerSelf();
        if (!primary) {
            const t = setInterval(registerSelf, 4000);
            if (t.unref) t.unref();
            const pp = setInterval(probePrimary, 7000 + Math.floor(Math.random() * 3000));
            if (pp.unref) pp.unref();
        }
    }
    return { server, url: `http://127.0.0.1:${bound}/`, primary };
}

async function reclaimPrimaryIfOrphaned(reason) {
    if (primaryFork || reclaiming) return false;
    if (Date.now() - lastReclaimAttempt < 2000) return false;
    reclaiming = true;
    lastReclaimAttempt = Date.now();
    try {
        const canonical = preferredPort || readSavedPort();
        if (!canonical) return false;
        sharedToken = sharedToken || readSavedToken() || randomBytes(16).toString("hex");
        const server = makeVoiceServer();
        try {
            await listenOnce(server, canonical);
        } catch (e) {
            if (e && e.code === "EADDRINUSE") {
                sharedToken = readSavedToken() || sharedToken;
                return false;
            }
            try { server.close(); } catch { }
            return false;
        }
        promotedServer = server;
        primaryFork = true;
        preferredPort = canonical;
        myBaseUrl = `http://127.0.0.1:${canonical}/`;
        savePort(canonical);
        forks.set(mySid(), myBaseUrl);
        log(`reclaimPrimary: promoted to primary on ${canonical} (${reason})`);
        broadcast({ type: "worker", state: "loading", msg: "Reassumindo motor de voz…" });
        ensureWorker();
        return true;
    } finally {
        reclaiming = false;
    }
}

function probePrimary() {
    if (primaryFork) return;
    const base = canonicalBase();
    if (!base) return;
    let done = false;
    try {
        const u = new URL("/ping", base);
        const req = httpGet(
            { hostname: u.hostname, port: u.port, path: "/ping", timeout: 2500 },
            (res) => {
                res.on("data", () => { });
                res.on("end", () => { });
            },
        );
        req.on("error", (e) => {
            if (done) return;
            done = true;
            if (e && DEAD_PRIMARY_CODES.has(e.code)) reclaimPrimaryIfOrphaned("probe " + e.code).catch(() => { });
        });
        req.on("timeout", () => { try { req.destroy(); } catch { } });
    } catch { }
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
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = (primaryFork && primaryServerEntry) ? primaryServerEntry : await startServer();
            if (entry.primary) primaryServerEntry = entry;
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
session = await joinSession({
    canvases: [canvas],
    hooks: {
        onUserPromptSubmitted: async () => {
            if (!voiceInstructionPending) return undefined;
            voiceInstructionPending = false;
            let ctx = "";
            if (settings.authorSummary !== false) ctx += VOICE_SUMMARY_INSTRUCTION;
            if (settings.cueCheckpoints !== false) ctx += (ctx ? " " : "") + CHECKPOINT_INSTRUCTION;
            return ctx ? { additionalContext: ctx } : undefined;
        },
    },
});
session.on("assistant.message", onAssistantMessage);
session.on("session.idle", onIdle);
restoreVoiceState();
restoreAudioHistory();
restorePendingTurns();
startHeartbeat();
const _turnSweep = setInterval(drainAllPendingTurns, 5000);
if (_turnSweep.unref) _turnSweep.unref();
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
