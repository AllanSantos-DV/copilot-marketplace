// Extension: copilot-remote
// Controle Remoto — drive a REMOTE machine's Copilot agent from this machine.
//
// It is a CLIENT of the copilot-mobile bridge running on the target machine:
// it pairs like a phone (kind:"desktop"), streams the remote agent's events and
// injects prompts. The cockpit is a desktop canvas (keyboard/screen), not a
// cramped phone PWA.
//
// Architecture:
//   panel.html (webview, loopback origin)
//        |  same-origin HTTP/SSE to the LOCAL loop server
//        v
//   extension.mjs (this) — local loop server + canvas + connection manager
//        |  client.mjs: cross-machine HTTP/SSE (no CORS; secrets stay in Node)
//        v
//   REMOTE copilot-mobile bridge  --session.send-->  remote agent
//
// stdout is reserved for JSON-RPC — never console.log(); use dbg().

import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { BridgeClient } from "./client.mjs";
import { DaemonClient, localDaemonInfo } from "./daemon.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(EXT_DIR, "artifacts");
const DEBUG_LOG = join(ARTIFACTS, "debug.log");
const STATE_FILE = join(ARTIFACTS, "state.json");
const PANEL_FILE = join(EXT_DIR, "panel.html");
const RECENT_MAX = 80;
const DEVICE_NAME_DEFAULT = "Controle Remoto (desktop)";

// ---------- logging ----------
function dbg(msg) {
    try {
        mkdirSync(ARTIFACTS, { recursive: true });
        appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [pid:${process.pid}] ${msg}\n`);
    } catch {}
}

// ---------- persisted + runtime state ----------
let localToken = randomBytes(16).toString("hex"); // same-origin auth for the panel
let persistedLoopPort = 0;
let targets = []; // [{ id, name, url, deviceId, deviceSecret, lastConnectedAt }]
let activeTargetId = null;
let remoteDaemons = []; // [{ url, token, deviceId, deviceSecret, name }] — paired peer daemons (cross-machine)
let activeDaemonUrl = null; // null = local daemon; otherwise a paired remote daemon's base URL (panel's choice)
let daemonStreamOff = null; // unsubscribe handle for the active daemon's event stream → panel
let panelSessionId = null;  // the session the panel is currently focused on (for voice routing)

let loopServer = null;
let loopPort = 0;
const panelClients = new Set(); // { res, id }
let recent = []; // durable remote events (with .seq) for backlog on (re)connect

let active = null; // { target, client, sub }
const askWaiters = new Set(); // one-shot turn collectors for agent-to-agent remote_ask
let conn = { connected: false, connecting: false, transport: null, busy: false, error: null, pending: [], question: null, remoteSnapshot: null };

function loadState() {
    try {
        if (!existsSync(STATE_FILE)) return;
        const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
        if (typeof s?.localToken === "string" && s.localToken) localToken = s.localToken;
        if (Number.isInteger(s?.loopPort) && s.loopPort >= 1024 && s.loopPort <= 65535) persistedLoopPort = s.loopPort;
        if (Array.isArray(s?.targets)) targets = s.targets.filter((t) => t && t.id && t.url);
        if (typeof s?.activeTargetId === "string") activeTargetId = s.activeTargetId;
        if (Array.isArray(s?.remoteDaemons)) remoteDaemons = s.remoteDaemons.filter((d) => d && d.url && d.deviceId && d.deviceSecret);
    } catch (e) {
        dbg("loadState failed: " + e.message);
    }
}
function saveState() {
    try {
        mkdirSync(ARTIFACTS, { recursive: true });
        const obj = { localToken, targets, activeTargetId, remoteDaemons };
        if (loopPort) obj.loopPort = loopPort;
        writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (e) {
        dbg("saveState failed: " + e.message);
    }
}

function normUrl(u) {
    return String(u || "").trim().replace(/\/+$/, "");
}
function findTargetByUrl(u) {
    const n = normUrl(u);
    return targets.find((t) => normUrl(t.url) === n) || null;
}
function upsertTarget(t) {
    const i = targets.findIndex((x) => x.id === t.id);
    if (i >= 0) targets[i] = t; else targets.push(t);
}

// ---------- panel SSE fan-out ----------
function writeSse(client, obj) {
    try { client.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
}
function broadcastPanel(obj) {
    for (const c of panelClients) writeSse(c, obj);
}

// ---------- voice engine reuse (borrow the voice extension's local Whisper) ----------
// We do NOT bundle Whisper. If the prod voice extension ("voice-chat") is installed,
// we POST recorded audio to its /transcribe endpoint and get text back. Discovery is
// via the voice extension's own port-file rendezvous; auth via its shared token.
function copilotHome() {
    const marker = sep + ".copilot" + sep;
    const i = EXT_DIR.indexOf(marker);
    return i >= 0 ? EXT_DIR.slice(0, i + marker.length - 1) : join(homedir(), ".copilot");
}
// The prod voice extension ships under its own extension dir + data dir (port-file).
const VOICE = { name: "voice-chat", dir: "voice-chat", data: "voice-chat-data" };

function voiceInfo() {
    const home = copilotHome();
    const installed = existsSync(join(home, "extensions", VOICE.dir, "extension.mjs"));
    let port = 0, token = "";
    if (installed) {
        try {
            const j = JSON.parse(readFileSync(join(home, VOICE.data, "server-port.json"), "utf8"));
            port = Number(j.port) || 0;
            token = typeof j.token === "string" ? j.token : "";
        } catch {}
    }
    return { installed, reachable: !!(port && token), port, token, variant: VOICE.name };
}

function voicePost(pathName, bodyObj, port, token, timeoutMs = 70000) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(bodyObj));
        const req = httpRequest(
            { host: "127.0.0.1", port, path: pathName, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length, "x-voice-token": token } },
            (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, json: j }); }); },
        );
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
        req.write(data);
        req.end();
    });
}

async function transcribeViaVoice(audioB64) {
    const v = voiceInfo();
    if (!v.installed) throw new Error("voice_not_installed");
    if (!v.reachable) throw new Error("voice_not_running");
    const r = await voicePost("/transcribe", { audio: audioB64 }, v.port, v.token);
    if (r.status === 503) throw new Error("voice_warming");
    if (!r.json || !r.json.ok) throw new Error((r.json && r.json.error) || ("http_" + r.status));
    return (r.json.text || "").trim();
}

function snapshot() {
    return {
        connected: conn.connected,
        connecting: conn.connecting,
        transport: conn.transport,
        busy: conn.busy,
        error: conn.error,
        pending: conn.pending || [],
        question: conn.question || null,
        activeTargetId,
        deviceName: DEVICE_NAME_DEFAULT,
        targets: targets.map((t) => ({
            id: t.id,
            name: t.name,
            url: t.url,
            paired: !!(t.deviceId && t.deviceSecret),
            active: t.id === activeTargetId,
            lastConnectedAt: t.lastConnectedAt || null,
        })),
        voice: voiceInfo(),
        remoteSnapshot: conn.remoteSnapshot || null,
    };
}

function pushRecent(evt) {
    recent.push(evt);
    if (recent.length > RECENT_MAX) recent.shift();
}

// ---------- connection manager ----------
function applyStatus(st) {
    if (!st) return;
    if (typeof st.busy === "boolean") conn.busy = st.busy;
    if (st.transport) conn.transport = st.transport;
    if (Array.isArray(st.pending)) conn.pending = st.pending;
    if ("question" in st) conn.question = st.question ?? null;
    if (st.snapshot) conn.remoteSnapshot = st.snapshot;
    if (st.error) conn.error = st.error;
    broadcastPanel({ type: "status", snapshot: snapshot() });
}

function onRemoteEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    // Track busy/pending implicitly from known event types as a safety net.
    if (evt.type === "busy") { conn.busy = !!evt.busy; broadcastPanel({ type: "status", snapshot: snapshot() }); return; }
    pushRecent(evt);
    for (const w of [...askWaiters]) { try { w(evt); } catch {} }
    broadcastPanel(evt);
}

// ---------- agent-to-agent: send a turn and AWAIT the remote agent's reply ----------
function activeTargetName() {
    const t = targets.find((x) => x.id === activeTargetId);
    return t ? t.name : "remoto";
}

// Resolve when the remote turn reaches a terminal/interactive point. Collects
// every assistant message; returns on idle (done), question (remote ask_user),
// permission (remote needs approval), timeout, or disconnect. Register the
// waiter BEFORE sending so no early event is lost.
function waitForTurn({ timeoutMs = 180000 } = {}) {
    return new Promise((resolve) => {
        const parts = [];
        let settled = false;
        const finish = (status, extra = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            askWaiters.delete(onEvt);
            resolve({ status, reply: parts.join("\n\n").trim(), ...extra });
        };
        const onEvt = (evt) => {
            if (!evt || typeof evt !== "object") return;
            switch (evt.type) {
                case "assistant": if (evt.content) parts.push(evt.content); break;
                case "idle": finish(evt.aborted ? "aborted" : "idle"); break;
                case "question": finish("question", { question: { id: evt.id ?? evt.requestId ?? null, question: evt.question || "", choices: Array.isArray(evt.choices) ? evt.choices : [], allowFreeform: evt.allowFreeform !== false } }); break;
                case "permission": finish("permission", { permission: { requestId: evt.requestId, title: evt.title || "", detail: evt.detail || "", intention: evt.intention || "", warning: evt.warning || "" } }); break;
                case "__disconnected": finish("disconnected"); break;
                default: break;
            }
        };
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
        askWaiters.add(onEvt);
    });
}

async function remoteAsk(prompt, timeoutMs, attachments) {
    if (!active) throw new Error("not_connected");
    const waiter = waitForTurn({ timeoutMs });
    await active.client.send(prompt, attachments || []);
    return waiter;
}
async function remoteAnswerAndWait(answer, timeoutMs) {
    if (!active) throw new Error("not_connected");
    const waiter = waitForTurn({ timeoutMs });
    await active.client.answer(answer, true);
    return waiter;
}
async function remotePermissionAndWait(requestId, decision, timeoutMs) {
    if (!active) throw new Error("not_connected");
    const waiter = waitForTurn({ timeoutMs });
    await active.client.permission(requestId, decision);
    return waiter;
}

// Read local files for sending to the remote agent. Text (md/mermaid/code) is
// INLINED into the prompt (the bridge only accepts image attachments and caps
// prompt length); images go as base64 blob attachments. Returns { prompt,
// attachments, notes }.
const FILE_TEXT_LANG = {
    ".md": "markdown", ".markdown": "markdown", ".mmd": "mermaid", ".mermaid": "mermaid",
    ".txt": "", ".log": "", ".csv": "", ".ini": "", ".toml": "toml", ".env": "",
    ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".xml": "xml", ".svg": "xml", ".html": "html", ".css": "css",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
    ".py": "python", ".java": "java", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cs": "csharp", ".sh": "bash", ".ps1": "powershell", ".sql": "sql",
};
const FILE_IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const FILE_INLINE_CAP = 12000; // chars of text inlined per file (bridge caps the prompt)

function buildFilePayload(paths, basePrompt) {
    const attachments = [];
    const blocks = [];
    const notes = [];
    for (const raw of paths) {
        const pth = String(raw || "").trim().replace(/^["']|["']$/g, "");
        if (!pth) continue;
        if (!existsSync(pth)) { notes.push(`(não encontrado: ${pth})`); continue; }
        const ext = extname(pth).toLowerCase();
        const name = basename(pth);
        if (ext in FILE_IMG_MIME) {
            try {
                const buf = readFileSync(pth);
                if (buf.length > 12 * 1024 * 1024) { notes.push(`(imagem grande demais: ${name})`); continue; }
                attachments.push({ data: buf.toString("base64"), mimeType: FILE_IMG_MIME[ext], displayName: name });
                notes.push(`imagem anexada: ${name}`);
            } catch (e) { notes.push(`(falha lendo ${name}: ${e.message})`); }
            continue;
        }
        try {
            let content = readFileSync(pth, "utf8");
            let truncated = false;
            if (content.length > FILE_INLINE_CAP) { content = content.slice(0, FILE_INLINE_CAP); truncated = true; }
            const lang = FILE_TEXT_LANG[ext] ?? "";
            blocks.push(`Arquivo: ${name}${truncated ? " (truncado)" : ""}\n\`\`\`${lang}\n${content}\n\`\`\``);
            notes.push(`texto embutido: ${name}${truncated ? " (truncado)" : ""}`);
        } catch (e) { notes.push(`(falha lendo ${name}: ${e.message})`); }
    }
    let prompt = basePrompt || "";
    if (blocks.length) prompt = (prompt ? prompt + "\n\n" : "") + blocks.join("\n\n");
    return { prompt, attachments, notes };
}

// Render a turn result as LLM-friendly text, telling the agent what to call next.
function formatTurn(r) {
    const name = activeTargetName();
    if (r.status === "idle") return `[${name}] respondeu:\n\n${r.reply || "(o agente remoto não retornou texto)"}`;
    if (r.status === "aborted") return `[${name}] o turno foi abortado.${r.reply ? "\n\nParcial:\n" + r.reply : ""}`;
    if (r.status === "timeout") return `[${name}] ainda não terminou (timeout de espera).${r.reply ? "\n\nParcial até agora:\n" + r.reply : ""}\n\nChame remote_ask de novo (prompt curto como "continue") para seguir aguardando, ou remote_status / remote_abort.`;
    if (r.status === "disconnected") return `[${name}] a conexão caiu durante a espera. Reconecte (remote_connect) e tente de novo.`;
    if (r.status === "question") {
        const q = r.question || {};
        const ch = (q.choices || []).length ? `\nOpções oferecidas: ${q.choices.join(" | ")}` : "";
        return `[${name}] está PERGUNTANDO e aguarda sua resposta:\n\n${q.question}${ch}\n\n➜ Responda com remote_answer { answer: "..." }.${r.reply ? "\n\nContexto antes da pergunta:\n" + r.reply : ""}`;
    }
    if (r.status === "permission") {
        const p = r.permission || {};
        return `[${name}] está PEDINDO PERMISSÃO:\n\n${p.title} ${p.detail}\n${p.intention ? p.intention + "\n" : ""}${p.warning ? "⚠ " + p.warning + "\n" : ""}\n➜ Decida com remote_permission { requestId: "${p.requestId}", decision: "approve" | "reject" }.${r.reply ? "\n\nContexto:\n" + r.reply : ""}`;
    }
    return `[${name}] status: ${r.status}\n${r.reply || ""}`;
}

async function disconnect() {
    if (active) {
        try { active.sub?.close(); } catch {}
        active = null;
    }
    for (const w of [...askWaiters]) { try { w({ type: "__disconnected" }); } catch {} }
    conn = { connected: false, connecting: false, transport: null, busy: false, error: null, pending: [], question: null, remoteSnapshot: conn.remoteSnapshot };
    broadcastPanel({ type: "status", snapshot: snapshot() });
}

// Connect to a target. If `code` is provided, pair first; otherwise re-auth with
// stored device creds. Throws on failure (caller maps to an API error).
async function connectTarget(target, code) {
    await disconnect();
    conn.connecting = true; conn.error = null;
    broadcastPanel({ type: "status", snapshot: snapshot() });

    const client = new BridgeClient({
        baseUrl: target.url,
        deviceId: target.deviceId || null,
        deviceSecret: target.deviceSecret || null,
        kind: "desktop",
        name: target.name || DEVICE_NAME_DEFAULT,
    });

    try {
        if (code) {
            const creds = await client.pair(code);
            target.deviceId = creds.deviceId;
            target.deviceSecret = creds.deviceSecret;
        } else {
            await client.ensureToken();
        }
    } catch (e) {
        conn.connecting = false;
        conn.error = String(e?.message || e);
        broadcastPanel({ type: "status", snapshot: snapshot() });
        throw e;
    }

    target.lastConnectedAt = Date.now();
    upsertTarget(target);
    activeTargetId = target.id;
    saveState();

    recent = [];
    const sub = client.subscribe({
        onEvent: onRemoteEvent,
        onStatus: applyStatus,
    });
    active = { target, client, sub };
    conn.connected = true;
    conn.connecting = false;
    conn.error = null;
    broadcastPanel({ type: "hello", snapshot: snapshot(), recent });
    broadcastPanel({ type: "status", snapshot: snapshot() });
    return snapshot();
}

// ---------- local HTTP API (panel <-> extension; loopback only) ----------
function isAuthed(url, req) {
    const t = req.headers["x-local-token"] || url.searchParams.get("t") || "";
    return t === localToken;
}
function sendJson(res, obj, status = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
}
function readBody(req, cap = 24 << 20) {
    return new Promise((resolve) => {
        let buf = "", n = 0;
        req.on("data", (c) => { n += c.length; if (n > cap) { try { req.destroy(); } catch {} resolve(null); } else buf += c; });
        req.on("end", () => { if (!buf) return resolve({}); try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
        req.on("error", () => resolve(null));
    });
}

const PLACEHOLDER_HTML = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:1rem;color:#ddd;background:#1e1e1e">
<h2>Controle Remoto</h2><p>panel.html ainda não foi criado (Fase 3). API local ativa.</p></body>`;

async function servePanel(res) {
    try {
        const html = await readFile(PANEL_FILE, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
    } catch {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PLACEHOLDER_HTML);
    }
}

async function handleLocal(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // Shell is harmless without a token; the APIs gate below.
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return servePanel(res);
    }

    // Everything else requires the same-origin local token.
    if (!isAuthed(url, req)) return sendJson(res, { ok: false, error: "forbidden" }, 403);

    if (req.method === "GET" && path === "/state") {
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }

    if (req.method === "GET" && path === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        const client = { res, id: randomBytes(4).toString("hex") };
        panelClients.add(client);
        writeSse(client, { type: "hello", snapshot: snapshot(), recent });
        req.on("close", () => panelClients.delete(client));
        return;
    }

    if (req.method === "POST" && path === "/connect") {
        const body = await readBody(req);
        const url2 = normUrl(body?.url);
        const code = body?.code ? String(body.code) : null;
        const name = (body?.name && String(body.name).slice(0, 60)) || null;
        if (!/^https?:\/\//i.test(url2)) return sendJson(res, { ok: false, error: "bad_url" }, 400);
        let target = findTargetByUrl(url2);
        if (!target) target = { id: randomBytes(6).toString("hex"), name: name || url2, url: url2 };
        else if (name) target.name = name;
        try {
            const snap = await connectTarget(target, code);
            return sendJson(res, { ok: true, snapshot: snap });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e), snapshot: snapshot() }, 400);
        }
    }

    if (req.method === "POST" && path === "/reconnect") {
        const body = await readBody(req);
        const target = targets.find((t) => t.id === body?.targetId);
        if (!target) return sendJson(res, { ok: false, error: "no_target" }, 404);
        try {
            const snap = await connectTarget(target, null);
            return sendJson(res, { ok: true, snapshot: snap });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e), snapshot: snapshot() }, 400);
        }
    }

    if (req.method === "POST" && path === "/disconnect") {
        await disconnect();
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }

    if (req.method === "POST" && path === "/forget") {
        const body = await readBody(req);
        const id = body?.targetId;
        if (active && active.target.id === id) await disconnect();
        targets = targets.filter((t) => t.id !== id);
        if (activeTargetId === id) activeTargetId = null;
        saveState();
        broadcastPanel({ type: "status", snapshot: snapshot() });
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }

    if (req.method === "POST" && path === "/send") {
        if (!active) return sendJson(res, { ok: false, error: "not_connected" }, 409);
        const body = await readBody(req);
        const prompt = typeof body?.prompt === "string" ? body.prompt : "";
        const atts = Array.isArray(body?.attachments) ? body.attachments : [];
        if (!prompt.trim() && !atts.length) return sendJson(res, { ok: false, error: "empty_prompt" }, 400);
        try {
            const messageId = await active.client.send(prompt, atts);
            return sendJson(res, { ok: true, messageId });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/permission") {
        if (!active) return sendJson(res, { ok: false, error: "not_connected" }, 409);
        const body = await readBody(req);
        const requestId = body?.requestId;
        const decision = body?.decision;
        if (!requestId || (decision !== "approve" && decision !== "reject")) return sendJson(res, { ok: false, error: "bad_request" }, 400);
        try {
            await active.client.permission(requestId, decision);
            return sendJson(res, { ok: true });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/abort") {
        if (!active) return sendJson(res, { ok: false, error: "not_connected" }, 409);
        try { await active.client.abort(); } catch (e) { dbg("abort failed: " + e.message); }
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/answer") {
        if (!active) return sendJson(res, { ok: false, error: "not_connected" }, 409);
        const body = await readBody(req);
        const answer = typeof body?.answer === "string" ? body.answer : "";
        if (!answer.trim()) return sendJson(res, { ok: false, error: "empty_answer" }, 400);
        try {
            await active.client.answer(answer, !!body?.wasFreeform);
            return sendJson(res, { ok: true });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "GET" && path === "/voice-status") {
        return sendJson(res, { ok: true, voice: voiceInfo() });
    }

    if (req.method === "POST" && path === "/voice-in") {
        const body = await readBody(req);
        const audio = typeof body?.audio === "string" ? body.audio : "";
        if (!audio || audio.length < 32) return sendJson(res, { ok: false, error: "no_audio" }, 400);
        let text = "";
        try {
            text = await transcribeViaVoice(audio);
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e), stage: "transcribe" }, 502);
        }
        if (!text) return sendJson(res, { ok: true, text: "", note: "empty_transcript" });
        // Route the recognized speech straight to the remote agent (no detour).
        if (!active) return sendJson(res, { ok: true, text, sent: false, note: "not_connected" });
        try {
            await active.client.send(text);
            return sendJson(res, { ok: true, text, sent: true });
        } catch (e) {
            return sendJson(res, { ok: false, text, sent: false, error: String(e?.message || e), stage: "send" }, 502);
        }
    }

    // ===== DAEMON-FIRST panel API (multi-session: list machine sessions, pick one, chat) =====
    if (req.method === "GET" && path === "/daemon/state") {
        const localInfo = localDaemonInfo();
        let mode = null, paired = false, reachable = false;
        try {
            const dc = await getActiveDaemon();
            if (dc) { const p = await dc.ping(); mode = p.mode ?? null; paired = !!p.paired; reachable = !!p.ok; }
        } catch {}
        return sendJson(res, {
            ok: true,
            local: { installed: !!localInfo, mode: localInfo?.mode ?? null, exposedUrl: localInfo?.exposedUrl ?? null },
            active: { url: activeDaemonUrl, isLocal: !activeDaemonUrl, mode, paired, reachable },
            remotes: remoteDaemons.map((d) => ({ url: d.url, name: d.name || d.url })),
            panelSessionId,
        });
    }

    if (req.method === "POST" && path === "/daemon/select") {
        const body = await readBody(req);
        const url = body?.url ? String(body.url).replace(/\/+$/, "") : null; // null/empty = local
        activeDaemonUrl = url || null;
        panelSessionId = null;
        try { daemonStreamOff?.(); } catch {}
        daemonStreamOff = null;
        try {
            const dc = await getActiveDaemon();
            if (!dc) return sendJson(res, { ok: false, error: "daemon_unavailable" }, 409);
            wireDaemonStream(dc);
            const sessions = await dc.listSessions();
            return sendJson(res, { ok: true, sessions });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "GET" && path === "/daemon/sessions") {
        try {
            const dc = await getActiveDaemon();
            if (!dc) return sendJson(res, { ok: false, error: "daemon_unavailable" }, 409);
            wireDaemonStream(dc);
            const sessions = await dc.listSessions();
            return sendJson(res, { ok: true, sessions });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/daemon/connect") {
        const body = await readBody(req);
        const url = String(body?.url || "").trim().replace(/\/+$/, "");
        const code = String(body?.code || "").trim();
        const name = (body?.name && String(body.name).slice(0, 60)) || null;
        if (!/^https?:\/\//i.test(url)) return sendJson(res, { ok: false, error: "bad_url" }, 400);
        if (!code) return sendJson(res, { ok: false, error: "missing_code" }, 400);
        try {
            const dc = new DaemonClient({ baseUrl: url, name: name || "Controle Remoto (peer)" });
            const creds = await dc.pairAsPeer(code);
            remoteDaemons = remoteDaemons.filter((d) => String(d.url).replace(/\/+$/, "") !== url);
            remoteDaemons.push({ url, token: creds.token, deviceId: creds.deviceId, deviceSecret: creds.deviceSecret, name: dc.name });
            saveState();
            try { daemonClient?.close(); } catch {}
            daemonClient = dc;
            activeDaemonUrl = url;
            panelSessionId = null;
            try { daemonStreamOff?.(); } catch {}
            daemonStreamOff = null;
            wireDaemonStream(dc);
            const sessions = await dc.listSessions();
            return sendJson(res, { ok: true, sessions });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/daemon/forget") {
        const body = await readBody(req);
        const url = String(body?.url || "").replace(/\/+$/, "");
        remoteDaemons = remoteDaemons.filter((d) => String(d.url).replace(/\/+$/, "") !== url);
        if (activeDaemonUrl === url) { activeDaemonUrl = null; try { daemonStreamOff?.(); } catch {} daemonStreamOff = null; try { daemonClient?.close(); } catch {} daemonClient = null; }
        saveState();
        return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/daemon/subscribe") {
        const body = await readBody(req);
        const sessionId = String(body?.sessionId || "");
        if (!sessionId) return sendJson(res, { ok: false, error: "missing_sessionId" }, 400);
        try {
            const dc = await getActiveDaemon();
            if (!dc) return sendJson(res, { ok: false, error: "daemon_unavailable" }, 409);
            wireDaemonStream(dc);
            panelSessionId = sessionId;
            const recent = await dc.subscribe(sessionId, 60);
            return sendJson(res, { ok: true, recent, sessionId });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/daemon/send") {
        const body = await readBody(req);
        const sessionId = String(body?.sessionId || "");
        const prompt = typeof body?.prompt === "string" ? body.prompt : "";
        if (!sessionId || !prompt.trim()) return sendJson(res, { ok: false, error: "bad_request" }, 400);
        try {
            const dc = await getActiveDaemon();
            if (!dc) return sendJson(res, { ok: false, error: "daemon_unavailable" }, 409);
            const messageId = await dc.send(sessionId, prompt);
            return sendJson(res, { ok: true, messageId });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/daemon/abort") {
        const body = await readBody(req);
        const sessionId = String(body?.sessionId || "");
        try {
            const dc = await getActiveDaemon();
            if (dc && sessionId) await dc.abort(sessionId);
            return sendJson(res, { ok: true });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 502);
        }
    }

    if (req.method === "POST" && path === "/daemon/voice-in") {
        const body = await readBody(req);
        const sessionId = String(body?.sessionId || "");
        const audio = typeof body?.audio === "string" ? body.audio : "";
        if (!sessionId) return sendJson(res, { ok: false, error: "missing_sessionId" }, 400);
        if (!audio || audio.length < 32) return sendJson(res, { ok: false, error: "no_audio" }, 400);
        let text = "";
        try { text = await transcribeViaVoice(audio); }
        catch (e) { return sendJson(res, { ok: false, error: String(e?.message || e), stage: "transcribe" }, 502); }
        if (!text) return sendJson(res, { ok: true, text: "", note: "empty_transcript" });
        try {
            const dc = await getActiveDaemon();
            if (!dc) return sendJson(res, { ok: true, text, sent: false, note: "daemon_unavailable" });
            await dc.send(sessionId, text);
            return sendJson(res, { ok: true, text, sent: true });
        } catch (e) {
            return sendJson(res, { ok: false, text, sent: false, error: String(e?.message || e), stage: "send" }, 502);
        }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
}

// Resolve the panel's active daemon (local by default, or a paired remote by URL).
async function getActiveDaemon() {
    return ensureDaemon(activeDaemonUrl || undefined);
}

// Fan the active daemon's multiplexed events out to the panel (tagged channel:"daemon").
// Idempotent per active client: re-wiring drops the previous sink first.
let _daemonStreamFor = null;
function wireDaemonStream(dc) {
    if (_daemonStreamFor === dc && daemonStreamOff) return;
    try { daemonStreamOff?.(); } catch {}
    daemonStreamOff = dc.onEvent((evt) => { try { broadcastPanel({ channel: "daemon", ...evt }); } catch {} });
    _daemonStreamFor = dc;
}

function listen127(port) {
    return new Promise((resolve, reject) => {
        const s = createServer((req, res) => handleLocal(req, res).catch((e) => {
            dbg("handleLocal threw: " + (e?.stack || e));
            try { sendJson(res, { ok: false, error: "internal" }, 500); } catch {}
        }));
        s.on("error", reject);
        s.listen(port, "127.0.0.1", () => resolve(s));
    });
}

async function ensureLoopServer() {
    if (loopServer) return;
    const want = persistedLoopPort || 0;
    try {
        loopServer = await listen127(want);
    } catch (e) {
        dbg(`loop port ${want} unavailable (${e?.code || e?.message || e}); using ephemeral`);
        loopServer = await listen127(0);
    }
    loopPort = loopServer.address().port;
    if (loopPort !== persistedLoopPort) { persistedLoopPort = loopPort; saveState(); }
    dbg("loop server on 127.0.0.1:" + loopPort);
}

// ---------- canvas ----------
const canvas = createCanvas({
    id: "copilot-remote",
    displayName: "Controle Remoto",
    description: "Conecta na ponte copilot-mobile de uma máquina remota e controla o agente dela (pareia como kind desktop).",
    actions: [
        {
            name: "status",
            description: "Retorna o estado da conexão remota (target ativo, conectado, ocupado, máquinas salvas).",
            handler: async () => ({ ok: true, ...snapshot() }),
        },
        {
            name: "connect",
            description: "Conecta a uma ponte remota. Forneça a URL (ex.: http://192.168.0.5:8765) e, na 1ª vez, o código de pareamento de 6 dígitos.",
            inputSchema: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL base da ponte remota (http/https)." },
                    code: { type: "string", description: "Código de pareamento de 6 dígitos (só na 1ª vez)." },
                    name: { type: "string", description: "Apelido da máquina (opcional)." },
                },
                required: ["url"],
            },
            handler: async (ctx) => {
                const url = normUrl(ctx?.input?.url);
                if (!/^https?:\/\//i.test(url)) throw new CanvasError("invalid_input", "URL inválida.");
                let target = findTargetByUrl(url) || { id: randomBytes(6).toString("hex"), name: ctx?.input?.name || url, url };
                if (ctx?.input?.name) target.name = ctx.input.name;
                await connectTarget(target, ctx?.input?.code ? String(ctx.input.code) : null);
                return { ok: true, ...snapshot() };
            },
        },
        {
            name: "send",
            description: "Injeta um prompt no agente da máquina remota conectada.",
            inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
            handler: async (ctx) => {
                if (!active) throw new CanvasError("not_connected", "Nenhuma máquina conectada.");
                const messageId = await active.client.send(String(ctx?.input?.prompt || ""));
                return { ok: true, messageId };
            },
        },
        {
            name: "disconnect",
            description: "Desconecta da máquina remota atual (mantém o pareamento salvo).",
            handler: async () => { await disconnect(); return { ok: true, ...snapshot() }; },
        },
    ],
    open: async () => {
        await ensureLoopServer();
        return { title: "Controle Remoto", url: `http://127.0.0.1:${loopPort}/?t=${localToken}` };
    },
    onClose: async () => {
        // Keep the loop server and the remote connection alive across panel
        // open/close (so closing the canvas doesn't drop the remote session).
        dbg("canvas closed (connection kept; active=" + (activeTargetId || "none") + ")");
    },
});

// ---------- agent-facing tools (agent-to-agent orchestration) ----------
// These let THE LOCAL AGENT (me) drive the REMOTE agent over the bridge: send a
// plan/instruction and await the remote agent's reply, then iterate — handling
// the remote agent's own questions/permissions. Names are globally unique.
const TOOL_CONNECTED_HINT = "Conecte primeiro com remote_connect { url, code } (a 1ª vez precisa do código de 6 dígitos mostrado no painel da ponte), ou peça ao usuário para armar a ponte e parear.";

const tools = [
    {
        name: "remote_status",
        description: "Mostra o estado da conexão com a máquina remota (se há um agente remoto conectado, qual máquina, se está ocupado) e as máquinas salvas. Use antes de remote_ask para confirmar que há um alvo conectado.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            const s = snapshot();
            const lines = [];
            lines.push(s.connected ? `Conectado a: ${activeTargetName()} (${s.transport || "?"}${s.busy ? ", ocupado" : ""}).` : "Nenhuma máquina remota conectada.");
            if (s.targets.length) {
                lines.push("Máquinas salvas:");
                for (const t of s.targets) lines.push(`  - ${t.name} ${t.url}${t.paired ? " [pareada]" : ""}${t.active ? " [ativa]" : ""}`);
            } else lines.push("Nenhuma máquina salva.");
            if (!s.connected) lines.push(TOOL_CONNECTED_HINT);
            return { resultType: "success", textResultForLlm: lines.join("\n") };
        },
    },
    {
        name: "remote_connect",
        description: "Conecta na ponte copilot-mobile de uma máquina remota (pareia como dispositivo 'desktop'). Na 1ª vez exige o código de pareamento de 6 dígitos mostrado no painel da ponte remota; depois reconecta sozinho. Após conectar, use remote_ask para conversar com o agente daquela máquina.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL base da ponte remota, ex.: http://192.168.0.5:8765 (LAN/Tailscale) ou a URL https pública." },
                code: { type: "string", description: "Código de pareamento de 6 dígitos (só na 1ª vez nessa máquina)." },
                name: { type: "string", description: "Apelido da máquina (opcional)." },
            },
            required: ["url"],
        },
        handler: async (args) => {
            const url = normUrl(args?.url);
            if (!/^https?:\/\//i.test(url)) return { resultType: "failure", textResultForLlm: "remote_connect: URL inválida (use http:// ou https://)." };
            let target = findTargetByUrl(url) || { id: randomBytes(6).toString("hex"), name: args?.name || url, url };
            if (args?.name) target.name = args.name;
            try {
                await connectTarget(target, args?.code ? String(args.code) : null);
                return { resultType: "success", textResultForLlm: `Conectado a ${activeTargetName()} (${url}). Agora você pode usar remote_ask para enviar instruções ao agente remoto.` };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: `Falha ao conectar: ${e?.message || e}. ${TOOL_CONNECTED_HINT}` };
            }
        },
    },
    {
        name: "remote_ask",
        description: "Envia uma mensagem/instrução ao AGENTE da máquina remota conectada e AGUARDA a resposta dele. É o coração da conversa agente-a-agente: você (com base no plano do usuário) manda a instrução e recebe de volta a resposta do agente remoto. Se o agente remoto fizer uma pergunta (ask_user) ou pedir permissão, o resultado indica isso para você responder com remote_answer / remote_permission. Requer conexão ativa.",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "A mensagem/instrução para o agente remoto. Pode ser um plano, uma pergunta, ou 'continue' para seguir aguardando um turno longo." },
                files: { type: "array", items: { type: "string" }, description: "Opcional: caminho(s) de arquivo LOCAL para enviar junto (mermaid/md/código são embutidos; imagens viram anexo)." },
                timeoutSeconds: { type: "number", description: "Tempo máximo de espera pela resposta, em segundos (padrão 180, máx 600)." },
            },
            required: ["prompt"],
        },
        handler: async (args) => {
            if (!active) return { resultType: "failure", textResultForLlm: "Nenhuma máquina remota conectada. " + TOOL_CONNECTED_HINT };
            let prompt = String(args?.prompt || "").trim();
            let attachments = [];
            let fileNotes = "";
            const files = Array.isArray(args?.files) ? args.files : [];
            if (files.length) {
                const fp = buildFilePayload(files, prompt);
                prompt = fp.prompt;
                attachments = fp.attachments;
                fileNotes = fp.notes.length ? `(${fp.notes.join("; ")})\n\n` : "";
            }
            if (!prompt && !attachments.length) return { resultType: "failure", textResultForLlm: "remote_ask: 'prompt' vazio (e nenhum arquivo válido)." };
            const ts = Math.min(600, Math.max(10, Number(args?.timeoutSeconds) || 180));
            try {
                const r = await remoteAsk(prompt || "(arquivo em anexo)", ts * 1000, attachments);
                return { resultType: "success", textResultForLlm: fileNotes + formatTurn(r) };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: "remote_ask falhou: " + (e?.message || e) };
            }
        },
    },
    {
        name: "remote_send_file",
        description: "Envia um ou mais ARQUIVOS LOCAIS desta máquina ao agente da máquina remota e aguarda a resposta. Arquivos de texto (diagrama mermaid .mmd, .md, código, .json, .svg…) são embutidos no prompt; imagens (.png/.jpg/.webp/.gif) vão como anexo. Use para mandar um diagrama/spec/arquivo para o agente remoto revisar ou implementar.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Caminho de um único arquivo local (atalho)." },
                paths: { type: "array", items: { type: "string" }, description: "Caminho(s) de arquivo local (use isto para vários)." },
                instruction: { type: "string", description: "Instrução que acompanha o(s) arquivo(s), ex.: 'revise este diagrama e aponte erros'." },
                timeoutSeconds: { type: "number", description: "Tempo máximo de espera (padrão 180, máx 600)." },
            },
        },
        handler: async (args) => {
            if (!active) return { resultType: "failure", textResultForLlm: "Nenhuma máquina remota conectada. " + TOOL_CONNECTED_HINT };
            const list = Array.isArray(args?.paths) ? args.paths.slice() : [];
            if (args?.path) list.unshift(String(args.path));
            if (!list.length) return { resultType: "failure", textResultForLlm: "remote_send_file: informe 'path' ou 'paths'." };
            const { prompt, attachments, notes } = buildFilePayload(list, String(args?.instruction || "").trim());
            if (!prompt && !attachments.length) return { resultType: "failure", textResultForLlm: "Nenhum arquivo válido. " + notes.join("; ") };
            const ts = Math.min(600, Math.max(10, Number(args?.timeoutSeconds) || 180));
            try {
                const r = await remoteAsk(prompt || "(arquivo em anexo)", ts * 1000, attachments);
                return { resultType: "success", textResultForLlm: `Enviado: ${notes.join("; ")}.\n\n` + formatTurn(r) };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: "remote_send_file falhou: " + (e?.message || e) };
            }
        },
    },
    {
        name: "remote_answer",
        description: "Responde a uma pergunta (ask_user) que o agente remoto fez — quando um remote_ask anterior retornou status de pergunta. Envia sua resposta e aguarda o próximo trecho da resposta do agente remoto.",
        parameters: {
            type: "object",
            properties: {
                answer: { type: "string", description: "A resposta à pergunta do agente remoto." },
                timeoutSeconds: { type: "number", description: "Tempo máximo de espera (padrão 180, máx 600)." },
            },
            required: ["answer"],
        },
        handler: async (args) => {
            if (!active) return { resultType: "failure", textResultForLlm: "Nenhuma máquina remota conectada. " + TOOL_CONNECTED_HINT };
            const answer = String(args?.answer || "").trim();
            if (!answer) return { resultType: "failure", textResultForLlm: "remote_answer: 'answer' vazio." };
            const ts = Math.min(600, Math.max(10, Number(args?.timeoutSeconds) || 180));
            try {
                const r = await remoteAnswerAndWait(answer, ts * 1000);
                return { resultType: "success", textResultForLlm: formatTurn(r) };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: "remote_answer falhou: " + (e?.message || e) };
            }
        },
    },
    {
        name: "remote_permission",
        description: "Aprova ou recusa um pedido de permissão do agente remoto (rodar comando, escrever arquivo, etc.) — quando um remote_ask/remote_answer anterior retornou status de permissão. Depois de decidir, aguarda o próximo trecho da resposta do agente remoto.",
        parameters: {
            type: "object",
            properties: {
                requestId: { type: "string", description: "O requestId da permissão (vem no resultado do remote_ask)." },
                decision: { type: "string", enum: ["approve", "reject"], description: "approve para permitir, reject para recusar." },
                timeoutSeconds: { type: "number", description: "Tempo máximo de espera (padrão 180, máx 600)." },
            },
            required: ["requestId", "decision"],
        },
        handler: async (args) => {
            if (!active) return { resultType: "failure", textResultForLlm: "Nenhuma máquina remota conectada. " + TOOL_CONNECTED_HINT };
            const requestId = String(args?.requestId || "");
            const decision = args?.decision;
            if (!requestId || (decision !== "approve" && decision !== "reject")) return { resultType: "failure", textResultForLlm: "remote_permission: informe requestId e decision ('approve'|'reject')." };
            const ts = Math.min(600, Math.max(10, Number(args?.timeoutSeconds) || 180));
            try {
                const r = await remotePermissionAndWait(requestId, decision, ts * 1000);
                return { resultType: "success", textResultForLlm: formatTurn(r) };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: "remote_permission falhou: " + (e?.message || e) };
            }
        },
    },
    {
        name: "remote_abort",
        description: "Aborta o turno atual do agente remoto (equivale ao Stop). Use se o agente remoto travou ou seguiu por um caminho errado.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            if (!active) return { resultType: "failure", textResultForLlm: "Nenhuma máquina remota conectada." };
            try { await active.client.abort(); return { resultType: "success", textResultForLlm: "Abort enviado ao agente remoto." }; }
            catch (e) { return { resultType: "failure", textResultForLlm: "remote_abort falhou: " + (e?.message || e) }; }
        },
    },

    // ===== DAEMON tools (multi-session): control ANY session on a machine running the copilot-mobile daemon =====
    {
        name: "remote_daemon_status",
        description: "Detecta o daemon copilot-mobile (na máquina local por padrão, lendo runtime.json) e lista as sessões do app que ele controla. Use antes de remote_session_ask para escolher a sessionId certa pelo título.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL base do daemon remoto (ex.: http://100.x.x.x:PORT). Omita para usar o daemon LOCAL desta máquina." },
                token: { type: "string", description: "Token do daemon (x-copilot-token). Omita para o daemon local (lido do runtime.json)." },
            },
        },
        handler: async (args) => {
            try {
                const dc = await ensureDaemon(args?.url, args?.token);
                if (!dc) return { resultType: "failure", textResultForLlm: "Daemon não encontrado. Localmente, confirme que o tray do copilot-mobile está rodando (runtime.json em ~/.copilot-mobile-daemon). Para um daemon remoto, passe url+token." };
                const ping = await dc.ping();
                const sessions = await dc.listSessions();
                const lines = [`Daemon OK (mode=${ping.mode || "?"}, paired=${!!ping.paired}). ${sessions.length} sessões:`];
                for (const s of sessions.slice(0, 40)) lines.push(`  • ${s.sessionId}  ${s.running ? "▶" : "·"}  "${String(s.title || "").slice(0, 60)}"`);
                lines.push("\nUse remote_session_ask { sessionId, prompt } para falar com o agente de uma sessão.");
                return { resultType: "success", textResultForLlm: lines.join("\n") };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: "remote_daemon_status falhou: " + (e?.message || e) };
            }
        },
    },
    {
        name: "remote_session_ask",
        description: "Envia uma instrução ao agente de UMA sessão específica da máquina remota (via daemon) e AGUARDA a resposta. Pegue a sessionId com remote_daemon_status. Se o agente remoto fizer uma pergunta, o resultado indica (responder pergunta via daemon ainda não é suportado).",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", description: "A sessionId alvo (de remote_daemon_status)." },
                prompt: { type: "string", description: "A instrução para o agente daquela sessão. Use 'continue' para seguir aguardando um turno longo." },
                timeoutSeconds: { type: "number", description: "Tempo máximo de espera (padrão 180, máx 600)." },
            },
            required: ["sessionId", "prompt"],
        },
        handler: async (args) => {
            const dc = await ensureDaemon();
            if (!dc) return { resultType: "failure", textResultForLlm: "Daemon não conectado. Rode remote_daemon_status primeiro." };
            const sessionId = String(args?.sessionId || "").trim();
            const prompt = String(args?.prompt || "").trim();
            if (!sessionId || !prompt) return { resultType: "failure", textResultForLlm: "remote_session_ask: informe sessionId e prompt." };
            const ts = Math.min(600, Math.max(10, Number(args?.timeoutSeconds) || 180));
            try {
                const r = await dc.ask(sessionId, prompt, { timeoutMs: ts * 1000 });
                return { resultType: "success", textResultForLlm: formatDaemonTurn(sessionId, r) };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: "remote_session_ask falhou: " + (e?.message || e) };
            }
        },
    },
    {
        name: "remote_session_abort",
        description: "Aborta o turno atual de uma sessão específica da máquina remota (via daemon).",
        parameters: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
        handler: async (args) => {
            const dc = await ensureDaemon();
            if (!dc) return { resultType: "failure", textResultForLlm: "Daemon não conectado." };
            try { await dc.abort(String(args?.sessionId || "")); return { resultType: "success", textResultForLlm: "Abort enviado à sessão." }; }
            catch (e) { return { resultType: "failure", textResultForLlm: "remote_session_abort falhou: " + (e?.message || e) }; }
        },
    },
    {
        name: "remote_daemon_connect",
        description: "Pareia com o daemon copilot-mobile de OUTRA máquina como dispositivo 'peer' (coexiste com o celular, sem derrubá-lo). Na 1ª vez exige o código de 6 dígitos mostrado no painel do daemon remoto (arme um modo lan/tailscale/public lá). Depois reconecta sozinho. Use a URL exposta do daemon (ex.: http://100.x.x.x:PORT do tailscale).",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL base exposta do daemon remoto (ex.: http://100.85.138.90:61453)." },
                code: { type: "string", description: "Código de pareamento de 6 dígitos do painel do daemon remoto." },
                name: { type: "string", description: "Apelido desta máquina controladora (opcional)." },
            },
            required: ["url", "code"],
        },
        handler: async (args) => {
            const url = String(args?.url || "").trim().replace(/\/+$/, "");
            const code = String(args?.code || "").trim();
            if (!/^https?:\/\//i.test(url)) return { resultType: "failure", textResultForLlm: "remote_daemon_connect: URL inválida (use http:// ou https://)." };
            if (!code) return { resultType: "failure", textResultForLlm: "remote_daemon_connect: informe o código de pareamento." };
            try { daemonClient?.close(); } catch {}
            const dc = new DaemonClient({ baseUrl: url, name: args?.name || "Controle Remoto (peer)" });
            try {
                const creds = await dc.pairAsPeer(code);
                // persist so we reconnect without a code next time
                remoteDaemons = remoteDaemons.filter((d) => String(d.url).replace(/\/+$/, "") !== url);
                remoteDaemons.push({ url, token: creds.token, deviceId: creds.deviceId, deviceSecret: creds.deviceSecret, name: dc.name });
                saveState();
                daemonClient = dc;
                const ping = await dc.ping();
                const sessions = await dc.listSessions();
                return { resultType: "success", textResultForLlm: `Pareado como peer com o daemon ${url} (mode=${ping.mode || "?"}). ${sessions.length} sessões disponíveis. Use remote_daemon_status para listar e remote_session_ask para falar com uma sessão.` };
            } catch (e) {
                return { resultType: "failure", textResultForLlm: `remote_daemon_connect falhou: ${e?.message || e}. Confirme que o daemon remoto está ARMADO (lan/tailscale/public) e o código está válido.` };
            }
        },
    },
];

// ---------- daemon connection (shared across the daemon tools) ----------
let daemonClient = null;

async function ensureDaemon(url, token) {
    // Explicit target by URL: a paired remote daemon (reconnect via saved peer creds),
    // or an ad-hoc one with an explicit token.
    if (url) {
        const base = String(url).replace(/\/+$/, "");
        if (daemonClient && daemonClient.baseUrl === base) return daemonClient;
        try { daemonClient?.close(); } catch {}
        const saved = remoteDaemons.find((d) => String(d.url).replace(/\/+$/, "") === base);
        if (saved) {
            daemonClient = new DaemonClient({ baseUrl: base, token: saved.token, deviceId: saved.deviceId, deviceSecret: saved.deviceSecret });
            try { await daemonClient.ensureToken(); } catch {} // refresh peer token if needed
        } else {
            daemonClient = new DaemonClient({ baseUrl: base, token: token || null });
        }
        return daemonClient;
    }
    if (daemonClient) return daemonClient;
    const local = localDaemonInfo();
    if (!local) return null;
    daemonClient = new DaemonClient(local);
    return daemonClient;
}

function formatDaemonTurn(sessionId, r) {
    const tag = sessionId.slice(0, 8);
    if (r.status === "idle") return `[sessão ${tag}] respondeu:\n\n${r.reply || "(sem texto)"}`;
    if (r.status === "aborted") return `[sessão ${tag}] turno abortado.${r.reply ? "\n\nParcial:\n" + r.reply : ""}`;
    if (r.status === "timeout") return `[sessão ${tag}] ainda não terminou (timeout).${r.reply ? "\n\nParcial:\n" + r.reply : ""}\n\nChame remote_session_ask com prompt "continue" para seguir aguardando, ou remote_session_abort.`;
    if (r.status === "question") {
        const q = r.question || {};
        const ch = (q.choices || []).length ? `\nOpções: ${q.choices.join(" | ")}` : "";
        return `[sessão ${tag}] está PERGUNTANDO:\n\n${q.question}${ch}\n\n⚠ Responder pergunta via daemon ainda NÃO é suportado (o daemon não expõe /answer). A sessão remota está aguardando — use remote_session_abort para liberar, ou responda pelo app/celular.${r.reply ? "\n\nContexto:\n" + r.reply : ""}`;
    }
    if (r.status === "permission") {
        const p = r.permission || {};
        return `[sessão ${tag}] pediu permissão (${p.title} ${p.detail}). Obs: o daemon normalmente auto-aprova; se apareceu, trate pelo app.`;
    }
    return `[sessão ${tag}] status: ${r.status}\n${r.reply || ""}`;
}

// ---------- boot ----------
loadState();
const session = await joinSession({ canvases: [canvas], tools });
dbg(`boot: targets=${targets.length} active=${activeTargetId || "(none)"} tools=${tools.length}`);
