// voice-net.mjs — servidor HTTP + SSE + coordenação primário/secundário entre forks.
//
// Dono do servidor de voz de cada fork: bind/handover da porta canônica, autenticação
// por token, roteamento (handleRequest) e o protocolo de eleição primário<->secundário.
// Importa a lógica de negócio (fala, update, sessão) da entry — ciclo ESM seguro (chamadas
// só em runtime). Deriva os próprios caminhos via voice-shared (sem TDZ de import cíclico).

import { createServer, request as httpRequest, get as httpGet, Agent as HttpAgent } from "node:http";
import { createReadStream, readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import shared from "./voice-shared.cjs";
import { dbg } from "./voice-core.mjs";
import { cleanForSpeech } from "./voice-text.mjs";
import { shouldStepDownForNewer } from "./voice-update.mjs";
import {
    sseClients, servers, forks, forkSeen, forkVersions, recentSpoken,
    activeSid, setActiveSid, primaryFork, setPrimaryFork, myBaseUrl, setMyBaseUrl,
    registered, setRegistered, setTurnOwnerSid, sessionDead,
} from "./voice-state.mjs";
import {
    ensureWorker, workerSend, manualRestartWorker, transcribeViaWorker,
    shutdownWorkerForHandover, workerReady, lastDevice, lastVoices, lastMics,
} from "./voice-worker.mjs";
import { pushAudio, audioHistoryForHello, audioHistoryReadOnly, markPlayed, reloadAudioStateFromDisk } from "./voice-audio.mjs";
import { injectTurn, drainTurnsToFork } from "./voice-turns.mjs";
import {
    speakToCanvas, claimVoiceOwnership, setRecordingActive, clearRecordingActive, startMonitor, stopMonitor,
    quiesceClosedPanelCapture, sessionHasClient, drainAllPendingSpeak, checkForUpdate, readUpdateState,
    writeUpdateState, effectiveVersion, pendingRestartVersion, saveSettings, dispatchVoiceTurn, drainPendingSpeak,
    sanitizeSettings,
    settings, setSettings, handingOver, setHandingOver, setLastTtsPreviewSid, primaryServerEntry, setPrimaryServerEntry,
    session, CURRENT_VERSION, FORK_TTL_MS, HANDOVER_GRACE_MS, RUNNING_AS_PLUGIN, CONVERSE_ONSET_MS, DEBUG_LOG, log,
    recordingActiveSid,
} from "./extension.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = shared.resolveDataDir();

// --- constantes de rede (derivadas localmente) ---
const IFRAME_FILE = join(EXT_DIR, "iframe.html");
const TTS_DIR = join(ARTIFACTS, "tts");
const PORT_FILE = join(ARTIFACTS, "server-port.json");
const DEAD_PRIMARY_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);
const HANDOVER_LOCK_FILE = join(ARTIFACTS, "handover.lock");
const HTTP_POST_TIMEOUT_MS = 30000;   // teto p/ um POST entre forks. /inject agora AGUARDA session.send; sem teto, um send VIVO travado deixaria o req pendurado -> drainingTurns(sid) nunca liberado -> a fila daquele sid emperra. No timeout resolvemos false: o turno segue na fila e re-roteia.
const loopbackAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 });

// --- estado da rede (single-writer neste módulo) ---
let preferredPort = 0;
let sharedToken = "";
let reclaiming = false;
let lastReclaimAttempt = 0;
let promotedServer = null;
let suppressReclaimUntil = 0;        // após ceder, NÃO reassumir a porta por um tempo (deixa a nova pegar; ANTI-FLAP)
let secondaryTimersOn = false;       // timers de re-registro/probe (idempotente entre startServer e step-down)
let heartbeatTimer = null;
let _secRegTimer = null, _secProbeTimer = null;

export function mySid() {
    return process.env.SESSION_ID || (session && session.sessionId) || "";
}

export function canonicalBase() {
    const p = preferredPort || readSavedPort();
    return p ? `http://127.0.0.1:${p}/` : null;
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

export function forwardToPrimary(path, body) {
    const base = canonicalBase();
    return base ? httpPostJson(base, path, body) : Promise.resolve(false);
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

export function registerSelf() {
    if (!myBaseUrl) return;
    if (sessionDead) return;   // fork morta não se anuncia: deixa a fork viva desta sessão assumir o roteamento
    if (!primaryFork && myBaseUrl === canonicalBase()) return;   // INVARIANTE ESTRUTURAL: uma não-primária NUNCA anuncia a porta canônica (senão vaza esta sessão p/ o novo primário). Independe de handingOver.
    if (primaryFork) {
        setFork(mySid(), myBaseUrl);
        return;
    }
    const base = canonicalBase();
    if (base) httpPostJson(base, "/register", { sid: mySid(), url: myBaseUrl, version: CURRENT_VERSION });
}

export function ensureSecondaryTimers() {
    if (secondaryTimersOn) return;
    secondaryTimersOn = true;
    _secRegTimer = setInterval(registerSelf, 4000);
    if (_secRegTimer.unref) _secRegTimer.unref();
    _secProbeTimer = setInterval(probePrimary, 7000 + Math.floor(Math.random() * 3000));
    if (_secProbeTimer.unref) _secProbeTimer.unref();
}

export function stopSecondaryTimers() {
    if (_secRegTimer) { clearInterval(_secRegTimer); _secRegTimer = null; }
    if (_secProbeTimer) { clearInterval(_secProbeTimer); _secProbeTimer = null; }
    secondaryTimersOn = false;
}

export async function stepDownForNewer(newerUrl, newerVer) {
    if (handingOver || !primaryFork) return;
    setHandingOver(true);
    log(`handover: cedendo primário p/ v${newerVer} (${newerUrl}); eu=v${CURRENT_VERSION}`);
    broadcast({ type: "worker", state: "loading", msg: `Ativando atualização (v${newerVer})…` });
    const graceUntil = Date.now() + HANDOVER_GRACE_MS;
    suppressReclaimUntil = graceUntil;
    writeHandoverLock(graceUntil);   // ANTI-FLAP global: bystanders velhos também suspendem o reclaim na janela
    // ORDEM CRÍTICA (gate): subo meu server EFÊMERO e reaponto myBaseUrl ANTES de qualquer await e ANTES
    // de virar não-primário. Assim NUNCA existe uma janela em que eu (não-primário) anuncie a porta
    // canônica (agora do novo primário) — o que injetaria minhas falas na sessão DELE (vazamento).
    let ephem = null;
    try {
        ephem = makeVoiceServer();
        await listenOnce(ephem, 0);
        setMyBaseUrl(`http://127.0.0.1:${ephem.address().port}/`);
        log(`handover: server efêmero próprio em ${myBaseUrl} (rota da minha sessão preservada)`);
    } catch (e) {
        // ABORT: sem meu próprio server efêmero não há rota segura p/ a MINHA sessão. Ceder o primário aqui
        // deixaria myBaseUrl canônica (vaza minha fala p/ a sessão do novo primário) ou me deixaria sem rota.
        // Então NÃO cedo: reverto tudo e sigo primário; a fork nova tenta de novo no próximo /register (4s).
        dbg("handover: falha ao subir server efêmero, ABORTANDO step-down (sigo primário): " + (e && e.message));
        try { if (ephem) ephem.close(); } catch { }
        setHandingOver(false);
        suppressReclaimUntil = 0;
        writeHandoverLock(0);   // limpa o lock global: bystanders não devem suspender o reclaim por um handover que não aconteceu
        broadcast({ type: "worker", state: workerReady ? "ready" : "loading", device: lastDevice });   // limpa o "Ativando atualização…" (o worker segue vivo, eu sigo primário)
        return;
    }
    setPrimaryFork(false);
    shutdownWorkerForHandover();
    // Registra o server efêmero no bookkeeping por instância (funciona p/ primário cold-start E reclaim,
    // cujo entry era primary:false) e libera a porta canônica SEM await (as conexões SSE dos painéis
    // ficam abertas por DESIGN no handover -> server.close(cb) NUNCA chamaria o cb; destruo os sockets
    // e sigo). O novo primário assume a canônica.
    for (const [id, entry] of servers) {
        if (entry && (entry.primary || (entry.server && (entry.server === promotedServer || (primaryServerEntry && entry.server === primaryServerEntry.server))))) {
            servers.set(id, { ...entry, server: ephem, url: myBaseUrl, primary: false });
        }
    }
    const oldSrv = promotedServer || (primaryServerEntry && primaryServerEntry.server);
    promotedServer = null;
    setPrimaryServerEntry(null);
    if (oldSrv) {
        try { for (const res of [...sseClients.keys()]) { try { res.end(); } catch { } sseClients.delete(res); } } catch { }
        try { oldSrv.close(); } catch { }   // fire-and-forget: sockets destruídos acima; a porta libera
    }
    ensureSecondaryTimers();
    httpPostJson(newerUrl, "/reclaim-now", { from: CURRENT_VERSION }).catch(() => { });   // reassuma JÁ (não espere o probe dela)
    registerSelf();   // já com o myBaseUrl efêmero -> o novo primário roteia minhas falas de volta p/ MIM
    setTimeout(() => { setHandingOver(false); registerSelf(); }, 2000);
}

export async function reclaimWithRetry(reason, attempts = 12) {
    for (let i = 0; i < attempts; i++) {
        if (primaryFork) return true;
        if (await reclaimPrimaryIfOrphaned(reason, true)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
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
        if (sid) drainPendingSpeak(sid).catch(() => { });   // canvas conectou -> toca o que o hook coletou
        if (sid && !activeSid) setActiveSid(sid);
        if (primaryFork && settings.wakeWord) {
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

    if (req.method === "POST" && path === "/register") {
        const body = await readBody(req);
        if (body && body.sid && body.url) {
            const sid = String(body.sid), url = String(body.url);
            const ver = body.version ? String(body.version) : "";
            if (ver) forkVersions.set(sid, ver);
            const changed = forks.get(sid) !== url;
            setFork(sid, url);
            if (changed) dbg(`registered fork sid=${sid}${ver ? " v" + ver : ""}`);
            // The URL just arrived from a live server -> deliver any held turns now
            // against this fresh URL (fixes stale-URL and late-register drops).
            drainTurnsToFork(sid, url);
            // Auto-handover: uma fork MAIS NOVA registrou -> este primário (código velho) cede a
            // porta+worker p/ ela. Ativa um update do extension.mjs sem fechar o app.
            if (primaryFork && !handingOver && shouldStepDownForNewer(CURRENT_VERSION, ver)) {
                stepDownForNewer(url, ver).catch((e) => dbg("stepDownForNewer: " + (e && e.message)));
                return sendJson(res, { ok: true, reclaim: true });
            }
        }
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/reclaim-now") {
        // Um primário mais VELHO cedeu p/ mim (versão mais nova): reassumo a porta JÁ.
        reclaimWithRetry("handover-poke").catch(() => { });
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/focus") {
        const body = await readBody(req);
        if (body && body.sid) {
            setActiveSid(String(body.sid));
            pushAudio(activeSid);
            drainTurnsToFork(activeSid);
        }
        dbg(`focus -> activeSid=${activeSid}`);
        return sendJson(res, { ok: true, activeSid });
    }

    if (req.method === "POST" && path === "/played") {
        // O iframe confirmou que TOCOU um item até o fim -> avança o cursor DURÁVEL de
        // "ouvido". É o ÚNICO ponto que consome a fila de verdade (entrega != ouvido).
        // A história vive no PRIMÁRIO; um secundário que receba isto encaminha p/ lá.
        const body = await readBody(req);
        const sid = body && body.sid ? String(body.sid) : "";
        const seq = body && Number.isFinite(body.seq) ? Math.floor(body.seq) : 0;
        if (sid && seq > 0) {
            if (primaryFork) markPlayed(sid, seq);
            else forwardToPrimary("/played", { sid, seq });
        }
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

    if (req.method === "POST" && path === "/inject") {
        const body = await readBody(req);
        const r = await injectTurn(body && body.text, body && body.id ? String(body.id) : "");
        // STATUS reflete o resultado real: 503 numa falha faz o primary RETER o turno e
        // re-rotear p/ uma fork viva (httpPostJson resolve por 2xx). Nunca mais um ok:true
        // fire-and-forget que descartava a fala numa sessão morta.
        const payload = r.dup ? { ok: true, dup: true } : (r.retry ? { ok: false, retry: true } : { ok: r.ok });
        return sendJson(res, payload, r.code);
    }

    if (req.method === "POST" && path === "/speak") {
        const body = await readBody(req);
        const raw = String((body && body.spoken) || "").trim();
        // O Stop hook manda o resumo CRU (linha 🔊 sem tratamento). Limpamos aqui, no servidor,
        // pra TODO chamador do /speak (hook, forward de secundário) chegar limpo no TTS. cleanForSpeech
        // é idempotente, então re-limpar texto já-limpo (cue/forward) não muda nada.
        const spoken = body && body.cue ? raw : cleanForSpeech(raw);
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
        if (body && body.sid) setActiveSid(String(body.sid));
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
        setSettings({ ...settings, ...sanitizeSettings(body) });
        await saveSettings();
        if (settings.language !== prevLang) {
            workerSend({ cmd: "set", language: settings.language });
        }
        if (settings.ttsVoice !== prevTtsVoice) {
            setLastTtsPreviewSid(body && body.sid ? String(body.sid) : activeSid);
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
    // PARCEIRO, ex.: copilot-mobile). ZERO efeito colateral: NÃO drena pending, NÃO seta activeSid, NÃO
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

export function readSavedPort() {
    try {
        const n = Number(JSON.parse(readFileSync(PORT_FILE, "utf8"))?.port);
        if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
    } catch {
    }
    return 0;
}

export function readSavedToken() {
    try {
        const t = JSON.parse(readFileSync(PORT_FILE, "utf8"))?.token;
        if (typeof t === "string" && /^[a-f0-9]{8,}$/.test(t)) return t;
    } catch {
    }
    return "";
}

export function savePort(port) {
    try {
        writeFileSync(PORT_FILE, JSON.stringify({ port, token: sharedToken }));
    } catch (e) {
        log("savePort failed: " + e.message);
    }
}

export function claimPortFileExclusive(port) {
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
        setPrimaryFork(true);
        if (!preferredPort) preferredPort = bound; 
        sharedToken = sharedToken || readSavedToken() || randomBytes(16).toString("hex");
        savePort(bound); 
        drainAllPendingSpeak().catch(() => { });   // servidor ATIVO -> drena o que o hook coletou offline
    } else {
        sharedToken = readSavedToken(); 
    }
    setMyBaseUrl(`http://127.0.0.1:${bound}/`);
    if (!registered) {
        setRegistered(true);
        registerSelf();
        if (!primary) {
            ensureSecondaryTimers();
        }
    }
    return { server, url: `http://127.0.0.1:${bound}/`, primary };
}

export async function reclaimPrimaryIfOrphaned(reason, force = false) {
    if (primaryFork || reclaiming) return false;
    if (!force && Date.now() < suppressReclaimUntil) return false;   // acabei de ceder p/ versão mais nova: NÃO reassuma (anti-flap por-fork)
    if (!force && handoverLockActive()) return false;                // handover em curso (por QUALQUER fork): bystander velho não fisga a porta (anti-flap global)
    if (!force && Date.now() - lastReclaimAttempt < 2000) return false;
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
                try { server.close(); } catch { }   // libera o objeto server que não chegou a bindar (higiene; nit do gate)
                return false;
            }
            try { server.close(); } catch { }
            return false;
        }
        promotedServer = server;
        setPrimaryFork(true);
        stopSecondaryTimers();   // promovido: para os timers de secundário (senão um re-registro atrasado anuncia URL errada / vaza no próximo step-down)
        preferredPort = canonical;
        setMyBaseUrl(`http://127.0.0.1:${canonical}/`);
        savePort(canonical);
        drainAllPendingSpeak().catch(() => { });   // promovido a primário -> drena o pendente do hook
        setFork(mySid(), myBaseUrl);
        // RECONCILIA o bookkeeping p/ ESPELHAR um primário de cold-start: as entradas de painel desta fork eram
        // secundárias, apontando p/ um server efêmero AGORA órfão (esta fork passou a servir pela canônica). Sem
        // isso, um step-down futuro não acha a entrada primária -> o server efêmero novo não é rastreado (vaza) e
        // o onClose fecha o server ERRADO. Reaponto as entradas p/ o server canônico promovido, marco primary:true,
        // seto primaryServerEntry e fecho o secundário órfão.
        setPrimaryServerEntry(null);
        for (const [id, entry] of servers) {
            if (entry && entry.server && entry.server !== server) {
                try { entry.server.close(); } catch { }   // fecha o secundário órfão (a fork agora serve pela canônica)
            }
            const rebuilt = { ...entry, server, url: myBaseUrl, primary: true };
            servers.set(id, rebuilt);
            if (!primaryServerEntry) setPrimaryServerEntry(rebuilt);
        }
        reloadAudioStateFromDisk();   // promovido: adota o áudio DURÁVEL do disco (o primário morto persistiu além do meu prefixo) ANTES de servir hello/ack
        log(`reclaimPrimary: promoted to primary on ${canonical} (${reason})`);
        broadcast({ type: "worker", state: "loading", msg: "Reassumindo motor de voz…" });
        ensureWorker();
        return true;
    } finally {
        reclaiming = false;
    }
}

export function probePrimary() {
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

export function httpPostJson(baseUrl, path, body, timeoutMs = HTTP_POST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        try {
            const u = new URL(path, baseUrl);
            const data = Buffer.from(JSON.stringify(body || {}));
            const isLoopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
            const req = httpRequest(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname,
                    method: "POST",
                    agent: isLoopback ? loopbackAgent : undefined,
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
            if (timeoutMs > 0) {
                req.setTimeout(timeoutMs, () => {
                    // Não deixa o drain preso num send que nunca responde: aborta e reporta
                    // falha (o turno fica na fila e re-roteia p/ uma fork viva).
                    try { req.destroy(); } catch { }
                    resolve(false);
                });
            }
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

export function writeHandoverLock(until) { try { writeFileSync(HANDOVER_LOCK_FILE, String(until)); } catch { } }

export function handoverLockActive() {
    try { return Date.now() < (parseInt(readFileSync(HANDOVER_LOCK_FILE, "utf8"), 10) || 0); } catch { return false; }
}

export function setFork(sid, url) { forks.set(sid, url); forkSeen.set(sid, Date.now()); }

export function pruneDeadSids() {
    const now = Date.now();
    const me = mySid();
    for (const [sid, ts] of forkSeen) {
        if (sid !== me && now - ts > FORK_TTL_MS) { forks.delete(sid); forkSeen.delete(sid); }
    }
    for (const [sid, v] of recentSpoken) {
        if (now - (v && v.ts || 0) > FORK_TTL_MS) recentSpoken.delete(sid);
    }
}
