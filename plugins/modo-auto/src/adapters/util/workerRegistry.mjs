// workerRegistry.mjs — registro CENTRAL dos workers vivos + encerramento por ÁRVORE. Sem ele, cada worker que
// sobrevive ao instante do kill vira órfão (o NETO pesado do SDK, 300-450MB) e VAZA. Dois usos:
//  (1) reap(child) nos 5 kill-points — troca o antigo `child.kill()` (que matava só o filho direto) por treeKill
//      (a ÁRVORE inteira) + untrack + log do residual (FAIL-LOUD centralizado num lugar só).
//  (2) killAll() no unload/deactivate — mata TODOS os workers ainda vivos no momento do descarregamento.
// Correções do painel profundo embutidas: DRAINING (anti-race: worker registrado DEPOIS do killAll começar é morto
// na hora, não escapa); budget GLOBAL coerente via Promise.race (execFile é ASSÍNCRONO → paraleliza de verdade;
// código síncrono NÃO paralelizaria); stderr/residual SINALIZADO (nunca "sucesso silencioso").
import { treeKill } from "./treeKill.mjs";

export function createWorkerRegistry({ log = () => {}, killer = treeKill } = {}) {
  const live = new Map(); // pid -> child
  let draining = false;

  // Registra um worker recém-spawnado. Untrack automático no exit/close (evita reap de um PID já reciclado pelo OS).
  function track(child) {
    const pid = child?.pid;
    if (!pid) return child;
    if (draining) { killer(pid).then((r) => { if (!r.ok) log(`[registry] reap tardio ${pid} FALHOU: ${r.reason}`); }); return child; } // anti-race
    live.set(pid, child);
    const drop = () => { live.delete(pid); };
    child.once("exit", drop); child.once("close", drop);
    return child;
  }

  // Mata a ÁRVORE de UM worker (substitui child.kill() nos kill-points) + untrack + loga residual. Nunca lança.
  async function reap(child) {
    const pid = child?.pid; if (!pid) return { ok: true, residual: [] };
    live.delete(pid);
    const r = await killer(pid);
    if (!r.ok) log(`[registry] reap ${pid} FALHOU (residual, SINALIZADO): ${r.reason}`);
    return r;
  }

  // Unload: DRENA em 2 FASES (contrato do plano, alinhado a liveWorkerClient.close): FASE 1 GRACIOSA — sinaliza cada
  // worker p/ sair limpo ({type:'close'} via stdin, que o live worker entende; para one-shot é no-op inofensivo) e
  // espera `drainMs`; quem sai sozinho NÃO precisa de taskkill /F. FASE 2 FORCE — tree-kill dos sobreviventes com
  // budget GLOBAL. NÃO manda SIGTERM ao root no drain (no Windows viraria TerminateProcess = órfãos, o bug original).
  async function killAll({ budgetMs = 4000, perKillTimeout = 3000, drainMs = 1500 } = {}) {
    draining = true;
    const entries = [...live.entries()];
    if (!entries.length) return { killed: [], residual: [], drained: [] };
    // FASE 1 — DRAIN GRACIOSO: pede saída limpa (sem force) e dá `drainMs` p/ o worker fechar o SDK sozinho.
    for (const [, child] of entries) {
      try { if (child.stdin?.writable) child.stdin.write(JSON.stringify({ type: "close" }) + "\n"); } catch { /* ignore */ }
      try { child.stdin?.end?.(); } catch { /* ignore */ }
    }
    if (drainMs > 0) await new Promise((res) => setTimeout(res, drainMs));
    const drained = entries.map(([p]) => p).filter((p) => !live.has(p)); // saíram sozinhos no drain (sem /F)
    const pids = [...live.keys()]; // sobreviventes → FASE 2 force
    if (!pids.length) { if (drained.length) log(`[registry] killAll: ${drained.length} worker(s) saíram no drain gracioso (sem force)`); return { killed: [], residual: [], drained }; }
    const kills = Promise.all(pids.map((pid) => killer(pid, { timeout: perKillTimeout }).then((r) => ({ pid, ...r }))));
    const budget = new Promise((res) => setTimeout(() => res("__budget__"), budgetMs));
    const done = await Promise.race([kills, budget]);
    live.clear();
    if (done === "__budget__") { log(`[registry] killAll: budget ${budgetMs}ms estourado — ${pids.length} worker(s) podem ter sobrado (residual)`); return { killed: [], residual: pids, drained }; }
    const residual = done.filter((r) => !r.ok).flatMap((r) => r.residual);
    const killed = done.filter((r) => r.ok).map((r) => r.pid);
    if (residual.length) log(`[registry] killAll residual (não morreram): ${residual.join(",")}`);
    return { killed, residual, drained };
  }

  return { track, reap, killAll, size: () => live.size, pids: () => [...live.keys()], isDraining: () => draining };
}

// SINGLETON compartilhado: os adapters (agentFactory/liveWorkerClient/modelProbe/shadowVerifier) importam ESTE p/
// registrar/reapar sem threading de DI por todas as assinaturas. `setLog` deixa o extension.mjs plugar o logHost.
let _log = () => {};
export const workers = createWorkerRegistry({ log: (m) => _log(m) });
export function setWorkerLog(fn) { if (typeof fn === "function") _log = fn; }
