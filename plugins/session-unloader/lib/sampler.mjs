// sampler.mjs — SAMPLER SINGLETON do daemon único: tira o scan de processos do caminho de request.
// Coalescing running+pending: no máximo 1 scan em voo por instância; nudges que chegam durante um scan
// marcam `pending` e disparam UM novo scan ao final (nunca acumulam N scans para N nudges). `/data`
// sempre lê `snapshot()` — síncrono, nunca bloqueia no I/O do scan.
//
// Estados: "scanning" (scan em voo agora), "fresh" (último scan dentro de freshMs), "stale" (mais velho
// que freshMs — dispara nudge automático), "error" (o último scan falhou e não há dado nenhum ainda).
// `data === null` significa FRIO (nenhum scan concluiu ainda) — distinto de um scan concluído que achou
// zero sessões (`data.sessions === []`), que é um sistema vazio de verdade.
import { ancestorsOf, guardKill, tokensPorSessao } from "./guards.mjs";
import { readSnapshot } from "./snapshot.mjs";
import { evaluateServerIdle } from "./idle-decision.mjs";
import { pidAlive } from "./process-utils.mjs";
import { scanServers } from "./scan.mjs";
import { getProcMap } from "./procmap.mjs";
import { logLine } from "./log.mjs";
import { resolveCopilotHome } from "./home.mjs";
import { availableParallelism } from "node:os";

export const DEFAULT_FRESH_MS = 10000; // casa com o polling do front-end (10s)

export class Sampler {
  constructor({
    home = resolveCopilotHome(),
    freshMs = DEFAULT_FRESH_MS,
    scanFn = scanServers,
    procMapFn = getProcMap,
    now = () => Date.now(),
    log = logLine,
    sessionNameFn = () => null,
    cpuCount = availableParallelism(),
  } = {}) {
    this.home = home;
    this.freshMs = freshMs;
    this.scanFn = scanFn;
    this.procMapFn = procMapFn;
    this.now = now;
    this.log = log;
    this.sessionNameFn = sessionNameFn;
    this.cpuCount = cpuCount;

    this.data = null;          // último snapshot COMPLETO (null = frio, nenhum scan terminou ainda)
    this.generatedAt = null;   // epoch ms do último scan concluído (sucesso ou falha)
    this.lastError = null;
    this.lastDurationMs = null;
    this.scanCount = 0;
    this.scanFailCount = 0;

    this._scanning = false;
    this._pending = false;
    this._pendingCtx = null;
    this._runPromise = null;
  }

  isScanning() { return this._scanning; }

  /**
   * Pede um scan. Se já houver um em voo, apenas marca `pending` (coalescing) e devolve a MESMA promise
   * do scan em curso — não empilha um scan por nudge. Ao terminar, se `pending` foi marcado nesse meio
   * tempo, dispara exatamente MAIS UM scan (nunca mais que isso por rajada).
   */
  nudge(config, callerPid = null) {
    if (this._scanning) {
      this._pending = true;
      this._pendingCtx = { config, callerPid };
      return this._runPromise;
    }
    this._runPromise = this._runOnce(config, callerPid).then(async () => {
      if (this._pending) {
        const ctx = this._pendingCtx;
        this._pending = false;
        this._pendingCtx = null;
        await this.nudge(ctx.config, ctx.callerPid);
      }
    });
    return this._runPromise;
  }

  async _runOnce(config, callerPid) {
    this._scanning = true;
    const startedAt = this.now();
    try {
      const servers = await this.scanFn({ home: this.home });
      const procMap = await this.procMapFn();
      const computed = this._compute({ servers, procMap, config, callerPid, now: startedAt });
      this.data = computed;
      this.generatedAt = startedAt;
      this.lastError = null;
      this.lastDurationMs = this.now() - startedAt;
      this.scanCount++;
      this.log({
        action: "scan-cycle", ok: true, durationMs: this.lastDurationMs,
        sessions: computed.sessions.length, candidates: computed.counts.candidates,
        protectedCount: computed.counts.protectedCount,
      });
    } catch (e) {
      this.lastError = String(e?.message || e);
      this.generatedAt = startedAt;
      this.lastDurationMs = this.now() - startedAt;
      this.scanCount++;
      this.scanFailCount++;
      this.log({ level: "WARN", action: "scan-cycle", ok: false, durationMs: this.lastDurationMs, error: this.lastError });
    } finally {
      this._scanning = false;
    }
  }

  _compute({ servers, procMap, config, callerPid, now }) {
    const selfPid = process.pid;
    const selfAncestors = ancestorsOf(selfPid, procMap);
    const callerAncestors = callerPid ? ancestorsOf(callerPid, procMap) : new Set();
    const protectedPids = new Set([...selfAncestors, ...callerAncestors, selfPid]);
    if (callerPid) protectedPids.add(callerPid);
    const perSessionTokens = tokensPorSessao(procMap);

    let active = 0, protectedCount = 0, candidates = 0, ramLoadedMb = 0, ramReleasableMb = 0;
    const reasons = {};
    const bump = (reason) => { const k = String(reason || "desconhecido"); reasons[k] = (reasons[k] || 0) + 1; };

    const sessions = (servers || []).map((s) => {
      const decision = evaluateServerIdle({
        server: s,
        previous: s.sessionId ? readSnapshot(s.sessionId, { home: this.home }) : null,
        procMap, config, now, cpuCount: this.cpuCount,
      });
      ramLoadedMb += Number(s.wsMb) || 0;
      let verdict, icon;
      if (!s.sessionId) { verdict = "casca (sem sessão)"; icon = "⚪"; }
      else if (callerPid && callerAncestors.has(s.pid)) { verdict = "esta sessão"; icon = "🟢"; active++; }
      else if (!decision.idle) {
        const pinned = decision.reason.startsWith("pin:");
        const failClosed = decision.diagnostics?.failClosed === true;
        verdict = `${pinned || failClosed ? "protegida" : "ativa"} (${decision.reason})`;
        icon = pinned || failClosed ? "🔒" : "🟢";
        if (pinned || failClosed) { protectedCount++; bump(decision.reason); } else { active++; }
      } else {
        const g = guardKill(s, {
          selfPid, selfAncestors: protectedPids, procMap, pidAlive,
          perSessionTokens, descendantsResult: decision.descendantsResult,
        });
        if (g.ok) { verdict = "candidata"; icon = "🔴"; candidates++; ramReleasableMb += Number(s.wsMb) || 0; }
        else { verdict = "protegida (" + g.reason + ")"; icon = "🔒"; protectedCount++; bump(g.reason); }
      }
      return {
        pid: s.pid,
        name: s.sessionId ? (this.sessionNameFn(s.sessionId) || s.sessionId.slice(0, 8)) : "(servidor sem sessão)",
        idleMin: Number.isFinite(decision.diagnostics?.idleForMs) ? Math.round(decision.diagnostics.idleForMs / 60000) : null,
        wsMb: s.wsMb == null ? null : Number(s.wsMb),
        verdict, icon, reason: decision.reason, diagnostics: decision.diagnostics,
      };
    });

    return {
      sessions,
      counts: {
        loaded: sessions.length,
        active,
        protectedCount,
        candidates,
        ramLoadedMb: Math.round(ramLoadedMb),
        ramReleasableMb: Math.round(ramReleasableMb),
        reasons,
      },
    };
  }

  /** Leitura SÍNCRONA e imediata do último snapshot — nunca bloqueia em I/O. Dispara nudge se stale. */
  snapshot(config, callerPid = null) {
    const now = this.now();
    const age = this.generatedAt == null ? null : now - this.generatedAt;
    let state;
    if (this._scanning) state = "scanning";
    else if (this.data == null) state = this.lastError ? "error" : "stale";
    else if (this.lastError) state = "error";
    else if (age != null && age <= this.freshMs) state = "fresh";
    else state = "stale";

    // self-heal: "stale" já se auto-nudge-ava; "error" também precisa — senão uma falha transitória de
    // scan (PowerShell/CIM instável, timeout, etc.) trava o daemon em 'error' PARA SEMPRE, porque nada
    // mais chama nudge() sozinho. O guard `!this._scanning` reusa o mesmo coalescing running+pending do
    // nudge() — não há spin: enquanto um scan (ou seu retry) está em voo, novos polls só marcam `pending`.
    if ((state === "stale" || state === "error") && !this._scanning) this.nudge(config, callerPid);

    return {
      state,
      data: this.data,
      generatedAt: this.generatedAt == null ? null : new Date(this.generatedAt).toISOString(),
      cachedAt: this.generatedAt == null ? null : new Date(this.generatedAt).toISOString(),
      age,
      durationMs: this.lastDurationMs,
      lastError: this.lastError,
      nextScan: null,
      scanCount: this.scanCount,
      scanFailCount: this.scanFailCount,
    };
  }
}
