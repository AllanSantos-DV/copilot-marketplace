// extension.mjs — MINIMAL copilot-mobile bridge.
//
// The standalone daemon (~/.copilot-mobile-daemon, started by the tray) owns EVERYTHING that does
// not require living inside a session: transport (off/lan/tailscale/public), pairing, device auth,
// the live event stream to the phone, AND it serves its own config panel (opened from the tray
// icon). The phone talks to the DAEMON, which reads each session fresh from disk — so this in-app
// fork no longer needs an HTTP server, transport, pairing, a canvas, or any relaying.
//
// What ONLY a fork joined to the live session can do (and therefore stays here):
//   1) phone→PC drift warning — the daemon writes the user's phone turns to disk through a SEPARATE
//      runtime the app's live head never sees (cross-process isolation, proven). We count
//      user.message on disk vs the count the app's runtime has processed; any excess = phone turns
//      this chat's memory is missing, so we tell the agent to have the user restart the app to
//      resync. Detection is pure + unit-tested in drift.mjs.
import { joinSession } from "@github/copilot-sdk/extension";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { decidePhoneDrift, driftAgentContext } from "./drift.mjs";
import { ensureDaemonInstalled } from "./bootstrap.mjs";
import { LiveLink } from "./liveLink.mjs";
import { AskUserBridge } from "./askUserBridge.mjs";

const SELF_SESSION_ID = process.env.SESSION_ID || "";
const DAEMON_HOME = process.env.COPILOT_DAEMON_HOME || join(homedir(), ".copilot-mobile-daemon");
const RUNTIME_FILE = join(DAEMON_HOME, "runtime.json");
const LOG_FILE = join(DAEMON_HOME, "bridge.log");
const eventsPath = (sid) => join(homedir(), ".copilot", "session-state", sid, "events.jsonl");

function dbg(msg) {
  try { mkdirSync(DAEMON_HOME, { recursive: true }); appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// Is the daemon currently exposing the agent to a phone? (kept for the bridge.log "armed" diagnostic)
function daemonArmed() {
  try {
    const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    return !!r && typeof r.mode === "string" && r.mode !== "off";
  } catch { return false; }
}

// The daemon's current transport mode string ("off"/"local"/"lan"/"tailscale"/"public"/…), or "" when
// the daemon isn't running/readable. Kept for the bridge.log diagnostic.
function daemonMode() {
  try {
    const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    return typeof r?.mode === "string" ? r.mode : "";
  } catch { return ""; }
}

// Daemon loopback coordinates (loopPort + desktopToken) from runtime.json, or null if not running/ready.
function daemonCoords() {
  try {
    const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    if (r && Number.isInteger(r.loopPort) && r.loopPort > 0 && typeof r.desktopToken === "string" && r.desktopToken) {
      return { port: r.loopPort, token: r.desktopToken };
    }
  } catch {}
  return null;
}

// STRICT ask_user override decision — ASK THE DAEMON. The daemon is the only party that knows both inputs
// of the gate: it's ARMED (transport != off) AND the phone is ACTIVE on THIS session. It returns the single
// authoritative `override` bool (askSignal.computeAskOverride). Any failure (daemon off/unreachable/timeout)
// ⇒ false ⇒ NATIVE ask_user — the safe default (the buggy canvas override never turns on by accident).
function queryAskMode(sessionId) {
  const d = daemonCoords();
  if (!d || !sessionId) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request(
      { host: "127.0.0.1", port: d.port, path: `/live/ask-mode?sessionId=${encodeURIComponent(sessionId)}`,
        method: "GET", headers: { "x-copilot-token": d.token } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { finish(res.statusCode === 200 && !!JSON.parse(b)?.override); } catch { finish(false); } }); res.on("error", () => finish(false)); },
    );
    req.on("error", () => finish(false));
    req.setTimeout(3000, () => { try { req.destroy(); } catch {} finish(false); });
    req.end();
  });
}

// Parsed user.message count + last user text from a session's on-disk event log — the AUTHORITATIVE
// cross-process view (a live runtime's getEvents can't see another runtime's appends, proven). Sync +
// safe inside the hook, which fires once per user prompt, so a full scan is cheap relative to a turn.
// Returns {count:-1} when unreadable (drift then no-ops → never a false warning).
function diskUserStats(sid) {
  try {
    let count = 0, lastText = "";
    for (const line of readFileSync(eventsPath(sid), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o?.type === "user.message") {
          count++;
          const c = o?.data?.content;
          lastText = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("") : "";
        }
      } catch {}
    }
    return { count, lastText };
  } catch { return { count: -1, lastText: "" }; }
}

// The count of user.message the APP's runtime has processed. Baseline from getEvents() at boot, then
// +1 per user-origin user.message on the live stream. getEvents() is NEVER called inside the hook
// (the runtime awaits the hook before processing → deadlock); the running counter avoids it.
let appHeadUsers = -1;
let appHeadPending = 0;

// ask_user override — STRICT gate, decided at THIS boot by asking the daemon (/live/ask-mode). The override
// (canvas + phone card) turns on ONLY when the daemon is ARMED and the phone is ACTIVE on this session;
// otherwise the NATIVE PC modal stays (reliable; the phone can still answer it via handlePendingUserInput).
// The SDK freezes the tool set at joinSession boot, so activation is a USER ACTION: when the user arms the
// daemon (or the phone opens this session), the daemon pushes an {signal:"askReload"} over the live channel
// and the bridge re-boots itself via session.rpc.extensions.reload() (wired below) — the fresh boot re-queries
// this and registers the override. Native default means the buggy override never turns on by accident.
const bootMode = daemonMode();
const overrideAsk = await queryAskMode(SELF_SESSION_ID);
const askBridge = overrideAsk ? new AskUserBridge({ log: dbg, sessionId: SELF_SESSION_ID }) : null;
dbg(`ask_user override=${overrideAsk} (bootMode="${bootMode}" via /live/ask-mode)`);

const session = await joinSession({
  tools: askBridge ? [askBridge.tool()] : [],
  canvases: askBridge ? [askBridge.canvas()] : [],
  hooks: {
    onUserPromptSubmitted: async (input) => {
      const parts = [];
      try {
        const { count, lastText } = diskUserStats(input?.sessionId || SELF_SESSION_ID);
        const d = decidePhoneDrift({ diskUsers: count, appHeadUsers, lastDiskUserText: lastText, currentPrompt: input?.prompt });
        if (d.drift > 0) { parts.push(driftAgentContext(d.drift)); dbg(`drift detected: ${d.drift} (disk=${count} head=${appHeadUsers})`); }
      } catch (e) { dbg("hook drift error: " + (e?.message || e)); }
      const ctx = parts.join("\n\n");
      return ctx ? { additionalContext: ctx } : undefined;
    },
  },
});
if (askBridge) askBridge.setSession(session);
// askBridge is null when native (transport closed at boot); every use below is guarded by `if (askBridge)`.

// Maintain the app head count from the live stream (user-origin turns only), then take the baseline.
// joinSession's session uses event-name-keyed listeners: session.on("user.message", cb).
session.on("user.message", (e) => {
  if (e?.agentId) return; // main loop only; ignore sub-agent turns
  if (appHeadUsers >= 0) appHeadUsers++; else appHeadPending++;
});
try {
  const evs = await session.getEvents();
  appHeadUsers = (evs || []).filter((e) => e?.type === "user.message").length + appHeadPending;
  appHeadPending = 0;
} catch (e) { dbg("baseline getEvents failed: " + (e?.message || e)); }

dbg(`bridge ready: session=${SELF_SESSION_ID || "(none)"} baselineHeadUsers=${appHeadUsers} armed=${daemonArmed()}`);

// Live-session routing: expose THIS live session (same runtime as the app) to the standalone daemon
// so the phone is routed through it instead of a rival disk-resume runtime. Total fallback — if the
// daemon is absent/unreachable this is a quiet no-op and the session behaves exactly as before.
const liveSessionId = session.sessionId || SELF_SESSION_ID;
if (liveSessionId) {
  try {
    const liveLink = new LiveLink({ sessionId: liveSessionId, runtimeFile: RUNTIME_FILE, session, log: dbg });
    // Wire the ask_user override both ways: it emits the question to the phone THROUGH the liveLink,
    // and a phone answer (liveLink cmd "answer") resolves the override's blocked handler.
    if (askBridge) { askBridge.setLiveLink(liveLink); liveLink.setAskBridge(askBridge); }
    // The daemon pushes {signal:"askReload", override} when the strict gate flips (armed/phone-active
    // transition). Since the SDK froze our tool set at boot, we re-boot via session.rpc.extensions.reload()
    // so the FRESH bridge re-queries /live/ask-mode and registers the override (or native). Guard: skip if
    // we're already in the desired mode (prevents a needless reload), and single-flight so bursts coalesce.
    let _reloading = false;
    liveLink.setOnSignal(async (sig) => {
      if (sig?.signal !== "askReload") return;
      const desired = !!sig.override;
      if (desired === !!askBridge) { dbg(`askReload: already ${desired ? "override" : "native"} — skip`); return; }
      if (_reloading) return;
      _reloading = true;
      // Self-heal the single-flight latch: a successful reload tears down THIS process (timer never fires),
      // but if reload ever resolves WITHOUT restarting us, clear the latch so future reloads aren't wedged.
      const latchReset = setTimeout(() => { _reloading = false; }, 15000);
      if (typeof latchReset.unref === "function") latchReset.unref();
      dbg(`askReload: gate flipped to ${desired ? "override" : "native"} → session.rpc.extensions.reload()`);
      try { await session.rpc.extensions.reload(); }
      catch (e) { clearTimeout(latchReset); _reloading = false; dbg("extensions.reload err: " + (e?.message || e)); }
    });
    // Stream EVERY live runtime event to the daemon (in addition to the user.message counter above).
    // Also release any open override question if the turn is aborted/errors, so it never dangles.
    session.on((raw) => {
      try { liveLink.pushEvent(raw); } catch {}
      if (askBridge) { const t = raw?.type || raw?.eventType; if (t === "abort" || t === "session.error") askBridge.abortAll(); }
    });
    liveLink.connect();
    // Best-effort clean detach when the session/app process goes away (the dropped SSE also signals it).
    const bye = () => { try { liveLink.stop(); } catch {} try { askBridge?.abortAll(); } catch {} };
    process.once("exit", bye);
    process.once("SIGTERM", bye);
    process.once("SIGINT", bye);
  } catch (e) { dbg("liveLink init error: " + (e?.message || e)); }
}

// First-run provisioning of the standalone daemon (download prebuilt + tray autostart). Detached and
// idempotent: returns fast once installed, never blocks the turn, serialized across forks by a lock.
ensureDaemonInstalled().catch((e) => dbg("ensureDaemonInstalled error: " + (e?.message || e)));
