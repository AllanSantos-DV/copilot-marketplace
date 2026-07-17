// voice-worker.mjs — ciclo de vida do worker Python (motor de voz) + camada TTS/STT.
//
// Dono de TODO o estado do worker (single-writer): processo, prontidão, watchdog de boot,
// auto-heal de wedge, catálogos de device/mic/voz. Importa da entry (ciclo ESM, seguro:
// declarações de função hoistadas + live-bindings lidos só em runtime) os pontos de saída
// para UI/roteamento. O motor em si é instalado/atualizado pelo SDK (vox_sdk), não aqui.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setPriority, constants as osConstants } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readdir, unlink, stat, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import shared from "./voice-shared.cjs";
import { dbg } from "./voice-core.mjs";
import { buildPythonCandidates, savePythonPath } from "./voice-python.mjs";
import {
    activeSid, turnOwnerSid, setTurnOwnerSid, monitorSid, primaryFork,
    pendingTts, pendingTranscribe, audioHistoryBySid,
} from "./voice-state.mjs";
import { broadcast, broadcastTo } from "./voice-net.mjs";
import {
    dispatchVoiceTurn, clearRecordingActive, log, settings, saveSettings,
    handingOver, lastTtsPreviewSid, DEBUG_LOG, tmark, timingEnabled,
} from "./extension.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = shared.resolveDataDir();
const MODELS_DIR = join(ARTIFACTS, "models");
const TTS_DIR = join(ARTIFACTS, "tts");
const WORKER_FILE = join(EXT_DIR, "voice_worker.py");
const WORKER_STABLE_MS = 30000;

// --- estado do worker (single-writer neste módulo) ---
let worker = null;
export let workerReady = false;
let workerStarting = false;
let pyIndex = 0;
let pyCandidates = null;   // concrete interpreters for the current start sequence
let pyExhaustCount = 0;    // consecutive full-discovery exhaustions (bounded retry)
let activePy = "";         // interpreter used by the in-flight start (cached on ready)
let crashCount = 0;
let readyAt = 0;
let workerStartAt = 0;
let lastLoadingMsg = "";
let lastLoadingAt = 0;
let lastLoadingBusy = false;   // a última fase de "loading" é uma operação LONGA e LEGÍTIMA (install/update do motor)? Se sim, o watchdog NÃO reinicia (matar no meio do install corromperia o venv).
let startupWatchdog = null;
let stabilityTimer = null;
let intentionalRestart = false;
let wedgeRestarts = 0;   // auto-reinícios consecutivos de um boot TRAVADO (worker vivo, mudo e que nunca ficou pronto); zerado ao ficar pronto, limitado por WEDGE_MAX_RESTARTS.
export let lastDevice = "cpu";
export let lastMics = { devices: [], current: null, default: null };
export let lastVoices = { voices: [], supported: [], default: null };
let ttsSeq = 0;

export function ensureWorker() {
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
        if (handingOver) return;   // handover de versão: a fork NOVA abre o worker; não respawn aqui (evita 2 workers)
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

export function workerSend(obj) {
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

export function restartWorker() {
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
export function manualRestartWorker() {
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
            setTurnOwnerSid(null);
            clearRecordingActive();
            broadcastTo(owner, { type: "transcript", text: ev.text || "", confirm, note: ev.note, peak: ev.peak, micOk: ev.micOk });
            if (t && !confirm) {
                if (timingEnabled()) dbg(`[timing] transcript-ready sid=${owner} decode=${ev.ms}ms audio=${ev.dur_ms}ms chars=${t.length} confirm=${confirm}`);
                tmark("recv", { ms: ev.ms, dur_ms: ev.dur_ms });
                dispatchVoiceTurn(t, owner);
            }
            break;
        }
        case "error":
            clearRecordingActive();
            setTurnOwnerSid(null);
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
        case "mic-fallback":
            // o mic selecionado sumiu (ex.: bluetooth descarregou) e o worker voltou ao padrão
            // do Windows sozinho. LIMPA o pino PERSISTIDO — senão o próximo spawn re-envia o
            // índice morto (VOICE_MIC_DEVICE) e, como os índices do PortAudio deslocam quando
            // um device some, poderia casar OUTRO microfone vivo e capturar o errado calado.
            // MAS só limpa se ainda for o índice que MORREU (ev.from): sob flapping (BT cai->volta
            // e o user re-seleciona antes do evento chegar) não pisa na reseleção nova.
            if (settings.micDevice != null && (ev.from == null || settings.micDevice === ev.from)) {
                settings.micDevice = null; saveSettings().catch(() => { });
            }
            broadcast({ type: "mic-fallback", to: ev.to || "default" });
            break;
        case "voices":
            // Catálogo do motor (fonte única). ok:false / lista vazia é repassado como
            // está — a UI mostra "vozes indisponíveis" ALTO, sem mascarar com lista local.
            lastVoices = { voices: Array.isArray(ev.voices) ? ev.voices : [], supported: Array.isArray(ev.supported) ? ev.supported : [], default: ev.default_voice ?? null };
            broadcast({ type: "voices", ...lastVoices, ok: ev.ok, msg: ev.msg });
            break;
        case "command": {
            const c = (ev.text || "").trim();
            dbg(`wake command: ${c.slice(0, 120)}`);
            if (c) {
                const owner = turnOwnerSid || activeSid;
                setTurnOwnerSid(null);
                broadcastTo(owner, { type: "transcript", text: c, confirm: false });
                if (timingEnabled()) dbg(`[timing] transcript-ready(cmd) sid=${owner} decode=${ev.ms}ms audio=${ev.dur_ms}ms chars=${c.length}`);
                tmark("recv", { ms: ev.ms, dur_ms: ev.dur_ms });
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

export async function synthesize(text) {
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

export function transcribeViaWorker(path) {
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

export function shutdownWorkerForHandover() {
    if (!worker) return;
    try { workerSend({ cmd: "shutdown" }); } catch { }
    try { worker.kill(); } catch { }
    worker = null; workerReady = false; workerStarting = false;
}
