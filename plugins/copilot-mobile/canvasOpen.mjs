// canvasOpen.mjs — PURE helpers for making the ask_user PC canvas RELIABLE (no SDK, unit-testable).
//
// WHY: in override mode the native modal is suppressed, so the PC canvas MUST actually surface — "o
// canvas tem que funcionar". rpc.canvas.open returns an OpenCanvasInstance whose `availability` is
// "ready" (provider live, panel shown) or "stale" (provider went away ⇒ awaiting rebind). The old code
// fire-and-forgot the open and swallowed rejections, so a stale/failed open left the question with NO
// UI. These helpers drive a bounded retry: a stale/failed open is re-issued (re-opening rehydrates and
// rebinds the provider), and a genuinely-ready open stops the loop.

/** Classify an rpc.canvas.open result. "none" = null/undefined (open failed to return an instance);
 *  "stale" = provider gone (needs rebind); "ready" = shown (or a host that doesn't populate the field). */
export function availabilityOf(result) {
  if (!result) return "none";
  if (result.availability === "stale") return "stale";
  return "ready";
}

/** Should we retry rpc.canvas.open? Retry while attempts remain AND the last open threw, returned no
 *  instance, or came back "stale" — i.e. the panel is not confirmed shown. A "ready" result stops. */
export function shouldRetryCanvasOpen({ availability = "none", threw = false, attempt = 1, maxAttempts = 3 } = {}) {
  if (attempt >= maxAttempts) return false;
  if (threw) return true;
  return availability === "none" || availability === "stale";
}

/** Backoff (ms) before the next canvas-open attempt. Small + bounded — the answer path never waits on this. */
export function canvasRetryDelayMs(attempt) {
  const a = Math.max(1, attempt | 0);
  return Math.min(1200, 300 * a);
}
