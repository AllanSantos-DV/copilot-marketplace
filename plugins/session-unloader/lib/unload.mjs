// Orchestrates tree-aware idle evaluation, final kill guards, treeKill and structured logging.
// DRY-RUN por padrão (só lista candidatas). Nunca lança para o hook (o caller decide propagar).
import { scanServers } from "./scan.mjs";
import { getProcMap } from "./procmap.mjs";
import { ancestorsOf, guardKill, tokensPorSessao } from "./guards.mjs";
import { readSnapshot, writeSnapshot, removeSnapshot } from "./snapshot.mjs";
import { acquireLock, releaseLock } from "./lock.mjs";
import { resolveCopilotHome } from "./home.mjs";
import { treeKill, pidAlive } from "./process-utils.mjs";
import { logLine } from "./log.mjs";
import { readConfig } from "./config.mjs";
import { availableParallelism } from "node:os";
import { evaluateServerIdle } from "./idle-decision.mjs";

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
  config = null,
  cpuCount = availableParallelism(),
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
    // Quais tokens são POR SESSÃO nesta foto (ex.: um MCP stdio que existe um por servidor). Calculado
    // UMA vez para a varredura inteira — é uma propriedade da árvore, não de cada servidor.
    const perSessionTokens = tokensPorSessao(procMap);
    const cfg = config || readConfig({ home });
    // protege também a sessão que disparou a ação pelo painel (nunca mata quem clicou)
    if (callerPid) { for (const p of ancestorsOf(callerPid, procMap)) selfAncestors.add(p); selfAncestors.add(callerPid); }

    const candidates = [], killed = [], skipped = [], protectedSessions = [];
    // rebase = atualiza a linha de base de CPU. SÓ em execução real (dryRun=false): o dry-run é READ-ONLY,
    // não pode "armar" o próximo scan gravando snapshot (senão um preview altera o estado — bug medido).
    const rebase = (s, nextSnapshot) => {
      if (!dryRun && s.sessionId && nextSnapshot) writeSnapshot(s.sessionId, nextSnapshot, { home });
    };

    for (const s of servers) {
      if (sessionId && s.sessionId !== sessionId) continue;
      const prev = s.sessionId ? readSnapshot(s.sessionId, { home }) : null;
      const decision = evaluateServerIdle({
        server: s,
        previous: prev,
        procMap,
        config: cfg,
        now,
        cpuCount,
      });
      const { tree, descendantsResult } = decision;
      if (!decision.idle) {
        protectedSessions.push({
          sessionId: s.sessionId,
          pid: s.pid,
          reason: decision.reason,
          diagnostics: decision.diagnostics,
        });
        if (decision.diagnostics?.failClosed) {
          log({ level: "WARN", action: "decision-fail-closed", sessionId: s.sessionId, pid: s.pid, reason: decision.reason });
        }
        rebase(s, decision.nextSnapshot);
        continue;
      }

      const candidate = {
        sessionId: s.sessionId,
        pid: s.pid,
        reason: decision.reason,
        diagnostics: decision.diagnostics,
      };
      candidates.push(candidate);
      if (dryRun) {
        log({ action: "dry-run", ...candidate });
        continue;
      }

      const g = guardKill(s, {
        selfPid,
        selfAncestors,
        procMap,
        pidAlive: alive,
        perSessionTokens,
        descendantsResult,
      });
      if (!g.ok) {
        skipped.push({ sessionId: s.sessionId, pid: s.pid, reason: g.reason });
        protectedSessions.push({ sessionId: s.sessionId, pid: s.pid, reason: g.reason });
        log({ level: "WARN", action: "skipped", sessionId: s.sessionId, pid: s.pid, reason: g.reason });
        rebase(s, decision.nextSnapshot);
        continue;
      }
      const r = await kill(s.pid);
      const ok = r && r.ok !== false;
      const killEntry = {
        sessionId: s.sessionId,
        pid: s.pid,
        commandLine: s.commandLine,
        wsMb: s.wsMb,
        reason: ok ? decision.reason : (r && r.reason),
        idleDecision: decision.diagnostics,
        descendants: tree.map((proc) => ({
          pid: proc.pid,
          ppid: proc.ppid,
          name: proc.name,
          cpu: proc.cpu,
        })),
      };
      log({ action: ok ? "killed" : "kill-fail", ...killEntry });
      if (ok) {
        killed.push({ sessionId: s.sessionId, pid: s.pid, reason: decision.reason });
        if (s.sessionId) removeSnapshot(s.sessionId, { home });
      }
      else { skipped.push({ sessionId: s.sessionId, pid: s.pid, reason: "kill-fail" }); }
    }
    return { candidates, killed, skipped, protected: protectedSessions };
  } finally {
    releaseLock({ home });
  }
}
