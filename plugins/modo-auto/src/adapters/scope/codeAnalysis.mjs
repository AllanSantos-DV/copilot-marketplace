// EVIDÊNCIA DETERMINÍSTICA de reúso/enxugamento (Princípio 11) — a DETECÇÃO é TOOL, não heurística. É
// LANGUAGE-AWARE: detecta a(s) linguagem(ns) do alvo e roda o TOOLCHAIN certo de cada uma (agnóstico por
// composição): jscpd (clones, qualquer linguagem) SEMPRE; Python → vulture (dead-code) + deptry (deps não
// usadas); JS/TS → depcheck (deps) + knip (dead-code). Framework DATA-DRIVEN (LANG_TOOLS) — somar linguagem é
// só acrescentar a entrada. Ferramenta/linguagem sem toolchain = DEGRADAÇÃO SINALIZADA (LLM-only), nunca crash
// nem fake. `runTool` e `languages` injetáveis → puro/testável. A evidência vira texto pra ancorar a mesa (FATOS).

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const IS_WIN = process.platform === "win32";
// Guard de segurança: só roda a ferramenta se os paths NÃO tiverem metacaracteres de shell (no Windows os bins
// são .cmd/.exe e exigem shell → validamos o path e citamos espaços; path suspeito → degrada, nunca injeta).
function shellSafe(p) { return typeof p === "string" && p.length > 0 && !/[;&|<>^"'`$\r\n()]/.test(p); }
// Captura o stdout MESMO quando a ferramenta sai com código ≠ 0 (vulture/knip/deptry saem ≠0 quando ACHAM issues).
function capStdout(fn) { try { return fn(); } catch (e) { if (e && typeof e.stdout === "string" && e.stdout.trim()) return e.stdout; throw e; } }
function runCmd(cmd, args, { cwd, timeoutMs }) {
  const opts = { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  return capStdout(() => IS_WIN
    ? execSync([cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" "), opts) // win: shell resolve .cmd/.exe/PATHEXT
    : execFileSync(cmd, args, opts));
}
const runNpx = (args, o) => runCmd("npx", ["--no-install", ...args], o); // ecossistema JS
const runBin = (bin, args, o) => runCmd(bin, args, o);                    // binário direto (ex.: python console scripts)
// Roda uma tool que ESCREVE num arquivo e sai !=0 quando ACHA issues (bandit/deptry): ignora o exit, confere o arquivo.
function runToFile(bin, args, outFile, o) { try { runBin(bin, args, o); } catch { /* exit !=0 = achou issues; resultado no arquivo */ } return existsSync(outFile); }

// Runner padrão por ferramenta. Qualquer erro (ausente/timeout/formato) → { ok:false, error } (o caller degrada).
function defaultRunTool(tool, root, { timeoutMs = 120000 } = {}) {
  try {
    if (!shellSafe(root)) return { ok: false, error: "root com caractere inseguro p/ shell (degrada)" };
    if (tool === "jscpd") {
      const outDir = mkdtempSync(join(tmpdir(), "jscpd-")); if (!shellSafe(outDir)) return { ok: false, error: "tmp inseguro" };
      runNpx(["jscpd", "--silent", "--reporters", "json", "--output", outDir, root], { cwd: root, timeoutMs });
      const rep = join(outDir, "jscpd-report.json"); if (!existsSync(rep)) return { ok: false, error: "jscpd sem report" };
      return { ok: true, data: JSON.parse(readFileSync(rep, "utf8")) };
    }
    if (tool === "depcheck") return { ok: true, data: JSON.parse(runNpx(["depcheck", root, "--json"], { cwd: root, timeoutMs })) };
    if (tool === "knip") return { ok: true, data: JSON.parse(runNpx(["knip", "--reporter", "json", "--directory", root], { cwd: root, timeoutMs })) };
    if (tool === "vulture") return { ok: true, text: runBin("python", ["-m", "vulture", root, "--min-confidence", "70"], { cwd: root, timeoutMs }) };
    if (tool === "deptry") {
      const outFile = join(mkdtempSync(join(tmpdir(), "deptry-")), "deptry.json"); if (!shellSafe(outFile)) return { ok: false, error: "tmp inseguro" };
      if (!runToFile("python", ["-m", "deptry", root, "--json-output", outFile], outFile, { cwd: root, timeoutMs })) return { ok: false, error: "deptry sem json (ausente?)" };
      return { ok: true, data: JSON.parse(readFileSync(outFile, "utf8")) };
    }
    if (tool === "bandit") {
      const outFile = join(mkdtempSync(join(tmpdir(), "bandit-")), "bandit.json"); if (!shellSafe(outFile)) return { ok: false, error: "tmp inseguro" };
      if (!runToFile("python", ["-m", "bandit", "-r", root, "-f", "json", "-o", outFile], outFile, { cwd: root, timeoutMs })) return { ok: false, error: "bandit sem json (ausente?)" };
      return { ok: true, data: JSON.parse(readFileSync(outFile, "utf8")) };
    }
    if (tool === "semgrep") return { ok: true, data: JSON.parse(runBin("semgrep", ["scan", "--config", "auto", "--json", "--quiet", "--metrics=off", root], { cwd: root, timeoutMs })) }; // console entry (NÃO `python -m semgrep`: stub sys.exit(2) desde 1.38.0)
    return { ok: false, error: "tool desconhecida: " + tool };
  } catch (e) { return { ok: false, error: (e?.message || String(e)).split("\n")[0].slice(0, 160) }; }
}

// ---- Detecção de linguagem (por extensão, walk BOUNDED, ignora deps/venv) ----
const EXT_LANG = { ".py": "python", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "ts", ".tsx": "ts", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby", ".php": "php" };
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "site-packages", "dist", "build", ".tox", "target", ".next", "vendor"]);
function detectLanguages(root, { readdir = readdirSync } = {}) {
  const found = new Set(); const stack = [root]; let budget = 6000;
  while (stack.length && budget > 0) {
    let entries; try { entries = readdir(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (budget-- <= 0) break;
      if (e.isDirectory?.()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(join(e.parentPath || e.path || root, e.name)); }
      else { const dot = e.name.lastIndexOf("."); if (dot >= 0) { const lang = EXT_LANG[e.name.slice(dot).toLowerCase()]; if (lang) found.add(lang); } }
    }
  }
  return [...found];
}

// ---- Toolchain: AGNÓSTICO (roda em qualquer linguagem) + por LINGUAGEM (data-driven). `kind` classifica a evidência. ----
const AGNOSTIC = [{ tool: "jscpd", kind: "clones" }, { tool: "semgrep", kind: "security" }];
const LANG_TOOLS = {
  python: [{ tool: "vulture", kind: "deadCode" }, { tool: "deptry", kind: "deps" }, { tool: "bandit", kind: "security" }],
  js: [{ tool: "depcheck", kind: "deps" }, { tool: "knip", kind: "deadCode" }],
  ts: [{ tool: "depcheck", kind: "deps" }, { tool: "knip", kind: "deadCode" }],
  // go/rust/java/ruby/php: detectadas mas sem toolchain configurado ainda → sinalizado (framework pronto).
};

// ---- Normalizadores por ferramenta (para uma evidência comum) ----
function normClones(data) { const dups = Array.isArray(data?.duplicates) ? data.duplicates : []; return dups.slice(0, 80).map((d) => ({ a: d.firstFile?.name || d.firstFile || "?", b: d.secondFile?.name || d.secondFile || "?", lines: d.lines || null })); }
function normDepcheck(data) { return [...(data?.dependencies || []), ...(data?.devDependencies || [])].map(String); }
function normDeptry(data) { const arr = Array.isArray(data) ? data : (Array.isArray(data?.violations) ? data.violations : []); return arr.filter((v) => /DEP00[24]/.test(v?.error?.code || v?.code || "") || /unused/i.test(v?.error?.message || "")).map((v) => String(v.module || v.dependency || v.name || "?")); }
function normVulture(text) { const out = []; for (const line of String(text || "").split(/\r?\n/)) { const m = line.match(/^(.*?):(\d+):\s*unused\s+(\w+)\s+'([^']+)'/i); if (m) out.push({ file: m[1], line: +m[2], what: `${m[3]} '${m[4]}'` }); } return out.slice(0, 80); }
function normKnip(data) { const out = []; for (const f of (data?.files || [])) out.push({ file: String(f), what: "arquivo não usado" }); for (const iss of (data?.issues || [])) for (const ex of (iss?.exports || [])) out.push({ file: String(iss.file || "?"), what: `export não usado '${ex?.name || ex}'` }); return out.slice(0, 80); }
function normSemgrep(data) { const rs = Array.isArray(data?.results) ? data.results : []; return rs.slice(0, 100).map((r) => ({ tool: "semgrep", rule: r.check_id || "?", severity: String(r.extra?.severity || "?").toUpperCase(), file: r.path || "?", line: r.start?.line || null, msg: String(r.extra?.message || r.check_id || "").replace(/\s+/g, " ").slice(0, 200) })); }
function normBandit(data) { const rs = Array.isArray(data?.results) ? data.results : []; return rs.slice(0, 100).map((r) => ({ tool: "bandit", rule: r.test_id || "?", severity: String(r.issue_severity || "?").toUpperCase(), file: r.filename || "?", line: r.line_number || null, msg: String(r.issue_text || "").replace(/\s+/g, " ").slice(0, 200) })); }
const NORM = { jscpd: (r) => ({ clones: normClones(r.data) }), depcheck: (r) => ({ unusedDeps: normDepcheck(r.data) }), deptry: (r) => ({ unusedDeps: normDeptry(r.data) }), vulture: (r) => ({ deadCode: normVulture(r.text) }), knip: (r) => ({ deadCode: normKnip(r.data) }), semgrep: (r) => ({ security: normSemgrep(r.data) }), bandit: (r) => ({ security: normBandit(r.data) }) };

/**
 * @param {{ runTool?:Function, detect?:Function, log?:(m:string)=>void }} [deps]
 */
export function createCodeAnalysis({ runTool, detect, log = () => {} } = {}) {
  const rt = runTool || defaultRunTool;
  const det = detect || detectLanguages;
  return {
    id: "code-analysis",
    languagesOf: (root) => det(root),

    /** Evidência determinística LANGUAGE-AWARE. `languages`/`kinds` filtram; ausência de tool/lang = degradado SINALIZADO. */
    async analyze(root, { languages = null, kinds = null, timeoutMs } = {}) {
      if (!root) throw new Error("codeAnalysis.analyze: root ausente");
      const langs = languages || det(root);
      const ev = { ok: true, root, languages: langs, clones: [], deadCode: [], unusedDeps: [], security: [], tools: [], degraded: [] };

      // candidatos: agnósticos + toolchain por linguagem; filtrados por `kinds` (default: todos); dedup por tool.
      let cands = [...AGNOSTIC, ...langs.flatMap((l) => LANG_TOOLS[l] || [])];
      if (Array.isArray(kinds) && kinds.length) cands = cands.filter((c) => kinds.includes(c.kind));
      const seen = new Set();
      for (const c of cands) {
        if (seen.has(c.tool)) continue; seen.add(c.tool);
        const r = await rt(c.tool, root, { timeoutMs });
        if (r && r.ok) {
          const part = NORM[c.tool] ? NORM[c.tool](r) : {};
          for (const k of ["clones", "deadCode", "unusedDeps", "security"]) if (part[k]) ev[k].push(...part[k]);
          ev.tools.push(c.tool);
        } else { ev.degraded.push(`${c.tool}: ${r?.error || "indisponível"}`); log(`[code-analysis] ${c.tool} indisponível (degradado, sinalizado): ${r?.error || ""}`); }
      }
      const semTool = langs.filter((l) => !LANG_TOOLS[l]);
      if (semTool.length) { ev.degraded.push(`linguagens sem toolchain configurado (framework pronto p/ somar): ${semTool.join(", ")}`); log(`[code-analysis] sem toolchain p/: ${semTool.join(", ")}`); }

      ev.summary = `${ev.languages.join("/") || "?"} | ${ev.clones.length} clone(s), ${ev.deadCode.length} dead-code, ${ev.unusedDeps.length} dep(s), ${ev.security.length} achado(s) de segurança — tools: ${ev.tools.join(", ") || "NENHUMA (LLM-only, sinalizado)"}`;
      return ev;
    },

    /** Renderiza a evidência p/ injetar no prompt da mesa (os agentes deliberam sobre FATOS). */
    render(ev) {
      if (!ev) return "(sem evidência de código)";
      const lines = [`EVIDÊNCIA DE CÓDIGO (${ev.summary})`];
      if (ev.clones?.length) lines.push("CLONES:\n" + ev.clones.slice(0, 15).map((c) => `- ${c.a} ≈ ${c.b}${c.lines ? ` (${c.lines} linhas)` : ""}`).join("\n"));
      if (ev.deadCode?.length) lines.push("DEAD-CODE:\n" + ev.deadCode.slice(0, 15).map((d) => `- ${d.file}${d.line ? ":" + d.line : ""} — ${d.what}`).join("\n"));
      if (ev.unusedDeps?.length) lines.push("DEPS NÃO USADAS: " + ev.unusedDeps.slice(0, 30).join(", "));
      if (ev.security?.length) lines.push("SEGURANÇA (SAST — triar falso-positivo):\n" + ev.security.slice(0, 20).map((s) => `- [${s.severity}] ${s.file}${s.line ? ":" + s.line : ""} — ${s.msg} (${s.rule})`).join("\n"));
      if (ev.degraded?.length) lines.push("DEGRADADO (completar por análise): " + ev.degraded.join("; "));
      return lines.join("\n\n");
    },
  };
}
