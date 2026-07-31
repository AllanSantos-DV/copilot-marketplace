// daemon-client.mjs — CLIENTE HTTP FINO do daemon único. É o único ponto de contato entre o processo da
// sessão (extension.mjs) e o núcleo pesado (scan/guards/telemetry/unload), que só existe no processo do
// daemon. Zero fallback: qualquer falha (find-or-start, transporte, HTTP não-2xx) vira um Error explícito
// com contexto — nunca é engolida nem mascarada por um segundo servidor local.
//
// Import-safe: este módulo só usa fetch/URL/URLSearchParams (stdlib) — não importa nada de lib/scan.mjs,
// lib/guards.mjs, lib/dashboard.mjs etc. Mantém extension.mjs fora do grafo de imports pesado.

async function readJsonSafely(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Faz uma requisição autenticada ao daemon. GET manda o token na query (a página do painel também usa
 * este padrão); métodos que mutam estado mandam o token no header X-Token (nunca no body).
 * @returns {Promise<any>} o corpo JSON já parseado.
 * @throws {Error} com `.status` (se HTTP) ou `.code` (ex.: DAEMON_TIMEOUT) quando a chamada falha.
 */
export async function daemonRequest(baseUrl, token, path, { method = "GET", callerPid = null, body, timeoutMs = 8000 } = {}) {
  const u = new URL(path, baseUrl);
  if (callerPid) u.searchParams.set("callerPid", String(callerPid));
  const headers = {};
  if (method === "GET") {
    u.searchParams.set("token", token || "");
  } else {
    headers["X-Token"] = token || "";
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(u, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`daemon não respondeu em ${timeoutMs}ms (${path})`);
      err.code = "DAEMON_TIMEOUT";
      throw err;
    }
    const err = new Error(`falha ao contatar o daemon em ${path}: ${e?.message || e}`);
    err.code = "DAEMON_UNREACHABLE";
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await readJsonSafely(res);
  if (!res.ok) {
    const detail = (json && json.error) || res.statusText || "erro desconhecido";
    const err = new Error(`daemon respondeu HTTP ${res.status} em ${path}: ${detail}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function unloadPath({ dryRun, sessionId }) {
  const qs = new URLSearchParams({ dryRun: dryRun ? "1" : "0" });
  if (sessionId) qs.set("sessionId", sessionId);
  return `action/unload?${qs.toString()}`;
}

/**
 * Encaminha `unload_idle` (tool) ao daemon. Preserva o contrato dryRun/force/sessionId/callerPid.
 * Nunca faz fallback: se `ensureDaemonFn` ou o transporte falharem, relança um erro com contexto.
 */
export async function requestUnload({
  ensureDaemonFn,
  requestFn = daemonRequest,
  dryRun = true,
  sessionId = null,
  callerPid = null,
} = {}) {
  let target;
  try {
    target = await ensureDaemonFn();
  } catch (e) {
    const err = new Error(`daemon do painel indisponível: ${e?.message || e}`);
    err.cause = e;
    throw err;
  }
  try {
    return await requestFn(target.url, target.token, unloadPath({ dryRun, sessionId }), {
      method: "POST",
      callerPid,
    });
  } catch (e) {
    const err = new Error(`ação do daemon falhou: ${e?.message || e}`);
    err.cause = e;
    err.status = e?.status;
    throw err;
  }
}

/** Busca o snapshot (`/data`) do daemon. Mesma disciplina de erro explícito que requestUnload. */
export async function requestSnapshot({ ensureDaemonFn, requestFn = daemonRequest, callerPid = null } = {}) {
  let target;
  try {
    target = await ensureDaemonFn();
  } catch (e) {
    const err = new Error(`daemon do painel indisponível: ${e?.message || e}`);
    err.cause = e;
    throw err;
  }
  try {
    return await requestFn(target.url, target.token, "data", { method: "GET", callerPid });
  } catch (e) {
    const err = new Error(`leitura do daemon falhou: ${e?.message || e}`);
    err.cause = e;
    throw err;
  }
}
