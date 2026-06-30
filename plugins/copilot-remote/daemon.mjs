// daemon.mjs — client for the copilot-mobile DAEMON (multi-session protocol).
//
// Unlike the old single-session bridge, the daemon controls EVERY session on the
// target machine. This client speaks its session-scoped contract:
//   GET  /ping                         -> { ok, daemon:true, mode, paired }
//   GET  /sessions                     -> { ok, sessions:[{sessionId,title,running}] }
//   POST /subscribe {sessionId,limit}  -> { ok, recent:[...] }   (normalized history)
//   POST /send {sessionId,prompt}      -> { ok, messageId }
//   POST /abort {sessionId}            -> { ok }
//   GET  /events  (SSE)                -> data: { sessionId, type, ... }  (multiplexed)
// Auth: x-copilot-token (desktop token over loopback, or a paired mobile token).
//
// One persistent SSE stream fans events to per-call waiters, each filtered by the
// sessionId it cares about — so N sessions never cross wires.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_HEADER = "x-copilot-token";
const mod = (u) => (u.protocol === "https:" ? https : http);

// Read the locally-running daemon's loopback coordinates (published on boot).
export function localDaemonInfo() {
    try {
        const home = process.env.COPILOT_DAEMON_HOME || join(homedir(), ".copilot-mobile-daemon");
        const r = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"));
        if (r && r.loopPort && r.desktopToken) {
            return { baseUrl: `http://127.0.0.1:${r.loopPort}`, token: r.desktopToken, mode: r.mode || "off", exposedUrl: r.exposedUrl || null };
        }
    } catch {}
    return null;
}

export function httpJson(baseUrl, path, { method = "GET", token = null, body = null, timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(path, baseUrl); } catch (e) { return reject(new Error("bad url: " + (e?.message || e))); }
        const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
        const headers = { Accept: "application/json" };
        if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
        if (token) headers[TOKEN_HEADER] = token;
        let settled = false;
        const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
        const req = mod(u).request(u, { method, headers }, (res) => {
            let buf = "";
            res.setEncoding("utf8");
            res.on("data", (d) => (buf += d));
            res.on("end", () => {
                let json = null;
                try { json = buf ? JSON.parse(buf) : {}; } catch { json = { ok: false, error: "bad_json", raw: buf }; }
                finish(resolve, { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, json });
            });
            res.on("error", (e) => finish(reject, e));
        });
        req.on("error", (e) => finish(reject, e));
        if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
        if (data) req.write(data);
        req.end();
    });
}

export class DaemonClient {
    constructor({ baseUrl, token = null, deviceId = null, deviceSecret = null, name = "Controle Remoto (desktop)" } = {}) {
        if (!baseUrl) throw new Error("baseUrl required");
        this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        this.token = token;            // desktop token (loopback) or peer token (paired)
        this.deviceId = deviceId;      // peer slot credentials (cross-machine reconnect)
        this.deviceSecret = deviceSecret;
        this.name = name;
        this._sinks = new Set();   // (evt) => void  — evt carries .sessionId
        this._sse = null;
        this._sseReq = null;
        this._closed = false;
    }

    creds() {
        return { baseUrl: this.baseUrl, token: this.token, deviceId: this.deviceId, deviceSecret: this.deviceSecret, name: this.name };
    }

    // Pair with a remote daemon as the PEER slot (a controller machine, coexists
    // with the phone). Exchanges a 6-digit code for { token, deviceId, deviceSecret }.
    async pairAsPeer(code) {
        const r = await httpJson(this.baseUrl, "/pair/claim", { method: "POST", body: { code: String(code || ""), name: this.name, kind: "peer" }, timeoutMs: 15000 });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        this.token = r.json.token;
        this.deviceId = r.json.deviceId;
        this.deviceSecret = r.json.deviceSecret;
        return this.creds();
    }

    // Re-authenticate the pinned peer (no code) → fresh token.
    async deviceAuth() {
        if (!this.deviceId || !this.deviceSecret) throw new Error("no_peer_creds");
        const r = await httpJson(this.baseUrl, "/device/auth", { method: "POST", body: { deviceId: this.deviceId, deviceSecret: this.deviceSecret }, timeoutMs: 12000 });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        this.token = r.json.token;
        return this.token;
    }

    // Ensure a usable token: prefer existing; else re-auth from peer creds.
    async ensureToken() {
        if (this.token) return this.token;
        if (this.deviceId && this.deviceSecret) return this.deviceAuth();
        throw new Error("not_paired");
    }

    static local() {
        const info = localDaemonInfo();
        return info ? new DaemonClient(info) : null;
    }

    async ping() {
        const r = await httpJson(this.baseUrl, "/ping", { token: this.token, timeoutMs: 8000 });
        return r.json || { ok: false };
    }
    async listSessions() {
        const r = await httpJson(this.baseUrl, "/sessions", { token: this.token, timeoutMs: 12000 });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        return Array.isArray(r.json.sessions) ? r.json.sessions : [];
    }
    async subscribe(sessionId, limit = 1) {
        const r = await httpJson(this.baseUrl, "/subscribe", { method: "POST", token: this.token, body: { sessionId, limit }, timeoutMs: 30000 });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        return r.json.recent || [];
    }
    async send(sessionId, prompt) {
        const r = await httpJson(this.baseUrl, "/send", { method: "POST", token: this.token, body: { sessionId, prompt }, timeoutMs: 30000 });
        if (!r.ok || !r.json?.ok) throw new Error(r.json?.error || ("http_" + r.status));
        return r.json.messageId || null;
    }
    async abort(sessionId) {
        const r = await httpJson(this.baseUrl, "/abort", { method: "POST", token: this.token, body: { sessionId }, timeoutMs: 8000 });
        return !!r.json?.ok;
    }

    // Persistent multiplexed event stream. Idempotent; auto-reconnects unless closed.
    ensureStream() {
        if (this._sse || this._closed) return;
        let u;
        try { u = new URL("/events", this.baseUrl); } catch { return; }
        const headers = { Accept: "text/event-stream", [TOKEN_HEADER]: this.token };
        try {
            this._sseReq = mod(u).request(u, { method: "GET", headers }, (res) => {
                if (res.statusCode !== 200) { res.resume(); this._sse = null; if (!this._closed) setTimeout(() => this.ensureStream(), 1500); return; }
                this._sse = res;
                res.setEncoding("utf8");
                let buf = "";
                res.on("data", (chunk) => {
                    buf += chunk;
                    let idx;
                    while ((idx = buf.indexOf("\n\n")) >= 0) {
                        const frame = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);
                        for (const line of frame.split("\n")) {
                            if (!line.startsWith("data:")) continue;
                            const payload = line.slice(5).trim();
                            if (!payload) continue;
                            let obj = null;
                            try { obj = JSON.parse(payload); } catch { obj = null; }
                            if (obj) for (const s of [...this._sinks]) { try { s(obj); } catch {} }
                        }
                    }
                });
                res.on("end", () => { this._sse = null; if (!this._closed) setTimeout(() => this.ensureStream(), 1500); });
                res.on("error", () => { this._sse = null; if (!this._closed) setTimeout(() => this.ensureStream(), 1500); });
            });
            this._sseReq.on("error", () => { this._sse = null; if (!this._closed) setTimeout(() => this.ensureStream(), 2000); });
            this._sseReq.end();
        } catch {}
    }

    onEvent(cb) { this._sinks.add(cb); this.ensureStream(); return () => this._sinks.delete(cb); }

    // Send a prompt to one session and await that session's reply (collect assistant
    // messages until idle / question / permission / timeout). Subscribes first so the
    // reply is captured, registers the waiter BEFORE sending (no race).
    async ask(sessionId, prompt, { timeoutMs = 180000 } = {}) {
        this.ensureStream();
        await this.subscribe(sessionId, 1);
        const waiter = this._waitTurn(sessionId, timeoutMs);
        await this.send(sessionId, prompt);
        return waiter;
    }

    _waitTurn(sessionId, timeoutMs) {
        return new Promise((resolve) => {
            const parts = [];
            let settled = false;
            const off = this.onEvent(onEvt);
            const timer = setTimeout(() => finish("timeout"), timeoutMs);
            function finish(status, extra = {}) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                off();
                resolve({ status, reply: parts.join("\n\n").trim(), ...extra });
            }
            function onEvt(evt) {
                if (!evt || evt.sessionId !== sessionId) return;
                switch (evt.type) {
                    case "assistant": if (evt.content) parts.push(evt.content); break;
                    case "idle": finish(evt.aborted ? "aborted" : "idle"); break;
                    case "question": finish("question", { question: { id: evt.id ?? evt.requestId ?? null, question: evt.question || "", choices: Array.isArray(evt.choices) ? evt.choices : [] } }); break;
                    case "permission": finish("permission", { permission: { requestId: evt.requestId, title: evt.title || "", detail: evt.detail || "" } }); break;
                    default: break;
                }
            }
        });
    }

    close() {
        this._closed = true;
        this._sinks.clear();
        try { this._sse?.destroy(); } catch {}
        try { this._sseReq?.destroy(); } catch {}
        this._sse = null;
    }
}

export default DaemonClient;
