// client.mjs — pure-Node client for the copilot-mobile bridge wire protocol.
//
// This is the ONLY place that knows the remote contract. If the bridge contract
// shifts, change it here (the host + UI talk to this module, never to the bridge
// directly). No external deps; works against http (LAN/Tailscale) and https
// (public cloudflared tunnel). Secrets (token, deviceSecret) live here in Node,
// never in the webview.
//
// Wire contract (consumed; the bridge owns it):
//   POST /pair/claim   {code, kind, name}        -> {ok, token, deviceId, deviceSecret}
//   POST /device/auth  {deviceId, deviceSecret}  -> {ok, token}
//   GET  /events       (SSE, x-copilot-token)    -> data: {json}\n\n  (first: {type:"hello",snapshot,recent})
//   GET  /poll?since=N (x-copilot-token)          -> {ok, seq, events, busy, pending, question}
//   POST /send         {prompt, attachments?}     -> {ok, messageId}
//   POST /permission   {requestId, decision}      -> {ok, applied}
//   POST /abort                                   -> {ok}
//   GET  /ping                                    -> {ok, role, busy}

import { httpJson, openEvents, isAuthErr } from "./netcore.mjs";

// A connection to ONE remote bridge. Holds auth state; exposes the protocol
// verbs plus a resilient `subscribe()` (SSE with automatic poll fallback — the
// poll path is the bridge's guaranteed channel through buffering tunnels).
export class BridgeClient {
    constructor({ baseUrl, token = null, deviceId = null, deviceSecret = null, kind = "desktop", name = "Desktop" } = {}) {
        if (!baseUrl) throw new Error("baseUrl required");
        this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        this.token = token;
        this.deviceId = deviceId;
        this.deviceSecret = deviceSecret;
        this.kind = kind;
        this.name = name;
        this._sub = null;
    }

    creds() {
        return { baseUrl: this.baseUrl, token: this.token, deviceId: this.deviceId, deviceSecret: this.deviceSecret, kind: this.kind, name: this.name };
    }

    // Exchange a 6-digit pairing code for a token + persistent device creds.
    async pair(code) {
        const r = await httpJson(this.baseUrl, "/pair/claim", { method: "POST", body: { code: String(code || ""), kind: this.kind, name: this.name } });
        if (!r.ok || !r.json?.ok) {
            const err = r.json?.error || ("http_" + r.status);
            throw new Error(err);
        }
        this.token = r.json.token;
        this.deviceId = r.json.deviceId;
        this.deviceSecret = r.json.deviceSecret;
        return this.creds();
    }

    // Re-auth a previously paired device (no code). Refreshes the token.
    async deviceAuth() {
        if (!this.deviceId || !this.deviceSecret) throw new Error("no_device_creds");
        const r = await httpJson(this.baseUrl, "/device/auth", { method: "POST", body: { deviceId: this.deviceId, deviceSecret: this.deviceSecret } });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        this.token = r.json.token;
        return this.token;
    }

    // De-duplicated re-auth: refresh the token from stored device creds. Multiple
    // concurrent callers share one in-flight attempt. Returns true on success.
    _reauth() {
        if (!this.deviceId || !this.deviceSecret) return Promise.resolve(false);
        if (this._reauthing) return this._reauthing;
        this._reauthing = (async () => {
            try { await this.deviceAuth(); return true; }
            catch { return false; }
            finally { this._reauthing = null; }
        })();
        return this._reauthing;
    }

    // Run an auth'd call; on a 401/403 (e.g. the bridge rotated its token after a
    // re-arm), refresh the token once and retry. Other errors propagate.
    async _withReauth(fn) {
        try { return await fn(); }
        catch (e) {
            if (isAuthErr(e) && (await this._reauth())) return await fn();
            throw e;
        }
    }

    // Ensure we hold a usable token: re-auth if we have device creds, else fail
    // (the caller must pair() first). Returns the token.
    async ensureToken() {
        if (this.deviceId && this.deviceSecret) {
            try { return await this.deviceAuth(); } catch (e) { if (this.token) return this.token; throw e; }
        }
        if (this.token) return this.token;
        throw new Error("not_paired");
    }

    async ping() {
        const r = await httpJson(this.baseUrl, "/ping", { method: "GET", token: this.token, timeoutMs: 8000 });
        return { ok: !!r.json?.ok, role: r.json?.role || null, busy: !!r.json?.busy, status: r.status };
    }

    async send(prompt, attachments = []) {
        return this._withReauth(async () => {
            const body = { prompt: String(prompt ?? "") };
            if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
            const r = await httpJson(this.baseUrl, "/send", { method: "POST", token: this.token, body, timeoutMs: 30000 });
            if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
            return r.json.messageId || null;
        });
    }

    async permission(requestId, decision) {
        return this._withReauth(async () => {
            const r = await httpJson(this.baseUrl, "/permission", { method: "POST", token: this.token, body: { requestId, decision } });
            if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
            return true;
        });
    }

    async abort() {
        return this._withReauth(async () => {
            const r = await httpJson(this.baseUrl, "/abort", { method: "POST", token: this.token, timeoutMs: 8000 });
            return !!r.json?.ok;
        });
    }

    // Answer a pending ask_user question (resolves the agent's prompt on the
    // bridge). wasFreeform=true when the user typed instead of picking a choice.
    async answer(text, wasFreeform = false) {
        return this._withReauth(async () => {
            const r = await httpJson(this.baseUrl, "/answer", { method: "POST", token: this.token, body: { answer: String(text ?? ""), wasFreeform: !!wasFreeform }, timeoutMs: 30000 });
            if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
            return true;
        });
    }

    async poll(since = 0) {
        const r = await httpJson(this.baseUrl, "/poll?since=" + encodeURIComponent(since), { method: "GET", token: this.token, timeoutMs: 12000 });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        return r.json; // { ok, seq, events, busy, pending, question }
    }

    // Resilient subscription: open SSE; if it fails or never delivers, fall back
    // to a poll loop. `onEvent(evt)` gets every durable event (with .seq);
    // `onStatus({busy,pending,question,transport})` gets ephemeral state.
    // Returns a handle with .close().
    subscribe({ onEvent, onStatus, pollMs = 1500, sseGraceMs = 4000 } = {}) {
        let stopped = false;
        let sse = null;
        let pollTimer = null;
        let lastSeq = 0;
        let graceTimer = null;
        let gotData = false;

        const bumpSeq = (evt) => { if (evt && typeof evt.seq === "number" && evt.seq > lastSeq) lastSeq = evt.seq; };

        const startPolling = (reason) => {
            if (stopped || pollTimer) return;
            if (sse) { try { sse.close(); } catch {} sse = null; }
            onStatus?.({ transport: "poll", reason: reason || null });
            const tick = async () => {
                if (stopped) return;
                try {
                    const r = await this.poll(lastSeq);
                    if (typeof r.seq === "number") lastSeq = Math.max(lastSeq, r.seq);
                    for (const evt of r.events || []) { bumpSeq(evt); onEvent?.(evt); }
                    onStatus?.({ transport: "poll", busy: !!r.busy, pending: r.pending || [], question: r.question ?? null });
                } catch (e) {
                    if (isAuthErr(e)) { try { await this._reauth(); } catch {} }
                    onStatus?.({ transport: "poll", error: String(e?.message || e) });
                }
                if (!stopped) pollTimer = setTimeout(tick, pollMs);
            };
            tick();
        };

        const startSse = () => {
            gotData = false;
            sse = openEvents(this.baseUrl, this.token, {
                onOpen: () => onStatus?.({ transport: "sse", connected: true }),
                onEvent: (evt) => {
                    gotData = true;
                    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
                    bumpSeq(evt);
                    if (evt.type === "hello") {
                        // hello carries snapshot + recent backlog
                        for (const e of evt.recent || []) { bumpSeq(e); onEvent?.(e); }
                        onStatus?.({ transport: "sse", snapshot: evt.snapshot || null });
                        return;
                    }
                    if (evt.type === "busy") { onStatus?.({ transport: "sse", busy: !!evt.busy }); return; }
                    onEvent?.(evt);
                },
                onError: async (err) => {
                    if (stopped) return;
                    if (isAuthErr(err)) { try { await this._reauth(); } catch {} }
                    startPolling("sse_error");
                },
            });
            // If SSE produces nothing within the grace window (e.g. a tunnel that
            // buffers), switch to polling — the guaranteed path.
            graceTimer = setTimeout(() => { if (!stopped && !gotData) startPolling("sse_silent"); }, sseGraceMs);
        };

        startSse();
        this._sub = {
            close() {
                stopped = true;
                if (graceTimer) clearTimeout(graceTimer);
                if (pollTimer) clearTimeout(pollTimer);
                if (sse) { try { sse.close(); } catch {} }
            },
        };
        return this._sub;
    }
}

export default BridgeClient;
