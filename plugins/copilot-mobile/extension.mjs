// extension.mjs — MINIMAL copilot-mobile bridge.
//
// The standalone daemon (~/.copilot-mobile-daemon, started by the tray) owns EVERYTHING that does
// not require living inside a session: transport (off/lan/tailscale/public), pairing, device auth,
// the live event stream to the phone, AND it serves its own config panel (opened from the tray
// icon). The phone talks to the DAEMON, which reads each session fresh from disk — so this in-app
// fork no longer needs an HTTP server, transport, pairing, a canvas, or any relaying.
//
// What ONLY a fork joined to the live session can do (and therefore stays here):
//   1) 🔊 voice-summary instruction — ask the agent to end each reply with a "🔊 …" line, which the
//      daemon turns into the phone's audio bubble. Injected only while the daemon is ARMED (we read
//      the daemon's runtime.json), so we don't nag when nothing is listening.
//   2) phone→PC drift warning — the daemon writes the user's phone turns to disk through a SEPARATE
//      runtime the app's live head never sees (cross-process isolation, proven). We count
//      user.message on disk vs the count the app's runtime has processed; any excess = phone turns
//      this chat's memory is missing, so we tell the agent to have the user restart the app to
//      resync. Detection is pure + unit-tested in drift.mjs.
import { joinSession } from "@github/copilot-sdk/extension";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { decidePhoneDrift, driftAgentContext } from "./drift.mjs";
import { ensureDaemonInstalled } from "./bootstrap.mjs";
import { LiveLink } from "./liveLink.mjs";
import { AskUserBridge } from "./askUserBridge.mjs";
import { decideAskUserOverride } from "./askMode.mjs";

const SELF_SESSION_ID = process.env.SESSION_ID || "";
const DAEMON_HOME = process.env.COPILOT_DAEMON_HOME || join(homedir(), ".copilot-mobile-daemon");
const RUNTIME_FILE = join(DAEMON_HOME, "runtime.json");
const LOG_FILE = join(DAEMON_HOME, "bridge.log");
const eventsPath = (sid) => join(homedir(), ".copilot", "session-state", sid, "events.jsonl");

function dbg(msg) {
  try { mkdirSync(DAEMON_HOME, { recursive: true }); appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// 🔊 instruction — verbatim from the original bridge (the daemon ports the same text for headless
// sessions; here we inject it into the app's LIVE session, which only a joined fork can do).
const VOICE_SUMMARY_INSTRUCTION =
  "Esta conversa está sendo acompanhada pelo celular (copilot-mobile). Responda normalmente no chat e, " +
  'ao FINAL da resposta, acrescente uma última linha começando exatamente com "🔊 " seguida de um RESUMO ' +
  "FALADO autoexplicativo da sua própria resposta: de 1 a 3 frases curtas, em português do Brasil, naturais " +
  "e completas (sem cortar no meio), sem markdown, sem listas, sem código e sem outros emojis. Essa linha 🔊 " +
  "é exatamente o que vira a mensagem de áudio no celular, então escreva-a para ser ouvida com clareza.";

// Is the daemon currently exposing the agent to a phone? (gate the 🔊 instruction)
function daemonArmed() {
  try {
    const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    return !!r && typeof r.mode === "string" && r.mode !== "off";
  } catch { return false; }
}

// The daemon's current transport mode string ("off"/"local"/"lan"/"tailscale"/"public"/…), or "" when
// the daemon isn't running/readable. Drives the ask_user override decision (askMode.decideAskUserOverride).
function daemonMode() {
  try {
    const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    return typeof r?.mode === "string" ? r.mode : "";
  } catch { return ""; }
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

// ask_user override — registered ONLY when a transport is OPEN at boot (askMode.decideAskUserOverride).
// ROOT-CAUSE FIX: the SDK decides tool overrides only at joinSession boot and a custom override can't
// delegate back to the native tool. The old code registered the override UNCONDITIONALLY, so with the
// daemon OFF (no phone, no open transport) the native PC modal was suppressed, the synthetic question
// died in the daemon's empty broadcast, and the flaky PC canvas was the only fallback ⇒ the question was
// HIDDEN and the turn hung until the user cancelled. Now: transport OPEN ⇒ override (canvas + phone);
// transport CLOSED ("off"/absent) ⇒ keep the NATIVE ask_user (the standard PC modal, reliable, never
// hidden). When native, the phone can STILL answer: the runtime's own user_input.requested is streamed to
// the daemon (session.on below) and a phone answer resolves it via rpc.ui.handlePendingUserInput
// (liveLink._runCommand). NOTE: joinSession decides the tool set ONCE at boot and the SDK can't swap it
// live, so a session that boots with the daemon OFF stays on native for its life — arming later keeps it
// answerable (native modal + phone via handlePendingUserInput) but does NOT auto-upgrade to the canvas
// UX; reopen/clear the session to boot it armed. The 🔊 voice instruction stays gated on daemonArmed().
const bootMode = daemonMode();
const overrideAsk = decideAskUserOverride({ mode: bootMode });
const askBridge = overrideAsk ? new AskUserBridge({ log: dbg, sessionId: SELF_SESSION_ID }) : null;
dbg(`ask_user override=${overrideAsk} (bootMode="${bootMode}")`);

const session = await joinSession({
  tools: askBridge ? [askBridge.tool()] : [],
  canvases: askBridge ? [askBridge.canvas()] : [],
  hooks: {
    onUserPromptSubmitted: async (input) => {
      const parts = [];
      if (daemonArmed()) parts.push(VOICE_SUMMARY_INSTRUCTION);
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
