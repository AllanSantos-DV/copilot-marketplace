// voice-python.mjs — descoberta do interpretador Python (independente do PATH). Auto-contido: as
// funções recebem/retornam listas de candidatos e fazem só I/O de descoberta (registry via py.exe,
// dirs comuns, where.exe, cache). NÃO reatribui estado do worker (pyIndex/activePy vivem no worker).
// "spawn python ENOENT" quebrava o motor quando o app subia sem Python no PATH; aqui preferimos um
// interpretador cacheado e caminhos ABSOLUTOS (py launcher/registry + dirs comuns), caindo em nomes
// crus do PATH só como último recurso. O que chega a "ready" é cacheado p/ starts futuros.

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import shared from "./voice-shared.cjs";

const PYTHON_CACHE_FILE = join(shared.resolveDataDir(), "python-path.json");

export function readPythonCache() {
    try {
        const p = JSON.parse(readFileSync(PYTHON_CACHE_FILE, "utf8"));
        const path = p && typeof p.path === "string" ? p.path : "";
        if (!path) return "";
        if (/[\\/]/.test(path) && !existsSync(path)) return ""; // cached interpreter was removed
        return path;
    } catch { return ""; }
}
export function savePythonPath(p) {
    try { if (p && /[\\/]/.test(p)) writeFileSync(PYTHON_CACHE_FILE, JSON.stringify({ path: p })); } catch { }
}
export function whichPython(name) {
    try {
        const whereExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
        const bin = existsSync(whereExe) ? whereExe : "where";
        const r = spawnSync(bin, [name], { encoding: "utf8", windowsHide: true });
        if (r && r.status === 0 && r.stdout) {
            return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
    } catch { }
    return [];
}
export function pyLauncherPaths() {
    // The py launcher lives at a fixed path and lists interpreters from the
    // registry (PEP 514) — it works even when PATH has no Python at all.
    try {
        const pyExe = join(process.env.SystemRoot || "C:\\Windows", "py.exe");
        const bin = existsSync(pyExe) ? pyExe : "py";
        const r = spawnSync(bin, ["-0p"], { encoding: "utf8", windowsHide: true });
        if (r && r.status === 0 && r.stdout) {
            const out = [];
            for (const line of r.stdout.split(/\r?\n/)) {
                const m = line.match(/([A-Za-z]:\\[^\r\n*]*python\.exe)\s*$/i);
                if (m) out.push(m[1].trim());
            }
            return out;
        }
    } catch { }
    return [];
}
export function commonPythonDirs() {
    const out = [];
    try {
        for (const n of readdirSync("C:\\")) {
            if (/^Python\d+$/i.test(n)) out.push(join("C:\\", n, "python.exe"));
        }
    } catch { }
    try {
        const base = join(process.env.LOCALAPPDATA || "", "Programs", "Python");
        for (const n of readdirSync(base)) out.push(join(base, n, "python.exe"));
    } catch { }
    try {
        const pyExe = join(process.env.SystemRoot || "C:\\Windows", "py.exe");
        if (existsSync(pyExe)) out.push(pyExe);
    } catch { }
    return out.filter((p) => { try { return existsSync(p); } catch { return false; } });
}
// PURE ordering/dedup — the piece worth locking with a test (no I/O here).
export function orderPythonCandidates(sources) {
    const raw = [
        sources.override,
        sources.cached,
        ...(sources.launcher || []),   // registry-based, PATH-independent
        ...(sources.common || []),     // filesystem, PATH-independent
        ...(sources.where || []),      // PATH-based
        ...(sources.bare || []),       // last-resort bare names
    ].filter((s) => typeof s === "string" && s.trim());
    const seen = new Set();
    const out = [];
    for (const c of raw) {
        const v = c.trim();
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}
export function buildPythonCandidates() {
    const bare = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
    if (process.platform !== "win32") {
        return orderPythonCandidates({ override: process.env.VOICE_PYTHON, cached: readPythonCache(), bare });
    }
    return orderPythonCandidates({
        override: process.env.VOICE_PYTHON,
        cached: readPythonCache(),
        launcher: pyLauncherPaths(),
        common: commonPythonDirs(),
        where: whichPython("python").concat(whichPython("python3")),
        bare,
    });
}
