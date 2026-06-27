// access.mjs — transport access methods: capability detection, auto-provisioning
// and (user-initiated, one-time) admin elevation. Pure Node so it can be unit-
// tested standalone with `node`, outside the Copilot host.
//
// Design rules:
//   * Detection and provisioning are ALWAYS no-admin (read-only queries +
//     downloading a single user-space exe).
//   * The only privileged action is creating/removing a Windows Firewall rule
//     for LAN, and it is ALWAYS user-initiated from the panel, runs via
//     Start-Process -Verb RunAs (one UAC), and never silently elevates.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { get as httpsGet, request as httpsRequest } from "node:https";
import { connect as tlsConnect, getCACertificates } from "node:tls";
import { tmpdir } from "node:os";

const TAILSCALE_FALLBACK = "C:\\Program Files\\Tailscale\\tailscale.exe";
const CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

// ---------- low-level helpers ----------
export function run(cmd, args, opts = {}) {
    const { timeoutMs = 6000, ...spawnOpts } = opts;
    return new Promise((resolve) => {
        let out = "", err = "", settled = false, timer = null;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(v);
        };
        let proc;
        try {
            proc = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
        } catch (e) {
            return finish({ code: -1, out: "", err: String(e?.message || e) });
        }
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                try { proc.kill(); } catch {}
                finish({ code: -1, out, err: err + `\n[run] timed out after ${timeoutMs}ms`, timedOut: true });
            }, timeoutMs);
            timer.unref?.();
        }
        proc.stdout?.on("data", (d) => (out += d.toString()));
        proc.stderr?.on("data", (d) => (err += d.toString()));
        proc.on("error", (e) => finish({ code: -1, out, err: err + String(e?.message || e) }));
        proc.on("close", (code) => finish({ code, out, err }));
    });
}

// Run a PowerShell command non-interactively (read-only queries — no admin).
export function ps(command, opts = {}) {
    return run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], opts);
}

export async function which(cmd) {
    const r = await run("where.exe", [cmd]);
    if (r.code === 0) {
        const first = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        return first || null;
    }
    return null;
}

// ---------- Tailscale ----------
export async function detectTailscale() {
    let exe = await which("tailscale");
    if (!exe && existsSync(TAILSCALE_FALLBACK)) exe = TAILSCALE_FALLBACK;
    if (!exe) return { installed: false, up: false, ip: null, dnsName: null };

    let ip = null;
    const ipr = await run(exe, ["ip", "-4"]);
    if (ipr.code === 0) {
        ip = ipr.out.split(/\r?\n/).map((s) => s.trim()).find((l) => /^100\.\d+\.\d+\.\d+$/.test(l)) || null;
    }
    let dnsName = null;
    const st = await run(exe, ["status", "--json"]);
    if (st.code === 0) {
        try {
            const j = JSON.parse(st.out);
            dnsName = (j?.Self?.DNSName || "").replace(/\.$/, "") || null;
        } catch {}
    }
    return { installed: true, up: !!ip, ip, dnsName, exe };
}

// ---------- cloudflared (auto-provisioned, no admin) ----------
export async function detectCloudflared(binDir) {
    const local = join(binDir, "cloudflared.exe");
    if (existsSync(local)) return local;
    const onPath = await which("cloudflared");
    return onPath || null;
}

function download(url, dest, log, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 6) return reject(new Error("too many redirects"));
        const req = httpsGet(url, { headers: { "User-Agent": "copilot-mobile" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(download(res.headers.location, dest, log, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error("HTTP " + res.statusCode));
            }
            const total = Number(res.headers["content-length"] || 0);
            let got = 0, lastPct = -1;
            const tmp = dest + ".part";
            const ws = createWriteStream(tmp);
            res.on("data", (c) => {
                got += c.length;
                if (total && log) {
                    const pct = Math.floor((got / total) * 100);
                    if (pct >= lastPct + 10) { lastPct = pct; log(`baixando cloudflared… ${pct}%`); }
                }
            });
            res.pipe(ws);
            ws.on("finish", () => ws.close(() => {
                try { renameSync(tmp, dest); resolve(dest); }
                catch (e) { reject(e); }
            }));
            ws.on("error", (e) => { try { unlinkSync(tmp); } catch {} reject(e); });
        });
        req.on("error", reject);
        req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    });
}

// ---------- Network / CA (restricted-network awareness, à la Voice's truststore) ----------
const PUBLIC_CA_HINTS = /DigiCert|Baltimore|GlobalSign|VeriSign|Sectigo|USERTrust|Go Daddy|Entrust|Amazon|Google Trust|GTS |ISRG|Let'?s Encrypt|Comodo|Thawte|GeoTrust|Starfield|Certum|QuoVadis|SecureTrust|Symantec|Microsoft (Azure |ECC |RSA )?(TLS|Root)|SSL\.com|Cloudflare/i;

// Build a PEM bundle from the OS trust store (Windows root store via Node 18+
// getCACertificates('system')). Written to disk so cloudflared can be pointed at
// it with --origin-ca-pool (cloudflared can't load the Windows store itself).
export function systemCaPem() {
    try {
        const certs = getCACertificates ? getCACertificates("system") : [];
        return { count: certs.length, pem: certs.join("\n") };
    } catch (e) {
        return { count: 0, pem: "", error: String(e?.message || e) };
    }
}
export function writeSystemCaPem(dir) {
    const { count, pem } = systemCaPem();
    if (!count) return null;
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "system-ca.pem");
    writeFileSync(p, pem, "utf8");
    return p;
}

// TLS-probe a public host and read the peer cert issuer. A non-public issuer
// (e.g. a corporate/self-signed root) means the network is intercepting TLS.
function probeIssuer(host, timeoutMs = 6000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        let sock;
        try {
            sock = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
                const cert = sock.getPeerCertificate(true);
                const top = (() => { let c = cert; const seen = new Set(); while (c && c.issuerCertificate && c.issuerCertificate !== c && !seen.has(c.fingerprint256)) { seen.add(c.fingerprint256); c = c.issuerCertificate; } return c; })();
                const issuerName = (top?.issuer?.O || top?.issuer?.CN || cert?.issuer?.O || cert?.issuer?.CN || "").toString();
                const intercepted = issuerName ? !PUBLIC_CA_HINTS.test(issuerName) : false;
                try { sock.end(); } catch {}
                finish({ reachable: true, issuer: issuerName, intercepted });
            });
        } catch (e) {
            return finish({ reachable: false, issuer: "", intercepted: false, error: String(e?.message || e) });
        }
        sock.on("error", (e) => finish({ reachable: false, issuer: "", intercepted: false, error: String(e?.message || e) }));
        sock.setTimeout(timeoutMs, () => { try { sock.destroy(); } catch {} finish({ reachable: false, issuer: "", intercepted: false, error: "timeout" }); });
    });
}

// One-shot network diagnostic used by the panel.
export async function detectNetwork() {
    const ca = systemCaPem();
    const [edge, dl] = await Promise.all([
        probeIssuer("www.cloudflare.com"),
        probeIssuer("github.com"),
    ]);
    const online = edge.reachable || dl.reachable;
    const intercepted = !!(edge.intercepted || dl.intercepted);
    return {
        online,
        edgeReachable: edge.reachable,
        downloadReachable: dl.reachable,
        intercepted,
        interceptionIssuer: edge.intercepted ? edge.issuer : (dl.intercepted ? dl.issuer : null),
        systemCaCount: ca.count,
        checkedAt: Date.now(),
    };
}

export async function ensureCloudflared(binDir, log = () => {}, force = false) {
    if (!force) {
        const found = await detectCloudflared(binDir);
        if (found) return found;
    }
    mkdirSync(binDir, { recursive: true });
    const dest = join(binDir, "cloudflared.exe");
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            log(`baixando cloudflared (tentativa ${attempt}/3)…`);
            await download(CLOUDFLARED_URL, dest, log);
            return dest;
        } catch (e) {
            lastErr = e;
            log(`falha no download: ${e.message}`);
            await new Promise((r) => setTimeout(r, attempt * 1500));
        }
    }
    throw new Error("não consegui baixar o cloudflared: " + (lastErr?.message || "erro"));
}

export async function detectNgrok() {
    return which("ngrok");
}

// ---------- Cloudflare WARP (conflicts with cloudflared tunnels) ----------
const WARP_FALLBACK = "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe";

async function warpExe() {
    let exe = await which("warp-cli");
    if (!exe && existsSync(WARP_FALLBACK)) exe = WARP_FALLBACK;
    return exe;
}

export async function detectWarp() {
    const exe = await warpExe();
    if (!exe) return { installed: false, connected: false, exe: null };
    const r = await run(exe, ["status"]);
    const connected = /Status update:\s*Connected|Status:\s*Connected/i.test(r.out);
    return { installed: true, connected, exe };
}

// Pause/resume WARP (no admin needed for consumer connect/disconnect).
export async function warpSet(connect) {
    const exe = await warpExe();
    if (!exe) return { ok: false, error: "warp-cli não encontrado" };
    const r = await run(exe, [connect ? "connect" : "disconnect"], { timeoutMs: 15000 });
    const ok = /Success/i.test(r.out) || r.code === 0;
    return { ok, error: ok ? null : (r.err || r.out || "falha") };
}

// ---------- Windows Firewall (read = no admin; write = one-time UAC) ----------
export async function getActiveProfiles() {
    const r = await ps("Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory");
    if (r.code !== 0) return [];
    return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export async function firewallRuleExists(displayName) {
    // Read-only query — does not require admin.
    const r = await ps(`if (Get-NetFirewallRule -DisplayName '${displayName}' -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`);
    return /YES/.test(r.out);
}

// Create a persistent inbound allow rule for a TCP port. User-initiated: shows
// ONE UAC prompt. Resolves { ok, cancelled, error }.
export async function createLanFirewallRuleElevated(displayName, port, artifactsDir, profile = "Private") {
    mkdirSync(artifactsDir, { recursive: true });
    const scriptPath = join(artifactsDir, "fw-allow.ps1");
    const script = [
        `$ErrorActionPreference = 'Stop'`,
        `if (-not (Get-NetFirewallRule -DisplayName '${displayName}' -ErrorAction SilentlyContinue)) {`,
        `  New-NetFirewallRule -DisplayName '${displayName}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile ${profile} | Out-Null`,
        `}`,
    ].join("\r\n");
    writeFileSync(scriptPath, script, "utf8");
    return elevate(scriptPath);
}

export async function removeLanFirewallRuleElevated(displayName, artifactsDir) {
    mkdirSync(artifactsDir, { recursive: true });
    const scriptPath = join(artifactsDir, "fw-remove.ps1");
    const script = [
        `$ErrorActionPreference = 'SilentlyContinue'`,
        `Get-NetFirewallRule -DisplayName '${displayName}' | Remove-NetFirewallRule`,
    ].join("\r\n");
    writeFileSync(scriptPath, script, "utf8");
    return elevate(scriptPath);
}

// Launch a hidden elevated PowerShell that runs scriptPath, waiting for it to
// finish. UAC cancellation surfaces as { ok:false, cancelled:true }.
function elevate(scriptPath) {
    const inner = `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const cmd = `try { $p = Start-Process -FilePath powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '${inner.replace(/'/g, "''")}'; exit $p.ExitCode } catch { Write-Output 'UAC_CANCELLED'; exit 1223 }`;
    return ps(cmd, { timeoutMs: 0 }).then((r) => {
        if (/UAC_CANCELLED/.test(r.out) || r.code === 1223) return { ok: false, cancelled: true };
        return { ok: r.code === 0, cancelled: false, error: r.code === 0 ? null : (r.err || `exit ${r.code}`) };
    });
}
