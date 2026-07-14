// askPage.mjs — PURE render-decision state machine for the ask_user canvas page (no DOM/SDK).
//
// The canvas HTML is a LONG-LIVED page: the ask server is memoized (one URL for the whole session) and
// the host REUSES the panel for each new question (same instanceId ⇒ it focuses the already-loaded
// webview instead of recreating it). So the page must handle a SEQUENCE of questions over its lifetime,
// re-arming after each answer. The original code used a permanent `done` flag that, once set, made the
// poll return forever — so a reused panel stayed stuck on the previous question's "✓ Respondido" screen
// and never showed the next question. This module is that decision, unit-tested; the inline page script
// mirrors it exactly.

/**
 * Decide what the 1-per-tick poll should do.
 * @param {{pendingRid: (string|null), renderedRid: (string|null), answering: boolean}} s
 * @returns {"skip"|"render"|"done-rearm"|"idle"}
 *   - "skip"       → a POST /answer is in flight, or the SAME question is still open: don't touch the DOM
 *                    (preserves typed text + input focus).
 *   - "render"     → a NEW question is open (requestId changed): rebuild the DOM for it.
 *   - "done-rearm" → no question is open but we had one rendered: show "✓ Respondido" ONCE and re-arm
 *                    (renderedRid→null) so the NEXT question renders even if the panel is reused.
 *   - "idle"       → nothing pending and already re-armed: leave the screen as-is.
 */
export function decideRender({ pendingRid = null, renderedRid = null, answering = false } = {}) {
  if (answering) return "skip";
  if (!pendingRid) return renderedRid !== null ? "done-rearm" : "idle";
  return pendingRid === renderedRid ? "skip" : "render";
}
