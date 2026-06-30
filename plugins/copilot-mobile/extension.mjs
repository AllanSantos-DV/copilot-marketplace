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

const session = await joinSession({
  tools: [],
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

// First-run provisioning of the standalone daemon (download prebuilt + tray autostart). Detached and
// idempotent: returns fast once installed, never blocks the turn, serialized across forks by a lock.
ensureDaemonInstalled().catch((e) => dbg("ensureDaemonInstalled error: " + (e?.message || e)));
