// askBridgeServer.mjs — DISPATCH loopback do ask-bridge (Fase 2, lado independente do copilot-mobile). SEM deps
// (node:http). O DONO sobe createAskBridgeOwner (POST /register + dispatch a TODOS os respondedores: locais
// in-process + remotos via POST /ask deles), vencendo o PRIMEIRO {answer} (first-to-answer). O RESPONDEDOR sobe
// createAskBridgeResponder (POST /ask → askFn). registerWithOwner conecta um respondedor ao dono. FAIL LOUD:
// nenhum respondedor / nenhum respondeu → throw com contexto (NUNCA resposta fabricada, NUNCA fallback silencioso).

import { createServer, request as httpRequest } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

async function readBody(req) { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return {}; } }

// POST JSON via node:http com timeout. Resolve o JSON da resposta; rejeita em erro/timeout (fail loud no caller).
export function postJson(url, body, { timeoutMs = 5000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length, ...headers } }, (res) => {
      let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => { try { resolve(JSON.parse(out || "{}")); } catch (e) { reject(e); } });
    });
    const to = setTimeout(() => { req.destroy(new Error("timeout:" + timeoutMs)); }, timeoutMs);
    req.on("error", (e) => { clearTimeout(to); reject(e); });
    req.on("close", () => clearTimeout(to));
    req.end(data);
  });
}

// DONO: servidor de registro + dispatch first-to-answer.
export function createAskBridgeOwner({ log = () => {}, dispatchTimeoutMs = 2000 } = {}) {
  const token = randomBytes(16).toString("hex");
  const local = [];               // { id, priority, ask:async(payload)=>string|{answer,decline}|null }
  const remote = new Map();       // id -> { url, priority, answerTimeoutMs }
  let server = null, port = 0;

  const normAnswer = (r) => {
    if (typeof r === "string") return { answer: r, decline: false };
    if (r && typeof r === "object") return { answer: typeof r.answer === "string" ? r.answer : null, decline: !!r.decline };
    return { answer: null, decline: false };
  };

  async function callLocal(l, payload) { try { return normAnswer(await l.ask(payload)); } catch (e) { log(`[ask-bridge owner] local '${l.id}' erro: ` + (e?.message || e)); return { answer: null, decline: false }; } }
  async function callRemote(id, r, payload) {
    try { const out = await postJson(r.url, payload, { timeoutMs: r.answerTimeoutMs || 60000, headers: { "x-ask-token": token } }); return normAnswer(out); }
    catch (e) { log(`[ask-bridge owner] remoto '${id}' erro/timeout: ` + (e?.message || e)); return { answer: null, decline: false }; }
  }

  // Despacha a TODOS; vence o 1º answer não-nulo e não-decline. Todos null/decline → throw (FAIL LOUD).
  async function dispatch(question, { choices = [], allowFreeform = true } = {}) {
    const payload = { requestId: randomUUID(), question: String(question || ""), choices, allowFreeform };
    const runs = [
      ...local.map((l) => ({ id: l.id, run: () => callLocal(l, payload) })),
      ...[...remote.entries()].map(([id, r]) => ({ id, run: () => callRemote(id, r, payload) })),
    ];
    if (!runs.length) throw new Error("ask-bridge.dispatch: nenhum respondedor registrado (FAIL LOUD — sem quem responda)");
    return await new Promise((resolve, reject) => {
      let pending = runs.length, settled = false;
      for (const rr of runs) {
        rr.run().then((res) => {
          if (settled) return;
          if (res.answer != null && res.answer !== "" && !res.decline) { settled = true; resolve(res.answer); return; }
          if (--pending === 0) { settled = true; reject(new Error("ask-bridge.dispatch: nenhum respondedor respondeu (todos null/decline) — FAIL LOUD")); }
        });
      }
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = createServer(async (req, res) => {
        try {
          const u = new URL(req.url, "http://x");
          if (req.method === "GET" && u.pathname === "/health") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, responders: local.length + remote.size })); return; }
          if (req.headers["x-ask-token"] !== token) { res.statusCode = 401; res.end('{"error":"token"}'); return; }
          if (req.method === "POST" && u.pathname === "/register") {
            const b = await readBody(req);
            if (!b.responderId || !b.url) { res.statusCode = 400; res.end('{"error":"responderId+url obrigatórios"}'); return; }
            remote.set(String(b.responderId), { url: String(b.url), priority: b.priority || 0, answerTimeoutMs: b.answerTimeoutMs || 60000 });
            log(`[ask-bridge owner] respondedor '${b.responderId}' registrado → ${b.url}`);
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true })); return;
          }
          if (req.method === "DELETE" && u.pathname.startsWith("/register/")) { remote.delete(decodeURIComponent(u.pathname.slice(10))); res.end('{"ok":true}'); return; }
          res.statusCode = 404; res.end('{"error":"not found"}');
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message || e) })); }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { port = server.address().port; log(`[ask-bridge owner] loopback em 127.0.0.1:${port}`); resolve({ port, token }); });
    });
  }

  return {
    start, token,
    get port() { return port; },
    addLocalResponder(id, ask, priority = 0) { local.push({ id: String(id), ask, priority }); },
    dispatch,
    responderCount() { return local.length + remote.size; },
    close() { try { server?.close(); } catch { /* ignore */ } },
  };
}

// RESPONDEDOR: POST /ask → askFn(payload) → {answer,decline}. Retorna {url,close}.
export function createAskBridgeResponder(askFn, { log = () => {} } = {}) {
  let server = null, url = null;
  function start() {
    return new Promise((resolve, reject) => {
      server = createServer(async (req, res) => {
        try {
          const u = new URL(req.url, "http://x");
          if (req.method === "GET" && u.pathname === "/health") { res.end('{"ok":true}'); return; }
          if (req.method === "POST" && u.pathname === "/ask") {
            const b = await readBody(req);
            let ans = null; try { ans = await askFn(b); } catch (e) { log("[ask-bridge responder] askFn erro: " + (e?.message || e)); }
            const answer = typeof ans === "string" ? ans : (ans && typeof ans.answer === "string" ? ans.answer : null);
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ answer, decline: !!(ans && ans.decline) })); return;
          }
          res.statusCode = 404; res.end('{"error":"not found"}');
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message || e) })); }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { url = `http://127.0.0.1:${server.address().port}/ask`; resolve({ url }); });
    });
  }
  return { start, get url() { return url; }, close() { try { server?.close(); } catch { /* ignore */ } } };
}

export async function registerWithOwner(ownerPort, ownerToken, { responderId, url, priority = 0, answerTimeoutMs = 60000 } = {}) {
  return postJson(`http://127.0.0.1:${ownerPort}/register`, { responderId, url, priority, answerTimeoutMs }, { timeoutMs: 3000, headers: { "x-ask-token": ownerToken } });
}
