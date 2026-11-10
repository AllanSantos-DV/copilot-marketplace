// Gate de publicação do copilot-marketplace.
//
// Garante que nenhum plugin seja publicado (push para este repo) sem a sua PÁGINA
// dedicada revisada. O "revisado" é um marcador determinístico em `docs/.reviewed.json`
// que casa a versão do plugin + um hash do (plugin.json + docs/content/<nome>.json).
// Quando o agente (publisher/vitrine) desenha a página, ele grava esse marcador — e é
// isso que o hook de pre-push confere para liberar (ou bloquear) o push.
// Também confere o contrato de cada plugin vendado (manifesto = plugin.json; `hooks` aponta para
// arquivo que existe) e, no pre-push, que runtime alterado veio com versão nova.
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

// Limite HARD do schema do marketplace do Copilot CLI: cada `description` tem no
// máximo 1024 chars. Estourar NÃO falha na origem — falha lá na frente, no
// `copilot plugin update`, e derruba a leitura do marketplace inteiro (TODOS os
// plugins param de atualizar). Por isso o gate recusa cedo, no push, apontando o
// plugin culpado. (A description é semântica — o que aquela versão entrega — não um
// changelog; ver AGENTS.md §4.1.)
const DESC_MAX = 1024;

function descriptionOverflows(manifestText) {
  let plugins;
  try {
    plugins = JSON.parse(manifestText ?? "").plugins;
  } catch {
    return []; // manifesto inválido é outro problema; aqui só medimos tamanho
  }
  if (!Array.isArray(plugins)) return [];
  const bad = [];
  for (const p of plugins) {
    const len = String(p?.description ?? "").length;
    if (len > DESC_MAX) {
      bad.push(`${p?.name ?? "?"}: description ${len} chars > ${DESC_MAX} (limite do marketplace.json; encurte — é semântica, não changelog)`);
    }
  }
  return bad;
}

/**
 * Divergências conhecidas entre a entrada do manifesto e o `plugin.json` vendado, por plugin e
 * campo, com o motivo. A correção é no repo de origem; quando ela chega, o check pede para tirar a
 * entrada daqui, para a lista nunca esconder uma divergência nova.
 */
const KNOWN_MANIFEST_DIVERGENCES = {
  "copilot-mobile": { description: "o repo de origem (copilot-mobile) ainda publica a description antiga no plugin.json" },
};

/**
 * Plugins cujo `plugin.json` ainda aponta `hooks` para o arquivo que a migração para o neural-link
 * apagou. O campo morto sai no repo de origem de cada um; o check pede para tirar a entrada daqui
 * quando isso acontecer.
 */
const KNOWN_DANGLING_HOOKS = {
  "action-bridge": "repo de origem: Action (integrations/copilot-extension)",
  "copilot-mobile": "repo de origem: copilot-mobile",
  "session-unloader": "repo de origem: session-unloader",
  "visual-explainer": "repo de origem: visual-explainer",
};

const CONTRACT_FIELDS = ["name", "version", "description"];

/**
 * Confere o contrato do plugin vendado: manifesto e `plugin.json` dizem o mesmo nome, versão e
 * description, e o `hooks` declarado aponta para um arquivo que existe.
 * @param {string} name nome do plugin.
 * @param {object|undefined} entry entrada do manifesto.
 * @param {string|null} pluginJsonText conteúdo de `plugins/<name>/plugin.json`.
 * @param {(rel: string) => boolean} exists diz se um caminho relativo à raiz existe.
 * @returns {string[]} falhas encontradas.
 */
function contractFails(name, entry, pluginJsonText, exists) {
  let plugin;
  try {
    plugin = JSON.parse(pluginJsonText ?? "");
  } catch {
    return [`${name}: plugins/${name}/plugin.json ausente ou inválido`];
  }
  const fails = [];
  const allowed = KNOWN_MANIFEST_DIVERGENCES[name] ?? {};
  for (const field of CONTRACT_FIELDS) {
    const differs = plugin[field] !== entry?.[field];
    if (differs && !allowed[field]) fails.push(`${name}: ${field} do manifesto ≠ plugins/${name}/plugin.json — alinhe os dois`);
    if (!differs && allowed[field]) fails.push(`${name}: ${field} já bate com o plugin.json — tire a exceção de KNOWN_MANIFEST_DIVERGENCES (docs/gate.mjs)`);
  }
  const dangling = typeof plugin.hooks === "string" && !exists(`plugins/${name}/${plugin.hooks}`);
  if (dangling && !KNOWN_DANGLING_HOOKS[name]) fails.push(`${name}: plugin.json aponta hooks para ${plugin.hooks}, que não existe — remova o campo ou vende o arquivo`);
  if (!dangling && KNOWN_DANGLING_HOOKS[name]) fails.push(`${name}: hooks não está mais quebrado — tire a exceção de KNOWN_DANGLING_HOOKS (docs/gate.mjs)`);
  return fails;
}

/**
 * Compara versões x.y.z numericamente.
 * @returns {number} negativo se a < b, zero se iguais, positivo se a > b.
 */
function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Plugins cujo runtime (`plugins/<nome>/`) mudou no range sem subir a versão. O
 * `copilot plugin update` só entrega quando a versão sobe, então a mudança não chegaria a ninguém.
 * Plugin novo ou removido no range não tem versão anterior para comparar.
 */
function unbumpedFails(base, tip) {
  let files;
  try {
    files = git(["diff", "--name-only", base, tip]);
  } catch {
    return [];
  }
  const names = new Set();
  for (const line of files.split(/\r?\n/)) {
    const m = line.trim().match(/^plugins\/([^/]+)\//);
    if (m) names.add(m[1]);
  }
  const fails = [];
  for (const name of names) {
    const before = versionOf(gitShow(base, `plugins/${name}/plugin.json`));
    const after = versionOf(gitShow(tip, `plugins/${name}/plugin.json`));
    if (before == null || after == null) continue;
    if (cmpVersion(after, before) <= 0) fails.push(`${name}: plugins/${name}/ mudou sem subir a versão (v${before} → v${after}) — o copilot plugin update só entrega versão nova`);
  }
  return fails;
}

function gitHas(rev, path) {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}:${path}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Acima disto a description já foge da faixa que cabe num card (AGENTS.md §4.1) e chega perto do
// limite duro; o aviso dá margem antes de o gate recusar.
const DESC_WARN = 600;

function descriptionWarnings(manifestText) {
  let plugins;
  try {
    plugins = JSON.parse(manifestText ?? "").plugins;
  } catch {
    return [];
  }
  return (Array.isArray(plugins) ? plugins : [])
    .filter((p) => {
      const len = String(p?.description ?? "").length;
      return len > DESC_WARN && len <= DESC_MAX;
    })
    .map((p) => `${p.name}: description com ${String(p.description).length} chars (> ${DESC_WARN}; o limite é ${DESC_MAX}) — encurte enquanto há margem`);
}

function versionOf(pluginJsonText) {
  try {
    return JSON.parse(pluginJsonText).version ?? null;
  } catch {
    return null;
  }
}

// Hash curto e estável do estado "publicável" de um plugin: plugin.json + a página.
// Normaliza CRLF->LF para que o hash bata entre o disco (working tree, pode ser CRLF no
// Windows) e o blob do git (guardado como LF por autocrlf/.gitattributes) — senão `mark`
// (disco) e `prepush` (git show) discordariam e o push seria bloqueado por engano.
function reviewHash(pluginJsonText, contentJsonText) {
  const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n");
  return createHash("sha256")
    .update(norm(pluginJsonText))
    .update("\0")
    .update(norm(contentJsonText))
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
/**
 * Bootstrap divergente entre plugins. Cinco plugins carregam o MESMO `boot.mjs`; sem esta trava,
 * uma correção chega em quatro e esquece o quinto — e ninguém percebe até quebrar na máquina de
 * alguém. Fonte canônica e regras de exceção vivem em `tools/sync-boot.mjs`.
 */
function bootstrapFails() {
  const tool = join(ROOT, "tools", "sync-boot.mjs");
  if (!existsSync(tool)) return [];
  try {
    execFileSync(process.execPath, [tool], { encoding: "utf8", stdio: "pipe" });
    return [];
  } catch (err) {
    const out = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
    const linhas = out.split("\n").filter((l) => l.includes("DIVERGE"));
    if (linhas.length) return linhas.map((l) => `bootstrap: ${l.trim()} — rode: node tools/sync-boot.mjs --fix`);
    const motivo = out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | ") || (err?.message ?? "sem saída");
    return [`bootstrap: tools/sync-boot.mjs falhou sem apontar divergência — ${motivo}`];
  }
}

/**
 * A vitrine gerada (página dedicada, card do `index.html`, linha da tabela do README e
 * `catalog.json`) mostra a versão e a descrição do manifesto? Só versão/description são comparadas:
 * o HTML inteiro varia por fim de linha no Windows. Um sync que pulou `node docs/build.mjs` deixa
 * essas saídas velhas.
 * @param {string} name nome do plugin.
 * @param {string} version versão do `plugin.json`.
 * @param {(rel: string) => string|null} read lê um arquivo relativo à raiz (disco ou commit).
 * @returns {string[]} falhas encontradas.
 */
function staleShowcase(name, version, read) {
  const fails = [];
  const rebuild = `rode node docs/build.mjs`;
  const page = read(`docs/p/${name}/index.html`);
  if (page != null && version && !page.includes(`>v${version}<`)) fails.push(`${name}: docs/p/${name}/ desatualizada — ${rebuild}`);
  const index = read("docs/index.html");
  if (index != null) {
    const start = index.indexOf(`id="p-${name}"`);
    const card = start === -1 ? "" : index.slice(start, index.indexOf("</article>", start));
    if (!card.includes(`>v${version}<`)) fails.push(`${name}: docs/index.html não mostra v${version} — ${rebuild}`);
  }
  const readme = read("README.md");
  if (readme != null && readme.includes("<!-- plugins:start -->")) {
    const row = readme.split(/\r?\n/).find((l) => l.includes(`](./plugins/${name})`)) ?? "";
    let entry;
    try {
      entry = JSON.parse(read(".github/plugin/marketplace.json") ?? "").plugins.find((p) => p.name === name);
    } catch {}
    const desc = String(entry?.description ?? "").replaceAll("|", "\\|");
    if (!row.endsWith(` | ${version} |`)) fails.push(`${name}: README sem v${version} na tabela — ${rebuild}`);
    else if (!row.includes(` | ${desc} | `)) fails.push(`${name}: README com description velha — ${rebuild}`);
  }
  const catalog = read("docs/catalog.json");
  if (catalog != null) {
    let entry;
    try {
      entry = JSON.parse(catalog).plugins.find((p) => p.name === name);
    } catch {}
    if (entry?.version !== version) fails.push(`${name}: docs/catalog.json não mostra v${version} — ${rebuild}`);
  }
  return fails;
}

/**
 * Entrada de um plugin no manifesto.
 * @param {string} name nome do plugin.
 * @returns {object|undefined} a entrada, ou undefined se o manifesto falta, é inválido ou não a tem.
 */
function manifestPlugin(name) {
  try {
    return JSON.parse(readText(MANIFEST) ?? "").plugins.find((p) => p.name === name);
  } catch {
    return undefined;
  }
}

function cmdCheck() {
  const names = manifestNames(readText(MANIFEST) ?? "");
  const marker = loadMarkerFrom(readText(MARKER));
  const fails = [];
  // Trava de tamanho de description (protege a vitrine inteira, não um plugin só).
  for (const f of descriptionOverflows(readText(MANIFEST))) fails.push(f);
  for (const f of bootstrapFails()) fails.push(f);
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
    for (const f of contractFails(name, manifestPlugin(name), pj, (rel) => existsSync(join(ROOT, rel)))) fails.push(f);
    const version = versionOf(pj);
    const m = marker[name];
    if (!m) fails.push(`${name}: sem marcador de revisado (rode: node docs/gate.mjs mark ${name})`);
    else if (m.version !== version) fails.push(`${name}: marcador v${m.version} ≠ plugin.json v${version} — re-revise`);
    else if (m.hash !== reviewHash(pj, cj)) fails.push(`${name}: página mudou desde a última revisão — re-revise`);
    for (const f of staleShowcase(name, version, (rel) => readText(join(ROOT, rel)))) fails.push(f);
  }
  if (fails.length) {
    console.error("gate: NÃO revisado:\n  - " + fails.join("\n  - "));
    process.exit(1);
  }
  for (const w of descriptionWarnings(readText(MANIFEST))) console.log(`gate: aviso — ${w}`);
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
  // Plugin REMOVIDO não tem o que revisar. `touchedPlugins` coleta o nome a partir dos
  // arquivos tocados, e um arquivo APAGADO também é um arquivo tocado — então tirar um
  // plugin da vitrine caía aqui pedindo a página de conteúdo de quem deixou de existir.
  // Nessa forma, remoção era impossível: o gate cobrava para sempre um artefato que o
  // próprio commit removeu. A fonte da verdade de "está publicado" é o manifesto no tip.
  if (!manifestNames(gitShow(tip, ".github/plugin/marketplace.json") ?? "").includes(name)) {
    return null;
  }

  const pj = gitShow(tip, `plugins/${name}/plugin.json`);
  const cj = gitShow(tip, `docs/content/${name}.json`);
  const marker = loadMarkerFrom(gitShow(tip, "docs/.reviewed.json"));
  if (!cj) return `${name}: falta docs/content/${name}.json (página não desenhada)`;
  let entry;
  try {
    entry = JSON.parse(gitShow(tip, ".github/plugin/marketplace.json") ?? "").plugins.find((p) => p.name === name);
  } catch {}
  const contract = contractFails(name, entry, pj, (rel) => gitHas(tip, rel));
  if (contract.length) return contract.join("; ");
  const stale = staleShowcase(name, versionOf(pj), (rel) => gitShow(tip, rel));
  if (stale.length) return stale.join("; ");
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
    "  Um ou mais plugins não passaram no gate de publicação:",
    ...fails.map((f) => `    • ${f}`),
    "",
    "  Página não revisada → acione o agente que desenha a página:",
    "    publisher   (publica: vender/versão + delega o design ao vitrine)",
    "    vitrine     (só desenha docs/content/<nome>.json com frontend-design)",
    "    depois: node docs/gate.mjs mark <nome>  e commit — aí libera.",
    "",
    "  Runtime mudou sem bump → suba a version no plugin.json e no manifesto.",
    "  Manifesto ≠ plugin.json → alinhe name/version/description nos dois.",
    "",
    "  Description longa → encurte no .github/plugin/marketplace.json (máx 1024).",
    "    A description é semântica (o que ESSA versão entrega), não um changelog.",
    "",
    "  Verifique com:  node docs/gate.mjs check",
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
  const bumpFails = [];
  let unknownRange = false;
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleção de ref
    if ((remoteRef ?? "").startsWith("refs/tags/")) continue; // tags: fora do gate
    const base = remoteSha && !ZERO.test(remoteSha) ? remoteSha : originMain;
    if (base) for (const f of unbumpedFails(base, localSha)) bumpFails.push(f);
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
  const fails = [...bumpFails];
  for (const item of toVerify) {
    const [name, tip] = item.split("\u0000");
    const f = verifyAtRev(name, tip);
    if (f) fails.push(f);
  }
  // Trava de description: valida o manifesto em cada tip empurrado (um estouro >1024
  // travaria o `plugin update` de TODOS os plugins, não só o alterado).
  const tips = new Set();
  for (const line of lines) {
    const [, localSha, remoteRef] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue;
    if ((remoteRef ?? "").startsWith("refs/tags/")) continue;
    tips.add(localSha);
  }
  for (const tip of tips) {
    for (const f of descriptionOverflows(gitShow(tip, ".github/plugin/marketplace.json"))) fails.push(f);
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
