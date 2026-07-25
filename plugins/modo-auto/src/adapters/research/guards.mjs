// guards.mjs — as DEFESAS das research tools (rede num worker = superfície nova). Três guards, todos FAIL-LOUD
// (retornam {ok:false,error} explícito — nunca deixam passar calado): (1) safeUrl anti-SSRF (só https, bloqueia
// alvo local/privado); (2) cleanQuery (tira segredo/caminho da query antes de sair pra web); (3) cleanOutput
// (tira <script>/injection do markdown ANTES de voltar pro modelo — a página é conteúdo hostil não-confiável).

const MAX_QUERY = 200;
const MAX_OUTPUT = 8000;

// IP/host literalmente local ou de rede privada (defesa anti-SSRF básica — sem resolver DNS; bloqueio por forma).
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, ""); // tira colchetes de IPv6
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // v6 loopback/ULA/link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;               // loopback, privada /8, 0.0.0.0/8
    if (a === 169 && b === 254) return true;                          // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;                 // privada /12
    if (a === 192 && b === 168) return true;                          // privada /16
  }
  return false;
}

// Valida uma URL ALVO (a página que o pesquisador quer ler). Só https; nunca alvo local/privado.
export function safeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, error: "url_blocked", reason: "vazia" };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: "url_blocked", reason: "malformada" }; }
  if (u.protocol !== "https:") return { ok: false, error: "url_blocked", reason: `protocolo ${u.protocol} (só https)` };
  if (isPrivateHost(u.hostname)) return { ok: false, error: "url_blocked", reason: `host local/privado ${u.hostname}` };
  return { ok: true, url: u.toString() };
}

// Tira SEGREDO/caminho/identificador da query antes de mandar pra web (não vaza token/UUID/path do projeto).
export function cleanQuery(raw) {
  let q = String(raw || "").replace(/\s+/g, " ").trim();
  q = q
    .replace(/[A-Za-z]:\\[^\s]+/g, " ")                               // caminho Windows C:\...
    .replace(/(?:^|\s)\/(?:home|users|root|etc|var|tmp)\/[^\s]+/gi, " ") // caminho POSIX sensível
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat|sk|xox[baprs])[-_][A-Za-z0-9_]{10,}\b/g, " ") // tokens
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, " ")               // Authorization
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ") // UUID
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, " ")                    // base64/hex longo
    .replace(/\s+/g, " ").trim()
    .slice(0, MAX_QUERY);
  if (!q) return { ok: false, error: "query_empty", reason: "query vazia após sanitização" };
  return { ok: true, query: q };
}

// Limpa o markdown vindo da web ANTES do modelo: trunca, tira script/comentário e neutraliza injection de prompt.
export function cleanOutput(raw) {
  let t = String(raw || "");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  // neutraliza (não apaga — deixa auditável) linhas que tentam sequestrar o modelo
  t = t.replace(/^\s*(system|assistant|developer)\s*:/gim, "[neutralizado] $1:")
       .replace(/ignore (all )?(previous|prior|above)( instructions)?/gi, "[neutralizado: instrução ignorada]")
       .replace(/disregard (all )?(previous|prior|above)/gi, "[neutralizado]");
  if (t.length > MAX_OUTPUT) t = t.slice(0, MAX_OUTPUT) + "\n…[truncado]";
  return t;
}

export const GUARD_LIMITS = { MAX_QUERY, MAX_OUTPUT };
