// Extension: copilot-mobile
// Control the local Copilot agent from your phone — transport-gated bridge.
//
// Architecture (mirrors the proven voice-chat pattern):
//   joinSession() -> session.send({prompt}) injects into the agent main loop;
//   session.on(...) observes the reply; a local HTTP+SSE server fans events out.
//
// Security model ("o gate fica na máquina"):
//   * A loopback server (127.0.0.1) is always available for the desktop canvas.
//   * External exposure (lan / tailscale / public) only happens when the user
//     explicitly ARMS a mode from the DESKTOP canvas. Closing returns to
//     loopback-only. The phone can NEVER change the transport mode — /mode,
//     /status and pairing-admin require a loopback request + the desktop token.
//   * Phones authenticate with a short-lived pairing CODE (shown on desktop)
//     which they exchange for a mobile token. Default mode = off (no egress).
//
// stdout is reserved for JSON-RPC — never console.log(); use dbg()/session.log().

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import * as access from "./access.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(EXT_DIR, "artifacts");
const DEBUG_LOG = join(ARTIFACTS, "debug.log");
const FILES = {
    "/": { path: join(EXT_DIR, "desktop.html"), type: "text/html; charset=utf-8" },
    "/desktop": { path: join(EXT_DIR, "desktop.html"), type: "text/html; charset=utf-8" },
    "/qrcode.min.js": { path: join(EXT_DIR, "qrcode.min.js"), type: "text/javascript; charset=utf-8" },
};

const FIXED_PORT = Number(process.env.COPILOT_MOBILE_PORT) || 0; // 0 = ephemeral (Windows assigns)
const MODES = ["off", "lan", "tailscale", "public"]; // "off" = loopback-only baseline
const PAIR_TTL_MS = 5 * 60 * 1000; // legacy fallback TTL (used if rotation is off)
const PAIR_ROTATE_MS = 60 * 1000; // rolling code: regenerate every 60s
const PAIR_GRACE_MS = 100 * 1000; // a just-rotated code stays valid this long (overlap)
const MAX_PROMPT = 16000;
const RECENT_MAX = 60;
const STATE_FILE = join(ARTIFACTS, "state.json"); // remembers the chosen LAN port
const BIN_DIR = join(ARTIFACTS, "bin"); // auto-provisioned tools (cloudflared)
function ruleNameFor(port) { return "CopilotMobile-LAN-" + port; } // port-based firewall rule

// ---------- logging ----------
function dbg(msg) {
    try {
        mkdirSync(ARTIFACTS, { recursive: true });
        appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [pid:${process.pid}] ${msg}\n`);
    } catch {}
}

// ---------- tokens / pairing ----------
let desktopToken = randomBytes(16).toString("hex"); // loopback-only; persisted by loadState so the canvas URL stays stable across restarts (prevents the seed->republish freeze)
let mobileToken = null; // issued when arming external exposure
let pairing = null; // { code, rotatesAt }  — current rolling code
let recentCodes = []; // [{ code, validUntil }] — just-rotated codes still accepted (grace)
let pairRotateTimer = null;

function newMobileToken() {
    mobileToken = randomBytes(24).toString("hex");
    return mobileToken;
}
function newPairingCode() {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    pairing = { code, rotatesAt: Date.now() + PAIR_ROTATE_MS };
    return code;
}
// Rolling code: retire the current code into a short grace window, then mint a
// new one. A phone that scanned the old QR seconds ago can still pair.
function rotatePairingCode() {
    if (!pairing || mode === "off") return;
    recentCodes.push({ code: pairing.code, validUntil: Date.now() + PAIR_GRACE_MS });
    recentCodes = recentCodes.filter((c) => c.validUntil > Date.now());
    newPairingCode();
    broadcast({ type: "mode", snapshot: snapshot() }); // panel refreshes the QR
}
function startPairRotation() {
    stopPairRotation();
    pairRotateTimer = setInterval(rotatePairingCode, PAIR_ROTATE_MS);
    pairRotateTimer.unref?.();
}
function stopPairRotation() {
    if (pairRotateTimer) clearInterval(pairRotateTimer);
    pairRotateTimer = null;
    recentCodes = [];
}
function pairingValid() {
    // Rolling code is for onboarding the ONE device; once pinned, pairing closes.
    return !!pairing && mode !== "off" && !pinnedDevice;
}
function codeAccepted(code) {
    if (pairing && code === pairing.code) return true;
    const now = Date.now();
    return recentCodes.some((c) => c.code === code && c.validUntil > now);
}

// ---------- runtime state ----------
let session = null;
let busy = false;
let busyWatchdog = null; // failsafe: clears a stuck "busy" if the agent goes silent
let mode = "off";
let persistedMode = null; // last armed mode loaded from state.json; used to auto-rearm the owner session on boot
const SELF_SESSION_ID = process.env.SESSION_ID || ""; // this fork's session id (set by the CLI host)
let activeMobileSessionId = null; // the ONE session that "owns" mobile; only its fork registers the ask_user override (scoped, never global)
let overrideRegistered = false;   // whether THIS fork registered the ask_user override (decided at join time)
let exposedUrl = null; // base URL the APK connects to, e.g. http://192.168.0.5:8765
let externalServer = null; // http.Server bound to LAN / tailscale
let tunnel = null; // { proc, url, kind }
let loopServer = null;
let loopPort = 0;
let persistedLoopPort = 0; // remembered loopback port so the canvas URL is stable across restarts
let tunnelServer = null; // loopback target the public tunnel forwards to (marks reqs external)
let tunnelPort = 0;
let lanPort = 0; // chosen LAN port: Windows-assigned the first time, then remembered
let tsPort = 0;  // tailscale port (ephemeral each arm; no firewall rule needed)
let provisioning = null; // human-readable status while auto-downloading a tool
let warpPausedByUs = false; // true if we disconnected WARP to let the tunnel work
let caPoolPath = null; // exported system-CA PEM for cloudflared --origin-ca-pool
let network = { online: true, edgeReachable: true, downloadReachable: true, intercepted: false, interceptionIssuer: null, systemCaCount: 0, checkedAt: 0 };
let caps = {
    tailscale: { installed: false, up: false, ip: null, dnsName: null },
    cloudflared: false,
    ngrok: false,
    warp: { installed: false, connected: false },
    profiles: [],
    lanRule: false,
    checkedAt: 0,
};

const sseClients = new Set(); // { res, role, external, addr, id }
const recent = []; // ring buffer of recent agent events (replayed to new clients)
const activity = []; // gate / security audit log
const pendingEcho = []; // prompts already echoed via /send, to dedupe the user.message event

function consumePendingEcho(content) {
    const now = Date.now();
    for (let i = pendingEcho.length - 1; i >= 0; i--) {
        if (now - pendingEcho[i].ts > 15000) pendingEcho.splice(i, 1); // prune stale
    }
    const norm = (content || "").trim();
    const idx = pendingEcho.findIndex((p) => p.content === norm);
    if (idx >= 0) {
        pendingEcho.splice(idx, 1);
        return true;
    }
    return false;
}

function logActivity(kind, detail) {
    activity.unshift({ t: Date.now(), kind, detail: detail || "" });
    if (activity.length > 100) activity.length = 100;
    dbg(`ACT ${kind} ${detail || ""}`);
}

// ---------- persisted state (LAN port + the single pinned device) ----------
let pinnedDevice = null; // { id, secretHash, name, pinnedAt } — the ONE authorized phone

function loadState() {
    if (FIXED_PORT) lanPort = FIXED_PORT;
    try {
        const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
        if (!FIXED_PORT && Number.isInteger(s?.lanPort) && s.lanPort >= 1024 && s.lanPort <= 65535) lanPort = s.lanPort;
        if (typeof s?.desktopToken === "string" && /^[0-9a-f]{32}$/.test(s.desktopToken)) desktopToken = s.desktopToken;
        if (Number.isInteger(s?.loopPort) && s.loopPort >= 1024 && s.loopPort <= 65535) persistedLoopPort = s.loopPort;
        if (typeof s?.activeMobileSessionId === "string" && s.activeMobileSessionId) activeMobileSessionId = s.activeMobileSessionId;
        if (typeof s?.mode === "string" && MODES.includes(s.mode)) persistedMode = s.mode;
        if (s?.device?.id && s?.device?.secretHash) pinnedDevice = s.device;
    } catch {}
}
function saveState() {
    try {
        mkdirSync(ARTIFACTS, { recursive: true });
        const obj = {};
        if (!FIXED_PORT) obj.lanPort = lanPort;
        obj.desktopToken = desktopToken;
        if (loopPort) obj.loopPort = loopPort;
        if (activeMobileSessionId) obj.activeMobileSessionId = activeMobileSessionId;
        obj.mode = mode; // remember the armed mode so the owner session can auto-rearm on boot
        if (pinnedDevice) obj.device = pinnedDevice;
        writeFileSync(STATE_FILE, JSON.stringify(obj));
    } catch (e) {
        dbg("saveState failed: " + e.message);
    }
}
function hashSecret(s) {
    return createHash("sha256").update(String(s)).digest("hex");
}
// Pin the single authorized device (precursor to the native app's hardware key:
// the stored secret becomes a hardware-backed challenge-response later).
function pinDevice(name) {
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(32).toString("hex");
    pinnedDevice = { id, secretHash: hashSecret(secret), name: String(name || "Celular").slice(0, 40), pinnedAt: Date.now() };
    saveState();
    return { id, secret };
}
function forgetDevice() {
    pinnedDevice = null;
    activeMobileSessionId = null; // releasing the pinned phone also releases mobile ownership → native ask_user returns on next reload
    saveState();
    dropMobileClients();
    logActivity("device", "esquecido (pode parear outro)");
}
function deviceAuthOk(id, secret) {
    return !!pinnedDevice && id === pinnedDevice.id && hashSecret(secret) === pinnedDevice.secretHash;
}
function dropMobileClients() {
    for (const c of [...sseClients]) {
        if (c.role === "mobile") { try { c.res.end(); } catch {} sseClients.delete(c); }
    }
}

// Reserve a stable LAN port the first time (probe a free port via loopback so we
// never flash the Windows firewall prompt), then remember it for the rule + binds.
async function ensureLanPort() {
    if (lanPort) return lanPort;
    const tmp = await listenServer("127.0.0.1", 0, true); // loopback probe = no firewall prompt
    lanPort = tmp.address().port;
    await closeServer(tmp);
    saveState();
    return lanPort;
}

// Pause WARP so cloudflared can reach the Cloudflare edge; remember we did it so
// we can resume on teardown. No-op if WARP isn't connected.
async function pauseWarpForTunnel() {
    if (warpPausedByUs) return;
    const w = await access.detectWarp();
    if (!w.installed || !w.connected) return;
    const r = await access.warpSet(false);
    if (r.ok) {
        warpPausedByUs = true;
        caps.warp.connected = false;
        logActivity("warp", "pausado (conflito com túnel)");
    } else {
        logActivity("warp", "falha ao pausar: " + (r.error || ""));
    }
}
async function resumeWarpIfPaused() {
    if (!warpPausedByUs) return;
    const r = await access.warpSet(true);
    warpPausedByUs = false;
    caps.warp.connected = r.ok;
    logActivity("warp", r.ok ? "retomado" : "falha ao retomar: " + (r.error || ""));
}

// ---------- SSE fan-out ----------
function writeSse(client, obj) {
    try {
        client.res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {}
}
function broadcast(obj) {
    for (const c of sseClients) writeSse(c, obj);
}
let seqCounter = 0;
const pendingPerms = new Map(); // requestId → { requestId, kind, title, detail, intention, warning, ts }
const toolNames = new Map(); // toolCallId → toolName (so tool_done always has a name, never "undefined")
let pendingQuestion = null; // active ask_user: { id, question, choices[], ts } — null when none
let userInputInterestHandle = null; // eventLog.registerInterest handle (active only while exposed)
let activeInputResolve = null; // resolver for an onUserInputRequest awaiting the phone's answer
let lastNotifiedReqId = null; // requestId from user_input.requested notification (to nudge the host card)
let userInputHandlerActive = false; // true while WE own the ask_user handler (exposed) — no host card

// Build a phone-friendly summary from a PermissionRequest (shell/write/read/...).
function summarizePermission(pr) {
    if (!pr) return { title: "Permissão", detail: "", intention: "", warning: "" };
    const i = pr.intention || "";
    switch (pr.kind) {
        case "shell": return { title: "Executar comando", detail: pr.fullCommandText || "", intention: i, warning: pr.warning || "" };
        case "write": return { title: "Escrever arquivo", detail: pr.fileName || "", intention: i, warning: "" };
        case "read": return { title: "Ler arquivo", detail: pr.fileName || pr.path || "", intention: i, warning: "" };
        case "url": return { title: "Acessar URL", detail: pr.url || "", intention: i, warning: "" };
        case "mcp": return { title: "Ferramenta MCP", detail: pr.toolName || "", intention: i, warning: "" };
        default: return { title: "Permissão: " + (pr.kind || "?"), detail: pr.fileName || pr.path || pr.url || "", intention: i, warning: "" };
    }
}

function recordAndBroadcast(obj) {
    obj.seq = ++seqCounter; // monotonic id so polling clients can dedup/catch up
    recent.push(obj);
    if (recent.length > RECENT_MAX) recent.shift();
    broadcast(obj);
}

// ---------- spoken-summary (the phone's "audio message", WhatsApp-style) ----------
// The phone must NOT read the whole reply. Instead — exactly like the voice-chat sibling —
// the agent authors a one-line spoken summary after a 🔊 marker, and ONLY that line becomes
// an audio bubble on the phone. No 🔊 ⇒ no audio. We also inject the instruction each turn
// (while armed) so every reply carries a 🔊 summary.
const VOICE_SENTINEL = "🔊";
const CHECKPOINT_SENTINEL = "📍";
const VOICE_SUMMARY_INSTRUCTION =
    "Esta conversa está sendo acompanhada pelo celular (copilot-mobile). Responda normalmente no chat e, " +
    'ao FINAL da resposta, acrescente uma última linha começando exatamente com "🔊 " seguida de um RESUMO ' +
    "FALADO autoexplicativo da sua própria resposta: de 1 a 3 frases curtas, em português do Brasil, naturais " +
    "e completas (sem cortar no meio), sem markdown, sem listas, sem código e sem outros emojis. Essa linha 🔊 " +
    "é exatamente o que vira a mensagem de áudio no celular, então escreva-a para ser ouvida com clareza.";
function cleanForSpeech(md) {
    let t = String(md || "");
    t = t.replace(/```[\s\S]*?```/g, " ");          // drop fenced code blocks
    t = t.replace(/`([^`]+)`/g, "$1");               // inline code -> content
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");     // images
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");   // links -> text
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");        // headings
    t = t.replace(/^\s{0,3}>\s?/gm, "");             // blockquotes
    t = t.replace(/^\s*[-*+]\s+/gm, "");             // bullets
    t = t.replace(/^\s*\d+\.\s+/gm, "");             // numbered lists
    t = t.replace(/[*_~]{1,3}/g, "");                // emphasis markers
    t = t.replace(/<[^>]+>/g, " ");                  // html tags
    t = t.replace(/\|/g, " ");                       // table pipes
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ""); // emojis/symbols
    t = t.replace(/\r/g, "");
    t = t.replace(/\n{2,}/g, ". ");
    t = t.replace(/\n/g, ". ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/(\.\s*){2,}/g, ". ");             // collapse repeated periods
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
// The audio bubble text — ONLY the agent-authored 🔊 line, cleaned. Empty ⇒ no audio bubble.
function audioSummaryFrom(content) {
    const authored = extractAuthoredSummary(content);
    if (!authored) return "";
    let s = cleanForSpeech(authored);
    if (s.length > 1200) s = firstSentences(s, 1200);
    return s;
}
// The chat text to DISPLAY — strip the trailing 🔊 line (and any checkpoint 📍 lines), since the
// summary is surfaced as the audio bubble, not as visible text.
function stripVoiceArtifacts(content) {
    let s = String(content || "");
    const idx = s.lastIndexOf(VOICE_SENTINEL);
    if (idx !== -1) s = s.slice(0, idx);
    s = s.split("\n").filter((ln) => !ln.includes(CHECKPOINT_SENTINEL)).join("\n");
    return s.replace(/\n+\s*$/, "").trimEnd();
}

// Centralized busy state so the phone never gets stuck on "thinking…".
// Busy is driven by the REAL turn lifecycle: assistant.turn_start -> true,
// assistant.turn_end / abort -> false. (There is no session.idle event.)
// A watchdog is the last-resort failsafe if a turn dies without any terminal event.
const BUSY_WATCHDOG_MS = 180000;
function setBusy(value) {
    if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
    if (value) {
        busyWatchdog = setTimeout(() => {
            busy = false;
            broadcast({ type: "busy", busy: false });
            dbg("busy watchdog fired — cleared stuck busy");
        }, BUSY_WATCHDOG_MS);
        busyWatchdog.unref?.();
    }
    if (busy !== value) {
        busy = value;
        broadcast({ type: "busy", busy });
    }
}
// Refresh the watchdog during a long-running turn (e.g. a slow tool) WITHOUT
// ever flipping busy false->true, so a stray late event can't re-stick the phone.
function touchBusy() { if (busy) setBusy(true); }

function snapshot() {
    return {
        mode,
        exposed: mode !== "off",
        exposedUrl,
        externalPort: lanPort || null,
        busy,
        lanUrls: lanPort ? lanCandidates().map((ip) => `http://${ip}:${lanPort}`) : [],
        tailscaleIp: tailscaleIp(),
        pairingCode: pairingValid() ? pairing.code : null,
        pairingRotatesIn: pairingValid() ? Math.max(0, pairing.rotatesAt - Date.now()) : 0,
        pairingRolling: true,
        pending: [...pendingPerms.values()],
        question: pendingQuestion,
        device: pinnedDevice ? { name: pinnedDevice.name, pinnedAt: pinnedDevice.pinnedAt } : null,
        deviceConnected: [...sseClients].some((c) => c.role === "mobile"),
        devices: [...sseClients].map((c) => ({ id: c.id, role: c.role, addr: c.addr, external: c.external })),
        activity: activity.slice(0, 30),
        tunnel: tunnel ? { kind: tunnel.kind, url: tunnel.url } : null,
        provisioning,
        caps,
        network,
        warpPaused: warpPausedByUs,
        lanPort: lanPort || null,
        fixedPort: !!FIXED_PORT,
        ruleName: lanPort ? ruleNameFor(lanPort) : null,
        modeStatus: {
            lan: caps.lanRule ? "ready" : "needs_admin",
            tailscale: caps.tailscale.up ? "ready" : (caps.tailscale.installed ? "needs_connect" : "needs_install"),
            public: caps.cloudflared || caps.ngrok ? "ready" : "auto_download",
        },
    };
}

// ---------- network helpers ----------
function lanIps() {
    const out = [];
    const ifs = networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const ni of ifs[name] || []) {
            if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
        }
    }
    return out;
}
function isCgnat(ip) {
    // Tailscale uses the 100.64.0.0/10 CGNAT range (100.64.x – 100.127.x)
    const m = /^100\.(\d+)\./.exec(ip);
    return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}
function isLinkLocal(ip) {
    return /^169\.254\./.test(ip); // APIPA / auto-config — not routable for phones
}
function privateRank(ip) {
    if (/^192\.168\./.test(ip)) return 0; // most common home/Wi-Fi range
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 5; // other (e.g. a real public IP on the NIC)
}
function lanCandidates() {
    return lanIps()
        .filter((ip) => !isCgnat(ip) && !isLinkLocal(ip))
        .sort((a, b) => privateRank(a) - privateRank(b));
}
function pickLanUrl() {
    const ip = lanCandidates()[0];
    return ip && lanPort ? `http://${ip}:${lanPort}` : null;
}
function tailscaleIp() {
    return lanIps().find((x) => isCgnat(x)) || null;
}

// ---------- auth ----------
function isLoopbackReq(req) {
    const a = req.socket.remoteAddress || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || a.startsWith("127.");
}
function tokenFrom(req, url) {
    return req.headers["x-copilot-token"] || url.searchParams.get("t") || "";
}
// Auth is computed per-request inside handleRequest from `external` (which honors
// forceExternal for tunnel-forwarded requests). Desktop endpoints require a
// non-external request + the desktop token; the phone can never reach them.

// ---------- HTTP server ----------
function readBody(req, cap = 1 << 20) {
    return new Promise((resolve) => {
        let buf = "";
        let n = 0;
        req.on("data", (c) => {
            n += c.length;
            if (n > cap) {
                try { req.destroy(); } catch {}
                resolve(null);
            } else buf += c;
        });
        req.on("end", () => {
            if (!buf) return resolve({});
            try { resolve(JSON.parse(buf)); } catch { resolve(null); }
        });
        req.on("error", () => resolve(null));
    });
}
function sendJson(res, obj, code = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
}

// Validate phone-sent attachments: only inline image blobs, base64, capped count/size.
// Returns a clean array of { data, mimeType, displayName } or [] when none/invalid.
const ATT_OK_MIME = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;
function sanitizeAttachments(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const a of arr.slice(0, 6)) { // cap: 6 images per message
        if (!a || typeof a !== "object") continue;
        const mimeType = typeof a.mimeType === "string" ? a.mimeType : "";
        let data = typeof a.data === "string" ? a.data : "";
        if (data.startsWith("data:")) { const i = data.indexOf(","); if (i >= 0) data = data.slice(i + 1); }
        if (!ATT_OK_MIME.test(mimeType) || data.length < 8) continue;
        if (data.length > 16 * 1024 * 1024) continue; // ~12MB decoded ceiling
        out.push({ data, mimeType, displayName: typeof a.displayName === "string" ? a.displayName.slice(0, 80) : "imagem.jpg" });
    }
    return out;
}
async function serveFile(res, entry) {
    try {
        const binary = /image\/png|image\/jpeg|application\/octet-stream/.test(entry.type);
        const data = await readFile(entry.path, binary ? undefined : "utf8");
        res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" });
        res.end(data);
    } catch (e) {
        res.writeHead(404);
        res.end("not found: " + e.message);
    }
}

async function handleRequest(req, res, forceExternal = false) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const external = forceExternal || !isLoopbackReq(req);
    const tok = tokenFrom(req, url);
    const isDesktop = !external && tok === desktopToken;
    const clientRole = isDesktop ? "desktop" : (mobileToken && tok === mobileToken ? "mobile" : null);

    // Static assets (the HTML shell is harmless without a token; the APIs gate).
    if (req.method === "GET" && FILES[path]) {
        return serveFile(res, FILES[path]);
    }

    // --- pairing: onboard the SINGLE device (code → token + device credentials) ---
    if (req.method === "POST" && path === "/pair/claim") {
        const body = await readBody(req);
        if (!body || typeof body.code !== "string") return sendJson(res, { ok: false, error: "bad_request" }, 400);
        if (pinnedDevice) { // single-device: a phone is already pinned
            logActivity("pair_fail", `addr=${req.socket.remoteAddress} (já pareado)`);
            return sendJson(res, { ok: false, error: "device_already_pinned" }, 409);
        }
        if (!mobileToken || !pairingValid() || !codeAccepted(body.code)) {
            logActivity("pair_fail", `addr=${req.socket.remoteAddress}`);
            return sendJson(res, { ok: false, error: "invalid_code" }, 403);
        }
        const dev = pinDevice(body.name); // pin this phone as the only authorized one
        dropMobileClients(); // single connection: drop any prior mobile stream
        logActivity("pair_ok", `${pinnedDevice.name} fixado (${req.socket.remoteAddress})`);
        broadcast({ type: "devices", snapshot: snapshot() });
        return sendJson(res, { ok: true, token: mobileToken, deviceId: dev.id, deviceSecret: dev.secret });
    }

    // --- device re-auth: pinned phone gets a fresh token without a code ---
    // Lets the registered device reconnect after a re-arm / token rotation.
    if (req.method === "POST" && path === "/device/auth") {
        const body = await readBody(req);
        if (!body || !body.deviceId || !body.deviceSecret) return sendJson(res, { ok: false, error: "bad_request" }, 400);
        if (mode === "off" || !mobileToken) return sendJson(res, { ok: false, error: "not_exposed" }, 409);
        if (!deviceAuthOk(body.deviceId, body.deviceSecret)) {
            logActivity("device_auth_fail", `addr=${req.socket.remoteAddress}`);
            return sendJson(res, { ok: false, error: "unauthorized" }, 403);
        }
        return sendJson(res, { ok: true, token: mobileToken });
    }

    // --- SSE event stream (desktop or paired phone) ---
    if (req.method === "GET" && path === "/events") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no", // hint proxies (nginx etc.) not to buffer
        });
        // Disable Nagle: push every SSE frame the instant it's written instead of
        // waiting to coalesce packets. This is the bulk of the perceived latency on
        // LAN — without it small event frames can sit ~40ms+ in the TCP buffer.
        try { res.socket?.setNoDelay(true); } catch {}
        // 2KB padding comment: nudges buffering proxies to flush early. If the
        // proxy still buffers (e.g. cloudflared http2), the client falls back to
        // /poll — so SSE is best-effort and polling is the guaranteed path.
        res.write(":" + " ".repeat(2048) + "\n\n");
        res.write(": connected\n\n");
        // Single connection: a new mobile stream replaces any previous one.
        if (role === "mobile") dropMobileClients();
        const client = { res, role, external, addr: req.socket.remoteAddress || "", id: randomBytes(4).toString("hex") };
        sseClients.add(client);
        writeSse(client, { type: "hello", role, snapshot: snapshot(), recent });
        if (role === "desktop") broadcast({ type: "devices", snapshot: snapshot() });
        else { logActivity("device_connect", `${client.addr}`); broadcast({ type: "devices", snapshot: snapshot() }); }
        req.on("close", () => {
            sseClients.delete(client);
            if (role !== "desktop") { logActivity("device_disconnect", `${client.addr}`); broadcast({ type: "devices", snapshot: snapshot() }); }
        });
        return;
    }

    // --- polling fallback (works through proxies that buffer SSE, e.g. tunnels) ---
    if (req.method === "GET" && path === "/poll") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const since = Number(url.searchParams.get("since") || 0);
        const events = recent.filter((e) => (e.seq || 0) > since);
        return sendJson(res, { ok: true, seq: seqCounter, events, busy, pending: [...pendingPerms.values()], question: pendingQuestion });
    }

    // --- approve/reject a pending tool-permission request from the phone ---
    // Non-hijacking: resolves the same pending request the desktop prompt shows;
    // whoever responds first wins (the other call becomes a no-op).
    if (req.method === "POST" && path === "/permission") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const body = await readBody(req);
        const requestId = body && body.requestId;
        const decision = body && body.decision;
        if (!requestId || (decision !== "approve" && decision !== "reject")) {
            return sendJson(res, { ok: false, error: "bad_request" }, 400);
        }
        const result = decision === "approve" ? { kind: "approve-once" } : { kind: "reject" };
        try {
            const applied = await session.rpc.permissions.handlePendingPermissionRequest({ requestId, result });
            pendingPerms.delete(requestId);
            logActivity("permission", `${decision} via ${role}`);
            broadcast({ type: "permission_done", requestId, ts: Date.now() });
            return sendJson(res, { ok: true, applied });
        } catch (e) {
            dbg("permission resolve failed: " + (e?.stack || e));
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 500);
        }
    }

    // --- answer a pending ask_user question (phone) ---
    // Resolves the ephemeral user_input.requested via handlePendingUserInput WITHOUT
    // aborting the turn. Falls back to a normal message if the request isn't answerable.
    if (req.method === "POST" && path === "/answer") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const body = await readBody(req);
        const answer = body && typeof body.answer === "string" ? body.answer.trim() : "";
        if (!answer) return sendJson(res, { ok: false, error: "empty_answer" }, 400);
        if (answer.length > MAX_PROMPT) return sendJson(res, { ok: false, error: "too_long" }, 413);
        const wasFreeform = !!(body && body.wasFreeform);
        recordAndBroadcast({ type: "user", content: answer, source: role, ts: Date.now() });
        pendingEcho.push({ content: answer, ts: Date.now() });
        // PRIMARY: we own the ask_user handler → resolve the agent's promise directly.
        // No host card exists, so nothing lingers on the desktop.
        if (activeInputResolve) {
            const resolve = activeInputResolve;
            activeInputResolve = null;
            const qid = pendingQuestion && pendingQuestion.id;
            pendingQuestion = null;
            recordAndBroadcast({ type: "question_done", id: qid, ts: Date.now() });
            try { resolve(answer, wasFreeform); } catch (e) { dbg("/answer resolve failed: " + e); }
            // Also nudge the host's own pending card (if it showed one) to dismiss it.
            if (lastNotifiedReqId && session.rpc?.ui?.handlePendingUserInput) {
                const rid = lastNotifiedReqId; lastNotifiedReqId = null;
                session.rpc.ui.handlePendingUserInput({ requestId: rid, response: { answer, wasFreeform } })
                    .then((r) => dbg(`/answer host-nudge requestId=${rid} -> ${JSON.stringify(r)}`))
                    .catch((e) => dbg("/answer host-nudge failed: " + (e?.message || e)));
            }
            dbg("/answer resolved via OWNED handler (no host card)");
            return sendJson(res, { ok: true, resolved: true, via: "handler" });
        }
        // SECONDARY: a host-owned question with a requestId → resolve via RPC.
        const reqId = pendingQuestion && pendingQuestion.requestId;
        if (reqId && session.rpc?.ui?.handlePendingUserInput) {
            try {
                const r = await session.rpc.ui.handlePendingUserInput({ requestId: reqId, response: { answer, wasFreeform } });
                dbg(`/answer handlePendingUserInput requestId=${reqId} resolved=${JSON.stringify(r)}`);
                pendingQuestion = null;
                recordAndBroadcast({ type: "question_done", id: reqId, ts: Date.now() });
                return sendJson(res, { ok: true, resolved: true, via: "rpc" });
            } catch (e) {
                dbg("/answer handlePendingUserInput failed, falling back to send: " + (e?.stack || e));
            }
        }
        // Fallback: no answerable requestId (tool-only ask_user) → best-effort message.
        setBusy(true);
        try {
            const messageId = await session.send({ prompt: answer });
            return sendJson(res, { ok: true, resolved: false, fallback: "send", messageId });
        } catch (e) {
            setBusy(false);
            dbg("/answer fallback send failed: " + (e?.stack || e));
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 500);
        }
    }

    // --- send a prompt to the agent (desktop or phone) ---
    if (req.method === "POST" && path === "/send") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const body = await readBody(req, 24 << 20); // 24MB: prompt + base64 image attachments
        if (!body) return sendJson(res, { ok: false, error: "too_large" }, 413);
        const prompt = body && typeof body.prompt === "string" ? body.prompt.trim() : "";
        const atts = sanitizeAttachments(body && body.attachments);
        if (!prompt && atts.length === 0) return sendJson(res, { ok: false, error: "empty_prompt" }, 400);
        if (prompt.length > MAX_PROMPT) return sendJson(res, { ok: false, error: "too_long" }, 413);
        recordAndBroadcast({
            type: "user", content: prompt, source: role,
            images: atts.map((a) => `data:${a.mimeType};base64,${a.data}`),
            ts: Date.now(),
        });
        pendingEcho.push({ content: prompt, ts: Date.now() });
        setBusy(true);
        try {
            const opts = { prompt: prompt || "(imagem enviada)" };
            if (atts.length) opts.attachments = atts.map((a) => ({ type: "blob", data: a.data, mimeType: a.mimeType, displayName: a.displayName }));
            const messageId = await session.send(opts);
            return sendJson(res, { ok: true, messageId });
        } catch (e) {
            setBusy(false);
            dbg("send failed: " + (e?.stack || e));
            return sendJson(res, { ok: false, error: String(e?.message || e) }, 500);
        }
    }

    // --- lightweight client-auth probe (used by the phone to validate its token) ---
    if (req.method === "GET" && path === "/ping") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        return sendJson(res, { ok: true, role, busy });
    }

    // --- abort the current agent turn ---
    if (req.method === "POST" && path === "/abort") {
        const role = clientRole;
        if (!role) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        setBusy(false); // instant feedback; the "abort" event will also record the idle line
        try { await session.abort(); } catch (e) { dbg("abort failed: " + e.message); }
        logActivity("abort", role);
        return sendJson(res, { ok: true });
    }

    // ===== DESKTOP-ONLY (gate) endpoints — non-external request + desktop token =====
    if (path === "/status") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        return sendJson(res, { ok: true, snapshot: snapshot(), desktopToken });
    }
    if (req.method === "POST" && path === "/capabilities") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        await refreshCaps();
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }
    if (req.method === "POST" && path === "/network") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        network = await access.detectNetwork();
        try { caPoolPath = access.writeSystemCaPem(BIN_DIR); } catch {}
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }
    if (req.method === "POST" && path === "/device/forget") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        forgetDevice();
        broadcast({ type: "devices", snapshot: snapshot() });
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }
    if (req.method === "POST" && path === "/firewall/allow") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const port = await ensureLanPort();
        const name = ruleNameFor(port);
        const profile = caps.profiles.includes("Public") && !caps.profiles.includes("Private") ? "Public" : "Private";
        const r = await access.createLanFirewallRuleElevated(name, port, ARTIFACTS, profile);
        caps.lanRule = await access.firewallRuleExists(name);
        logActivity("firewall", r.ok ? `rule criada porta ${port} (${profile})` : (r.cancelled ? "UAC cancelado" : "falha: " + r.error));
        broadcast({ type: "mode", snapshot: snapshot() });
        return sendJson(res, { ok: r.ok, cancelled: !!r.cancelled, error: r.error || null, snapshot: snapshot() });
    }
    if (req.method === "POST" && path === "/firewall/remove") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const port = lanPort;
        if (!port) return sendJson(res, { ok: false, error: "no_port", snapshot: snapshot() }, 400);
        const name = ruleNameFor(port);
        const r = await access.removeLanFirewallRuleElevated(name, ARTIFACTS);
        caps.lanRule = await access.firewallRuleExists(name);
        logActivity("firewall", r.ok ? `rule removida porta ${port}` : (r.cancelled ? "UAC cancelado" : "falha: " + r.error));
        broadcast({ type: "mode", snapshot: snapshot() });
        return sendJson(res, { ok: r.ok, cancelled: !!r.cancelled, snapshot: snapshot() });
    }
    if (req.method === "POST" && path === "/mode") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        const body = await readBody(req);
        const next = body && body.mode;
        if (!MODES.includes(next)) return sendJson(res, { ok: false, error: "bad_mode" }, 400);
        try {
            await setMode(next, { confirm: !!(body && body.confirm), pauseWarp: !!(body && body.pauseWarp) });
            return sendJson(res, { ok: true, snapshot: snapshot() });
        } catch (e) {
            return sendJson(res, { ok: false, error: String(e?.message || e), snapshot: snapshot() }, 400);
        }
    }
    if (req.method === "POST" && path === "/pair/new") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        if (mode === "off") return sendJson(res, { ok: false, error: "not_exposed" }, 400);
        if (!mobileToken) newMobileToken();
        const code = newPairingCode();
        logActivity("pair_code", "regenerated");
        return sendJson(res, { ok: true, code, snapshot: snapshot() });
    }
    if (req.method === "POST" && path === "/revoke") {
        if (!isDesktop) return sendJson(res, { ok: false, error: "forbidden" }, 403);
        revokeAll();
        return sendJson(res, { ok: true, snapshot: snapshot() });
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
}

// ---------- transport gate ----------
function listenServer(host, port, forceExternal = false) {
    return new Promise((resolve, reject) => {
        const s = createServer((req, res) => handleRequest(req, res, forceExternal));
        s.on("error", reject);
        s.listen(port, host, () => resolve(s));
    });
}
function closeServer(s) {
    return new Promise((resolve) => {
        try { s.close(() => resolve()); } catch { resolve(); }
    });
}
function dropExternalClients() {
    for (const c of [...sseClients]) {
        if (c.external) {
            try { c.res.end(); } catch {}
            sseClients.delete(c);
        }
    }
}
async function teardownExternal() {
    dropExternalClients();
    if (externalServer) {
        await closeServer(externalServer);
        externalServer = null;
    }
    if (tunnel) {
        try { tunnel.proc.kill(); } catch {}
        tunnel = null;
    }
    if (tunnelServer) {
        await closeServer(tunnelServer);
        tunnelServer = null;
        tunnelPort = 0;
    }
    tsPort = 0;
    provisioning = null;
    exposedUrl = null;
    stopPairRotation();
    await resumeWarpIfPaused();
}

async function refreshCaps() {
    try {
        const [ts, cf, ng, warp, profiles] = await Promise.all([
            access.detectTailscale(),
            access.detectCloudflared(BIN_DIR),
            access.detectNgrok(),
            access.detectWarp(),
            access.getActiveProfiles(),
        ]);
        const lanRule = lanPort ? await access.firewallRuleExists(ruleNameFor(lanPort)) : false;
        caps = {
            tailscale: { installed: ts.installed, up: ts.up, ip: ts.ip, dnsName: ts.dnsName },
            cloudflared: !!cf,
            ngrok: !!ng,
            warp: { installed: warp.installed, connected: warp.connected },
            profiles,
            lanRule,
            checkedAt: Date.now(),
        };
    } catch (e) {
        dbg("refreshCaps failed: " + (e?.message || e));
    }
    // Network/CA awareness (parallel, best-effort) for restricted-network support.
    access.detectNetwork().then((n) => {
        network = n;
        if (n.intercepted) logActivity("network", `TLS interceptado por ${n.interceptionIssuer || "CA desconhecida"}`);
    }).catch(() => {});
    try { caPoolPath = access.writeSystemCaPem(BIN_DIR); } catch {}
    return caps;
}
function revokeAll() {
    mobileToken = null;
    pairing = null;
    dropExternalClients();
    logActivity("revoke", "all devices + token cleared");
    broadcast({ type: "devices", snapshot: snapshot() });
}

// Tell the runtime there's a REMOTE consumer for ask_user questions while the
// bridge is exposed. The SDK gates some coordination on registered interest, so
// this is what should let the desktop's native ask_user card dismiss when the
// phone answers (handlePendingUserInput alone resolves the request but doesn't
// always dismiss the host UI). Scoped to "exposed" so an unarmed bridge leaves
// the desktop 100% native.
async function registerUserInputInterest() {
    if (userInputInterestHandle) return;
    try {
        const r = await session.rpc?.eventLog?.registerInterest?.({ eventType: "user_input.requested" });
        userInputInterestHandle = r?.handle || null;
        dbg("registerInterest user_input.requested -> handle=" + userInputInterestHandle);
    } catch (e) { dbg("registerInterest failed: " + (e?.stack || e)); }
}
async function releaseUserInputInterest() {
    if (!userInputInterestHandle) return;
    const h = userInputInterestHandle;
    userInputInterestHandle = null;
    try { await session.rpc?.eventLog?.releaseInterest?.({ handle: h }); dbg("releaseInterest user_input.requested ok"); }
    catch (e) { dbg("releaseInterest failed: " + (e?.stack || e)); }
}

// ROBUST ask_user control: we OVERRIDE the built-in ask_user (overridesBuiltInTool:true).
// The host honors this (validateExternalToolOverrides) and routes the real userInput.request
// JSON-RPC to OUR handler INSTEAD of creating its native desktop card. So EVERY ask_user
// (ours, a skill's, a sub-agent's) is intercepted — no card can ever trap the agent on the
// PC, in ANY mode (interactive/plan/autopilot alike). The question is surfaced to whatever
// surface is connected: the paired phone when exposed, and/or the desktop control panel.
// The handler blocks the turn until an answer arrives via POST /answer (which resolves
// activeInputResolve), exactly like a slow async tool. Safety timeout prevents a hang.
const USERINPUT_TIMEOUT_MS = 180000; // 3 min safety net so the agent never hangs forever
function connectedSurfaces() {
    let phone = 0, desktop = 0;
    for (const c of sseClients) { if (c.role === "mobile") phone++; else if (c.role === "desktop") desktop++; }
    return { phone, desktop, any: phone + desktop };
}
// Fix C: native fallback. When the override is active (owner session) but there's no phone/
// panel surface, surface the question through the host's native elicitation dialog instead of
// failing. Bounded by a timeout so it can never out-live the tool safety net. Returns
// { handled, answer }: handled=false means "degrade to the normal fail-fast path".
async function tryDesktopElicitation(question, choices, allowFreeform) {
    const elicit = session?.rpc?.ui?.elicitation;
    if (typeof elicit !== "function") return { handled: false };
    const hasChoices = Array.isArray(choices) && choices.length > 0;
    const field = hasChoices && !allowFreeform
        ? { type: "string", title: "Resposta", enum: choices }
        : { type: "string", title: "Resposta", description: hasChoices ? ("Opções: " + choices.join(" | ")) : undefined };
    const req = { message: question, requestedSchema: { type: "object", properties: { answer: field }, required: ["answer"] } };
    try {
        const resp = await Promise.race([
            elicit.call(session.rpc.ui, req),
            new Promise((res) => { const t = setTimeout(() => res({ action: "__timeout__" }), USERINPUT_TIMEOUT_MS); t.unref?.(); }),
        ]);
        if (resp?.action === "accept") {
            const v = resp.content?.answer;
            return { handled: true, answer: v == null ? "" : String(v) };
        }
        if (resp?.action === "__timeout__") { dbg("elicitation timed out"); return { handled: true, answer: "" }; }
        // decline / cancel → user explicitly dismissed; respect it (don't re-ask via message).
        return { handled: true, answer: "" };
    } catch (e) {
        dbg("elicitation unavailable/failed: " + (e?.message || e));
        return { handled: false };
    }
}
const askUserOverride = {
    name: "ask_user",
    overridesBuiltInTool: true,
    description:
        "Ask the user a question and wait for their answer. Handled by copilot-mobile: routed to the " +
        "paired phone when the mobile bridge is exposed, otherwise to the desktop control panel. " +
        "Supports multiple-choice (choices) and free-form answers.",
    parameters: {
        type: "object",
        properties: {
            question: { type: "string", description: "The question to ask the user." },
            choices: { type: "array", items: { type: "string" }, description: "Optional multiple-choice options (rendered as buttons)." },
            allowFreeform: { type: "boolean", description: "Whether to allow a free-form typed answer in addition to choices. Default true." },
        },
        required: ["question"],
    },
    handler: async (args) => {
        const q = typeof args?.question === "string" ? args.question.trim() : "";
        if (!q) return { resultType: "failure", error: "empty_question", textResultForLlm: "ask_user: 'question' is empty." };
        const choices = Array.isArray(args?.choices) ? args.choices.filter((c) => typeof c === "string") : [];
        const allowFreeform = args?.allowFreeform !== false;
        const surfaces = connectedSurfaces();
        // Not exposed AND no desktop panel connected → no phone/panel surface to show the
        // question on (we replaced the native card in THIS owner session). Try a native
        // elicitation dialog first (Fix C); only if that's unavailable do we fail fast so the
        // agent asks via a normal message instead of hanging.
        if (mode === "off" && surfaces.desktop === 0) {
            const elic = await tryDesktopElicitation(q, choices, allowFreeform);
            if (elic.handled) {
                dbg(`ask_user override: resolved via native elicitation answer='${(elic.answer || "").slice(0, 60)}'`);
                return { resultType: "success", textResultForLlm: elic.answer || "(user did not answer)" };
            }
            dbg("ask_user override: off, no panel, elicitation unavailable → fail fast");
            return { resultType: "failure", error: "no_surface", textResultForLlm: "Sem painel/cliente conectado para exibir a pergunta. Pergunte como mensagem normal." };
        }
        const reqId = "auo-" + Date.now().toString(36);
        if (activeInputResolve) { try { activeInputResolve("", true); } catch {} activeInputResolve = null; }
        pendingQuestion = { id: reqId, requestId: reqId, viaHandler: true, question: q, choices, allowFreeform, ts: Date.now() };
        recordAndBroadcast({ type: "question", ...pendingQuestion });
        dbg(`ask_user override fired q='${q.slice(0, 60)}' choices=${choices.length} mode=${mode} surfaces=phone:${surfaces.phone}/desktop:${surfaces.desktop}`);
        return await new Promise((resolve) => {
            let done = false;
            const finish = (answer, wasFreeform) => {
                if (done) return; done = true;
                activeInputResolve = null;
                clearTimeout(timer);
                const text = String(answer ?? "");
                dbg(`ask_user override resolved answer='${text.slice(0, 60)}' freeform=${!!wasFreeform}`);
                resolve({ resultType: "success", textResultForLlm: text || "(user did not answer)" });
            };
            activeInputResolve = finish;
            const timer = setTimeout(() => {
                if (done) return;
                pendingQuestion = null;
                recordAndBroadcast({ type: "question_done", id: reqId, ts: Date.now() });
                dbg("ask_user override timeout — resolving empty so the agent doesn't hang");
                finish("", true);
            }, USERINPUT_TIMEOUT_MS);
            timer.unref?.();
        });
    },
};

async function setMode(next, opts = {}) {
    const confirm = !!opts.confirm;
    const pauseWarp = !!opts.pauseWarp;
    await teardownExternal();
    mode = next;
    if (next === "off") {
        mobileToken = null;
        pairing = null;
        await releaseUserInputInterest(); // desktop goes back to 100% native
        saveState(); // remember we're off so boot doesn't auto-rearm
        logActivity("mode", "off (loopback-only)");
        broadcast({ type: "mode", snapshot: snapshot() });
        return;
    }
    // Arming external exposure → require a fresh token + pairing code.
    // This session also becomes the mobile OWNER: only the owner session's fork registers
    // the ask_user override (scoped, never global). Persist so reopening this session keeps it.
    if (SELF_SESSION_ID && activeMobileSessionId !== SELF_SESSION_ID) {
        activeMobileSessionId = SELF_SESSION_ID;
        saveState();
        logActivity("mobile", "owner set to this session");
    }
    if (SELF_SESSION_ID && !overrideRegistered) {
        dbg("arm: this fork has no ask_user override (was not owner at join) → reload needed to route ask_user here");
        try { await session.log("Mobile armado nesta sessão. Recarregue a extensão UMA vez para rotear o ask_user ao celular aqui — as outras sessões seguem com o ask_user nativo.", { level: "warn" }); } catch {}
    }
    newMobileToken();
    newPairingCode();

    if (next === "lan") {
        // Bind the remembered LAN port (Windows-assigned the first time). If it's
        // taken now, fall back to a fresh free port and remember the new one.
        const want = lanPort || 0;
        try {
            externalServer = await listenServer("0.0.0.0", want, true);
        } catch (e) {
            if (want && /EADDRINUSE|EACCES/i.test(String(e?.code || e?.message || e))) {
                externalServer = await listenServer("0.0.0.0", 0, true);
            } else {
                await teardownExternal(); mode = "off";
                throw e;
            }
        }
        const bound = externalServer.address().port;
        if (bound !== lanPort) { lanPort = bound; saveState(); }
        caps.lanRule = await access.firewallRuleExists(ruleNameFor(lanPort));
        exposedUrl = pickLanUrl();
        if (!exposedUrl) {
            await teardownExternal(); mode = "off";
            throw new Error("Nenhum IP de LAN encontrado (você está em alguma rede?)");
        }
        // Without the firewall rule the phone may be blocked / prompt for admin.
        // We still expose (loopback unaffected); snapshot surfaces needs_admin.
    } else if (next === "tailscale") {
        const ts = await access.detectTailscale();
        caps.tailscale = { installed: ts.installed, up: ts.up, ip: ts.ip, dnsName: ts.dnsName };
        if (!ts.installed) {
            await teardownExternal(); mode = "off";
            throw new Error("Tailscale não instalado. Instale (requer admin 1×) e conecte.");
        }
        if (!ts.up) {
            await teardownExternal(); mode = "off";
            throw new Error("Tailscale instalado mas desconectado. Abra o app e faça login/conecte.");
        }
        externalServer = await listenServer(ts.ip, 0, true); // ephemeral; URL carries the port
        tsPort = externalServer.address().port;
        exposedUrl = `http://${ts.ip}:${tsPort}`;
    } else if (next === "public") {
        if (!confirm) {
            await teardownExternal(); mode = "off";
            throw new Error("URL pública expõe à internet — reenvie com confirm=true.");
        }
        if (pauseWarp) await pauseWarpForTunnel();
        await startPublicTunnel();
    }
    startPairRotation(); // rolling pairing code while exposed
    await registerUserInputInterest(); // count as remote consumer so the desktop card coordinates
    saveState(); // persist the armed mode so the owner session auto-rearms on the next boot
    logActivity("mode", `${next} exposed=${exposedUrl || "(pending)"}`);
    broadcast({ type: "mode", snapshot: snapshot() });
}

// Public tunnel: auto-provision cloudflared (no admin) and forward a dedicated
// loopback target server through it. ngrok is used only if already on PATH.
async function startPublicTunnel() {
    // Dedicated loopback target so tunnel-forwarded requests are tagged external.
    tunnelServer = await listenServer("127.0.0.1", 0, true);
    tunnelPort = tunnelServer.address().port;
    const target = `http://127.0.0.1:${tunnelPort}`;

    let cfPath = null;
    try {
        provisioning = "preparando cloudflared…";
        broadcast({ type: "mode", snapshot: snapshot() });
        cfPath = await access.ensureCloudflared(BIN_DIR, (m) => {
            provisioning = m;
            broadcast({ type: "provisioning", msg: m, snapshot: snapshot() });
        });
        caps.cloudflared = true;
    } catch (e) {
        const ng = await access.detectNgrok();
        if (!ng) {
            await teardownExternal(); mode = "off";
            throw new Error("Falha ao provisionar cloudflared e ngrok ausente: " + e.message);
        }
    }
    provisioning = "abrindo túnel…";
    broadcast({ type: "mode", snapshot: snapshot() });
    try {
        await spawnTunnel(cfPath, target);
    } catch (e) {
        await teardownExternal(); // also resumes WARP if we paused it
        mode = "off";
        throw e;
    }
    provisioning = null;
}

function spawnTunnel(cfPath, target) {
    return new Promise((resolve, reject) => {
        // Force HTTP/2 (TCP/443) instead of QUIC/UDP: QUIC is often blocked by
        // firewalls or interfered with by Cloudflare WARP, causing edge-dial
        // timeouts. Overridable via COPILOT_MOBILE_CF_PROTOCOL.
        const cfProto = process.env.COPILOT_MOBILE_CF_PROTOCOL || "http2";
        // On Windows cloudflared can't load the system root store; feed it the
        // exported CA pool so it works behind a corporate/intercepting CA.
        const cfArgs = ["tunnel", "--protocol", cfProto];
        if (caPoolPath) cfArgs.push("--origin-ca-pool", caPoolPath);
        cfArgs.push("--url", target);
        const candidates = [];
        if (cfPath) candidates.push({
            kind: "cloudflared",
            cmd: cfPath,
            args: cfArgs,
            re: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
            readyRe: /Registered tunnel connection|registered connIndex/i,
        });
        candidates.push({
            kind: "ngrok",
            cmd: "ngrok",
            args: ["http", String(tunnelPort), "--log", "stdout"],
            re: /(https:\/\/[a-z0-9-]+\.ngrok[-a-z0-9.]*\.\w+)/i,
            readyRe: null,
        });
        let idx = 0;
        const tryNext = () => {
            if (idx >= candidates.length) return reject(new Error("nenhum túnel disponível"));
            const c = candidates[idx++];
            let proc;
            try {
                proc = spawn(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            } catch {
                return tryNext();
            }
            let urlSeen = false, settled = false, edgeErrors = 0;
            let regTimer = null;
            const finishOk = () => { if (!settled) { settled = true; clearTimeout(regTimer); resolve(); } };
            const failWith = (msg) => {
                if (settled) return;
                settled = true;
                clearTimeout(regTimer);
                try { proc.kill(); } catch {}
                tunnel = null;
                exposedUrl = null;
                reject(new Error(msg));
            };
            const onData = (d) => {
                const s = d.toString();
                dbg(`tunnel(${c.kind}): ${s.trim()}`);
                if (!urlSeen) {
                    const m = c.re.exec(s);
                    if (m) {
                        urlSeen = true;
                        tunnel = { proc, url: m[1], kind: c.kind };
                        exposedUrl = m[1];
                        provisioning = "registrando conexão…";
                        broadcast({ type: "provisioning", msg: provisioning, snapshot: snapshot() });
                        if (!c.readyRe) return finishOk(); // ngrok: ready at URL
                        // cloudflared: only succeed once the edge connection registers.
                        regTimer = setTimeout(() => {
                            const warpHint = caps.warp.connected
                                ? " O Cloudflare WARP está ativo e bloqueia o túnel — use a opção de pausar o WARP."
                                : " Verifique a conexão (porta 7844 de saída pode estar bloqueada).";
                            failWith("O túnel não conseguiu conectar à edge da Cloudflare." + warpHint);
                        }, 25000);
                    }
                } else if (c.readyRe && c.readyRe.test(s)) {
                    finishOk(); // edge connection registered → genuinely reachable
                } else if (/Unable to establish connection|failed to dial|i\/o timeout|edge error/i.test(s)) {
                    if (++edgeErrors >= 3) {
                        const warpHint = caps.warp.connected
                            ? " O Cloudflare WARP está ativo e conflita com o túnel — pause o WARP e tente de novo."
                            : "";
                        failWith("Falha ao conectar à edge da Cloudflare (timeout)." + warpHint);
                    }
                }
            };
            proc.stdout.on("data", onData);
            proc.stderr.on("data", onData);
            proc.on("error", () => { if (!settled) tryNext(); });
            proc.on("exit", () => { if (!settled) tryNext(); });
            setTimeout(() => { if (!urlSeen && !settled) { try { proc.kill(); } catch {} tryNext(); } }, 30000);
        };
        tryNext();
    });
}

// ---------- agent wiring ----------
function wireAgentEvents() {
    // A turn is starting — set busy from the authoritative lifecycle event.
    session.on("assistant.turn_start", (e) => {
        if (e?.agentId) return; // main loop only; sub-agent turns nest inside it
        setBusy(true);
    });
    // A turn finished normally — the real "idle". (There is no session.idle event.)
    session.on("assistant.turn_end", (e) => {
        if (e?.agentId) return;
        setBusy(false);
        recordAndBroadcast({ type: "idle", ts: Date.now() });
    });
    // User pressed STOP (on the desktop OR the phone) — abort fires here and does
    // NOT emit a turn_end, so this listener is what releases the phone. THE fix.
    session.on("abort", (e) => {
        if (e?.agentId) return;
        setBusy(false);
        recordAndBroadcast({ type: "idle", aborted: true, ts: Date.now() });
        dbg("abort event — busy cleared");
    });
    session.on("user.message", (e) => {
        if (e?.agentId) return; // ignore sub-agents; track only the main loop
        setBusy(true); // a turn is starting (whether from phone, desktop, or voice)
        const content = e?.data?.content || "";
        dbg(`user.message source=${JSON.stringify(e?.data?.source)} len=${content.length}`);
        if (consumePendingEcho(content)) return; // already echoed by /send — avoid double
        recordAndBroadcast({ type: "user", content, source: "app", ts: Date.now() });
    });
    session.on("assistant.message", (e) => {
        if (e?.agentId) return;
        touchBusy(); // keep the watchdog alive during the turn; never falsely flips busy
        const content = e?.data?.content;
        if (typeof content === "string" && content.trim()) {
            // Only an agent-authored 🔊 line becomes an audio bubble; otherwise no audio at all.
            const audioSummary = audioSummaryFrom(content);
            const display = audioSummary ? stripVoiceArtifacts(content) : content;
            recordAndBroadcast({ type: "assistant", content: display, audioSummary, messageId: e?.data?.messageId, ts: Date.now() });
        }
    });
    session.on("tool.execution_start", (e) => {
        if (e?.agentId) return;
        touchBusy();
        const tool = e?.data?.toolName;
        const tid = e?.data?.toolCallId;
        if (tool === "ask_user") {
            // The question is surfaced by our join-time handler (when exposed) or by the
            // user_input.requested notification (when the host is the handler). Suppress
            // the generic tool line and don't race a third source here.
            return;
        }
        if (tid) toolNames.set(tid, tool || "tool");
        recordAndBroadcast({ type: "tool_start", tool: tool || "tool", id: tid, ts: Date.now() });
    });
    session.on("tool.execution_complete", (e) => {
        if (e?.agentId) return;
        touchBusy();
        const tid = e?.data?.toolCallId;
        const tool = e?.data?.toolName || (tid && toolNames.get(tid)) || "tool";
        if (tool === "ask_user") {
            const id = tid || (pendingQuestion && pendingQuestion.id);
            pendingQuestion = null; // answered (here or on the desktop) — clear the card
            recordAndBroadcast({ type: "question_done", id, ts: Date.now() });
            return;
        }
        if (tid) toolNames.delete(tid);
        recordAndBroadcast({ type: "tool_done", tool, ok: e?.data?.success, id: tid, ts: Date.now() });
    });
    // PRIMARY answerable path: ask_user emits an (ephemeral) user_input.requested with a
    // requestId we can resolve via session.rpc.ui.handlePendingUserInput — without aborting
    // the turn. The desktop is also a consumer, so first-to-answer wins (non-hijacking).
    session.on("user_input.requested", (e) => {
        if (e?.agentId) return;
        const d = e?.data || {};
        // Always remember the requestId so /answer can also nudge the host's own card.
        if (d.requestId) lastNotifiedReqId = d.requestId;
        if (activeInputResolve) return; // our handler fired & already surfaced the question
        dbg(`user_input.requested FIRED requestId=${d.requestId} choices=${(d.choices || []).length} allowFreeform=${d.allowFreeform}`);
        pendingQuestion = {
            id: d.requestId,
            requestId: d.requestId, // answerable
            question: typeof d.question === "string" ? d.question : "",
            choices: Array.isArray(d.choices) ? d.choices.filter((c) => typeof c === "string") : [],
            allowFreeform: d.allowFreeform !== false,
            ts: Date.now(),
        };
        recordAndBroadcast({ type: "question", ...pendingQuestion });
    });
    session.on("user_input.completed", (e) => {
        const id = e?.data?.requestId;
        dbg(`user_input.completed requestId=${id}`);
        if (id && id === lastNotifiedReqId) lastNotifiedReqId = null;
        if (pendingQuestion && (!id || pendingQuestion.requestId === id || pendingQuestion.id === id)) pendingQuestion = null;
        recordAndBroadcast({ type: "question_done", id, ts: Date.now() });
    });
    session.on("permission.requested", (e) => {
        const d = e?.data;
        if (!d || !d.requestId || d.resolvedByHook) return; // hook already handled it
        const s = summarizePermission(d.permissionRequest);
        const item = {
            requestId: d.requestId,
            kind: d.permissionRequest?.kind || "unknown",
            title: s.title, detail: s.detail, intention: s.intention, warning: s.warning,
            agentId: e.agentId || null, ts: Date.now(),
        };
        pendingPerms.set(d.requestId, item);
        recordAndBroadcast({ type: "permission", ...item });
    });
    session.on("permission.completed", (e) => {
        const id = e?.data?.requestId;
        if (!id) return;
        if (pendingPerms.delete(id)) recordAndBroadcast({ type: "permission_done", requestId: id, ts: Date.now() });
    });
}

// ---------- canvas ----------
const canvas = createCanvas({
    id: "copilot-mobile",
    displayName: "Mobile",
    description: "Painel de controle: exponha (ou não) o agente para o seu celular e gerencie o pareamento — o gate fica na máquina.",
    actions: [
        {
            name: "status",
            description: "Retorna o estado da ponte mobile (modo de transporte, exposição, dispositivos pareados).",
            handler: async () => ({ ok: true, ...snapshot() }),
        },
        {
            name: "set_mode",
            description: "Altera o modo de transporte da ponte mobile: off | lan | tailscale | public (public exige confirm).",
            inputSchema: {
                type: "object",
                properties: {
                    mode: { type: "string", enum: MODES, description: "Modo de transporte." },
                    confirm: { type: "boolean", description: "Confirmação obrigatória para o modo public (internet)." },
                    pauseWarp: { type: "boolean", description: "No modo public, pausar o Cloudflare WARP (que conflita com o túnel) e retomá-lo ao desligar." },
                },
                required: ["mode"],
            },
            handler: async (ctx) => {
                const next = ctx?.input?.mode;
                if (!MODES.includes(next)) throw new CanvasError("invalid_input", "mode inválido.");
                await setMode(next, { confirm: !!ctx?.input?.confirm, pauseWarp: !!ctx?.input?.pauseWarp });
                return { ok: true, ...snapshot() };
            },
        },
    ],
    open: async () => {
        await ensureLoopServer();
        refreshCaps().then(() => broadcast({ type: "mode", snapshot: snapshot() })).catch(() => {});
        return {
            title: "Mobile",
            url: `http://127.0.0.1:${loopPort}/?t=${desktopToken}`,
            status: mode === "off" ? "Loopback (fechado)" : `Exposto: ${mode}`,
        };
    },
    onClose: async () => {
        // Keep the bridge alive across panel open/close; do not auto-expose.
        dbg("canvas closed (bridge stays in mode=" + mode + ")");
    },
});

async function ensureLoopServer() {
    if (loopServer) return;
    // Reuse the previously-bound loopback port so the canvas URL (port + desktopToken)
    // is stable across restarts. The app persists the open canvas and re-seeds its URL
    // on session resume; a stable URL means the seeded URL is still valid, which removes
    // the seed->republish race that froze the whole app on restore. Fall back to an
    // ephemeral port if the remembered one is taken.
    const want = persistedLoopPort || 0;
    try {
        loopServer = await listenServer("127.0.0.1", want);
    } catch (e) {
        if (!want) throw e;
        dbg(`loopback port ${want} unavailable (${e?.code || e?.message || e}); using an ephemeral port`);
        loopServer = await listenServer("127.0.0.1", 0);
    }
    loopPort = loopServer.address().port;
    if (loopPort !== persistedLoopPort) { persistedLoopPort = loopPort; saveState(); }
    dbg("loopback server on 127.0.0.1:" + loopPort);
}

// ---------- boot ----------
loadState();
// Scope the ask_user override to ONLY the session that owns mobile (activeMobileSessionId).
// Tool definitions are fixed at join time and cannot be added/removed at runtime, so this
// gate is the only way to keep every OTHER session's native ask_user fully intact.
overrideRegistered = !!SELF_SESSION_ID && SELF_SESSION_ID === activeMobileSessionId;
await ensureLoopServer();
session = await joinSession({
    canvases: [canvas],
    tools: overrideRegistered ? [askUserOverride] : [],
    hooks: {
        // While the mobile bridge is armed, ask the agent to author a 🔊 spoken-summary line
        // each turn. That single line is what becomes the phone's audio bubble.
        onUserPromptSubmitted: async () => {
            if (mode === "off") return undefined;
            return { additionalContext: VOICE_SUMMARY_INSTRUCTION };
        },
    },
});
dbg(`join: sessionId=${SELF_SESSION_ID || "(none)"} activeMobile=${activeMobileSessionId || "(none)"} askUserOverride=${overrideRegistered}`);
wireAgentEvents();
refreshCaps().catch(() => {});

// Auto-rearm: if THIS session owns mobile and a phone is paired, restore the previously
// armed LAN/Tailscale exposure across reloads/reopens. This keeps the phone reconnecting on
// its own AND keeps ask_user routing live in every fork (interest + override), so an answer
// from the phone always resolves the turn and never leaves a stuck card on the desktop —
// without a manual re-arm. Public exposure is intentionally NOT auto-restored (it reaches the
// internet; the user must re-arm it deliberately each time).
if (overrideRegistered && pinnedDevice && (persistedMode === "lan" || persistedMode === "tailscale")) {
    try {
        await setMode(persistedMode);
        dbg(`boot auto-rearm: restored mode=${persistedMode} (owner session + pinned device=${pinnedDevice.name})`);
    } catch (e) {
        dbg("boot auto-rearm failed (left off): " + (e?.message || e));
    }
}

// SSE keep-alive heartbeat.
setInterval(() => {
    for (const c of sseClients) {
        try { c.res.write(": ping\n\n"); } catch {}
    }
}, 20000).unref?.();

logActivity("boot", `loopback:${loopPort} lanPort:${lanPort || "(auto)"}`);
const bootMsg = mode === "off"
    ? "copilot-mobile pronto (modo: off — nada exposto até você armar no painel)."
    : `copilot-mobile pronto e rearmado (modo: ${mode}${exposedUrl ? " — " + exposedUrl : ""}). O celular pareado reconecta sozinho.`;
await session.log(bootMsg, { level: "info" }).catch(() => {});

process.on("uncaughtException", (e) => dbg("uncaught: " + (e?.stack || e)));
process.on("unhandledRejection", (e) => dbg("unhandledRejection: " + (e?.stack || e)));
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
        try { await teardownExternal(); } catch {}
        process.exit(0);
    });
}
