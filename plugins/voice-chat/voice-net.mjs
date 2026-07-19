// voice-net.mjs — servidor HTTP + SSE LOCAL de cada fork (thin client).
//
// Cada session-fork é um cliente INDEPENDENTE: sobe o próprio servidor HTTP numa porta
// EFÊMERA que serve APENAS o próprio iframe. Sem porta canônica, sem eleição
// primário/secundário e sem roteamento cross-fork — o motor compartilhado vem do daemon
// vox-engine. Importa a lógica de negócio (fala, update, sessão) da entry — ciclo ESM
// seguro (chamadas só em runtime). Deriva os caminhos via voice-shared (sem TDZ cíclico).

import { createServer, Agent as HttpAgent } from "node:http";
import { createReadStream, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import shared from "./voice-shared.cjs";
import { dbg } from "./voice-core.mjs";
import { sseClients, setTurnOwnerSid } from "./voice-state.mjs";
import {
    ensureWorker, workerSend, manualRestartWorker, transcribeViaWorker,
    workerReady, lastVoices, lastMics, lastAppFocused,
} from "./voice-worker.mjs";
import { pushAudio, audioHistoryForHello, audioHistoryReadOnly, markPlayed } from "./voice-audio.mjs";
import {
    handleVoiceTranscript, claimVoiceOwnership, setRecordingActive, clearRecordingActive, startMonitor, stopMonitor,
    quiesceClosedPanelCapture, sessionHasClient, checkForUpdate, readUpdateState,
    writeUpdateState, effectiveVersion, pendingRestartVersion, saveSettings, drainPendingSpeak,
    sanitizeSettings, settings, setSettings, setLastTtsPreviewSid,
    session, RUNNING_AS_PLUGIN, CONVERSE_ONSET_MS, log, recordingActiveSid,
} from "./extension.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = shared.resolveDataDir();

// --- constantes de rede (derivadas localmente) ---
const IFRAME_FILE = join(EXT_DIR, "iframe.html");
const TTS_DIR = join(ARTIFACTS, "tts");
const TOKEN_FILE = join(ARTIFACTS, "server-port.json");   // porta EFÊMERA + token de loopback LOCAL desta fork (persistido p/ sobreviver a um reload; consumido por testes/probes p/ descobrir o servidor headless — nada em produção lê cross-fork)
const loopbackAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 });

// --- estado da rede (single-writer neste módulo) ---
let sharedToken = "";
let heartbeatTimer = null;

export function mySid() {
    return process.env.SESSION_ID || (session && session.sessionId) || "";
}

export function withSid(u, sid = mySid()) {
    // O token de loopback é entregue à canvas via cookie de mesma origem + injeção no
    // corpo do HTML (ver o handler GET /), nunca na query da URL do painel — assim não
    // vaza por referrer/histórico/log. A página lê o token para o header x-voice-token.
    return u + (u.includes("?") ? "&" : "?") + "sid=" + encodeURIComponent(sid);
}

export function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of sseClients.keys()) {
        try {
            res.write(line);
        } catch {
        }
    }
}

export function broadcastTo(sid, obj) {
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

export function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        for (const res of [...sseClients.keys()]) {
            try { res.write(": ping\n\n"); }
            catch { sseClients.delete(res); }
        }
    }, 15000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
}

export function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                // Buffer.concat + toString: `b += c` coage cada Buffer p/ string por chunk
                // (O(n²) em corpos grandes) E pode QUEBRAR um caractere UTF-8 multibyte
                // dividido entre dois chunks -> JSON.parse falharia. Concatenar os bytes e
                // decodificar 1x é mais rápido e correto.
                const b = Buffer.concat(chunks).toString("utf8");
                resolve(b ? JSON.parse(b) : {});
            } catch {
                resolve({});
            }
        });
    });
}

export function sendJson(res, obj, code = 200) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

export function cookieToken(req) {
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

export function tokenOK(req, url) {
    if (!sharedToken) return true; 
    // Header (POST), cookie de mesma origem (SSE, que não manda header) e query (fallback
    // legado, quando um webview cross-origin descarta o cookie) — todos aceitos.
    const got = req.headers["x-voice-token"] || cookieToken(req) || url.searchParams.get("t") || "";
    return got === sharedToken;
}

export async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    if ((req.method === "POST" || path === "/events" || path === "/audio") && !tokenOK(req, url)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "forbidden" }));
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
        if (sid) drainPendingSpeak(sid).catch(() => { });   // canvas conectou -> toca o que o hook coletou
        if (settings.wakeWord) {
            try { workerSend({ cmd: "wake", on: true, phrases: [settings.wakePhrase] }); } catch { }
        }
        const _us = readUpdateState();
        const pendingUpdate = pendingRestartVersion(_us);
        res.write(
            `data: ${JSON.stringify({
                type: "hello",
                settings,
                worker: workerReady ? "ready" : "loading",
                voices: lastVoices,
                appFocused: lastAppFocused,
                audioHistory: audioHistoryForHello(sid),
                pendingUpdate,
                version: effectiveVersion(_us),
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
            if (sid) {
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
        pushAudio(sid);
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
        setTurnOwnerSid(null);
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

    if (req.method === "POST" && path === "/played") {
        // O iframe confirmou que TOCOU um item até o fim -> avança o cursor DURÁVEL de
        // "ouvido". Fork LOCAL: aplica direto (nunca encaminha).
        const body = await readBody(req);
        const sid = body && body.sid ? String(body.sid) : "";
        const seq = body && Number.isFinite(body.seq) ? Math.floor(body.seq) : 0;
        if (sid && seq > 0) markPlayed(sid, seq);
        return sendJson(res, { ok: true });
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

    if (req.method === "POST" && path === "/send") {
        const body = await readBody(req);
        const text = (body && body.text ? String(body.text) : "").trim();
        if (text) handleVoiceTranscript(text);
        return sendJson(res, { ok: !!text });
    }

    if (req.method === "POST" && path === "/settings") {
        const body = await readBody(req);
        const prevLang = settings.language;
        const prevWake = settings.wakeWord;
        const prevPhrase = settings.wakePhrase;
        const prevTtsVoice = settings.ttsVoice;
        setSettings({ ...settings, ...sanitizeSettings(body) });
        await saveSettings();
        if (settings.language !== prevLang) {
            workerSend({ cmd: "set", language: settings.language });
        }
        if (settings.ttsVoice !== prevTtsVoice) {
            setLastTtsPreviewSid(mySid());   // o preview da nova voz toca no iframe DESTA sessão
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
        return sendJson(res, { ok, status: r.status, version: r.version, current: effectiveVersion(readUpdateState()), needsAppRestart: !!r.needsAppRestart, error: r.error });
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

    // GET /audio?sid=<sid>[&since=<seq>] — LEITURA PURA do histórico de áudio da sessão (contrato de
    // PARCEIRO, ex.: copilot-mobile). ZERO efeito colateral: NÃO drena pending, NÃO
    // avança cursor delivered/heard, NÃO persiste, NÃO liga worker. Só espelha o mesmo histórico que o
    // hello do /events entrega. Token-gated (x-voice-token), como o /events — carrega texto da sessão.
    // Retorna itens ordenados por seq asc; `since` filtra seq>since (polling incremental); sid sem áudio
    // ⇒ items:[] com 200. O wav de cada item fica em GET /tts/<name>.wav (busque logo: retenção enxuta).
    if (req.method === "GET" && path === "/audio") {
        const sid = url.searchParams.get("sid") || "";
        if (!sid) return sendJson(res, { ok: false, error: "missing sid" }, 400);
        const sinceRaw = url.searchParams.get("since");
        const since = sinceRaw != null ? parseInt(sinceRaw, 10) : 0;
        const { items } = audioHistoryReadOnly(sid, Number.isFinite(since) ? since : 0);
        return sendJson(res, { ok: true, sid, items, engineReady: workerReady });
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

export function readSavedToken() {
    try {
        const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"))?.token;
        if (typeof t === "string" && /^[a-f0-9]{8,}$/.test(t)) return t;
    } catch {
    }
    return "";
}

export function listenOnce(server, port) {
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

export function makeVoiceServer() {
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

export async function startServer() {
    // Cliente THIN por fork: servidor HTTP LOCAL numa porta EFÊMERA que serve APENAS o
    // próprio iframe. Sem porta canônica, sem eleição, sem registry — o motor compartilhado
    // vem do daemon vox-engine. O token de loopback é LOCAL (carregado do disco p/ sobreviver
    // a um reload da fork, ou gerado) e injetado no HTML/cookie da própria canvas.
    sharedToken = sharedToken || readSavedToken() || randomBytes(16).toString("hex");
    const server = makeVoiceServer();
    await listenOnce(server, 0);
    const bound = server.address().port;
    // Breadcrumb de descoberta do servidor DESTA fork (porta efêmera + token). Persistido p/
    // sobreviver a um reload e p/ o boot headless (harness/probes) achar o servidor. Cada fork
    // escreve o SEU; nada em produção lê isto cross-fork (iframe recebe a URL pela canvas; o
    // Stop hook usa o heartbeat forks/<sid>.json).
    try { writeFileSync(TOKEN_FILE, JSON.stringify({ port: bound, token: sharedToken })); } catch (e) { log("savePort failed: " + e.message); }
    return { server, url: `http://127.0.0.1:${bound}/`, primary: true };
}
