// PROVENIÊNCIA DO BUILD — grava, no momento do EMPACOTAMENTO (repo dev, com .git), de qual commit/tag/branch/
// remote o runtime instalado veio. O runtime instalado (mirror ~/.copilot/extensions/modo-auto) é uma cópia
// runtime-only PODADA (sem .git, sem test/) por design — o modo-sombra que audita o mirror não tem como provar
// proveniência sozinho. Este módulo roda no repo DEV (que tem .git) e grava um .build-provenance.json que o
// mirror carrega junto (fora da lista RUNTIME_KEEP de poda, como artefato de dados). FAIL LOUD (Princípio 10):
// o que não pode ser medido (git não responde, plugin.json ilegível) vira `indeterminate` sinalizado — NUNCA um
// "ok" fake nem um default silencioso. git e fs são INJETADOS (puro/testável, sem tocar disco/processo real).
import assert from "node:assert";
import { join } from "node:path";
import { writeProvenance, readProvenance, formatProvenance } from "../src/adapters/health/buildProvenance.mjs";

let pass = 0;
const total = 12;
const ok = (m) => { console.log("  ok -", m); pass++; };

// git FAKE: mapa "args.join(' ')" → stdout (string) | null (comando falhou / não é repo git).
function fakeGit(map = {}) {
  return (args) => {
    const key = args.join(" ");
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  };
}

const ROOT = "C:\\repo\\modo-auto";
const OUT = join(ROOT, ".build-provenance.json");
const PLUGIN = join(ROOT, "plugin.json");
const NOW = "2026-07-29T12:00:00.000Z";

function fakeFs({ files = {} } = {}) {
  const norm = (p) => String(p).replace(/\//g, "\\");
  const store = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const writes = [];
  return {
    exists: (p) => store.has(norm(p)),
    read: (p) => { if (!store.has(norm(p))) throw new Error("ENOENT " + p); return store.get(norm(p)); },
    write: (p, content) => { writes.push({ path: norm(p), content }); },
    writes,
  };
}

// 1) CENÁRIO REAL MEDIDO (repo dev, tag de release, árvore limpa) — todos os campos preenchidos, indeterminate vazio.
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({
    "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "rev-parse --short HEAD": "a1b2c3d",
    "rev-parse --abbrev-ref HEAD": "develop",
    "branch -r --contains a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": "  origin/develop\n  origin/main",
    "tag --points-at HEAD": "v1.0.7",
    "remote get-url origin": "https://github.com/AllanSantos-DV/modo-auto.git",
    "status --porcelain": "",
  });
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(prov.commit.sha, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "sha completo medido");
  assert.strictEqual(prov.commit.shortSha, "a1b2c3d", "sha curto medido");
  assert.strictEqual(prov.branch, "develop", "branch medida");
  assert.strictEqual(prov.tag, "v1.0.7", "tag apontando pro HEAD");
  assert.strictEqual(prov.remote, "https://github.com/AllanSantos-DV/modo-auto.git", "remote origin medido");
  assert.strictEqual(prov.clean, true, "árvore limpa (status --porcelain vazio)");
  assert.strictEqual(prov.version, "1.0.7", "versão do plugin.json");
  assert.strictEqual(prov.generatedAt, NOW, "data ISO injetada (determinística)");
  assert.deepStrictEqual(prov.indeterminate, [], "tudo medido → indeterminate vazio");
  ok("cenário real (release com tag, árvore limpa): tudo medido, indeterminate vazio");
}

// 2) árvore SUJA (status --porcelain não vazio) → clean:false, não afeta os outros campos medidos
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({
    "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "rev-parse --short HEAD": "a1b2c3d",
    "rev-parse --abbrev-ref HEAD": "develop",
    "branch -r --contains a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": "  origin/develop\n  origin/main",
    "tag --points-at HEAD": "",
    "remote get-url origin": "https://github.com/AllanSantos-DV/modo-auto.git",
    "status --porcelain": " M src/adapters/health/setupCheck.mjs\n",
  });
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(prov.clean, false, "detecta árvore suja");
  assert.strictEqual(prov.tag, null, "sem tag apontando pro HEAD → null (não é falha de medição)");
  assert.ok(!prov.indeterminate.includes("clean"), "clean FOI medido (mesmo sendo false) → não entra em indeterminate");
  assert.ok(!prov.indeterminate.includes("tag"), "ausência LEGÍTIMA de tag (build de branch, não release) → não é indeterminado");
  ok("branch build sem tag + árvore suja: campos medidos corretamente, ausência de tag não é 'indeterminado'");
}

// 3) FAIL LOUD TOTAL: git não responde nada (fora de um repo git) → todos os campos derivados de git são null e
//    LISTADOS em indeterminate; NUNCA um 'ok' fake.
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({}); // todo comando cai no null (repo sem .git)
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(prov.commit.sha, null, "sem git → sha null, nunca inventado");
  assert.strictEqual(prov.commit.shortSha, null, "sem git → shortSha null");
  assert.strictEqual(prov.branch, null, "sem git → branch null");
  assert.strictEqual(prov.remote, null, "sem git → remote null");
  assert.strictEqual(prov.clean, null, "sem git → clean null (não posso afirmar limpo OU sujo)");
  assert.strictEqual(prov.tag, null, "sem git → tag null (HEAD indeterminável, não dá pra saber se há tag)");
  for (const campo of ["commit.sha", "commit.shortSha", "branch", "remote", "clean", "tag"]) {
    assert.ok(prov.indeterminate.includes(campo), `'${campo}' deve estar listado em indeterminate: ${JSON.stringify(prov.indeterminate)}`);
  }
  assert.strictEqual(prov.version, "1.0.7", "plugin.json ainda legível independente do git falhar");
  ok("FAIL LOUD: git indisponível → TODO campo derivado de git (incl. tag) é null E nomeado em indeterminate (nunca 'ok' fake)");
}

// 4) plugin.json ilegível/ausente → version:null + 'version' em indeterminate, sem derrubar o resto
{
  const fs = fakeFs({ files: {} }); // plugin.json não existe
  const git = fakeGit({
    "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "rev-parse --short HEAD": "a1b2c3d",
    "rev-parse --abbrev-ref HEAD": "develop",
    "branch -r --contains a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": "  origin/develop\n  origin/main",
    "tag --points-at HEAD": "",
    "remote get-url origin": "https://github.com/AllanSantos-DV/modo-auto.git",
    "status --porcelain": "",
  });
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(prov.version, null, "plugin.json ausente → version null, não quebra o build");
  assert.ok(prov.indeterminate.includes("version"), "'version' nomeado em indeterminate: " + JSON.stringify(prov.indeterminate));
  assert.strictEqual(prov.commit.sha, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "git continua medido mesmo sem plugin.json");
  ok("plugin.json ilegível: version vira indeterminado isolado, não contamina os campos de git");
}

// 5) MÚLTIPLAS TAGS apontando pro HEAD → usa a PRIMEIRA linha (não concatena, não quebra)
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({
    "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "rev-parse --short HEAD": "a1b2c3d",
    "rev-parse --abbrev-ref HEAD": "develop",
    "branch -r --contains a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": "  origin/develop\n  origin/main",
    "tag --points-at HEAD": "v1.0.7\nv1.0.7-alias",
    "remote get-url origin": "https://github.com/AllanSantos-DV/modo-auto.git",
    "status --porcelain": "",
  });
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(prov.tag, "v1.0.7", "múltiplas tags no HEAD → primeira linha, determinístico");
  ok("múltiplas tags no HEAD: escolhe a primeira, sem ambiguidade");
}

// 6) FALHA PARCIAL: só o remote 'origin' não existe (clone local sem remote configurado) — só ELE vira
//    indeterminado, o resto (sha/branch/tag/clean) continua medido normalmente.
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({
    "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "rev-parse --short HEAD": "a1b2c3d",
    "rev-parse --abbrev-ref HEAD": "develop",
    "branch -r --contains a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": "  origin/develop\n  origin/main",
    "tag --points-at HEAD": "",
    "status --porcelain": "",
    // "remote get-url origin" AUSENTE do map → fakeGit devolve null (sem remote configurado)
  });
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(prov.remote, null, "sem remote configurado → null");
  assert.deepStrictEqual(prov.indeterminate, ["remote"], "SÓ o remote é indeterminado — sha/branch/clean continuam medidos");
  assert.strictEqual(prov.commit.sha, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "sha não contaminado pela falta de remote");
  assert.strictEqual(prov.clean, true, "clean não contaminado pela falta de remote");
  ok("falha PARCIAL (sem remote): indeterminate lista só 'remote', o resto medido normalmente");
}

// 7) GRAVAÇÃO NO DISCO: o arquivo .build-provenance.json é escrito no path OUT com JSON válido que faz
//    ROUND-TRIP para o MESMO objeto retornado (nada de string mal formada / conteúdo divergente do retorno).
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "2.0.0" }) } });
  const git = fakeGit({
    "rev-parse HEAD": "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
    "rev-parse --short HEAD": "f0f0f0f",
    "rev-parse --abbrev-ref HEAD": "main",
    "tag --points-at HEAD": "v2.0.0",
    "remote get-url origin": "https://github.com/AllanSantos-DV/modo-auto.git",
    "status --porcelain": "",
  });
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(fs.writes.length, 1, "grava exatamente UM arquivo");
  assert.strictEqual(fs.writes[0].path, OUT.replace(/\//g, "\\"), "grava no path OUT esperado: " + fs.writes[0].path);
  const onDisk = JSON.parse(fs.writes[0].content);
  assert.deepStrictEqual(onDisk, prov, "conteúdo gravado é IDÊNTICO ao objeto retornado (sem divergência)");
  ok("grava .build-provenance.json em OUT com JSON round-trip idêntico ao objeto retornado");
}

// 8) MESMO em FALHA TOTAL de git, o arquivo AINDA é gravado (o registro do 'indeterminado' precisa chegar ao
//    disco para o modo-sombra poder ler — sumir com o arquivo seria fail-SILENT, não fail-LOUD).
{
  const fs = fakeFs({ files: {} });
  const git = fakeGit({});
  const prov = writeProvenance({ root: ROOT, out: OUT, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW });
  assert.strictEqual(fs.writes.length, 1, "grava o arquivo MESMO com tudo indeterminado (fail LOUD, não fail SILENT)");
  const onDisk = JSON.parse(fs.writes[0].content);
  assert.ok(Array.isArray(onDisk.indeterminate) && onDisk.indeterminate.length > 0, "o próprio arquivo denuncia o que não foi medido");
  ok("falha total de git: o .build-provenance.json ainda é gravado, denunciando o indeterminado (fail LOUD)");
}

// 9) PATH TRAVERSAL bloqueado: 'out' com '..' saindo de 'root' → lança, NUNCA escreve (fail loud, não silencioso).
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({ "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" });
  const evilOut = `${ROOT}\\..\\..\\etc\\passwd.build-provenance.json`; // string concat (não path.join) p/ preservar '..' literal
  assert.throws(() => writeProvenance({ root: ROOT, out: evilOut, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW }), /path traversal/, "'..' em out → lança e bloqueia");
  assert.strictEqual(fs.writes.length, 0, "NADA foi escrito antes da validação (bloqueio ocorre antes de tocar git/fs)");
  ok("path traversal ('..' saindo do root): bloqueado com throw, zero escrita em disco");
}

// 10) OUT fora do root (sem '..', mas em outra árvore) → também bloqueado.
{
  const fs = fakeFs({ files: { [PLUGIN]: JSON.stringify({ version: "1.0.7" }) } });
  const git = fakeGit({ "rev-parse HEAD": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" });
  const outsideOut = "C:\\outra-pasta\\.build-provenance.json";
  assert.throws(() => writeProvenance({ root: ROOT, out: outsideOut, git, exists: fs.exists, read: fs.read, write: fs.write, now: () => NOW }), /dentro de 'root'/, "out fora do root → lança e bloqueia");
  assert.strictEqual(fs.writes.length, 0, "nada escrito com out fora do root");
  ok("out fora do root (sem '..'): bloqueado com throw, zero escrita em disco");
}

// 11) readProvenance: arquivo AUSENTE no mirror → found:false + reason, NUNCA um 'ok' fake nem provenance inventada.
{
  const fs = fakeFs({ files: {} }); // mirror sem .build-provenance.json
  const res = readProvenance(ROOT, { exists: fs.exists, read: fs.read });
  assert.strictEqual(res.found, false, "arquivo ausente → found:false");
  assert.ok(typeof res.reason === "string" && res.reason.length > 0, "reason explica a ausência: " + JSON.stringify(res));
  assert.ok(!("provenance" in res), "sem provenance inventada quando ausente");
  ok("readProvenance: arquivo ausente no mirror → found:false + reason (nunca provenance fake)");
}

// 12) readProvenance: arquivo PRESENTE e válido → found:true + provenance IDÊNTICA ao que foi gravado (round-trip);
//     e um JSON corrompido → found:false + reason, nunca lança pro caller.
{
  const written = { commit: { sha: "abc", shortSha: "abc" }, branch: "develop", tag: "v1.0.7", remote: "https://github.com/AllanSantos-DV/modo-auto.git", clean: true, version: "1.0.7", generatedAt: NOW, indeterminate: [] };
  const fs = fakeFs({ files: { [OUT]: JSON.stringify(written) } });
  const res = readProvenance(ROOT, { exists: fs.exists, read: fs.read });
  assert.strictEqual(res.found, true, "arquivo presente e válido → found:true");
  assert.deepStrictEqual(res.provenance, written, "provenance lida é IDÊNTICA à gravada (round-trip)");

  const fsBad = fakeFs({ files: { [OUT]: "{ isso nao e json" } });
  const resBad = readProvenance(ROOT, { exists: fsBad.exists, read: fsBad.read });
  assert.strictEqual(resBad.found, false, "JSON malformado → found:false, nunca lança pro caller");
  assert.ok(typeof resBad.reason === "string" && resBad.reason.length > 0, "reason explica o JSON malformado");
  ok("readProvenance: arquivo válido → round-trip idêntico; arquivo corrompido → found:false sinalizado (nunca throw)");
}

console.log(`\nbuild-provenance-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
