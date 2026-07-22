// netcore.mjs — the SINGLE source of truth for copilot-remote's wire transport.
//
// Both remote clients (BridgeClient in client.mjs, DaemonClient in daemon.mjs)
// import from here instead of each hand-rolling http + SSE. Zero external deps.
//
// Corporate TLS: outbound HTTPS (to a tunnel URL) can be re-signed by a corporate
// MITM proxy on the controlling machine. We build an https.Agent trusting the OS
// root store (Node >=22.15 tls.getCACertificates('system')) UNIONed with the
// bundled Mozilla roots — so the client trusts the corporate CA WITHOUT ever
// resorting to rejectUnauthorized:false. Feature-detected; degrades to the
// default agent when getCACertificates is unavailable.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";

export const TOKEN_HEADER = "x-copilot-token";

export function isAuthErr(e) {
    return /(?<!\d)(40[13])(?!\d)|forbidden|unauthorized/i.test(String(e?.message || e));
}

export function mod(u) {
    return u.protocol === "https:" ? https : http;
}

// Lazily-built https.Agent that trusts the system trust store + Mozilla roots.
// Built once and reused. Returns null when no augmentation is possible/needed
// (older Node) so callers fall back to the default global agent.
let _httpsAgent;
export function httpsAgent() {
    if (_httpsAgent !== undefined) return _httpsAgent;
    try {
        const sys = typeof tls.getCACertificates === "function" ? tls.getCACertificates("system") : [];
        if (Array.isArray(sys) && sys.length) {
            const bundled = Array.isArray(tls.rootCertificates) ? tls.rootCertificates : [];
            _httpsAgent = new https.Agent({ keepAlive: true, ca: [...bundled, ...sys] });
        } else {
            _httpsAgent = null;
        }
    } catch {
        _httpsAgent = null;
    }
    return _httpsAgent;
}

// Attach the CA-aware agent to request options for https targets only.
function withAgent(u, options) {
    if (u.protocol === "https:") {
        const a = httpsAgent();
        if (a) options.agent = a;
    }
    return options;
}

// One-shot JSON request. Resolves { ok, status, json } and never throws for
// HTTP-level errors; only rejects on socket/timeout failures.
export function httpJson(baseUrl, path, { method = "GET", token = null, body = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(path, baseUrl); } catch (e) { return reject(new Error("bad url: " + (e?.message || e))); }
        const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
        const headers = { Accept: "application/json" };
        if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
        if (token) headers[TOKEN_HEADER] = token;
        let settled = false;
        const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
        const req = mod(u).request(u, withAgent(u, { method, headers }), (res) => {
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

// Open an SSE event stream. Parses `data: {json}\n\n` frames, skips comment
// (`:`) lines. Returns a handle with .close(). Does NOT set a request timeout
// (the stream is intentionally long-lived); liveness is the caller's concern.
export function openEvents(baseUrl, token, { onEvent, onOpen, onError } = {}) {
    let u, closed = false, req = null;
    try { u = new URL("/events", baseUrl); } catch (e) { onError?.(new Error("bad url: " + (e?.message || e))); return { close() {} }; }
    const headers = { Accept: "text/event-stream" };
    if (token) headers[TOKEN_HEADER] = token;
    try {
        req = mod(u).request(u, withAgent(u, { method: "GET", headers }), (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                onError?.(new Error("sse_status_" + res.statusCode));
                return;
            }
            onOpen?.();
            res.setEncoding("utf8");
            let buf = "";
            res.on("data", (chunk) => {
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    for (const line of frame.split("\n")) {
                        if (!line.startsWith("data:")) continue; // skip `:` comments / padding
                        const payload = line.slice(5).trim();
                        if (!payload) continue;
                        let obj = null;
                        try { obj = JSON.parse(payload); } catch { obj = null; }
                        if (obj) onEvent?.(obj);
                    }
                }
            });
            res.on("end", () => { if (!closed) onError?.(new Error("sse_ended")); });
            res.on("error", (e) => { if (!closed) onError?.(e); });
        });
        req.on("error", (e) => { if (!closed) onError?.(e); });
        req.end();
    } catch (e) {
        onError?.(e);
    }
    return { close() { closed = true; try { req?.destroy(); } catch {} } };
}
