// Persists per-PID cumulative CPU and the monotonic idle window for one session process tree.
// The pure evaluator is shared by the hook, tool and dashboard.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

const HUNDRED_NS_PER_MS = 10_000;

function snapPath(home, sid) { return join(home, "session-state", sid, ".cpu-snapshot.json"); }

export function readSnapshot(sid, { home = resolveCopilotHome() } = {}) {
  try { return JSON.parse(readFileSync(snapPath(home, sid), "utf8")); } catch { return null; }
}

export function writeSnapshot(sid, data, { home = resolveCopilotHome() } = {}) {
  const p = snapPath(home, sid);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}

// Remove a linha de base (ao descarregar a sessão): o reabrir vira cold-start limpo, nunca morto de imediato.
export function removeSnapshot(sid, { home = resolveCopilotHome() } = {}) {
  try { unlinkSync(snapPath(home, sid)); return true; } catch { return false; }
}

function snapshotFor(tree, now, idleSince) {
  const pidCpu = {};
  for (const proc of tree || []) {
    const pid = Number(proc?.pid);
    const cpu = Number(proc?.cpu);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(cpu) && cpu >= 0) pidCpu[pid] = cpu;
  }
  return { version: 2, pidCpu, at: now, idleSince };
}

function matchingPin(tree, allowlist) {
  for (const token of allowlist || []) {
    const literal = String(token || "").trim();
    if (!literal) continue;
    const needle = literal.toLowerCase();
    if ((tree || []).some((proc) =>
      `${proc?.name || ""}\n${proc?.cmdline || ""}`.toLowerCase().includes(needle))) return literal;
  }
  return null;
}

/**
 * Pure, tree-aware idle decision. I/O adapters provide the process tree and persist nextSnapshot.
 */
export function evaluateIdle({
  server,
  previous,
  tree,
  config,
  now = Date.now(),
  cpuCount = 1,
} = {}) {
  const idleTimeoutMs = Number(config?.idleTimeoutMs);
  const activeCpuRatio = Number(config?.activeCpuRatio);
  const minSampleMs = Number(config?.minSampleMs);
  const safeCpuCount = Math.max(1, Number(cpuCount) || 1);
  const pin = matchingPin(tree, config?.allowlist);

  if (pin) {
    return {
      idle: false,
      reason: `pin:${pin}`,
      nextSnapshot: snapshotFor(tree, now, now),
      diagnostics: { pin, allowlist: [...(config?.allowlist || [])] },
    };
  }

  const validPrevious = previous?.version === 2
    && previous.pidCpu && typeof previous.pidCpu === "object"
    && Number.isFinite(Number(previous.at))
    && Number.isFinite(Number(previous.idleSince));
  if (!validPrevious) {
    return {
      idle: false,
      reason: "cold-start",
      nextSnapshot: snapshotFor(tree, now, now),
      diagnostics: { migratedLegacySnapshot: previous != null },
    };
  }

  if (Number(server?.eventsMtimeMs) > Number(previous.at)) {
    return {
      idle: false,
      reason: "events-active",
      nextSnapshot: snapshotFor(tree, now, now),
      diagnostics: { eventsMtimeMs: Number(server.eventsMtimeMs) },
    };
  }

  const deltaWallMs = now - Number(previous.at);
  if (!Number.isFinite(deltaWallMs) || deltaWallMs < minSampleMs) {
    return {
      idle: false,
      reason: "sample-too-short",
      nextSnapshot: previous,
      diagnostics: { deltaWallMs, minSampleMs },
    };
  }

  let cpuBusy100ns = 0;
  const pidDeltas = {};
  const treeChanges = [];
  for (const proc of tree || []) {
    const pid = Number(proc?.pid);
    const cpu = Number(proc?.cpu);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(cpu) || cpu < 0) continue;
    const before = Number(previous.pidCpu[pid]);
    if (!Number.isFinite(before)) treeChanges.push({ pid, change: "added" });
    else if (cpu < before) treeChanges.push({ pid, change: "cpu-regressed" });
    const delta = Number.isFinite(before) ? Math.max(0, cpu - before) : cpu;
    pidDeltas[pid] = delta;
    cpuBusy100ns += delta;
  }
  const cpuRatio = (cpuBusy100ns / HUNDRED_NS_PER_MS) / (deltaWallMs * safeCpuCount);
  const diagnostics = {
    deltaWallMs,
    cpuBusy100ns,
    cpuRatio,
    cpuCount: safeCpuCount,
    pidDeltas,
    allowlist: [...(config?.allowlist || [])],
    treeChanges,
  };
  if (treeChanges.length) {
    return {
      idle: false,
      reason: "tree-changed",
      nextSnapshot: snapshotFor(tree, now, now),
      diagnostics,
    };
  }
  if (cpuRatio >= activeCpuRatio) {
    return {
      idle: false,
      reason: "cpu-active",
      nextSnapshot: snapshotFor(tree, now, now),
      diagnostics,
    };
  }

  const idleSince = Number(previous.idleSince);
  const idleForMs = Math.max(0, now - idleSince);
  const idle = idleForMs >= idleTimeoutMs;
  return {
    idle,
    reason: idle ? "idle-timeout" : "idle-countdown",
    nextSnapshot: snapshotFor(tree, now, idleSince),
    diagnostics: { ...diagnostics, idleSince, idleForMs, idleTimeoutMs },
  };
}
