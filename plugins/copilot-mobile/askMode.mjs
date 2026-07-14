// askMode.mjs — PURE decision: should this live session OVERRIDE ask_user, or keep the NATIVE tool?
//
// THE CONTRACT (from the bug's root cause): the SDK can only decide tool overrides at joinSession boot
// and a custom override CANNOT delegate back to the native ask_user. So "always override" (the old
// behavior) meant that with the daemon OFF — no phone, no open transport — the native PC modal was
// suppressed AND the question reached nobody (it died in the daemon's empty broadcast) AND the PC canvas
// was the only, unreliable, fallback. Net: the question was HIDDEN and the turn hung until cancelled.
//
// Fix: gate the override on there being an OPEN transport at boot.
//   • transport OPEN (daemon mode is local/lan/tailscale/public/…) ⇒ OVERRIDE: route to the phone + show
//     the PC canvas (the phone-first experience the user wants when armed).
//   • transport CLOSED (mode "off" / unknown / daemon absent)      ⇒ NATIVE: the standard desktop
//     ask_user modal renders and is answered on the PC — reliable, never hidden.
//
// Pure + unit-testable (no SDK, no fs). The caller (extension.mjs) reads runtime.json once at boot and
// passes the mode. NOTE: the SDK fixes the tool set at joinSession boot (no live swap), so a session that
// boots OFF stays native for its life — still phone-answerable via handlePendingUserInput, but reopen the
// session to boot it armed for the canvas UX.

/**
 * @param {{ mode?: string|null }} args - `mode` is the daemon's runtime.json transport mode.
 * @returns {boolean} true ⇒ register the ask_user override (canvas + phone); false ⇒ keep native ask_user.
 */
export function decideAskUserOverride({ mode } = {}) {
  const m = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  // Only an OPEN transport enables the override. Everything else (off, empty, unknown) ⇒ native.
  if (!m || m === "off") return false;
  return true;
}

/** True when a mode STRING represents an open transport (symmetry helper for the runtime watcher). */
export function isOpenTransport(mode) {
  return decideAskUserOverride({ mode });
}
