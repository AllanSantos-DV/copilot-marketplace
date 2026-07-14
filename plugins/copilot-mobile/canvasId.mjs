// canvasId.mjs — PURE derivation of the per-session ask_user canvas id (no SDK import, unit-testable).
//
// WHY THIS EXISTS: the ask_user override registers its PC canvas dynamically via joinSession({ canvases }).
// A canvas id is registered at the HOST keyed GLOBALLY by that id — it is last-writer-wins. With a single
// FIXED id shared by every session, the newest session to load (or reload) STEALS the registration, and
// every OTHER session's `rpc.canvas.open` then fails with `No canvas "<id>" is registered` — the question
// never surfaces on the PC and the user is stuck (has to Stop the session and answer by hand). Deriving the
// id from the session (with a pid fallback) gives each concurrent session its OWN canvas that can never be
// stolen by a sibling, so N sessions can each show their own question canvas at the same time.

export const ASK_CANVAS_BASE = "copilot-mobile-ask";

/** Derive the unique canvas + instance ids for one session. `sessionId` is preferred (stable across a
 *  reload of the SAME session); `pid` is the fallback so two sessions without a SESSION_ID env still get
 *  distinct ids. The suffix is sanitized to the id-safe charset and length-capped. */
export function deriveCanvasIds(sessionId = "", pid = 0) {
  const cleaned = String(sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
  const suffix = cleaned || `pid-${pid || 0}`;
  const canvasId = `${ASK_CANVAS_BASE}-${suffix}`;
  return { canvasId, instanceId: `${canvasId}-1` };
}
