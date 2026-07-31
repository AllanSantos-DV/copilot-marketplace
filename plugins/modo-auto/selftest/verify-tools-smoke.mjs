// verify-tools-smoke.mjs — DETERMINÍSTICO (usa git/fs do PRÓPRIO repo, ZERO LLM/rede): prova que as tools
// read-only do shadow-verifier confirmam a realidade. É o que tira a cegueira do sombra. Roda contra o repo real.
import { tmpDir } from "./tmpProjeto.mjs";
import assert from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { verifyTools, VERIFY_TOOL_NAMES, resolveRepoRoot } from "../src/adapters/shadow/verifyTools.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), ".."); // raiz do modo-auto
const tool = (name) => verifyTools.find((t) => t.name === name).handler;
const J = (h, a) => JSON.parse(h(a));
let pass = 0; const ok = (m) => { console.log("  ok -", m); pass++; };
const skip = (m) => { console.log("  skip -", m); pass++; }; // SKIP sinalizado conta como ok (contexto inválido, não falha)
// As asserções de HISTÓRICO git (tracked/log) só valem no repo DEV COMMITADO. Rodado de um clone-FANTASMA
// (ex.: o mirror do canvas-sync: tem .git mas ZERO commits) ou fora de repo, elas não se aplicam → SKIP sinalizado.
const git = (args) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_PARAMETERS: "" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
function hasCommits(repo) { try { return (parseInt(git(["-C", repo, "rev-list", "--count", "HEAD"]), 10) || 0) > 0; } catch { return false; } }
// O git SOBE na árvore de diretórios: perguntar "tem commits?" de dentro de uma pasta ANINHADA em outro repo
// responde pelo repo DE CIMA. É exatamente o caso do artefato instalado — `installed-plugins/_direct/...` mora
// dentro de `~/.copilot`, que É um repo git (36 commits) onde o modo-auto entra como arquivo NÃO-versionado.
// Sem esta checagem, o teste se achava "no repo dev" e exigia que findingsTracker.mjs fosse tracked... no repo
// errado. Por isso a raiz precisa ser CONFIRMADA: só é repo dev se o toplevel for ESTE diretório.
function isRepoRoot(repo) {
  try { return git(["-C", repo, "rev-parse", "--show-toplevel"]).replace(/\\/g, "/").toLowerCase() === repo.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
  catch { return false; }
}
const DEV_REPO = isRepoRoot(REPO) && hasCommits(REPO);

// path_exists
{
  const y = J(tool("path_exists"), { repo: REPO, relpath: "package.json" });
  const n = J(tool("path_exists"), { repo: REPO, relpath: "zzz-nao-existe-123.txt" });
  assert.ok(y.exists === true && y.kind === "file", "package.json existe (file): " + JSON.stringify(y));
  assert.strictEqual(n.exists, false, "arquivo falso não existe");
  ok("path_exists: confirma existência real (package.json true, falso false)");
}
// git_tracked (só no repo dev COMMITADO — no mirror-fantasma/non-repo os arquivos não estão tracked por CONTEXTO)
if (!DEV_REPO) {
  skip("git_tracked: fora do repo dev commitado (ex.: mirror com .git fantasma / non-repo) — assert de arquivo tracked não se aplica");
} else {
  const y = J(tool("git_tracked"), { repo: REPO, relpath: "src/adapters/shadow/findingsTracker.mjs" });
  const n = J(tool("git_tracked"), { repo: REPO, relpath: "zzz-nao-existe-123.txt" });
  assert.strictEqual(y.tracked, true, "findingsTracker.mjs é tracked (foi commitado)");
  assert.strictEqual(n.tracked, false, "arquivo falso não é tracked");
  ok("git_tracked: prova que um arquivo foi versionado (refuta 'untracked' falso)");
}
// git_grep (--untracked: vê o working tree). O padrão "ausente" é MONTADO em runtime p/ não existir em NENHUM
// arquivo — inclusive este teste (senão o próprio git_grep --untracked acharia o literal aqui).
// A INVARIANTE não é "repo dev × resto" (isso era binário demais e quebrou num 3º caso legítimo: o artefato
// vendado DENTRO da vitrine, onde ele É rastreado e o grep funciona corretamente). A invariante é a ANCORAGEM:
// se o alvo pertence a um repo válido, o grep RESPONDE; se não pertence, RECUSA com erro. O que nunca pode
// acontecer é "0 matches" calado sem repo válido — esse é o falso "não existe" que estas tools existem p/ matar.
{
  const ancorado = resolveRepoRoot(REPO) !== null;
  const y = J(tool("git_grep"), { repo: REPO, pattern: "createFindingsTracker" });
  if (!ancorado) {
    assert.strictEqual(y.count, null, "sem repo válido, git_grep tem que RECUSAR (null+error), não devolver 0 calado");
    assert.ok(y.error, "e dizer por quê");
    skip("git_grep: alvo sem repo válido → recusa explicada (nunca '0 matches' falso)");
  } else {
    const absent = ["zzz", "sym", "nao", "existe", Date.now().toString(36)].join("_");
    const n = J(tool("git_grep"), { repo: REPO, pattern: absent });
    assert.ok(y.count >= 1 && y.matches[0].file, "ancorado num repo, tem que achar o símbolo real: " + JSON.stringify(y).slice(0, 120));
    assert.strictEqual(n.count, 0, "símbolo inexistente (runtime-único) = 0 matches");
    ok("git_grep: ancorado num repo válido, confirma o que existe e o que não existe");
  }
}
// file_contains
{
  const y = J(tool("file_contains"), { repo: REPO, relpath: "src/adapters/shadow/findingsTracker.mjs", needle: "cosineDistance" });
  const n = J(tool("file_contains"), { repo: REPO, relpath: "src/adapters/shadow/findingsTracker.mjs", needle: "ESTA_STRING_NAO_ESTA_LA" });
  const gone = J(tool("file_contains"), { repo: REPO, relpath: "nada/aqui.txt", needle: "x" });
  assert.ok(y.exists && y.contains === true, "arquivo contém a substring real");
  assert.ok(n.exists && n.contains === false, "não contém a substring inexistente");
  assert.strictEqual(gone.exists, false, "arquivo ausente → exists:false (não lança)");
  ok("file_contains: prova 'X importa/contém Y' com precisão (e degrada em arquivo ausente)");
}
// git_log_grep (mecanismo + shape; count depende do histórico → só valida forma e não-erro). Precisa de commits.
if (!DEV_REPO) {
  skip("git_log_grep: fora do repo dev commitado — sem histórico p/ validar shape aqui (SINALIZADO)");
} else {
  const r = J(tool("git_log_grep"), { repo: REPO, pattern: "sombra" });
  assert.ok(Array.isArray(r.commits) && typeof r.count === "number" && !r.error, "retorna {commits,count} sem erro: " + JSON.stringify(r).slice(0, 100));
  ok("git_log_grep: mecanismo de prova de commit ('foi commitado') funciona (shape {commits,count})");
}
// read_build_provenance: mirror SEM .git só consegue provar sua origem via este arquivo. Sem o arquivo →
// found:false + reason (nunca inventa commit/tag); com o arquivo → found:true + provenance IDÊNTICA ao gravado.
{
  const tmp = tmpDir("modo-provenance-");
  const absent = J(tool("read_build_provenance"), { repo: tmp });
  assert.strictEqual(absent.found, false, "mirror sem .build-provenance.json → found:false: " + JSON.stringify(absent));
  assert.ok(typeof absent.reason === "string" && absent.reason.length > 0, "reason explica a ausência");

  const written = { commit: { sha: "abc123", shortSha: "abc123" }, branch: "develop", tag: "v9.9.9", remote: "https://github.com/x/y.git", clean: true, version: "9.9.9", generatedAt: "2026-01-01T00:00:00.000Z", indeterminate: [] };
  writeFileSync(join(tmp, ".build-provenance.json"), JSON.stringify(written));
  const present = J(tool("read_build_provenance"), { repo: tmp });
  assert.strictEqual(present.found, true, "mirror com .build-provenance.json → found:true");
  assert.deepStrictEqual(present.provenance, written, "provenance lida é IDÊNTICA à gravada (round-trip)");
  ok("read_build_provenance: mirror sem .git prova sua origem via .build-provenance.json (found:false quando ausente, round-trip quando presente)");
}

// allowlist fail-closed: os nomes expostos são EXATAMENTE as tools custom (nada de built-in/shell)
assert.deepStrictEqual([...VERIFY_TOOL_NAMES].sort(), ["file_contains", "git_grep", "git_log_grep", "git_tracked", "path_exists", "read_build_provenance"], "availableTools = só as custom read-only");
ok("VERIFY_TOOL_NAMES = allowlist fail-closed (6 tools custom read-only; sem shell/built-in)");

// FAIL-LOUD contra cwd NÃO-repo (raiz dos falsos "sem git history / untracked"): git tools NÃO podem confundir
// "não consigo rodar git aqui" com "não existe/não versionado". Devem devolver null+error, nunca false/0 calado.
{
  // No repo dev, tem que ACHAR a raiz. Fora dele (artefato instalado dentro de OUTRO repo, como
  // installed-plugins/ dentro de ~/.copilot), tem que devolver null: é a defesa que impede auditar o repo
  // ERRADO e concluir "untracked/sem história" sobre arquivos que estão versionados em outro lugar.
  // A invariante NÃO é o contexto ("sou repo dev?"), é a PERTINÊNCIA: resolveRepoRoot devolve raiz **se e somente
  // se** o alvo pertence àquele repo (tem arquivos rastreados lá). Isso vale nos três casos reais: repo dev
  // (pertence), artefato instalado dentro de ~/.copilot (NÃO pertence → null), e artefato vendado dentro da
  // vitrine (pertence → raiz da vitrine). Testar contexto em vez de invariante foi o que quebrou no clone
  // anônimo — o teste exigia null onde o comportamento correto era responder.
  const root = resolveRepoRoot(REPO);
  const rastreados = (() => { try { return git(["-C", REPO, "ls-files"]).trim().length > 0; } catch { return false; } })();
  if (rastreados) {
    assert.ok(root, "alvo COM arquivos rastreados tem que resolver a raiz do repo a que pertence");
    ok("resolveRepoRoot: alvo pertence ao repo → devolve a raiz (" + root + ")");
  } else {
    assert.strictEqual(root, null, "alvo SEM arquivos rastreados (artefato alheio aninhado) → null, nunca o repo de cima");
    ok("resolveRepoRoot: artefato aninhado em repo ALHEIO devolve null (não audita o repo errado)");
  }
  const NONREPO = tmpdir();
  if (resolveRepoRoot(NONREPO) === null) {
    const t = J(tool("git_tracked"), { repo: NONREPO, relpath: "qualquer.txt" });
    assert.ok(t.tracked === null && t.error, "git_tracked em NÃO-repo → tracked:null + error (não 'false' calado): " + JSON.stringify(t));
    const lg = J(tool("git_log_grep"), { repo: NONREPO, pattern: "x" });
    assert.ok(lg.commits === null && lg.error, "git_log_grep em NÃO-repo → commits:null + error (não '0 commits' falso)");
    const gg = J(tool("git_grep"), { repo: NONREPO, pattern: "x" });
    assert.ok(gg.count === null && gg.error, "git_grep em NÃO-repo → count:null + error (não '0 matches' falso)");
    ok("FAIL-LOUD: git tools em cwd NÃO-repo devolvem null+error (fecha a raiz dos falsos 'sem git history')");
  } else { ok("(skip) tmpdir é repo git nesta máquina — caso não-repo não testável aqui"); }
}

// REGRESSÃO (v0.2.97): os handlers de git precisam ANCORAR num repo VÁLIDO. Ter o resolveRepoRoot não bastava —
// medido no runtime v0.2.96, `resolveRepoRoot(mirror)` já devolvia null e MESMO ASSIM `git_tracked` respondia
// `tracked:false`, porque o handler rodava `git -C <alvo>` direto e o git SOBE para o repo de cima. Resolver que
// ninguém consulta é decoração: o falso "não versionado" continuava saindo com cara de fato.
{
  const NESTED = tmpDir("modo-auto-nested-");
  const outer = join(NESTED, "repo-alheio");
  const inner = join(outer, "artefato-instalado");
  mkdirSync(inner, { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: outer, encoding: "utf8", env: { ...process.env, GIT_CONFIG_PARAMETERS: "" }, stdio: ["ignore", "pipe", "ignore"] });
  try {
    g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    writeFileSync(join(outer, "proprio.txt"), "do repo de cima");
    g(["add", "proprio.txt"]); g(["commit", "-qm", "commit do repo alheio"]);
    // o artefato aninhado NÃO é versionado no repo de cima (é cópia instalada) — igual ao mirror real
    writeFileSync(join(inner, "arquivo.mjs"), "export const x = 1;\n");

    assert.strictEqual(resolveRepoRoot(inner), null, "artefato aninhado em repo alheio → null");
    const t = J(tool("git_tracked"), { repo: inner, relpath: "arquivo.mjs" });
    assert.strictEqual(t.tracked, null, "git_tracked NÃO pode dizer false auditando o repo de cima: " + JSON.stringify(t));
    assert.ok(t.error && /alheio|não pertence/i.test(t.error), "precisa explicar por que recusou: " + JSON.stringify(t));
    const lg = J(tool("git_log_grep"), { repo: inner, pattern: "commit do repo alheio" });
    assert.strictEqual(lg.count, null, "git_log_grep não pode devolver commits do repo ALHEIO: " + JSON.stringify(lg));
    const gg = J(tool("git_grep"), { repo: inner, pattern: "export" });
    assert.strictEqual(gg.count, null, "git_grep não pode buscar no repo alheio: " + JSON.stringify(gg));
    ok("handlers git ANCORAM em repo válido: aninhado em repo alheio → null+error (nunca false/0 do repo de cima)");
  } finally { try { rmSync(NESTED, { recursive: true, force: true }); } catch { /* temp */ } }
}

console.log(`\nverify-tools-smoke: ${pass}/10 OK`);
