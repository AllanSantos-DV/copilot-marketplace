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

## Owner question: remaining identity hits outside action-bridge (2026-11-10)

Sweep after the release: 89 hits, all the owner's name (no e-mail, no handle outside repo URLs).
Breakdown by origin:

| Group | Files (hits) | Who can change it |
|---|---|---|
| Vendored plugin authors | `author.name` in plugin.json of canvas-sync, copilot-memory, session-unloader (source: this repo), copilot-mobile, copilot-remote, mcp-bridge, modo-auto, voice-chat (sources: their own repos) (16) | this repo for the first three; each source repo's session for the rest, since `plugins/<name>/` is never edited by hand (AGENTS §2) |
| modo-auto extras | LICENSE, README, package.json, selftest/memory-validator-smoke.mjs:208 (a `C:\Users\<account>` path) (10) | modo-auto source repo |
| copilot-memory README | README.md:247 (2) | copilot-memory source |
| Manifest | `owner.name`, `metadata.description` ("Plugins do <name>"), `author.name` of each entry (19) | this repo |
| Showcase byline | footer "Feito por <name>" from `docs/build.mjs` -> every generated page, `docs/index.html` (6 + 2 per page) | this repo |
| Repo docs | README.md intro, AGENTS.md (2 + 7) | this repo |

Facts: in the Copilot CLI plugin reference, `author` is optional and only `author.name` is
required when the object exists; plugin `name` is the only required field
(https://docs.github.com/en/copilot/reference/cli-plugin-reference, accessed 2026-11-10).
The neutral pattern already shipped: action-bridge `{"name":"Action"}`, visual-explainer
`{"name":"o mantenedor"}`.

Decision for the owner: does the identity rule cover the showcase byline and the marketplace
owner (`owner.name`, the "Feito por" footer, README intro), which are the public face of the
storefront, or only what a plugin install ships?

Recommendation: neutralize everything a plugin install ships (all `author` fields, modo-auto
LICENSE/README/package.json/selftest path, copilot-memory README), each through its source repo
plus a version bump, and use "o mantenedor" for `owner.name`, the footer and the README intro.
The GitHub account in repository URLs stays: it is the repo address and cannot be removed
without moving the repositories.
