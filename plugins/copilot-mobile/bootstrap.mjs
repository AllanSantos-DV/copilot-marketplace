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
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, createWriteStream, renameSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { get as httpsGet } from "node:https";

// Pinned target: bump these together with a new dist release to roll the daemon forward.
const DAEMON_VERSION = "0.1.0";
const DIST_OWNER = "AllanSantos-DV";
const DIST_REPO = "copilot-mobile-daemon-dist";
const DIST_TAG = "copilot-mobile-daemon-v0.1.0";
const DIST_ASSET = "copilot-mobile-daemon-win32-x64.tar.gz";
const DIST_URL = `https://github.com/${DIST_OWNER}/${DIST_REPO}/releases/download/${DIST_TAG}/${DIST_ASSET}`;

const HOME = process.env.COPILOT_DAEMON_HOME || join(homedir(), ".copilot-mobile-daemon");
const APP_DIR = join(HOME, "app");
const MARKER = join(APP_DIR, ".installed.json");
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
// streaming to a .part file then atomically renaming. Resolves on 200, rejects otherwise.
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const req = httpsGet(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const part = dest + ".part";
      const out = createWriteStream(part);
      res.pipe(out);
      out.on("finish", () => out.close(() => { try { renameSync(part, dest); resolve(); } catch (e) { reject(e); } }));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("download timeout")));
  });
}

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

async function provision() {
  mkdirSync(APP_DIR, { recursive: true });
  const tgz = join(HOME, DIST_ASSET);
  log(`downloading ${DIST_URL}`);
  await download(DIST_URL, tgz);
  log(`downloaded ${tgz}; extracting → ${APP_DIR}`);
  // Native bsdtar (Windows 10 1803+/11). Archive root = daemon contents → extract straight into app/.
  const code = await run("tar", ["-xzf", tgz, "-C", APP_DIR]);
  if (code !== 0 || !existsSync(join(APP_DIR, "bin", "daemon.mjs"))) throw new Error("extract failed (tar code " + code + ")");
  try { rmSync(tgz, { force: true }); } catch {}
  // Register logon autostart (idempotent) so the tray comes back on every login.
  const installPs1 = join(APP_DIR, "scripts", "install-autostart.ps1");
  if (existsSync(installPs1)) {
    await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPs1]);
    log("autostart registered");
  }
  writeFileSync(MARKER, JSON.stringify({ version: DAEMON_VERSION, installedAt: Date.now() }));
  log(`marker written (v${DAEMON_VERSION})`);
  startTrayDetached();
}

// Public entry. Safe to call on every load: returns fast when already provisioned. Never throws.
export async function ensureDaemonInstalled() {
  try {
    if (platform() !== "win32") { log("non-win32 platform — skipping (bundle is win32-x64)"); return; }
    if (isInstalledCurrent()) {
      if (!trayRunning()) { log("installed but tray not running — starting"); startTrayDetached(); }
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
    } finally {
      try { closeSync(fd); } catch {}
      try { rmSync(LOCK, { force: true }); } catch {}
    }
  } catch (e) {
    log("bootstrap error (will retry next load): " + (e?.message || e));
    try { rmSync(LOCK, { force: true }); } catch {}
  }
}
