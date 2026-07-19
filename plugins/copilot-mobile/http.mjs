// HTTP helpers — one home for the bridge's small, hand-rolled loopback request/download plumbing so
// the timeouts, headers and never-throw semantics live in ONE place. Behavior-preserving: each
// helper reproduces exactly what its call-sites (liveLink, extension, bootstrap) used to do inline.
//
// NOTE ON DUPLICATION: `daemon/src/http.mjs` is a sibling module tailored to the daemon's own
// callers. The bridge is packaged and shipped independently (VS Code extension surface) and must
// never import from ../daemon/src, so the two modules share intent, not code. Streaming SSE reads
// (liveLink._openCommands) are NOT centralized here — those pipe a live event stream, not a one-shot
// request; SSE framing lives in ./sse.mjs.
import http from "node:http";
import { get as httpsGet } from "node:https";
import { createWriteStream, renameSync } from "node:fs";

/**
 * Loopback JSON POST. Never throws: resolves the response status code, or `0` on a body-stringify
 * failure or any transport error. Sets Content-Type + Content-Length automatically and merges the
 * caller's `headers` (e.g. an auth token). Mirrors liveLink's former private `_post`.
 * @param {{host?:string, port:number, path:string, headers?:object, agent?:any, timeoutMs?:number}} opts
 * @param {any} body JSON-serializable request body (defaults to `{}`).
 * @returns {Promise<number>} response status (0 on error).
 */
export function postJson({ host = "127.0.0.1", port, path, headers = {}, agent, timeoutMs }, body) {
  return new Promise((resolve) => {
    let data;
    try { data = Buffer.from(JSON.stringify(body || {})); } catch { return resolve(0); }
    const req = http.request(
      { host, port, path, method: "POST", agent,
        headers: { "Content-Type": "application/json", "Content-Length": data.length, ...headers } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode || 0)); res.on("error", () => resolve(0)); },
    );
    req.on("error", () => resolve(0));
    if (timeoutMs) req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(0); });
    req.write(data); req.end();
  });
}

/**
 * Loopback JSON GET. Never throws: resolves `{ status, json }` (json `null` on non-200, transport
 * error/timeout, or a parse failure). Mirrors extension's former private `queryAskMode` transport.
 * @param {{host?:string, port:number, path:string, headers?:object, agent?:any, timeoutMs?:number}} opts
 * @returns {Promise<{status:number, json:any}>}
 */
export function getJson({ host = "127.0.0.1", port, path, headers = {}, agent, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request(
      { host, port, path, method: "GET", headers, agent },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return finish({ status: res.statusCode || 0, json: null });
          try { finish({ status: 200, json: JSON.parse(b) }); }
          catch { finish({ status: 200, json: null }); }
        });
        res.on("error", () => finish({ status: 0, json: null }));
      },
    );
    req.on("error", () => finish({ status: 0, json: null }));
    if (timeoutMs) req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish({ status: 0, json: null }); });
    req.end();
  });
}

const REDIRECT_CODES = [301, 302, 303, 307, 308];

/**
 * Stream an https download to `dest`, following redirects (max `maxRedirects`), writing to a
 * `<dest>.part` temp file and atomically renaming on success. Rejects on non-200 / transport error /
 * timeout. Mirrors bootstrap's former private `download`.
 * @returns {Promise<void>}
 */
export function download(url, dest, { timeoutMs = 180000, maxRedirects = 5, get = httpsGet } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > maxRedirects) return reject(new Error("too many redirects"));
    const req = get(url, (res) => {
      if (REDIRECT_CODES.includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, { timeoutMs, maxRedirects, get }, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const part = dest + ".part";
      const out = createWriteStream(part);
      res.pipe(out);
      out.on("finish", () => out.close(() => { try { renameSync(part, dest); resolve(); } catch (e) { reject(e); } }));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("download timeout")));
  });
}
