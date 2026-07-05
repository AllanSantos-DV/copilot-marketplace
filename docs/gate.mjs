// Gate de publicação do copilot-marketplace.
//
// Garante que nenhum plugin seja publicado (push para este repo) sem a sua PÁGINA
// dedicada revisada. O "revisado" é um marcador determinístico em `docs/.reviewed.json`
// que casa a versão do plugin + um hash do (plugin.json + docs/content/<nome>.json).
// Quando o agente (publisher/vitrine) desenha a página, ele grava esse marcador — e é
// isso que o hook de pre-push confere para liberar (ou bloquear) o push.
//
// Modos:
//   node docs/gate.mjs check                 -> valida a working tree (humano/self-check)
//   node docs/gate.mjs mark <nome|--all>     -> grava o marcador "revisado" (o agente usa)
//   node docs/gate.mjs prepush <remoteUrl>   -> lê stdin (linhas do pre-push) e bloqueia
//                                               o push se um plugin foi tocado sem revisão
//
// Node puro, sem dependências. Fiel à filosofia do repo (sem GitHub Actions).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // docs/
const ROOT = join(HERE, "..");
const MANIFEST = join(ROOT, ".github", "plugin", "marketplace.json");
const CONTENT = join(HERE, "content");
const PLUGINS = join(ROOT, "plugins");
const MARKER = join(HERE, ".reviewed.json");

// Só age quando o remote é ESTE repositório (ou um fork com o mesmo caminho).
const TARGET = "allansantos-dv/copilot-marketplace";

const ZERO = /^0+$/;

// ---------- helpers ----------
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function gitShow(rev, path) {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function manifestNames(text) {
  try {
    const j = JSON.parse(text);
    return (Array.isArray(j.plugins) ? j.plugins : []).map((p) => p.name).filter(Boolean);
  } catch {
    return [];
  }
}

function versionOf(pluginJsonText) {
  try {
    return JSON.parse(pluginJsonText).version ?? null;
  } catch {
    return null;
  }
}

// Hash curto e estável do estado "publicável" de um plugin: plugin.json + a página.
function reviewHash(pluginJsonText, contentJsonText) {
  return createHash("sha256")
    .update(pluginJsonText ?? "")
    .update("\0")
    .update(contentJsonText ?? "")
    .digest("hex")
    .slice(0, 16);
}

function isTarget(url) {
  return String(url ?? "")
    .toLowerCase()
    .replace(/\.git$/, "")
    .includes(TARGET);
}

function loadMarkerFrom(text) {
  try {
    return JSON.parse(text ?? "") ?? {};
  } catch {
    return {};
  }
}

// ---------- mode: mark ----------
function markOne(name, marker) {
  const pj = readText(join(PLUGINS, name, "plugin.json"));
  const cj = readText(join(CONTENT, `${name}.json`));
  if (!pj) {
    console.error(`gate: mark ${name}: plugins/${name}/plugin.json não existe`);
    return false;
  }
  if (!cj) {
    console.error(`gate: mark ${name}: docs/content/${name}.json não existe — desenhe a página antes de marcar`);
    return false;
  }
  marker[name] = { version: versionOf(pj), hash: reviewHash(pj, cj), at: new Date().toISOString() };
  return true;
}

function cmdMark(arg) {
  const marker = loadMarkerFrom(readText(MARKER));
  let names;
  if (arg === "--all") {
    names = manifestNames(readText(MANIFEST) ?? "");
  } else if (arg) {
    names = [arg];
  } else {
    console.error("uso: node docs/gate.mjs mark <nome|--all>");
    process.exit(2);
  }
  let ok = true;
  for (const n of names) ok = markOne(n, marker) && ok;
  // Poda marcadores de plugins que não existem mais no manifesto.
  const live = new Set(manifestNames(readText(MANIFEST) ?? ""));
  for (const k of Object.keys(marker)) if (!live.has(k)) delete marker[k];
  const ordered = Object.fromEntries(Object.keys(marker).sort().map((k) => [k, marker[k]]));
  writeFileSync(MARKER, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  console.log(`gate: marcado revisado -> ${names.join(", ")}`);
  process.exit(ok ? 0 : 1);
}

// ---------- mode: check (working tree) ----------
function cmdCheck() {
  const names = manifestNames(readText(MANIFEST) ?? "");
  const marker = loadMarkerFrom(readText(MARKER));
  const fails = [];
  for (const name of names) {
    const pj = readText(join(PLUGINS, name, "plugin.json"));
    const cj = readText(join(CONTENT, `${name}.json`));
    if (!cj) {
      fails.push(`${name}: falta docs/content/${name}.json (página não desenhada)`);
      continue;
    }
    try {
      JSON.parse(cj);
    } catch {
      fails.push(`${name}: docs/content/${name}.json não é JSON válido`);
      continue;
    }
    const version = versionOf(pj);
    const m = marker[name];
    if (!m) fails.push(`${name}: sem marcador de revisado (rode: node docs/gate.mjs mark ${name})`);
    else if (m.version !== version) fails.push(`${name}: marcador v${m.version} ≠ plugin.json v${version} — re-revise`);
    else if (m.hash !== reviewHash(pj, cj)) fails.push(`${name}: página mudou desde a última revisão — re-revise`);
    // página gerada em sincronia com a versão?
    const page = readText(join(HERE, "p", name, "index.html"));
    if (page && version && !page.includes(`v${version}`)) fails.push(`${name}: docs/p/${name}/ desatualizada — rode node docs/build.mjs`);
  }
  if (fails.length) {
    console.error("gate: NÃO revisado:\n  - " + fails.join("\n  - "));
    process.exit(1);
  }
  console.log(`gate: ok — ${names.length} plugin(s) revisado(s) e em sincronia`);
  process.exit(0);
}

// ---------- mode: prepush ----------
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Plugins tocados no range base..tip (via git). Regras:
//  - plugins/<nome>/...                 -> <nome>
//  - docs/content/<nome>.json           -> <nome>
//  - .github/plugin/marketplace.json    -> todos os plugins do manifesto (no tip)
function touchedPlugins(base, tip) {
  let files;
  try {
    files = git(base ? ["diff", "--name-only", `${base}`, `${tip}`] : ["show", "--name-only", "--pretty=format:", `${tip}`]);
  } catch {
    files = null;
  }
  if (files == null) return null; // desconhecido -> chamador decide (fail-safe)
  const set = new Set();
  let manifestChanged = false;
  for (const line of files.split(/\r?\n/)) {
    const f = line.trim();
    if (!f) continue;
    let m;
    if ((m = f.match(/^plugins\/([^/]+)\//))) set.add(m[1]);
    else if ((m = f.match(/^docs\/content\/([^/]+)\.json$/))) set.add(m[1]);
    else if (f === ".github/plugin/marketplace.json") manifestChanged = true;
  }
  if (manifestChanged) for (const n of manifestNames(gitShow(tip, ".github/plugin/marketplace.json") ?? "")) set.add(n);
  return set;
}

function verifyAtRev(name, tip) {
  const pj = gitShow(tip, `plugins/${name}/plugin.json`);
  const cj = gitShow(tip, `docs/content/${name}.json`);
  const marker = loadMarkerFrom(gitShow(tip, "docs/.reviewed.json"));
  if (!cj) return `${name}: falta docs/content/${name}.json (página não desenhada)`;
  const version = versionOf(pj);
  const m = marker[name];
  if (!m) return `${name}: sem marcador de revisado`;
  if (m.version !== version) return `${name}: marcador v${m.version} ≠ plugin.json v${version}`;
  if (m.hash !== reviewHash(pj, cj)) return `${name}: página mudou desde a última revisão`;
  return null;
}

function blockMessage(fails) {
  return [
    "",
    "  ╭──────────────────────────────────────────────────────────────╮",
    "  │  PUSH BLOQUEADO · copilot-marketplace                          │",
    "  ╰──────────────────────────────────────────────────────────────╯",
    "  Um ou mais plugins foram alterados sem a página dedicada revisada:",
    ...fails.map((f) => `    • ${f}`),
    "",
    "  Acione o agente que desenha a página (ele grava o marcador):",
    "    publisher   (publica: vender/versão + delega o design ao vitrine)",
    "    vitrine     (só desenha docs/content/<nome>.json com frontend-design)",
    "",
    "  Depois de desenhar, o agente roda:  node docs/gate.mjs mark <nome>",
    "  e faz o commit — aí o push é liberado. Verifique com:",
    "    node docs/gate.mjs check",
    "",
  ].join("\n");
}

function cmdPrepush(url) {
  // Fora do repo alvo: nunca interfere.
  if (!isTarget(url)) process.exit(0);
  let originMain = null;
  try {
    originMain = git(["rev-parse", "origin/main"]).trim();
  } catch {}
  const lines = readStdin().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const toVerify = new Set();
  let unknownRange = false;
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleção de ref
    if ((remoteRef ?? "").startsWith("refs/tags/")) continue; // tags: fora do gate
    const base = remoteSha && !ZERO.test(remoteSha) ? remoteSha : originMain;
    const touched = touchedPlugins(base, localSha);
    if (touched == null) {
      unknownRange = true;
      continue;
    }
    for (const n of touched) toVerify.add(`${n}\u0000${localSha}`);
  }
  // Range indeterminado tocando o alvo: seja estrito e verifique tudo no tip mais novo.
  if (unknownRange && lines.length) {
    const tip = lines[0].split(/\s+/)[1];
    for (const n of manifestNames(gitShow(tip, ".github/plugin/marketplace.json") ?? readText(MANIFEST) ?? "")) toVerify.add(`${n}\u0000${tip}`);
  }
  const fails = [];
  for (const item of toVerify) {
    const [name, tip] = item.split("\u0000");
    const f = verifyAtRev(name, tip);
    if (f) fails.push(f);
  }
  if (fails.length) {
    process.stderr.write(blockMessage([...new Set(fails)]) + "\n");
    process.exit(1);
  }
  process.exit(0);
}

// ---------- dispatch ----------
const mode = process.argv[2];
try {
  if (mode === "check") cmdCheck();
  else if (mode === "mark") cmdMark(process.argv[3]);
  else if (mode === "prepush") cmdPrepush(process.argv[3]);
  else {
    console.error("uso: node docs/gate.mjs <check|mark|prepush> [arg]");
    process.exit(2);
  }
} catch (err) {
  // Erro inesperado de infra no modo prepush: NÃO trava o push (fail-open) — a garantia
  // principal continua sendo o fluxo do agente. Nos modos manuais, propaga o erro.
  if (mode === "prepush") {
    process.stderr.write(`gate: aviso — verificação pulada (${err?.message ?? err}); push liberado.\n`);
    process.exit(0);
  }
  throw err;
}
