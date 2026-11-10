# action-bridge: neutral plugin author (2026-11-10)

Source reference: Action commit 8048d9b (neutral author "Action"). The vendored runtime
(`extension.mjs`) is byte-identical to the Action `dist/extension.mjs`, so only metadata changed:
`plugins/action-bridge/plugin.json` and the manifest entry (author `Action`, version 1.3.1).

Identity sweep (`owner-identity-sweep.mjs --pasta`): 97 hits before, 93 after. The 4 removed are the
author lines of action-bridge (plugin.json) and its manifest entry. Remaining hits are outside this
change: other plugins' `author`, README/AGENTS, the generated page footer ("Feito por ..."),
`docs/build.mjs`, modo-auto LICENSE/README/selftest.

Sister-feature candidates (technical, no change in end-user use unless noted):
1. Gate: manifest entry must equal plugin.json (name/version/description); copilot-mobile already drifts.
2. Gate: fail on a `hooks` pointer to a missing file (5 plugins declare hooks.json with none vendored).
3. Gate: require a version bump when plugin files change in the push range.
4. Gate: canvas plugins (`extensions`) must ship boot.mjs (voice-chat does not; confirm intent).
5. Show publish date on vitrine cards (changes what the user sees: owner decision).
6. Consolidate the three daemon-lifecycle copies (session-unloader, modo-auto/embed-house, visual-explainer).
