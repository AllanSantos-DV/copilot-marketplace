// bootstrap.mjs — first-run provisioning of the standalone daemon, so installing ONLY the
// marketplace plugin is enough. On load the minimal bridge calls ensureDaemonInstalled(), which:
//   1) checks a version marker (idempotent — does nothing once installed & current);
//   2) downloads the PREBUILT daemon (code + the ~@github/copilot runtime) as a public tarball from
//      the dist repo release (no npm, no build, no token needed);
//   3) extracts it to ~/.copilot-mobile-daemon/app, registers the tray autostart, and starts the tray.
// It is detached and never blocks the agent turn; a lock file serializes concurrent session forks.
//
// The daemon's STATE (daemon.json/state.json/runtime.json) lives in the parent home dir, so
// re-installing app/ never wipes pairing or the chosen transport.
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, readdirSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { download } from "./http.mjs";

// Pinned target: bump these together with a new dist release to roll the daemon forward.
const DAEMON_VERSION = "0.1.33";
const DIST_OWNER = "AllanSantos-DV";
const DIST_REPO = "copilot-mobile-daemon-dist";
const DIST_TAG = "copilot-mobile-daemon-v0.1.33";
const DIST_ASSET = "copilot-mobile-daemon-win32-x64.tar.gz";
const DIST_URL = `https://github.com/${DIST_OWNER}/${DIST_REPO}/releases/download/${DIST_TAG}/${DIST_ASSET}`;

const HOME = process.env.COPILOT_DAEMON_HOME || join(homedir(), ".copilot-mobile-daemon");
const APP_DIR = join(HOME, "app");
const MARKER = join(APP_DIR, ".installed.json");
// Pruned files are MOVED here, not destroyed — a wrong prune is recoverable by copying back. Lives
// OUTSIDE app/ so the next prune never re-scans it (and `verifyInstall` never sees it as an install file).
const QUARANTINE = join(HOME, "_pruned");
const RUNTIME_FILE = join(HOME, "runtime.json");
const LOCK = join(HOME, "bootstrap.lock");
const LOG = join(HOME, "bootstrap.log");

function log(msg) {
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" }); } catch {}
}

function installedVersion() {
  try { return JSON.parse(readFileSync(MARKER, "utf8")).version || null; } catch { return null; }
}

// Already provisioned AND current AND the payload is really there.
function isInstalledCurrent() {
  return installedVersion() === DAEMON_VERSION
    && existsSync(join(APP_DIR, "bin", "daemon.mjs"))
    && existsSync(join(APP_DIR, "node_modules", "@github", "copilot"));
}

function trayRunning() {
  // runtime.json is published by the daemon on boot/mode-change; fresh ⇒ a daemon is live.
  try { const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8")); return !!(r && r.loopPort); } catch { return false; }
}

// Download with redirect-following (GitHub release URLs 302 to objects.githubusercontent.com),
// streaming to a .part file then atomically renaming — see the shared helper in ./http.mjs
// (redirects/.part/180s-timeout are its defaults, so the call-sites keep `download(url, dest)`).

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { windowsHide: true, ...opts });
      p.on("exit", (code) => resolve(code ?? 0));
      p.on("error", (e) => { log(`spawn ${cmd} failed: ${e?.message || e}`); resolve(-1); });
    } catch (e) { log(`spawn ${cmd} threw: ${e?.message || e}`); resolve(-1); }
  });
}

// Launch the tray detached so the daemon outlives this session (the tray supervises it).
function startTrayDetached() {
  const vbs = join(APP_DIR, "bin", "tray.vbs");
  if (!existsSync(vbs)) { log("tray.vbs missing after extract"); return; }
  try {
    const p = spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
    log("tray launched");
  } catch (e) { log("tray launch failed: " + (e?.message || e)); }
}

// Restart an already-running daemon so freshly-extracted CODE is loaded: kill the
// daemon child (its pid is in runtime.json) and let the tray's supervisor relaunch
// it (≤3s) with the new bin/src. Returns true if a running daemon was signalled.
function restartRunningDaemon() {
  try {
    const r = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    if (r && r.pid) {
      try { process.kill(r.pid); } catch (e) { log("kill daemon pid failed: " + (e?.message || e)); return false; }
      log("daemon pid " + r.pid + " killed — tray will relaunch with new code");
      return true;
    }
  } catch {}
  return false;
}

/**
 * Remove files the CURRENT dist no longer ships. `tar -x` only ADDS/overwrites — it never deletes, so
 * files dropped from the tarball (unit tests, the dev harness) survive forever in an install upgraded
 * in place, contradicting the shipped code.
 *
 * SAFEGUARDS (a deleter that runs unattended on every machine must not be a regex guess):
 *   1. ALLOW-LIST: the dist ships FILES.json (written by pack-dist). We delete only paths ABSENT from
 *      it — a file the manifest lists is NEVER touched, whatever it looks like.
 *   2. FLOOR: if FILES.json is missing, unparseable, or lists fewer than MIN_MANIFEST files, we prune
 *      NOTHING and say so. A truncated manifest must never authorize a mass delete.
 *   3. SCOPE: even among unlisted files we only remove the known non-shipping shapes (tests, dev
 *      harness, *.bak-<stamp>, a stray dist/*.tar.gz). Runtime state the daemon creates at run time
 *      (logs, runtime.json, node_modules, .git) is out of scope by construction.
 * Best-effort throughout: pruning must never block an upgrade.
 */
const MIN_MANIFEST = 50;
function pruneOrphans() {
  let shipped = null;
  try {
    const m = JSON.parse(readFileSync(join(APP_DIR, "FILES.json"), "utf8"));
    if (Array.isArray(m?.files) && m.files.length >= MIN_MANIFEST) shipped = new Set(m.files);
    else log(`prune skipped: manifest has ${m?.files?.length ?? 0} entries (< ${MIN_MANIFEST})`);
  } catch { log("prune skipped: no readable FILES.json in the bundle"); }
  if (!shipped) return; // no manifest ⇒ no deletions. Never guess.

  const nonShipping = (rel) => {
    const base = rel.split("/").pop();
    return /\.test\.mjs$/.test(base)
      || (rel.startsWith("scripts/") && (/^(validate-|probe-|poc-)/.test(base) || base === "_isolate.mjs" || base === "pack-dist.mjs"))
      || /\.bak-\d+/.test(rel)
      || (rel.startsWith("dist/") && rel.endsWith(".tar.gz"));
  };
  const removed = [];
  const walk = (dir, prefix = "", depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(join(dir, e.name), rel, depth + 1); continue; }
      if (shipped.has(rel)) continue;          // (1) the manifest wins — never delete a shipped file
      if (!nonShipping(rel)) continue;         // (3) unlisted but not a known leftover ⇒ leave it alone
      // (4) REVERSIBLE: move to a quarantine folder instead of destroying. A wrong prune is then a
      // copy-back, not a data loss. Falls back to delete only if the move itself fails.
      try {
        const dest = join(QUARANTINE, rel);
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(join(dir, e.name), dest);
        removed.push(rel);
      } catch {
        try { rmSync(join(dir, e.name), { force: true }); removed.push(rel); } catch {}
      }
    }
  };
  walk(APP_DIR);
  pruneUnrunnableScripts();
  verifyInstall(shipped);
  if (removed.length) log(`pruned ${removed.length} file(s) absent from FILES.json → quarantined in ${QUARANTINE}: ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? "…" : ""}`);
}

/** Post-install verification against the shipped manifest: every file the dist promised must be on disk.
 *  Reports LOUD (bootstrap.log) instead of silently trusting the extract. Never throws. */
function verifyInstall(shipped) {
  try {
    const missing = [];
    for (const rel of shipped) if (!existsSync(join(APP_DIR, rel))) missing.push(rel);
    if (missing.length) log(`VERIFY FAILED: ${missing.length} shipped file(s) missing after install: ${missing.slice(0, 5).join(", ")}`);
    else log(`verify ok: all ${shipped.size} shipped files present`);
  } catch {}
}

/**
 * The repo's package.json declares the whole dev harness (`validate:*`, `test:*`, …) but the dist
 * deliberately ships none of it — so an INSTALLED bundle advertised ~25 scripts that fail with
 * MODULE_NOT_FOUND. A bundle must only declare what it can actually run. Rewrite the installed
 * package.json dropping every script whose `scripts/<file>.mjs` target is absent (the repo copy is
 * untouched). Best-effort; a failure here never blocks the upgrade.
 */
function pruneUnrunnableScripts() {
  const pkgPath = join(APP_DIR, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg?.scripts) return;
    const kept = {};
    let dropped = 0;
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      // Drop a script when the file/dir it drives isn't in the bundle: a `scripts/<x>.mjs` target that
      // doesn't exist, or a test runner pointed at `test/`-style globs (unit tests are never shipped).
      const s = String(cmd);
      const m = /(?:^|\s)(scripts\/[\w.\-]+\.mjs)/.exec(s);
      const usesTests = /(^|\s)(test\/|[\w.\-/*]*\*\.test\.mjs)/.test(s) || /--test\b/.test(s);
      if ((m && !existsSync(join(APP_DIR, m[1]))) || (usesTests && !existsSync(join(APP_DIR, "test")))) { dropped++; continue; }
      kept[name] = cmd;
    }
    if (!dropped) return;
    pkg.scripts = kept;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    log(`package.json: dropped ${dropped} script(s) whose target is not shipped`);
  } catch { /* never block an upgrade over cosmetics */ }
}

async function provision() {
  mkdirSync(APP_DIR, { recursive: true });
  const tgz = join(HOME, DIST_ASSET);
  log(`downloading ${DIST_URL}`);
  await download(DIST_URL, tgz);
  log(`downloaded ${tgz}; extracting → ${APP_DIR}`);
  // Native bsdtar (Windows 10 1803+/11). Archive root = daemon contents → extract straight into app/.
  // UPGRADE-SAFE: a running daemon locks node_modules (its bundled runtime .exe). The runtime is
  // pinned and rarely changes between daemon versions, so when it's already present we extract CODE
  // ONLY (exclude node_modules) — this avoids the lock and lets upgrades apply without first stopping
  // the daemon. First install (no runtime yet) does a full extract. If a runtime bump is ever needed,
  // ship it as a fresh marker/version that lands before the daemon starts.
  const haveRuntime = existsSync(join(APP_DIR, "node_modules", "@github", "copilot"));
  const base = ["-xzf", tgz, "-C", APP_DIR];
  let code = await run("tar", haveRuntime ? [...base, "--exclude", "node_modules"] : base);
  if (code !== 0 && haveRuntime) {
    // Some tar builds want a glob form for the exclusion — retry before giving up.
    code = await run("tar", [...base, "--exclude", "node_modules/*", "--exclude", "node_modules"]);
  }
  if (code !== 0 || !existsSync(join(APP_DIR, "bin", "daemon.mjs"))) throw new Error("extract failed (tar code " + code + ")");
  try { rmSync(tgz, { force: true }); } catch {}
  pruneOrphans();
  // Register logon autostart (idempotent) so the tray comes back on every login.
  const installPs1 = join(APP_DIR, "scripts", "install-autostart.ps1");
  if (existsSync(installPs1)) {
    await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPs1]);
    log("autostart registered");
  }
  writeFileSync(MARKER, JSON.stringify({ version: DAEMON_VERSION, installedAt: Date.now() }));
  log(`marker written (v${DAEMON_VERSION})`);
  // Apply the new code: restart a running daemon (its tray relaunches it with the new
  // bin/src), and ensure a supervisor exists (startTrayDetached is a no-op if one is up).
  restartRunningDaemon();
  startTrayDetached();
}

// The owner's Copilot token is injected by the CLI into THIS process only (measured: it is not a
// user- or machine-scoped environment variable). A daemon respawned by the tray therefore has no way
// to recover it, which is exactly what orphans guest containers ("container gone and cannot be
// recreated without the owner token"). We are the process that legitimately holds it, so we hand it
// over on every load. In memory on both sides — nothing is written to disk.
function ownerCopilotToken() {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("COPILOT_GH_ACCOUNT_") && typeof v === "string" && v.length > 20) return v;
  }
  return process.env.HOST_COPILOT_TOKEN || "";
}

async function supplyHostToken() {
  const token = ownerCopilotToken();
  if (!token) return; // nothing to hand over — stay silent, the daemon just keeps asking
  let rt;
  try { rt = JSON.parse(readFileSync(RUNTIME_FILE, "utf8")); } catch { return; }
  if (!rt?.loopPort || !rt?.desktopToken) return;
  try {
    const r = await fetch(`http://127.0.0.1:${rt.loopPort}/host/token`, {
      method: "POST",
      headers: { "x-copilot-token": rt.desktopToken, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((x) => x.json());
    if (r?.healed) log(`host token supplied — re-healed ${r.healed} orphaned guest(s)`);
    else if (r?.first) log("host token supplied");
  } catch (e) { log("host token handoff failed (harmless, retries next load): " + (e?.message || e)); }
}

// Public entry. Safe to call on every load: returns fast when already provisioned. Never throws.
export async function ensureDaemonInstalled() {
  try {
    if (platform() !== "win32") { log("non-win32 platform — skipping (bundle is win32-x64)"); return; }
    if (isInstalledCurrent()) {
      if (!trayRunning()) { log("installed but tray not running — starting"); startTrayDetached(); }
      else await supplyHostToken(); // steady state: keep the daemon's owner token alive across respawns
      return;
    }
    // Serialize across concurrent session forks: first to create the lock wins; others bail.
    mkdirSync(HOME, { recursive: true });
    let fd;
    try { fd = openSync(LOCK, "wx"); } catch { log("another fork holds the bootstrap lock — skipping"); return; }
    try {
      log(`provisioning daemon v${DAEMON_VERSION} (installed=${installedVersion() || "none"})`);
      await provision();
      log("provision complete");
      // The provision just restarted the daemon (fresh process ⇒ empty owner token). Give the tray a
      // moment to relaunch it, then hand the token straight over so guests never sit orphaned.
      await new Promise((r) => setTimeout(r, 6000));
      await supplyHostToken();
    } finally {
      try { closeSync(fd); } catch {}
      try { rmSync(LOCK, { force: true }); } catch {}
    }
  } catch (e) {
    log("bootstrap error (will retry next load): " + (e?.message || e));
    try { rmSync(LOCK, { force: true }); } catch {}
  }
}
