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

## Owner decision applied: neutral storefront (2026-11-10)

Decision relayed by the orchestrator: the identity rule covers the storefront's public face too.
Applied in this repo: `author.name` "o mantenedor" in canvas-sync 0.6.1, copilot-memory 1.17.1 and
session-unloader 0.7.1 (author url dropped); manifest `owner.name`, `metadata.description` and every
entry author (action-bridge keeps "Action", matching its plugin.json); footer "Feito pelo mantenedor",
page title, meta description and hero line in `docs/build.mjs`; README and AGENTS intro and examples;
AGENTS §4.1 states the neutral-author rule.

Sweep: 89 hits before, 22 after. All 22 are in vendored files owned by other repos:
copilot-mobile, copilot-remote, mcp-bridge, voice-chat (`plugin.json` author), modo-auto (LICENSE,
README:11/83, package.json author, plugin.json author, selftest/memory-validator-smoke.mjs:208 path),
copilot-memory README:247. The copilot-memory and session-unloader source repos still carry the name
in their own plugin.json (1.17.0 / 0.7.0); their next sync would revert the vendored change unless the
source is fixed and its next version is above 1.17.1 / 0.7.1.

Real-environment check: runtime of the three plugins is identical to the installed copies (diff -r
without plugin.json); installed folders backed up to %LOCALAPPDATA%\copilot-plugin-backups and the
candidate plugin.json applied. A new `copilot -p` session ran canvas-sync at SessionStart, which
mirrored copilot-memory 1.17.1 to ~/.copilot/extensions (`action: update`, `guard: upgrade`). The
headless CLI does not load extensions in either version (A/B with 1.17.0 gave the same answer), so the
mirror was imported in Node with the extension's own `COPILOT_MEMORY_SMOKE` mode: 27 tools, hooks
onSessionStart and onUserPromptSubmitted, version 1.17.1, author "o mantenedor".

## Owner question: CLI registry still lists the old versions (2026-11-10)

Facts: the installed folders of canvas-sync, copilot-memory and session-unloader match origin/main
(diff -r: 0 differences; versions 0.6.1 / 1.17.1 / 0.7.1 in the installed plugin.json). The CLI plugin
list still prints 0.6.0 / 1.17.0 / 0.7.0 because the CLI keeps its own record in ~/.copilot/config.json
(`installedPlugins[].version`, `source_sha`), written only by its own install and update commands. The
Skill Manager guard refuses those commands from an agent and forbids any other path to that folder.
action-bridge stays as a direct install (`_direct`, deprecated by the CLI) for the same reason.

Impact: none on behaviour (same files); only the registry number is stale, and the next update of each
plugin rewrites it.

Options: (a) the owner runs the CLI's update-all once; (b) the owner allows the Copilot CLI plugin
installer for agents in the Skill Manager; (c) leave it until the next plugin release.
Recommendation: (a), and in the same run reinstall action-bridge from `action-bridge@copilot-marketplace`
in place of the direct install. config.json is not edited by hand: the CLI owns it and the guard covers it.
