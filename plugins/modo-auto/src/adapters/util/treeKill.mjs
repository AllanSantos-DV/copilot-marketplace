// treeKill.mjs — mata a ÁRVORE INTEIRA de um processo (o filho E todos os netos), determinístico e FAIL-LOUD.
// Motivo (MEDIDO nesta máquina): o reaper do modo-auto matava só o filho DIRETO (child.kill() = TerminateProcess
// no PID). No Windows os NETOS (launcher → CLI → sessão do SDK Copilot, 300-450MB) ficam ÓRFÃOS e VAZAM — medi
// ~1GB de árvores idle vivas depois do comando terminar. Aqui: `taskkill /T /F` (árvore inteira) no Windows,
// `pkill -P` + SIGTERM no Unix.
//
// ASSÍNCRONO de propósito (execFile promisified): `killAll` precisa paralelizar N kills via Promise.all/Promise.race
// — código SÍNCRONO (execFileSync) NÃO paraleliza (correção do painel profundo). Idempotente (PID já morto = ok).
// FAIL-LOUD: captura stderr e DISTINGUE "não encontrado" (=já morto, ok) de "acesso negado"/timeout (=ok:false +
// residual + reason). NUNCA lança — o caller decide (logar/propagar). LIMITAÇÃO: crash abrupto do host (kill -9,
// BSOD) não roda ninguém → netos sobrevivem como hoje (<5% dos encerramentos); mitigação futura = Job Object N-API.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const isWin = process.platform === "win32";
// "já morto" (idempotência): Windows taskkill = exit 128 + "not found"/"não ... encontrado"; Unix = ESRCH.
const NOT_FOUND_RE = /not found|not running|no such process|n(ã|a)o .*encontrad|não existe/i;

/**
 * Mata a árvore de processos enraizada em `pid` (o processo e TODOS os descendentes). Nunca lança.
 * @param {number} pid — PID raiz da árvore (o filho spawnado).
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
      // pkill -P mata os filhos DIRETOS; depois o próprio pid. Premissa do projeto: CLI→SDK encerram pelo fecho
      // do pipe stdin quando o CLI recebe SIGTERM (mesmo contrato que a mesa inteira já assume). ESRCH = já morto.
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
