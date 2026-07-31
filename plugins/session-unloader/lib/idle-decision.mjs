import { descendantsOf } from "./guards.mjs";
import { evaluateIdle } from "./snapshot.mjs";

function failClosed(reason, descendantsResult = { descendentes: [], truncado: false }) {
  return {
    idle: false,
    reason,
    nextSnapshot: null,
    diagnostics: { failClosed: true },
    tree: [],
    descendantsResult,
  };
}

export function evaluateServerIdle({
  server,
  previous,
  procMap,
  config,
  now = Date.now(),
  cpuCount = 1,
} = {}) {
  if (!server?.sessionId) return failClosed("session-unknown");
  if (!(procMap instanceof Map)) return failClosed("tree-map-unavailable");

  const descendantsResult = descendantsOf(server.pid, procMap);
  const root = procMap.get(Number(server.pid));
  if (!root) return failClosed("tree-root-missing", descendantsResult);
  if (descendantsResult.truncado) return failClosed("tree-scan-truncated", descendantsResult);

  const tree = [{ pid: Number(server.pid), ...root }, ...descendantsResult.descendentes];
  if (tree.some((proc) => !Number.isFinite(Number(proc.cpu)))) {
    return { ...failClosed("tree-cpu-unavailable", descendantsResult), tree };
  }

  return {
    ...evaluateIdle({
      server,
      previous,
      tree,
      config: {
        ...config,
        allowlist: config?.effectiveAllowlist || config?.allowlist || [],
      },
      now,
      cpuCount,
    }),
    tree,
    descendantsResult,
  };
}
