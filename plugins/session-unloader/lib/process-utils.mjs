// process-utils.mjs — utilitários de processo COMPARTILHADOS entre plugins do Copilot CLI (cross-plugin).
//
// Consolidação (ADR session-unloader, Fase 1): reúne, SEM alteração funcional, duas funções já validadas em
// produção noutros plugins, para que novos plugins (ex.: session-unloader) não redupliquem:
//   • treeKill(pid)  — origem: modo-auto/src/adapters/util/treeKill.mjs (mata a ÁRVORE inteira, fail-loud).
//   • pidAlive(pid)  — origem: voice-chat/voice-core.mjs (sonda de PID vivo cross-fork).
// Os originais NÃO são alterados (apenas copiados); esta é a cópia canônica para reúso. Zero dependências
// externas — só a stdlib do Node (child_process, util).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const isWin = process.platform === "win32";
// "já morto" (idempotência): Windows taskkill = exit 128 + "not found"/"não ... encontrado"; Unix = ESRCH.
const NOT_FOUND_RE = /not found|not running|no such process|n(ã|a)o .*encontrad|não existe/i;

/**
 * Mata a árvore de processos enraizada em `pid` (o processo e TODOS os descendentes). Nunca lança.
 * @param {number} pid — PID raiz da árvore (o servidor de sessão a descarregar).
 * @param {{ timeout?:number }} [opts] — timeout do kill (ms, default 5000). Sem timeout → risco de hang do event loop.
 * @returns {Promise<{ok:boolean, residual:number[], reason?:string}>}
 *   ok:true  → árvore encerrada, OU já estava morta (idempotente). residual:[].
 *   ok:false → NÃO conseguiu (acesso negado, timeout, erro real). residual:[pid] + reason (SINALIZADO — o caller
 *              DEVE logar/propagar; nunca engolir). Não é "sucesso silencioso".
 */
export async function treeKill(pid, { timeout = 5000 } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, residual: [], reason: `pid inválido: ${pid}` };
  try {
    if (isWin) {
      // /T = árvore (o processo E os filhos iniciados por ele); /F = força. windowsHide evita flash de janela.
      await pexec("taskkill", ["/T", "/F", "/PID", String(n)], { timeout, windowsHide: true });
    } else {
      // pkill -P mata os filhos DIRETOS; depois o próprio pid. ESRCH = já morto.
      try { await pexec("pkill", ["-TERM", "-P", String(n)], { timeout }); } catch { /* sem filhos diretos = ok */ }
      try { process.kill(n, "SIGTERM"); } catch (e) { if (e?.code !== "ESRCH") throw e; }
    }
    return { ok: true, residual: [] };
  } catch (e) {
    // combina TODOS os campos onde a mensagem pode estar (stderr some quando há timeout; message às vezes é só
    // "Command failed"). Robusto contra a variação de forma do erro do execFile com/sem a opção timeout.
    const msg = [e?.stderr, e?.stdout, e?.message].map((x) => String(x || "")).join(" ");
    const code = e?.code;
    // idempotência: processo já inexistente NÃO é falha (taskkill exit 128 / ESRCH / texto "not found").
    if (code === 128 || code === "ESRCH" || NOT_FOUND_RE.test(msg)) return { ok: true, residual: [] };
    // FALHA REAL sinalizada (ex.: "Access is denied", timeout ETIMEDOUT): devolve residual pro caller decidir.
    return { ok: false, residual: [n], reason: (code === "ETIMEDOUT" ? `timeout ${timeout}ms: ` : "") + (msg.trim().slice(0, 200) || `code ${code}`) };
  }
}

/**
 * Sonda se um PID está VIVO (cross-fork). process.kill(pid,0) NÃO envia sinal — só testa existência:
 * lança ESRCH se morto, EPERM se existe mas sem permissão (= vivo). Usado para descartar locks stale e
 * para a guarda de auto-preservação/anti-TOCTOU antes de um kill.
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}
