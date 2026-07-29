// askBridgeClaim.mjs — COMPANION do bridge COMPARTILHADO de ask_user (Fase 1). O SDK só permite UM override de
// ask_user por sessão; este módulo COORDENA (via lockfile ATÔMICO por sessão) QUEM registra o override. Reuso dos
// padrões do próprio dono: openSync(path,'wx') atômico (embed-house/provision.mjs) + process.kill(pid,0) stale
// check (copilot-mobile/singleton). PORTÁVEL e SEM deps → promovível a módulo compartilhado (~/.ask-bridge/lib) na
// Fase 2, quando o copilot-mobile adotar o mesmo protocolo. FAIL LOUD: erro inesperado SOBE (o caller sinaliza),
// NUNCA degrada calado.
//
// acquireOrConnect(sessionId, {extensionId}) → { isOwner, owner?, release }
//   isOwner=true  → ESTE plugin é o dono da rota nesta sessão → REGISTRA o override.
//   isOwner=false → outro plugin JÁ é dono (owner.json, pid VIVO) → NÃO registrar (evita o clash). Na Fase 2,
//                   conectar como RESPONDEDOR via owner.loopbackPort. `owner` traz o dono atual.
//
// Riscos conhecidos e mitigação:
//   • PID recycling (Windows): process.kill(pid,0) pode dar falso-positivo p/ um pid reciclado. MITIGADO por
//     HEARTBEAT — o dono re-carimba heartbeatAt no owner.json (startHeartbeat); acquireOrConnect trata como STALE
//     (e rouba) um dono cujo heartbeat passou de staleMs. Gated por opt-in: sem heartbeatAt → pidAlive puro (não
//     rouba dono antigo). • TOCTOU: openSync('wx') é atômico (só um vence); a janela lock→owner.json é coberta
//     por poll curto do perdedor.

import { openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bridgeDir(sessionId, home = homedir()) {
  const safe = String(sessionId || "default").replace(/[^\w.-]/g, "_");
  return join(home, ".ask-bridge", "sessions", safe);
}

// pid vivo? EPERM (existe, sem permissão) conta como vivo; ESRCH (não existe) = morto.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

export function readOwner(dir) {
  try { return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { return null; }
}

// owner.json "stale por IDADE"? SÓ quando o dono OPTOU pelo heartbeat (campo heartbeatAt presente) E o último beat
// passou de staleMs. Sem heartbeatAt (dono antigo/pré-heartbeat) → NUNCA stale por idade (cai no pidAlive puro) —
// assim NÃO roubamos o claim de um dono legítimo (ex.: copilot-mobile que ainda não adotou o heartbeat).
export function ownerStale(owner, staleMs = 90000) {
  if (!owner || !owner.heartbeatAt) return false;
  const t = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) > staleMs;
}

/**
 * @param {string} sessionId
 * @param {{ extensionId?:string, home?:string, ownerExtra?:object, pollMs?:number, pollTries?:number, staleMs?:number }} [opts]
 * @returns {Promise<{ isOwner:boolean, owner:object|null, release:()=>boolean }>}
 */
export async function acquireOrConnect(sessionId, { extensionId = "modo-auto", home = homedir(), ownerExtra = {}, pollMs = 200, pollTries = 3, staleMs = 90000 } = {}) {
  const dir = bridgeDir(sessionId, home);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, "claim.lock");
  const ownerPath = join(dir, "owner.json");

  const writeOwner = () => {
    const now = new Date().toISOString();
    const owner = { pid: process.pid, extensionId, sessionId: String(sessionId || ""), bootId: Math.random().toString(36).slice(2), acquiredAt: now, heartbeatAt: now, ...ownerExtra };
    writeFileSync(ownerPath, JSON.stringify(owner, null, 2));
    return owner;
  };
  // Aquisição ATÔMICA: openSync('wx') falha com EEXIST se o lock já existe (só um vence). Outro erro SOBE (fail loud).
  const tryAcquire = () => {
    let fd;
    try { fd = openSync(lockPath, "wx"); } catch (e) { if (e && e.code === "EEXIST") return null; throw e; }
    try { const owner = writeOwner(); return { isOwner: true, owner, release: () => releaseClaim(sessionId, { home, myPid: process.pid }) }; }
    finally { try { closeSync(fd); } catch { /* ignore */ } }
  };

  let got = tryAcquire();
  if (got) return got;

  // Ocupado → quem é o dono? Poll curto (janela entre o lock e o owner.json do vencedor).
  let owner = readOwner(dir);
  for (let i = 0; i < pollTries && !owner; i++) { await sleep(pollMs); owner = readOwner(dir); }

  // Dono VIVO (pid) E com heartbeat fresco (ou sem opt-in de heartbeat) → não registrar; respondedor na Fase 2.
  if (owner && owner.pid !== process.pid && pidAlive(owner.pid) && !ownerStale(owner, staleMs)) {
    return { isOwner: false, owner, release: () => false };
  }

  // Dono MORTO (pid não vivo), STALE por idade (pid reciclado/travado no Windows), ou owner.json nunca apareceu
  // (vencedor crashou pré-escrita) → cleanup + 1 retry (rouba o claim órfão).
  try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* travado: segue best-effort */ }
  try { if (existsSync(ownerPath)) unlinkSync(ownerPath); } catch { /* ignore */ }
  got = tryAcquire();
  if (got) return got;

  // Ainda ocupado (corrida no cleanup com outro plugin) → conecta com o dono atual. Sinalizado ao caller.
  owner = readOwner(dir);
  return { isOwner: false, owner: owner || null, release: () => false };
}

// Libera o claim SÓ se EU for o dono (nunca apaga o lock de outro plugin). Remove o dir da sessão se ficar VAZIO
// (não deixa órfão em ~/.ask-bridge/sessions/). Idempotente.
export function releaseClaim(sessionId, { home = homedir(), myPid = process.pid } = {}) {
  const dir = bridgeDir(sessionId, home);
  const owner = readOwner(dir);
  if (owner && owner.pid !== myPid) return false; // outro plugin é dono → não toca
  let removed = false;
  try { if (existsSync(join(dir, "owner.json"))) { unlinkSync(join(dir, "owner.json")); removed = true; } } catch { /* ignore */ }
  try { if (existsSync(join(dir, "claim.lock"))) { unlinkSync(join(dir, "claim.lock")); removed = true; } } catch { /* ignore */ }
  try { if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* dir em uso/corrida: ignora */ }
  return removed;
}

// HEARTBEAT (gap Windows PID-recycling): o dono re-carimba heartbeatAt no owner.json → prova de vida por IDADE além
// do pid. SÓ se EU for o dono. Idempotente/best-effort.
export function heartbeat(sessionId, { home = homedir(), myPid = process.pid } = {}) {
  const dir = bridgeDir(sessionId, home);
  const owner = readOwner(dir);
  if (!owner || owner.pid !== myPid) return false;
  try { writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...owner, heartbeatAt: new Date().toISOString() }, null, 2)); return true; } catch { return false; }
}

// Liga o heartbeat periódico (timer UNREF — não segura o processo). Retorna stop().
export function startHeartbeat(sessionId, { home = homedir(), myPid = process.pid, intervalMs = 20000 } = {}) {
  const t = setInterval(() => { try { heartbeat(sessionId, { home, myPid }); } catch { /* ignore */ } }, intervalMs);
  if (t && typeof t.unref === "function") t.unref();
  return () => { try { clearInterval(t); } catch { /* ignore */ } };
}

// Mescla campos no owner.json (ex.: loopbackPort/token do dispatch da Fase 2) — SÓ se EU for o dono. O servidor
// sobe DEPOIS do acquire (precisa da porta), então o dono re-grava o owner.json com a porta p/ os respondedores.
export function updateOwnerInfo(sessionId, extra = {}, { home = homedir(), myPid = process.pid } = {}) {
  const dir = bridgeDir(sessionId, home);
  const owner = readOwner(dir);
  if (!owner || owner.pid !== myPid) return false; // não sou o dono → não mexo
  try { writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...owner, ...extra }, null, 2)); return true; } catch { return false; }
}

// ── SINAL DE CONTROLE AUTÔNOMO POR SESSÃO (protocolo 1.2.0, aditivo) ───────────────────────────────────────
// PROBLEMA: o override do ask_user é ÚNICO por sessão e amarrado no JOIN. Um plugin de RELAY (whatsapp-bridge)
// tem bind de UMA sessão só; um plugin de CONTROLE AUTÔNOMO (modo-auto) é POR SESSÃO. Quando os dois caem na
// MESMA sessão, o relay tomava a tecla e a pergunta ia pro humano — travando justamente a sessão que o dono
// LIGOU para ser autônoma. REGRA DO DONO: na sessão com controle autônomo ARMADO, quem responde é ele.
// Este sinal é o contrato: quem arma DECLARA (setArmed) e o relay CONSULTA (isArmed) ANTES de registrar.

// Declara/retira o controle autônomo DESTA sessão. armed=false remove o arquivo (o relay volta a valer).
export function setArmed(sessionId, armed, { extensionId = "modo-auto", home = homedir(), myPid = process.pid } = {}) {
  const dir = bridgeDir(sessionId, home);
  const f = join(dir, "armed.json");
  if (!armed) {
    const cur = (() => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } })();
    if (cur && cur.pid !== myPid) return false; // não desarmo o sinal de OUTRO processo
    try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
    try { if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* em uso */ }
    return true;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify({ pid: myPid, extensionId, sessionId: String(sessionId || ""), armedAt: new Date().toISOString() }, null, 2));
  return true;
}

// Há controle autônomo VIVO nesta sessão? Retorna o sinal ou null. `excludeExtensionId` ignora o próprio plugin
// (quem armou não cede pra si mesmo). Sinal de processo MORTO é ignorado (e limpo) — nunca bloqueia pra sempre.
export function isArmed(sessionId, { home = homedir(), excludeExtensionId = null } = {}) {
  const dir = bridgeDir(sessionId, home);
  const f = join(dir, "armed.json");
  let a = null;
  try { a = JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  if (!a || (excludeExtensionId && a.extensionId === excludeExtensionId)) return null;
  if (!pidAlive(a.pid)) { try { unlinkSync(f); } catch { /* best-effort */ } return null; } // órfão → não bloqueia
  return a;
}