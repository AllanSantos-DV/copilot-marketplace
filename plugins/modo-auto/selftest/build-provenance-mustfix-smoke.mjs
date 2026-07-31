// build-provenance-mustfix-smoke.mjs — cobre os 3 mustFix que a MESA levantou ao reprovar a fase:
//  1) readProvenance aceitava qualquer JSON válido como prova ({} , [], campos faltando) → "ok" fake;
//  2) formatProvenance não existia, quebrando o padrão de setupCheck/formatSetup (consumidor remontava a string);
//  3) o carimbo não ligava commit ↔ remote, então um commit NUNCA PUSHADO era registrado igual a um publicado —
//     e o falso-negativo alvo ("esse commit/tag não existe no remote") continuava de pé.

import assert from "node:assert";
import { writeProvenance, readProvenance, formatProvenance } from "../src/adapters/health/buildProvenance.mjs";

let pass = 0, total = 0;
const ok = (m) => { total++; pass++; console.log("  ok - " + m); };
const run = (m, fn) => { total++; try { fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const gitOf = (map) => (args) => { const k = args.join(" "); if (!(k in map)) throw new Error("git falso: comando não mapeado: " + k); return map[k]; };
const BASE = {
  "rev-parse HEAD": SHA, "rev-parse --short HEAD": "a1b2c3d", "rev-parse --abbrev-ref HEAD": "develop",
  "tag --points-at HEAD": "v0.2.88", "remote get-url origin": "https://github.com/AllanSantos-DV/modo-auto.git",
  "status --porcelain": "",
};
const fsOf = (files) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(files, String(p)),
  read: (p) => { if (!(String(p) in files)) throw new Error("ENOENT " + p); return files[String(p)]; },
  write: () => {},
});
const PLUGIN = { "/root/plugin.json": JSON.stringify({ version: "0.2.88" }) };
const write = (gitMap) => writeProvenance({ root: "/root", out: "/root/.build-provenance.json", git: gitOf(gitMap), ...fsOf(PLUGIN) });
const readWith = (content) => readProvenance("/mirror", {
  exists: () => true, read: () => content,
});

console.log("mustFix 1 — JSON válido ≠ proveniência válida");
for (const [rotulo, conteudo] of [["objeto vazio", "{}"], ["array", "[]"], ["escalar", '"texto"'], ["null", "null"]]) {
  run(`${rotulo} é RECUSADO com motivo (nunca found:true fake)`, () => {
    const r = readWith(conteudo);
    assert.strictEqual(r.found, false);
    assert.ok(r.reason && r.reason.length > 0, "precisa dizer POR QUE recusou");
  });
}
run("objeto pela metade é recusado LISTANDO os campos ausentes", () => {
  const r = readWith(JSON.stringify({ commit: { sha: SHA }, branch: "develop" }));
  assert.strictEqual(r.found, false);
  assert.match(r.reason, /campos ausentes/);
});
run("'indeterminate' com tipo errado é recusado (schema, não só presença)", () => {
  const r = readWith(JSON.stringify({ commit: {}, branch: null, tag: null, remote: null, clean: null, version: null, generatedAt: "x", indeterminate: "nao-e-lista" }));
  assert.strictEqual(r.found, false);
});
run("'commit' não-objeto é recusado", () => {
  const r = readWith(JSON.stringify({ commit: "abc", branch: null, tag: null, remote: null, clean: null, version: null, generatedAt: "x", indeterminate: [] }));
  assert.strictEqual(r.found, false);
});
run("proveniência COMPLETA é aceita", () => {
  const bom = { kind: "operational-audit", commit: { sha: SHA, shortSha: "a1b2c3d" }, branch: "develop", tag: "v0.2.88", remote: "x", clean: true, version: "0.2.88", pushed: true, remoteBranches: [], generatedAt: "x", indeterminate: [] };
  const r = readWith(JSON.stringify(bom));
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.provenance.commit.shortSha, "a1b2c3d");
});

console.log("mustFix 2 — formatProvenance (padrão formatSetup)");
run("ausente diz INDISPONÍVEL e PROÍBE concluir que o commit não existe", () => {
  const l = formatProvenance({ found: false, reason: "arquivo ausente" });
  assert.match(l, /INDISPONÍVEL/);
  assert.match(l, /NÃO conclua/);
  assert.match(l, /runtime-only/);
});
run("estado bom vira uma linha com versão, commit, tag, branch, limpeza, publicação e origin", () => {
  const l = formatProvenance({ found: true, provenance: { kind: "operational-audit", version: "0.2.88", commit: { shortSha: "a1b2c3d" }, tag: "v0.2.88", branch: "develop", clean: true, pushed: true, remote: "https://github.com/AllanSantos-DV/modo-auto.git", indeterminate: [] } });
  for (const t of ["v0.2.88", "a1b2c3d", "develop", "árvore limpa", "publicado no remote", "AllanSantos-DV/modo-auto"]) assert.ok(l.includes(t), `falta '${t}' em: ${l}`);
});
run("estado RUIM aparece, não é mascarado", () => {
  const l = formatProvenance({ found: true, provenance: { kind: "operational-audit", commit: {}, clean: false, pushed: false, indeterminate: ["version"] } });
  assert.match(l, /árvore SUJA/);
  assert.match(l, /NÃO publicado/);
  assert.match(l, /não medido: version/);
});
run("a linha DECLARA a natureza (auto-declarado, não assinado)", () => {
  const l = formatProvenance({ found: true, provenance: { kind: "operational-audit", commit: {}, indeterminate: [] } });
  assert.match(l, /auto-declarado, não assinado/);
});

console.log("mustFix 3 — ligação commit ↔ remote");
run("commit contido em branch remota => pushed:true + QUAL branch", () => {
  const p = write({ ...BASE, [`branch -r --contains ${SHA}`]: "  origin/develop\n  origin/main" });
  assert.strictEqual(p.pushed, true);
  assert.deepStrictEqual(p.remoteBranches, ["origin/develop", "origin/main"]);
});
run("commit em NENHUMA branch remota => pushed:false (o falso-negativo alvo), e isso é MEDIÇÃO", () => {
  const p = write({ ...BASE, [`branch -r --contains ${SHA}`]: "" });
  assert.strictEqual(p.pushed, false);
  assert.ok(!p.indeterminate.includes("pushed"), "'' é 'não publicado', não 'não medido'");
});
run("git indisponível => pushed:null E listado em indeterminate (nunca false fake)", () => {
  const p = writeProvenance({ root: "/root", out: "/root/.build-provenance.json", git: () => { throw new Error("git fora"); }, ...fsOf(PLUGIN) });
  assert.strictEqual(p.pushed, null);
  assert.ok(p.indeterminate.includes("pushed"));
});
run("descarta a linha '->' do HEAD remoto (não é branch que contém)", () => {
  const p = write({ ...BASE, [`branch -r --contains ${SHA}`]: "  origin/HEAD -> origin/main\n  origin/main" });
  assert.deepStrictEqual(p.remoteBranches, ["origin/main"]);
});
run("o registro declara sua NATUREZA (kind)", () => {
  const p = write({ ...BASE, [`branch -r --contains ${SHA}`]: "  origin/main" });
  assert.strictEqual(p.kind, "operational-audit");
});

console.log(`\nbuild-provenance-mustfix-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
