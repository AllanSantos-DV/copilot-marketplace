// unload.mjs — orquestra a descarga: lock anti-race → scan → procMap → para cada servidor decide idle
// (sinal duplo) → aplica as guardas → treeKill → log → remove snapshot. Tudo injetável para teste.
// DRY-RUN por padrão (só lista candidatas). Nunca lança para o hook (o caller decide propagar).
import { scanServers } from "./scan.mjs";
import { getProcMap } from "./procmap.mjs";
import { ancestorsOf, guardKill } from "./guards.mjs";
import { readSnapshot, writeSnapshot, removeSnapshot, isIdle } from "./snapshot.mjs";
import { acquireLock, releaseLock } from "./lock.mjs";
import { resolveCopilotHome } from "./home.mjs";
import { treeKill, pidAlive } from "./process-utils.mjs";
import { logLine } from "./log.mjs";

export async function unloadIdle({
  home = resolveCopilotHome(),
  dryRun = true,
  sessionId = null,
  callerPid = null,
  now = Date.now(),
  killFn = null,
  pidAliveFn = null,
  scan = scanServers,
  procMapFn = getProcMap,
  log = logLine,
} = {}) {
  const kill = killFn || treeKill;
  const alive = pidAliveFn || pidAlive;

  if (!acquireLock({ home }, now)) {
    return { skipped: [{ reason: "lock-ocupado" }], candidates: [], killed: [] };
  }
  try {
    const servers = await scan({ home });
    const procMap = await procMapFn();
    const selfPid = process.pid;
    const selfAncestors = ancestorsOf(selfPid, procMap);
    // protege também a sessão que disparou a ação pelo painel (nunca mata quem clicou)
    if (callerPid) { for (const p of ancestorsOf(callerPid, procMap)) selfAncestors.add(p); selfAncestors.add(callerPid); }

    const candidates = [], killed = [], skipped = [];
    // rebase = atualiza a linha de base de CPU. SÓ em execução real (dryRun=false): o dry-run é READ-ONLY,
    // não pode "armar" o próximo scan gravando snapshot (senão um preview altera o estado — bug medido).
    const rebase = (s) => { if (!dryRun && s.sessionId) writeSnapshot(s.sessionId, { cpu: s.cpu, at: now }, { home }); };

    for (const s of servers) {
      if (sessionId && s.sessionId !== sessionId) continue;
      const prev = s.sessionId ? readSnapshot(s.sessionId, { home }) : null;
      if (!isIdle(s, prev, now)) { rebase(s); continue; }         // ativa/cold-start → só atualiza a base

      candidates.push({ sessionId: s.sessionId, pid: s.pid });
      if (dryRun) { log({ action: "dry-run", sessionId: s.sessionId, pid: s.pid, reason: "candidata" }); rebase(s); continue; }

      const g = guardKill(s, { selfPid, selfAncestors, procMap, pidAlive: alive });
      if (!g.ok) {
        skipped.push({ sessionId: s.sessionId, pid: s.pid, reason: g.reason });
        log({ level: "WARN", action: "skipped", sessionId: s.sessionId, pid: s.pid, reason: g.reason });
        rebase(s);
        continue;
      }
      const r = await kill(s.pid);
      const ok = r && r.ok !== false;
      log({ action: ok ? "killed" : "kill-fail", sessionId: s.sessionId, pid: s.pid, commandLine: s.commandLine, wsMb: s.wsMb, reason: ok ? "idle-10min+cpu0" : (r && r.reason) });
      if (ok) { killed.push({ sessionId: s.sessionId, pid: s.pid }); if (s.sessionId) removeSnapshot(s.sessionId, { home }); }
      else { skipped.push({ sessionId: s.sessionId, pid: s.pid, reason: "kill-fail" }); }
    }
    return { candidates, killed, skipped };
  } finally {
    releaseLock({ home });
  }
}
