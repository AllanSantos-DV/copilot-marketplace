// LiveLink — the bridge side of live-session routing. A joined-session fork (this extension) runs
// INSIDE the desktop app's live session (joinSession → the SAME runtime as the app). This link makes
// that live session reachable by the standalone daemon so the phone can be routed THROUGH it instead
// of the daemon opening a rival disk-resume runtime (which is what causes PC↔phone drift and
// `alreadyInUse`). See ../daemon/src/live.mjs for the daemon side + protocol.
//
// The bridge is a pure CLIENT (never opens a port — only the daemon owns transport, exactly the
// reason the old in-app HTTP server was removed). Over the daemon's loopback port (from runtime.json,
// authed with the desktopToken) it:
//   • POST /live/join                       — announce this live session
//   • GET  /live/commands (SSE, stays open) — receive send/abort/getEvents; the OPEN stream is the
//                                             liveness signal the daemon keys routing off of
//   • POST /live/event                      — push each live runtime event (ordered, best-effort)
//   • POST /live/result                     — return a command's result
//   • POST /live/leave                      — clean detach on stop
//
// TOTAL FALLBACK: if the daemon is absent/unreadable/unreachable, every method is a quiet no-op and
// retries later — the app session behaves exactly as before (voice + drift only). Nothing here may
// ever throw into the live session.
import http from "node:http";
import { readFileSync } from "node:fs";

const RETRY_MS = 4000;
const RETRY_MAX_MS = 30000;
const EVENT_QUEUE_CAP = 500; // bound memory if the daemon wedges mid-turn (drop oldest)

/** Exponential backoff for the live-link reconnect: base doubles per attempt, capped at max. Pure +
 *  testable; the caller adds jitter and resets `attempt` on a healthy connect. A FLAT retry (the old
 *  bare RETRY_MS) hammered the daemon every 4s while it was down/restarting — this backs off instead. */
export function liveRetryDelay(attempt, base = RETRY_MS, max = RETRY_MAX_MS) {
  const a = Math.max(0, attempt | 0);
  return Math.min(base * (2 ** a), max);
}

export class LiveLink {
  constructor({ sessionId, runtimeFile, session, log = () => {} }) {
    this.sessionId = sessionId;
    this.runtimeFile = runtimeFile;
    this.session = session;      // the joined live CopilotSession (send/abort/getEvents/on)
    this.log = log;
    this._askBridge = null;      // AskUserBridge | null — when set, cmd "answer" resolves the override
    this.connected = false;
    this._d = null;              // cached { port, token } while connected
    this._cmdReq = null;         // the open commands-SSE request
    this._retryTimer = null;
    this._retryAttempt = 0;      // exponential-backoff counter; reset to 0 on a healthy connect
    this._stopped = false;
    this._evQ = [];
    this._draining = false;
    this._agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  }

  /** Wire the ask_user override so a phone answer resolves it (instead of the native runtime input). */
  setAskBridge(b) { this._askBridge = b; }

  /** Register a handler for daemon SIGNALS (no cmdId), e.g. {signal:"askReload"} → the bridge re-evaluates
   *  its ask_user mode by reloading the extension. Fire-and-forget: signals never expect a /live/result. */
  setOnSignal(cb) { this._onSignal = typeof cb === "function" ? cb : null; }

  /** Read the daemon's loopback coordinates from runtime.json. null ⇒ daemon not running/ready. */
  _daemon() {
    try {
      const r = JSON.parse(readFileSync(this.runtimeFile, "utf8"));
      if (r && Number.isInteger(r.loopPort) && r.loopPort > 0 && typeof r.desktopToken === "string" && r.desktopToken) {
        return { port: r.loopPort, token: r.desktopToken };
      }
    } catch {}
    return null;
  }

  _post(d, path, body) {
    return new Promise((resolve) => {
      let data;
      try { data = Buffer.from(JSON.stringify(body || {})); } catch { return resolve(0); }
      const req = http.request(
        { host: "127.0.0.1", port: d.port, path, method: "POST", agent: this._agent,
          headers: { "Content-Type": "application/json", "Content-Length": data.length, "x-copilot-token": d.token } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode || 0)); res.on("error", () => resolve(0)); },
      );
      req.on("error", () => resolve(0));
      req.write(data); req.end();
    });
  }

  /** Push a live runtime event to the daemon, preserving order via a single-drain queue. */
  pushEvent(raw) {
    if (!this.connected || !this._d) return;
    this._evQ.push(raw);
    if (this._evQ.length > EVENT_QUEUE_CAP) this._evQ.splice(0, this._evQ.length - EVENT_QUEUE_CAP);
    this._drain();
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._evQ.length && this.connected && this._d) {
        const raw = this._evQ.shift();
        await this._post(this._d, "/live/event", { sessionId: this.sessionId, raw });
      }
    } catch { /* best-effort */ } finally { this._draining = false; }
  }

  /** Execute a daemon command on the live session and return its result. */
  async _runCommand(cmd) {
    const d = this._d; if (!d) return;
    let ok = true, value;
    try {
      if (cmd.cmd === "send") {
        // If our ask_user override has a question OPEN, a normal phone message IS the freeform answer.
        // The turn is already BLOCKED on that question, so a fresh session.send() couldn't run anyway;
        // and a freeform-only question has no text field on the phone card — the normal composer is how
        // you answer it. Route the text to the blocked handler instead of starting a new turn.
        // Attachments-only (no text) can't be a freeform answer, so those still go through as a send.
        const text = typeof cmd.prompt === "string"
          ? cmd.prompt
          : (cmd.prompt && typeof cmd.prompt.prompt === "string" ? cmd.prompt.prompt : "");
        const hasPending = !!(this._askBridge && this._askBridge.hasPending());
        if (this._askBridge && this._askBridge.hasPending() && text.trim()) {
          const answered = this._askBridge.resolveFromPhone("", text);
          this.log(`override-send: normal phone message routed as freeform answer (answered=${answered}, len=${text.length})`);
          value = { answered, via: "override-send" };
        } else {
          this.log(`cmd send: injecting into live session (textLen=${text.length}, hasPending=${hasPending})`);
          value = await this.session.send(cmd.prompt);
          this.log(`cmd send: session.send returned messageId=${JSON.stringify(value)}`);
        }
      }
      else if (cmd.cmd === "abort") {
        // Release any blocked override question FIRST (mirrors hub.abort's explicit _resolvePending) so
        // the phone's STOP deterministically unblocks the turn, without relying on the runtime emitting
        // an `abort`/`session.error` event to our joined session.on.
        try { this._askBridge?.abortAll(); } catch {}
        await this.session.abort(); value = true;
      }
      else if (cmd.cmd === "getEvents") value = await this.session.getEvents();
      else if (cmd.cmd === "answer") {
        // Two planes, most specific first:
        //  1) OVERRIDE (daemon armed): our ask_user override owns this session's questions. Resolve its
        //     blocked handler by requestId so the phone's choice returns the answer to the agent — the
        //     app never rendered a native modal, so there's nothing to dismiss.
        //  2) NATIVE (override off): resolve the runtime's pending user_input by id via rpc.ui so the
        //     phone still unblocks a native ask_user (returns { success:false } if already answered).
        const viaOverride = !!(this._askBridge && this._askBridge.resolveFromPhone(String(cmd.requestId || ""), String(cmd.answer ?? "")));
        if (viaOverride) {
          this.log(`cmd answer: resolved via override (reqId=${String(cmd.requestId || "").slice(0, 8)})`);
          value = { success: true, via: "override" };
        } else {
          this.log(`cmd answer: resolving native user_input (reqId=${String(cmd.requestId || "").slice(0, 8)})`);
          value = await this.session.rpc.ui.handlePendingUserInput({
            requestId: String(cmd.requestId || ""),
            response: { answer: String(cmd.answer ?? ""), wasFreeform: !!cmd.wasFreeform },
          });
          this.log(`cmd answer: native handlePendingUserInput returned ${JSON.stringify(value)}`);
        }
      }
      else { ok = false; value = "unknown_cmd:" + cmd.cmd; }
    } catch (e) { ok = false; value = String(e?.message || e); this.log(`cmd ${cmd.cmd}: FAILED ${value}`); }
    await this._post(d, "/live/result", { sessionId: this.sessionId, cmdId: cmd.cmdId, ok, value });
  }

  /** Route one SSE frame payload: a daemon SIGNAL ({signal:...}, fire-and-forget) → _onSignal; a COMMAND
   *  ({cmdId:...}, expects a /live/result) → _runCommand. Malformed JSON is ignored. Extracted so the
   *  routing is unit-testable (liveLink-signal.test.mjs) without a live daemon SSE. */
  _handleFramePayload(payload) {
    let cmd;
    try { cmd = JSON.parse(payload); } catch { return; }
    if (cmd?.signal) { try { this._onSignal?.(cmd); } catch {} }
    else if (cmd?.cmdId) this._runCommand(cmd);
  }

  /** Connect (join + open the commands SSE). Idempotent; schedules a retry on any failure. */
  connect() {
    if (this._stopped || this.connected) return;
    const d = this._daemon();
    if (!d) { this._scheduleRetry(); return; }
    this._post(d, "/live/join", { sessionId: this.sessionId }).then((code) => {
      if (this._stopped) return;
      if (code !== 200) { this._scheduleRetry(); return; }
      this._openCommands(d);
    });
  }

  _openCommands(d) {
    const path = `/live/commands?sessionId=${encodeURIComponent(this.sessionId)}&t=${encodeURIComponent(d.token)}`;
    const req = http.request(
      { host: "127.0.0.1", port: d.port, path, method: "GET", agent: this._agent,
        headers: { "x-copilot-token": d.token, Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); this._onDrop(); return; }
        this.connected = true;
        this._retryAttempt = 0; // healthy link — reset the reconnect backoff
        this._d = d;
        this.log(`live link up: session=${this.sessionId} port=${d.port}`);
        this._drain(); // flush anything queued before the SSE opened
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              const s = line.trimStart();
              if (!s.startsWith("data:")) continue; // ignore ":" keep-alive comments
              const payload = s.slice(5).trim();
              if (!payload) continue;
              try {
                this._handleFramePayload(payload);
              } catch {}
            }
          }
        });
        res.on("end", () => this._onDrop());
        res.on("error", () => this._onDrop());
      },
    );
    req.on("error", () => this._onDrop());
    req.end();
    this._cmdReq = req;
  }

  _onDrop() {
    if (this.connected) this.log(`live link down: session=${this.sessionId}`);
    this.connected = false;
    this._d = null;
    this._cmdReq = null;
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._stopped || this._retryTimer) return;
    const delay = liveRetryDelay(this._retryAttempt) + Math.floor(Math.random() * 500); // backoff + jitter
    this._retryAttempt++;
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this.connect(); }, delay);
    if (typeof this._retryTimer.unref === "function") this._retryTimer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    try { this._cmdReq?.destroy(); } catch {}
    const d = this._d || this._daemon();
    if (d) this._post(d, "/live/leave", { sessionId: this.sessionId }).catch(() => {});
    this.connected = false;
    this._d = null;
  }
}
