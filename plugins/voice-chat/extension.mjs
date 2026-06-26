
import { createServer, request as httpRequest, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, sep } from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync, copyFileSync } from "node:fs";
import { setPriority, constants as osConstants, homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
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
const PENDING_REPLIES_FILE = join(ARTIFACTS, "pending-replies.json");
const IFRAME_FILE = join(EXT_DIR, "iframe.html");
const WORKER_FILE = join(EXT_DIR, "voice_worker.py");
const TTS_SCRIPT = join(EXT_DIR, "tts.ps1");
const DEBUG_LOG = join(ARTIFACTS, "debug.log");
const VOICE_STATE_FILE = join(ARTIFACTS, "voice-state.json");
const PORT_FILE = join(ARTIFACTS, "server-port.json");

const CURRENT_VERSION = "1.1.7";
const UPDATE_RAW_BASE = (process.env.VOICE_UPDATE_BASE || "https://github.com/AllanSantos-DV/copilot-voice/releases/latest/download/").replace(/\/?$/, "/");
const RUNNING_AS_PLUGIN = /[\\/]installed-plugins[\\/]/.test(EXT_DIR);
const UPDATE_DISABLED = process.env.VOICE_UPDATE_DISABLED === "1" || RUNNING_AS_PLUGIN;
const UPDATE_THROTTLE_MS = Number(process.env.VOICE_UPDATE_THROTTLE_MS) || 0;
const UPDATE_STATE_FILE = join(ARTIFACTS, "update-state.json");
const UPDATABLE_FILES = new Set(["extension.mjs", "voice_worker.py", "iframe.html", "tts.ps1", "requirements.txt"]);

const PY_CANDIDATES = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

const CONVERSE_ONSET_MS = Number(process.env.VOICE_CONVERSE_ONSET_MS) || 20000;

let session; 

const sseClients = new Map(); 
const servers = new Map(); 
let preferredPort = 0;
let sharedToken = "";
let primaryFork = false;

const forks = new Map(); 
let activeSid = null; 
let turnOwnerSid = null; 
const pendingReplyAudio = new Map(); 
let myBaseUrl = null; 
let registered = false; 
function mySid() {
    return process.env.SESSION_ID || (session && session.sessionId) || "";
}
function canonicalBase() {
    const p = preferredPort || readSavedPort();
    return p ? `http://127.0.0.1:${p}/` : null;
}
function withSid(u) {
    let out = u + (u.includes("?") ? "&" : "?") + "sid=" + encodeURIComponent(mySid());
    if (sharedToken) out += "&t=" + encodeURIComponent(sharedToken);
    return out;
}
const VALID_MODELS = ["auto", "tiny", "base", "small", "turbo", "large-v3"];
const TTS_VOICES = [
    { id: "vits-piper-pt_BR-cadu-medium",   label: "Cadu",     summary: "Timbre mais cheio e natural, fundo mais silencioso no geral. Recomendada como padrão." },
    { id: "vits-piper-pt_BR-dii-high",      label: "Dii",      summary: "A mais limpa nos agudos — chiado quase nulo. Boa se o 'sss' te incomoda." },
    { id: "vits-piper-pt_BR-edresson-low",  label: "Edresson", summary: "Voz mais grave e encorpada. Leve na CPU, qualidade básica (modelo low)." },
    { id: "vits-piper-pt_BR-faber-medium",  label: "Faber",    summary: "Voz neutra e clara. Equilíbrio entre naturalidade e leveza." },
    { id: "vits-piper-pt_BR-jeff-medium",   label: "Jeff",     summary: "Voz jovem. Pronúncia um pouco menos precisa em termos técnicos." },
    { id: "vits-piper-pt_BR-miro-high",     label: "Miro",     summary: "Alta definição, mas com mais chiado de fundo. Era a voz antiga padrão." },
];
const VALID_TTS_VOICES = TTS_VOICES.map(v => v.id);
const DEFAULT_SETTINGS = {
    voice: "Microsoft Maria Desktop",
    rate: 0,
    model: "auto",
    language: "pt",
    fullRead: false,
    speakAll: false,
    ttsVoice: "vits-piper-pt_BR-cadu-medium",
    ttsSid: 0,
    authorSummary: true,
    confirmTranscript: false,
    cueStart: true,
    cueCheckpoints: true,
    wakeWord: false,
    wakePhrase: "escuta jarvis",
    handsfree: false,
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
let crashCount = 0;
const WORKER_STABLE_MS = 30000;
let readyAt = 0;
let stabilityTimer = null;
let intentionalRestart = false;
let lastGpuStatus = null;
let lastDevice = "cpu";

let pendingVoiceTurn = false;
let voiceInstructionPending = false; 
let spokenCheckpoints = new Set(); 
let latestReply = "";
let lastSpokenContent = "";
let idleFallback = null;
const IDLE_FALLBACK_MS = 180000; 
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
    if (typeof b.ttsVoice === "string" && VALID_TTS_VOICES.includes(b.ttsVoice)) out.ttsVoice = b.ttsVoice;
    if (typeof b.rate === "number" && b.rate >= -10 && b.rate <= 10) out.rate = Math.round(b.rate);
    if (typeof b.model === "string" && VALID_MODELS.includes(b.model)) out.model = b.model;
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
    if (!sid) return broadcast(obj);
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const [res, csid] of sseClients) {
        if (csid && csid !== sid) continue;
        try {
            res.write(line);
        } catch {
        }
    }
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
let _caBundle = null;
function caBundle() {
    if (_caBundle) return _caBundle;
    let sys = [];
    try { sys = tls.getCACertificates("system") || []; } catch { sys = []; }
    _caBundle = [...(tls.rootCertificates || []), ...sys];
    return _caBundle;
}
function fetchBuf(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        const getter = new URL(url).protocol === "http:" ? httpGet : httpsGet;
        const req = getter(url, { headers: { "User-Agent": "voice-chat-updater", Accept: "*/*" }, ca: caBundle() }, (res) => {
            const sc = res.statusCode || 0;
            if (sc >= 300 && sc < 400 && res.headers.location && redirects < 5) {
                res.resume();
                resolve(fetchBuf(new URL(res.headers.location, url).toString(), redirects + 1));
                return;
            }
            if (sc !== 200) {
                res.resume();
                reject(new Error("HTTP " + sc));
                return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    });
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
        const manifest = JSON.parse((await fetchBuf(UPDATE_RAW_BASE + "manifest.json")).toString("utf8"));
        const remoteVer = manifest && manifest.version;
        if (!remoteVer || !verGt(remoteVer, CURRENT_VERSION)) return { status: "uptodate", version: CURRENT_VERSION };
        if (st.pendingVersion === remoteVer) {
            broadcast({ type: "update", version: remoteVer });
            return { status: "pending", version: remoteVer };
        }
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const staged = [];
        for (const f of files) {
            const rel = typeof f === "string" ? f : f && f.path;
            if (!rel || rel.includes("/") || rel.includes("\\") || rel.includes("..") || !UPDATABLE_FILES.has(rel)) {
                dbg("update: skipping unsafe/unlisted file " + rel);
                continue;
            }
            const buf = await fetchBuf(UPDATE_RAW_BASE + rel);
            const want = typeof f === "object" ? f.sha256 : null;
            if (want && sha256Hex(buf) !== want) throw new Error("sha256 mismatch for " + rel);
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

function ensureWorker() {
    if (worker || workerStarting || !primaryFork) return;
    startWorker();
}

function startWorker() {
    workerStarting = true;
    const py = PY_CANDIDATES[pyIndex % PY_CANDIDATES.length];
    const env = {
        ...process.env,
        VOICE_MODEL: settings.model,
        VOICE_MODEL_ROOT: MODELS_DIR,
        VOICE_LANG: settings.language,
        VOICE_TTS_MODEL: settings.ttsVoice,
        VOICE_WAKE_PHRASES: settings.wakePhrase || "escuta jarvis",
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
        if (ev.event === "ready") sawReady = true;
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
    workerStarting = false; 
}

function tryNextPy(reason) {
    pyIndex++;
    if (pyIndex < PY_CANDIDATES.length) {
        log(`retry python candidate '${PY_CANDIDATES[pyIndex]}' (${reason})`);
        setTimeout(startWorker, 200);
    } else {
        broadcast({
            type: "worker",
            state: "error",
            msg: "Não foi possível iniciar o Python do motor de voz.",
        });
    }
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

function onWorkerEvent(ev) {
    switch (ev.event) {
        case "ready":
            workerReady = true;
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
            broadcast({ type: "worker", state: "loading", msg: ev.msg, pct: ev.pct });
            break;
        case "level":
            broadcast({ type: "level", rms: ev.rms, peak: ev.peak });
            break;
        case "recording":
            broadcast({ type: "recording", state: ev.state });
            break;
        case "transcript": {
            const t = (ev.text || "").trim();
            const confirm = settings.confirmTranscript === true && !!t;
            const owner = turnOwnerSid || activeSid;
            turnOwnerSid = null;
            broadcastTo(owner, { type: "transcript", text: ev.text || "", confirm });
            if (t && !confirm) dispatchVoiceTurn(t, owner);
            break;
        }
        case "error":
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
        case "tts_voice":
            broadcast({ type: "worker", state: "voiceReady" });
            if (ev.ok) previewVoice();
            else if (ev.msg) broadcast({ type: "error", msg: ev.msg });
            break;
        case "wake":
            broadcast({ type: "wake", state: ev.state, phrase: ev.phrase, msg: ev.msg });
            break;
        case "gpu_status":
            lastGpuStatus = ev;
            broadcast({ type: "gpu", status: ev });
            break;
        case "gpu_setup":
            broadcast({ type: "gpuSetup", ok: !!ev.ok, msg: ev.msg,
                        needsCuda: !!ev.needsCuda, restart: !!ev.restart });
            if (ev.restart) restartWorker();
            break;
        case "command": {
            const c = (ev.text || "").trim();
            dbg(`wake command: ${c.slice(0, 120)}`);
            if (c) {
                broadcastTo(activeSid, { type: "transcript", text: c, confirm: false });
                dispatchVoiceTurn(c, activeSid);
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
    const target = want && forks.has(want) ? want : mySid();
    if (target === mySid()) {
        handleVoiceTranscript(t);
        return;
    }
    const url = forks.get(target);
    dbg(`dispatchVoiceTurn -> sid=${target} url=${url}`);
    httpPostJson(url, "/inject", { text: t }).then((ok) => {
        if (!ok) {
            dbg(`dispatch to sid=${target} failed — running locally`);
            handleVoiceTranscript(t);
        }
    });
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
    if (!pendingVoiceTurn && !(primaryFork && settings.speakAll)) return;
    _phase = "reply:msg";
    dbg(
        `onAssistantMessage: agentId=${event?.agentId ?? "(root)"} len=${
            event?.data?.content ? event.data.content.length : 0
        }`,
    );
    if (event?.agentId) return; 
    const content = event?.data?.content;
    armIdleFallback();
    if (typeof content === "string" && content.trim()) {
        latestReply = content;
        maybeSpeakCheckpoints(content);
    }
}

function maybeSpeakCheckpoints(content) {
    if (!pendingVoiceTurn || settings.cueCheckpoints === false) return;
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
    if (!pendingVoiceTurn && !(primaryFork && settings.speakAll)) return; 
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
    if (pendingVoiceTurn && settings.authorSummary && latestReply && !latestReply.includes(VOICE_SENTINEL)) {
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
    if (!pendingVoiceTurn && !settings.speakAll) return;
    if (content === lastSpokenContent) {
        pendingVoiceTurn = false;
        clearVoiceState();
        return;
    }
    lastSpokenContent = content;
    pendingVoiceTurn = false;
    clearVoiceState();

    const { spoken, full } = makeSpoken(content);
    let speakText = settings.fullRead ? full : spoken;
    if (!speakText) {
        speakText = "A resposta não tem texto para ler em voz alta. Confira o chat para os detalhes.";
    }
    const fullForUi = full && full !== speakText ? full : undefined;

    _phase = "flushSpeech:speak";
    if (primaryFork) {
        await speakToCanvas(mySid(), speakText, fullForUi);
    } else {
        const base = canonicalBase();
        if (base) await httpPostJson(base, "/speak", { sid: mySid(), spoken: speakText, full: fullForUi });
    }
    _phase = "flushSpeech:done";
}

async function speakToCanvas(sid, spoken, full, cue) {
    if (cue) {
        broadcastTo(sid, { type: "cue", kind: cue, spoken });
        try {
            const wav = await synthesize(spoken);
            if (canPlayInSession(sid)) broadcastTo(sid, { type: "cue", kind: cue, spoken, audio: "/tts/" + wav });
        } catch (e) {
            dbg("speakToCanvas cue tts failed: " + (e && e.message));
        }
        return;
    }
    broadcastTo(sid, { type: "reply", spoken, full });
    try {
        const wav = await synthesize(spoken);
        const msg = { type: "reply", spoken, full, audio: "/tts/" + wav };
        if (canPlayInSession(sid)) {
            clearPendingReply(sid);
            broadcastTo(sid, msg);
        } else {
            pendingReplyAudio.set(sid, msg);
            writePendingReply(sid, { spoken, full, wav, ts: Date.now() });
            dbg(`held reply audio for sid=${sid} (active=${activeSid})`);
        }
    } catch (e) {
        log("tts failed: " + e.message);
        broadcastTo(sid, { type: "error", msg: "Falha na síntese de voz: " + e.message });
    }
}

function canPlayInSession(sid) {
    return !sid || !activeSid || sid === activeSid;
}

async function speakCue(text, kind) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    if (primaryFork) {
        await speakToCanvas(mySid(), clean, undefined, kind);
    } else {
        const base = canonicalBase();
        if (base) await httpPostJson(base, "/speak", { sid: mySid(), spoken: clean, cue: kind });
    }
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
        log("worker tts failed, falling back to SAPI: " + e.message);
        const txtFile = join(TTS_DIR, `say-${id}.txt`);
        await writeFile(txtFile, speakText, "utf8");
        try {
            await runTts(txtFile, wavFile);
        } finally {
            unlink(txtFile).catch(() => {});
        }
    }
    cleanupOldWavs().catch(() => {});
    return basename(wavFile);
}

async function previewVoice() {
    try {
        const wav = await synthesize("Voz alterada. Agora estou falando assim.");
        broadcast({ type: "voicePreview", audio: "/tts/" + wav });
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

function runTts(txtFile, wavFile) {
    return new Promise((resolve, reject) => {
        if (process.platform !== "win32") {
            reject(new Error("SAPI fallback is Windows-only"));
            return;
        }
        const args = [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            TTS_SCRIPT,
            "-TextFile",
            txtFile,
            "-Out",
            wavFile,
            "-Voice",
            settings.voice,
            "-Rate",
            String(settings.rate),
        ];
        const ps = spawn("powershell.exe", args, { windowsHide: true });
        let err = "";
        ps.stderr.on("data", (d) => (err += d.toString()));
        ps.on("error", reject);
        ps.on("exit", (code) => {
            if (code === 0 && existsSync(wavFile)) resolve();
            else reject(new Error(`tts exit ${code}: ${err.slice(0, 240)}`));
        });
    });
}

function readPendingMap() {
    try { return JSON.parse(readFileSync(PENDING_REPLIES_FILE, "utf8")) || {}; } catch { return {}; }
}
function writePendingMap(map) {
    try { writeFileSync(PENDING_REPLIES_FILE, JSON.stringify(map)); } catch {  }
}
function writePendingReply(sid, obj) {
    if (!sid) return;
    const map = readPendingMap();
    map[String(sid)] = obj;
    writePendingMap(map);
}
function readPendingReply(sid) {
    if (!sid) return null;
    const map = readPendingMap();
    return map[String(sid)] || null;
}
function clearPendingReply(sid) {
    if (!sid) return;
    const map = readPendingMap();
    if (map[String(sid)]) { delete map[String(sid)]; writePendingMap(map); }
}

async function cleanupOldWavs() {
    try {
        const files = (await readdir(TTS_DIR)).filter((f) => f.endsWith(".wav"));
        if (files.length <= 8) return;
        const withTime = await Promise.all(
            files.map(async (f) => ({ f, m: (await stat(join(TTS_DIR, f))).mtimeMs })),
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
            req.on("error", () => resolve(false));
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

function tokenOK(req, url) {
    if (!sharedToken) return true; 
    const got = req.headers["x-voice-token"] || url.searchParams.get("t") || "";
    return got === sharedToken;
}

function claimVoiceOwnership(sid) {
    if (!sid) return;
    const s = String(sid);
    activeSid = s;
    turnOwnerSid = s;
    pendingReplyAudio.delete(s);
}

async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    if ((req.method === "POST" || path === "/events") && !tokenOK(req, url)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "forbidden" }));
        return;
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        try {
            const html = await readFile(IFRAME_FILE, "utf8");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        } catch (e) {
            res.writeHead(500);
            res.end("iframe load error: " + e.message);
        }
        return;
    }

    if (req.method === "GET" && path === "/events") {
        const sid = url.searchParams.get("sid") || "";
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        sseClients.set(res, sid);
        if (sid) activeSid = sid; 
        const _us = readUpdateState();
        const pendingUpdate = _us.pendingVersion && verGt(_us.pendingVersion, CURRENT_VERSION) ? _us.pendingVersion : null;
        const _pr = readPendingReply(sid);
        const pendingReply = (_pr && _pr.wav && existsSync(join(TTS_DIR, _pr.wav)))
            ? { spoken: _pr.spoken, full: _pr.full, audio: "/tts/" + _pr.wav }
            : null;
        res.write(
            `data: ${JSON.stringify({
                type: "hello",
                settings,
                worker: workerReady ? "ready" : "loading",
                pendingUpdate,
                version: CURRENT_VERSION,
                pluginManaged: RUNNING_AS_PLUGIN,
                pendingReply,
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
        req.on("close", () => sseClients.delete(res));
        ensureWorker();
        return;
    }

    if (req.method === "POST" && path === "/rec/start") {
        const body = await readBody(req);
        if (body && body.sid) claimVoiceOwnership(body.sid); 
        ensureWorker();
        workerSend({ cmd: "start" });
        return sendJson(res, { ok: true });
    }
    if (req.method === "POST" && path === "/rec/stop") {
        workerSend({ cmd: "stop" });
        return sendJson(res, { ok: true });
    }
    if (req.method === "POST" && path === "/rec/cancel") {
        workerSend({ cmd: "cancel" });
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
            forks.set(String(body.sid), String(body.url));
            dbg(`registered fork sid=${body.sid}`);
        }
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/focus") {
        const body = await readBody(req);
        if (body && body.sid) {
            activeSid = String(body.sid);
            const held = pendingReplyAudio.get(activeSid);
            if (held) {
                pendingReplyAudio.delete(activeSid);
                broadcastTo(activeSid, held);
                dbg(`flushed held reply -> sid=${activeSid}`);
            }
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
        if (text) handleVoiceTranscript(text);
        return sendJson(res, { ok: !!text });
    }

    if (req.method === "POST" && path === "/speak") {
        const body = await readBody(req);
        const spoken = String((body && body.spoken) || "").trim();
        const sid = body && body.sid ? String(body.sid) : "";
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
        const prevModel = settings.model;
        const prevLang = settings.language;
        const prevWake = settings.wakeWord;
        const prevPhrase = settings.wakePhrase;
        const prevTtsVoice = settings.ttsVoice;
        settings = { ...settings, ...sanitizeSettings(body) };
        await saveSettings();
        if (settings.model !== prevModel || settings.language !== prevLang) {
            workerSend({ cmd: "set", model: settings.model, language: settings.language });
        }
        if (settings.ttsVoice !== prevTtsVoice) {
            workerSend({ cmd: "tts_voice", voice: settings.ttsVoice });
        }
        if (settings.wakeWord !== prevWake || settings.wakePhrase !== prevPhrase) {
            ensureWorker();
            workerSend({ cmd: "wake", on: settings.wakeWord, phrases: [settings.wakePhrase] });
        }
        return sendJson(res, { ok: true, settings });
    }

    if (req.method === "POST" && path === "/reply-played") {
        const body = await readBody(req);
        clearPendingReply(body && body.sid ? body.sid : activeSid);
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/check-update") {
        const r = await checkForUpdate({ force: true });
        const ok = r.status !== "error" && r.status !== "disabled";
        return sendJson(res, { ok, status: r.status, version: r.version, current: CURRENT_VERSION, error: r.error });
    }

    if (req.method === "GET" && path === "/gpu-status") {
        ensureWorker();
        workerSend({ cmd: "gpu_status" });
        return sendJson(res, { ok: true, status: lastGpuStatus, device: lastDevice });
    }

    if (req.method === "POST" && path === "/gpu-setup") {
        ensureWorker();
        const sent = workerSend({ cmd: "gpu_setup" });
        return sendJson(res, { ok: sent });
    }

    if (req.method === "POST" && path === "/restart-worker") {
        broadcast({ type: "worker", state: "loading", msg: "Reiniciando motor de voz…" });
        restartWorker();
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

async function startServer() {
    const server = createServer((req, res) => {
        handleRequest(req, res).catch((e) => {
            log("request error: " + e.message);
            try {
                res.writeHead(500);
                res.end();
            } catch {
            }
        });
    });

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
        primary = !canonical;
    }

    if (primary) {
        primaryFork = true;
        if (!preferredPort) preferredPort = bound; 
        sharedToken = readSavedToken() || randomBytes(16).toString("hex");
        savePort(bound); 
    } else {
        sharedToken = readSavedToken(); 
    }
    myBaseUrl = `http://127.0.0.1:${bound}/`;
    if (!registered) {
        registered = true;
        registerSelf();
        if (!primary) {
            const t = setInterval(registerSelf, 15000);
            if (t.unref) t.unref();
        }
    }
    return { server, url: `http://127.0.0.1:${bound}/`, primary };
}

const canvas = createCanvas({
    id: "voice-chat",
    displayName: "Voz",
    description:
        "Converse por voz com o Copilot: fale e ouça um resumo falado da resposta (Whisper local para transcrição + voz local pt-BR).",
    actions: [
        {
            name: "speak",
            description: "Sintetiza e reproduz um texto em voz alta no painel de voz (TTS local pt-BR).",
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
                if (primaryFork) {
                    await speakToCanvas(mySid(), speakText, fullForUi);
                } else {
                    const base = canonicalBase();
                    if (base) await httpPostJson(base, "/speak", { sid: mySid(), spoken: speakText, full: fullForUi });
                }
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
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer();
            servers.set(ctx.instanceId, entry);
        }
        if (entry.primary) {
            ensureWorker();
            checkForUpdate().catch(() => {});
            return {
                title: "Voz",
                url: withSid(entry.url),
                status: workerReady ? "Pronto" : "Iniciando…",
            };
        }
        const canonical = readSavedPort();
        const url = withSid(canonical ? `http://127.0.0.1:${canonical}/` : entry.url);
        return { title: "Voz", url, status: "Pronto" };
    },
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
            servers.delete(ctx.instanceId);
            await new Promise((r) => entry.server.close(() => r()));
        }
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
