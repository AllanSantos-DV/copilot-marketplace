// guards.mjs — as travas de segurança ANTES de qualquer kill. Nenhuma sozinha basta; TODAS têm de passar.
//   1. pid vivo               (senão nada a fazer)
//   2. auto-preservação       (nunca a própria sessão/scan nem seus ancestrais)
//   3. anti-TOCTOU            (o pid AINDA é um servidor --server --stdio; senão PID reciclado → aborta)
//   4. sem daemon singleton   (não derruba Action-mcp/embed-house/memory/bolão que servem todas as sessões)
// Ponte cross-session NÃO é guardada (decisão do ADR: se a sessão-ponte está ociosa, morre — trade-off aceito).

export const SINGLETON_RE = /action-mcp|embed-house|mcp-memory|server-http\.mjs|memory.*daemon/i;

// Conjunto de PIDs ancestrais de `pid` (subindo por ppid). Inclui o pai imediato até a raiz.
export function ancestorsOf(pid, procMap) {
  const anc = new Set();
  let cur = Number(pid), guard = 0;
  while (procMap.has(cur) && guard < 40) {
    const { ppid } = procMap.get(cur);
    if (anc.has(ppid)) break;
    anc.add(ppid);
    cur = ppid;
    guard++;
  }
  return anc;
}

// Filhos DIRETOS de `pid` no procMap.
export function childrenOf(pid, procMap) {
  const kids = [];
  const target = Number(pid);
  for (const [cpid, info] of procMap) if (info.ppid === target) kids.push({ pid: cpid, ...info });
  return kids;
}

/**
 * Decide se PODE descarregar o servidor. Retorna { ok:true } ou { ok:false, reason }.
 * @param {{pid:number}} server
 * @param {{selfPid:number, selfAncestors:Set<number>, procMap:Map, pidAlive:(n:number)=>boolean}} ctx
 */
export function guardKill(server, { selfPid, selfAncestors, procMap, pidAlive }) {
  const pid = Number(server.pid);
  if (!pidAlive(pid)) return { ok: false, reason: "pid-morto" };
  if (pid === selfPid) return { ok: false, reason: "self-pid" };
  if (selfAncestors.has(pid)) return { ok: false, reason: "ancestral-do-scan" };
  const cur = procMap.get(pid);
  if (!cur || !/--server --stdio/.test(cur.cmdline)) return { ok: false, reason: "cmdline-mudou-TOCTOU" };
  const singletonKid = childrenOf(pid, procMap).find((k) => SINGLETON_RE.test(k.cmdline));
  if (singletonKid) return { ok: false, reason: `hospeda-singleton:${singletonKid.name}` };
  return { ok: true };
}
